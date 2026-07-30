import crypto from "node:crypto";
import type pg from "pg";
import type { CookieOptions, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { getConfig } from "./config.js";
import { query, withTransaction } from "./db.js";
import { ApiError } from "./errors.js";
import { deliverOtp, getChannelStatus } from "./notifier.js";
import {
  createOpaqueToken,
  createOtpCode,
  hashOtpCode,
  normalizeEmail,
  normalizePhone,
  publicUser,
  sha256,
  signAccessToken,
  type AuthUser
} from "./security.js";

export type OtpPurpose = "register" | "login" | "bind" | "reset_password";

export const normalizeTarget = (rawTarget: string) => {
  const value = rawTarget.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return { channel: "email" as const, target: normalizeEmail(value) };
  }
  const phone = normalizePhone(value);
  if (/^(?:\+86)?1\d{10}$/.test(phone)) {
    return {
      channel: "sms" as const,
      target: phone.startsWith("+86") ? phone : `+86${phone}`
    };
  }
  throw new ApiError(400, "INVALID_TARGET", "请输入有效的邮箱或中国大陆手机号");
};

export const sendOtp = async (
  rawTarget: string,
  purpose: OtpPurpose,
  requesterIp?: string
) => {
  const { channel, target } = normalizeTarget(rawTarget);
  const channelStatus = getChannelStatus();
  if (!getConfig().OTP_DEBUG && !channelStatus[channel].configured) {
    throw new ApiError(
      503,
      channel === "email" ? "EMAIL_CHANNEL_NOT_CONFIGURED" : "SMS_CHANNEL_NOT_CONFIGURED",
      channel === "email" ? "邮箱验证码渠道尚未配置" : "短信验证码渠道尚未配置"
    );
  }
  const recent = await query<{ count: string }>(
    `SELECT count(*)::text AS count
      FROM otp_codes
      WHERE target = $1
        AND purpose = $2
        AND created_at > now() - interval '1 minute'`,
    [target, purpose]
  );
  if (Number(recent.rows[0]?.count || 0) > 0) {
    throw new ApiError(429, "OTP_TOO_FREQUENT", "验证码发送过于频繁，请稍后再试");
  }
  const code = createOtpCode();
  const codeHash = hashOtpCode(target, purpose, code);
  const inserted = await query<{ id: string }>(
    `INSERT INTO otp_codes
       (channel, target, purpose, code_hash, requester_ip, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' minutes')::interval)
     RETURNING id`,
    [channel, target, purpose, codeHash, requesterIp || null, getConfig().OTP_TTL_MINUTES]
  );
  const id = inserted.rows[0].id;
  try {
    const delivery = await deliverOtp(channel, target, code);
    await query(
      `UPDATE otp_codes
          SET delivery_status = 'sent', provider_message_id = $2
        WHERE id = $1`,
      [id, delivery.messageId || null]
    );
    return {
      channel,
      targetMasked:
        channel === "email"
          ? target.replace(/^(.{2}).*(@.*)$/, "$1***$2")
          : target.replace(/^(\+86\d{3})\d{4}(\d{4})$/, "$1****$2"),
      expiresInSeconds: getConfig().OTP_TTL_MINUTES * 60,
      ...(getConfig().OTP_DEBUG ? { debugCode: code } : {})
    };
  } catch (error) {
    await query(
      `UPDATE otp_codes
          SET delivery_status = 'failed', error_message = $2
        WHERE id = $1`,
      [id, error instanceof Error ? error.message.slice(0, 500) : "unknown error"]
    );
    throw error;
  }
};

