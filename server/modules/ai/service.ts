import {
  releaseEntitlement,
  reserveEntitlement
} from "../commerce/entitlements.js";
import { CommerceError } from "../commerce/types.js";
import { ApiError } from "../../errors.js";
import type { AiJobKind } from "../llm/types.js";
import {
  attachEntitlementToQueuedJob,
  createOrLoadAiJob,
  deleteQueuedAiJob,
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

export const createAiAnalysisService = () => ({
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
      await attachEntitlementToQueuedJob(
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

    return {
      created: true,
      job: persisted.job
    };
  }
});
