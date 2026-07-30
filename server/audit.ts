import type { Request } from "express";
import type pg from "pg";
import { query } from "./db.js";

type AuditClient = Pick<pg.PoolClient, "query">;

export const writeAdminAudit = async (
  request: Request,
  action: string,
  targetType?: string,
  targetId?: string,
  detail: Record<string, unknown> = {},
  client?: AuditClient
) => {
  const values = [
    request.authUser?.id || null,
    action,
    targetType || null,
    targetId || null,
    detail,
    request.ip || null
  ];
  const text = `INSERT INTO admin_audit_logs
    (admin_user_id, action, target_type, target_id, detail, ip)
    VALUES ($1, $2, $3, $4, $5, $6)`;
  if (client) {
    await client.query(text, values);
    return;
  }
  await query(text, values);
};

