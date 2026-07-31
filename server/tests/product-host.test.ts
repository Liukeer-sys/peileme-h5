import { afterEach, describe, expect, it } from "vitest";
import { getConfig, resetConfigForTests } from "../config";
import {
  createProductHostResolver,
  normalizeProductHost,
  parseProductHostAllowlist
} from "../product-host";

describe("product host normalization and configuration", () => {
  it.each([
    ["PEILEME.ART", "peileme.art"],
    ["peileme.art:443", "peileme.art"],
    ["AI.PEILEME.ART.:8443", "ai.peileme.art"],
    ["127.0.0.1:3001", "127.0.0.1"],
    ["[::1]:3001", "::1"],
    ["[0:0:0:0:0:0:0:1]:3001", "::1"]
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeProductHost(input)).toBe(expected);
  });

  it.each([
    "",
    " peileme.art",
    "peileme.art ",
    "https://peileme.art",
    "peileme.art/path",
    "user@peileme.art",
    "peileme.art,ai.peileme.art",
    "peileme..art",
    "peileme.art:99999",
    "::1",
    "127.0.0.1.",
    "127.0.0.1.:80"
  ])("rejects invalid raw Host %s", (input) => {
    expect(normalizeProductHost(input)).toBeNull();
  });

  it.each([
    "2130706433",
    "0177.0.0.1",
    "0x7f000001",
    "127.1"
  ])("rejects alternate numeric authority %s", (input) => {
    expect(normalizeProductHost(input)).toBeNull();
  });

  it("rejects every embedded HTTP control character", () => {
    for (const control of ["\r", "\n", "\t", "\0", "\u007f"]) {
      expect(normalizeProductHost(`peileme.art${control}.evil`)).toBeNull();
      expect(normalizeProductHost(`peileme.art${control}:443`)).toBeNull();
    }
  });

  it("rejects empty, protocol-bearing and normalized duplicate allowlist entries", () => {
    expect(() =>
      parseProductHostAllowlist("peileme.art,,localhost", "MAIN_PRODUCT_HOSTS")
    ).toThrow(/empty/i);
    expect(() =>
      parseProductHostAllowlist(
        "https://peileme.art",
        "MAIN_PRODUCT_HOSTS"
      )
    ).toThrow(/invalid/i);
    expect(() =>
      parseProductHostAllowlist(
        "peileme.art,PEILEME.ART.:443",
        "MAIN_PRODUCT_HOSTS"
      )
    ).toThrow(/duplicate/i);
    expect(() =>
      parseProductHostAllowlist(
        "[::1],[0:0:0:0:0:0:0:1]",
        "MAIN_PRODUCT_HOSTS"
      )
    ).toThrow(/duplicate/i);
  });

  it("rejects cross-list overlap after normalization", () => {
    expect(() =>
      createProductHostResolver(
        ["peileme.art", "localhost"],
        ["ai.peileme.art", "localhost"]
      )
    ).toThrow(/both/i);
    expect(() =>
      createProductHostResolver(
        ["::1"],
        ["0:0:0:0:0:0:0:1"]
      )
    ).toThrow(/both/i);
  });

  it("derives a channel only from configured normalized Host values", () => {
    const resolve = createProductHostResolver(
      ["peileme.art", "www.peileme.art"],
      ["ai.peileme.art"]
    );

    expect(resolve("PEILEME.ART.:443")).toBe("main");
    expect(resolve("ai.peileme.art:443")).toBe("ai");
    expect(resolve("unknown.example")).toBeNull();
    expect(resolve("peileme.art,ai.peileme.art")).toBeNull();
  });

  it("resolves equivalent bracketed IPv6 authorities identically", () => {
    const resolve = createProductHostResolver(["::1"], ["2001:db8::1"]);

    expect(resolve("[::1]:3001")).toBe("main");
    expect(resolve("[0:0:0:0:0:0:0:1]:3001")).toBe("main");
  });
});

