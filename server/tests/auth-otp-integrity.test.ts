import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { closePool, query } from "../db.js";
import { ApiError } from "../errors.js";
import { runMigrations } from "../migrate.js";
import { hashOtpCode } from "../security.js";
import {
  redeemInvite,
  registerUser,
  sendOtp,
  verifyCodeLogin
} from "../services.js";
import { withTransaction } from "../db.js";

const emailTarget = "auth-full-chain-email@peileme.test";
const phoneTarget = "+8613900009001";
const validCode = "246810";
const wrongCode = "135791";

const expectApiError = async (
  operation: Promise<unknown>,
  code: string,
  status?: number
) => {
  try {
    await operation;
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(code);
    if (status !== undefined) expect((error as ApiError).status).toBe(status);
  }
};

const insertOtp = async (
  target: string,
  purpose: "register" | "login" | "reset_password",
  options: { expired?: boolean; maxAttempts?: number } = {}
) => {
  const channel = target.includes("@") ? "email" : "sms";
  await query(
    `INSERT INTO otp_codes
       (channel, target, purpose, code_hash, delivery_status, expires_at, max_attempts)
     VALUES ($1, $2, $3, $4, 'sent',
             ${options.expired ? "now() - interval '1 second'" : "now() + interval '10 minutes'"},
             $5)`,
    [
      channel,
      target,
      purpose,
      hashOtpCode(target, purpose, validCode),
      options.maxAttempts ?? 5
    ]
  );
};

const insertUser = async (target: string) => {
  const email = target.includes("@") ? target : null;
  const phone = email ? null : target;
  const result = await query<{ id: string }>(
    `INSERT INTO users(email, phone, display_name, email_verified_at, phone_verified_at)
     VALUES ($1, $2, 'OTP 完整性测试',
             CASE WHEN $1::text IS NULL THEN NULL ELSE now() END,
             CASE WHEN $2::text IS NULL THEN NULL ELSE now() END)
     RETURNING id`,
    [email, phone]
  );
  return result.rows[0].id;
};

