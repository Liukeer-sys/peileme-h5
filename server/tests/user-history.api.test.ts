import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { closePool, query } from "../db.js";
import { runMigrations } from "../migrate.js";
import { signAccessToken, type AuthUser } from "../security.js";

const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });

const users: Record<"owner" | "other", AuthUser> = {
  owner: {
    id: "",
    role: "user",
    email: "history-owner@peileme.test",
    phone: null,
    displayName: "历史记录本人",
    status: "active"
  },
  other: {
    id: "",
    role: "user",
    email: "history-other@peileme.test",
    phone: null,
    displayName: "其他历史用户",
    status: "active"
  }
};

let ownerToken = "";

const cleanup = async () => {
  const ids = [users.owner.id, users.other.id].filter(Boolean);
  if (ids.length) {
    await query("DELETE FROM orders WHERE user_id = ANY($1::uuid[])", [ids]);
    await query("DELETE FROM uploads WHERE user_id = ANY($1::uuid[])", [ids]);
    await query("DELETE FROM assessments WHERE user_id = ANY($1::uuid[])", [ids]);
  }
  await query(
    "DELETE FROM users WHERE email IN ('history-owner@peileme.test', 'history-other@peileme.test')"
  );
};

beforeAll(async () => {
  await runMigrations();
  await cleanup();
  const inserted = await query<{ id: string; email: string }>(
    `INSERT INTO users(email, display_name, email_verified_at)
     VALUES
       ('history-owner@peileme.test', '历史记录本人', now()),
       ('history-other@peileme.test', '其他历史用户', now())
     RETURNING id, email`
  );
  for (const row of inserted.rows) {
    const key = row.email.includes("owner") ? "owner" : "other";
    users[key].id = row.id;
  }
  ownerToken = await signAccessToken(users.owner);

  for (const user of Object.values(users)) {
    await query(
      `INSERT INTO assessments(
         user_id, visitor_id, session_id, status, current_step, answers,
         result, completed_at, product_channel, created_at, updated_at
       ) VALUES
       ($1, $2, $3, 'completed', 'result', '{}'::jsonb,
        '{"payableFen":120000}'::jsonb, now() - interval '4 minutes', 'main',
        now() - interval '4 minutes', now() - interval '4 minutes'),
       ($1, $4, $5, 'completed', 'result', '{}'::jsonb,
        '{"summary":"ai-policy"}'::jsonb, now() - interval '3 minutes', 'ai',
        now() - interval '3 minutes', now() - interval '3 minutes')`,
      [
        user.id,
        `history-main-${user.id}`,
        `history-main-session-${user.id}`,
        `history-ai-${user.id}`,
        `history-ai-session-${user.id}`
      ]
    );
    await query(
      `INSERT INTO uploads(
         user_id, visitor_id, original_name, stored_name, mime_type,
         size_bytes, status, analysis, created_at
       ) VALUES (
         $1, $2, $3, $4, 'application/pdf', 128, 'ready',
         '{"summary":"document-ready"}'::jsonb, now() - interval '2 minutes'
       )`,
      [
        user.id,
        `history-upload-${user.id}`,
        `${user.email}-劳动合同.pdf`,
        `history-${user.id}.pdf`
      ]
    );
    for (const channel of ["main", "ai"] as const) {
      await query(
        `INSERT INTO orders(
           order_no, user_id, product_channel, status, total_fen,
           idempotency_key, expires_at, created_at, updated_at
         ) VALUES (
           $1, $2, $3, 'CREATED', 990, $4,
           now() + interval '1 day',
           now() - interval '1 minute', now() - interval '1 minute'
         )`,
        [
          `HISTORY-${channel.toUpperCase()}-${user.id}`,
          user.id,
          channel,
          `history-${channel}-${user.id}`
        ]
      );
    }
  }
});

afterAll(async () => {
  await cleanup();
  await closePool();
});

