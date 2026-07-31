import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { sanitizePaymentEvidence } from "../modules/payments/evidence.js";

type TruncatedEvidence = {
  _truncated: true;
  _reason: "evidence_limits_exceeded";
  _sha256: string;
};

type OmittedEvidence = {
  _truncated: true;
  _reason: "evidence_limits_exceeded";
  _digest_status: "omitted_safety_limit";
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

const expectDigestOmitted = (input: unknown) => {
  const sanitized = sanitizePaymentEvidence(input);
  expect(sanitized).toEqual({
    _truncated: true,
    _reason: "evidence_limits_exceeded",
    _digest_status: "omitted_safety_limit"
  } satisfies OmittedEvidence);
  expect(sanitized).not.toHaveProperty("_sha256");
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

  it("omits revoked proxies without throwing or reading traps", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    expectDigestOmitted(proxy);
    expectDigestOmitted(proxy);
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

  it("sanitizes array accessors as stable markers without invoking getters", () => {
    let getterCalls = 0;
    const evidence: unknown[] = [];
    Object.defineProperty(evidence, "0", {
      enumerable: true,
      configurable: true,
      get: () => {
        getterCalls += 1;
        return "must-not-be-read";
      }
    });

    const first = sanitizePaymentEvidence(evidence);
    const repeated = sanitizePaymentEvidence(evidence);

    expect(first).toEqual(["[Accessor get=true set=false]"]);
    expect(repeated).toEqual(first);
    expect(getterCalls).toBe(0);
  });

  it("omits proxy arrays without invoking their get trap", () => {
    let getCalls = 0;
    const evidence = new Proxy(
      Array.from({ length: 51 }, (_, index) => index),
      {
        get: () => {
          getCalls += 1;
          throw new Error("array get trap must not run");
        }
      }
    );

    expectDigestOmitted(evidence);
    expectDigestOmitted(evidence);
    expect(getCalls).toBe(0);
  });

  it("omits proxy arrays whose item descriptors would throw", () => {
    let getCalls = 0;
    const target = ["safe"];
    const evidence = new Proxy(target, {
      get: () => {
        getCalls += 1;
        throw new Error("array get trap must not run");
      },
      getOwnPropertyDescriptor: (current, key) => {
        if (key === "length") {
          return Reflect.getOwnPropertyDescriptor(current, key);
        }
        throw new Error("array item descriptor unavailable");
      }
    });

    expectDigestOmitted(evidence);
    expectDigestOmitted(evidence);
    expect(getCalls).toBe(0);
  });

  it("omits object proxies before descriptor traps can run", () => {
    let descriptorPhase = 0;
    const target = { safe: "kept" };
    const evidence = new Proxy(target, {
      ownKeys: (current) => {
        descriptorPhase = 0;
        return Reflect.ownKeys(current);
      },
      getOwnPropertyDescriptor: (current, key) => {
        descriptorPhase += 1;
        if (descriptorPhase === 2) {
          throw new Error("second descriptor unavailable");
        }
        return Reflect.getOwnPropertyDescriptor(current, key);
      }
    });

    expectDigestOmitted(evidence);
    expectDigestOmitted(evidence);
    expect(descriptorPhase).toBe(0);
  });

  it("sanitizes ordinary object accessors without invoking getters", () => {
    let getterCalls = 0;
    const evidence = { safe: "kept" } as Record<string, unknown>;
    Object.defineProperty(evidence, "computed", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "must-not-be-read";
      }
    });

    expect(sanitizePaymentEvidence(evidence)).toEqual({ safe: "kept" });
    expect(getterCalls).toBe(0);
  });

  it("replaces PostgreSQL-unsafe text while preserving valid Unicode", () => {
    const evidence = Object.create(null) as Record<string, unknown>;
    evidence.legalUnicode = "支付成功😀 café";
    evidence.nulText = "before\0after";
    evidence.highSurrogate = "before\ud800after";
    evidence.lowSurrogate = "before\udc00after";
    Object.defineProperty(evidence, "unsafe\0\ud800key", {
      value: "kept",
      enumerable: true
    });

    expect(sanitizePaymentEvidence(evidence)).toEqual({
      legalUnicode: "支付成功😀 café",
      nulText: "before�after",
      highSurrogate: "before�after",
      lowSurrogate: "before�after",
      "unsafe��key": "kept"
    });
  });

  it("filters precise payment PII tokens without erasing audit status fields", () => {
    const sanitized = sanitizePaymentEvidence({
      buyer_user_id: "buyer-user-secret",
      buyer_logon_id: "buyer-logon-secret",
      openId: "openid-secret",
      unionId: "unionid-secret",
      account_no: "account-secret",
      bank_account_no: "bank-account-secret",
      mobile: "mobile-secret",
      identity_no: "identity-secret",
      passphrase: "passphrase-secret",
      cvv: "cvv-secret",
      clientIPAddress: "client-ip-secret",
      spbillCreateIPAddress: "spbill-ip-secret",
      card_no: "card-no-secret",
      cardNo: "camel-card-no-secret",
      pan: "pan-secret",
      bankcardno: "bank-card-no-secret",
      bankCardNo: "camel-bank-card-no-secret",
      acct_no: "acct-no-secret",
      acctNo: "camel-acct-no-secret",
      account: "account-secret",
      account_id: "account-id-secret",
      user_account: "user-account-secret",
      "c\0vv": "normalized-cvv-secret",
      pass_word: "normalized-password-secret",
      "p\0an": "normalized-pan-secret",
      se_cret: "normalized-secret",
      track_data: "track-data-secret",
      track1: "track-one-secret",
      "track-2": "track-two-secret",
      magstripe: "magstripe-secret",
      mag_stripe: "split-magstripe-secret",
      cardholder_name: "cardholder-secret",
      cardHolderName: "camel-cardholder-secret",
      expiry_date: "expiry-secret",
      expi_ry_date: "split-expiry-secret",
      expirationDate: "expiration-secret",
      service_code: "service-code-secret",
      serviceCode: "camel-service-code-secret",
      "c\0vv_hash": "suffixed-cvv-secret",
      "raw_c\0vv_value": "wrapped-cvv-secret",
      "p\0an_hash": "suffixed-pan-secret",
      se_cret_value: "suffixed-secret",
      mag_stripe_data: "split-magstripe-data-secret",
      magStripeHash: "camel-magstripe-hash-secret",
      exp_date: "exp-date-secret",
      expMonth: "exp-month-secret",
      exp_year: "exp-year-secret",
      expiration_month: "expiration-month-secret",
      expirationYear: "expiration-year-secret",
      expiry_month: "expiry-month-secret",
      expiryYear: "expiry-year-secret",
      name_on_card: "name-on-card-secret",
      nameOnCard: "camel-name-on-card-secret",
      card_holder: "card-holder-secret",
      cardHolder: "camel-card-holder-secret",
      magnetic_stripe_data: "magnetic-stripe-secret",
      magneticStripeData: "camel-magnetic-stripe-secret",
      cav2: "cav2-secret",
      cvn2: "cvn2-secret",
      cid: "cid-secret",
      csc: "csc-secret",
      cvd: "cvd-secret",
      cvd2: "cvd2-secret",
      card_validation_code: "card-validation-code-secret",
      cardValidationValue: "card-validation-value-secret",
      card_verification_code: "card-verification-code-secret",
      cardVerificationValue: "card-verification-value-secret",
      card_security_code: "card-security-code-secret",
      acct_number: "account-number-secret",
      cc_number: "cc-number-secret",
      cc_num: "cc-num-secret",
      cc_nbr: "cc-nbr-secret",
      card_num: "card-num-secret",
      card_nbr: "card-nbr-secret",
      credit_card_num: "credit-card-num-secret",
      debit_card_num: "debit-card-num-secret",
      card: {
        number: "nested-card-number-secret",
        name: "nested-card-name-secret",
        service: "nested-card-service-secret"
      },
      full_track: "full-track-secret",
      track: { data: "nested-track-data-secret" },
      holder_name: "holder-name-secret",
      holder: "holder-container-secret",
      expiry: "expiry-container-secret",
      expiration: "expiration-container-secret",
      valid_thru: "valid-thru-secret",
      validUntil: "valid-until-secret",
      svc_code: "svc-code-secret",
      a_u_t_h_o_r_i_z_a_t_i_o_n: "split-authorization-secret",
      [`${"x_".repeat(300)}tail`]: "overlong-key-secret",
      microphone_status: "enabled",
      tokenization_status: "complete",
      shipping: "standard",
      microphone: "enabled",
      tokenization: "complete",
      opinion: "approved",
      pineapple: "allowed",
      name: "provider-audit",
      key: "provider-audit-key"
    });

    expect(sanitized).toEqual({
      microphone_status: "enabled",
      tokenization_status: "complete",
      shipping: "standard",
      microphone: "enabled",
      tokenization: "complete",
      opinion: "approved",
      pineapple: "allowed",
      name: "provider-audit",
      key: "provider-audit-key"
    });
  });

  it("bounds BigInt sanitization and hashing before decimal conversion", () => {
    expect(sanitizePaymentEvidence(9_007_199_254_740_993n)).toBe(
      "9007199254740993"
    );
    expectDistinctStableHashes(
      { oversized: "x".repeat(5_000), counter: 123n },
      { oversized: "x".repeat(5_000), counter: 124n }
    );

    const huge = 1n << 2_000_000n;
    const decimalSpy = vi.spyOn(BigInt.prototype, "toString");
    try {
      const startedAt = performance.now();
      expectDigestOmitted(huge);
      expectDigestOmitted(-huge);
      expectDigestOmitted({ oversized: "x".repeat(5_000), huge });
      expect(performance.now() - startedAt).toBeLessThan(1_500);
      expect(decimalSpy).not.toHaveBeenCalled();
    } finally {
      decimalSpy.mockRestore();
    }
  });

  it("redacts sensitive values before hashing without reading accessors", () => {
    const sensitiveKeys = [
      "cvv",
      "raw_c\0vv_value",
      "p\0an_hash",
      "se_cret_value",
      "magStripeHash",
      "exp_month",
      "expiryYear",
      "nameOnCard",
      "card_holder",
      "magneticStripeData",
      "track_data",
      "service_code",
      "a_u_t_h_o_r_i_z_a_t_i_o_n_hash",
      "c_a_v_2_hash",
      "cc_num",
      "card",
      "full_track",
      "holder",
      "valid_until"
    ];
    const withSensitive = (
      key: string,
      sensitiveValue: string,
      status = "accepted"
    ) => ({
      oversized: "x".repeat(5_000),
      nested: { [key]: sensitiveValue, status }
    });

    for (const key of sensitiveKeys) {
      expect(hashOf(withSensitive(key, "secret-A")), key).toBe(
        hashOf(withSensitive(key, "secret-B"))
      );
    }
    expect(hashOf(withSensitive("cvv", "secret", "accepted"))).not.toBe(
      hashOf(withSensitive("cvv", "secret", "declined"))
    );

    let getterCalls = 0;
    const nested = { status: "accepted" } as Record<string, unknown>;
    Object.defineProperty(nested, "a_u_t_h_o_r_i_z_a_t_i_o_n_hash", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "must-never-be-read";
      }
    });
    hashOf({ oversized: "x".repeat(5_000), nested });
    expect(getterCalls).toBe(0);
  });

  it("hashes every one of 6001 own keys without sampling", () => {
    const makeEvidence = (middle: string) =>
      Object.fromEntries(
        Array.from({ length: 6_001 }, (_, index) => [
          `field${String(index).padStart(4, "0")}`,
          index === 3_000 ? middle : index
        ])
      );

    expectDistinctStableHashes(makeEvidence("A"), makeEvidence("B"));
  });

  it("hashes every one of 5001 Map entries without sampling", () => {
    const makeEvidence = (last: string) =>
      new Map(
        Array.from({ length: 5_001 }, (_, index) => [
          `entry${String(index).padStart(4, "0")}`,
          index === 5_000 ? last : index
        ])
      );

    expectDistinctStableHashes(makeEvidence("A"), makeEvidence("B"));
  });

  it("hashes every one of 5001 actually-present sparse indices", () => {
    const makeEvidence = (middle: string) => {
      const evidence = new Array<unknown>(10_001);
      for (let ordinal = 0; ordinal < 5_001; ordinal += 1) {
        evidence[ordinal * 2] = ordinal === 2_500 ? middle : ordinal;
      }
      return evidence;
    };

    expectDistinctStableHashes(makeEvidence("A"), makeEvidence("B"));
  });

  it("omits digests at explicit string and binary safety limits", () => {
    expectDigestOmitted({ message: "x".repeat(262_145) });
    expectDigestOmitted({
      oversized: "x".repeat(5_000),
      bytes: new Uint8Array(1_048_577)
    });
    expectDigestOmitted({
      oversized: "x".repeat(5_000),
      bytes: new ArrayBuffer(1_048_577)
    });
  });

  it("omits digests at explicit byte, node and depth safety limits", () => {
    expectDigestOmitted({
      chunks: [
        "a".repeat(200_000),
        "b".repeat(200_000),
        "c".repeat(200_000)
      ]
    });
    expectDigestOmitted({
      values: Array.from({ length: 100_001 }, () => null)
    });

    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let depth = 0; depth < 65; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    expectDigestOmitted(deep);
  });

  it("preserves every normalized key collision with conflict-free suffixes", () => {
    const evidence = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of [
      ["collision\0key", "nul"],
      ["collision\ud800key", "surrogate"],
      ["collision�key", "replacement"],
      ["collision�key~normalized-2", "pre-existing-suffix"],
      ["__proto__", "prototype-safe"]
    ] as const) {
      Object.defineProperty(evidence, key, { value, enumerable: true });
    }

    const sanitized = sanitizePaymentEvidence(evidence) as Record<
      string,
      unknown
    >;
    expect(Object.getPrototypeOf(sanitized)).toBeNull();
    expect(Object.values(sanitized)).toHaveLength(5);
    expect(new Set(Object.values(sanitized))).toEqual(
      new Set([
        "nul",
        "surrogate",
        "replacement",
        "pre-existing-suffix",
        "prototype-safe"
      ])
    );
    expect(Object.prototype.polluted).toBeUndefined();
    expect(sanitizePaymentEvidence(evidence)).toEqual(sanitized);
  });

  it("does not execute getters on proxy-provided descriptor objects", () => {
    let descriptorGetterCalls = 0;
    let outerDescriptorCalls = 0;
    const descriptorResult = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of [
      ["enumerable", true],
      ["configurable", true],
      ["writable", true],
      ["value", "descriptor-secret"]
    ] as const) {
      Object.defineProperty(descriptorResult, key, {
        enumerable: true,
        get: () => {
          descriptorGetterCalls += 1;
          return value;
        }
      });
    }
    const target = {};
    Object.defineProperty(target, "safe", {
      value: "target-value",
      enumerable: true,
      configurable: true
    });
    const evidence = new Proxy(target, {
      ownKeys: () => ["safe"],
      getOwnPropertyDescriptor: () => {
        outerDescriptorCalls += 1;
        return descriptorResult;
      }
    });

    expectDigestOmitted(evidence);
    expectDigestOmitted(evidence);
    expect(outerDescriptorCalls).toBe(0);
    expect(descriptorGetterCalls).toBe(0);
  });

  it("does not execute get/set getters on proxy accessor descriptors", () => {
    let descriptorGetterCalls = 0;
    const descriptorResult = Object.create(null) as Record<string, unknown>;
    for (const key of ["enumerable", "configurable", "get", "set"] as const) {
      Object.defineProperty(descriptorResult, key, {
        enumerable: true,
        get: () => {
          descriptorGetterCalls += 1;
          if (key === "enumerable" || key === "configurable") return true;
          return undefined;
        }
      });
    }
    const target = {};
    Object.defineProperty(target, "safe", {
      value: "target-value",
      enumerable: true,
      configurable: true
    });
    const evidence = new Proxy(target, {
      ownKeys: () => ["safe"],
      getOwnPropertyDescriptor: () => descriptorResult
    });

    expectDigestOmitted(evidence);
    expectDigestOmitted(evidence);
    expect(descriptorGetterCalls).toBe(0);
  });

  it("hashes Map entries through captured intrinsics across realms", () => {
    expectDistinctStableHashes(
      { oversized: "x".repeat(5_000), value: new Map([["key", "A"]]) },
      { oversized: "x".repeat(5_000), value: new Map([["key", "B"]]) }
    );
    expectDistinctStableHashes(
      {
        oversized: "x".repeat(5_000),
        value: runInNewContext("new Map([['key', 'A']])")
      },
      {
        oversized: "x".repeat(5_000),
        value: runInNewContext("new Map([['key', 'B']])")
      }
    );
  });

  it("hashes Set entries through captured intrinsics across realms", () => {
    expectDistinctStableHashes(
      { oversized: "x".repeat(5_000), value: new Set(["A"]) },
      { oversized: "x".repeat(5_000), value: new Set(["B"]) }
    );
    expectDistinctStableHashes(
      {
        oversized: "x".repeat(5_000),
        value: runInNewContext("new Set(['A'])")
      },
      {
        oversized: "x".repeat(5_000),
        value: runInNewContext("new Set(['B'])")
      }
    );
  });

  it("hashes self-referential and instance-shadowed collections safely", () => {
    let shadowGetterCalls = 0;
    const left = new Map<unknown, unknown>();
    left.set("self", left);
    left.set("value", "A");
    Object.defineProperty(left, "entries", {
      enumerable: true,
      get: () => {
        shadowGetterCalls += 1;
        throw new Error("shadowed entries must not run");
      }
    });
    const right = new Map<unknown, unknown>();
    right.set("self", right);
    right.set("value", "B");
    Object.defineProperty(right, "entries", {
      enumerable: true,
      get: () => {
        shadowGetterCalls += 1;
        throw new Error("shadowed entries must not run");
      }
    });

    expectDistinctStableHashes(
      { oversized: "x".repeat(5_000), value: left },
      { oversized: "x".repeat(5_000), value: right }
    );
    expect(shadowGetterCalls).toBe(0);

    let proxyGetCalls = 0;
    const proxied = new Proxy(new Set(["secret"]), {
      get: () => {
        proxyGetCalls += 1;
        throw new Error("collection proxy get must not run");
      }
    });
    expectDigestOmitted({ oversized: "x".repeat(5_000), value: proxied });
    expectDigestOmitted({ oversized: "x".repeat(5_000), value: proxied });
    expect(proxyGetCalls).toBe(0);
  });

  it("preserves prototype-shaped own keys without prototype mutation", () => {
    const evidence = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(evidence, "__proto__", {
      value: { polluted: true },
      enumerable: true
    });
    Object.defineProperties(evidence, {
      constructor: {
        value: "constructor-audit",
        enumerable: true
      },
      prototype: {
        value: "prototype-audit",
        enumerable: true
      }
    });

    const sanitized = sanitizePaymentEvidence(evidence) as Record<
      string,
      unknown
    >;
    expect(Object.getPrototypeOf(sanitized)).toBeNull();
    expect(Object.getOwnPropertyDescriptor(sanitized, "__proto__")?.value)
      .toEqual({ polluted: true });
    expect(sanitized.constructor).toBe("constructor-audit");
    expect(sanitized.prototype).toBe("prototype-audit");
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("hashes maximum-length sparse arrays in bounded time", () => {
    const evidence = new Array<unknown>(2 ** 32 - 1);
    evidence[2 ** 32 - 2] = "tail";
    Object.defineProperty(evidence, "meta", {
      value: "kept",
      enumerable: true
    });

    const startedAt = performance.now();
    const first = hashOf(evidence);
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1_500);
    expect(hashOf(evidence)).toBe(first);
  });

  it("distinguishes sparse present indices and extra own keys", () => {
    const atStart = new Array<unknown>(51);
    const atEnd = new Array<unknown>(51);
    atStart[0] = "present";
    atEnd[50] = "present";
    expectDistinctStableHashes(atStart, atEnd);

    const alpha = new Array<unknown>(51);
    const beta = new Array<unknown>(51);
    Object.defineProperty(alpha, "alpha", { value: "present" });
    Object.defineProperty(beta, "beta", { value: "present" });
    expectDistinctStableHashes(alpha, beta);
  });

  it("distinguishes sparse holes from explicit undefined", () => {
    const hole = new Array<unknown>(51);
    const explicitUndefined = new Array<unknown>(51);
    explicitUndefined[25] = undefined;

    expectDistinctStableHashes(hole, explicitUndefined);
  });
});
