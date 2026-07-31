import { runInNewContext } from "node:vm";
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

  it("includes non-index array string data keys", () => {
    const makeEvidence = (meta: string) => {
      const items = Array.from({ length: 51 }, (_, index) => index);
      Object.defineProperty(items, "meta", {
        value: meta,
        enumerable: true
      });
      return items;
    };
    expectDistinctStableHashes(makeEvidence("A"), makeEvidence("B"));
  });

  it("includes non-index array symbol data keys", () => {
    const metaKey = Symbol.for("payment-evidence-meta");
    const makeEvidence = (meta: string) => {
      const items = Array.from({ length: 51 }, (_, index) => index);
      Object.defineProperty(items, metaKey, {
        value: meta,
        enumerable: true
      });
      return items;
    };
    expectDistinctStableHashes(makeEvidence("A"), makeEvidence("B"));
  });

  it("includes Date own data keys after its intrinsic value", () => {
    const makeEvidence = (meta: string) => {
      const date = new Date("2026-08-01T00:00:00.000Z");
      Object.defineProperty(date, "meta", {
        value: meta,
        enumerable: true
      });
      return { oversized: "x".repeat(5_000), date };
    };
    expectDistinctStableHashes(makeEvidence("A"), makeEvidence("B"));
  });

  it("includes typed view extra own data keys after its bytes", () => {
    const makeEvidence = (meta: string) => {
      const bytes = new Uint8Array([1, 2, 3]);
      Object.defineProperty(bytes, "meta", {
        value: meta,
        enumerable: true
      });
      return { oversized: "x".repeat(5_000), bytes };
    };
    expectDistinctStableHashes(makeEvidence("A"), makeEvidence("B"));
  });

  it("includes ArrayBuffer extra own data keys after its bytes", () => {
    const makeEvidence = (meta: string) => {
      const bytes = new ArrayBuffer(3);
      new Uint8Array(bytes).set([1, 2, 3]);
      Object.defineProperty(bytes, "meta", {
        value: meta,
        enumerable: true
      });
      return { oversized: "x".repeat(5_000), bytes };
    };
    expectDistinctStableHashes(makeEvidence("A"), makeEvidence("B"));
  });

  it("stably hashes revoked proxies without throwing", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    const first = hashOf(proxy);
    expect(hashOf(proxy)).toBe(first);
  });

  it("uses Date internal slots without invoking spoofed own methods", () => {
    let getterCalls = 0;
    const makeEvidence = (iso: string) => {
      const date = new Date(iso);
      Object.defineProperties(date, {
        getTime: {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            return () => 0;
          }
        },
        toISOString: {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            return () => "2000-01-01T00:00:00.000Z";
          }
        }
      });
      return { oversized: "x".repeat(5_000), date };
    };
    const left = makeEvidence("2026-08-01T00:00:00.000Z");
    const right = makeEvidence("2026-08-02T00:00:00.000Z");

    const first = hashOf(left);
    const repeated = hashOf(left);
    const different = hashOf(right);

    expect(getterCalls).toBe(0);
    expect(repeated).toBe(first);
    expect(different).not.toBe(first);
  });

  it("uses typed-array internal slots without invoking spoofed own getters", () => {
    let getterCalls = 0;
    const spoofBuffer = new ArrayBuffer(3);
    new Uint8Array(spoofBuffer).set([9, 9, 9]);
    const makeEvidence = (lastByte: number) => {
      const bytes = new Uint8Array([1, 2, lastByte]);
      Object.defineProperties(bytes, {
        buffer: {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            return spoofBuffer;
          }
        },
        byteOffset: {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            return 0;
          }
        },
        byteLength: {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            return 3;
          }
        },
        length: {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            return 3;
          }
        },
        [Symbol.toStringTag]: {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            return "SpoofedView";
          }
        }
      });
      return { oversized: "x".repeat(5_000), bytes };
    };
    const left = makeEvidence(3);
    const right = makeEvidence(4);

    const first = hashOf(left);
    const repeated = hashOf(left);
    const different = hashOf(right);

    expect(getterCalls).toBe(0);
    expect(repeated).toBe(first);
    expect(different).not.toBe(first);
  });

  it("uses DataView internal slots without invoking spoofed own getters", () => {
    let getterCalls = 0;
    const spoofBuffer = new ArrayBuffer(3);
    new Uint8Array(spoofBuffer).set([9, 9, 9]);
    const makeEvidence = (lastByte: number) => {
      const buffer = new ArrayBuffer(3);
      new Uint8Array(buffer).set([1, 2, lastByte]);
      const view = new DataView(buffer);
      Object.defineProperties(view, {
        buffer: {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            return spoofBuffer;
          }
        },
        byteOffset: {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            return 0;
          }
        },
        byteLength: {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            return 3;
          }
        },
        [Symbol.toStringTag]: {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            return "SpoofedView";
          }
        }
      });
      return { oversized: "x".repeat(5_000), view };
    };
    const left = makeEvidence(3);
    const right = makeEvidence(4);

    const first = hashOf(left);
    const repeated = hashOf(left);
    const different = hashOf(right);

    expect(getterCalls).toBe(0);
    expect(repeated).toBe(first);
    expect(different).not.toBe(first);
  });

  it("includes SharedArrayBuffer bytes without invoking spoofed own getters", () => {
    let getterCalls = 0;
    const makeEvidence = (lastByte: number) => {
      const buffer = new SharedArrayBuffer(3);
      new Uint8Array(buffer).set([1, 2, lastByte]);
      Object.defineProperties(buffer, {
        byteLength: {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            return 3;
          }
        },
        [Symbol.toStringTag]: {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            return "SpoofedBuffer";
          }
        }
      });
      return { oversized: "x".repeat(5_000), buffer };
    };
    const left = makeEvidence(3);
    const right = makeEvidence(4);

    const first = hashOf(left);
    const repeated = hashOf(left);
    const different = hashOf(right);

    expect(getterCalls).toBe(0);
    expect(repeated).toBe(first);
    expect(different).not.toBe(first);
  });

  it("falls through Date prototype brand spoofing to own data keys", () => {
    const makeEvidence = (meta: string) => {
      const value = Object.create(Date.prototype) as Record<string, unknown>;
      value.meta = meta;
      return { oversized: "x".repeat(5_000), value };
    };

    expectDistinctStableHashes(makeEvidence("A"), makeEvidence("B"));
  });

  it("falls through ArrayBuffer prototype brand spoofing to own data keys", () => {
    const makeEvidence = (meta: string) => {
      const value = Object.create(
        ArrayBuffer.prototype
      ) as Record<string, unknown>;
      value.meta = meta;
      return { oversized: "x".repeat(5_000), value };
    };

    expectDistinctStableHashes(makeEvidence("A"), makeEvidence("B"));
  });

  it("uses cross-realm Date internal slots", () => {
    expectDistinctStableHashes(
      {
        oversized: "x".repeat(5_000),
        value: runInNewContext("new Date(0)")
      },
      {
        oversized: "x".repeat(5_000),
        value: runInNewContext("new Date(1)")
      }
    );
  });

  it("uses cross-realm ArrayBuffer internal slots", () => {
    expectDistinctStableHashes(
      {
        oversized: "x".repeat(5_000),
        value: runInNewContext("Uint8Array.from([1, 2, 3]).buffer")
      },
      {
        oversized: "x".repeat(5_000),
        value: runInNewContext("Uint8Array.from([1, 2, 4]).buffer")
      }
    );
  });

  it("uses cross-realm SharedArrayBuffer internal slots when supported", () => {
    if (typeof SharedArrayBuffer !== "function") return;
    expectDistinctStableHashes(
      {
        oversized: "x".repeat(5_000),
        value: runInNewContext(
          "const b = new SharedArrayBuffer(3); new Uint8Array(b).set([1, 2, 3]); b"
        )
      },
      {
        oversized: "x".repeat(5_000),
        value: runInNewContext(
          "const b = new SharedArrayBuffer(3); new Uint8Array(b).set([1, 2, 4]); b"
        )
      }
    );
  });

  it("recognizes cross-realm typed arrays through ArrayBuffer.isView", () => {
    expectDistinctStableHashes(
      {
        oversized: "x".repeat(5_000),
        value: runInNewContext("new Uint8Array([1, 2, 3])")
      },
      {
        oversized: "x".repeat(5_000),
        value: runInNewContext("new Uint8Array([1, 2, 4])")
      }
    );
  });
});
