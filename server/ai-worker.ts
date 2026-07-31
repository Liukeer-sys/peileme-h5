import crypto from "node:crypto";
import http from "node:http";
import { closePool } from "./db.js";
import { getConfig } from "./config.js";
import { runMigrations } from "./migrate.js";
import {
  processNextAiJob,
  recoverAiWorkerQueue,
  writeAiWorkerHeartbeat
} from "./modules/ai/worker-service.js";
import { createConfiguredAiProviders } from "./modules/llm/openai-compatible.js";

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const start = async () => {
  await runMigrations();
  const config = getConfig();
  const workerId = `ai-worker-${crypto.randomUUID()}`;
  const providers = createConfiguredAiProviders({
    primary: config.LLM_PRIMARY,
    maxRetries: config.LLM_MAX_RETRIES,
    retryBackoffMs: config.LLM_RETRY_BACKOFF_MS,
    requestTimeoutMs: config.LLM_REQUEST_TIMEOUT_MS,
    tuzi: {
      baseUrl: config.LLM_TUZI_BASE_URL,
      apiKey: config.LLM_TUZI_API_KEY,
      model: config.LLM_TUZI_MODEL
    },
    dataeyes: {
      baseUrl: config.LLM_DATAEYES_BASE_URL,
      apiKey: config.LLM_DATAEYES_API_KEY,
      model: config.LLM_DATAEYES_MODEL
    }
  });
  const options = {
    workerId,
    leaseSeconds: config.AI_WORKER_LEASE_SECONDS,
    maxAttempts: config.AI_WORKER_MAX_ATTEMPTS,
    retryDelayMilliseconds: config.AI_WORKER_RETRY_DELAY_MS
  };
  let running = true;
  let busy = false;
  let lastTickAt = new Date();
  let lastError: string | null = null;
  let nextRecoveryAt = 0;

  await writeAiWorkerHeartbeat({
    workerId,
    status: "starting",
    detail: { providers: providers.map((provider) => provider.key) }
  });
  await recoverAiWorkerQueue(config.AI_WORKER_MAX_ATTEMPTS);

  const server = http.createServer((_request, response) => {
    const fresh = Date.now() - lastTickAt.getTime() < 30_000;
    response.statusCode = fresh ? 200 : 503;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      status: fresh ? "healthy" : "stale",
      service: "ai-worker",
      workerId,
      busy,
      lastTickAt: lastTickAt.toISOString(),
      lastError
    }));
  });
  server.listen(config.AI_WORKER_PORT, "0.0.0.0", () => {
    console.log(`Peileme AI worker health listening on 0.0.0.0:${config.AI_WORKER_PORT}`);
  });

  const heartbeat = setInterval(() => {
    lastTickAt = new Date();
    void writeAiWorkerHeartbeat({
      workerId,
      status: "healthy",
      detail: { busy, lastTickAt: lastTickAt.toISOString(), lastError }
    }).catch((error) => {
      lastError = error instanceof Error ? error.message : "heartbeat failed";
    });
  }, 10_000);
  heartbeat.unref();

  const shutdown = async (signal: string) => {
    if (!running) return;
    running = false;
    console.log(`Received ${signal}, stopping AI worker`);
    clearInterval(heartbeat);
    await writeAiWorkerHeartbeat({ workerId, status: "stopping" }).catch(() => undefined);
    server.close();
    const deadline = Date.now() + 20_000;
    while (busy && Date.now() < deadline) await delay(100);
    await closePool();
    process.exit(busy ? 1 : 0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  while (running) {
    try {
      if (Date.now() >= nextRecoveryAt) {
        await recoverAiWorkerQueue(config.AI_WORKER_MAX_ATTEMPTS);
        nextRecoveryAt = Date.now() + 60_000;
      }
      busy = true;
      const result = await processNextAiJob(providers, options);
      lastError = null;
      lastTickAt = new Date();
      busy = false;
      if (!result.processed) await delay(config.AI_WORKER_POLL_MS);
    } catch (error) {
      busy = false;
      lastTickAt = new Date();
      lastError = error instanceof Error ? error.message : "worker tick failed";
      console.error(error);
      await delay(config.AI_WORKER_POLL_MS);
    }
  }
};

start().catch(async (error) => {
  console.error(error);
  await closePool();
  process.exit(1);
});
