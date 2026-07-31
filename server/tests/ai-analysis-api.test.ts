import crypto from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { closePool, query } from "../db.js";
import { runMigrations } from "../migrate.js";
import { processNextAiJob } from "../modules/ai/worker-service.js";
import { seedPolicyFoundation } from "../modules/policy/seed.js";
import { signAccessToken, type AuthUser } from "../security.js";
import type { AiProvider } from "../modules/llm/types.js";

const report = (summary: string) => ({
  schemaVersion: "1.0" as const,
  summary,
  riskLevel: "medium" as const,
  findings: [{
    title: "补偿基数需要核对",
    severity: "medium" as const,
    explanation: "建议核对解除前十二个月应发工资。"
  }],
  actions: ["整理工资流水和解除通知"]
});

const authUser = (id: string, email: string): AuthUser => ({
  id,
  role: "user",
  email,
  phone: null,
  displayName: email,
  status: "active"
});

const workerOptions = (suffix: string, maxAttempts = 1) => ({
  workerId: `test-worker-${suffix}`,
  leaseSeconds: 60,
  maxAttempts,
  retryDelayMilliseconds: 0
});

const createAiApp = (providers: readonly AiProvider[] = []) =>
  createApp({ aiProviders: providers });

const submit = async (
  token: string,
  body: Record<string, unknown>,
  expectedStatus = 202
) => request(createAiApp())
  .post("/api/ai/jobs")
  .set("host", "ai.localhost")
  .set("authorization", `Bearer ${token}`)
  .send(body)
  .expect(expectedStatus);

const detail = async (token: string, id: string) =>
  request(createAiApp())
    .get(`/api/ai/jobs/${id}`)
    .set("host", "ai.localhost")
    .set("authorization", `Bearer ${token}`)
    .expect(200);

const grant = async (userId: string, sku: string, uses = 20) => {
  await query(
    `INSERT INTO entitlements(
       user_id, product_id, source_type, total_uses, remaining_uses, status
     )
     SELECT $1, id, 'admin', $3, $3, 'active'
       FROM products
      WHERE sku = $2`,
    [userId, sku, uses]
  );
};

let userA = "";
let userB = "";
let tokenA = "";
let tokenB = "";
let uploadA = "";
let uploadB = "";

beforeAll(async () => {
  await runMigrations();
  await query(`
    TRUNCATE TABLE
      operational_job_runs,
      ai_provider_attempts,
      ai_job_events,
      ai_reports,
      ai_jobs,
      entitlement_usages,
      entitlements,
      uploads,
      assessments,
      users
    RESTART IDENTITY CASCADE
  `);
  await seedPolicyFoundation();
  const users = await query<{ id: string; email: string }>(
    `INSERT INTO users(email, display_name, role, email_verified_at)
     VALUES
       ('ai-a@peileme.test', 'AI 用户 A', 'user', now()),
       ('ai-b@peileme.test', 'AI 用户 B', 'user', now())
     RETURNING id, email`
  );
  userA = users.rows[0].id;
  userB = users.rows[1].id;
  tokenA = await signAccessToken(authUser(userA, users.rows[0].email));
  tokenB = await signAccessToken(authUser(userB, users.rows[1].email));
  await grant(userA, "AI_SEVERANCE_ANALYSIS");
  await grant(userA, "AI_DOCUMENT_REVIEW");

  const uploads = await query<{ id: string; user_id: string }>(
    `INSERT INTO uploads(
       user_id, visitor_id, original_name, stored_name, mime_type, size_bytes
     ) VALUES
       ($1, 'visitor_ai_a', 'agreement-a.pdf', $3, 'application/pdf', 1200),
       ($2, 'visitor_ai_b', 'agreement-b.pdf', $4, 'application/pdf', 1300)
     RETURNING id, user_id`,
    [userA, userB, `ai-a-${crypto.randomUUID()}.pdf`, `ai-b-${crypto.randomUUID()}.pdf`]
  );
  uploadA = uploads.rows.find((row) => row.user_id === userA)!.id;
  uploadB = uploads.rows.find((row) => row.user_id === userB)!.id;
});

afterAll(async () => {
  await closePool();
});

