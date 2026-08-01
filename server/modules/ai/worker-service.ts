import { ApiError } from "../../errors.js";
import { query } from "../../db.js";
import { runProviderChain } from "../llm/router.js";
import type { AiProvider, AiProviderAttempt } from "../llm/types.js";
import { loadOwnedProviderMaterials } from "./materials.js";
import {
  appendAiJobStreamChunk,
  advanceAiJobProgress,
  claimNextAiJob,
  completeAiJob,
  failAiJob,
  recoverExpiredAiJobs,
  renewAiJobLease,
  requeueAiJob,
  setAiJobProgress
} from "./repository.js";

export type AiWorkerOptions = {
  workerId: string;
  leaseSeconds: number;
  maxAttempts: number;
  retryDelayMilliseconds: number;
};

export type AiWorkerTickResult =
  | { processed: false }
  | {
      processed: true;
      jobId: string;
      status: "completed" | "failed" | "requeued";
      provider?: string;
      failureCode?: string;
    };

const finishOperationalRun = async (
  id: number,
  status: "succeeded" | "failed",
  detail: Record<string, unknown>
) => {
  await query(
    `UPDATE operational_job_runs
        SET status = $2,
            finished_at = now(),
            detail = $3
      WHERE id = $1`,
    [id, status, detail]
  );
};

const terminalFailureCode = (error: unknown) => {
  if (error instanceof ApiError) return error.code;
  return "AI_WORKER_UNEXPECTED_ERROR";
};