describe("current-user unified history", () => {
  it("requires authentication and rejects caller-selected ownership", async () => {
    await request(createApp())
      .get("/api/me/history")
      .set("host", "peileme.art")
      .expect(401);
    await request(createApp())
      .get("/api/account/history")
      .set("host", "peileme.art")
      .expect(401);

    const injected = await request(createApp())
      .get(`/api/me/history?userId=${users.other.id}`)
      .set("host", "peileme.art")
      .set(authHeader(ownerToken))
      .expect(400);
    expect(injected.body.error).toBe("VALIDATION_ERROR");
  });

  it("returns only the signed-in user's main-site policy and commerce timeline", async () => {
    const response = await request(createApp())
      .get("/api/me/history?page=1&pageSize=20")
      .set("host", "peileme.art")
      .set(authHeader(ownerToken))
      .expect(200);

    expect(response.body.channel).toBe("main");
    expect(response.body.pagination).toMatchObject({ page: 1, pageSize: 20, total: 2 });
    expect(response.body.items.map((item: { source: string }) => item.source)).toEqual([
      "commerce",
      "policy"
    ]);
    expect(JSON.stringify(response.body)).not.toContain(users.other.id);
    expect(JSON.stringify(response.body)).not.toContain("劳动合同.pdf");
  });

  it("merges the optional AI source with owned AI-site policy, upload and commerce history", async () => {
    const seenUserIds: string[] = [];
    const app = createApp({
      aiHistorySource: async ({ userId, limit }: { userId: string; limit: number }) => {
        seenUserIds.push(userId);
        return {
          total: 1,
          items: [
            {
              id: `ai-job-${userId}`,
              source: "ai",
              kind: "ai_analysis",
              status: "completed",
              title: "离职赔偿完整分析",
              occurredAt: new Date(),
              updatedAt: new Date(),
              metadata: {
                reportReady: true,
                requestedLimit: limit,
                internalOwnerId: users.other.id
              }
            }
          ]
        };
      }
    });

    const response = await request(app)
      .get("/api/me/history?page=1&pageSize=10")
      .set("host", "ai.peileme.art")
      .set(authHeader(ownerToken))
      .expect(200);

    expect(seenUserIds).toEqual([users.owner.id]);
    expect(response.body.channel).toBe("ai");
    expect(response.body.pagination.total).toBe(4);
    expect(response.body.items.map((item: { kind: string }) => item.kind)).toEqual([
      "ai_analysis",
      "order",
      "document_analysis",
      "policy_assessment"
    ]);
    expect(response.body.items.every((item: { occurredAt?: string }) => item.occurredAt)).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain(users.other.id);
    expect(JSON.stringify(response.body)).not.toContain("requestedLimit");
  });

  it("includes persisted AI jobs without an injected history source", async () => {
    const inserted = await query<{ id: string }>(
      `INSERT INTO ai_jobs(
         user_id, kind, status, progress, idempotency_key, input_hash,
         input_metadata, upload_metadata, completed_at
       ) VALUES (
         $1, 'severance_analysis', 'COMPLETED', 100, 'history-default-ai',
         repeat('a', 64), '{}'::jsonb, '[]'::jsonb, now()
       ) RETURNING id`,
      [users.owner.id]
    );
    try {
      const response = await request(createApp())
        .get("/api/me/history?page=1&pageSize=10")
        .set("host", "ai.peileme.art")
        .set(authHeader(ownerToken))
        .expect(200);

      expect(response.body.pagination.total).toBe(4);
      expect(response.body.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: inserted.rows[0].id,
            source: "ai",
            kind: "ai_analysis",
            title: "赔了么 AI 分析"
          })
        ])
      );
    } finally {
      await query("DELETE FROM ai_jobs WHERE id = $1", [inserted.rows[0].id]);
    }
  });

  it("keeps the deprecated account-history alias owner-scoped and channel-scoped", async () => {
    const main = await request(createApp())
      .get("/api/account/history?pageSize=10")
      .set("host", "peileme.art")
      .set(authHeader(ownerToken))
      .expect(200);
    expect(main.headers.deprecation).toBe("true");
    expect(main.body.items.map((item: { source: string }) => item.source)).toEqual([
      "order",
      "policy_calculation"
    ]);
    expect(main.body.items.every((item: { productChannel: string }) => item.productChannel === "main"))
      .toBe(true);
    expect(main.body.sourceStatus).toEqual({
      policy_calculations: "available",
      orders: "available",
      uploads: "not_applicable",
      ai_tasks: "available"
    });

    const ai = await request(createApp())
      .get("/api/account/history?pageSize=10")
      .set("host", "ai.peileme.art")
      .set(authHeader(ownerToken))
      .expect(200);
    expect(ai.body.items.map((item: { source: string }) => item.source)).toEqual([
      "order",
      "upload"
    ]);
    expect(ai.body.items.every((item: { productChannel: string }) => item.productChannel === "ai"))
      .toBe(true);
    expect(JSON.stringify(ai.body)).not.toContain(users.other.id);
  });

  it("paginates after globally sorting all history sources", async () => {
    const app = createApp({
      aiHistorySource: async ({ userId }: { userId: string }) => ({
        total: 1,
        items: [
          {
            id: `ai-job-${userId}`,
            source: "ai",
            kind: "ai_analysis",
            status: "completed",
            title: "离职赔偿完整分析",
            occurredAt: new Date(),
            updatedAt: new Date()
          }
        ]
      })
    });
    const page = await request(app)
      .get("/api/me/history?page=2&pageSize=2")
      .set("host", "ai.peileme.art")
      .set(authHeader(ownerToken))
      .expect(200);

    expect(page.body.pagination).toEqual({ page: 2, pageSize: 2, total: 4 });
    expect(page.body.items.map((item: { kind: string }) => item.kind)).toEqual([
      "document_analysis",
      "policy_assessment"
    ]);
  });
});