describe("AI asynchronous API boundary", () => {
  it("requires login, hides AI routes on the main host, and validates input", async () => {
    const validBody = {
      kind: "severance_analysis",
      idempotencyKey: "boundary-valid-1",
      input: { situation: "公司提出协商解除，工作三年，月工资一万元，需要分析补偿和证据。" }
    };
    await request(createAiApp()).post("/api/ai/jobs").set("host", "ai.localhost").send(validBody).expect(401);
    await request(createAiApp())
      .post("/api/ai/jobs")
      .set("host", "localhost")
      .set("authorization", `Bearer ${tokenA}`)
      .send(validBody)
      .expect(404);
    await request(createAiApp())
      .post("/api/ai/jobs")
      .set("host", "ai.localhost")
      .set("authorization", `Bearer ${tokenA}`)
      .send({ ...validBody, input: { situation: "太短" } })
      .expect(400);
  });

  it("returns a durable queued job before any provider is called", async () => {
    let calls = 0;
    const provider: AiProvider = {
      key: "delayed",
      model: "delayed-v1",
      priority: 1,
      analyze: async () => {
        calls += 1;
        return report("后台完成");
      }
    };
    const queued = await submit(tokenA, {
      kind: "severance_analysis",
      idempotencyKey: "async-boundary-1",
      input: { situation: "公司提出解除，工作四年，月工资一万二，需要异步分析补偿和证据。" }
    });
    expect(queued.body).toMatchObject({ status: "QUEUED", progress: 0 });
    expect(calls).toBe(0);

    const tick = await processNextAiJob([provider], workerOptions("async"));
    expect(tick).toMatchObject({ processed: true, status: "completed", jobId: queued.body.id });
    expect(calls).toBe(1);
    const completed = await detail(tokenA, queued.body.id);
    expect(completed.body).toMatchObject({
      status: "COMPLETED",
      selectedProvider: "delayed",
      report: { summary: "后台完成" }
    });
    expect(completed.body.events.map((event: { toStatus: string }) => event.toStatus)).toEqual([
      "QUEUED", "RUNNING", "COMPLETED"
    ]);
  });
});

describe("AI Worker fallback, retry and entitlement settlement", () => {
  it("falls back to the second provider and persists body-free attempt evidence", async () => {
    const calls: string[] = [];
    const providers: AiProvider[] = [
      {
        key: "primary",
        model: "primary-model",
        priority: 1,
        analyze: async () => {
          calls.push("primary");
          throw new Error("secret upstream failure body");
        }
      },
      {
        key: "fallback",
        model: "fallback-model",
        priority: 2,
        analyze: async () => {
          calls.push("fallback");
          return report("降级通道完成分析");
        }
      }
    ];
    const queued = await submit(tokenA, {
      kind: "severance_analysis",
      idempotencyKey: "fallback-success-1",
      input: { situation: "公司通知本月底解除劳动合同，工作五年，月工资一万二，需要核算补偿。" }
    });
    await expect(processNextAiJob(providers, workerOptions("fallback"))).resolves.toMatchObject({
      status: "completed",
      provider: "fallback"
    });
    expect(calls).toEqual(["primary", "fallback"]);

    const attempts = await query<{
      job_attempt: number;
      provider_key: string;
      outcome: string;
      error_code: string | null;
    }>(
      `SELECT job_attempt, provider_key, outcome, error_code
         FROM ai_provider_attempts
        WHERE job_id = $1
        ORDER BY job_attempt, ordinal`,
      [queued.body.id]
    );
    expect(attempts.rows).toEqual([
      { job_attempt: 1, provider_key: "primary", outcome: "failed", error_code: "PROVIDER_ERROR" },
      { job_attempt: 1, provider_key: "fallback", outcome: "succeeded", error_code: null }
    ]);
    expect(JSON.stringify(attempts.rows)).not.toContain("secret upstream");
    const usage = await query<{ status: string }>(
      "SELECT status FROM entitlement_usages WHERE business_id = $1",
      [queued.body.id]
    );
    expect(usage.rows[0].status).toBe("consumed");
  });

  it("requeues an exhausted chain once, then fails final and restores the use", async () => {
    const provider: AiProvider = {
      key: "broken",
      model: "broken-v1",
      priority: 1,
      analyze: async () => { throw new Error("upstream unavailable"); }
    };
    const queued = await submit(tokenA, {
      kind: "severance_analysis",
      idempotencyKey: "worker-retry-final-1",
      input: { situation: "公司要求立即离职且没有书面通知，需要验证 Worker 重试及次数退回。" }
    });
    await expect(processNextAiJob([provider], workerOptions("retry", 2))).resolves.toMatchObject({ status: "requeued" });
    await expect(processNextAiJob([provider], workerOptions("retry", 2))).resolves.toMatchObject({ status: "failed" });
    const failed = await detail(tokenA, queued.body.id);
    expect(failed.body).toMatchObject({
      status: "FAILED_FINAL",
      failureCode: "AI_PROVIDER_CHAIN_EXHAUSTED"
    });
    const usage = await query<{ status: string; remaining_uses: number }>(
      `SELECT eu.status, e.remaining_uses
         FROM entitlement_usages eu
         JOIN entitlements e ON e.id = eu.entitlement_id
        WHERE eu.business_id = $1`,
      [queued.body.id]
    );
    expect(usage.rows[0]).toMatchObject({ status: "released" });
    expect(usage.rows[0].remaining_uses).toBeGreaterThan(0);
  });

  it("fails closed without providers and releases the reservation", async () => {
    const queued = await submit(tokenA, {
      kind: "severance_analysis",
      idempotencyKey: "no-provider-async-1",
      input: { situation: "劳动合同到期公司不续签，需要验证未配置模型时任务安全失败并退回次数。" }
    });
    await expect(processNextAiJob([], workerOptions("none"))).resolves.toMatchObject({
      status: "failed",
      failureCode: "AI_PROVIDER_NOT_CONFIGURED"
    });
    const failed = await detail(tokenA, queued.body.id);
    expect(failed.body).toMatchObject({ status: "FAILED_FINAL", failureCode: "AI_PROVIDER_NOT_CONFIGURED" });
  });
});

