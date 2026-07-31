import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPaymentSecret } from "../modules/payments/secret-loader.js";

describe("payment secret loader", () => {
  it("loads a read-only regular file and removes one line ending", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "peileme-secret-"));
    const file = path.join(directory, "secret");
    try {
      await writeFile(file, "secret-value\r\n", { encoding: "utf8", mode: 0o400 });
      await chmod(file, 0o400);
      expect(
        loadPaymentSecret({
          name: "TEST_PAYMENT_SECRET",
          file
        })
      ).toBe("secret-value");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("loads a secret through a named env reference", () => {
    const secret = "environment-secret-value";
    expect(
      loadPaymentSecret({
        name: "TEST_PAYMENT_SECRET",
        secretRef: "env:PAYMENT_SECRET_VALUE",
        environment: { PAYMENT_SECRET_VALUE: secret }
      })
    ).toBe(secret);
  });

  it("rejects ambiguous file and env sources without printing the secret", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "peileme-secret-"));
    const file = path.join(directory, "secret");
    const secret = "must-never-appear-in-errors";
    try {
      await writeFile(file, secret, { encoding: "utf8", mode: 0o400 });
      await chmod(file, 0o400);
      let thrown: unknown;
      try {
        loadPaymentSecret({
          name: "TEST_PAYMENT_SECRET",
          file,
          secretRef: "env:PAYMENT_SECRET_VALUE",
          environment: { PAYMENT_SECRET_VALUE: secret }
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(String(thrown)).toMatch(/exactly one secret source/i);
      expect(String(thrown)).not.toContain(secret);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects symlinks even when their target is read-only", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "peileme-secret-"));
    const target = path.join(directory, "target");
    const link = path.join(directory, "link");
    try {
      await writeFile(target, "secret", { encoding: "utf8", mode: 0o400 });
      await chmod(target, 0o400);
      await symlink(target, link);
      expect(() =>
        loadPaymentSecret({ name: "TEST_PAYMENT_SECRET", file: link })
      ).toThrow(/regular file/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("never includes an env secret in a missing-reference error", () => {
    const unrelatedSecret = "unrelated-sensitive-value";
    let thrown: unknown;
    try {
      loadPaymentSecret({
        name: "TEST_PAYMENT_SECRET",
        secretRef: "env:MISSING_PAYMENT_SECRET",
        environment: { UNRELATED_SECRET: unrelatedSecret }
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toMatch(/MISSING_PAYMENT_SECRET.*(?:missing|empty)/i);
    expect(String(thrown)).not.toContain(unrelatedSecret);
  });
});
