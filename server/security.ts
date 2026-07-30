import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { SignJWT, jwtVerify } from "jose";
import { getConfig } from "./config.js";
import { query } from "./db.js";

export type AuthUser = {
  id: string;
  role: "user" | "admin" | "analyst";
  email: string | null;
  phone: string | null;
  displayName: string | null;
  status: "active" | "disabled";
};

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser;
    }
  }
}

const jwtKey = () => new TextEncoder().encode(getConfig().JWT_SECRET);

export const sha256 = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex");

export const createOpaqueToken = () => crypto.randomBytes(48).toString("base64url");

export const createOtpCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

export const hashOtpCode = (target: string, purpose: string, code: string) =>
  crypto
    .createHmac("sha256", getConfig().OTP_SECRET)
    .update(`${target}:${purpose}:${code}`)
    .digest("hex");

export const signAccessToken = async (user: AuthUser) =>
  new SignJWT({ role: user.role, email: user.email, phone: user.phone })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${getConfig().ACCESS_TOKEN_TTL_MINUTES}m`)
    .setIssuer("peileme-api")
    .setAudience("peileme-web")
    .sign(jwtKey());

export const verifyAccessToken = async (token: string) => {
  const { payload } = await jwtVerify(token, jwtKey(), {
    issuer: "peileme-api",
    audience: "peileme-web"
  });
  if (!payload.sub) throw new Error("Access token has no subject");
  return payload;
};

const loadUser = async (id: string): Promise<AuthUser | undefined> => {
  const result = await query<{
    id: string;
    role: AuthUser["role"];
    email: string | null;
    phone: string | null;
    display_name: string | null;
    status: AuthUser["status"];
  }>(
    `SELECT id, role, email, phone, display_name, status
       FROM users
      WHERE id = $1`,
    [id]
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        role: row.role,
        email: row.email,
        phone: row.phone,
        displayName: row.display_name,
        status: row.status
      }
    : undefined;
};

export const optionalAuth = async (request: Request, _response: Response, next: NextFunction) => {
  try {
    const authorization = request.header("authorization");
    if (!authorization?.startsWith("Bearer ")) return next();
    const payload = await verifyAccessToken(authorization.slice(7));
    const user = await loadUser(payload.sub as string);
    if (user?.status === "active") request.authUser = user;
    next();
  } catch {
    next();
  }
};

export const requireAuth = (request: Request, response: Response, next: NextFunction) => {
  if (!request.authUser) {
    response.status(401).json({ error: "AUTH_REQUIRED", message: "请先登录" });
    return;
  }
  next();
};

export const requireCapability = (capability: string) => async (
  request: Request,
  response: Response,
  next: NextFunction
) => {
  if (!request.authUser) {
    response.status(401).json({ error: "AUTH_REQUIRED", message: "请先登录" });
    return;
  }
  try {
    const result = await query(
      `SELECT 1
         FROM role_capabilities
        WHERE role = $1
          AND capability = $2`,
      [request.authUser.role, capability]
    );
    if (!result.rowCount) {
      response.status(403).json({
        error: "CAPABILITY_REQUIRED",
        message: "当前账号没有此操作权限"
      });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
};

export const requireAdmin = (request: Request, response: Response, next: NextFunction) => {
  if (!request.authUser || !["admin", "analyst"].includes(request.authUser.role)) {
    response.status(403).json({ error: "ADMIN_REQUIRED", message: "需要管理权限" });
    return;
  }
  next();
};

export const requireSuperAdmin = (
  request: Request,
  response: Response,
  next: NextFunction
) => {
  if (!request.authUser || request.authUser.role !== "admin") {
    response.status(403).json({ error: "SUPER_ADMIN_REQUIRED", message: "需要超级管理员权限" });
    return;
  }
  next();
};

export const normalizeEmail = (value: string) => value.trim().toLowerCase();
export const normalizePhone = (value: string) => value.replace(/[^\d+]/g, "");

export const getRequestIdentity = (request: Request) => {
  const visitorId = String(request.header("x-visitor-id") || "").slice(0, 80);
  const sessionId = String(request.header("x-session-id") || "").slice(0, 80);
  const safePattern = /^[a-zA-Z0-9_-]{8,80}$/;
  return {
    visitorId: safePattern.test(visitorId) ? visitorId : `visitor_${crypto.randomUUID()}`,
    sessionId: safePattern.test(sessionId) ? sessionId : `session_${crypto.randomUUID()}`
  };
};

export const publicUser = (user: AuthUser) => ({
  id: user.id,
  role: user.role,
  email: user.email,
  phone: user.phone,
  displayName: user.displayName,
  status: user.status
});