describe("AI first-use, documents and idempotency", () => {
  it("grants and consumes the first document review, then requires another use", async () => {
    const provider: AiProvider = {
      key: "metadata-review",
      model: "review-v1",
      priority: 1,
      materialMode: "metadata",
      analyze: async () => report("首次文件审查完成")
    };
    const first = await submit(tokenB, {
      kind: "document_review",
      idempotencyKey: "first-document-review-1",
      input: { objective: "检查离职协议中的权利放弃、补偿金额、付款期限和违约责任" },
      uploadIds: [uploadB]
    });
    await processNextAiJob([provider], workerOptions("first-review"));
    const completed = await detail(tokenB, first.body.id);
    expect(completed.body.status).toBe("COMPLETED");
    const free = await query<{ source_type: string; total_uses: number; remaining_uses: number }>(
      `SELECT e.source_type, e.total_uses, e.remaining_uses
         FROM entitlements e
         JOIN products p ON p.id = e.product_id
        WHERE e.user_id = $1 AND p.sku = 'AI_DOCUMENT_REVIEW'`,
      [userB]
    );
    expect(free.rows).toEqual([{ source_type: "first_free", total_uses: 1, remaining_uses: 0 }]);

    const required = await submit(tokenB, {
      kind: "document_review",
      idempotencyKey: "second-document-review-1",
      input: { objective: "第二次文件审查应进入按次权益边界并返回明确提示" },
      uploadIds: [uploadB]
    }, 402);
    expect(required.body).toMatchObject({
      error: "AI_ENTITLEMENT_REQUIRED",
      detail: { sku: "AI_DOCUMENT_REVIEW" }
    });
  });

  it("keeps a material parsing failure as a terminal job and releases the use", async () => {
    const provider: AiProvider = {
      key: "content-review",
      model: "content-v1",
      priority: 1,
      materialMode: "content",
      analyze: async () => report("不应执行")
    };
    const queued = await submit(tokenA, {
      kind: "document_review",
      idempotencyKey: "material-unavailable-async-1",
      input: { objective: "文件存储缺失时任务应失败并退回本次使用次数" },
      uploadIds: [uploadA]
    });
    await expect(processNextAiJob([provider], workerOptions("material"))).resolves.toMatchObject({
      status: "failed",
      failureCode: "AI_MATERIAL_UNAVAILABLE"
    });
    const failed = await detail(tokenA, queued.body.id);
    expect(failed.body).toMatchObject({ status: "FAILED_FINAL", failureCode: "AI_MATERIAL_UNAVAILABLE" });
  });

  it("deduplicates identical submissions, rejects changed payloads and runs one Worker job", async () => {
    let calls = 0;
    const provider: AiProvider = {
      key: "idempotent",
      model: "idempotent-v1",
      priority: 1,
      analyze: async () => {
        calls += 1;
        return report("幂等任务完成");
      }
    };
    const body = {
      kind: "severance_analysis",
      idempotencyKey: "same-async-request-1",
      input: { situation: "公司提出协商解除，工作四年，奖金比例较高，需要核对补偿工资基数。" }
    };
    const first = await submit(tokenA, body);
    const retry = await submit(tokenA, body, 200);
    expect(retry.body.id).toBe(first.body.id);
    expect(calls).toBe(0);
    const conflict = await submit(tokenA, {
      ...body,
      input: { situation: "同一个幂等键改成另一份完全不同的离职事实，服务端必须拒绝复用。" }
    }, 409);
    expect(conflict.body.error).toBe("AI_IDEMPOTENCY_CONFLICT");
    await processNextAiJob([provider], workerOptions("idempotent"));
    expect(calls).toBe(1);
  });

  it("rejects another user's upload and keeps history ownership isolated", async () => {
    const forbidden = await submit(tokenA, {
      kind: "document_review",
      idempotencyKey: "document-unowned-async-1",
      input: { objective: "审查另一位用户的文件，服务端必须拒绝" },
      uploadIds: [uploadB]
    }, 404);
    expect(forbidden.body.error).toBe("AI_UPLOAD_NOT_FOUND");

    const userAList = await request(createAiApp())
      .get("/api/ai/jobs")
      .set("host", "ai.localhost")
      .set("authorization", `Bearer ${tokenA}`)
      .expect(200);
    expect(userAList.body.items.length).toBeGreaterThan(0);
    const hidden = await request(createAiApp())
      .get(`/api/ai/jobs/${userAList.body.items[0].id}`)
      .set("host", "ai.localhost")
      .set("authorization", `Bearer ${tokenB}`)
      .expect(404);
    expect(hidden.body.error).toBe("AI_JOB_NOT_FOUND");
  });
});
