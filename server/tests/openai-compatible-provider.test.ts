import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfig, resetConfigForTests } from "../config.js";
import { runProviderChain } from "../modules/llm/router.js";
import {
  createConfiguredAiProviders,
  createOpenAiCompatibleProvider
} from "../modules/llm/openai-compatible.js";

const report = {
  schemaVersion: "1.0",
  summary: "劳动关系与解除事实需要结合证据核对。",
  riskLevel: "medium",
  findings: [
    {
      title: "解除依据待核验",
      severity: "medium",
      explanation: "现有材料尚未完整展示解除通知与送达证据。"
    }
  ],
  actions: ["补充解除通知和工资流水"]
};

const request = {
  jobId: "00000000-0000-4000-8000-000000000001",
  kind: "severance_analysis" as const,
  input: { situation: "公司口头通知解除劳动合同，但没有提供书面依据。" },
  uploads: []
};

const llmEnvironmentNames = [
  "LLM_PRIMARY",
  "LLM_TUZI_BASE_URL",
  "LLM_TUZI_API_KEY",
  "LLM_TUZI_MODEL",
  "LLM_DATAEYES_BASE_URL",
  "LLM_DATAEYES_API_KEY",
  "LLM_DATAEYES_MODEL",
  "LLM_MAX_RETRIES",
  "LLM_RETRY_BACKOFF_MS",
  "LLM_REQUEST_TIMEOUT_MS"
] as const;
const originalLlmEnvironment = Object.fromEntries(
  llmEnvironmentNames.map((name) => [name, process.env[name]])
);

