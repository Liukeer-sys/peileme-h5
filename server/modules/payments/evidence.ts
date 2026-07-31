import { createHash } from "node:crypto";

const intrinsicApply = Reflect.apply;
const arrayBufferIsViewIntrinsic = ArrayBuffer.isView;
const arrayIsArrayIntrinsic = Array.isArray;
const SharedArrayBufferIntrinsic =
  typeof SharedArrayBuffer === "function" ? SharedArrayBuffer : undefined;

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
  type OwnPropertyMode = "all" | "array-extras" | "typed-array-extras";
  type HashTask =
    | { kind: "value"; value: unknown }
    | { kind: "token"; tag: string; data?: HashBytes }
    | {
        kind: "own-properties";
        value: object;
        objectId: number;
        mode: OwnPropertyMode;
        indexedLength: number;
      };

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
  const ownPropertiesTask = (
    value: object,
    objectId: number,
    mode: OwnPropertyMode = "all",
    indexedLength = 0
  ): HashTask => ({
    kind: "own-properties",
    value,
    objectId,
    mode,
    indexedLength
  });
  const tasks: HashTask[] = [valueTask(input)];

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
    indexedLength: number
  ) => {
    let ownKeys: PropertyKey[];
    try {
      ownKeys = Reflect.ownKeys(value);
    } catch {
      writeToken("unreadable-object", String(objectId));
      return;
    }
    const sortedKeys = ownKeys
      .filter((key) => {
        if (mode === "array-extras" && key === "length") return false;
        if (mode === "all") return true;
        return !isProcessedIndexKey(key, indexedLength);
      })
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
    writeToken("own-properties-start", `${objectId}:${sortedKeys.length}`);
    tasks.push(token("own-properties-end"));
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
  };

  while (tasks.length > 0) {
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
        task.indexedLength
      );
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

    const dateTime = probeIntrinsic<number>(dateGetTimeIntrinsic, value);
    if (dateTime.matched) {
      try {
        writeToken(
          "date",
          Number.isNaN(dateTime.value)
            ? "[Invalid Date]"
            : callIntrinsic<string>(dateToISOStringIntrinsic, value)
        );
        tasks.push(ownPropertiesTask(value, objectId));
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
            indexedLength
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
      try {
        const bufferBytes = new Uint8Array(
          value as ArrayBuffer,
          0,
          arrayBufferByteLength.value
        );
        writeToken("array-buffer", bufferBytes);
        tasks.push(ownPropertiesTask(value, objectId));
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
      try {
        const bufferBytes = new Uint8Array(
          value as SharedArrayBuffer,
          0,
          sharedArrayBufferByteLength.value
        );
        writeToken("shared-array-buffer", bufferBytes);
        tasks.push(ownPropertiesTask(value, objectId));
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
      let arrayLength: number;
      try {
        arrayLength = arrayValue.length;
      } catch {
        writeToken("unreadable-object", String(objectId));
        continue;
      }
      writeToken("array-start", `${objectId}:${arrayLength}`);
      tasks.push(
        ownPropertiesTask(value, objectId, "array-extras", arrayLength)
      );
      tasks.push(token("array-end"));
      for (let index = arrayLength - 1; index >= 0; index -= 1) {
        let descriptor: PropertyDescriptor | undefined;
        try {
          descriptor = Object.getOwnPropertyDescriptor(
            arrayValue,
            String(index)
          );
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
    writeToken("object", String(objectId));
    tasks.push(ownPropertiesTask(value, objectId));
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
      try {
        if (arrayValue.length > MAX_ARRAY_ITEMS) {
          limitExceeded = true;
          return null;
        }
        return arrayValue.map((item) => visit(item, depth + 1));
      } catch {
        limitExceeded = true;
        return "[Unreadable Array]";
      }
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
