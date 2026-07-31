import bcrypt from "bcryptjs";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { closePool, query } from "../db.js";
import { runMigrations } from "../migrate.js";
import { seedPolicyFoundation } from "../modules/policy/seed.js";

const tokens: Record<string, string> = {};
let regularUserId = "";
let announcementId = "";
let announcementVersion = 0;

const login = async (email: string) => {
  const response = await request(createApp())
    .post("/api/auth/login")
    .send({ identifier: email, password: "AdminPass123" })
    .expect(200);
  return response.body.accessToken as string;
};

const authorized = (role: string) => ({
  authorization: `Bearer ${tokens[role]}`
});

beforeAll(async () => {
  await runMigrations();
  await query(`
    TRUNCATE TABLE
      operational_job_runs,
      operational_errors,
      admin_audit_logs,
      uploads,
      policy_calculation_snapshots,
      regional_parameters,
      administrative_regions,
      policy_rule_versions,
      policy_rule_sets,
      role_capabilities,
      announcements,
      assessments,
      analytics_events,
      visitor_sessions,
      access_grants,
      invite_redemptions,
      invite_codes,
      refresh_sessions,
      otp_codes,
      users
    RESTART IDENTITY CASCADE
  `);
  const passwordHash = await bcrypt.hash("AdminPass123", 4);
  const users = await query<{ id: string; role: string; email: string }>(
    `INSERT INTO users(email, display_name, password_hash, role, email_verified_at)
     VALUES
       ('admin@peileme.test', '超级管理员', $1, 'admin', now()),
       ('operations@peileme.test', '运营人员', $1, 'operations', now()),
       ('analyst@peileme.test', '数据分析员', $1, 'analyst', now()),
       ('user@peileme.test', '普通用户', $1, 'user', now())
     RETURNING id, role, email`,
    [passwordHash]
  );
  regularUserId = users.rows.find((row) => row.role === "user")!.id;
  await seedPolicyFoundation();
  for (const row of users.rows.filter((user) => user.role !== "user")) {
    tokens[row.role] = await login(row.email);
  }
});

afterAll(async () => {
  await closePool();
});

describe("trusted analytics boundary", () => {
  it("rejects server-only event names and unknown properties from browsers", async () => {
    await request(createApp())
      .post("/api/events/batch")
      .set("x-visitor-id", "visitor_admin_ops_123")
      .set("x-session-id", "session_admin_ops_123")
      .send({
        events: [
          {
            name: "payment_succeeded",
            properties: { amountFen: 999_999 }
          }
        ]
      })
      .expect(400);

    await request(createApp())
      .post("/api/events/batch")
      .set("x-visitor-id", "visitor_admin_ops_123")
      .set("x-session-id", "session_admin_ops_123")
      .send({
        events: [{ name: "page_view", properties: { amountFen: 999_999 } }]
      })
      .expect(400);
  });

  it("stores allowlisted browser events explicitly as client facts", async () => {
    await request(createApp())
      .post("/api/events/batch")
      .set("x-visitor-id", "visitor_admin_ops_123")
      .set("x-session-id", "session_admin_ops_123")
      .send({
        events: [
          {
            name: "page_view",
            path: "/",
            properties: { title: "赔了么" }
          }
        ]
      })
      .expect(202);
    const stored = await query<{ source: string; schema_version: number }>(
      `SELECT source, schema_version
         FROM analytics_events
        WHERE event_name = 'page_view'
        ORDER BY id DESC
        LIMIT 1`
    );
    expect(stored.rows[0]).toEqual({ source: "client", schema_version: 1 });
  });
});

describe("capability RBAC and account safety", () => {
  it("lets operations query accounts while keeping writes admin-only", async () => {
    await request(createApp())
      .get("/api/admin/users?role=user&status=active&pageSize=20")
      .set(authorized("operations"))
      .expect(200)
      .expect(({ body }) => {
        expect(body.items.every((item: { role: string }) => item.role === "user")).toBe(true);
      });

    await request(createApp())
      .patch(`/api/admin/users/${regularUserId}`)
      .set(authorized("operations"))
      .send({ status: "disabled" })
      .expect(403);
  });

  it("uses optimistic versions, revokes sessions on disable, and audits atomically", async () => {
    const current = await request(createApp())
      .get("/api/admin/users?search=user%40peileme.test")
      .set(authorized("admin"))
      .expect(200);
    const user = current.body.items.find((item: { id: string }) => item.id === regularUserId);
    await query(
      `INSERT INTO refresh_sessions(user_id, token_hash, expires_at)
       VALUES ($1, repeat('a', 64), now() + interval '1 day')`,
      [regularUserId]
    );

    const disabled = await request(createApp())
      .patch(`/api/admin/users/${regularUserId}`)
      .set(authorized("admin"))
      .send({ status: "disabled", expectedUpdatedAt: user.updated_at })
      .expect(200);
    expect(disabled.body.status).toBe("disabled");

    await request(createApp())
      .patch(`/api/admin/users/${regularUserId}`)
      .set(authorized("admin"))
      .send({ status: "active", expectedUpdatedAt: user.updated_at })
      .expect(409)
      .expect(({ body }) => expect(body.error).toBe("VERSION_CONFLICT"));

    const facts = await query<{ revoked: string; audits: string }>(
      `SELECT
         (SELECT count(*)::text FROM refresh_sessions WHERE user_id = $1 AND revoked_at IS NOT NULL) AS revoked,
         (SELECT count(*)::text FROM admin_audit_logs WHERE action = 'user.update' AND target_id = $1::text) AS audits`,
      [regularUserId]
    );
    expect(facts.rows[0]).toEqual({ revoked: "1", audits: "1" });
  });

  it("protects the current and final active super administrator", async () => {
    const current = await query<{ updated_at: string }>(
      "SELECT updated_at::text FROM users WHERE email = 'admin@peileme.test'"
    );
    const expectedUpdatedAt = current.rows[0].updated_at;
    await request(createApp())
      .patch("/api/admin/users/" + (
        await query<{ id: string }>("SELECT id FROM users WHERE email = 'admin@peileme.test'")
      ).rows[0].id)
      .set(authorized("admin"))
      .send({ role: "analyst", expectedUpdatedAt })
      .expect(400)
      .expect(({ body }) => expect(body.error).toBe("CANNOT_DEMOTE_SELF"));
  });
});

