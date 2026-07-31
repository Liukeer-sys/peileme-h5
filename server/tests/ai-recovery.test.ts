import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, query } from "../db.js";
import { runMigrations } from "../migrate.js";
import { recoverInterruptedAiJobs } from "../modules/ai/repository.js";
import { seedPolicyFoundation } from "../modules/policy/seed.js";

let userId = "";

beforeAll(async () => {
  await runMigrations();
  await query("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  const user = await query<{ id: string }>(
    `INSERT INTO users(email, display_name, role, email_verified_at)
     VALUES ('ai-recovery@peileme.test', 'AI 恢复用户', 'user', now())
     RETURNING id`
  );
  userId = user.rows[0].id;
  await seedPolicyFoundation();
});

afterAll(async () => {
  await closePool();
});

describe("AI startup recovery", () => {
  it("releases interrupted reservations, removes queued jobs and terminalizes running jobs", async () => {
    const queuedId = randomUUID();
    const queuedReservedId = randomUUID();
    const runningId = randomUUID();
    await query(
      `INSERT INTO ai_jobs(
         id, user_id, kind, status, progress, idempotency_key, input_hash,
         input_metadata, upload_metadata
       ) VALUES
         ($1, $4, 'document_review', 'QUEUED', 0, 'recovery-queued-plain', repeat('a', 64), '{}', '[]'),
         ($2, $4, 'document_review', 'QUEUED', 0, 'recovery-queued-reserved', repeat('b', 64), '{}', '[]'),
         ($3, $4, 'severance_analysis', 'RUNNING', 10, 'recovery-running', repeat('c', 64), '{}', '[]')`,
      [queuedId, queuedReservedId, runningId, userId]
    );
    const entitlements = await query<{ id: string }>(
      `INSERT INTO entitlements(
         user_id, product_id, source_type, total_uses, remaining_uses,
         status, reserved_for, reserved_at
       )
       SELECT $1, p.id, 'admin', 1, 0, 'reserved', reservation.job_id, now()
         FROM products p
         JOIN (VALUES
           ('AI_DOCUMENT_REVIEW', $2::uuid),
           ('AI_SEVERANCE_ANALYSIS', $3::uuid)
         ) AS reservation(sku, job_id) ON reservation.sku = p.sku
       RETURNING id`,
      [userId, queuedReservedId, runningId]
    );
    expect(entitlements.rowCount).toBe(2);
    const entitlementRows = await query<{ id: string; sku: string }>(
      `SELECT e.id, p.sku
         FROM entitlements e
         JOIN products p ON p.id = e.product_id
        WHERE e.id = ANY($1::uuid[])`,
      [entitlements.rows.map((row) => row.id)]
    );
    const documentEntitlement = entitlementRows.rows.find(
      (row) => row.sku === "AI_DOCUMENT_REVIEW"
    )!;
    const analysisEntitlement = entitlementRows.rows.find(
      (row) => row.sku === "AI_SEVERANCE_ANALYSIS"
    )!;
    const usages = await query<{ id: string; business_id: string }>(
      `INSERT INTO entitlement_usages(
         entitlement_id, user_id, business_type, business_id, status
       ) VALUES
         ($1, $3, 'commerce', $4, 'reserved'),
         ($2, $3, 'commerce', $5, 'reserved')
       RETURNING id, business_id`,
      [
        documentEntitlement.id,
        analysisEntitlement.id,
        userId,
        queuedReservedId,
        runningId
      ]
    );
    const runningUsage = usages.rows.find(
      (row) => row.business_id === runningId
    )!;
    await query(
      "UPDATE ai_jobs SET entitlement_usage_id = $2 WHERE id = $1",
      [runningId, runningUsage.id]
    );
    await query(
      `INSERT INTO ai_job_events(job_id, from_status, to_status, progress)
       VALUES
         ($1, NULL, 'QUEUED', 0),
         ($2, NULL, 'QUEUED', 0),
         ($3, NULL, 'QUEUED', 0),
         ($3, 'QUEUED', 'RUNNING', 10)`,
      [queuedId, queuedReservedId, runningId]
    );

    await expect(recoverInterruptedAiJobs()).resolves.toEqual({
      releasedUsages: 2,
      queuedDeleted: 2,
      runningFailed: 1
    });

    const jobs = await query<{
      id: string;
      status: string;
      failure_code: string | null;
    }>(
      "SELECT id, status, failure_code FROM ai_jobs WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[queuedId, queuedReservedId, runningId]]
    );
    expect(jobs.rows).toEqual([
      { id: runningId, status: "FAILED_FINAL", failure_code: "AI_JOB_INTERRUPTED" }
    ]);
    const released = await query<{
      status: string;
      remaining_uses: number;
      entitlement_status: string;
    }>(
      `SELECT eu.status, e.remaining_uses, e.status AS entitlement_status
         FROM entitlement_usages eu
         JOIN entitlements e ON e.id = eu.entitlement_id
        WHERE eu.business_id = ANY($1::uuid[])
        ORDER BY eu.business_id`,
      [[queuedReservedId, runningId]]
    );
    expect(released.rows).toEqual([
      { status: "released", remaining_uses: 1, entitlement_status: "active" },
      { status: "released", remaining_uses: 1, entitlement_status: "active" }
    ]);
    await expect(recoverInterruptedAiJobs()).resolves.toEqual({
      releasedUsages: 0,
      queuedDeleted: 0,
      runningFailed: 0
    });
  });
});
