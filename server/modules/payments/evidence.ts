import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

const intrinsicApply = Reflect.apply;
const arrayBufferIsViewIntrinsic = ArrayBuffer.isView;
const arrayIsArrayIntrinsic = Array.isArray;
const SharedArrayBufferIntrinsic =
  typeof SharedArrayBuffer === "function" ? SharedArrayBuffer : undefined;
const isProxyIntrinsic = utilTypes.isProxy;

const captureGetter = (target: object, key: PropertyKey) => {
  const getter = Object.getOwnPropertyDescriptor(target, key)?.get;
  if (!getter) throw new TypeError(`Missing intrinsic getter: ${String(key)}`);
  return getter;
};

const callIntrinsic = <Result>(intrinsic: Function, receiver: object) =>
  intrinsicApply(intrinsic, receiver, []) as Result;

type IntrinsicProbe<Result> =
  | { matched: true; value: Result }
  | { matched: false };

const probeIntrinsic = <Result>(
  intrinsic: Function | undefined,
  receiver: object
): IntrinsicProbe<Result> => {
  if (!intrinsic) return { matched: false };
  try {
    return { matched: true, value: callIntrinsic<Result>(intrinsic, receiver) };
  } catch {
    return { matched: false };
  }
};

const dateGetTimeIntrinsic = Date.prototype.getTime;
const dateToISOStringIntrinsic = Date.prototype.toISOString;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayBufferIntrinsic = captureGetter(typedArrayPrototype, "buffer");
const typedArrayByteOffsetIntrinsic = captureGetter(
  typedArrayPrototype,
  "byteOffset"
);
const typedArrayByteLengthIntrinsic = captureGetter(
  typedArrayPrototype,
  "byteLength"
);
const typedArrayLengthIntrinsic = captureGetter(typedArrayPrototype, "length");
const typedArrayTagIntrinsic = captureGetter(
  typedArrayPrototype,
  Symbol.toStringTag
);
const dataViewBufferIntrinsic = captureGetter(DataView.prototype, "buffer");
const dataViewByteOffsetIntrinsic = captureGetter(
  DataView.prototype,
  "byteOffset"
);
const dataViewByteLengthIntrinsic = captureGetter(
  DataView.prototype,
  "byteLength"
);
const arrayBufferByteLengthIntrinsic = captureGetter(
  ArrayBuffer.prototype,
  "byteLength"
);
const sharedArrayBufferByteLengthIntrinsic = SharedArrayBufferIntrinsic
  ? captureGetter(SharedArrayBufferIntrinsic.prototype, "byteLength")
  : undefined;
const mapSizeIntrinsic = captureGetter(Map.prototype, "size");
const mapEntriesIntrinsic = Map.prototype.entries;
const mapIteratorNextIntrinsic = Object.getPrototypeOf(
  new Map().entries()
).next;
const setSizeIntrinsic = captureGetter(Set.prototype, "size");
const setValuesIntrinsic = Set.prototype.values;
const setIteratorNextIntrinsic = Object.getPrototypeOf(
  new Set().values()
).next;

const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 100;
const MAX_STRING_BYTES = 2_048;
const MAX_NODES = 1_000;
const MAX_JSON_BYTES = 32_768;
const MAX_DIGEST_BYTES = 1_048_576;
const MAX_DIGEST_NODES = 100_000;
const MAX_DIGEST_DEPTH = 64;
const MAX_DIGEST_STRING_CODE_UNITS = 262_144;
const MAX_DIGEST_BINARY_BYTES = 1_048_576;
const MAX_DIGEST_BIGINT_ABS = (1n << 4_096n) - 1n;
const MIN_DIGEST_BIGINT = -MAX_DIGEST_BIGINT_ABS;

const sensitiveKeySegments = new Set([
  "authorization",
  "signature",
  "token",
  "secret",
  "payer",
  "openid",
  "phone",
  "email",
  "password",
  "passwd",
  "pwd",
  "cookie",
  "credential",
  "credentials",
  "certificate",
  "mobile",
  "address",
  "unionid",
  "cvv",
  "cvv2",
  "cvc",
  "cvc2",
  "pin",
  "passphrase",
  "pan",
  "account",
  "track1",
  "track2",
  "magstripe"
]);

