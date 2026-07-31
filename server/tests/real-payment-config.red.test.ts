import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { getConfig, resetConfigForTests } from "../config.js";

const paymentEnvironmentNames = [
  "PAYMENT_MODE",
  "PAYMENT_PROVIDERS",
  "PAYMENT_NOTIFY_ORIGIN",
  "WECHAT_PAY_APP_ID",
  "WECHAT_PAY_MCH_ID",
  "WECHAT_PAY_MERCHANT_SERIAL_NO",
  "WECHAT_PAY_PRIVATE_KEY_FILE",
  "WECHAT_PAY_PRIVATE_KEY_SECRET_REF",
  "WECHAT_PAY_API_V3_KEY_FILE",
  "WECHAT_PAY_API_V3_KEY_SECRET_REF",
  "WECHAT_PAY_PUBLIC_KEYS_FILE",
  "WECHAT_PAY_PUBLIC_KEYS_SECRET_REF",
  "ALIPAY_APP_ID",
  "ALIPAY_SELLER_ID",
  "ALIPAY_PRIVATE_KEY_FILE",
  "ALIPAY_PRIVATE_KEY_SECRET_REF",
  "ALIPAY_PUBLIC_KEY_FILE",
  "ALIPAY_PUBLIC_KEY_SECRET_REF"
] as const;

