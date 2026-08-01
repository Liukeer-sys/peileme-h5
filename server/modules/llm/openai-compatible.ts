import type { AiProvider, AiProviderRequest } from "./types.js";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

type ProviderRuntime = {
  key: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  priority: number;
  maxRetries: number;
  retryBackoffMs: number;
  requestTimeoutMs: number;
};

export type AiProviderChainConfig = {
  primary: "tuzi" | "dataeyes";
  maxRetries: number;
  retryBackoffMs: number;
  requestTimeoutMs: number;
  tuzi: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  dataeyes: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
};

class UpstreamProviderError extends Error {
  constructor(
    message: string,
    readonly transient: boolean
  ) {
    super(message);
    this.name = transient ? "ProviderTransientError" : "ProviderError";
  }
}

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const isTransientStatus = (status: number) =>
  status === 408 || status === 429 || status >= 500;

const completionUrl = (baseUrl: string) => {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/v1")
    ? `${normalized}/chat/completions`
    : `${normalized}/v1/chat/completions`;
};

const systemPrompt = `你是“赔了么”的劳动政策与文件风险分析助手。
只基于用户提供的事实和材料输出，不虚构法律依据或材料内容。
输出必须是一个 JSON 对象，禁止 Markdown 和额外解释，并严格符合：
{
  "schemaVersion": "1.0",
  "summary": "中文总结",
  "riskLevel": "low|medium|high",
  "findings": [{"title":"标题","severity":"low|medium|high","explanation":"说明"}],
  "actions": ["下一步行动"]
}`;

const userPrompt = (request: AiProviderRequest) => {
  const uploads = request.uploads.map(({ imageDataUrl: _imageDataUrl, ...upload }) => upload);
  return JSON.stringify({
    task:
      request.kind === "document_review"
        ? "审查用户上传的劳动文件，识别签署、解除、补偿与证据风险"
        : "分析离职补偿情形、风险和下一步行动",
    jobId: request.jobId,
    input: request.input,
    uploads
  });
};

const userContent = (request: AiProviderRequest) => {
  const images = request.uploads.flatMap((upload) =>
    upload.imageDataUrl
      ? [{ type: "image_url", image_url: { url: upload.imageDataUrl } }]
      : []
  );
  if (!images.length) return userPrompt(request);
  return [
    { type: "text", text: userPrompt(request) },
    ...images
  ];
};

const extractJson = (raw: string) => {
  let value = raw.trim();
  if (value.startsWith("```")) {
    value = value
      .replace(/^```[a-zA-Z0-9_-]*\s*/, "")
      .replace(/\s*```$/, "")
      .trim();
  }
  const firstObject = value.indexOf("{");
  const lastObject = value.lastIndexOf("}");
  if (firstObject < 0 || lastObject < firstObject) {
    throw new UpstreamProviderError("provider returned non-JSON content", true);
  }
  return JSON.parse(value.slice(firstObject, lastObject + 1));
};

const readErrorBody = async (response: Response) => {
  try {
    return (await response.text()).replace(/\s+/g, " ").slice(0, 200);
  } catch {
    return "unreadable response";
  }
};

const readStreamingContent = async (
  response: Response,
  onToken: (token: string) => void | Promise<void>
) => {
  if (!response.body) {
    throw new UpstreamProviderError("provider returned an empty stream", true);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";

  const consumeLine = async (rawLine: string) => {
    const line = rawLine.replace(/\r$/, "");
    if (!line.startsWith("data:")) return false;
    const data = line.slice(5).trimStart();
    if (!data) return false;
    if (data === "[DONE]") return true;
    let payload: {
      choices?: Array<{
        delta?: { content?: unknown };
        message?: { content?: unknown };
      }>;
    };
    try {
      payload = JSON.parse(data) as typeof payload;
    } catch {
      throw new UpstreamProviderError("provider returned invalid SSE data", true);
    }
    const delta = payload.choices?.[0]?.delta?.content
      ?? payload.choices?.[0]?.message?.content;
    if (typeof delta === "string" && delta) {
      content += delta;
      await onToken(delta);
    }
    return false;
  };

  let done = false;
  while (!done) {
    const next = await reader.read();
    buffer += decoder.decode(next.value, { stream: !next.done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (await consumeLine(line)) {
        done = true;
        break;
      }
    }
    if (next.done) {
      if (buffer && !done) await consumeLine(buffer);
      break;
    }
  }
  if (!content.trim()) {
    throw new UpstreamProviderError("provider returned empty content", true);
  }
  return extractJson(content);
};

export const createOpenAiCompatibleProvider = (
  config: ProviderRuntime,
  dependencies: {
    fetchImpl?: FetchLike;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {}
): AiProvider => {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const sleep = dependencies.sleep ?? defaultSleep;
  const endpoint = completionUrl(config.baseUrl);

  const requestCompletion = async (
    request: AiProviderRequest,
    stream: boolean,
    onToken?: (token: string) => void | Promise<void>
  ) => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < config.maxRetries; attempt += 1) {
      let emittedThisAttempt = false;
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: config.model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userContent(request) }
            ],
            temperature: 0.2,
            max_tokens: 4_096,
            stream
          }),
          signal: AbortSignal.timeout(config.requestTimeoutMs)
        });
        if (!response.ok) {
          const transient = isTransientStatus(response.status);
          throw new UpstreamProviderError(
            `${config.key} HTTP ${response.status}: ${await readErrorBody(response)}`,
            transient
          );
        }
        if (stream) {
          return await readStreamingContent(response, async (token) => {
            emittedThisAttempt = true;
            await onToken?.(token);
          });
        }
        const payload = await response.json() as {
          choices?: Array<{ message?: { content?: unknown } }>;
        };
        const content = payload.choices?.[0]?.message?.content;
        if (typeof content !== "string" || !content.trim()) {
          throw new UpstreamProviderError(
            `${config.key} returned empty content`,
            true
          );
        }
        return extractJson(content);
      } catch (error) {
        lastError = error;
        const transient =
          error instanceof UpstreamProviderError
            ? error.transient
            : true;
        if (
          emittedThisAttempt ||
          !transient ||
          attempt >= config.maxRetries - 1
        ) break;
        await sleep(config.retryBackoffMs * (attempt + 1));
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw new UpstreamProviderError(`${config.key} request failed`, true);
  };

  return {
    key: config.key,
    model: config.model,
    priority: config.priority,
    materialMode: "content",
    analyze: (request) => requestCompletion(request, false),
    analyzeStream: (request, onToken) => requestCompletion(request, true, onToken)
  };
};

export const createConfiguredAiProviders = (
  config: AiProviderChainConfig
): AiProvider[] => {
  const definitions = {
    tuzi: config.tuzi,
    dataeyes: config.dataeyes
  } as const;
  const order = config.primary === "dataeyes"
    ? ["dataeyes", "tuzi"] as const
    : ["tuzi", "dataeyes"] as const;
  return order.flatMap((key, index) => {
    const definition = definitions[key];
    if (!definition.apiKey.trim()) return [];
    return [
      createOpenAiCompatibleProvider({
        key,
        baseUrl: definition.baseUrl,
        apiKey: definition.apiKey,
        model: definition.model,
        priority: index + 1,
        maxRetries: config.maxRetries,
        retryBackoffMs: config.retryBackoffMs,
        requestTimeoutMs: config.requestTimeoutMs
      })
    ];
  });
};