export const processNextAiJob = async (
  providers: readonly AiProvider[],
  options: AiWorkerOptions
): Promise<AiWorkerTickResult> => {
  const job = await claimNextAiJob(options.workerId, options.leaseSeconds);
  if (!job) return { processed: false };

  const run = await query<{ id: number }>(
    `INSERT INTO operational_job_runs(job_name, status, started_at, detail)
     VALUES ('ai-analysis-worker', 'running', now(), $1)
     RETURNING id`,
    [{ jobId: job.id, attempt: job.attemptCount, workerId: options.workerId }]
  );
  const runId = run.rows[0].id;
  const renewal = setInterval(() => {
    void renewAiJobLease(job.id, options.workerId, options.leaseSeconds).catch(
      () => undefined
    );
  }, Math.max(10_000, Math.floor(options.leaseSeconds * 1_000 / 3)));
  renewal.unref();
  const publishProgress = (
    progress: number,
    stage: string,
    detail?: Record<string, unknown>
  ) =>
    setAiJobProgress({
      jobId: job.id,
      workerId: options.workerId,
      jobAttempt: job.attemptCount,
      progress,
      stage,
      detail
    });
  await publishProgress(20, "loading_materials");
  let progressHeartbeat: NodeJS.Timeout | null = null;

  let attempts: readonly AiProviderAttempt[] = [];
  try {
    const uploads = providers.some((provider) => provider.materialMode === "content")
      ? await loadOwnedProviderMaterials(job.userId, job.uploadIds)
      : job.uploadIds.map((id) => ({
          id,
          originalName: "",
          mimeType: "application/octet-stream",
          sizeBytes: "0"
        }));
    await publishProgress(35, "materials_ready");
    let streamBuffer = "";
    let streamOrdinal = 0;
    let streamProviderKey = "";
    let streamModel = "";
    const flushStream = async () => {
      if (!streamBuffer) return;
      const text = streamBuffer;
      streamBuffer = "";
      streamOrdinal += 1;
      const persisted = await appendAiJobStreamChunk({
        jobId: job.id,
        workerId: options.workerId,
        jobAttempt: job.attemptCount,
        ordinal: streamOrdinal,
        providerKey: streamProviderKey,
        model: streamModel,
        text
      });
      if (!persisted) throw new Error("AI stream lost its Worker lease");
    };
    let routed;
    try {
      routed = await runProviderChain(providers, {
        jobId: job.id,
        kind: job.kind,
        input: job.input,
        uploads
      }, {
        onToken: async (event) => {
          streamProviderKey = event.providerKey;
          streamModel = event.model;
          streamBuffer += event.text;
          if (streamBuffer.length >= 48) await flushStream();
        },
        onEvent: async (event) => {
          if (event.type === "attempt_started") {
            const progress = event.ordinal === 1
              ? 45
              : Math.min(80, 65 + (event.ordinal - 2) * 7);
            await publishProgress(progress, "provider_started", {
              ordinal: event.ordinal,
              provider: event.providerKey,
              model: event.model
            });
            if (!progressHeartbeat) {
              progressHeartbeat = setInterval(() => {
                void advanceAiJobProgress({
                  jobId: job.id,
                  workerId: options.workerId,
                  jobAttempt: job.attemptCount,
                  increment: 3,
                  maximum: 82
                }).catch(() => undefined);
              }, 2_000);
              progressHeartbeat.unref();
            }
            return;
          }
          if (event.type === "attempt_failed" && event.hasFallback) {
            await publishProgress(
              Math.min(82, 55 + (event.attempt.ordinal - 1) * 7),
              "provider_fallback",
              {
                ordinal: event.attempt.ordinal,
                provider: event.attempt.providerKey,
                errorCode: event.attempt.errorCode
              }
            );
            return;
          }
          if (event.type === "attempt_succeeded") {
            await publishProgress(85, "provider_succeeded", {
              ordinal: event.attempt.ordinal,
              provider: event.attempt.providerKey,
              model: event.attempt.model
            });
          }
        }
      });
      await flushStream();
    } catch {
      const failureCode = "AI_PROVIDER_CONFIGURATION_ERROR";
      await failAiJob({
        jobId: job.id,
        usageId: job.entitlementUsageId,
        workerId: options.workerId,
        jobAttempt: job.attemptCount,
        failureCode,
        attempts: []
      });
      await finishOperationalRun(runId, "failed", {
        jobId: job.id,
        attempt: job.attemptCount,
        failureCode
      });
      return { processed: true, jobId: job.id, status: "failed", failureCode };
    }

    attempts = routed.attempts;
    if (routed.ok) {
      await publishProgress(95, "persisting_report");
      await completeAiJob({
        jobId: job.id,
        usageId: job.entitlementUsageId,
        workerId: options.workerId,
        jobAttempt: job.attemptCount,
        providerKey: routed.providerKey,
        model: routed.model,
        attempts: routed.attempts,
        report: routed.report
      });
      await finishOperationalRun(runId, "succeeded", {
        jobId: job.id,
        attempt: job.attemptCount,
        provider: routed.providerKey,
        fallbackUsed: routed.attempts.length > 1
      });
      return {
        processed: true,
        jobId: job.id,
        status: "completed",
        provider: routed.providerKey
      };
    }

    if (
      routed.failureCode === "AI_PROVIDER_CHAIN_EXHAUSTED" &&
      job.attemptCount < options.maxAttempts
    ) {
      await requeueAiJob({
        jobId: job.id,
        jobAttempt: job.attemptCount,
        workerId: options.workerId,
        delayMilliseconds: options.retryDelayMilliseconds,
        failureCode: routed.failureCode,
        attempts: routed.attempts
      });
      await finishOperationalRun(runId, "failed", {
        jobId: job.id,
        attempt: job.attemptCount,
        failureCode: routed.failureCode,
        requeued: true
      });
      return {
        processed: true,
        jobId: job.id,
        status: "requeued",
        failureCode: routed.failureCode
      };
    }

    await failAiJob({
      jobId: job.id,
      usageId: job.entitlementUsageId,
      workerId: options.workerId,
      jobAttempt: job.attemptCount,
      failureCode: routed.failureCode,
      attempts: routed.attempts
    });
    await finishOperationalRun(runId, "failed", {
      jobId: job.id,
      attempt: job.attemptCount,
      failureCode: routed.failureCode
    });
    return {
      processed: true,
      jobId: job.id,
      status: "failed",
      failureCode: routed.failureCode
    };
  } catch (error) {
    const failureCode = terminalFailureCode(error);
    if (
      failureCode === "AI_WORKER_UNEXPECTED_ERROR" &&
      job.attemptCount < options.maxAttempts
    ) {
      await requeueAiJob({
        jobId: job.id,
        jobAttempt: job.attemptCount,
        workerId: options.workerId,
        delayMilliseconds: options.retryDelayMilliseconds,
        failureCode,
        attempts
      });
      await finishOperationalRun(runId, "failed", {
        jobId: job.id,
        attempt: job.attemptCount,
        failureCode,
        requeued: true
      });
      return {
        processed: true,
        jobId: job.id,
        status: "requeued",
        failureCode
      };
    }
    await failAiJob({
      jobId: job.id,
      usageId: job.entitlementUsageId,
      workerId: options.workerId,
      jobAttempt: job.attemptCount,
      failureCode,
      attempts
    });
    await finishOperationalRun(runId, "failed", {
      jobId: job.id,
      attempt: job.attemptCount,
      failureCode
    });
    return { processed: true, jobId: job.id, status: "failed", failureCode };
  } finally {
    clearInterval(renewal);
    if (progressHeartbeat) clearInterval(progressHeartbeat);
  }
};

export const recoverAiWorkerQueue = (maxAttempts: number) =>
  recoverExpiredAiJobs(maxAttempts);

export const writeAiWorkerHeartbeat = async (input: {
  workerId: string;
  status: "starting" | "healthy" | "stopping";
  detail?: Record<string, unknown>;
}) => {
  await query(
    `INSERT INTO service_heartbeats(service_name, instance_id, status, detail, seen_at)
     VALUES ('ai-worker', $1, $2, $3, now())
     ON CONFLICT (service_name) DO UPDATE SET
       instance_id = EXCLUDED.instance_id,
       status = EXCLUDED.status,
       detail = EXCLUDED.detail,
       seen_at = now()`,
    [input.workerId, input.status, input.detail ?? {}]
  );
};
