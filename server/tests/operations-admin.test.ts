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
let operationsToken = "";
let analystToken = "";

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
      operational_job_runs,
      app_errors,
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
  const inserted = await query<{ id: string; email: string; role: string }>(
    `INSERT INTO users(email, display_name, password_hash, role, email_verified_at)
     VALUES
       ('operations-admin@peileme.test', '运营管理员', $1, 'admin', now()),
       ('operations-user@peileme.test', '普通用户', $2, 'user', now()),
       ('operations-staff@peileme.test', '运营人员', $1, 'operations', now()),
       ('operations-analyst@peileme.test', '数据分析员', $1, 'analyst', now())
     RETURNING id, email, role`,
    [adminPassword, userPassword]
  );
  adminId = inserted.rows.find((row) => row.email.startsWith("operations-admin"))!.id;
  userId = inserted.rows.find((row) => row.email.startsWith("operations-user"))!.id;
  await seedPolicyFoundation();
  adminToken = await login("operations-admin@peileme.test", "AdminPass123");
  userToken = await login("operations-user@peileme.test", "UserPass123");
  operationsToken = await login("operations-staff@peileme.test", "AdminPass123");
  analystToken = await login("operations-analyst@peileme.test", "AdminPass123");
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
    const current = await query<{ updated_at: Date }>(
      "SELECT updated_at FROM users WHERE id = $1",
      [adminId]
    );
    const response = await request(createApp())
      .patch(`/api/admin/users/${adminId}`)
      .set("authorization", `Bearer ${adminToken}`)
      .send({ role: "analyst", expectedUpdatedAt: current.rows[0].updated_at.toISOString() })
      .expect(400);

    expect(response.body.error).toBe("CANNOT_DEMOTE_SELF");
    const activeAdmins = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM users WHERE role = 'admin' AND status = 'active'"
    );
    expect(activeAdmins.rows[0].count).toBe("1");
  });

  it("updates a user and writes a structured audit row in the same operation", async () => {
    const current = await request(createApp())
      .get("/api/admin/users?search=operations-user%40peileme.test")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(200);
    const user = current.body.items.find((item: { id: string }) => item.id === userId);
    await query(
      `INSERT INTO refresh_sessions(user_id, token_hash, expires_at)
       VALUES ($1, repeat('a', 64), now() + interval '1 day')`,
      [userId]
    );
    await request(createApp())
      .patch(`/api/admin/users/${userId}`)
      .set("authorization", `Bearer ${adminToken}`)
      .set("x-request-id", "operations-user-disable-1")
      .send({ status: "disabled", expectedUpdatedAt: user.updated_at })
      .expect(200);

    await request(createApp())
      .patch(`/api/admin/users/${userId}`)
      .set("authorization", `Bearer ${adminToken}`)
      .send({ status: "active", expectedUpdatedAt: user.updated_at })
      .expect(409)
      .expect(({ body }) => expect(body.error).toBe("VERSION_CONFLICT"));

    const result = await query<{
      status: string;
      action: string;
      actor_role: string;
      request_id: string;
      revoked_sessions: string;
      active_sessions: string;
      detail: { before: { status: string }; after: { status: string } };
    }>(
      `SELECT u.status, l.action, l.actor_role, l.request_id, l.detail,
              (SELECT count(*)::text
                 FROM refresh_sessions s
                WHERE s.user_id = u.id
                  AND s.revoked_at IS NOT NULL) AS revoked_sessions,
              (SELECT count(*)::text
                 FROM refresh_sessions s
                WHERE s.user_id = u.id
                  AND s.revoked_at IS NULL) AS active_sessions
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
      active_sessions: "0",
      detail: {
        before: { status: "active" },
        after: { status: "disabled" }
      }
    });
    expect(Number(result.rows[0].revoked_sessions)).toBeGreaterThanOrEqual(1);
  });

  it("lets operations query filtered accounts while keeping lifecycle writes admin-only", async () => {
    const accounts = await request(createApp())
      .get("/api/admin/users?role=user&status=disabled&pageSize=20")
      .set("authorization", `Bearer ${operationsToken}`)
      .expect(200);
    expect(accounts.body.items.every((item: { role: string; status: string }) =>
      item.role === "user" && item.status === "disabled"
    )).toBe(true);

    const current = await query<{ updated_at: string }>(
      "SELECT updated_at::text FROM users WHERE id = $1",
      [userId]
    );
    await request(createApp())
      .patch(`/api/admin/users/${userId}`)
      .set("authorization", `Bearer ${operationsToken}`)
      .send({ status: "active", expectedUpdatedAt: current.rows[0].updated_at })
      .expect(403);
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
      .set("authorization", `Bearer ${operationsToken}`)
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

  it("lets operations publish a site-scoped announcement and audits the transition", async () => {
    const created = await request(createApp())
      .post("/api/admin/policy/announcements")
      .set("authorization", `Bearer ${operationsToken}`)
      .send({
        title: "主站维护提醒",
        body: "今晚 23:00 进行短时维护。",
        placement: "main",
        status: "draft"
      })
      .expect(201);
    const published = await request(createApp())
      .patch(`/api/admin/policy/announcements/${created.body.id}`)
      .set("authorization", `Bearer ${operationsToken}`)
      .send({ status: "published", expectedRevision: created.body.revision })
      .expect(200);
    expect(published.body.revision).toBe(2);

    const [main, ai, audit] = await Promise.all([
      request(createApp()).get("/api/public/announcements").set("host", "localhost").expect(200),
      request(createApp()).get("/api/public/announcements").set("host", "ai.localhost").expect(200),
      query<{ count: string }>(
        "SELECT count(*)::text AS count FROM admin_audit_logs WHERE target_id = $1",
        [created.body.id]
      )
    ]);
    expect(main.body.items.map((item: { id: string }) => item.id)).toContain(created.body.id);
    expect(ai.body.items.map((item: { id: string }) => item.id)).not.toContain(created.body.id);
    expect(audit.rows[0].count).toBe("2");
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
  it("rejects invented events and unregistered properties from browser analytics", async () => {
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
      .expect(400);

    await request(createApp())
      .post("/api/events/batch")
      .set(visitorHeaders)
      .send({
        events: [{ name: "page_view", path: "/", properties: { title: "首页" } }]
      })
      .expect(202);

    const stored = await query<{
      source: string;
      schema_version: number;
      properties: Record<string, unknown>;
    }>(
      `SELECT source, schema_version, properties
         FROM analytics_events
        WHERE event_name = 'page_view'
        ORDER BY id DESC
        LIMIT 1`
    );
    expect(stored.rows[0]).toEqual({
      source: "client",
      schema_version: 1,
      properties: { title: "首页" }
    });
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

  it("stores structured internal errors and capability-protects job summaries", async () => {
    await request(createApp()).get("/api/test/force-error").expect(500);
    await query(
      `INSERT INTO operational_job_runs(job_name, status, started_at, finished_at, detail)
       VALUES ('announcement-expiry', 'succeeded', now() - interval '1 second', now(), '{"updated":1}')`
    );

    await request(createApp())
      .get("/api/admin/operations")
      .set("authorization", `Bearer ${analystToken}`)
      .expect(403);
    const summary = await request(createApp())
      .get("/api/admin/operations")
      .set("authorization", `Bearer ${operationsToken}`)
      .expect(200);
    expect(summary.body.errors[0]).toMatchObject({
      method: "GET",
      path: "/api/test/force-error",
      status_code: 500
    });
    expect(summary.body.jobs[0]).toMatchObject({
      job_name: "announcement-expiry",
      status: "succeeded"
    });
  });
});
