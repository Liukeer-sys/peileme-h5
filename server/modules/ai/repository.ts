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
  attempt_count: number;
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

export type WorkerAiJob = {
  id: string;
  userId: string;
  kind: AiJobKind;
  input: Record<string, unknown>;
  uploadIds: string[];
  entitlementUsageId: string;
  attemptCount: number;
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
    j.attempt_count,
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
    workerId?: string;
    jobAttempt?: number;
  }
) => {
  const fenced = input.workerId !== undefined && input.jobAttempt !== undefined;
  const updated = await client.query(
    `UPDATE ai_jobs
        SET status = $3,
            progress = $4,
            updated_at = now()
      WHERE id = $1
        AND status = $2
        ${fenced ? "AND claimed_by = $5 AND attempt_count = $6" : ""}
      RETURNING id`,
    fenced
      ? [input.jobId, input.from, input.to, input.progress, input.workerId, input.jobAttempt]
      : [input.jobId, input.from, input.to, input.progress]
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

export const attachEntitlementToQueuedJob = async (
  jobId: string,
  usageId: string
) =>
  withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE ai_jobs
          SET entitlement_usage_id = $2,
              available_at = now(),
              updated_at = now()
        WHERE id = $1
          AND status = 'QUEUED'
          AND entitlement_usage_id IS NULL
      RETURNING id`,
      [jobId, usageId]
    );
    if (!updated.rowCount) {
      throw new Error(`AI job ${jobId} cannot accept an entitlement`);
    }
  });

export const claimNextAiJob = async (
  workerId: string,
  leaseSeconds: number
): Promise<WorkerAiJob | null> =>
  withTransaction(async (client) => {
    const selected = await client.query<{
      id: string;
      user_id: string;
      kind: AiJobKind;
      input_metadata: Record<string, unknown>;
      upload_metadata: AiUploadMetadata[];
      entitlement_usage_id: string;
      attempt_count: number;
    }>(
      `SELECT id, user_id, kind, input_metadata, upload_metadata,
              entitlement_usage_id, attempt_count
         FROM ai_jobs
        WHERE status = 'QUEUED'
          AND entitlement_usage_id IS NOT NULL
          AND available_at <= now()
        ORDER BY available_at, created_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED`
    );
    const job = selected.rows[0];
    if (!job) return null;
    await client.query(
      `UPDATE ai_jobs
          SET status = 'RUNNING',
              progress = 10,
              attempt_count = attempt_count + 1,
              claimed_by = $2,
              claimed_at = now(),
              lease_expires_at = now() + ($3 || ' seconds')::interval,
              updated_at = now()
        WHERE id = $1`,
      [job.id, workerId, leaseSeconds]
    );
    await client.query(
      `INSERT INTO ai_job_events(job_id, from_status, to_status, progress, detail)
       VALUES ($1, 'QUEUED', 'RUNNING', 10, $2)`,
      [job.id, {
        workerId,
        attempt: job.attempt_count + 1,
        stage: "claimed"
      }]
    );
    return {
      id: job.id,
      userId: job.user_id,
      kind: job.kind,
      input: job.input_metadata,
      uploadIds: job.upload_metadata.map((upload) => upload.id),
      entitlementUsageId: job.entitlement_usage_id,
      attemptCount: job.attempt_count + 1
    };
  });

export const renewAiJobLease = async (
  jobId: string,
  workerId: string,
  leaseSeconds: number
) => {
  const renewed = await query(
    `UPDATE ai_jobs
        SET lease_expires_at = now() + ($3 || ' seconds')::interval,
            updated_at = now()
      WHERE id = $1
        AND status = 'RUNNING'
        AND claimed_by = $2`,
    [jobId, workerId, leaseSeconds]
  );
  return renewed.rowCount === 1;
};

export const setAiJobProgress = async (input: {
  jobId: string;
  workerId: string;
  jobAttempt: number;
  progress: number;
  stage: string;
  detail?: Record<string, unknown>;
}) =>
  withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE ai_jobs
          SET progress = GREATEST(progress, $4),
              updated_at = now()
        WHERE id = $1
          AND status = 'RUNNING'
          AND claimed_by = $2
          AND attempt_count = $3
      RETURNING progress`,
      [input.jobId, input.workerId, input.jobAttempt, input.progress]
    );
    if (!updated.rowCount) return false;
    await client.query(
      `INSERT INTO ai_job_events(job_id, from_status, to_status, progress, detail)
       VALUES ($1, 'RUNNING', 'RUNNING', $2, $3)`,
      [input.jobId, updated.rows[0].progress, {
        stage: input.stage,
        ...input.detail
      }]
    );
    return true;
  });

