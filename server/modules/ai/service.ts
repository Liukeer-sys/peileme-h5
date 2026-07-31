import {
  releaseEntitlement,
  reserveEntitlement
} from "../commerce/entitlements.js";
import { runProviderChain } from "../llm/router.js";
import type { AiJobKind, AiProvider } from "../llm/types.js";
import {
  attachEntitlementAndStart,
  completeAiJob,
  createOrLoadAiJob,
  deleteQueuedAiJob,
  failAiJob,
  getOwnedAiJob,
  hashAiJobInput,
  loadOwnedUploadMetadata
} from "./repository.js";

type CreateJobInput = {
  userId: string;
  kind: AiJobKind;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  uploadIds: string[];
};

export const createAiAnalysisService = (
  providers: readonly AiProvider[] = []
) => ({
  createJob: async (input: CreateJobInput) => {
    const uploadMetadata = await loadOwnedUploadMetadata(
      input.userId,
      input.uploadIds
    );
    const inputHash = hashAiJobInput({
      kind: input.kind,
      payload: input.payload,
      uploadIds: input.uploadIds
    });
    const persisted = await createOrLoadAiJob({
      userId: input.userId,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      inputHash,
      inputMetadata: input.payload,
      uploadMetadata
    });
    if (!persisted.created) return persisted;

    let reservation;
    try {
      reservation = await reserveEntitlement(
        input.userId,
        input.kind === "severance_analysis"
          ? "AI_SEVERANCE_ANALYSIS"
          : "AI_DOCUMENT_REVIEW",
        persisted.job.id
      );
      await attachEntitlementAndStart(
        persisted.job.id,
        reservation.usageId
      );
    } catch (error) {
      await deleteQueuedAiJob(persisted.job.id);
      throw error;
    }

    const routed = await runProviderChain(providers, {
      jobId: persisted.job.id,
      kind: input.kind,
      input: input.payload,
      uploads: uploadMetadata
    });

    if (routed.ok) {
      await completeAiJob({
        jobId: persisted.job.id,
        usageId: reservation.usageId,
        providerKey: routed.providerKey,
        model: routed.model,
        attempts: routed.attempts,
        report: routed.report
      });
    } else {
      await releaseEntitlement(reservation.usageId);
      await failAiJob({
        jobId: persisted.job.id,
        failureCode: routed.failureCode,
        attempts: routed.attempts
      });
    }

    return {
      created: true,
      job: await getOwnedAiJob(input.userId, persisted.job.id)
    };
  }
});
