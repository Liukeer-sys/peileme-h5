import crypto from "node:crypto";
import type pg from "pg";
import { query, withTransaction } from "../../db.js";
import { ApiError } from "../../errors.js";
import {
  consumeEntitlementInTransaction,
  releaseEntitlementInTransaction
} from "../commerce/entitlements.js";
import type { AiProviderAttempt, AiJobKind } from "../llm/types.js";
import type { AiReport } from "../llm/router.js";

export type AiJobStatus =
  | "QUEUED"
  | "AWAITING_ENTITLEMENT"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED_FINAL";

type AiJobRow = {
  id: string;
  user_id: string;
  kind: AiJobKind;
  status: AiJobStatus;
  progress: number;
  input_hash: string;
  input_metadata: Record<string, unknown>;
  upload_metadata: AiUploadMetadata[];
  entitlement_usage_id: string | null;
  selected_provider: string | null;
  selected_model: string | null;
  failure_code: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  report: AiReport | null;
};

export type AiUploadMetadata = {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: string;
};

export type PublicAiJob = {
  id: string;
  kind: AiJobKind;
  status: AiJobStatus;
  progress: number;
  selectedProvider: string | null;
  selectedModel: string | null;
  failureCode: string | null;
  report: AiReport | null;
  uploads: AiUploadMetadata[];
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
};

export const hashAiJobInput = (input: {
  kind: AiJobKind;
  payload: Record<string, unknown>;
  uploadIds: readonly string[];
}) =>
  crypto
    .createHash("sha256")
    .update(
      stableJson({
        kind: input.kind,
        payload: input.payload,
        uploadIds: [...input.uploadIds].sort()
      })
    )
    .digest("hex");

const mapJob = (row: AiJobRow): PublicAiJob => ({
  id: row.id,
  kind: row.kind,
  status: row.status,
  progress: row.progress,
  selectedProvider: row.selected_provider,
  selectedModel: row.selected_model,
  failureCode: row.failure_code,
  report: row.report,
  uploads: row.upload_metadata,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at
});

const jobSelect = `
  SELECT
    j.id,
    j.user_id,
    j.kind,
    j.status,
    j.progress,
    j.input_hash,
    j.input_metadata,
    j.upload_metadata,
    j.entitlement_usage_id,
    j.selected_provider,
    j.selected_model,
    j.failure_code,
    j.created_at,
    j.updated_at,
    j.completed_at,
    r.content AS report
  FROM ai_jobs j
  LEFT JOIN ai_reports r ON r.job_id = j.id`;

export const loadOwnedUploadMetadata = async (
  userId: string,
  uploadIds: readonly string[]
): Promise<AiUploadMetadata[]> => {
  if (!uploadIds.length) return [];
  const result = await query<{
    id: string;
    original_name: string;
    mime_type: string;
    size_bytes: string;
  }>(
    `SELECT id, original_name, mime_type, size_bytes::text AS size_bytes
       FROM uploads
      WHERE user_id = $1
        AND id = ANY($2::uuid[])
      ORDER BY id`,
    [userId, uploadIds]
  );
  if (result.rowCount !== new Set(uploadIds).size) {
    throw new ApiError(404, "AI_UPLOAD_NOT_FOUND", "材料不存在");
  }
  return result.rows.map((row) => ({
    id: row.id,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes
  }));
};