const sensitiveKeySequences = [
  ["private", "key"],
  ["api", "key"],
  ["api", "v3", "key"],
  ["open", "id"],
  ["union", "id"],
  ["buyer", "id"],
  ["buyer", "ids"],
  ["set", "cookie"],
  ["id", "card"],
  ["identity", "number"],
  ["identity", "no"],
  ["id", "number"],
  ["id", "no"],
  ["bank", "card"],
  ["card", "number"],
  ["card", "no"],
  ["bank", "card", "no"],
  ["acct", "no"],
  ["account", "number"],
  ["account", "no"],
  ["private", "certificate"],
  ["session", "key"],
  ["buyer", "logon", "id"],
  ["buyer", "user", "id"],
  ["buyer", "account"],
  ["payer", "account"],
  ["bank", "account"],
  ["bank", "account", "no"],
  ["cert", "no"],
  ["cert", "number"],
  ["client", "ip"],
  ["client", "ip", "address"],
  ["spbill", "create", "ip"],
  ["spbill", "create", "ip", "address"],
  ["track", "data"],
  ["track", "1"],
  ["track", "2"],
  ["cardholder", "name"],
  ["card", "holder", "name"],
  ["expiry", "date"],
  ["expiration", "date"],
  ["service", "code"]
] as const;

const compactSensitiveKeys = new Set(
  [
    ...sensitiveKeySegments,
    ...sensitiveKeySequences.map((sequence) => sequence.join(""))
  ]
);

const exceedsBigIntSafetyLimit = (value: bigint) =>
  value > MAX_DIGEST_BIGINT_ABS || value < MIN_DIGEST_BIGINT;

const includesTokenSequence = (
  segments: string[],
  sequence: readonly string[]
) => {
  if (sequence.length > segments.length) return false;
  for (let start = 0; start <= segments.length - sequence.length; start += 1) {
    if (
      sequence.every((segment, offset) => segments[start + offset] === segment)
    ) {
      return true;
    }
  }
  return false;
};

const isSensitiveKey = (key: string) => {
  const segmented = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  const segments = segmented.split(/[^a-z0-9]+/).filter(Boolean);
  if (segments.some((segment) => sensitiveKeySegments.has(segment))) {
    return true;
  }
  const normalized = segments.join("");
  return (
    compactSensitiveKeys.has(normalized) ||
    sensitiveKeySequences.some((sequence) =>
      includesTokenSequence(segments, sequence)
    )
  );
};

const sanitizePostgresText = (input: string) => {
  let sanitized = "";
  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);
    if (codeUnit === 0) {
      sanitized += "�";
      continue;
    }
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = input.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        sanitized += input[index] + input[index + 1];
        index += 1;
      } else {
        sanitized += "�";
      }
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      sanitized += "�";
      continue;
    }
    sanitized += input[index];
  }
  return sanitized;
};

const isOpaqueProxy = (value: object) => {
  try {
    return isProxyIntrinsic(value);
  } catch {
    return true;
  }
};

