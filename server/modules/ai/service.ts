import {
  releaseEntitlement,
  reserveEntitlement
} from "../commerce/entitlements.js";
import { CommerceError } from "../commerce/types.js";
import { ApiError } from "../../errors.js";
import { runProviderChain } from "../llm/router.js";
import type { AiJobKind, AiProvider } from "../llm/types.js";
import { loadOwnedProviderMaterials } from "./materials.js";
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

    let providerUploads = uploadMetadata;
    if (providers.some((provider) => provider.materialMode === "content")) {
      try {
        providerUploads = await loadOwnedProviderMaterials(
          input.userId,
          input.uploadIds
        );
      } catch (error) {
        await deleteQueuedAiJob(persisted.job.id);
        throw error;
      }
    }

    const sku = input.kind === "severance_analysis"
      ? "AI_SEVERANCE_ANALYSIS"
      : "AI_DOCUMENT_REVIEW";
    let reservation;
    try {
      reservation = await reserveEntitlement(
        input.userId,
        sku,
        persisted.job.id
      );
      await attachEntitlementAndStart(
        persisted.job.id,
        reservation.usageId
      );
    } catch (error) {
      if (reservation) {
        await releaseEntitlement(reservation.usageId);
      }
      await deleteQueuedAiJob(persisted.job.id);
      if (
        error instanceof CommerceError &&
        error.code === "ENTITLEMENT_NOT_AVAILABLE"
      ) {
        throw new ApiError(
          402,
          "AI_ENTITLEMENT_REQUIRED",
          "本次 AI 分析需要可用次数",
          { sku }
        );
      }
      throw error;
    }

    let routed;
    try {
      routed = await runProviderChain(providers, {
        jobId: persisted.job.id,
        kind: input.kind,
        input: input.payload,
        uploads: providerUploads
      });
    } catch {
      await releaseEntitlement(reservation.usageId);
      await failAiJob({
        jobId: persisted.job.id,
        failureCode: "AI_PROVIDER_CONFIGURATION_ERROR",
        attempts: []
      });
      return {
        created: true,
        job: await getOwnedAiJob(input.userId, persisted.job.id)
      };
    }

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