export const consumeOtp = async (
  client: pg.PoolClient,
  rawTarget: string,
  purpose: OtpPurpose,
  code: string
) => {
  const { channel, target } = normalizeTarget(rawTarget);
  const result = await client.query<{
    id: string;
    code_hash: string;
    attempts: number;
    max_attempts: number;
  }>(
    `SELECT id, code_hash, attempts, max_attempts
       FROM otp_codes
      WHERE target = $1
        AND purpose = $2
        AND consumed_at IS NULL
        AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE`,
    [target, purpose]
  );
  const otp = result.rows[0];
  if (!otp) throw new ApiError(400, "OTP_INVALID_OR_EXPIRED", "验证码错误或已过期");
  if (otp.attempts >= otp.max_attempts) {
    throw new ApiError(429, "OTP_ATTEMPTS_EXCEEDED", "验证码尝试次数过多");
  }
  const valid = hashOtpCode(target, purpose, code) === otp.code_hash;
  if (!valid) {
    await client.query("UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1", [otp.id]);
    throw new ApiError(400, "OTP_INVALID_OR_EXPIRED", "验证码错误或已过期");
  }
  await client.query(
    "UPDATE otp_codes SET consumed_at = now(), attempts = attempts + 1 WHERE id = $1",
    [otp.id]
  );
  return { channel, target };
};

type InviteRecord = {
  id: string;
  code: string;
  max_uses: number;
  used_count: number;
  grants: string[];
};

export const validateInvite = async (
  client: pg.PoolClient,
  rawCode: string,
  lock = false
): Promise<InviteRecord> => {
  const code = rawCode.trim().toUpperCase();
  const result = await client.query<InviteRecord>(
    `SELECT id, code, max_uses, used_count, grants
       FROM invite_codes
      WHERE upper(code) = $1
        AND enabled = true
        AND (expires_at IS NULL OR expires_at > now())
        AND used_count < max_uses
      LIMIT 1
      ${lock ? "FOR UPDATE" : ""}`,
    [code]
  );
  const invite = result.rows[0];
  if (!invite) throw new ApiError(400, "INVITE_INVALID", "邀请码无效、已过期或次数已用完");
  return invite;
};

export const redeemInvite = async (
  client: pg.PoolClient,
  userId: string,
  rawCode: string
) => {
  const invite = await validateInvite(client, rawCode, true);
  const existing = await client.query(
    "SELECT 1 FROM invite_redemptions WHERE invite_code_id = $1 AND user_id = $2",
    [invite.id, userId]
  );
  if (existing.rowCount) {
    throw new ApiError(409, "INVITE_ALREADY_REDEEMED", "这个邀请码已经兑换过");
  }
  await client.query(
    "INSERT INTO invite_redemptions(invite_code_id, user_id) VALUES ($1, $2)",
    [invite.id, userId]
  );
  await client.query(
    "UPDATE invite_codes SET used_count = used_count + 1, updated_at = now() WHERE id = $1",
    [invite.id]
  );
  const grants = Array.isArray(invite.grants) ? invite.grants : [];
  for (const moduleName of grants) {
    await client.query(
      `INSERT INTO access_grants(user_id, module, source, source_id)
       VALUES ($1, $2, 'invite', $3)
       ON CONFLICT DO NOTHING`,
      [userId, String(moduleName), invite.id]
    );
  }
  return { code: invite.code, grants };
};

const sharedCookieOptions = (path: string): CookieOptions => ({
  sameSite: "lax",
  secure: getConfig().NODE_ENV === "production",
  domain: getConfig().COOKIE_DOMAIN || undefined,
  path
});

const refreshCookieOptions = (): CookieOptions => ({
  ...sharedCookieOptions("/api/auth"),
  httpOnly: true,
  maxAge: getConfig().REFRESH_TOKEN_TTL_DAYS * 86_400_000
});

const csrfCookieOptions = (): CookieOptions => ({
  ...sharedCookieOptions("/"),
  httpOnly: false,
  maxAge: getConfig().REFRESH_TOKEN_TTL_DAYS * 86_400_000
});

const csrfSignature = (nonce: string) =>
  crypto
    .createHmac("sha256", getConfig().CSRF_SECRET)
    .update(nonce)
    .digest("base64url");

const createCsrfToken = () => {
  const nonce = createOpaqueToken();
  return `${nonce}.${csrfSignature(nonce)}`;
};

const safeEqual = (left: string, right: string) => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

export const verifyCsrfRequest = (request: Request) => {
  const cookieToken = String(request.cookies?.peileme_csrf || "");
  const headerToken = String(request.header("x-csrf-token") || "");
  if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken)) {
    return false;
  }
  const separator = cookieToken.lastIndexOf(".");
  if (separator < 1) return false;
  const nonce = cookieToken.slice(0, separator);
  const signature = cookieToken.slice(separator + 1);
  return Boolean(signature) && safeEqual(signature, csrfSignature(nonce));
};