const hashEvidenceUnchecked = (input: unknown): string | null => {
  const hash = createHash("sha256");
  const seen = new WeakMap<object, number>();
  let nextObjectId = 0;
  let digestBytes = 0;
  let digestNodes = 0;
  let safetyLimitExceeded = false;

  type HashBytes = string | Uint8Array;
  type OwnPropertyMode = "all" | "array-properties" | "typed-array-extras";
  type HashTask =
    | { kind: "value"; value: unknown; depth: number }
    | { kind: "token"; tag: string; data?: HashBytes }
    | {
        kind: "own-properties";
        value: object;
        objectId: number;
        mode: OwnPropertyMode;
        indexedLength: number;
        depth: number;
      };

  const writeToken = (tag: string, data: HashBytes = "") => {
    if (safetyLimitExceeded) return;
    const tagBytes = Buffer.byteLength(tag, "utf8");
    const dataBytes =
      typeof data === "string" ? data.length * 2 : data.byteLength;
    if (
      (typeof data === "string" &&
        data.length > MAX_DIGEST_STRING_CODE_UNITS) ||
      (typeof data !== "string" &&
        data.byteLength > MAX_DIGEST_BINARY_BYTES) ||
      digestBytes + tagBytes + dataBytes > MAX_DIGEST_BYTES
    ) {
      safetyLimitExceeded = true;
      return;
    }
    digestBytes += tagBytes + dataBytes;
    const encodedData =
      typeof data === "string" ? Buffer.from(data, "utf16le") : data;
    hash.update(`T${tagBytes}:`, "utf8");
    hash.update(tag, "utf8");
    hash.update(`D${dataBytes}:`, "utf8");
    hash.update(encodedData);
  };

  const token = (tag: string, data?: HashBytes): HashTask => ({
    kind: "token",
    tag,
    data
  });
  const valueTask = (value: unknown, depth: number): HashTask => ({
    kind: "value",
    value,
    depth
  });
  const ownPropertiesTask = (
    value: object,
    objectId: number,
    mode: OwnPropertyMode = "all",
    indexedLength = 0,
    depth = 0
  ): HashTask => ({
    kind: "own-properties",
    value,
    objectId,
    mode,
    indexedLength,
    depth
  });
  const tasks: HashTask[] = [valueTask(input, 0)];

  const readOwnDataValue = (
    container: unknown,
    key: PropertyKey
  ): { ok: true; value: unknown } | { ok: false } => {
    if (
      (typeof container !== "object" || container === null) &&
      typeof container !== "function"
    ) {
      return { ok: false };
    }
    try {
      const descriptor = Object.getOwnPropertyDescriptor(container, key);
      return descriptor && "value" in descriptor
        ? { ok: true, value: descriptor.value }
        : { ok: false };
    } catch {
      return { ok: false };
    }
  };

  const isProcessedIndexKey = (key: PropertyKey, indexedLength: number) => {
    if (typeof key !== "string") return false;
    const index = Number(key);
    return (
      Number.isInteger(index) &&
      index >= 0 &&
      index < indexedLength &&
      String(index) === key
    );
  };

  const enqueueOwnProperties = (
    value: object,
    objectId: number,
    mode: OwnPropertyMode,
    indexedLength: number,
    depth: number
  ) => {
    let ownKeys: PropertyKey[];
    try {
      ownKeys = Reflect.ownKeys(value);
    } catch {
      writeToken("unreadable-object", String(objectId));
      return;
    }
    const filteredKeys = ownKeys.filter((key) => {
      if (mode === "array-properties") return key !== "length";
      if (mode === "all") return true;
      return !isProcessedIndexKey(key, indexedLength);
    });
    if (filteredKeys.length > MAX_DIGEST_NODES) {
      safetyLimitExceeded = true;
      return;
    }
    const sortedKeys = filteredKeys
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
    writeToken(
      "own-properties-start",
      `${objectId}:${filteredKeys.length}`
    );
    tasks.push(token("own-properties-end"));
    for (let index = sortedKeys.length - 1; index >= 0; index -= 1) {
      const { key, label } = sortedKeys[index];
      if (typeof key === "string" && isSensitiveKey(key)) {
        tasks.push(token("property-redacted", `${label}:REDACTED`));
        continue;
      }
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
        tasks.push(valueTask(descriptor.value, depth + 1));
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
  };

  while (tasks.length > 0 && !safetyLimitExceeded) {
    const task = tasks.pop()!;
    if (task.kind === "token") {
      writeToken(task.tag, task.data);
      continue;
    }
    if (task.kind === "own-properties") {
      enqueueOwnProperties(
        task.value,
        task.objectId,
        task.mode,
        task.indexedLength,
        task.depth
      );
      continue;
    }
    const value = task.value;
    digestNodes += 1;
    if (
      digestNodes > MAX_DIGEST_NODES ||
      task.depth > MAX_DIGEST_DEPTH
    ) {
      safetyLimitExceeded = true;
      continue;
    }
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
        if (exceedsBigIntSafetyLimit(value)) {
          safetyLimitExceeded = true;
          continue;
        }
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

    if (isOpaqueProxy(value)) {
      safetyLimitExceeded = true;
      continue;
    }

    const priorId = seen.get(value);
    if (priorId !== undefined) {
      writeToken("reference", String(priorId));
      continue;
    }
    const objectId = nextObjectId;
    nextObjectId += 1;
    seen.set(value, objectId);

    const mapSize = probeIntrinsic<number>(mapSizeIntrinsic, value);
    if (mapSize.matched) {
      if (mapSize.value > MAX_DIGEST_NODES) {
        safetyLimitExceeded = true;
        continue;
      }
      writeToken("map-start", `${objectId}:${mapSize.value}`);
      const entries: Array<
        | { key: unknown; value: unknown; redacted: false }
        | { key: string; redacted: true }
      > = [];
      let collectionReadable = true;
      try {
        const iterator = callIntrinsic<object>(mapEntriesIntrinsic, value);
        for (let index = 0; index < mapSize.value; index += 1) {
          const step = callIntrinsic<object>(mapIteratorNextIntrinsic, iterator);
          const done = readOwnDataValue(step, "done");
          if (!done.ok) {
            collectionReadable = false;
            break;
          }
          if (done.value === true) break;
          const pairResult = readOwnDataValue(step, "value");
          if (!pairResult.ok) {
            collectionReadable = false;
            break;
          }
          const keyResult = readOwnDataValue(pairResult.value, "0");
          if (!keyResult.ok) {
            collectionReadable = false;
            break;
          }
          if (
            typeof keyResult.value === "string" &&
            isSensitiveKey(keyResult.value)
          ) {
            entries.push({ key: keyResult.value, redacted: true });
            continue;
          }
          const valueResult = readOwnDataValue(pairResult.value, "1");
          if (!valueResult.ok) {
            collectionReadable = false;
            break;
          }
          entries.push({
            key: keyResult.value,
            value: valueResult.value,
            redacted: false
          });
        }
      } catch {
        collectionReadable = false;
      }
      tasks.push(token("map-end"));
      tasks.push(ownPropertiesTask(value, objectId, "all", 0, task.depth));
      if (!collectionReadable) {
        tasks.push(token("map-iterator-unreadable"));
      }
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        tasks.push(token("map-entry-end", String(index)));
        if (entry.redacted) {
          tasks.push(token("map-entry-redacted", "REDACTED"));
        } else {
          tasks.push(valueTask(entry.value, task.depth + 1));
        }
        tasks.push(valueTask(entry.key, task.depth + 1));
        tasks.push(token("map-entry-start", String(index)));
      }
      continue;
    }

    const setSize = probeIntrinsic<number>(setSizeIntrinsic, value);
    if (setSize.matched) {
      if (setSize.value > MAX_DIGEST_NODES) {
        safetyLimitExceeded = true;
        continue;
      }
      writeToken("set-start", `${objectId}:${setSize.value}`);
      const entries: unknown[] = [];
      let collectionReadable = true;
      try {
        const iterator = callIntrinsic<object>(setValuesIntrinsic, value);
        for (let index = 0; index < setSize.value; index += 1) {
          const step = callIntrinsic<object>(setIteratorNextIntrinsic, iterator);
          const done = readOwnDataValue(step, "done");
          if (!done.ok) {
            collectionReadable = false;
            break;
          }
          if (done.value === true) break;
          const entry = readOwnDataValue(step, "value");
          if (!entry.ok) {
            collectionReadable = false;
            break;
          }
          entries.push(entry.value);
        }
      } catch {
        collectionReadable = false;
      }
      tasks.push(token("set-end"));
      tasks.push(ownPropertiesTask(value, objectId, "all", 0, task.depth));
      if (!collectionReadable) {
        tasks.push(token("set-iterator-unreadable"));
      }
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        tasks.push(token("set-entry-end", String(index)));
        tasks.push(valueTask(entries[index], task.depth + 1));
        tasks.push(token("set-entry-start", String(index)));
      }
      continue;
    }

    const dateTime = probeIntrinsic<number>(dateGetTimeIntrinsic, value);
    if (dateTime.matched) {
      try {
        writeToken(
          "date",
          Number.isNaN(dateTime.value)
            ? "[Invalid Date]"
            : callIntrinsic<string>(dateToISOStringIntrinsic, value)
        );
        tasks.push(ownPropertiesTask(value, objectId, "all", 0, task.depth));
        continue;
      } catch {
        // Continue to the remaining brands and ordinary own-key handling.
      }
    }

    let isBinaryView = false;
    try {
      isBinaryView = arrayBufferIsViewIntrinsic(value);
    } catch {
      // Continue to the remaining brands and ordinary own-key handling.
    }
    if (isBinaryView) {
      try {
        let viewName: string;
        let viewBuffer: ArrayBufferLike;
        let byteOffset: number;
        let byteLength: number;
        let indexedLength: number;
        try {
          byteLength = callIntrinsic<number>(
            dataViewByteLengthIntrinsic,
            value
          );
          viewBuffer = callIntrinsic<ArrayBufferLike>(
            dataViewBufferIntrinsic,
            value
          );
          byteOffset = callIntrinsic<number>(
            dataViewByteOffsetIntrinsic,
            value
          );
          viewName = "DataView";
          indexedLength = 0;
        } catch {
          byteLength = callIntrinsic<number>(
            typedArrayByteLengthIntrinsic,
            value
          );
          viewBuffer = callIntrinsic<ArrayBufferLike>(
            typedArrayBufferIntrinsic,
            value
          );
          byteOffset = callIntrinsic<number>(
            typedArrayByteOffsetIntrinsic,
            value
          );
          indexedLength = callIntrinsic<number>(
            typedArrayLengthIntrinsic,
            value
          );
          viewName = callIntrinsic<string>(typedArrayTagIntrinsic, value);
        }
        if (byteLength > MAX_DIGEST_BINARY_BYTES) {
          safetyLimitExceeded = true;
          continue;
        }
        const viewBytes = new Uint8Array(
          viewBuffer,
          byteOffset,
          byteLength
        );
        writeToken("binary-view-type", viewName);
        writeToken("binary-view-bytes", viewBytes);
        tasks.push(
          ownPropertiesTask(
            value,
            objectId,
            indexedLength > 0 ? "typed-array-extras" : "all",
            indexedLength,
            task.depth
          )
        );
        continue;
      } catch {
        // Continue to the remaining brands and ordinary own-key handling.
      }
    }

    const arrayBufferByteLength = probeIntrinsic<number>(
      arrayBufferByteLengthIntrinsic,
      value
    );
    if (arrayBufferByteLength.matched) {
      if (arrayBufferByteLength.value > MAX_DIGEST_BINARY_BYTES) {
        safetyLimitExceeded = true;
        continue;
      }
      try {
        const bufferBytes = new Uint8Array(
          value as ArrayBuffer,
          0,
          arrayBufferByteLength.value
        );
        writeToken("array-buffer", bufferBytes);
        tasks.push(ownPropertiesTask(value, objectId, "all", 0, task.depth));
        continue;
      } catch {
        // Continue to the remaining brands and ordinary own-key handling.
      }
    }

    const sharedArrayBufferByteLength = probeIntrinsic<number>(
      sharedArrayBufferByteLengthIntrinsic,
      value
    );
    if (sharedArrayBufferByteLength.matched) {
      if (sharedArrayBufferByteLength.value > MAX_DIGEST_BINARY_BYTES) {
        safetyLimitExceeded = true;
        continue;
      }
      try {
        const bufferBytes = new Uint8Array(
          value as SharedArrayBuffer,
          0,
          sharedArrayBufferByteLength.value
        );
        writeToken("shared-array-buffer", bufferBytes);
        tasks.push(ownPropertiesTask(value, objectId, "all", 0, task.depth));
        continue;
      } catch {
        // Continue to ordinary own-key handling.
      }
    }

    let isArray = false;
    try {
      isArray = arrayIsArrayIntrinsic(value);
    } catch {
      // Continue to ordinary own-key handling.
    }
    if (isArray) {
      const arrayValue = value as unknown[];
      let lengthDescriptor: PropertyDescriptor | undefined;
      try {
        lengthDescriptor = Object.getOwnPropertyDescriptor(
          arrayValue,
          "length"
        );
      } catch {
        writeToken("array-length-unreadable", String(objectId));
        continue;
      }
      if (
        !lengthDescriptor ||
        !("value" in lengthDescriptor) ||
        !Number.isInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) {
        writeToken("array-length-invalid", String(objectId));
        continue;
      }
      const arrayLength = lengthDescriptor.value as number;
      writeToken("array-start", `${objectId}:${arrayLength}`);
      tasks.push(token("array-end"));
      tasks.push(
        ownPropertiesTask(
          value,
          objectId,
          "array-properties",
          arrayLength,
          task.depth
        )
      );
      continue;
    }
    writeToken("object", String(objectId));
    tasks.push(ownPropertiesTask(value, objectId, "all", 0, task.depth));
  }
  return safetyLimitExceeded ? null : hash.digest("hex");
};

