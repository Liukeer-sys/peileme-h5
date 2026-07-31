import "dotenv/config";
import { z } from "zod";
import {
  createProductHostResolver,
  normalizeProductHost,
  parseProductHostAllowlist
} from "./product-host.js";

const booleanValue = z
  .string()
  .optional()
  .transform((value) => value === "true" || value === "1");

const productHostList = (name: string, defaultValue: string) =>
  z
    .string()
    .default(defaultValue)
    .transform((value) => parseProductHostAllowlist(value, name));

const parseHttpOrigin = (value: string, name: string) => {
  if (value !== value.trim()) {
    throw new Error(
      `${name} must contain canonical http/https origins`
    );
  }
  const parsed = new URL(value);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== value
  ) {
    throw new Error(
      `${name} must contain canonical http/https origins`
    );
  }
  return parsed.origin;
};

const canonicalAppOrigin = (name: string, defaultValue: string) =>
  z
    .string()
    .default(defaultValue)
    .transform((value, context) => {
      try {
        return parseHttpOrigin(value, name);
      } catch {
        context.addIssue({
          code: "custom",
          message: `${name} must be a single canonical http/https origin`
        });
        return z.NEVER;
      }
    });

const corsOriginList = z
  .string()
  .default("http://localhost:5173,http://ai.localhost:5174")
  .transform((value, context) => {
    try {
      const entries = value.split(",");
      if (!entries.length || entries.some((entry) => !entry.trim())) {
        throw new Error("APP_ORIGIN contains an empty origin");
      }
      const origins = entries.map((entry) =>
        parseHttpOrigin(entry.trim(), "APP_ORIGIN")
      );
      if (new Set(origins).size !== origins.length) {
        throw new Error("APP_ORIGIN contains a duplicate origin");
      }
      return origins.join(",");
    } catch (error) {
      context.addIssue({
        code: "custom",
        message:
          error instanceof Error
            ? error.message
            : "APP_ORIGIN is invalid"
      });
      return z.NEVER;
    }
  });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PAYMENT_MODE: z.enum(["disabled", "fake"]).default("disabled"),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1).default("postgresql://peileme:peileme@127.0.0.1:5432/peileme"),
  APP_ORIGIN: corsOriginList,
  MAIN_PRODUCT_HOSTS: productHostList(
    "MAIN_PRODUCT_HOSTS",
    "peileme.art,www.peileme.art,localhost,127.0.0.1,[::1]"
  ),
  AI_PRODUCT_HOSTS: productHostList(
    "AI_PRODUCT_HOSTS",
    "ai.peileme.art,ai.localhost"
  ),
  MAIN_APP_ORIGIN: canonicalAppOrigin(
    "MAIN_APP_ORIGIN",
    "http://localhost:5173"
  ),
  AI_APP_ORIGIN: canonicalAppOrigin(
    "AI_APP_ORIGIN",
    "http://ai.localhost:5174"
  ),
  COOKIE_DOMAIN: z.string().optional(),
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
  JWT_SECRET: z.string().min(32).default("development-only-jwt-secret-change-me"),
  OTP_SECRET: z.string().min(32).default("development-only-otp-secret-change-me"),
  CSRF_SECRET: z.string().min(32).default("development-only-csrf-secret-change-me"),
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  OTP_TTL_MINUTES: z.coerce.number().int().positive().max(30).default(10),
  OTP_DEBUG: booleanValue,
  REGISTRATION_REQUIRE_INVITE: booleanValue,
  UPLOAD_DIR: z.string().default("./data/uploads"),
  MAX_UPLOAD_MB: z.coerce.number().positive().max(50).default(10),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_SECURE: booleanValue,
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  ALIYUN_DM_ACCESS_KEY_ID: z.string().optional(),
  ALIYUN_DM_ACCESS_KEY_SECRET: z.string().optional(),
  ALIYUN_DM_ACCOUNT_NAME: z.string().optional(),
  ALIYUN_SMS_ACCESS_KEY_ID: z.string().optional(),
  ALIYUN_SMS_ACCESS_KEY_SECRET: z.string().optional(),
  ALIYUN_SMS_SIGN_NAME: z.string().optional(),
  ALIYUN_SMS_TEMPLATE_CODE: z.string().optional()
});

export type AppConfig = z.infer<typeof envSchema>;

let cachedConfig: AppConfig | undefined;

export const getConfig = () => {
  if (!cachedConfig) {
    if (process.env.NODE_ENV === "production") {
      for (const name of [
        "MAIN_PRODUCT_HOSTS",
        "AI_PRODUCT_HOSTS",
        "MAIN_APP_ORIGIN",
        "AI_APP_ORIGIN"
      ] as const) {
        if (!process.env[name]?.trim()) {
          throw new Error(`${name} must be configured in production`);
        }
      }
    }
    const parsedConfig = envSchema.parse(process.env);
    const resolveProductHost = createProductHostResolver(
      parsedConfig.MAIN_PRODUCT_HOSTS,
      parsedConfig.AI_PRODUCT_HOSTS
    );
    for (const [name, origin, expectedChannel] of [
      ["MAIN_APP_ORIGIN", parsedConfig.MAIN_APP_ORIGIN, "main"],
      ["AI_APP_ORIGIN", parsedConfig.AI_APP_ORIGIN, "ai"]
    ] as const) {
      const hostname = normalizeProductHost(new URL(origin).hostname);
      if (!hostname || resolveProductHost(hostname) !== expectedChannel) {
        throw new Error(
          `${name} hostname must belong to ${expectedChannel} product hosts`
        );
      }
    }
    const allowedOrigins = new Set(parsedConfig.APP_ORIGIN.split(","));
    for (const [name, origin] of [
      ["MAIN_APP_ORIGIN", parsedConfig.MAIN_APP_ORIGIN],
      ["AI_APP_ORIGIN", parsedConfig.AI_APP_ORIGIN]
    ] as const) {
      if (!allowedOrigins.has(origin)) {
        throw new Error(`${name} must also be included in APP_ORIGIN`);
      }
    }
    if (parsedConfig.NODE_ENV === "production") {
      if (parsedConfig.PAYMENT_MODE === "fake") {
        throw new Error("PAYMENT_MODE=fake is forbidden in production");
      }
      if (parsedConfig.JWT_SECRET.startsWith("development-only")) {
        throw new Error("JWT_SECRET must be configured in production");
      }
      if (parsedConfig.OTP_SECRET.startsWith("development-only")) {
        throw new Error("OTP_SECRET must be configured in production");
      }
      if (parsedConfig.CSRF_SECRET.startsWith("development-only")) {
        throw new Error("CSRF_SECRET must be configured in production");
      }
    }
    cachedConfig = parsedConfig;
  }
  return cachedConfig;
};

export const resetConfigForTests = () => {
  cachedConfig = undefined;
};