const setSessionCookies = (response: Response, refreshToken: string) => {
  response.cookie("peileme_refresh", refreshToken, refreshCookieOptions());
  response.cookie("peileme_csrf", createCsrfToken(), csrfCookieOptions());
};

export const clearRefreshCookie = (response: Response) => {
  const { maxAge: _refreshMaxAge, ...refreshOptions } = refreshCookieOptions();
  const { maxAge: _csrfMaxAge, ...csrfOptions } = csrfCookieOptions();
  response.clearCookie("peileme_refresh", refreshOptions);
  response.clearCookie("peileme_csrf", csrfOptions);
};

export type DeviceSession = {
  id: string;
  userAgent: string | null;
  ip: string | null;
  expiresAt: Date;
  lastUsedAt: Date | null;
  createdAt: Date;
  isCurrent: boolean;
};

export const listOwnedSessions = async (
  userId: string,
  refreshToken: string
): Promise<DeviceSession[]> => {
  const currentTokenHash = refreshToken ? sha256(refreshToken) : "";
  const result = await query<{
    id: string;
    user_agent: string | null;
    ip: string | null;
    expires_at: Date;
    last_used_at: Date | null;
    created_at: Date;
    is_current: boolean;
  }>(
    `SELECT id, user_agent, ip::text, expires_at, last_used_at, created_at,
            token_hash = $2 AS is_current
       FROM refresh_sessions
      WHERE user_id = $1
        AND revoked_at IS NULL
        AND expires_at > now()
      ORDER BY created_at DESC`,
    [userId, currentTokenHash]
  );
  return result.rows.map((row) => ({
    id: row.id,
    userAgent: row.user_agent,
    ip: row.ip,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    isCurrent: row.is_current
  }));
};

export const revokeOwnedSession = async (
  userId: string,
  sessionId: string,
  refreshToken: string
) => {
  const result = await query<{ token_hash: string }>(
    `UPDATE refresh_sessions
        SET revoked_at = now()
      WHERE id = $1
        AND user_id = $2
        AND revoked_at IS NULL
      RETURNING token_hash`,
    [sessionId, userId]
  );
  const session = result.rows[0];
  if (!session) {
    throw new ApiError(404, "SESSION_NOT_FOUND", "设备会话不存在");
  }
  return {
    isCurrent:
      Boolean(refreshToken) && safeEqual(session.token_hash, sha256(refreshToken))
  };
};

export const revokeOtherSessions = async (
  userId: string,
  refreshToken: string
) =>
  withTransaction(async (client) => {
    if (!refreshToken) {
      throw new ApiError(
        400,
        "SESSION_CONTEXT_REQUIRED",
        "当前设备会话不可用，请重新登录"
      );
    }
    const current = await client.query<{ id: string }>(
      `SELECT id
         FROM refresh_sessions
        WHERE user_id = $1
          AND token_hash = $2
          AND revoked_at IS NULL
          AND expires_at > now()
        LIMIT 1
        FOR UPDATE`,
      [userId, sha256(refreshToken)]
    );
    if (!current.rows[0]) {
      throw new ApiError(
        400,
        "SESSION_CONTEXT_REQUIRED",
        "当前设备会话不可用，请重新登录"
      );
    }
    const revoked = await client.query(
      `UPDATE refresh_sessions
          SET revoked_at = now()
        WHERE user_id = $1
          AND id <> $2
          AND revoked_at IS NULL`,
      [userId, current.rows[0].id]
    );
    return revoked.rowCount || 0;
  });

export const issueSession = async (
  user: AuthUser,
  request: Request,
  response: Response
) => {
  const refreshToken = createOpaqueToken();
  await query(
    `INSERT INTO refresh_sessions
       (user_id, token_hash, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' days')::interval)`,
    [
      user.id,
      sha256(refreshToken),
      request.header("user-agent")?.slice(0, 500) || null,
      request.ip || null,
      getConfig().REFRESH_TOKEN_TTL_DAYS
    ]
  );
  setSessionCookies(response, refreshToken);
  return {
    accessToken: await signAccessToken(user),
    expiresInSeconds: getConfig().ACCESS_TOKEN_TTL_MINUTES * 60,
    user: publicUser(user)
  };
};