const withEnvironment = async (
  values: Record<string, string | undefined>,
  callback: () => void | Promise<void>
) => {
  const previous = new Map<string, string | undefined>();
  const names = new Set<string>([
    ...paymentEnvironmentNames,
    ...Object.keys(values)
  ]);
  for (const name of names) {
    const value = values[name];
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

const createReadOnlySecretFile = async (
  directory: string,
  filename: string,
  value: string
) => {
  const file = path.join(directory, filename);
  await writeFile(file, value, { encoding: "utf8", mode: 0o400 });
  await chmod(file, 0o400);
  return file;
};

const validWechatEnvironment = async (directory: string) => ({
  PAYMENT_MODE: "live",
  PAYMENT_PROVIDERS: "wechat_h5",
  PAYMENT_NOTIFY_ORIGIN: "https://peileme.art",
  WECHAT_PAY_APP_ID: "wx-production-app-id",
  WECHAT_PAY_MCH_ID: "1900000001",
  WECHAT_PAY_MERCHANT_SERIAL_NO: "MERCHANT-SERIAL-001",
  WECHAT_PAY_PRIVATE_KEY_FILE: await createReadOnlySecretFile(
    directory,
    "wechat-private.pem",
    "readable-private-key-placeholder\n"
  ),
  WECHAT_PAY_API_V3_KEY_FILE: await createReadOnlySecretFile(
    directory,
    "wechat-api-v3-key",
    "12345678901234567890123456789012\n"
  ),
  WECHAT_PAY_PUBLIC_KEYS_FILE: await createReadOnlySecretFile(
    directory,
    "wechat-public-keys.json",
    '{"PUBLIC-SERIAL":"public-key-placeholder"}\n'
  )
});

const completeProvider = (channel: "wechat_h5" | "alipay_wap") => ({
  channel,
  async createPayment() {
    throw new Error("not invoked");
  },
  async queryPayment() {
    throw new Error("not invoked");
  },
  async closePayment() {
    throw new Error("not invoked");
  },
  async refundPayment() {
    throw new Error("not invoked");
  },
  async refund() {
    throw new Error("not invoked");
  }
});

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

  it("fails fast when live mode has no provider", async () => {
    await withEnvironment(
      {
        PAYMENT_MODE: "live",
        PAYMENT_PROVIDERS: "",
        PAYMENT_NOTIFY_ORIGIN: "https://peileme.art"
      },
      () => {
        expect(() => getConfig()).toThrow(
          /PAYMENT_PROVIDERS.*(?:at least one|wechat_h5|alipay_wap)/i
        );
      }
    );
  });

  it("fails fast when an enabled provider secret file is missing", async () => {
    const secretDirectory = await mkdtemp(
      path.join(tmpdir(), "peileme-payment-config-")
    );
    try {
      const environment = await validWechatEnvironment(secretDirectory);
      environment.WECHAT_PAY_PRIVATE_KEY_FILE = path.join(
        secretDirectory,
        "missing-private-key.pem"
      );
      await withEnvironment(environment, () => {
        expect(() => getConfig()).toThrow(
          /WECHAT_PAY_PRIVATE_KEY.*(?:missing|read|regular file)/i
        );
      });
    } finally {
      await rm(secretDirectory, { recursive: true, force: true });
    }
  });

  it.each([
    { mode: 0o000, description: "unreadable" },
    { mode: 0o600, description: "writable" }
  ])(
    "rejects a $description payment secret file",
    async ({ mode }) => {
      const secretDirectory = await mkdtemp(
        path.join(tmpdir(), "peileme-payment-config-")
      );
      try {
        const environment = await validWechatEnvironment(secretDirectory);
        await chmod(environment.WECHAT_PAY_PRIVATE_KEY_FILE, mode);
        await withEnvironment(environment, () => {
          expect(() => getConfig()).toThrow(
            /WECHAT_PAY_PRIVATE_KEY.*(?:readable|read-only|permission)/i
          );
        });
      } finally {
        await rm(secretDirectory, { recursive: true, force: true });
      }
    }
  );

  it("requires an exact 32-byte WeChat APIv3 key", async () => {
    const secretDirectory = await mkdtemp(
      path.join(tmpdir(), "peileme-payment-config-")
    );
    try {
      const environment = await validWechatEnvironment(secretDirectory);
      await chmod(environment.WECHAT_PAY_API_V3_KEY_FILE, 0o600);
      await writeFile(
        environment.WECHAT_PAY_API_V3_KEY_FILE,
        "1234567890123456789012345678901\n",
        "utf8"
      );
      await chmod(environment.WECHAT_PAY_API_V3_KEY_FILE, 0o400);
      await withEnvironment(environment, () => {
        expect(() => getConfig()).toThrow(
          /WECHAT_PAY_API_V3_KEY.*32 bytes/i
        );
      });
    } finally {
      await rm(secretDirectory, { recursive: true, force: true });
    }
  });

  it("requires a canonical printable ASCII WeChat APIv3 key", async () => {
    const secretDirectory = await mkdtemp(
      path.join(tmpdir(), "peileme-payment-config-")
    );
    try {
      const environment = await validWechatEnvironment(secretDirectory);
      await chmod(environment.WECHAT_PAY_API_V3_KEY_FILE, 0o600);
      await writeFile(
        environment.WECHAT_PAY_API_V3_KEY_FILE,
        `${"é".repeat(16)}\n`,
        "utf8"
      );
      await chmod(environment.WECHAT_PAY_API_V3_KEY_FILE, 0o400);
      await withEnvironment(environment, () => {
        expect(() => getConfig()).toThrow(
          /WECHAT_PAY_API_V3_KEY.*(?:ASCII|32 bytes)/i
        );
      });
    } finally {
      await rm(secretDirectory, { recursive: true, force: true });
    }
  });

  it("deep-freezes cached payment configuration", async () => {
    const secretDirectory = await mkdtemp(
      path.join(tmpdir(), "peileme-payment-config-")
    );
    try {
      const environment = await validWechatEnvironment(secretDirectory);
      await withEnvironment(environment, () => {
        const config = getConfig();
        expect(Object.isFrozen(config)).toBe(true);
        expect(Object.isFrozen(config.PAYMENT_PROVIDERS)).toBe(true);
        expect(() =>
          (config.PAYMENT_PROVIDERS as string[]).push("alipay_wap")
        ).toThrow(TypeError);
        expect(getConfig().PAYMENT_PROVIDERS).toEqual(["wechat_h5"]);
      });
    } finally {
      await rm(secretDirectory, { recursive: true, force: true });
    }
  });

  it("rejects merchant identifiers with surrounding whitespace", async () => {
    const secretDirectory = await mkdtemp(
      path.join(tmpdir(), "peileme-payment-config-")
    );
    try {
      const environment = await validWechatEnvironment(secretDirectory);
      environment.WECHAT_PAY_APP_ID = " wx-production-app-id";
      await withEnvironment(environment, () => {
        expect(() => getConfig()).toThrow(
          /WECHAT_PAY_APP_ID.*(?:canonical|whitespace)/i
        );
      });
    } finally {
      await rm(secretDirectory, { recursive: true, force: true });
    }
  });

  it("accepts named env secret references without returning secret values", async () => {
    const secretDirectory = await mkdtemp(
      path.join(tmpdir(), "peileme-payment-config-")
    );
    const secretName = "PEILEME_TEST_WECHAT_API_V3_KEY";
    const secretValue = "12345678901234567890123456789012";
    try {
      const environment = await validWechatEnvironment(secretDirectory);
      const previous = process.env[secretName];
      process.env[secretName] = secretValue;
      try {
        await withEnvironment(
          {
            ...environment,
            WECHAT_PAY_API_V3_KEY_FILE: undefined,
            WECHAT_PAY_API_V3_KEY_SECRET_REF: `env:${secretName}`
          },
          () => {
            const config = getConfig();
            expect(config.WECHAT_PAY_API_V3_KEY_SECRET_REF).toBe(
              `env:${secretName}`
            );
            expect(JSON.stringify(config)).not.toContain(secretValue);
          }
        );
      } finally {
        if (previous === undefined) delete process.env[secretName];
        else process.env[secretName] = previous;
      }
    } finally {
      await rm(secretDirectory, { recursive: true, force: true });
    }
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
    const wechat = completeProvider("wechat_h5");
    const alipay = completeProvider("alipay_wap");
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
    expect(JSON.stringify(registry)).not.toMatch(
      /private|secret|credential|api.?v3/i
    );
  });

  it("fails registry construction when a configured provider has no factory", async () => {
    const moduleUrl = pathToFileURL(
      path.resolve("server/modules/payments/registry.ts")
    ).href;
    const registryModule = await import(/* @vite-ignore */ moduleUrl);

    expect(() =>
      registryModule.createPaymentProviderRegistry(
        {
          PAYMENT_MODE: "live",
          PAYMENT_PROVIDERS: ["wechat_h5"]
        },
        {}
      )
    ).toThrow(/wechat_h5.*(?:factory|configured|available)/i);
  });

  it("preflights every configured factory before invoking any factory", async () => {
    const moduleUrl = pathToFileURL(
      path.resolve("server/modules/payments/registry.ts")
    ).href;
    const registryModule = await import(/* @vite-ignore */ moduleUrl);
    let wechatFactoryCalls = 0;

    expect(() =>
      registryModule.createPaymentProviderRegistry(
        {
          PAYMENT_MODE: "live",
          PAYMENT_PROVIDERS: ["wechat_h5", "alipay_wap"]
        },
        {
          wechatFactory: () => {
            wechatFactoryCalls += 1;
            return completeProvider("wechat_h5");
          }
        }
      )
    ).toThrow(/alipay_wap.*factory/i);
    expect(wechatFactoryCalls).toBe(0);
  });

  it("rejects provider instances with an incomplete runtime contract", async () => {
    const moduleUrl = pathToFileURL(
      path.resolve("server/modules/payments/registry.ts")
    ).href;
    const registryModule = await import(/* @vite-ignore */ moduleUrl);

    expect(() =>
      registryModule.createPaymentProviderRegistry(
        {
          PAYMENT_MODE: "live",
          PAYMENT_PROVIDERS: ["wechat_h5"]
        },
        {
          wechatFactory: () => ({ channel: "wechat_h5" })
        }
      )
    ).toThrow(/wechat_h5.*(?:contract|method|provider)/i);
  });

  it("does not perform network I/O while validating or constructing providers", async () => {
    const secretDirectory = await mkdtemp(
      path.join(tmpdir(), "peileme-payment-config-")
    );
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error("network is forbidden during payment construction");
    }) as typeof fetch;
    try {
      const environment = await validWechatEnvironment(secretDirectory);
      await withEnvironment(environment, async () => {
        const config = getConfig();
        const registryModule = await import(
          /* @vite-ignore */ pathToFileURL(
            path.resolve("server/modules/payments/registry.ts")
          ).href
        );
        const provider = completeProvider("wechat_h5");
        const registry = registryModule.createPaymentProviderRegistry(config, {
          wechatFactory: () => provider
        });
        expect(registry.require("wechat_h5")).toBe(provider);
      });
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(secretDirectory, { recursive: true, force: true });
    }
  });
});
