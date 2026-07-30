import bcrypt from "bcryptjs";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { closePool, query } from "../db.js";
import { runMigrations } from "../migrate.js";

let adminToken = "";
let userToken = "";
let analystToken = "";
let inviteCode = "";
let anonymousAssessmentId = "";

const visitorHeaders = {
  "x-visitor-id": "visitor_test_12345678",
  "x-session-id": "session_test_12345678"
};

beforeAll(async () => {
  await runMigrations();
  await query(`
    TRUNCATE TABLE
      admin_audit_logs,
      uploads,
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
  await query(
    `INSERT INTO users
       (email, display_name, password_hash, role, email_verified_at)
     VALUES ('admin@peileme.test', '测试管理员', $1, 'admin', now())`,
    [passwordHash]
  );
});

afterAll(async () => {
  await closePool();
});

describe("health and authentication", () => {
  it("reports database and OTP channel status", async () => {
    const response = await request(createApp()).get("/api/health").expect(200);
    expect(response.body.status).toBe("healthy");
    expect(response.body.database).toBe(true);
    expect(response.body.channels.debug).toBe(true);
  });

  it("registers an email account with a one-time code", async () => {
    const app = createApp();
    const codeResponse = await request(app)
      .post("/api/auth/send-code")
      .send({ target: "user@peileme.test", purpose: "register" })
      .expect(201);
    expect(codeResponse.body.debugCode).toMatch(/^\d{6}$/);

    const registerResponse = await request(app)
      .post("/api/auth/register")
      .send({
        target: "user@peileme.test",
        code: codeResponse.body.debugCode,
        password: "UserPass123",
        displayName: "测试用户"
      })
      .expect(201);
    expect(registerResponse.body.user.email).toBe("user@peileme.test");
    expect(registerResponse.body.accessToken).toBeTruthy();
    userToken = registerResponse.body.accessToken;

    const meResponse = await request(app)
      .get("/api/auth/me")
      .set("authorization", `Bearer ${userToken}`)
      .expect(200);
    expect(meResponse.body.user.displayName).toBe("测试用户");
  });

  it("logs in the administrator with a password", async () => {
    const response = await request(createApp())
      .post("/api/auth/login")
      .send({ identifier: "admin@peileme.test", password: "AdminPass123" })
      .expect(200);
    expect(response.body.user.role).toBe("admin");
    adminToken = response.body.accessToken;
  });

  it("resets a password with a one-time code and revokes old sessions", async () => {
    const app = createApp();
    const codeResponse = await request(app)
      .post("/api/auth/send-code")
      .send({ target: "user@peileme.test", purpose: "reset_password" })
      .expect(201);
    await request(app)
      .post("/api/auth/reset-password")
      .send({
        target: "user@peileme.test",
        code: codeResponse.body.debugCode,
        password: "NewUserPass123"
      })
      .expect(200);
    const loginResponse = await request(app)
      .post("/api/auth/login")
      .send({ identifier: "user@peileme.test", password: "NewUserPass123" })
      .expect(200);
    userToken = loginResponse.body.accessToken;
  });
});

describe("invites and access grants", () => {
  it("creates and redeems a scoped invite", async () => {
    const app = createApp();
    const created = await request(app)
      .post("/api/admin/invites")
      .set("authorization", `Bearer ${adminToken}`)
      .send({
        maxUses: 2,
        description: "API 测试邀请码",
        grants: ["caseLawPack", "evidencePack"]
      })
      .expect(201);
    inviteCode = created.body.code;
    expect(inviteCode).toMatch(/^PLM-/);

    const redeemed = await request(app)
      .post("/api/invites/redeem")
      .set("authorization", `Bearer ${userToken}`)
      .send({ code: inviteCode })
      .expect(200);
    expect(redeemed.body.grants).toEqual(["caseLawPack", "evidencePack"]);

    const access = await request(app)
      .get("/api/access/me")
      .set("authorization", `Bearer ${userToken}`)
      .expect(200);
    expect(access.body.grants.map((item: { module: string }) => item.module)).toEqual([
      "caseLawPack",
      "evidencePack"
    ]);
  });

  it("keeps analyst accounts read-only", async () => {
    await query(
      `INSERT INTO users(email, display_name, role, email_verified_at)
       VALUES ('analyst@peileme.test', '测试分析员', 'analyst', now())`
    );
    const otp = await request(createApp())
      .post("/api/auth/send-code")
      .send({ target: "analyst@peileme.test", purpose: "login" })
      .expect(201);
    const loggedIn = await request(createApp())
      .post("/api/auth/login")
      .send({ identifier: "analyst@peileme.test", code: otp.body.debugCode })
      .expect(200);
    analystToken = loggedIn.body.accessToken;
    await request(createApp())
      .get("/api/admin/overview")
      .set("authorization", `Bearer ${analystToken}`)
      .expect(200);
    await request(createApp())
      .post("/api/admin/invites")
      .set("authorization", `Bearer ${analystToken}`)
      .send({ maxUses: 1 })
      .expect(403);
  });
});

describe("assessments, events and uploads", () => {
  it("persists and completes an anonymous assessment", async () => {
    const app = createApp();
    const created = await request(app)
      .post("/api/assessments")
      .set(visitorHeaders)
      .send({
        status: "in_progress",
        currentStep: "city",
        answers: { city: "上海" }
      })
      .expect(201);
    anonymousAssessmentId = created.body.id;
    expect(anonymousAssessmentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );

    await request(app)
      .patch(`/api/assessments/${anonymousAssessmentId}`)
      .set(visitorHeaders)
      .send({
        status: "completed",
        currentStep: "result",
        answers: { city: "上海", avgMonthlySalary: 12000 },
        result: { lowAmount: 12000, highAmount: 24000 }
      })
      .expect(200);

    const row = await query<{ status: string; completed_at: Date | null }>(
      "SELECT status, completed_at FROM assessments WHERE id = $1",
      [anonymousAssessmentId]
    );
    expect(row.rows[0].status).toBe("completed");
    expect(row.rows[0].completed_at).toBeTruthy();
  });

  it("stores a batch of analytics events and exposes admin aggregates", async () => {
    const app = createApp();
    const events = await request(app)
      .post("/api/events/batch")
      .set(visitorHeaders)
      .send({
        events: [
          { name: "page_view", path: "/" },
          { name: "assessment_started", path: "/", properties: { source: "test" } },
          { name: "assessment_completed", path: "/result" }
        ]
      })
      .expect(202);
    expect(events.body.accepted).toBe(3);

    const overview = await request(app)
      .get("/api/admin/overview?days=30")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(Number(overview.body.summary.visitors)).toBeGreaterThanOrEqual(1);
    expect(Number(overview.body.summary.completed_assessments)).toBeGreaterThanOrEqual(1);
  });

  it("stores a private document upload", async () => {
    await request(createApp())
      .post("/api/assessments/claim")
      .set("authorization", `Bearer ${userToken}`)
      .set(visitorHeaders)
      .expect(200);
    const response = await request(createApp())
      .post("/api/uploads")
      .set("authorization", `Bearer ${userToken}`)
      .set(visitorHeaders)
      .field("assessmentId", anonymousAssessmentId)
      .attach("files", Buffer.from("%PDF-1.4 test document"), {
        filename: "解除协议.pdf",
        contentType: "application/pdf"
      })
      .expect(201);
    expect(response.body.files[0].original_name).toBe("解除协议.pdf");
    expect(response.body.files[0].status).toBe("stored");
  });

  it("rejects spoofed file content and foreign assessment attachments", async () => {
    const before = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM uploads"
    );
    await request(createApp())
      .post("/api/uploads")
      .set("authorization", `Bearer ${userToken}`)
      .set(visitorHeaders)
      .attach("files", Buffer.from("plain text disguised as PDF"), {
        filename: "伪装文件.pdf",
        contentType: "application/pdf"
      })
      .expect(400);

    const foreign = await request(createApp())
      .post("/api/assessments")
      .set({
        "x-visitor-id": "visitor_foreign_12345678",
        "x-session-id": "session_foreign_12345678"
      })
      .send({ status: "in_progress", currentStep: "city", answers: { city: "北京" } })
      .expect(201);
    await request(createApp())
      .post("/api/uploads")
      .set("authorization", `Bearer ${userToken}`)
      .set(visitorHeaders)
      .field("assessmentId", foreign.body.id)
      .attach("files", Buffer.from("%PDF-1.4 valid header"), {
        filename: "他人材料.pdf",
        contentType: "application/pdf"
      })
      .expect(404);

    const after = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM uploads"
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });
});