export const createOrLoadAiJob = async (input: {
  userId: string;
  kind: AiJobKind;
  idempotencyKey: string;
  inputHash: string;
  inputMetadata: Record<string, unknown>;
  uploadMetadata: AiUploadMetadata[];
}): Promise<{ created: boolean; job: PublicAiJob }> =>
  withTransaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`ai-job:${input.userId}:${input.idempotencyKey}`]
    );
    const existing = await client.query<AiJobRow>(
      `${jobSelect}
        WHERE j.user_id = $1 AND j.idempotency_key = $2`,
      [input.userId, input.idempotencyKey]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].input_hash !== input.inputHash) {
        throw new ApiError(
          409,
          "AI_IDEMPOTENCY_CONFLICT",
          "同一幂等键不能用于不同的分析内容"
        );
      }
      return { created: false, job: mapJob(existing.rows[0]) };
    }

    const inserted = await client.query<AiJobRow>(
      `INSERT INTO ai_jobs(
         user_id,
         kind,
         status,
         progress,
         idempotency_key,
         input_hash,
         input_metadata,
         upload_metadata
       ) VALUES ($1, $2, 'QUEUED', 0, $3, $4, $5, $6)
       RETURNING *, NULL::jsonb AS report`,
      [
        input.userId,
        input.kind,
        input.idempotencyKey,
        input.inputHash,
        input.inputMetadata,
        JSON.stringify(input.uploadMetadata)
      ]
    );
    const job = inserted.rows[0];
    await client.query(
      `INSERT INTO ai_job_events(job_id, from_status, to_status, progress)
       VALUES ($1, NULL, 'QUEUED', 0)`,
      [job.id]
    );
    return { created: true, job: mapJob(job) };
  });

const transitionJob = async (
  client: pg.PoolClient,
  input: {
    jobId: string;
    from: AiJobStatus;
    to: AiJobStatus;
    progress: number;
    detail?: Record<string, unknown>;
  }
) => {
  const updated = await client.query(
    `UPDATE ai_jobs
        SET status = $3,
            progress = $4,
            updated_at = now()
      WHERE id = $1 AND status = $2
      RETURNING id`,
    [input.jobId, input.from, input.to, input.progress]
  );
  if (!updated.rowCount) {
    throw new Error(`AI job ${input.jobId} is no longer ${input.from}`);
  }
  await client.query(
    `INSERT INTO ai_job_events(job_id, from_status, to_status, progress, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.jobId, input.from, input.to, input.progress, input.detail ?? {}]
  );
};

export const attachEntitlementAndStart = async (
  jobId: string,
  usageId: string
) =>
  withTransaction(async (client) => {
    await client.query(
      `UPDATE ai_jobs SET entitlement_usage_id = $2 WHERE id = $1`,
      [jobId, usageId]
    );
    await transitionJob(client, {
      jobId,
      from: "QUEUED",
      to: "RUNNING",
      progress: 10
    });
  });

const persistAttempts = async (
  client: pg.PoolClient,
  jobId: string,
  attempts: readonly AiProviderAttempt[]
) => {
  for (const attempt of attempts) {
    await client.query(
      `INSERT INTO ai_provider_attempts(
         job_id, ordinal, provider_key, model, outcome, error_code, latency_ms
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        jobId,
        attempt.ordinal,
        attempt.providerKey,
        attempt.model,
        attempt.outcome,
        attempt.errorCode,
        attempt.latencyMs
      ]
    );
  }
};

export const completeAiJob = async (input: {
  jobId: string;
  usageId: string;
  providerKey: string;
  model: string;
  attempts: readonly AiProviderAttempt[];
  report: AiReport;
}) =>
  withTransaction(async (client) => {
    await persistAttempts(client, input.jobId, input.attempts);
    await client.query(
      `INSERT INTO ai_reports(job_id, schema_version, content)
       VALUES ($1, $2, $3)`,
      [input.jobId, input.report.schemaVersion, input.report]
    );
    await consumeEntitlementInTransaction(client, input.usageId);
    await transitionJob(client, {
      jobId: input.jobId,
      from: "RUNNING",
      to: "COMPLETED",
      progress: 100,
      detail: { provider: input.providerKey, model: input.model }
    });
    await client.query(
      `UPDATE ai_jobs
          SET selected_provider = $2,
              selected_model = $3,
              completed_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [input.jobId, input.providerKey, input.model]
    );
  });

export const failAiJob = async (input: {
  jobId: string;
  failureCode: string;
  attempts: readonly AiProviderAttempt[];
}) =>
  withTransaction(async (client) => {
    await persistAttempts(client, input.jobId, input.attempts);
    await transitionJob(client, {
      jobId: input.jobId,
      from: "RUNNING",
      to: "FAILED_FINAL",
      progress: 100,
      detail: { failureCode: input.failureCode }
    });
    await client.query(
      `UPDATE ai_jobs
          SET failure_code = $2,
              failure_message = NULL,
              completed_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [input.jobId, input.failureCode]
    );
  });