export const appendAiJobStreamChunk = async (input: {
  jobId: string;
  workerId: string;
  jobAttempt: number;
  ordinal: number;
  providerKey: string;
  model: string;
  text: string;
}) => {
  if (!input.text) return false;
  const inserted = await query(
    `INSERT INTO ai_job_events(job_id, from_status, to_status, progress, detail)
     SELECT id, 'RUNNING', 'RUNNING', progress, $4
       FROM ai_jobs
      WHERE id = $1
        AND status = 'RUNNING'
        AND claimed_by = $2
        AND attempt_count = $3
     RETURNING id`,
    [
      input.jobId,
      input.workerId,
      input.jobAttempt,
      {
        stage: "stream_chunk",
        ordinal: input.ordinal,
        provider: input.providerKey,
        model: input.model,
        text: input.text
      }
    ]
  );
  return inserted.rowCount === 1;
};

export const advanceAiJobProgress = async (input: {
  jobId: string;
  workerId: string;
  jobAttempt: number;
  increment: number;
  maximum: number;
}) => {
  const updated = await query(
    `UPDATE ai_jobs
        SET progress = LEAST($5, progress + $4),
            updated_at = now()
      WHERE id = $1
        AND status = 'RUNNING'
        AND claimed_by = $2
        AND attempt_count = $3
        AND progress < $5`,
    [
      input.jobId,
      input.workerId,
      input.jobAttempt,
      input.increment,
      input.maximum
    ]
  );
  return updated.rowCount === 1;
};

const persistAttempts = async (
  client: pg.PoolClient,
  jobId: string,
  jobAttempt: number,
  attempts: readonly AiProviderAttempt[]
) => {
  for (const attempt of attempts) {
    await client.query(
      `INSERT INTO ai_provider_attempts(
         job_id, job_attempt, ordinal, provider_key, model, outcome, error_code, latency_ms
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        jobId,
        jobAttempt,
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
  workerId: string;
  providerKey: string;
  model: string;
  jobAttempt: number;
  attempts: readonly AiProviderAttempt[];
  report: AiReport;
}) =>
  withTransaction(async (client) => {
    await persistAttempts(client, input.jobId, input.jobAttempt, input.attempts);
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
      detail: { provider: input.providerKey, model: input.model },
      workerId: input.workerId,
      jobAttempt: input.jobAttempt
    });
    await client.query(
      `UPDATE ai_jobs
          SET selected_provider = $2,
              selected_model = $3,
              claimed_by = NULL,
              claimed_at = NULL,
              lease_expires_at = NULL,
              completed_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [input.jobId, input.providerKey, input.model]
    );
  });