describe("product host production configuration", () => {
  const originalEnvironment = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnvironment)) delete process.env[key];
    }
    Object.assign(process.env, originalEnvironment);
    resetConfigForTests();
  });

  it.each([
    "MAIN_PRODUCT_HOSTS",
    "AI_PRODUCT_HOSTS",
    "MAIN_APP_ORIGIN",
    "AI_APP_ORIGIN"
  ])("requires an explicit non-empty production %s", (name) => {
    process.env.NODE_ENV = "production";
    process.env.PAYMENT_MODE = "disabled";
    process.env.JWT_SECRET =
      "production-jwt-secret-that-is-longer-than-thirty-two-characters";
    process.env.OTP_SECRET =
      "production-otp-secret-that-is-longer-than-thirty-two-characters";
    process.env.CSRF_SECRET =
      "production-csrf-secret-that-is-longer-than-thirty-two-characters";
    process.env.MAIN_PRODUCT_HOSTS = "peileme.art,www.peileme.art";
    process.env.AI_PRODUCT_HOSTS = "ai.peileme.art";
    process.env.APP_ORIGIN =
      "https://peileme.art,https://ai.peileme.art";
    process.env.MAIN_APP_ORIGIN = "https://peileme.art";
    process.env.AI_APP_ORIGIN = "https://ai.peileme.art";
    delete process.env[name];
    resetConfigForTests();

    expect(() => getConfig()).toThrow(
      `${name} must be configured in production`
    );
  });

  it.each([
    ["MAIN_APP_ORIGIN", "https://peileme.art/path"],
    ["MAIN_APP_ORIGIN", "https://peileme.art?from=bad"],
    ["MAIN_APP_ORIGIN", "ftp://peileme.art"],
    ["AI_APP_ORIGIN", "https://peileme.art"]
  ])("rejects invalid or cross-channel %s=%s", (name, value) => {
    process.env.APP_ORIGIN =
      "https://peileme.art,https://ai.peileme.art";
    process.env.MAIN_PRODUCT_HOSTS = "peileme.art,www.peileme.art";
    process.env.AI_PRODUCT_HOSTS = "ai.peileme.art";
    process.env.MAIN_APP_ORIGIN = "https://peileme.art";
    process.env.AI_APP_ORIGIN = "https://ai.peileme.art";
    process.env[name] = value;
    resetConfigForTests();

    expect(() => getConfig()).toThrow(new RegExp(name));
  });

  it("keeps canonical payment origins separate from the CORS origin list", () => {
    process.env.APP_ORIGIN =
      "https://console.peileme.art,https://peileme.art,https://www.peileme.art,https://ai.peileme.art";
    process.env.MAIN_PRODUCT_HOSTS = "peileme.art,www.peileme.art";
    process.env.AI_PRODUCT_HOSTS = "ai.peileme.art";
    process.env.MAIN_APP_ORIGIN = "https://www.peileme.art";
    process.env.AI_APP_ORIGIN = "https://ai.peileme.art";
    resetConfigForTests();

    const config = getConfig();
    expect(config.MAIN_APP_ORIGIN).toBe("https://www.peileme.art");
    expect(config.AI_APP_ORIGIN).toBe("https://ai.peileme.art");
    expect(config.APP_ORIGIN).toContain("console.peileme.art");
  });

  it("keeps an IPv6 loopback host resolvable after config normalization", () => {
    process.env.MAIN_PRODUCT_HOSTS = "localhost,[::1]";
    resetConfigForTests();

    const config = getConfig();
    const resolve = createProductHostResolver(
      config.MAIN_PRODUCT_HOSTS,
      config.AI_PRODUCT_HOSTS
    );
    expect(config.MAIN_PRODUCT_HOSTS).toContain("::1");
    expect(resolve("[::1]:3001")).toBe("main");
  });

  it.each([
    "https://peileme.art/path,https://ai.peileme.art",
    "https://user@peileme.art,https://ai.peileme.art",
    "https://peileme.art,https://peileme.art"
  ])("rejects an invalid CORS origin list %s", (value) => {
    process.env.APP_ORIGIN = value;
    resetConfigForTests();

    expect(() => getConfig()).toThrow(/APP_ORIGIN/);
  });

  it("requires both canonical payment origins in the CORS allowlist", () => {
    process.env.APP_ORIGIN = "http://localhost:5173";
    resetConfigForTests();

    expect(() => getConfig()).toThrow(
      "AI_APP_ORIGIN must also be included in APP_ORIGIN"
    );
  });

  it("boots with complete local defaults when related environment is absent", () => {
    for (const name of [
      "NODE_ENV",
      "APP_ORIGIN",
      "MAIN_PRODUCT_HOSTS",
      "AI_PRODUCT_HOSTS",
      "MAIN_APP_ORIGIN",
      "AI_APP_ORIGIN"
    ]) {
      delete process.env[name];
    }
    resetConfigForTests();

    const config = getConfig();
    expect(config.NODE_ENV).toBe("development");
    expect(config.APP_ORIGIN).toBe(
      "http://localhost:5173,http://ai.localhost:5174"
    );
    expect(config.MAIN_APP_ORIGIN).toBe("http://localhost:5173");
    expect(config.AI_APP_ORIGIN).toBe("http://ai.localhost:5174");
    expect(config.MAIN_PRODUCT_HOSTS).toEqual(
      expect.arrayContaining(["localhost", "127.0.0.1", "::1"])
    );
    expect(config.AI_PRODUCT_HOSTS).toContain("ai.localhost");
  });
});
