import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, query } from "../db.js";
import { runMigrations } from "../migrate.js";
import {
  claimNextAiJob,
  completeAiJob,
  recoverExpiredAiJobs
} from "../modules/ai/repository.js";
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

describe("AI Worker lease recovery", () => {
  it("requeues an expired first attempt, terminalizes an exhausted lease, and removes abandoned unreserved jobs", async () => {
    const requeueId = randomUUID();
    const failedId = randomUUID();
    const abandonedId = randomUUID();
    await query(
      `INSERT INTO ai_jobs(
         id, user_id, kind, status, progress, idempotency_key, input_hash,
         input_metadata, upload_metadata, attempt_count, claimed_by,
         claimed_at, lease_expires_at, created_at
       ) VALUES
         ($1, $4, 'severance_analysis', 'RUNNING', 10, 'lease-requeue', repeat('a', 64), '{}', '[]', 1, 'dead-worker', now() - interval '2 hours', now() - interval '1 hour', now() - interval '2 hours'),
         ($2, $4, 'document_review', 'RUNNING', 10, 'lease-failed', repeat('b', 64), '{}', '[]', 2, 'dead-worker', now() - interval '2 hours', now() - interval '1 hour', now() - interval '2 hours'),
         ($3, $4, 'document_review', 'QUEUED', 0, 'lease-abandoned', repeat('c', 64), '{}', '[]', 0, NULL, NULL, NULL, now() - interval '10 minutes')`,
      [requeueId, failedId, abandonedId, userId]
    );
    const entitlements = await query<{ id: string; job_id: string }>(
      `WITH requested(sku, job_id) AS (VALUES
         ('AI_SEVERANCE_ANALYSIS', $2::uuid),
         ('AI_DOCUMENT_REVIEW', $3::uuid)
       )
       INSERT INTO entitlements(
         user_id, product_id, source_type, total_uses, remaining_uses,
         status, reserved_for, reserved_at
       )
       SELECT $1, p.id, 'admin', 1, 0, 'reserved', requested.job_id, now()
         FROM products p
         JOIN requested ON requested.sku = p.sku
       RETURNING id, reserved_for AS job_id`,
      [userId, requeueId, failedId]
    );
    for (const entitlement of entitlements.rows) {
      const usage = await query<{ id: string }>(
        `INSERT INTO entitlement_usages(
           entitlement_id, user_id, business_type, business_id, status
         ) VALUES ($1, $2, 'commerce', $3, 'reserved')
         RETURNING id`,
        [entitlement.id, userId, entitlement.job_id]
      );
      await query(
        "UPDATE ai_jobs SET entitlement_usage_id = $2 WHERE id = $1",
        [entitlement.job_id, usage.rows[0].id]
      );
    }
    await query(
      `INSERT INTO ai_job_events(job_id, from_status, to_status, progress)
       VALUES
         ($1, NULL, 'QUEUED', 0),
         ($1, 'QUEUED', 'RUNNING', 10),
         ($2, NULL, 'QUEUED', 0),
         ($2, 'QUEUED', 'RUNNING', 10),
         ($3, NULL, 'QUEUED', 0)`,
      [requeueId, failedId, abandonedId]
    );
    await query(
      `INSERT INTO operational_job_runs(job_name, status, started_at, detail)
       VALUES
         ('ai-analysis-worker', 'running', now() - interval '2 hours', jsonb_build_object('jobId', $1::text)),
         ('ai-analysis-worker', 'running', now() - interval '2 hours', jsonb_build_object('jobId', $2::text))`,
      [requeueId, failedId]
    );

    await expect(recoverExpiredAiJobs(2)).resolves.toEqual({
      releasedUsages: 1,
      requeued: 1,
      failed: 1,
      abandoned: 1
    });

    const jobs = await query<{ id: string; status: string; failure_code: string | null }>(
      "SELECT id, status, failure_code FROM ai_jobs WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[requeueId, failedId, abandonedId]]
    );
    expect(jobs.rows).toEqual(expect.arrayContaining([
      { id: requeueId, status: "QUEUED", failure_code: null },
      { id: failedId, status: "FAILED_FINAL", failure_code: "AI_WORKER_LEASE_EXPIRED" }
    ]));
    expect(jobs.rows.some((row) => row.id === abandonedId)).toBe(false);

    const usages = await query<{ business_id: string; status: string; remaining_uses: number }>(
      `SELECT eu.business_id, eu.status, e.remaining_uses
         FROM entitlement_usages eu
         JOIN entitlements e ON e.id = eu.entitlement_id
        WHERE eu.business_id = ANY($1::uuid[])
        ORDER BY eu.business_id`,
      [[requeueId, failedId]]
    );
    expect(usages.rows).toEqual(expect.arrayContaining([
      { business_id: requeueId, status: "reserved", remaining_uses: 0 },
      { business_id: failedId, status: "released", remaining_uses: 1 }
    ]));
    const runs = await query<{
      job_id: string;
      status: string;
      finished: boolean;
      recovered: boolean;
      failure_code: string;
    }>(
      `SELECT detail->>'jobId' AS job_id,
              status,
              finished_at IS NOT NULL AS finished,
              (detail->>'recovered')::boolean AS recovered,
              detail->>'failureCode' AS failure_code
         FROM operational_job_runs
        WHERE detail->>'jobId' = ANY($1::text[])
        ORDER BY detail->>'jobId'`,
      [[requeueId, failedId]]
    );
    expect(runs.rows).toEqual(expect.arrayContaining([
      {
        job_id: requeueId,
        status: "failed",
        finished: true,
        recovered: true,
        failure_code: "AI_WORKER_LEASE_EXPIRED"
      },
      {
        job_id: failedId,
        status: "failed",
        finished: true,
        recovered: false,
        failure_code: "AI_WORKER_LEASE_EXPIRED"
      }
    ]));

    const replacement = await claimNextAiJob("replacement-worker", 60);
    expect(replacement).toMatchObject({ id: requeueId, attemptCount: 2 });
    await expect(completeAiJob({
      jobId: requeueId,
      usageId: replacement!.entitlementUsageId,
      workerId: "dead-worker",
      jobAttempt: 1,
      providerKey: "stale-provider",
      model: "stale-model",
      attempts: [],
      report: {
        schemaVersion: "1.0",
        summary: "过期 Worker 的结果",
        riskLevel: "medium",
        findings: [],
        actions: []
      }
    })).rejects.toThrow(`AI job ${requeueId} is no longer RUNNING`);
    const fenced = await query<{ status: string; claimed_by: string; attempt_count: number }>(
      "SELECT status, claimed_by, attempt_count FROM ai_jobs WHERE id = $1",
      [requeueId]
    );
    expect(fenced.rows[0]).toEqual({
      status: "RUNNING",
      claimed_by: "replacement-worker",
      attempt_count: 2
    });
    await expect(recoverExpiredAiJobs(2)).resolves.toEqual({
      releasedUsages: 0,
      requeued: 0,
      failed: 0,
      abandoned: 0
    });
  });
});