export const deleteQueuedAiJob = async (jobId: string) => {
  await query("DELETE FROM ai_jobs WHERE id = $1 AND status = 'QUEUED'", [jobId]);
};

export const recoverInterruptedAiJobs = async () =>
  withTransaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('ai-job-startup-recovery', 0))"
    );
    const active = await client.query<{
      id: string;
      status: "QUEUED" | "AWAITING_ENTITLEMENT" | "RUNNING";
    }>(
      `SELECT id, status
         FROM ai_jobs
        WHERE status IN ('QUEUED', 'AWAITING_ENTITLEMENT', 'RUNNING')
        ORDER BY created_at, id
        FOR UPDATE`
    );
    let releasedUsages = 0;
    let queuedDeleted = 0;
    let runningFailed = 0;

    for (const job of active.rows) {
      const usages = await client.query<{ id: string }>(
        `SELECT id
           FROM entitlement_usages
          WHERE business_type = 'commerce'
            AND business_id = $1
            AND status = 'reserved'
          ORDER BY created_at, id
          FOR UPDATE`,
        [job.id]
      );
      for (const usage of usages.rows) {
        await releaseEntitlementInTransaction(client, usage.id);
        releasedUsages += 1;
      }

      if (job.status === "RUNNING") {
        await transitionJob(client, {
          jobId: job.id,
          from: "RUNNING",
          to: "FAILED_FINAL",
          progress: 100,
          detail: { failureCode: "AI_JOB_INTERRUPTED" }
        });
        await client.query(
          `UPDATE ai_jobs
              SET failure_code = 'AI_JOB_INTERRUPTED',
                  failure_message = NULL,
                  completed_at = now(),
                  updated_at = now()
            WHERE id = $1`,
          [job.id]
        );
        runningFailed += 1;
      } else {
        await client.query("DELETE FROM ai_jobs WHERE id = $1", [job.id]);
        queuedDeleted += 1;
      }
    }

    return { releasedUsages, queuedDeleted, runningFailed };
  });

export const getOwnedAiJob = async (userId: string, jobId: string) => {
  const result = await query<AiJobRow>(
    `${jobSelect} WHERE j.user_id = $1 AND j.id = $2`,
    [userId, jobId]
  );
  if (!result.rows[0]) {
    throw new ApiError(404, "AI_JOB_NOT_FOUND", "分析任务不存在");
  }
  return mapJob(result.rows[0]);
};

export const getOwnedAiJobDetail = async (userId: string, jobId: string) => {
  const job = await getOwnedAiJob(userId, jobId);
  const events = await query<{
    from_status: string | null;
    to_status: string;
    progress: number;
    detail: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT from_status, to_status, progress, detail, created_at
       FROM ai_job_events
      WHERE job_id = $1
      ORDER BY id`,
    [jobId]
  );
  return {
    ...job,
    events: events.rows.map((event) => ({
      fromStatus: event.from_status,
      toStatus: event.to_status,
      progress: event.progress,
      detail: event.detail,
      createdAt: event.created_at
    }))
  };
};

export const listOwnedAiJobs = async (
  userId: string,
  limit: number,
  offset: number
) => {
  const [items, total] = await Promise.all([
    query<AiJobRow>(
      `${jobSelect}
        WHERE j.user_id = $1
        ORDER BY j.created_at DESC, j.id DESC
        LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    ),
    query<{ count: string }>(
      "SELECT count(*)::text AS count FROM ai_jobs WHERE user_id = $1",
      [userId]
    )
  ]);
  return {
    items: items.rows.map(mapJob),
    total: Number(total.rows[0]?.count ?? 0)
  };
};
