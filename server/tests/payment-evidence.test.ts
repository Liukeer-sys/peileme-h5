import { describe, expect, it } from "vitest";
import { sanitizePaymentEvidence } from "../modules/payments/evidence.js";

type TruncatedEvidence = {
  _truncated: true;
  _reason: "evidence_limits_exceeded";
  _sha256: string;
};

const hashOf = (input: unknown) => {
  const sanitized = sanitizePaymentEvidence(input);
  expect(sanitized).toMatchObject({
    _truncated: true,
    _reason: "evidence_limits_exceeded",
    _sha256: expect.stringMatching(/^[0-9a-f]{64}$/)
  });
  return (sanitized as TruncatedEvidence)._sha256;
};

const expectDistinctStableHashes = (left: unknown, right: unknown) => {
  const first = hashOf(left);
  expect(hashOf(left)).toBe(first);
  expect(hashOf(right)).not.toBe(first);
};

describe("payment evidence full-content digest", () => {
  it("includes string bytes after the first 65536 characters", () => {
    const prefix = "x".repeat(65_536);
    expectDistinctStableHashes(
      { message: `${prefix}A` },
      { message: `${prefix}B` }
    );
  });

  it("includes the 257th array item", () => {
    const prefix = Array.from({ length: 256 }, (_, index) => index);
    expectDistinctStableHashes(
      { items: [...prefix, "A"] },
      { items: [...prefix, "B"] }
    );
  });

  it("includes the 257th sorted own data key", () => {
    const makeEvidence = (lastValue: string) =>
      Object.fromEntries(
        Array.from({ length: 257 }, (_, index) => [
          `key${String(index).padStart(3, "0")}`,
          index === 256 ? lastValue : index
        ])
      );
    expectDistinctStableHashes(
      makeEvidence("A"),
      makeEvidence("B")
    );
  });

  it("includes values below the previous depth budget", () => {
    const makeEvidence = (leaf: string) => {
      const root: Record<string, unknown> = {};
      let cursor = root;
      for (let depth = 0; depth < 20; depth += 1) {
        const next: Record<string, unknown> = {};
        cursor.next = next;
        cursor = next;
      }
      cursor.leaf = leaf;
      return root;
    };
    expectDistinctStableHashes(
      makeEvidence("A"),
      makeEvidence("B")
    );
  });

  it("includes typed array bytes instead of only their length", () => {
    expectDistinctStableHashes(
      {
        oversized: "x".repeat(5_000),
        bytes: new Uint8Array([1, 2, 3])
      },
      {
        oversized: "x".repeat(5_000),
        bytes: new Uint8Array([1, 2, 4])
      }
    );
  });
});
