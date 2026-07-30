import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as testSetup from "./setup.js";

describe("test upload environment", () => {
  it("uses a unique upload directory for this test run", () => {
    const uploadDir = process.env.UPLOAD_DIR;

    expect(uploadDir).toBeTruthy();
    expect(path.dirname(uploadDir!)).toBe(path.resolve(tmpdir()));
    expect(path.basename(uploadDir!)).toMatch(/^peileme-test-uploads-[A-Za-z0-9_-]+$/);
    expect(existsSync(uploadDir!)).toBe(true);
  });

  it("cleans only the directory owned by the current lifecycle", () => {
    expect(testSetup.createTestUploadDir).toBeTypeOf("function");
    expect(testSetup.cleanupTestUploadDir).toBeTypeOf("function");
    const owned = testSetup.createTestUploadDir();
    const historical = mkdtempSync(path.join(tmpdir(), "peileme-test-uploads-history-"));
    writeFileSync(path.join(historical, "sentinel.txt"), "keep", "utf8");

    try {
      expect(testSetup.cleanupTestUploadDir(owned)).toBe(true);
      expect(testSetup.cleanupTestUploadDir(historical)).toBe(false);
      expect(existsSync(owned)).toBe(false);
      expect(existsSync(path.join(historical, "sentinel.txt"))).toBe(true);
    } finally {
      rmSync(owned, { recursive: true, force: true });
      rmSync(historical, { recursive: true, force: true });
    }
  });

  it("retains ownership when removing an owned directory fails", () => {
    const owned = testSetup.createTestUploadDir();

    try {
      expect(() =>
        testSetup.cleanupTestUploadDir(owned, (_path, _options) => {
          throw new Error("rm failed");
        })
      ).toThrow("rm failed");
      expect(existsSync(owned)).toBe(true);
      expect(testSetup.cleanupTestUploadDir(owned)).toBe(true);
    } finally {
      rmSync(owned, { recursive: true, force: true });
    }
  });
});
