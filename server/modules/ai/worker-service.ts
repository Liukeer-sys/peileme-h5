import { ApiError } from "../../errors.js";
import { query } from "../../db.js";
import { runProviderChain } from "../llm/router.js";
import type { AiProvider, AiProviderAttempt } from "../llm/types.js";
import { loadOwnedProviderMaterials } from "./materials.js";
import {
  claimNextAiJob,
  completeAiJob,
  failAiJob,
  recoverExpiredAiJobs,
  renewAiJobLease,
  requeueAiJob
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
    let routed;
    try {
      routed = await runProviderChain(providers, {
        jobId: job.id,
        kind: job.kind,
        input: job.input,
        uploads
      });
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
