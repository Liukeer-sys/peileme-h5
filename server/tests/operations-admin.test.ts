import bcrypt from "bcryptjs";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { closePool, query } from "../db.js";
import { runMigrations } from "../migrate.js";
import { writeServerEvent } from "../modules/analytics/catalog.js";
import { seedPolicyFoundation } from "../modules/policy/seed.js";

const visitorHeaders = {
  "x-visitor-id": "visitor_operations_12345678",
  "x-session-id": "session_operations_12345678"
};

let adminId = "";
let userId = "";
let adminToken = "";
let userToken = "";

const login = async (identifier: string, password: string) =>
  (
    await request(createApp())
      .post("/api/auth/login")
      .send({ identifier, password })
      .expect(200)
  ).body.accessToken as string;

beforeAll(async () => {
  await runMigrations();
  await query(`
    TRUNCATE TABLE
      admin_audit_logs,
      announcements,
      analytics_events,
      visitor_sessions,
      role_capabilities,
      policy_calculation_snapshots,
      regional_parameters,
      administrative_regions,
      policy_rule_versions,
      policy_rule_sets,
      refresh_sessions,
      otp_codes,
      users
    RESTART IDENTITY CASCADE
  `);
  const adminPassword = await bcrypt.hash("AdminPass123", 4);
  const userPassword = await bcrypt.hash("UserPass123", 4);
  const inserted = await query<{ id: string; email: string }>(
    `INSERT INTO users(email, display_name, password_hash, role, email_verified_at)
     VALUES
       ('operations-admin@peileme.test', '运营管理员', $1, 'admin', now()),
       ('operations-user@peileme.test', '普通用户', $2, 'user', now())
     RETURNING id, email`,
    [adminPassword, userPassword]
  );
  adminId = inserted.rows.find((row) => row.email.startsWith("operations-admin"))!.id;
  userId = inserted.rows.find((row) => row.email.startsWith("operations-user"))!.id;
  await seedPolicyFoundation();
  adminToken = await login("operations-admin@peileme.test", "AdminPass123");
  userToken = await login("operations-user@peileme.test", "UserPass123");
});

afterAll(async () => {
  await closePool();
});

describe("operations RBAC and user lifecycle", () => {
  it("keeps ordinary users outside every admin endpoint", async () => {
    await request(createApp())
      .get("/api/admin/users")
      .set("authorization", `Bearer ${userToken}`)
      .expect(403);
    await request(createApp())
      .get("/api/admin/system")
      .set("authorization", `Bearer ${userToken}`)
      .expect(403);
  });

  it("prevents demoting the last active administrator", async () => {
    const response = await request(createApp())
      .patch(`/api/admin/users/${adminId}`)
      .set("authorization", `Bearer ${adminToken}`)
      .send({ role: "analyst" })
      .expect(409);

    expect(response.body.error).toBe("LAST_ACTIVE_ADMIN");
    const activeAdmins = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM users WHERE role = 'admin' AND status = 'active'"
    );
    expect(activeAdmins.rows[0].count).toBe("1");
  });

  it("updates a user and writes a structured audit row in the same operation", async () => {
    await request(createApp())
      .patch(`/api/admin/users/${userId}`)
      .set("authorization", `Bearer ${adminToken}`)
      .set("x-request-id", "operations-user-disable-1")
      .send({ status: "disabled" })
      .expect(200);

    const result = await query<{
      status: string;
      action: string;
      actor_role: string;
      request_id: string;
      detail: { before: { status: string }; after: { status: string } };
    }>(
      `SELECT u.status, l.action, l.actor_role, l.request_id, l.detail
         FROM users u
         JOIN admin_audit_logs l
           ON l.target_id = u.id::text
          AND l.action = 'user.update'
        WHERE u.id = $1
        ORDER BY l.id DESC
        LIMIT 1`,
      [userId]
    );
    expect(result.rows[0]).toMatchObject({
      status: "disabled",
      action: "user.update",
      actor_role: "admin",
      request_id: "operations-user-disable-1",
      detail: {
        before: { status: "active" },
        after: { status: "disabled" }
      }
    });
  });
});

