import "dotenv/config";
import { z } from "zod";
import {
  createProductHostResolver,
  normalizeProductHost,
  parseProductHostAllowlist
} from "./product-host.js";
import { loadPaymentSecret } from "./modules/payments/secret-loader.js";
import {
  isRealPaymentChannel,
  type RealPaymentChannel
} from "./modules/payments/provider.js";

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

const paymentProviderList = z
  .string()
  .default("")
  .transform((value, context): RealPaymentChannel[] => {
    if (!value.trim()) return [];
    const providers = value.split(",").map((entry) => entry.trim());
    if (
      providers.some((entry) => !isRealPaymentChannel(entry)) ||
      new Set(providers).size !== providers.length
    ) {
      context.addIssue({
        code: "custom",
        message:
          "PAYMENT_PROVIDERS must contain unique wechat_h5/alipay_wap entries"
      });
      return z.NEVER;
    }
    return providers as RealPaymentChannel[];
  });

const llmBaseUrl = z
  .string()
  .url()
  .transform((value, context) => {
    const parsed = new URL(value);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      context.addIssue({
        code: "custom",
        message: "LLM base URL must be a canonical HTTP(S) URL"
      });
      return z.NEVER;
    }
    return value.replace(/\/+$/, "");
  });

const llmApiKey = z
  .string()
  .default("")
  .refine((value) => value === value.trim(), {
    message: "LLM API keys must not contain surrounding whitespace"
  });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PAYMENT_MODE: z.enum(["disabled", "live", "fake"]).default("disabled"),
  PAYMENT_PROVIDERS: paymentProviderList,
  PAYMENT_NOTIFY_ORIGIN: z.string().optional(),
  WECHAT_PAY_APP_ID: z.string().optional(),
  WECHAT_PAY_MCH_ID: z.string().optional(),
  WECHAT_PAY_MERCHANT_SERIAL_NO: z.string().optional(),
  WECHAT_PAY_PRIVATE_KEY_FILE: z.string().optional(),
  WECHAT_PAY_PRIVATE_KEY_SECRET_REF: z.string().optional(),
  WECHAT_PAY_API_V3_KEY_FILE: z.string().optional(),
  WECHAT_PAY_API_V3_KEY_SECRET_REF: z.string().optional(),
  WECHAT_PAY_PUBLIC_KEYS_FILE: z.string().optional(),
  WECHAT_PAY_PUBLIC_KEYS_SECRET_REF: z.string().optional(),
  ALIPAY_APP_ID: z.string().optional(),
  ALIPAY_SELLER_ID: z.string().optional(),
  ALIPAY_PRIVATE_KEY_FILE: z.string().optional(),
  ALIPAY_PRIVATE_KEY_SECRET_REF: z.string().optional(),
  ALIPAY_PUBLIC_KEY_FILE: z.string().optional(),
  ALIPAY_PUBLIC_KEY_SECRET_REF: z.string().optional(),
  LLM_PRIMARY: z.enum(["tuzi", "dataeyes"]).default("tuzi"),
  LLM_TUZI_BASE_URL: llmBaseUrl.default("https://api.tu-zi.com"),
  LLM_TUZI_API_KEY: llmApiKey,
  LLM_TUZI_MODEL: z.string().trim().min(1).max(160).default("gpt-5.4"),
  LLM_DATAEYES_BASE_URL: llmBaseUrl.default("https://cloud.dataeyes.ai"),
  LLM_DATAEYES_API_KEY: llmApiKey,
  LLM_DATAEYES_MODEL: z.string().trim().min(1).max(160).default("gemini-2.5-pro"),
  LLM_MAX_RETRIES: z.coerce.number().int().min(1).max(5).default(3),
  LLM_RETRY_BACKOFF_MS: z.coerce.number().int().min(0).max(10_000).default(800),
  LLM_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(240_000).default(90_000),
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