describe("announcement lifecycle and site scope", () => {
  it("lets operations create and publish a scoped announcement with audit versions", async () => {
    const created = await request(createApp())
      .post("/api/admin/policy/announcements")
      .set(authorized("operations"))
      .send({
        title: "主站维护提醒",
        body: "今晚 23:00 进行短时维护。",
        placement: "main",
        status: "draft"
      })
      .expect(201);
    announcementId = created.body.id;
    announcementVersion = created.body.version;
    expect(announcementVersion).toBe(1);

    const published = await request(createApp())
      .patch(`/api/admin/policy/announcements/${announcementId}`)
      .set(authorized("operations"))
      .send({ status: "published", expectedVersion: announcementVersion })
      .expect(200);
    announcementVersion = published.body.version;
    expect(announcementVersion).toBe(2);

    const audit = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM admin_audit_logs WHERE target_id = $1",
      [announcementId]
    );
    expect(audit.rows[0].count).toBe("2");
  });

  it("rejects stale announcement writes and serves only active host-scoped content", async () => {
    await request(createApp())
      .patch(`/api/admin/policy/announcements/${announcementId}`)
      .set(authorized("operations"))
      .send({ status: "archived", expectedVersion: 1 })
      .expect(409)
      .expect(({ body }) => expect(body.error).toBe("VERSION_CONFLICT"));

    const [main, ai] = await Promise.all([
      request(createApp()).get("/api/public/announcements").set("host", "localhost").expect(200),
      request(createApp()).get("/api/public/announcements").set("host", "ai.localhost").expect(200)
    ]);
    expect(main.body.items.map((item: { id: string }) => item.id)).toContain(announcementId);
    expect(ai.body.items.map((item: { id: string }) => item.id)).not.toContain(announcementId);
  });
});

describe("regional parameter versions and operations visibility", () => {
  it("increments regional parameter versions and rejects lost updates", async () => {
    const first = await request(createApp())
      .put("/api/admin/policy/regional-parameters")
      .set(authorized("admin"))
      .send({
        regionCode: "110000",
        year: 2024,
        parameterType: "minimum_monthly_wage",
        amountFen: 242_000,
        sourceName: "北京市人力资源和社会保障局",
        sourceUrl: "https://rsj.beijing.gov.cn/xxgk/zcwj/202312/t20231229_3518002.html",
        sourcePublishedAt: "2023-12-29",
        status: "verified"
      })
      .expect(200);
    expect(first.body.version).toBe(1);

    const second = await request(createApp())
      .put("/api/admin/policy/regional-parameters")
      .set(authorized("admin"))
      .send({
        regionCode: "110000",
        year: 2024,
        parameterType: "minimum_monthly_wage",
        amountFen: 250_000,
        sourceName: "北京市人力资源和社会保障局",
        sourceUrl: "https://rsj.beijing.gov.cn/xxgk/zcwj/202312/t20231229_3518002.html",
        sourcePublishedAt: "2023-12-29",
        status: "verified",
        expectedVersion: 1
      })
      .expect(200);
    expect(second.body.version).toBe(2);

    await request(createApp())
      .put("/api/admin/policy/regional-parameters")
      .set(authorized("admin"))
      .send({
        regionCode: "110000",
        year: 2024,
        parameterType: "minimum_monthly_wage",
        amountFen: 260_000,
        sourceName: "北京市人力资源和社会保障局",
        sourceUrl: "https://rsj.beijing.gov.cn/xxgk/zcwj/202312/t20231229_3518002.html",
        sourcePublishedAt: "2023-12-29",
        status: "verified",
        expectedVersion: 1
      })
      .expect(409)
      .expect(({ body }) => expect(body.error).toBe("VERSION_CONFLICT"));
  });

  it("exposes readiness plus capability-protected structured error and job summaries", async () => {
    await request(createApp()).get("/api/ready").expect(200).expect(({ body }) => {
      expect(body.status).toBe("ready");
      expect(body.database).toBe(true);
    });

    await request(createApp()).get("/api/test/force-error").expect(500);
    await query(
      `INSERT INTO operational_job_runs(job_name, status, started_at, finished_at, detail)
       VALUES ('announcement-expiry', 'succeeded', now() - interval '1 second', now(), '{"updated":1}')`
    );

    await request(createApp())
      .get("/api/admin/operations")
      .set(authorized("analyst"))
      .expect(403);
    const summary = await request(createApp())
      .get("/api/admin/operations")
      .set(authorized("operations"))
      .expect(200);
    expect(summary.body.errors[0]).toMatchObject({ method: "GET", path: "/api/test/force-error" });
    expect(summary.body.jobs[0]).toMatchObject({ job_name: "announcement-expiry", status: "succeeded" });
  });
});