afterEach(() => {
  for (const name of llmEnvironmentNames) {
    const value = originalLlmEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetConfigForTests();
});

describe("OpenAI-compatible AI provider", () => {
  it("defaults to Tuzi gpt-5.6-sol with DataEyes as the configured fallback model", () => {
    delete process.env.LLM_TUZI_MODEL;
    delete process.env.LLM_DATAEYES_MODEL;
    resetConfigForTests();

    expect(getConfig()).toMatchObject({
      LLM_PRIMARY: "tuzi",
      LLM_TUZI_MODEL: "gpt-5.6-sol",
      LLM_DATAEYES_MODEL: "gpt-5.6-sol"
    });
  });

  it("defaults the Tuzi route to gpt-5.6-sol", () => {
    delete process.env.LLM_TUZI_MODEL;
    resetConfigForTests();

    expect(getConfig().LLM_TUZI_MODEL).toBe("gpt-5.6-sol");
  });

  it("loads the shared OranMemory-style environment contract", () => {
    process.env.LLM_PRIMARY = "dataeyes";
    process.env.LLM_TUZI_BASE_URL = "https://tuzi.example/v1/";
    process.env.LLM_TUZI_API_KEY = "tuzi-key";
    process.env.LLM_TUZI_MODEL = "tuzi-model";
    process.env.LLM_DATAEYES_BASE_URL = "https://dataeyes.example";
    process.env.LLM_DATAEYES_API_KEY = "dataeyes-key";
    process.env.LLM_DATAEYES_MODEL = "dataeyes-model";
    process.env.LLM_MAX_RETRIES = "4";
    process.env.LLM_RETRY_BACKOFF_MS = "250";
    process.env.LLM_REQUEST_TIMEOUT_MS = "45000";
    resetConfigForTests();

    const config = getConfig();
    expect(config).toMatchObject({
      LLM_PRIMARY: "dataeyes",
      LLM_TUZI_BASE_URL: "https://tuzi.example/v1",
      LLM_TUZI_MODEL: "tuzi-model",
      LLM_DATAEYES_BASE_URL: "https://dataeyes.example",
      LLM_DATAEYES_MODEL: "dataeyes-model",
      LLM_MAX_RETRIES: 4,
      LLM_RETRY_BACKOFF_MS: 250,
      LLM_REQUEST_TIMEOUT_MS: 45_000
    });
  });

  it("keeps OranMemory provider ordering while omitting unconfigured providers", () => {
    const providers = createConfiguredAiProviders({
      primary: "dataeyes",
      maxRetries: 3,
      retryBackoffMs: 800,
      requestTimeoutMs: 90_000,
      tuzi: {
        baseUrl: "https://api.tu-zi.com",
        apiKey: "tuzi-secret",
        model: "gpt-5.4"
      },
      dataeyes: {
        baseUrl: "https://cloud.dataeyes.ai",
        apiKey: "dataeyes-secret",
        model: "gpt-5.6-sol"
      }
    });

    expect(providers.map(({ key, model, priority }) => ({ key, model, priority })))
      .toEqual([
        { key: "dataeyes", model: "gpt-5.6-sol", priority: 1 },
        { key: "tuzi", model: "gpt-5.4", priority: 2 }
      ]);
    expect(JSON.stringify(providers)).not.toContain("secret");

    const onlyTuzi = createConfiguredAiProviders({
      primary: "tuzi",
      maxRetries: 1,
      retryBackoffMs: 0,
      requestTimeoutMs: 1_000,
      tuzi: {
        baseUrl: "https://api.tu-zi.com",
        apiKey: "tuzi-secret",
        model: "gpt-5.4"
      },
      dataeyes: {
        baseUrl: "https://cloud.dataeyes.ai",
        apiKey: "",
        model: "gpt-5.6-sol"
      }
    });
    expect(onlyTuzi.map((provider) => provider.key)).toEqual(["tuzi"]);
  });

  it("retries transient failures and parses a fenced structured report", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({
          choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(report)}\n\`\`\`` } }]
        })
      );
    const sleep = vi.fn().mockResolvedValue(undefined);
    const provider = createOpenAiCompatibleProvider(
      {
        key: "tuzi",
        baseUrl: "https://api.tu-zi.com",
        apiKey: "provider-secret",
        model: "gpt-5.4",
        priority: 1,
        maxRetries: 3,
        retryBackoffMs: 25,
        requestTimeoutMs: 2_000
      },
      { fetchImpl, sleep }
    );

    await expect(provider.analyze(request)).resolves.toEqual(report);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(25);
    const [url, init] = fetchImpl.mock.calls[1];
    expect(String(url)).toBe("https://api.tu-zi.com/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer provider-secret");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("gpt-5.4");
    expect(body.messages[1].content).toContain("公司口头通知解除劳动合同");
  });

  it("switches provider immediately after a permanent upstream rejection", async () => {
    const firstFetch = vi.fn().mockResolvedValue(
      new Response("unauthorized", { status: 401 })
    );
    const secondFetch = vi.fn().mockResolvedValue(
      Response.json({ choices: [{ message: { content: JSON.stringify(report) } }] })
    );
    const first = createOpenAiCompatibleProvider(
      {
        key: "tuzi",
        baseUrl: "https://api.tu-zi.com",
        apiKey: "first-key",
        model: "gpt-5.4",
        priority: 1,
        maxRetries: 3,
        retryBackoffMs: 1,
        requestTimeoutMs: 2_000
      },
      { fetchImpl: firstFetch, sleep: vi.fn() }
    );
    const second = createOpenAiCompatibleProvider(
      {
        key: "dataeyes",
        baseUrl: "https://cloud.dataeyes.ai/v1",
        apiKey: "second-key",
        model: "gpt-5.6-sol",
        priority: 2,
        maxRetries: 1,
        retryBackoffMs: 1,
        requestTimeoutMs: 2_000
      },
      { fetchImpl: secondFetch, sleep: vi.fn() }
    );

    const result = await runProviderChain([first, second], request);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.providerKey).toBe("dataeyes");
      expect(result.attempts.map((attempt) => attempt.outcome)).toEqual([
        "failed",
        "succeeded"
      ]);
    }
    expect(firstFetch).toHaveBeenCalledTimes(1);
    expect(secondFetch).toHaveBeenCalledTimes(1);
    expect(String(secondFetch.mock.calls[0][0])).toBe(
      "https://cloud.dataeyes.ai/v1/chat/completions"
    );
  });

  it("sends images as multimodal parts without duplicating base64 into the text prompt", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({ choices: [{ message: { content: JSON.stringify(report) } }] })
    );
    const provider = createOpenAiCompatibleProvider(
      {
        key: "tuzi",
        baseUrl: "https://api.tu-zi.com",
        apiKey: "provider-key",
        model: "gpt-5.4",
        priority: 1,
        maxRetries: 1,
        retryBackoffMs: 0,
        requestTimeoutMs: 2_000
      },
      { fetchImpl, sleep: vi.fn() }
    );
    const imageDataUrl = "data:image/png;base64,iVBORw0KGgo=";

    await provider.analyze({
      ...request,
      kind: "document_review",
      uploads: [{
        id: "00000000-0000-4000-8000-000000000010",
        originalName: "解除通知.png",
        mimeType: "image/png",
        sizeBytes: "8",
        imageDataUrl
      }]
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1].body));
    const content = body.messages[1].content;
    expect(content).toEqual([
      expect.objectContaining({ type: "text" }),
      { type: "image_url", image_url: { url: imageDataUrl } }
    ]);
    expect(content[0].text).not.toContain(imageDataUrl);
    expect(content[0].text).toContain("解除通知.png");
  });
});