const requirePaymentValue = (
  config: AppConfig,
  name:
    | "WECHAT_PAY_APP_ID"
    | "WECHAT_PAY_MCH_ID"
    | "WECHAT_PAY_MERCHANT_SERIAL_NO"
    | "ALIPAY_APP_ID"
    | "ALIPAY_SELLER_ID"
) => {
  const rawValue = config[name];
  const value = rawValue?.trim();
  if (!value) throw new Error(`${name} must be configured in live mode`);
  if (value !== rawValue) {
    throw new Error(`${name} must not contain surrounding whitespace`);
  }
  return value;
};

const deepFreezeConfig = <Value>(value: Value): Value => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) {
      deepFreezeConfig(descriptor.value);
    }
  }
  return Object.freeze(value);
};

const validatePaymentSecret = (
  config: AppConfig,
  name: string,
  file: string | undefined,
  secretRef: string | undefined
) =>
  loadPaymentSecret({
    name,
    file,
    secretRef
  });

const validateLivePaymentConfig = (config: AppConfig) => {
  if (!config.PAYMENT_PROVIDERS.length) {
    throw new Error(
      "PAYMENT_PROVIDERS must configure at least one of wechat_h5/alipay_wap"
    );
  }
  let notificationOrigin: string;
  try {
    notificationOrigin = parseHttpOrigin(
      config.PAYMENT_NOTIFY_ORIGIN ?? "",
      "PAYMENT_NOTIFY_ORIGIN"
    );
  } catch {
    throw new Error(
      "PAYMENT_NOTIFY_ORIGIN must be a single canonical HTTPS origin in live mode"
    );
  }
  if (!notificationOrigin.startsWith("https://")) {
    throw new Error(
      "PAYMENT_NOTIFY_ORIGIN must be a single canonical HTTPS origin in live mode"
    );
  }

  for (const channel of config.PAYMENT_PROVIDERS) {
    if (channel === "wechat_h5") {
      requirePaymentValue(config, "WECHAT_PAY_APP_ID");
      requirePaymentValue(config, "WECHAT_PAY_MCH_ID");
      requirePaymentValue(config, "WECHAT_PAY_MERCHANT_SERIAL_NO");
      validatePaymentSecret(
        config,
        "WECHAT_PAY_PRIVATE_KEY",
        config.WECHAT_PAY_PRIVATE_KEY_FILE,
        config.WECHAT_PAY_PRIVATE_KEY_SECRET_REF
      );
      const apiV3Key = validatePaymentSecret(
        config,
        "WECHAT_PAY_API_V3_KEY",
        config.WECHAT_PAY_API_V3_KEY_FILE,
        config.WECHAT_PAY_API_V3_KEY_SECRET_REF
      );
      if (!/^[\x21-\x7e]{32}$/.test(apiV3Key)) {
        throw new Error(
          "WECHAT_PAY_API_V3_KEY must contain exactly 32 bytes of printable ASCII"
        );
      }
      validatePaymentSecret(
        config,
        "WECHAT_PAY_PUBLIC_KEYS",
        config.WECHAT_PAY_PUBLIC_KEYS_FILE,
        config.WECHAT_PAY_PUBLIC_KEYS_SECRET_REF
      );
    } else {
      requirePaymentValue(config, "ALIPAY_APP_ID");
      requirePaymentValue(config, "ALIPAY_SELLER_ID");
      validatePaymentSecret(
        config,
        "ALIPAY_PRIVATE_KEY",
        config.ALIPAY_PRIVATE_KEY_FILE,
        config.ALIPAY_PRIVATE_KEY_SECRET_REF
      );
      validatePaymentSecret(
        config,
        "ALIPAY_PUBLIC_KEY",
        config.ALIPAY_PUBLIC_KEY_FILE,
        config.ALIPAY_PUBLIC_KEY_SECRET_REF
      );
    }
  }
};

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
    if (parsedConfig.PAYMENT_MODE === "fake") {
      throw new Error(
        `PAYMENT_MODE=fake is forbidden in ${parsedConfig.NODE_ENV}`
      );
    }
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
    if (parsedConfig.PAYMENT_MODE === "live") {
      validateLivePaymentConfig(parsedConfig);
    }
    cachedConfig = deepFreezeConfig(parsedConfig);
  }
  return cachedConfig;
};

export const resetConfigForTests = () => {
  cachedConfig = undefined;
};