describe("announcement delivery and optimistic edits", () => {
  it("serves only active published announcements for the current product host", async () => {
    await query(
      `INSERT INTO announcements(title, body, placement, status, starts_at, ends_at)
       VALUES
         ('主站公告', 'main', 'main', 'published', now() - interval '1 hour', now() + interval '1 hour'),
         ('AI 公告', 'ai', 'ai', 'published', now() - interval '1 hour', now() + interval '1 hour'),
         ('全站公告', 'all', 'all', 'published', now() - interval '1 hour', now() + interval '1 hour'),
         ('未来公告', 'future', 'all', 'published', now() + interval '1 hour', now() + interval '2 hours'),
         ('草稿公告', 'draft', 'all', 'draft', NULL, NULL)`
    );

    const main = await request(createApp())
      .get("/api/public/announcements")
      .set("host", "localhost")
      .expect(200);
    const ai = await request(createApp())
      .get("/api/public/announcements")
      .set("host", "ai.localhost")
      .expect(200);

    expect(main.body.items.map((item: { title: string }) => item.title).sort()).toEqual([
      "主站公告",
      "全站公告"
    ]);
    expect(ai.body.items.map((item: { title: string }) => item.title).sort()).toEqual([
      "AI 公告",
      "全站公告"
    ]);
  });

  it("rejects a stale announcement revision and preserves the winning edit", async () => {
    const created = await request(createApp())
      .post("/api/admin/policy/announcements")
      .set("authorization", `Bearer ${adminToken}`)
      .send({
        title: "并发公告",
        body: "初稿",
        placement: "all",
        status: "draft"
      })
      .expect(201);
    expect(created.body.revision).toBe(1);

    const winning = await request(createApp())
      .patch(`/api/admin/policy/announcements/${created.body.id}`)
      .set("authorization", `Bearer ${adminToken}`)
      .send({ title: "已保存版本", expectedRevision: 1 })
      .expect(200);
    expect(winning.body.revision).toBe(2);

    const stale = await request(createApp())
      .patch(`/api/admin/policy/announcements/${created.body.id}`)
      .set("authorization", `Bearer ${adminToken}`)
      .send({ title: "过期编辑", expectedRevision: 1 })
      .expect(409);
    expect(stale.body.error).toBe("VERSION_CONFLICT");

    const stored = await query<{ title: string; revision: number }>(
      "SELECT title, revision FROM announcements WHERE id = $1",
      [created.body.id]
    );
    expect(stored.rows[0]).toEqual({ title: "已保存版本", revision: 2 });
  });
});

describe("regional parameter version conflicts", () => {
  it("rejects a stale regional-parameter revision", async () => {
    await query(
      `INSERT INTO administrative_regions(
         code, name, level, status, source_name, source_url, source_snapshot_date
       )
       VALUES (
         '990000', '运营测试省', 'province', 'active', '测试来源',
         'https://www.gov.cn/test', '2026-01-01'
       )`
    );
    const base = {
      regionCode: "990000",
      year: 2026,
      parameterType: "minimum_monthly_wage",
      amountFen: 250_000,
      sourceName: "运营测试来源",
      sourceUrl: "https://www.gov.cn/test",
      sourcePublishedAt: "2026-01-01",
      status: "draft"
    };
    const created = await request(createApp())
      .put("/api/admin/policy/regional-parameters")
      .set("authorization", `Bearer ${adminToken}`)
      .send(base)
      .expect(200);
    expect(created.body.revision).toBe(1);

    const winning = await request(createApp())
      .put("/api/admin/policy/regional-parameters")
      .set("authorization", `Bearer ${adminToken}`)
      .send({ ...base, amountFen: 260_000, expectedRevision: 1 })
      .expect(200);
    expect(winning.body.revision).toBe(2);

    const stale = await request(createApp())
      .put("/api/admin/policy/regional-parameters")
      .set("authorization", `Bearer ${adminToken}`)
      .send({ ...base, amountFen: 270_000, expectedRevision: 1 })
      .expect(409);
    expect(stale.body.error).toBe("VERSION_CONFLICT");
  });
});

describe("trusted analytics boundary", () => {
  it("rejects invented client events and strips properties outside the event schema", async () => {
    await request(createApp())
      .post("/api/events/batch")
      .set(visitorHeaders)
      .send({ events: [{ name: "invented_revenue", properties: { amountFen: 999_999 } }] })
      .expect(400);

    await request(createApp())
      .post("/api/events/batch")
      .set(visitorHeaders)
      .send({
        events: [
          {
            name: "page_view",
            path: "/",
            properties: { title: "首页", amountFen: 999_999, credential: "secret" }
          }
        ]
      })
      .expect(202);

    const stored = await query<{ source: string; properties: Record<string, unknown> }>(
      `SELECT source, properties
         FROM analytics_events
        WHERE event_name = 'page_view'
        ORDER BY id DESC
        LIMIT 1`
    );
    expect(stored.rows[0]).toEqual({ source: "client", properties: { title: "首页" } });
  });

  it("writes backend facts through a server-only event API", async () => {
    await writeServerEvent({
      name: "user_registered",
      userId,
      productChannel: "main",
      properties: { channel: "email" }
    });

    const stored = await query<{ source: string; visitor_id: string; properties: unknown }>(
      `SELECT source, visitor_id, properties
         FROM analytics_events
        WHERE event_name = 'user_registered'
        ORDER BY id DESC
        LIMIT 1`
    );
    expect(stored.rows[0]).toMatchObject({
      source: "server",
      visitor_id: "server",
      properties: { channel: "email", productChannel: "main" }
    });
  });
});

describe("operational readiness", () => {
  it("exposes dependency readiness and bounded task/error summaries", async () => {
    const ready = await request(createApp()).get("/api/ready").expect(200);
    expect(ready.body).toMatchObject({
      status: "ready",
      dependencies: { database: "ready" }
    });

    const system = await request(createApp())
      .get("/api/admin/system")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(system.body.operational).toMatchObject({
      errors: { last24Hours: expect.any(Number), recent: expect.any(Array) },
      tasks: {
        reconciliationDue: expect.any(Number),
        failedNotifications: expect.any(Number),
        failedUploads: expect.any(Number),
        failedOtpDeliveries: expect.any(Number)
      }
    });
  });
});
