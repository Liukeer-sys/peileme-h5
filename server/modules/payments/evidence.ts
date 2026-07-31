import { createHash } from "node:crypto";

const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 100;
const MAX_STRING_BYTES = 2_048;
const MAX_NODES = 1_000;
const MAX_JSON_BYTES = 32_768;

const sensitiveKeyPattern =
  /authorization|signature|token|secret|privatekey|apikey|payer|openid|buyerids?|phone|email/;

const isSensitiveKey = (key: string) =>
  sensitiveKeyPattern.test(key.toLowerCase().replace(/[^a-z0-9]/g, ""));

const hashEvidence = (input: unknown) => {
  const hash = createHash("sha256");
  const seen = new WeakMap<object, number>();
  let objectId = 0;
  let nodes = 0;

  const update = (value: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > 4_000 || depth > 16) {
      hash.update("[hash-budget]");
      return;
    }
    if (value === null) {
      hash.update("null;");
      return;
    }
    switch (typeof value) {
      case "string":
        hash.update(`string:${Buffer.byteLength(value, "utf8")}:`);
        hash.update(value.slice(0, 65_536));
        return;
      case "number":
        hash.update(`number:${String(value)};`);
        return;
      case "bigint":
        hash.update(`bigint:${value.toString()};`);
        return;
      case "boolean":
        hash.update(`boolean:${String(value)};`);
        return;
      case "undefined":
      case "symbol":
      case "function":
        hash.update(`${typeof value};`);
        return;
    }

    const priorId = seen.get(value);
    if (priorId !== undefined) {
      hash.update(`circular:${priorId};`);
      return;
    }
    const currentId = objectId;
    objectId += 1;
    seen.set(value, currentId);
    if (value instanceof Date) {
      hash.update(`date:${value.toISOString()};`);
      return;
    }
    if (ArrayBuffer.isView(value)) {
      hash.update(`binary:${value.byteLength};`);
      return;
    }
    if (Array.isArray(value)) {
      hash.update(`array:${value.length};`);
      for (const item of value.slice(0, 256)) update(item, depth + 1);
      return;
    }
    let keys: string[];
    try {
      keys = Object.keys(value).sort();
    } catch {
      hash.update("unreadable-object;");
      return;
    }
    hash.update(`object:${keys.length};`);
    for (const key of keys.slice(0, 256)) {
      hash.update(`key:${key};`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && "value" in descriptor) {
        update(descriptor.value, depth + 1);
      } else {
        hash.update("accessor;");
      }
    }
  };

  try {
    update(input, 0);
  } catch {
    hash.update("unhashable;");
  }
  return hash.digest("hex");
};

const truncatedEvidence = (input: unknown) => ({
  _truncated: true,
  _reason: "evidence_limits_exceeded",
  _sha256: hashEvidence(input)
});

export const sanitizePaymentEvidence = (input: unknown): unknown => {
  const seen = new WeakSet<object>();
  let limitExceeded = false;
  let nodes = 0;

  const visit = (value: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) {
      limitExceeded = true;
      return null;
    }
    if (value === null) return null;
    switch (typeof value) {
      case "string":
        if (Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES) {
          limitExceeded = true;
          return null;
        }
        return value;
      case "number":
        return Number.isFinite(value) ? value : String(value);
      case "bigint":
        return value.toString();
      case "boolean":
        return value;
      case "undefined":
      case "function":
      case "symbol":
        return `[${typeof value}]`;
    }

    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (value instanceof Date) return value.toISOString();
    if (ArrayBuffer.isView(value)) return `[Binary ${value.byteLength} bytes]`;
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_ITEMS) {
        limitExceeded = true;
        return null;
      }
      return value.map((item) => visit(item, depth + 1));
    }

    let keys: string[];
    try {
      keys = Object.keys(value);
    } catch {
      return "[Unreadable Object]";
    }
    if (keys.length > MAX_OBJECT_KEYS) {
      limitExceeded = true;
      return null;
    }
    const sanitized: Record<string, unknown> = {};
    for (const key of keys) {
      if (isSensitiveKey(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) continue;
      sanitized[key] = visit(descriptor.value, depth + 1);
    }
    return sanitized;
  };

  const sanitized = visit(input, 0);
  if (limitExceeded) return truncatedEvidence(input);
  const serialized = JSON.stringify(sanitized);
  if (Buffer.byteLength(serialized, "utf8") > MAX_JSON_BYTES) {
    return truncatedEvidence(input);
  }
  return sanitized;
};
