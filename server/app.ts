import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import compression from "compression";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import multer from "multer";
import { nanoid } from "nanoid";
import { pinoHttp } from "pino-http";
import { z } from "zod";
import { writeAdminAudit as audit } from "./audit.js";
import { getConfig } from "./config.js";
import { query, withTransaction } from "./db.js";
import { ApiError } from "./errors.js";
import { createCommerceRouters } from "./modules/commerce/routes.js";
import { createAiRouter } from "./modules/ai/routes.js";
import { listOwnedAiJobs } from "./modules/ai/repository.js";
import type { AiProvider } from "./modules/llm/types.js";
import type { PaymentProvider } from "./modules/payments/provider.js";
import { getChannelStatus } from "./notifier.js";
import {
  createAdminPolicyRouter,
  createPolicyRouter
} from "./modules/policy/routes.js";
import { type PolicyOutput } from "./modules/policy/types.js";
import {
  listUserHistory,
  type AiHistorySource
} from "./modules/history/service.js";
import {
  ACCESS_GRANT_MODULES,
  clearRefreshCookie,
  consumeOtp,
  issueSession,
  listOwnedSessions,
  normalizeTarget,
  redeemInvite,
  registerUser,
  revokeOtherSessions,
  revokeOwnedSession,
  revokeSessionByRefreshToken,
  rotateRefreshSession,
  sanitizeGrantModules,
  sendOtp,
  validateInvite,
  verifyCsrfRequest,
  verifyCodeLogin,
  verifyPasswordLogin,
  withOtpTransaction,
  type OtpPurpose
} from "./services.js";
import {
  getRequestIdentity,
  optionalAuth,
  publicUser,
  requireAdmin,
  requireAuth,
  requireSuperAdmin
} from "./security.js";
import {
  attachProductChannel,
  createProductHostResolver,
  requireAiProductHost,
  requireProductHost
} from "./product-host.js";

const identifierSchema = z.string().trim().min(4).max(160);
const codeSchema = z.string().regex(/^\d{6}$/, "验证码应为 6 位数字");
const passwordSchema = z
  .string()
  .min(8, "密码至少 8 位")
  .max(128)
  .regex(/[A-Za-z]/, "密码需包含字母")
  .regex(/\d/, "密码需包含数字");
const uuidSchema = z.string().uuid();

const refreshTokenFrom = (request: Request) =>
  String(
    request.cookies?.peileme_refresh_v2 ||
      request.cookies?.peileme_refresh ||
      ""
  );

const requireValidCsrf = (
  request: Request,
  response: Response,
  next: NextFunction
) => {
  if (!refreshTokenFrom(request) || verifyCsrfRequest(request)) {
    next();
    return;
  }
  response.status(403).json({
    error: "CSRF_INVALID",
    message: "安全校验失败，请刷新页面后重试"
  });
};

const otpRateLimiter = rateLimit({
  windowMs: 10 * 60_000,
  limit: 8,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "RATE_LIMITED", message: "请求过于频繁，请稍后再试" }
});

const authRateLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "RATE_LIMITED", message: "登录尝试过于频繁，请稍后再试" }
});

const maskUserAgent = (request: Request) =>
  request.header("user-agent")?.slice(0, 500) || null;

const parsePagination = (request: Request) => {
  const page = Math.max(1, Number(request.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize) || 20));
  return { page, pageSize, offset: (page - 1) * pageSize };
};

const uploadConfig = () => {
  const uploadDir = path.resolve(getConfig().UPLOAD_DIR);
  fs.mkdirSync(uploadDir, { recursive: true, mode: 0o750 });
  return {
    uploadDir,
    middleware: multer({
      storage: multer.diskStorage({
        destination: uploadDir,
        filename: (_request, file, callback) => {
          const extensionByMime: Record<string, string> = {
            "image/jpeg": ".jpg",
            "image/png": ".png",
            "image/webp": ".webp",
            "application/pdf": ".pdf"
          };
          callback(null, `${crypto.randomUUID()}${extensionByMime[file.mimetype] || ""}`);
        }
      }),
      limits: {
        files: 6,
        fileSize: getConfig().MAX_UPLOAD_MB * 1024 * 1024
      },
      fileFilter: (_request, file, callback) => {
        const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
        if (allowed.includes(file.mimetype)) {
          callback(null, true);
          return;
        }
        callback(new ApiError(400, "UNSUPPORTED_FILE_TYPE", "仅支持 JPG、PNG、WebP 和 PDF"));
      }
    })
  };
};

const normalizeUploadFilename = (filename: string) => {
  const basename = path.basename(filename);
  try {
    const decoded = Buffer.from(basename, "latin1").toString("utf8");
    return decoded.includes("\uFFFD") ? basename : decoded;
  } catch {
    return basename;
  }
};

