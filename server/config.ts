import { z } from "zod";

const booleanValue = z
  .string()
  .optional()
  .transform((value) => value === "true" || value === "1");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1).default("postgresql://peileme:peileme@127.0.0.1:5432/peileme"),
  APP_ORIGIN: z.string().default("http://localhost:5173"),
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
    cachedConfig = envSchema.parse(process.env);
    if (cachedConfig.NODE_ENV === "production") {
      if (cachedConfig.JWT_SECRET.startsWith("development-only")) {
        throw new Error("JWT_SECRET must be configured in production");
      }
      if (cachedConfig.OTP_SECRET.startsWith("development-only")) {
        throw new Error("OTP_SECRET must be configured in production");
      }
      if (cachedConfig.CSRF_SECRET.startsWith("development-only")) {
        throw new Error("CSRF_SECRET must be configured in production");
      }
    }
  }
  return cachedConfig;
};

export const resetConfigForTests = () => {
  cachedConfig = undefined;
};
