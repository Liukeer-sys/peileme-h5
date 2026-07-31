import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { getConfig, resetConfigForTests } from "../config.js";

const withEnvironment = async (
  values: Record<string, string | undefined>,
  callback: () => void | Promise<void>
) => {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetConfigForTests();
  try {
    await callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetConfigForTests();
  }
};

const productionFoundation = {
  NODE_ENV: "production",
  APP_ORIGIN: "https://peileme.art,https://ai.peileme.art",
  MAIN_PRODUCT_HOSTS: "peileme.art,www.peileme.art",
  AI_PRODUCT_HOSTS: "ai.peileme.art",
  MAIN_APP_ORIGIN: "https://peileme.art",
  AI_APP_ORIGIN: "https://ai.peileme.art",
  JWT_SECRET: "production-jwt-secret-that-is-at-least-thirty-two-characters",
  OTP_SECRET: "production-otp-secret-that-is-at-least-thirty-two-characters",
  CSRF_SECRET: "production-csrf-secret-that-is-at-least-thirty-two-characters"
} as const;

describe("Task 4 payment configuration and registry contract (RED)", () => {
  it.each(["test", "production"])(
    "rejects PAYMENT_MODE=fake in %s",
    async (environment) => {
      await withEnvironment(
        {
          ...(environment === "production" ? productionFoundation : {}),
          NODE_ENV: environment,
          PAYMENT_MODE: "fake"
        },
        () => {
          expect(() => getConfig()).toThrow(
            /(?:PAYMENT_MODE=fake.*forbidden|fake payment providers are forbidden)/i
          );
        }
      );
    }
  );

  it("fails fast when a live WeChat provider has no credentials", async () => {
    await withEnvironment(
      {
        PAYMENT_MODE: "live",
        PAYMENT_PROVIDERS: "wechat_h5",
        PAYMENT_NOTIFY_ORIGIN: "https://peileme.art",
        WECHAT_PAY_APP_ID: undefined,
        WECHAT_PAY_MCH_ID: undefined,
        WECHAT_PAY_MERCHANT_SERIAL_NO: undefined,
        WECHAT_PAY_PRIVATE_KEY_FILE: undefined,
        WECHAT_PAY_API_V3_KEY_FILE: undefined,
        WECHAT_PAY_PUBLIC_KEYS_FILE: undefined
      },
      () => {
        expect(() => getConfig()).toThrow(/WECHAT_PAY_APP_ID/);
      }
    );
  });

  it("requires a canonical HTTPS notification origin in live mode", async () => {
    const secretDirectory = await mkdtemp(
      path.join(tmpdir(), "peileme-payment-config-")
    );
    const privateKeyFile = path.join(secretDirectory, "alipay-private.pem");
    const publicKeyFile = path.join(secretDirectory, "alipay-public.pem");

    try {
      await Promise.all([
        writeFile(privateKeyFile, "readable-private-key-placeholder\n", "utf8"),
        writeFile(publicKeyFile, "readable-public-key-placeholder\n", "utf8")
      ]);

      await withEnvironment(
        {
          ...productionFoundation,
          PAYMENT_MODE: "live",
          PAYMENT_PROVIDERS: "alipay_wap",
          PAYMENT_NOTIFY_ORIGIN: "http://peileme.art",
          ALIPAY_APP_ID: "2026000000000000",
          ALIPAY_SELLER_ID: "2088000000000000",
          ALIPAY_PRIVATE_KEY_FILE: privateKeyFile,
          ALIPAY_PUBLIC_KEY_FILE: publicKeyFile
        },
        () => {
          expect(() => getConfig()).toThrow(
            /PAYMENT_NOTIFY_ORIGIN.*HTTPS/i
          );
        }
      );
    } finally {
      await rm(secretDirectory, { recursive: true, force: true });
    }
  });

  it("publishes only configured real providers from the registry", async () => {
    const moduleUrl = pathToFileURL(
      path.resolve("server/modules/payments/registry.ts")
    ).href;
    const registryModule = await import(
      /* @vite-ignore */ moduleUrl
    );
    const wechat = { channel: "wechat_h5" as const };
    const alipay = { channel: "alipay_wap" as const };
    const registry = registryModule.createPaymentProviderRegistry(
      {
        PAYMENT_MODE: "live",
        PAYMENT_PROVIDERS: ["wechat_h5"]
      },
      {
        wechatFactory: () => wechat,
        alipayFactory: () => alipay
      }
    );

    expect(registry.listAvailable()).toEqual([
      { channel: "wechat_h5", label: "微信支付" }
    ]);
    expect(registry.require("wechat_h5")).toBe(wechat);
    expect(() => registry.require("alipay_wap")).toThrow(
      "PAYMENT_PROVIDER_UNAVAILABLE"
    );
  });
});