const hashEvidence = (input: unknown): string | null => {
  try {
    return hashEvidenceUnchecked(input);
  } catch {
    return null;
  }
};

const truncatedEvidence = (input: unknown) => {
  const digest = hashEvidence(input);
  return digest === null
    ? {
        _truncated: true as const,
        _reason: "evidence_limits_exceeded" as const,
        _digest_status: "omitted_safety_limit" as const
      }
    : {
        _truncated: true as const,
        _reason: "evidence_limits_exceeded" as const,
        _sha256: digest
      };
};

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
        if (
          value.length > MAX_DIGEST_STRING_CODE_UNITS ||
          Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES
        ) {
          limitExceeded = true;
          return null;
        }
        return sanitizePostgresText(value);
      case "number":
        return Number.isFinite(value) ? value : String(value);
      case "bigint":
        if (exceedsBigIntSafetyLimit(value)) {
          limitExceeded = true;
          return null;
        }
        return value.toString();
      case "boolean":
        return value;
      case "undefined":
      case "function":
      case "symbol":
        return `[${typeof value}]`;
    }

    if (isOpaqueProxy(value)) {
      limitExceeded = true;
      return "[Opaque Proxy]";
    }
    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    const mapSize = probeIntrinsic<number>(mapSizeIntrinsic, value);
    if (mapSize.matched) {
      limitExceeded = true;
      return `[Map ${mapSize.value} entries]`;
    }

    const setSize = probeIntrinsic<number>(setSizeIntrinsic, value);
    if (setSize.matched) {
      limitExceeded = true;
      return `[Set ${setSize.value} entries]`;
    }

    const dateTime = probeIntrinsic<number>(dateGetTimeIntrinsic, value);
    if (dateTime.matched) {
      try {
        return callIntrinsic<string>(dateToISOStringIntrinsic, value);
      } catch {
        limitExceeded = true;
        return "[Unreadable Date]";
      }
    }

    let isBinaryView = false;
    try {
      isBinaryView = arrayBufferIsViewIntrinsic(value);
    } catch {
      // Continue to the remaining brands and ordinary own-key handling.
    }
    if (isBinaryView) {
      try {
        let byteLength: number;
        try {
          byteLength = callIntrinsic<number>(
            dataViewByteLengthIntrinsic,
            value
          );
        } catch {
          byteLength = callIntrinsic<number>(
            typedArrayByteLengthIntrinsic,
            value
          );
        }
        return `[Binary ${byteLength} bytes]`;
      } catch {
        // Continue to the remaining brands and ordinary own-key handling.
      }
    }

    const arrayBufferByteLength = probeIntrinsic<number>(
      arrayBufferByteLengthIntrinsic,
      value
    );
    if (arrayBufferByteLength.matched) {
      return `[Binary ${arrayBufferByteLength.value} bytes]`;
    }

    const sharedArrayBufferByteLength = probeIntrinsic<number>(
      sharedArrayBufferByteLengthIntrinsic,
      value
    );
    if (sharedArrayBufferByteLength.matched) {
      return `[Binary ${sharedArrayBufferByteLength.value} bytes]`;
    }

    let isArray = false;
    try {
      isArray = arrayIsArrayIntrinsic(value);
    } catch {
      // Continue to ordinary own-key handling.
    }
    if (isArray) {
      const arrayValue = value as unknown[];
      let lengthDescriptor: PropertyDescriptor | undefined;
      try {
        lengthDescriptor = Object.getOwnPropertyDescriptor(
          arrayValue,
          "length"
        );
      } catch {
        limitExceeded = true;
        return "[Unreadable Array]";
      }
      if (
        !lengthDescriptor ||
        !("value" in lengthDescriptor) ||
        !Number.isInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) {
        limitExceeded = true;
        return "[Unreadable Array]";
      }
      const arrayLength = lengthDescriptor.value as number;
      if (arrayLength > MAX_ARRAY_ITEMS) {
        limitExceeded = true;
        return null;
      }
      const sanitizedArray = new Array<unknown>(arrayLength);
      for (let index = 0; index < arrayLength; index += 1) {
        let descriptor: PropertyDescriptor | undefined;
        try {
          descriptor = Object.getOwnPropertyDescriptor(
            arrayValue,
            String(index)
          );
        } catch {
          limitExceeded = true;
          sanitizedArray[index] = "[Unreadable Array Item]";
          continue;
        }
        if (!descriptor) continue;
        if ("value" in descriptor) {
          sanitizedArray[index] = visit(descriptor.value, depth + 1);
        } else {
          sanitizedArray[index] =
            `[Accessor get=${Boolean(descriptor.get)} ` +
            `set=${Boolean(descriptor.set)}]`;
        }
      }
      return sanitizedArray;
    }

    let keys: string[];
    try {
      keys = Object.keys(value);
    } catch {
      limitExceeded = true;
      return "[Unreadable Object]";
    }
    if (keys.length > MAX_OBJECT_KEYS) {
      limitExceeded = true;
      return null;
    }
    const safeEntries = keys
      .filter((key) => !isSensitiveKey(key))
      .map((key) => ({ key, baseKey: sanitizePostgresText(key) }));
    const reservedBaseKeys = new Set(
      safeEntries.map(({ baseKey }) => baseKey)
    );
    const assignedKeys = new Set<string>();
    const allocateSafeKey = (baseKey: string) => {
      if (!assignedKeys.has(baseKey)) {
        assignedKeys.add(baseKey);
        return baseKey;
      }
      let ordinal = 2;
      let candidate = `${baseKey}~normalized-${ordinal}`;
      while (
        assignedKeys.has(candidate) ||
        reservedBaseKeys.has(candidate)
      ) {
        ordinal += 1;
        candidate = `${baseKey}~normalized-${ordinal}`;
      }
      assignedKeys.add(candidate);
      return candidate;
    };
    const sanitized = Object.create(null) as Record<string, unknown>;
    for (const { key, baseKey } of safeEntries) {
      const safeKey = allocateSafeKey(baseKey);
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, key);
      } catch {
        limitExceeded = true;
        Object.defineProperty(sanitized, safeKey, {
          value: "[Unreadable Property]",
          enumerable: true,
          configurable: true,
          writable: true
        });
        continue;
      }
      if (!descriptor || !("value" in descriptor)) continue;
      Object.defineProperty(sanitized, safeKey, {
        value: visit(descriptor.value, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true
      });
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