export const failAiJob = async (input: {
  jobId: string;
  failureCode: string;
  usageId: string;
  workerId: string;
  jobAttempt: number;
  attempts: readonly AiProviderAttempt[];
}) =>
  withTransaction(async (client) => {
    await persistAttempts(client, input.jobId, input.jobAttempt, input.attempts);
    await releaseEntitlementInTransaction(client, input.usageId);
    await transitionJob(client, {
      jobId: input.jobId,
      from: "RUNNING",
      to: "FAILED_FINAL",
      progress: 100,
      detail: { failureCode: input.failureCode },
      workerId: input.workerId,
      jobAttempt: input.jobAttempt
    });
    await client.query(
      `UPDATE ai_jobs
          SET failure_code = $2,
              failure_message = NULL,
              claimed_by = NULL,
              claimed_at = NULL,
              lease_expires_at = NULL,
              completed_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [input.jobId, input.failureCode]
    );
  });

export const requeueAiJob = async (input: {
  jobId: string;
  jobAttempt: number;
  workerId: string;
  delayMilliseconds: number;
  failureCode: string;
  attempts: readonly AiProviderAttempt[];
}) =>
  withTransaction(async (client) => {
    await persistAttempts(client, input.jobId, input.jobAttempt, input.attempts);
    await transitionJob(client, {
      jobId: input.jobId,
      from: "RUNNING",
      to: "QUEUED",
      progress: 0,
      detail: {
        failureCode: input.failureCode,
        retryAttempt: input.jobAttempt + 1
      },
      workerId: input.workerId,
      jobAttempt: input.jobAttempt
    });
    await client.query(
      `UPDATE ai_jobs
          SET available_at = now() + ($2 || ' milliseconds')::interval,
              claimed_by = NULL,
              claimed_at = NULL,
              lease_expires_at = NULL,
              updated_at = now()
        WHERE id = $1`,
      [input.jobId, input.delayMilliseconds]
    );
  });

export const deleteQueuedAiJob = async (jobId: string) => {
  await query("DELETE FROM ai_jobs WHERE id = $1 AND status = 'QUEUED'", [jobId]);
};

export const recoverExpiredAiJobs = async (maxAttempts: number) =>
  withTransaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('ai-job-startup-recovery', 0))"
    );
    const active = await client.query<{
      id: string;
      entitlement_usage_id: string;
      attempt_count: number;
    }>(
      `SELECT id, entitlement_usage_id, attempt_count
         FROM ai_jobs
        WHERE status = 'RUNNING'
          AND entitlement_usage_id IS NOT NULL
          AND lease_expires_at < now()
        ORDER BY lease_expires_at, id
        FOR UPDATE SKIP LOCKED`
    );
    let releasedUsages = 0;
    let requeued = 0;
    let failed = 0;

    for (const job of active.rows) {
      if (job.attempt_count >= maxAttempts) {
        await releaseEntitlementInTransaction(client, job.entitlement_usage_id);
        releasedUsages += 1;
        await transitionJob(client, {
          jobId: job.id,
          from: "RUNNING",
          to: "FAILED_FINAL",
          progress: 100,
          detail: { failureCode: "AI_WORKER_LEASE_EXPIRED" }
        });
        await client.query(
          `UPDATE ai_jobs
              SET failure_code = 'AI_WORKER_LEASE_EXPIRED',
                  failure_message = NULL,
                  claimed_by = NULL,
                  claimed_at = NULL,
                  lease_expires_at = NULL,
                  completed_at = now(),
                  updated_at = now()
            WHERE id = $1`,
          [job.id]
        );
        failed += 1;
      } else {
        await transitionJob(client, {
          jobId: job.id,
          from: "RUNNING",
          to: "QUEUED",
          progress: 0,
          detail: { failureCode: "AI_WORKER_LEASE_EXPIRED", recovered: true }
        });
        await client.query(
          `UPDATE ai_jobs
              SET available_at = now(),
                  claimed_by = NULL,
                  claimed_at = NULL,
                  lease_expires_at = NULL,
                  updated_at = now()
            WHERE id = $1`,
          [job.id]
        );
        requeued += 1;
      }
      await client.query(
        `UPDATE operational_job_runs
            SET status = 'failed',
                finished_at = now(),
                detail = detail || jsonb_build_object(
                  'failureCode', 'AI_WORKER_LEASE_EXPIRED',
                  'recovered', $2::boolean
                )
          WHERE job_name = 'ai-analysis-worker'
            AND status = 'running'
            AND detail->>'jobId' = $1`,
        [job.id, job.attempt_count < maxAttempts]
      );
    }

    const abandoned = await client.query(
      `DELETE FROM ai_jobs
        WHERE status = 'QUEUED'
          AND entitlement_usage_id IS NULL
          AND created_at < now() - interval '5 minutes'`
    );
    return {
      releasedUsages,
      requeued,
      failed,
      abandoned: abandoned.rowCount ?? 0
    };
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

export const listOwnedAiJobStreamEvents = async (
  userId: string,
  jobId: string,
  afterId: number
) => {
  const job = await getOwnedAiJob(userId, jobId);
  const events = await query<{
    id: string;
    text: string;
    ordinal: number;
  }>(
    `SELECT
       id::text AS id,
       detail->>'text' AS text,
       (detail->>'ordinal')::integer AS ordinal
     FROM ai_job_events
     WHERE job_id = $1
       AND id > $2
       AND detail->>'stage' = 'stream_chunk'
     ORDER BY id
     LIMIT 200`,
    [jobId, afterId]
  );
  return { job, events: events.rows };
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
