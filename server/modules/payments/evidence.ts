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
  let nextObjectId = 0;

  type HashBytes = string | Uint8Array;
  type HashTask =
    | { kind: "value"; value: unknown }
    | { kind: "token"; tag: string; data?: HashBytes };

  const writeToken = (tag: string, data: HashBytes = "") => {
    const tagBytes = Buffer.byteLength(tag, "utf8");
    const dataBytes =
      typeof data === "string"
        ? Buffer.byteLength(data, "utf8")
        : data.byteLength;
    hash.update(`T${tagBytes}:`, "utf8");
    hash.update(tag, "utf8");
    hash.update(`D${dataBytes}:`, "utf8");
    hash.update(data);
  };

  const token = (tag: string, data?: HashBytes): HashTask => ({
    kind: "token",
    tag,
    data
  });
  const valueTask = (value: unknown): HashTask => ({ kind: "value", value });
  const tasks: HashTask[] = [valueTask(input)];

  while (tasks.length > 0) {
    const task = tasks.pop()!;
    if (task.kind === "token") {
      writeToken(task.tag, task.data);
      continue;
    }
    const value = task.value;
    if (value === null) {
      writeToken("null");
      continue;
    }
    switch (typeof value) {
      case "string":
        writeToken("string", value);
        continue;
      case "number":
        writeToken(
          "number",
          Object.is(value, -0) ? "-0" : String(value)
        );
        continue;
      case "bigint":
        writeToken("bigint", value.toString());
        continue;
      case "boolean":
        writeToken("boolean", String(value));
        continue;
      case "undefined":
        writeToken("undefined");
        continue;
      case "symbol":
        writeToken(
          "symbol",
          `${Symbol.keyFor(value) ?? ""}:${value.description ?? ""}`
        );
        continue;
      case "function": {
        let source: string;
        try {
          source = Function.prototype.toString.call(value);
        } catch {
          source = "[Unreadable Function]";
        }
        writeToken("function", source);
        continue;
      }
    }

    const priorId = seen.get(value);
    if (priorId !== undefined) {
      writeToken("reference", String(priorId));
      continue;
    }
    const objectId = nextObjectId;
    nextObjectId += 1;
    seen.set(value, objectId);

    if (value instanceof Date) {
      const time = value.getTime();
      writeToken(
        "date",
        Number.isNaN(time) ? "[Invalid Date]" : value.toISOString()
      );
      continue;
    }
    if (ArrayBuffer.isView(value)) {
      let viewName = "ArrayBufferView";
      try {
        viewName = Object.prototype.toString.call(value);
      } catch {
        viewName = "[Unreadable ArrayBufferView]";
      }
      writeToken("binary-view-type", viewName);
      writeToken(
        "binary-view-bytes",
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      );
      continue;
    }
    if (value instanceof ArrayBuffer) {
      writeToken("array-buffer", new Uint8Array(value));
      continue;
    }
    if (Array.isArray(value)) {
      writeToken("array-start", `${objectId}:${value.length}`);
      tasks.push(token("array-end"));
      for (let index = value.length - 1; index >= 0; index -= 1) {
        let descriptor: PropertyDescriptor | undefined;
        try {
          descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        } catch {
          tasks.push(token("array-item-unreadable", String(index)));
          continue;
        }
        if (!descriptor) {
          tasks.push(token("array-hole", String(index)));
          continue;
        }
        if ("value" in descriptor) {
          tasks.push(valueTask(descriptor.value));
          tasks.push(token("array-index", String(index)));
        } else {
          tasks.push(
            token(
              "array-accessor",
              `${index}:get=${Boolean(descriptor.get)}:set=${Boolean(descriptor.set)}`
            )
          );
        }
      }
      continue;
    }

    let ownKeys: PropertyKey[];
    try {
      ownKeys = Reflect.ownKeys(value);
    } catch {
      writeToken("unreadable-object", String(objectId));
      continue;
    }
    const sortedKeys = ownKeys
      .map((key, ordinal) => ({
        key,
        ordinal,
        label:
          typeof key === "symbol"
            ? `symbol:${Symbol.keyFor(key) ?? ""}:${key.description ?? ""}`
            : `string:${String(key)}`
      }))
      .sort(
        (left, right) =>
          (left.label < right.label ? -1 : left.label > right.label ? 1 : 0) ||
          left.ordinal - right.ordinal
      );
    writeToken("object-start", `${objectId}:${sortedKeys.length}`);
    tasks.push(token("object-end"));
    for (let index = sortedKeys.length - 1; index >= 0; index -= 1) {
      const { key, label } = sortedKeys[index];
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, key);
      } catch {
        tasks.push(token("property-unreadable", label));
        continue;
      }
      if (!descriptor) {
        tasks.push(token("property-missing", label));
        continue;
      }
      if ("value" in descriptor) {
        tasks.push(valueTask(descriptor.value));
        tasks.push(token("property-key", label));
      } else {
        tasks.push(
          token(
            "property-accessor",
            `${label}:get=${Boolean(descriptor.get)}:set=${Boolean(descriptor.set)}`
          )
        );
      }
    }
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
