export type AiJobKind = "severance_analysis" | "document_review";

export type AiProviderRequest = {
  jobId: string;
  kind: AiJobKind;
  input: Record<string, unknown>;
  uploads: Array<{
    id: string;
    originalName: string;
    mimeType: string;
    sizeBytes: string;
  }>;
};

export type AiProvider = {
  key: string;
  model: string;
  priority: number;
  enabled?: boolean;
  analyze: (request: AiProviderRequest) => Promise<unknown>;
};

export type AiProviderAttempt = {
  ordinal: number;
  providerKey: string;
  model: string;
  outcome: "succeeded" | "failed";
  errorCode: string | null;
  latencyMs: number;
};
