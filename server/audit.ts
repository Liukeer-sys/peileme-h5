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
    request.ip || null,
    request.authUser?.role || null,
    String(request.header("x-request-id") || request.id || "").slice(0, 160) || null
  ];
  const text = `INSERT INTO admin_audit_logs
    (admin_user_id, action, target_type, target_id, detail, ip, actor_role, request_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;
  if (client) {
    await client.query(text, values);
    return;
  }
  await query(text, values);
};