export const registerUser = async (input: {
  target: string;
  code: string;
  password?: string;
  displayName?: string;
  inviteCode?: string;
}) =>
  withTransaction(async (client) => {
    const verified = await consumeOtp(client, input.target, "register", input.code);
    if (getConfig().REGISTRATION_REQUIRE_INVITE && !input.inviteCode) {
      throw new ApiError(400, "INVITE_REQUIRED", "注册需要邀请码");
    }
    const email = verified.channel === "email" ? verified.target : null;
    const phone = verified.channel === "sms" ? verified.target : null;
    const duplicate = await client.query(
      "SELECT 1 FROM users WHERE lower(email) = lower($1) OR phone = $2",
      [email, phone]
    );
    if (duplicate.rowCount) throw new ApiError(409, "USER_EXISTS", "该账号已经注册");
    const passwordHash = input.password
      ? await bcrypt.hash(input.password, 12)
      : null;
    const result = await client.query<{
      id: string;
      role: AuthUser["role"];
      email: string | null;
      phone: string | null;
      display_name: string | null;
      status: AuthUser["status"];
    }>(
      `INSERT INTO users
         (email, phone, display_name, password_hash, email_verified_at, phone_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, role, email, phone, display_name, status`,
      [
        email,
        phone,
        input.displayName?.trim().slice(0, 80) || null,
        passwordHash,
        email ? new Date() : null,
        phone ? new Date() : null
      ]
    );
    const row = result.rows[0];
    const grants = input.inviteCode
      ? await redeemInvite(client, row.id, input.inviteCode)
      : undefined;
    return {
      user: {
        id: row.id,
        role: row.role,
        email: row.email,
        phone: row.phone,
        displayName: row.display_name,
        status: row.status
      } satisfies AuthUser,
      grants
    };
  });

export const verifyPasswordLogin = async (identifier: string, password: string) => {
  const { channel, target } = normalizeTarget(identifier);
  const result = await query<{
    id: string;
    role: AuthUser["role"];
    email: string | null;
    phone: string | null;
    display_name: string | null;
    status: AuthUser["status"];
    password_hash: string | null;
  }>(
    `SELECT id, role, email, phone, display_name, status, password_hash
       FROM users
      WHERE ${channel === "email" ? "lower(email) = lower($1)" : "phone = $1"}
      LIMIT 1`,
    [target]
  );
  const row = result.rows[0];
  if (!row?.password_hash || !(await bcrypt.compare(password, row.password_hash))) {
    throw new ApiError(401, "LOGIN_FAILED", "账号或密码错误");
  }
  if (row.status !== "active") throw new ApiError(403, "USER_DISABLED", "账号已被停用");
  await query("UPDATE users SET last_login_at = now() WHERE id = $1", [row.id]);
  return {
    id: row.id,
    role: row.role,
    email: row.email,
    phone: row.phone,
    displayName: row.display_name,
    status: row.status
  } satisfies AuthUser;
};

export const verifyCodeLogin = async (identifier: string, code: string) =>
  withTransaction(async (client) => {
    const verified = await consumeOtp(client, identifier, "login", code);
    const result = await client.query<{
      id: string;
      role: AuthUser["role"];
      email: string | null;
      phone: string | null;
      display_name: string | null;
      status: AuthUser["status"];
    }>(
      `SELECT id, role, email, phone, display_name, status
         FROM users
        WHERE ${verified.channel === "email" ? "lower(email) = lower($1)" : "phone = $1"}
        LIMIT 1`,
      [verified.target]
    );
    const row = result.rows[0];
    if (!row) throw new ApiError(404, "USER_NOT_FOUND", "账号尚未注册");
    if (row.status !== "active") throw new ApiError(403, "USER_DISABLED", "账号已被停用");
    await client.query("UPDATE users SET last_login_at = now() WHERE id = $1", [row.id]);
    return {
      id: row.id,
      role: row.role,
      email: row.email,
      phone: row.phone,
      displayName: row.display_name,
      status: row.status
    } satisfies AuthUser;
  });
