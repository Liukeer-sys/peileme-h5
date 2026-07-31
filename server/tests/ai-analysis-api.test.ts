import crypto from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { closePool, query } from "../db.js";
import { runMigrations } from "../migrate.js";
import { signAccessToken, type AuthUser } from "../security.js";

type ControlledProvider = {
  key: string;
  model: string;
  priority: number;
  enabled?: boolean;
  analyze: (input: unknown) => Promise<unknown>;
};

const report = (summary: string) => ({
  schemaVersion: "1.0",
  summary,
  riskLevel: "medium",
  findings: [
    {
      title: "补偿基数需要核对",
      severity: "medium",
      explanation: "建议核对解除前十二个月应发工资。"
    }
  ],
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

const createAiApp = (providers: ControlledProvider[]) =>
  createApp({ aiProviders: providers } as never);

let userA = "";
let userB = "";
let tokenA = "";
let tokenB = "";
let uploadA = "";
let uploadB = "";

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

beforeAll(async () => {
  await runMigrations();
  await query(`
    TRUNCATE TABLE
      entitlement_usages,
      entitlements,
      uploads,
      assessments,
      users
    RESTART IDENTITY CASCADE
  `);
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

  await query(
    `INSERT INTO products(
       sku, name, description, product_channel, fulfillment_type, status,
       entitlement_policy
     ) VALUES
       ('AI_SEVERANCE_ANALYSIS', 'AI 离职分析', '测试商品', 'ai', 'ai_analysis', 'active', '{}'),
       ('AI_DOCUMENT_REVIEW', 'AI 文件审查', '测试商品', 'ai', 'document_review', 'active', '{}')
     ON CONFLICT (sku) DO UPDATE SET status = 'active'`
  );
  await grant(userA, "AI_SEVERANCE_ANALYSIS");
  await grant(userA, "AI_DOCUMENT_REVIEW");
  await grant(userB, "AI_SEVERANCE_ANALYSIS");

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

describe("AI analysis API product and identity boundary", () => {
  it("requires login, hides the API on the main host, and validates input", async () => {
    const app = createAiApp([]);
    const validBody = {
      kind: "severance_analysis",
      idempotencyKey: "boundary-valid-1",
      input: { situation: "公司提出协商解除，工作三年，月工资一万元，需要分析补偿和证据。" }
    };

    await request(app)
      .post("/api/ai/jobs")
      .set("host", "ai.localhost")
      .send(validBody)
      .expect(401);
    await request(app)
      .post("/api/ai/jobs")
      .set("host", "localhost")
      .set("authorization", `Bearer ${tokenA}`)
      .send(validBody)
      .expect(404);
    const invalid = await request(app)
      .post("/api/ai/jobs")
      .set("host", "ai.localhost")
      .set("authorization", `Bearer ${tokenA}`)
      .send({
        kind: "severance_analysis",
        idempotencyKey: "boundary-invalid-1",
        input: { situation: "太短" }
      })
      .expect(400);
    expect(invalid.body.error).toBe("VALIDATION_ERROR");
  });
});

describe("AI analysis provider fallback and persistence", () => {
  it("falls back by priority, persists attempts and completes with a structured report", async () => {
    const calls: string[] = [];
    const app = createAiApp([
      {
        key: "primary",
        model: "primary-model",
        priority: 10,
        analyze: async () => {
          calls.push("primary");
          throw new Error("upstream body must never be persisted");
        }
      },
      {
        key: "fallback",
        model: "fallback-model",
        priority: 20,
        analyze: async () => {
          calls.push("fallback");
          return report("已完成离职补偿分析");
        }
      }
    ]);
    const response = await request(app)
      .post("/api/ai/jobs")
      .set("host", "ai.localhost")
      .set("authorization", `Bearer ${tokenA}`)
      .send({
        kind: "severance_analysis",
        idempotencyKey: "fallback-success-1",
        input: { situation: "公司通知本月底解除劳动合同，工作五年，月工资一万二，需要核算补偿。" }
      })
      .expect(201);

    expect(calls).toEqual(["primary", "fallback"]);
    expect(response.body).toMatchObject({
      status: "COMPLETED",
      selectedProvider: "fallback",
      report: { summary: "已完成离职补偿分析" }
    });

    const attempts = await query<{
      provider_key: string;
      outcome: string;
      error_code: string | null;
    }>(
      `SELECT provider_key, outcome, error_code
         FROM ai_provider_attempts
        WHERE job_id = $1
        ORDER BY ordinal`,
      [response.body.id]
    );
    expect(attempts.rows).toEqual([
      { provider_key: "primary", outcome: "failed", error_code: "PROVIDER_ERROR" },
      { provider_key: "fallback", outcome: "succeeded", error_code: null }
    ]);
    expect(JSON.stringify(attempts.rows)).not.toContain("upstream body");

    const states = await query<{ to_status: string }>(
      "SELECT to_status FROM ai_job_events WHERE job_id = $1 ORDER BY id",
      [response.body.id]
    );
    expect(states.rows.map((row) => row.to_status)).toEqual([
      "QUEUED",
      "RUNNING",
      "COMPLETED"
    ]);
    const usage = await query<{ status: string }>(
      "SELECT status FROM entitlement_usages WHERE business_id = $1",
      [response.body.id]
    );
    expect(usage.rows[0].status).toBe("consumed");
  });

  it("persists a final failure, releases the reservation, and fails closed with no providers", async () => {
    const failing = createAiApp([
      {
        key: "only-provider",
        model: "broken-model",
        priority: 1,
        analyze: async () => {
          throw new Error("secret upstream failure detail");
        }
      }
    ]);
    const failed = await request(failing)
      .post("/api/ai/jobs")
      .set("host", "ai.localhost")
      .set("authorization", `Bearer ${tokenA}`)
      .send({
        kind: "severance_analysis",
        idempotencyKey: "all-failed-1",
        input: { situation: "公司要求立即离职，没有出具书面通知，工作两年，需要判断风险和补偿。" }
      })
      .expect(201);
    expect(failed.body).toMatchObject({
      status: "FAILED_FINAL",
      failureCode: "AI_PROVIDER_CHAIN_EXHAUSTED"
    });
    expect(JSON.stringify(failed.body)).not.toContain("secret upstream");
    const released = await query<{ status: string }>(
      "SELECT status FROM entitlement_usages WHERE business_id = $1",
      [failed.body.id]
    );
    expect(released.rows[0].status).toBe("released");

    const disabled = await request(createAiApp([]))
      .post("/api/ai/jobs")
      .set("host", "ai.localhost")
      .set("authorization", `Bearer ${tokenA}`)
      .send({
        kind: "severance_analysis",
        idempotencyKey: "no-provider-1",
        input: { situation: "劳动合同即将到期，公司表示不再续签，需要分析补偿标准与准备材料。" }
      })
      .expect(201);
    expect(disabled.body).toMatchObject({
      status: "FAILED_FINAL",
      failureCode: "AI_PROVIDER_NOT_CONFIGURED"
    });
  });
});

describe("AI analysis idempotency, document metadata and owned history", () => {
  it("returns the same task for an identical retry and rejects a changed payload", async () => {
    let calls = 0;
    const app = createAiApp([
      {
        key: "controlled",
        model: "controlled-v1",
        priority: 1,
        analyze: async () => {
          calls += 1;
          return report("幂等分析完成");
        }
      }
    ]);
    const body = {
      kind: "severance_analysis",
      idempotencyKey: "same-request-1",
      input: { situation: "公司提出协商解除，工作四年，奖金比例较高，需要核对补偿工资基数。" }
    };
    const first = await request(app)
      .post("/api/ai/jobs")
      .set("host", "ai.localhost")
      .set("authorization", `Bearer ${tokenA}`)
      .send(body)
      .expect(201);
    const retry = await request(app)
      .post("/api/ai/jobs")
      .set("host", "ai.localhost")
      .set("authorization", `Bearer ${tokenA}`)
      .send(body)
      .expect(200);
    expect(retry.body.id).toBe(first.body.id);
    expect(calls).toBe(1);

    const conflict = await request(app)
      .post("/api/ai/jobs")
      .set("host", "ai.localhost")
      .set("authorization", `Bearer ${tokenA}`)
      .send({
        ...body,
        input: { situation: "同一个幂等键改成了另一份完全不同的离职事实，需要拒绝复用。" }
      })
      .expect(409);
    expect(conflict.body.error).toBe("AI_IDEMPOTENCY_CONFLICT");
  });

  it("accepts owned upload metadata for document review and rejects another user's upload", async () => {
    const app = createAiApp([
      {
        key: "document-provider",
        model: "document-v1",
        priority: 1,
        analyze: async () => report("文件签署风险审查完成")
      }
    ]);
    const accepted = await request(app)
      .post("/api/ai/jobs")
      .set("host", "ai.localhost")
      .set("authorization", `Bearer ${tokenA}`)
      .send({
        kind: "document_review",
        idempotencyKey: "document-owned-1",
        input: { objective: "签署前检查离职协议中的放弃权利和违约条款" },
        uploadIds: [uploadA]
      })
      .expect(201);
    expect(accepted.body).toMatchObject({
      kind: "document_review",
      status: "COMPLETED",
      report: { summary: "文件签署风险审查完成" }
    });

    const forbidden = await request(app)
      .post("/api/ai/jobs")
      .set("host", "ai.localhost")
      .set("authorization", `Bearer ${tokenA}`)
      .send({
        kind: "document_review",
        idempotencyKey: "document-unowned-1",
        input: { objective: "审查另一位用户的文件，服务端必须拒绝" },
        uploadIds: [uploadB]
      })
      .expect(404);
    expect(forbidden.body.error).toBe("AI_UPLOAD_NOT_FOUND");
  });

  it("lists and returns only the current user's task history", async () => {
    const userAList = await request(createAiApp([]))
      .get("/api/ai/jobs")
      .set("host", "ai.localhost")
      .set("authorization", `Bearer ${tokenA}`)
      .expect(200);
    expect(userAList.body.items.length).toBeGreaterThan(0);
    expect(userAList.body.items.every((item: { userId?: string }) => item.userId === undefined)).toBe(true);

    const ownedId = userAList.body.items[0].id;
    await request(createAiApp([]))
      .get(`/api/ai/jobs/${ownedId}`)
      .set("host", "ai.localhost")
      .set("authorization", `Bearer ${tokenA}`)
      .expect(200);
    const hidden = await request(createAiApp([]))
      .get(`/api/ai/jobs/${ownedId}`)
      .set("host", "ai.localhost")
      .set("authorization", `Bearer ${tokenB}`)
      .expect(404);
    expect(hidden.body.error).toBe("AI_JOB_NOT_FOUND");
  });
});