const hasExpectedFileSignature = (file: Express.Multer.File) => {
  const descriptor = fs.openSync(file.path, "r");
  const header = Buffer.alloc(12);
  try {
    fs.readSync(descriptor, header, 0, header.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  if (file.mimetype === "application/pdf") return header.subarray(0, 4).toString() === "%PDF";
  if (file.mimetype === "image/jpeg") {
    return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  }
  if (file.mimetype === "image/png") {
    return header
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (file.mimetype === "image/webp") {
    return header.subarray(0, 4).toString() === "RIFF" &&
      header.subarray(8, 12).toString() === "WEBP";
  }
  return false;
};

const removeUploadedFiles = (files: Express.Multer.File[]) => {
  files.forEach((file) => {
    try {
      fs.unlinkSync(file.path);
    } catch {
      // Cleanup is best-effort when a request has already failed.
    }
  });
};

const persistedAiHistorySource: AiHistorySource = async ({ userId, limit }) => {
  const result = await listOwnedAiJobs(userId, limit, 0);
  return {
    total: result.total,
    items: result.items.map((job) => ({
      id: job.id,
      source: "ai",
      kind: "ai_analysis",
      status: job.status,
      title: job.kind === "document_review" ? "文件签署分析" : "赔了么 AI 分析",
      occurredAt: job.completedAt ?? job.updatedAt ?? job.createdAt,
      updatedAt: job.updatedAt,
      metadata: { reportReady: Boolean(job.report) }
    }))
  };
};

export const createApp = (
  options: {
    policyCalculate?: (input: unknown) => PolicyOutput;
    paymentProvider?: PaymentProvider;
    aiProviders?: readonly AiProvider[];
    aiHistorySource?: AiHistorySource;
  } = {}
) => {
  const config = getConfig();
  const aiHistorySource = options.aiHistorySource ?? persistedAiHistorySource;
  const { uploadDir, middleware: upload } = uploadConfig();
  const app = express();

  app.set("trust proxy", config.TRUST_PROXY);
  app.disable("x-powered-by");
  app.use(
    pinoHttp({
      quietReqLogger: true,
      autoLogging: config.NODE_ENV !== "test",
      redact: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"]
    })
  );
  app.use(helmet({ crossOriginResourcePolicy: { policy: "same-site" } }));
  app.use(compression());
  app.use(
    attachProductChannel(
      createProductHostResolver(
        config.MAIN_PRODUCT_HOSTS,
        config.AI_PRODUCT_HOSTS
      )
    )
  );
  app.use(
    "/api",
    (request: Request, response: Response, next: NextFunction) => {
      if (
        request.path === "/health" &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        next();
        return;
      }
      requireProductHost(request, response, next);
    }
  );
  app.use("/api/uploads", requireAiProductHost);
  app.use("/api/admin/uploads", requireAiProductHost);
  app.use(
    cors({
      origin: config.APP_ORIGIN.split(",").map((item) => item.trim()),
      credentials: true
    })
  );
  app.use(express.json({ limit: "512kb" }));
  app.use(express.urlencoded({ extended: false, limit: "128kb" }));
  app.use(cookieParser());
  app.use(optionalAuth);
  const commerceRouters = createCommerceRouters(options.paymentProvider);
  app.use("/api/commerce", commerceRouters.router);
  app.use("/api/admin/commerce", commerceRouters.adminRouter);
  if (config.NODE_ENV === "test") {
    app.use("/api/test-payments", commerceRouters.testRouter);
  }
  app.use(
    "/api/policy",
    createPolicyRouter({ calculate: options.policyCalculate })
  );
  app.use("/api/admin/policy", createAdminPolicyRouter());
  app.use("/api/ai", requireAiProductHost, createAiRouter(options.aiProviders));

  app.get("/api/health", async (_request, response) => {
    const started = Date.now();
    const database = await query<{ now: Date }>("SELECT now()");
    response.json({
      status: "healthy",
      version: process.env.APP_VERSION || "dev",
      database: Boolean(database.rows[0]),
      channels: getChannelStatus(),
      uptimeSeconds: Math.round(process.uptime()),
      checkedInMs: Date.now() - started
    });
  });

  app.get("/api/public/config", (request, response) => {
    response.json({
      registrationRequireInvite: config.REGISTRATION_REQUIRE_INVITE,
      channels: getChannelStatus(),
      ...(request.productChannel === "ai"
        ? { maxUploadMb: config.MAX_UPLOAD_MB }
        : {})
    });
  });

  const allowedOrigins = new Set(
    config.APP_ORIGIN.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  );
  const rejectOrigin = (response: Response) =>
    response.status(403).json({
      error: "ORIGIN_FORBIDDEN",
      message: "请求来源未获授权"
    });
  const requireMutationOrigin = (
    request: Request,
    response: Response,
    next: NextFunction
  ) => {
    const origin = request.header("origin");
    if (!origin || !allowedOrigins.has(origin)) {
      rejectOrigin(response);
      return;
    }
    next();
  };
  app.use(
    "/api/auth",
    (request: Request, response: Response, next: NextFunction) => {
      const origin = request.header("origin");
      if (origin && !allowedOrigins.has(origin)) {
        rejectOrigin(response);
        return;
      }
      next();
    }
  );

  app.post("/api/auth/send-code", otpRateLimiter, async (request, response) => {
    const body = z
      .object({
        target: identifierSchema,
        purpose: z.enum(["register", "login", "bind", "reset_password"])
      })
      .parse(request.body);
    const result = await sendOtp(body.target, body.purpose as OtpPurpose, request.ip);
    response.status(201).json(result);
  });

  app.post("/api/auth/register", authRateLimiter, async (request, response) => {
    const body = z
      .object({
        target: identifierSchema,
        code: codeSchema,
        password: passwordSchema.optional(),
        displayName: z.string().trim().min(1).max(80).optional(),
        inviteCode: z.string().trim().min(4).max(80).optional()
      })
      .parse(request.body);
    const registered = await registerUser(body);
    const session = await issueSession(registered.user, request, response);
    response.status(201).json({ ...session, redeemed: registered.grants });
  });

  app.post("/api/auth/login", authRateLimiter, async (request, response) => {
    const body = z
      .object({
        identifier: identifierSchema,
        password: z.string().min(1).max(128).optional(),
        code: codeSchema.optional()
      })
      .refine((value) => Boolean(value.password || value.code), {
        message: "请输入密码或验证码"
      })
      .parse(request.body);
    const user = body.code
      ? await verifyCodeLogin(body.identifier, body.code)
      : await verifyPasswordLogin(body.identifier, body.password!);
    response.json(await issueSession(user, request, response));
  });

  app.post("/api/auth/reset-password", authRateLimiter, async (request, response) => {
    const body = z
      .object({
        target: identifierSchema,
        code: codeSchema,
        password: passwordSchema
      })
      .parse(request.body);
    const normalized = await withOtpTransaction(async (client) => {
      const target = await consumeOtp(client, body.target, "reset_password", body.code);
      const passwordHash = await bcrypt.hash(body.password, 12);
      const result = await client.query<{ id: string }>(
        `UPDATE users
            SET password_hash = $2, updated_at = now()
          WHERE (email = $1 OR phone = $1)
            AND status = 'active'
          RETURNING id`,
        [target.target, passwordHash]
      );
      if (!result.rowCount) throw new ApiError(404, "USER_NOT_FOUND", "账号不存在");
      await client.query(
        "UPDATE refresh_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
        [result.rows[0].id]
      );
      return target;
    });
    response.json({ reset: true, channel: normalized.channel });
  });

  app.post(
    "/api/auth/refresh",
    requireMutationOrigin,
    requireValidCsrf,
    async (request, response) => {
      const refreshToken = refreshTokenFrom(request);
      if (!refreshToken) {
        response.status(204).end();
        return;
      }
      try {
        response.json(
          await rotateRefreshSession(refreshToken, request, response)
        );
      } catch (error) {
        if (error instanceof ApiError && error.code === "REFRESH_INVALID") {
          clearRefreshCookie(response);
        }
        throw error;
      }
    }
  );

  app.post(
    "/api/auth/logout",
    requireMutationOrigin,
    requireValidCsrf,
    async (request, response) => {
      const refreshToken = refreshTokenFrom(request);
      await revokeSessionByRefreshToken(refreshToken);
      clearRefreshCookie(response);
      response.status(204).end();
    }
  );

  app.get("/api/auth/me", requireAuth, async (request, response) => {
    const capabilities = await query<{ capability: string }>(
      `SELECT capability
         FROM role_capabilities
        WHERE role = $1
        ORDER BY capability`,
      [request.authUser!.role]
    );
    response.json({
      user: publicUser(request.authUser!),
      capabilities: capabilities.rows.map((row) => row.capability)
    });
  });

  app.get("/api/auth/sessions", requireAuth, async (request, response) => {
    const items = await listOwnedSessions(
      request.authUser!.id,
      refreshTokenFrom(request)
    );
    response.json({ items });
  });

  app.delete(
    "/api/auth/sessions/:id",
    requireAuth,
    requireMutationOrigin,
    requireValidCsrf,
    async (request, response) => {
      const id = uuidSchema.parse(request.params.id);
      const revoked = await revokeOwnedSession(
        request.authUser!.id,
        id,
        refreshTokenFrom(request)
      );
      if (revoked.isCurrent) clearRefreshCookie(response);
      response.status(204).end();
    }
  );

  app.post(
    "/api/auth/sessions/revoke-others",
    requireAuth,
    requireMutationOrigin,
    requireValidCsrf,
    async (request, response) => {
      const revoked = await revokeOtherSessions(
        request.authUser!.id,
        refreshTokenFrom(request)
      );
      response.json({ revoked });
    }
  );

  app.patch("/api/auth/me", requireAuth, async (request, response) => {
    const body = z
      .object({ displayName: z.string().trim().min(1).max(80) })
      .parse(request.body);
    const result = await query<{ display_name: string }>(
      `UPDATE users
          SET display_name = $2, updated_at = now()
        WHERE id = $1
        RETURNING display_name`,
      [request.authUser!.id, body.displayName]
    );
    response.json({ displayName: result.rows[0].display_name });
  });

  app.post("/api/invites/validate", async (request, response) => {
    const body = z.object({ code: z.string().trim().min(4).max(80) }).parse(request.body);
    const invite = await withTransaction((client) => validateInvite(client, body.code));
    response.json({ valid: true, grants: sanitizeGrantModules(invite.grants) });
  });

  app.post("/api/invites/redeem", requireAuth, async (request, response) => {
    const body = z.object({ code: z.string().trim().min(4).max(80) }).parse(request.body);
    const redeemed = await withTransaction((client) =>
      redeemInvite(client, request.authUser!.id, body.code)
    );
    response.json(redeemed);
  });

  app.get("/api/access/me", requireAuth, async (request, response) => {
    const result = await query<{ module: string; expires_at: Date | null }>(
      `SELECT DISTINCT module, expires_at
         FROM access_grants
        WHERE user_id = $1
          AND module = ANY($2::text[])
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY module`,
      [request.authUser!.id, ACCESS_GRANT_MODULES]
    );
    response.json({ grants: result.rows });
  });

  const historyQuerySchema = z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20)
    })
    .strict();

  app.get("/api/me/history", requireAuth, async (request, response) => {
    const params = historyQuerySchema.parse(request.query);
    const history = await listUserHistory({
      userId: request.authUser!.id,
      channel: request.productChannel!,
      page: params.page,
      pageSize: params.pageSize,
      aiHistorySource
    });
    response.json({ channel: request.productChannel, ...history });
  });

  app.get("/api/account/history", requireAuth, async (request, response) => {
    const params = historyQuerySchema.parse(request.query);
    const channel = request.productChannel!;
    const history = await listUserHistory({
      userId: request.authUser!.id,
      channel,
      page: params.page,
      pageSize: params.pageSize,
      aiHistorySource,
      includePolicy: channel === "main"
    });
    response.set("deprecation", "true");
    response.json({
      items: history.items.map((item) => ({
        ...item,
        sourceId: item.id,
        source:
          item.kind === "order"
            ? "order"
            : item.kind === "policy_assessment"
              ? "policy_calculation"
              : item.kind === "document_analysis"
                ? "upload"
                : "ai_task",
        productChannel: channel
      })),
      pagination: history.pagination,
      sourceStatus: {
        policy_calculations: channel === "main" ? "available" : "not_applicable",
        orders: "available",
        uploads: channel === "ai" ? "available" : "not_applicable",
        ai_tasks: "available"
      }
    });
  });

  const assessmentBodySchema = z.object({
    status: z.enum(["in_progress", "completed", "abandoned"]).default("in_progress"),
    currentStep: z.string().max(100).optional(),
    answers: z.record(z.string(), z.unknown()).default({}),
    result: z.record(z.string(), z.unknown()).nullable().optional()
  });

  app.post("/api/assessments", async (request, response) => {
    const body = assessmentBodySchema.parse(request.body);
    const identity = getRequestIdentity(request);
    const saved = await query<{ id: string; created_at: Date; updated_at: Date }>(
      `INSERT INTO assessments
         (user_id, visitor_id, session_id, status, current_step, answers, result, completed_at, product_channel)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $4 = 'completed' THEN now() END, $8)
       RETURNING id, created_at, updated_at`,
      [
        request.authUser?.id || null,
        identity.visitorId,
        identity.sessionId,
        body.status,
        body.currentStep || null,
        body.answers,
        body.result || null,
        request.productChannel!
      ]
    );
    response.status(201).json(saved.rows[0]);
  });

  app.patch("/api/assessments/:id", async (request, response) => {
    const id = uuidSchema.parse(request.params.id);
    const body = assessmentBodySchema.partial().parse(request.body);
    const identity = getRequestIdentity(request);
    const result = await query<{ id: string; updated_at: Date }>(
      `UPDATE assessments
          SET status = COALESCE($2, status),
              current_step = COALESCE($3, current_step),
              answers = COALESCE($4, answers),
              result = COALESCE($5, result),
              user_id = COALESCE(user_id, $6),
              completed_at = CASE
                WHEN COALESCE($2, status) = 'completed' THEN COALESCE(completed_at, now())
                ELSE completed_at
              END,
              updated_at = now()
        WHERE id = $1
          AND product_channel = $8
          AND (
            ($6::uuid IS NOT NULL AND user_id = $6)
            OR (user_id IS NULL AND visitor_id = $7)
          )
        RETURNING id, updated_at`,
      [
        id,
        body.status || null,
        body.currentStep || null,
        body.answers || null,
        body.result === undefined ? null : body.result,
        request.authUser?.id || null,
        identity.visitorId,
        request.productChannel!
      ]
    );
    if (!result.rowCount) throw new ApiError(404, "ASSESSMENT_NOT_FOUND", "评估记录不存在");
    response.json(result.rows[0]);
  });

  app.post("/api/assessments/claim", requireAuth, async (request, response) => {
    const { visitorId } = getRequestIdentity(request);
    const result = await query(
      `UPDATE assessments
          SET user_id = $1, updated_at = now()
        WHERE visitor_id = $2
          AND product_channel = $3
          AND user_id IS NULL`,
      [request.authUser!.id, visitorId, request.productChannel!]
    );
    await query(
      `UPDATE visitor_sessions SET user_id = $1 WHERE visitor_id = $2 AND user_id IS NULL`,
      [request.authUser!.id, visitorId]
    );
    response.json({ claimed: result.rowCount });
  });

  app.get("/api/assessments/mine", requireAuth, async (request, response) => {
    const { page, pageSize, offset } = parsePagination(request);
    const [items, total] = await Promise.all([
      query(
        `SELECT id, status, current_step, answers, result, completed_at, created_at, updated_at
           FROM assessments
          WHERE user_id = $1
            AND product_channel = $4
          ORDER BY created_at DESC
          LIMIT $2 OFFSET $3`,
        [
          request.authUser!.id,
          pageSize,
          offset,
          request.productChannel!
        ]
      ),
      query<{ count: string }>(
        "SELECT count(*)::text AS count FROM assessments WHERE user_id = $1 AND product_channel = $2",
        [request.authUser!.id, request.productChannel!]
      )
    ]);
    response.json({
      items: items.rows,
      pagination: { page, pageSize, total: Number(total.rows[0]?.count || 0) }
    });
  });

  const eventSchema = z.object({
    name: z.string().trim().min(1).max(100),
    path: z.string().max(500).optional(),
    properties: z.record(z.string(), z.unknown()).default({}),
    occurredAt: z.string().datetime().optional()
  });

  app.post("/api/events/batch", async (request, response) => {
    const body = z
      .object({ events: z.array(eventSchema).min(1).max(50) })
      .parse(request.body);
    const identity = getRequestIdentity(request);
    await withTransaction(async (client) => {
      const first = body.events[0];
      await client.query(
        `INSERT INTO visitor_sessions
           (session_id, visitor_id, user_id, entry_path, referrer, user_agent, ip)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (session_id) DO UPDATE
           SET user_id = COALESCE(visitor_sessions.user_id, EXCLUDED.user_id),
               last_seen_at = now()`,
        [
          identity.sessionId,
          identity.visitorId,
          request.authUser?.id || null,
          first.path || null,
          request.header("referer")?.slice(0, 1000) || null,
          maskUserAgent(request),
          request.ip || null
        ]
      );
      for (const event of body.events) {
        await client.query(
          `INSERT INTO analytics_events
             (event_name, visitor_id, session_id, user_id, path, properties, user_agent, ip, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now()))`,
          [
            event.name,
            identity.visitorId,
            identity.sessionId,
            request.authUser?.id || null,
            event.path || null,
            event.properties,
            maskUserAgent(request),
            request.ip || null,
            event.occurredAt || null
          ]
        );
      }
    });
    response.status(202).json({ accepted: body.events.length });
  });

  app.post("/api/uploads", requireAuth, upload.array("files", 6), async (request, response) => {
    const files = (request.files || []) as Express.Multer.File[];
    if (!files.length) throw new ApiError(400, "FILES_REQUIRED", "请选择要上传的文件");
    const identity = getRequestIdentity(request);
    const assessmentId = request.body.assessmentId
      ? uuidSchema.parse(request.body.assessmentId)
      : null;
    try {
      for (const file of files) {
        if (!hasExpectedFileSignature(file)) {
          throw new ApiError(400, "FILE_CONTENT_MISMATCH", "文件内容与扩展类型不一致");
        }
        fs.chmodSync(file.path, 0o640);
      }
      const stored = await withTransaction(async (client) => {
        if (assessmentId) {
          const owned = await client.query(
            "SELECT 1 FROM assessments WHERE id = $1 AND user_id = $2 AND product_channel = 'ai'",
            [assessmentId, request.authUser!.id]
          );
          if (!owned.rowCount) {
            throw new ApiError(404, "ASSESSMENT_NOT_FOUND", "评估记录不存在");
          }
        }
        const saved = [];
        for (const file of files) {
          const result = await client.query<{
            id: string;
            original_name: string;
            mime_type: string;
            size_bytes: string;
            status: string;
            created_at: Date;
          }>(
            `INSERT INTO uploads
               (user_id, assessment_id, visitor_id, original_name, stored_name, mime_type, size_bytes)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, original_name, mime_type, size_bytes, status, created_at`,
            [
              request.authUser!.id,
              assessmentId,
              identity.visitorId,
              normalizeUploadFilename(file.originalname).slice(0, 240),
              file.filename,
              file.mimetype,
              file.size
            ]
          );
          saved.push(result.rows[0]);
        }
        return saved;
      });
      response.status(201).json({ files: stored });
    } catch (error) {
      removeUploadedFiles(files);
      throw error;
    }
  });

  app.get("/api/uploads/mine", requireAuth, async (request, response) => {
    const result = await query(
      `SELECT id, assessment_id, original_name, mime_type, size_bytes, status, analysis, created_at
         FROM uploads
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 100`,
      [request.authUser!.id]
    );
    response.json({ files: result.rows });
  });

  app.get("/api/uploads/:id/download", requireAuth, async (request, response) => {
    const id = uuidSchema.parse(request.params.id);
    const result = await query<{ stored_name: string; original_name: string }>(
      "SELECT stored_name, original_name FROM uploads WHERE id = $1 AND user_id = $2",
      [id, request.authUser!.id]
    );
    const file = result.rows[0];
    if (!file) throw new ApiError(404, "UPLOAD_NOT_FOUND", "文件不存在");
    response.download(path.join(uploadDir, file.stored_name), file.original_name);
  });

  app.get("/api/admin/overview", requireAdmin, async (request, response) => {
    const days = Math.min(365, Math.max(1, Number(request.query.days) || 30));
    const interval = `${days} days`;
    const productChannel = request.productChannel!;
    const includeMaterialMetrics = productChannel === "ai";
    const [summary, funnel, trend, recent] = await Promise.all([
      query<{
        visitors: string;
        sessions: string;
        completed_assessments: string;
        registered_users: string;
        uploaded_files?: string;
      }>(
        `SELECT
           (SELECT count(DISTINCT visitor_id)::text FROM analytics_events WHERE occurred_at > now() - $1::interval) AS visitors,
           (SELECT count(*)::text FROM visitor_sessions WHERE started_at > now() - $1::interval) AS sessions,
           (SELECT count(*)::text FROM assessments WHERE product_channel = $2 AND status = 'completed' AND completed_at > now() - $1::interval) AS completed_assessments,
           (SELECT count(*)::text FROM users WHERE created_at > now() - $1::interval) AS registered_users
           ${
             includeMaterialMetrics
               ? ", (SELECT count(*)::text FROM uploads WHERE created_at > now() - $1::interval) AS uploaded_files"
               : ""
           }`,
        [interval, productChannel]
      ),
      query<{ event_name: string; count: string; users: string }>(
        `SELECT event_name, count(*)::text AS count, count(DISTINCT visitor_id)::text AS users
           FROM analytics_events
          WHERE occurred_at > now() - $1::interval
            AND event_name = ANY($2)
          GROUP BY event_name`,
        [
          interval,
          [
            "page_view",
            "assessment_started",
            "assessment_completed",
            "auth_registered",
            "invite_redeemed",
            ...(includeMaterialMetrics ? ["document_uploaded"] : [])
          ]
        ]
      ),
      query<{ day: string; visitors: string; assessments: string }>(
        `WITH days AS (
           SELECT generate_series(current_date - ($1::int - 1), current_date, interval '1 day')::date AS day
         )
         SELECT d.day::text,
                count(DISTINCT e.visitor_id)::text AS visitors,
                count(DISTINCT a.id)::text AS assessments
           FROM days d
           LEFT JOIN analytics_events e ON e.occurred_at >= d.day AND e.occurred_at < d.day + interval '1 day'
           LEFT JOIN assessments a ON a.product_channel = $2
                                  AND a.completed_at >= d.day
                                  AND a.completed_at < d.day + interval '1 day'
          GROUP BY d.day
          ORDER BY d.day`,
        [days, productChannel]
      ),
      query(
        `SELECT id, status, current_step, answers->>'city' AS city,
                answers->>'terminationReason' AS termination_reason,
                created_at, completed_at
           FROM assessments
          WHERE product_channel = $1
          ORDER BY created_at DESC
          LIMIT 8`,
        [productChannel]
      )
    ]);
    response.json({
      days,
      summary: summary.rows[0],
      funnel: funnel.rows,
      trend: trend.rows,
      recentAssessments: recent.rows
    });
  });

  app.get("/api/admin/users", requireAdmin, async (request, response) => {
    const { page, pageSize, offset } = parsePagination(request);
    const search = String(request.query.search || "").trim();
    const [items, total] = await Promise.all([
      query(
        `SELECT u.id, u.email, u.phone, u.display_name, u.role, u.status,
                u.last_login_at, u.created_at,
                count(DISTINCT a.id)::int AS assessment_count,
                count(DISTINCT r.id)::int AS invite_redemption_count
           FROM users u
           LEFT JOIN assessments a ON a.user_id = u.id
                                  AND a.product_channel = $4
           LEFT JOIN invite_redemptions r ON r.user_id = u.id
          WHERE ($1 = '' OR coalesce(u.email, '') ILIKE '%' || $1 || '%'
                       OR coalesce(u.phone, '') ILIKE '%' || $1 || '%'
                       OR coalesce(u.display_name, '') ILIKE '%' || $1 || '%')
          GROUP BY u.id
          ORDER BY u.created_at DESC
          LIMIT $2 OFFSET $3`,
        [search, pageSize, offset, request.productChannel!]
      ),
      query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM users
          WHERE ($1 = '' OR coalesce(email, '') ILIKE '%' || $1 || '%'
                       OR coalesce(phone, '') ILIKE '%' || $1 || '%'
                       OR coalesce(display_name, '') ILIKE '%' || $1 || '%')`,
        [search]
      )
    ]);
    response.json({
      items: items.rows,
      pagination: { page, pageSize, total: Number(total.rows[0]?.count || 0) }
    });
  });

  app.patch("/api/admin/users/:id", requireSuperAdmin, async (request, response) => {
    const id = uuidSchema.parse(request.params.id);
    const body = z
      .object({
        status: z.enum(["active", "disabled"]).optional(),
        role: z.enum(["user", "admin", "analyst"]).optional()
      })
      .refine((value) => value.status || value.role, { message: "没有需要更新的字段" })
      .parse(request.body);
    if (id === request.authUser!.id && body.status === "disabled") {
      throw new ApiError(400, "CANNOT_DISABLE_SELF", "不能停用当前管理员账号");
    }
    const result = await query(
      `UPDATE users
          SET status = COALESCE($2, status),
              role = COALESCE($3, role),
              updated_at = now()
        WHERE id = $1
        RETURNING id, email, phone, display_name, role, status, updated_at`,
      [id, body.status || null, body.role || null]
    );
    if (!result.rowCount) throw new ApiError(404, "USER_NOT_FOUND", "用户不存在");
    await audit(request, "user.update", "user", id, body);
    response.json(result.rows[0]);
  });

  app.get("/api/admin/assessments", requireAdmin, async (request, response) => {
    const { page, pageSize, offset } = parsePagination(request);
    const status = String(request.query.status || "");
    const [items, total] = await Promise.all([
      query(
        `SELECT a.id, a.product_channel, a.status, a.current_step, a.answers, a.result,
                a.visitor_id, a.session_id, a.completed_at, a.created_at, a.updated_at,
                u.email, u.phone, u.display_name
           FROM assessments a
           LEFT JOIN users u ON u.id = a.user_id
          WHERE a.product_channel = $4
            AND ($1 = '' OR a.status = $1)
          ORDER BY a.created_at DESC
          LIMIT $2 OFFSET $3`,
        [status, pageSize, offset, request.productChannel!]
      ),
      query<{ count: string }>(
        "SELECT count(*)::text AS count FROM assessments WHERE product_channel = $2 AND ($1 = '' OR status = $1)",
        [status, request.productChannel!]
      )
    ]);
    response.json({
      items: items.rows,
      pagination: { page, pageSize, total: Number(total.rows[0]?.count || 0) }
    });
  });

  app.get("/api/admin/invites", requireAdmin, async (_request, response) => {
    const result = await query(
      `SELECT i.id, i.code, i.description, i.max_uses, i.used_count, i.grants,
              i.enabled, i.expires_at, i.created_at, i.updated_at,
              u.email AS created_by_email
         FROM invite_codes i
         LEFT JOIN users u ON u.id = i.created_by
        ORDER BY i.created_at DESC
        LIMIT 500`
    );
    response.json({
      items: result.rows.map((item) => ({
        ...item,
        grants: sanitizeGrantModules(item.grants)
      }))
    });
  });

  app.post("/api/admin/invites", requireSuperAdmin, async (request, response) => {
    const body = z
      .object({
        code: z.string().trim().min(4).max(80).optional(),
        description: z.string().trim().max(240).optional(),
        maxUses: z.coerce.number().int().positive().max(100_000).default(1),
        expiresAt: z.string().datetime().nullable().optional(),
        grants: z
          .array(z.enum(ACCESS_GRANT_MODULES))
          .min(1)
          .default([...ACCESS_GRANT_MODULES])
      })
      .parse(request.body);
    const code = (body.code || `PLM-${nanoid(5)}-${nanoid(5)}`).toUpperCase();
    const result = await query(
      `INSERT INTO invite_codes
         (code, description, max_uses, expires_at, grants, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        code,
        body.description || null,
        body.maxUses,
        body.expiresAt || null,
        JSON.stringify(body.grants),
        request.authUser!.id
      ]
    );
    await audit(request, "invite.create", "invite", result.rows[0].id, {
      code,
      maxUses: body.maxUses
    });
    response.status(201).json(result.rows[0]);
  });

  app.patch("/api/admin/invites/:id", requireSuperAdmin, async (request, response) => {
    const id = uuidSchema.parse(request.params.id);
    const body = z
      .object({
        enabled: z.boolean().optional(),
        maxUses: z.coerce.number().int().positive().max(100_000).optional(),
        expiresAt: z.string().datetime().nullable().optional(),
        description: z.string().trim().max(240).nullable().optional()
      })
      .parse(request.body);
    const result = await query(
      `UPDATE invite_codes
          SET enabled = COALESCE($2, enabled),
              max_uses = COALESCE($3, max_uses),
              expires_at = CASE WHEN $4::boolean THEN $5::timestamptz ELSE expires_at END,
              description = CASE WHEN $6::boolean THEN $7 ELSE description END,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [
        id,
        body.enabled ?? null,
        body.maxUses ?? null,
        Object.hasOwn(body, "expiresAt"),
        body.expiresAt ?? null,
        Object.hasOwn(body, "description"),
        body.description ?? null
      ]
    );
    if (!result.rowCount) throw new ApiError(404, "INVITE_NOT_FOUND", "邀请码不存在");
    await audit(request, "invite.update", "invite", id, body);
    response.json(result.rows[0]);
  });

  app.get("/api/admin/events", requireAdmin, async (request, response) => {
    const days = Math.min(365, Math.max(1, Number(request.query.days) || 30));
    const includeMaterialEvents = request.productChannel === "ai";
    const result = await query(
      `SELECT event_name,
              count(*)::int AS event_count,
              count(DISTINCT visitor_id)::int AS visitor_count,
              count(DISTINCT session_id)::int AS session_count,
              min(occurred_at) AS first_seen_at,
              max(occurred_at) AS last_seen_at
        FROM analytics_events
        WHERE occurred_at > now() - ($1 || ' days')::interval
          ${
            includeMaterialEvents
              ? ""
              : "AND event_name NOT LIKE 'document_%' AND event_name NOT LIKE 'ai_document_%'"
          }
        GROUP BY event_name
        ORDER BY event_count DESC`,
      [days]
    );
    response.json({ days, items: result.rows });
  });

  app.get("/api/admin/audit-logs", requireAdmin, async (request, response) => {
    const { pageSize, offset, page } = parsePagination(request);
    const includeMaterialAudit = request.productChannel === "ai";
    const result = await query(
      `SELECT l.id, l.action, l.target_type, l.target_id, l.detail, l.ip, l.created_at,
              u.email AS admin_email, u.display_name AS admin_name
         FROM admin_audit_logs l
         LEFT JOIN users u ON u.id = l.admin_user_id
        ${
          includeMaterialAudit
            ? ""
            : "WHERE COALESCE(l.target_type, '') NOT IN ('upload', 'uploads', 'document') AND l.action NOT LIKE 'upload.%' AND l.action NOT LIKE 'document.%' AND l.action NOT LIKE 'ai_document.%'"
        }
        ORDER BY l.created_at DESC
        LIMIT $1 OFFSET $2`,
      [pageSize, offset]
    );
    response.json({ items: result.rows, pagination: { page, pageSize } });
  });

  app.get("/api/admin/uploads", requireAdmin, async (request, response) => {
    const { page, pageSize, offset } = parsePagination(request);
    const status = String(request.query.status || "");
    const [items, total] = await Promise.all([
      query(
        `SELECT f.id, f.assessment_id, f.original_name, f.mime_type, f.size_bytes,
                f.status, f.analysis, f.created_at,
                u.email, u.phone, u.display_name,
                a.answers->>'city' AS city
           FROM uploads f
           LEFT JOIN users u ON u.id = f.user_id
           LEFT JOIN assessments a ON a.id = f.assessment_id
          WHERE ($1 = '' OR f.status = $1)
          ORDER BY f.created_at DESC
          LIMIT $2 OFFSET $3`,
        [status, pageSize, offset]
      ),
      query<{ count: string }>(
        "SELECT count(*)::text AS count FROM uploads WHERE ($1 = '' OR status = $1)",
        [status]
      )
    ]);
    response.json({
      items: items.rows,
      pagination: { page, pageSize, total: Number(total.rows[0]?.count || 0) }
    });
  });

  app.get("/api/admin/system", requireAdmin, async (request, response) => {
    const includeMaterialTables = request.productChannel === "ai";
    const [databaseSize, tableCounts, migration] = await Promise.all([
      query<{ size: string }>("SELECT pg_size_pretty(pg_database_size(current_database())) AS size"),
      query<{ name: string; count: string }>(
        `SELECT name, count
           FROM (
             SELECT 'users' AS name, count(*)::text AS count FROM users
             UNION ALL SELECT 'assessments', count(*)::text FROM assessments
             UNION ALL SELECT 'analytics_events', count(*)::text FROM analytics_events
             ${
               includeMaterialTables
                 ? "UNION ALL SELECT 'uploads', count(*)::text FROM uploads"
                 : ""
             }
             UNION ALL SELECT 'invite_codes', count(*)::text FROM invite_codes
           ) counts`
      ),
      query("SELECT version, applied_at FROM schema_migrations ORDER BY applied_at DESC")
    ]);
    response.json({
      status: "healthy",
      databaseSize: databaseSize.rows[0]?.size,
      tableCounts: tableCounts.rows,
      migrations: migration.rows,
      channels: getChannelStatus(),
      runtime: {
        node: process.version,
        uptimeSeconds: Math.round(process.uptime()),
        environment: config.NODE_ENV
      }
    });
  });

  app.get("/api/admin/uploads/:id/download", requireSuperAdmin, async (request, response) => {
    const id = uuidSchema.parse(request.params.id);
    const result = await query<{ stored_name: string; original_name: string }>(
      "SELECT stored_name, original_name FROM uploads WHERE id = $1",
      [id]
    );
    const file = result.rows[0];
    if (!file) throw new ApiError(404, "UPLOAD_NOT_FOUND", "文件不存在");
    await audit(request, "upload.download", "upload", id);
    response.download(path.join(uploadDir, file.stored_name), file.original_name);
  });

  app.use((_request, response) => {
    response.status(404).json({ error: "NOT_FOUND", message: "接口不存在" });
  });

  app.use(
    (
      error: unknown,
      request: Request,
      response: Response,
      _next: NextFunction
    ) => {
      if (error instanceof z.ZodError) {
        response.status(400).json({
          error: "VALIDATION_ERROR",
          message: error.issues[0]?.message || "请求参数错误",
          issues: error.issues
        });
        return;
      }
      if (error instanceof multer.MulterError) {
        response.status(400).json({
          error: "UPLOAD_ERROR",
          message:
            error.code === "LIMIT_FILE_SIZE"
              ? `单个文件不能超过 ${config.MAX_UPLOAD_MB}MB`
              : error.message
        });
        return;
      }
      if (error instanceof ApiError) {
        response.status(error.status).json({
          error: error.code,
          message: error.message,
          detail: error.detail
        });
        return;
      }
      const pgError = error as { code?: string; constraint?: string; message?: string };
      if (pgError.code === "23505") {
        response.status(409).json({
          error: "CONFLICT",
          message: pgError.constraint?.includes("invite")
            ? "邀请码已存在"
            : "数据已存在"
        });
        return;
      }
      request.log?.error(error);
      response.status(500).json({
        error: "INTERNAL_ERROR",
        message: "服务暂时开小差了"
      });
    }
  );

  return app;
};