describe("OTP transaction integrity", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await query(
      `DELETE FROM otp_codes
        WHERE target IN ($1, $2)
           OR target LIKE 'auth-full-chain-%@peileme.test'
           OR target LIKE '+8613900090%'`,
      [emailTarget, phoneTarget]
    );
    await query(
      `DELETE FROM users
        WHERE email LIKE 'auth-full-chain-%@peileme.test'
           OR phone = $1
           OR phone LIKE '+8613900090%'`,
      [phoneTarget]
    );
    await query("DELETE FROM invite_codes WHERE code LIKE 'AUTH-FULL-CHAIN-%'");
  });

  afterAll(async () => {
    await query(
      `DELETE FROM otp_codes
        WHERE target IN ($1, $2)
           OR target LIKE 'auth-full-chain-%@peileme.test'
           OR target LIKE '+8613900090%'`,
      [emailTarget, phoneTarget]
    );
    await query(
      `DELETE FROM users
        WHERE email LIKE 'auth-full-chain-%@peileme.test'
           OR phone = $1
           OR phone LIKE '+8613900090%'`,
      [phoneTarget]
    );
    await query("DELETE FROM invite_codes WHERE code LIKE 'AUTH-FULL-CHAIN-%'");
    await closePool();
  });

  it.each([
    ["email", emailTarget],
    ["sms", phoneTarget]
  ])("persists failed %s attempts even when verification returns an error", async (_channel, target) => {
    await insertUser(target);
    await insertOtp(target, "login");

    await expectApiError(
      verifyCodeLogin(target, wrongCode),
      "OTP_INVALID_OR_EXPIRED",
      400
    );

    const stored = await query<{ attempts: number }>(
      `SELECT attempts FROM otp_codes
        WHERE target = $1 AND purpose = 'login'
        ORDER BY created_at DESC LIMIT 1`,
      [target]
    );
    expect(stored.rows[0].attempts).toBe(1);
  });

  it("atomically exhausts a code under concurrent wrong guesses", async () => {
    await insertUser(emailTarget);
    await insertOtp(emailTarget, "login", { maxAttempts: 5 });

    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () => verifyCodeLogin(emailTarget, wrongCode))
    );
    const errorCodes = attempts.map((attempt) =>
      attempt.status === "rejected" && attempt.reason instanceof ApiError
        ? attempt.reason.code
        : "unexpected"
    );
    expect(errorCodes).toContain("OTP_INVALID_OR_EXPIRED");
    expect(errorCodes).toContain("OTP_ATTEMPTS_EXCEEDED");

    const stored = await query<{ attempts: number; consumed_at: Date | null }>(
      `SELECT attempts, consumed_at FROM otp_codes
        WHERE target = $1 AND purpose = 'login'
        ORDER BY created_at DESC LIMIT 1`,
      [emailTarget]
    );
    expect(stored.rows[0]).toMatchObject({ attempts: 5, consumed_at: null });
    await expectApiError(
      verifyCodeLogin(emailTarget, validCode),
      "OTP_ATTEMPTS_EXCEEDED",
      429
    );
  });

  it.each([
    ["email", emailTarget],
    ["sms", phoneTarget]
  ])("allows exactly one concurrent use of a correct %s code", async (_channel, target) => {
    await insertUser(target);
    await insertOtp(target, "login");

    const results = await Promise.allSettled([
      verifyCodeLogin(target, validCode),
      verifyCodeLogin(target, validCode)
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({
      code: "OTP_INVALID_OR_EXPIRED"
    });

    const stored = await query<{ attempts: number; consumed_at: Date | null }>(
      `SELECT attempts, consumed_at FROM otp_codes
        WHERE target = $1 AND purpose = 'login'
        ORDER BY created_at DESC LIMIT 1`,
      [target]
    );
    expect(stored.rows[0].attempts).toBe(1);
    expect(stored.rows[0].consumed_at).toBeInstanceOf(Date);
  });

  it("rejects expired and already consumed codes", async () => {
    await insertUser(emailTarget);
    await insertOtp(emailTarget, "login", { expired: true });
    await expectApiError(
      verifyCodeLogin(emailTarget, validCode),
      "OTP_INVALID_OR_EXPIRED",
      400
    );

    await query("DELETE FROM otp_codes WHERE target = $1", [emailTarget]);
    await insertOtp(emailTarget, "login");
    await verifyCodeLogin(emailTarget, validCode);
    await expectApiError(
      verifyCodeLogin(emailTarget, validCode),
      "OTP_INVALID_OR_EXPIRED",
      400
    );
  });

  it.each([
    ["email", emailTarget],
    ["sms", phoneTarget]
  ])("serializes concurrent %s sends so the one-minute target frequency limit cannot be bypassed", async (_channel, target) => {
    const results = await Promise.allSettled([
      sendOtp(target, "register", "127.0.0.1"),
      sendOtp(target, "register", "127.0.0.1")
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({
      code: "OTP_TOO_FREQUENT"
    });
    const stored = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM otp_codes
        WHERE target = $1 AND purpose = 'register'`,
      [target]
    );
    expect(stored.rows[0].count).toBe("1");
  });

  it("persists reset-password failures through the HTTP transaction boundary", async () => {
    await insertUser(emailTarget);
    await insertOtp(emailTarget, "reset_password", { maxAttempts: 2 });
    const app = createApp();

    await request(app)
      .post("/api/auth/reset-password")
      .send({ target: emailTarget, code: wrongCode, password: "ResetPass123" })
      .expect(400);
    const exhausted = await request(app)
      .post("/api/auth/reset-password")
      .send({ target: emailTarget, code: wrongCode, password: "ResetPass123" })
      .expect(429);
    expect(exhausted.body.error).toBe("OTP_ATTEMPTS_EXCEEDED");

    const stored = await query<{ attempts: number }>(
      `SELECT attempts FROM otp_codes
        WHERE target = $1 AND purpose = 'reset_password'
        ORDER BY created_at DESC LIMIT 1`,
      [emailTarget]
    );
    expect(stored.rows[0].attempts).toBe(2);
  });

  it.each([
    ["email", "auth-full-chain-register@peileme.test"],
    ["sms", "+8613900090001"]
  ])("registers a %s identity with a code and records its invite relationship", async (_channel, target) => {
    const inviteCode = `AUTH-FULL-CHAIN-${String(_channel).toUpperCase()}`;
    await query(
      `INSERT INTO invite_codes(code, max_uses, grants)
       VALUES ($1, 1, '["caseLawPack"]'::jsonb)`,
      [inviteCode]
    );
    await insertOtp(target, "register");

    const registered = await registerUser({
      target,
      code: validCode,
      password: "AuthPass123",
      displayName: "完整链路用户",
      inviteCode
    });
    const relationship = await query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM invite_redemptions
        WHERE user_id = $1`,
      [registered.user.id]
    );
    expect(relationship.rows[0].count).toBe("1");
    expect(registered.grants?.grants).toEqual(["caseLawPack"]);
    expect(registered.user.email || registered.user.phone).toBe(target);
  });

  it("never lets a one-use invite attach to two users under concurrent redemption", async () => {
    const first = await insertUser("auth-full-chain-invite-a@peileme.test");
    const second = await insertUser("auth-full-chain-invite-b@peileme.test");
    await query(
      `INSERT INTO invite_codes(code, max_uses, grants)
       VALUES ('AUTH-FULL-CHAIN-ONE', 1, '["evidencePack"]'::jsonb)`
    );

    const results = await Promise.allSettled([
      withTransaction((client) => redeemInvite(client, first, "AUTH-FULL-CHAIN-ONE")),
      withTransaction((client) => redeemInvite(client, second, "AUTH-FULL-CHAIN-ONE"))
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const stored = await query<{ used_count: number; redemption_count: number }>(
      `SELECT i.used_count,
              (SELECT count(*)::int FROM invite_redemptions r WHERE r.invite_code_id = i.id)
                AS redemption_count
         FROM invite_codes i
        WHERE i.code = 'AUTH-FULL-CHAIN-ONE'`
    );
    expect(stored.rows[0]).toEqual({ used_count: 1, redemption_count: 1 });
  });
});
