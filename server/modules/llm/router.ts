import { z } from "zod";
import type {
  AiProvider,
  AiProviderAttempt,
  AiProviderRequest
} from "./types.js";

const findingSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    severity: z.enum(["low", "medium", "high"]),
    explanation: z.string().trim().min(1).max(4_000)
  })
  .strict();

export const aiReportSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    summary: z.string().trim().min(1).max(8_000),
    riskLevel: z.enum(["low", "medium", "high"]),
    findings: z.array(findingSchema).max(100),
    actions: z.array(z.string().trim().min(1).max(1_000)).max(100)
  })
  .strict();

export type AiReport = z.infer<typeof aiReportSchema>;

const safeProviderKey = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const createProviderRegistry = (
  providers: readonly AiProvider[]
): AiProvider[] => {
  const enabled = providers
    .filter((provider) => provider.enabled !== false)
    .map((provider) => {
      if (
        !safeProviderKey.test(provider.key) ||
        !provider.model.trim() ||
        !Number.isFinite(provider.priority)
      ) {
        throw new Error("Invalid AI provider registry entry");
      }
      return provider;
    })
    .sort(
      (left, right) =>
        left.priority - right.priority || left.key.localeCompare(right.key)
    );
  if (new Set(enabled.map((provider) => provider.key)).size !== enabled.length) {
    throw new Error("Duplicate AI provider registry key");
  }
  return enabled;
};

const classifyProviderError = (error: unknown) => {
  if (error instanceof z.ZodError) return "INVALID_OUTPUT";
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  if (name.includes("timeout")) return "TIMEOUT";
  if (name.includes("ratelimit")) return "RATE_LIMITED";
  return "PROVIDER_ERROR";
};

export type ProviderChainResult =
  | {
      ok: true;
      report: AiReport;
      providerKey: string;
      model: string;
      attempts: AiProviderAttempt[];
    }
  | {
      ok: false;
      failureCode:
        | "AI_PROVIDER_NOT_CONFIGURED"
        | "AI_PROVIDER_CHAIN_EXHAUSTED"
        | "AI_PROVIDER_STREAM_INTERRUPTED";
      attempts: AiProviderAttempt[];
    };

export type ProviderChainEvent =
  | {
      type: "attempt_started";
      ordinal: number;
      providerKey: string;
      model: string;
    }
  | {
      type: "attempt_failed";
      attempt: AiProviderAttempt;
      hasFallback: boolean;
    }
  | {
      type: "attempt_succeeded";
      attempt: AiProviderAttempt;
    };

type ProviderChainOptions = {
  onEvent?: (event: ProviderChainEvent) => void | Promise<void>;
  onToken?: (event: {
    providerKey: string;
    model: string;
    text: string;
  }) => void | Promise<void>;
};

export const runProviderChain = async (
  providers: readonly AiProvider[],
  request: AiProviderRequest,
  options: ProviderChainOptions = {}
): Promise<ProviderChainResult> => {
  const chain = createProviderRegistry(providers);
  if (!chain.length) {
    return {
      ok: false,
      failureCode: "AI_PROVIDER_NOT_CONFIGURED",
      attempts: []
    };
  }

  const attempts: AiProviderAttempt[] = [];
  for (const [index, provider] of chain.entries()) {
    await options.onEvent?.({
      type: "attempt_started",
      ordinal: index + 1,
      providerKey: provider.key,
      model: provider.model
    });
    const startedAt = performance.now();
    let report: AiReport;
    let emittedAnyToken = false;
    try {
      const rawReport = provider.analyzeStream && options.onToken
        ? await provider.analyzeStream(request, async (text) => {
            if (!text) return;
            emittedAnyToken = true;
            await options.onToken?.({
              providerKey: provider.key,
              model: provider.model,
              text
            });
          })
        : await provider.analyze(request);
      report = aiReportSchema.parse(rawReport);
    } catch (error) {
      const attempt: AiProviderAttempt = {
        ordinal: index + 1,
        providerKey: provider.key,
        model: provider.model,
        outcome: "failed",
        errorCode: classifyProviderError(error),
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt))
      };
      attempts.push(attempt);
      await options.onEvent?.({
        type: "attempt_failed",
        attempt,
        hasFallback: !emittedAnyToken && index + 1 < chain.length
      });
      if (emittedAnyToken) {
        return {
          ok: false,
          failureCode: "AI_PROVIDER_STREAM_INTERRUPTED",
          attempts
        };
      }
      continue;
    }
    const attempt: AiProviderAttempt = {
      ordinal: index + 1,
      providerKey: provider.key,
      model: provider.model,
      outcome: "succeeded",
      errorCode: null,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt))
    };
    attempts.push(attempt);
    await options.onEvent?.({ type: "attempt_succeeded", attempt });
    return {
      ok: true,
      report,
      providerKey: provider.key,
      model: provider.model,
      attempts
    };
  }
  return {
    ok: false,
    failureCode: "AI_PROVIDER_CHAIN_EXHAUSTED",
    attempts
  };
};
