import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync
} from "node:fs";
import { TextDecoder } from "node:util";

const paymentSecretMaximumBytes = 256 * 1024;
const envSecretReferencePattern = /^env:([A-Z_][A-Z0-9_]*)$/;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export type PaymentSecretSource = {
  name: string;
  file?: string;
  secretRef?: string;
  environment?: NodeJS.ProcessEnv;
};

const secretError = (name: string, detail: string) =>
  new Error(`${name} ${detail}`);

const removeOneLineEnding = (value: string) =>
  value.endsWith("\r\n")
    ? value.slice(0, -2)
    : value.endsWith("\n")
      ? value.slice(0, -1)
      : value;

const validateSecretValue = (name: string, value: string) => {
  const normalized = removeOneLineEnding(value);
  if (!normalized.length) throw secretError(name, "is missing or empty");
  if (normalized.startsWith("\ufeff")) {
    throw secretError(name, "must not contain a UTF-8 BOM");
  }
  if (normalized.includes("\0")) {
    throw secretError(name, "must not contain NUL control characters");
  }
  if (Buffer.byteLength(normalized, "utf8") > paymentSecretMaximumBytes) {
    throw secretError(name, "exceeds the maximum allowed size");
  }
  return normalized;
};

const validateSecretBytes = (name: string, value: Buffer) => {
  if (value.byteLength > paymentSecretMaximumBytes + 2) {
    throw secretError(name, "secret file exceeds the maximum allowed size");
  }
  if (
    value.byteLength >= 3 &&
    value[0] === 0xef &&
    value[1] === 0xbb &&
    value[2] === 0xbf
  ) {
    throw secretError(name, "must not contain a UTF-8 BOM");
  }
  let decoded: string;
  try {
    decoded = utf8Decoder.decode(value);
  } catch {
    throw secretError(name, "must contain valid UTF-8 text");
  }
  return validateSecretValue(name, decoded);
};

const readBoundedSecretFile = (
  name: string,
  descriptor: number,
  reportedSize: number
) => {
  const maximumRawBytes = paymentSecretMaximumBytes + 2;
  if (reportedSize > maximumRawBytes) {
    throw secretError(name, "secret file exceeds the maximum allowed size");
  }
  const buffer = Buffer.allocUnsafe(maximumRawBytes + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    let bytesRead: number;
    try {
      bytesRead = readSync(
        descriptor,
        buffer,
        offset,
        buffer.byteLength - offset,
        null
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "EINTR") {
        continue;
      }
      throw error;
    }
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maximumRawBytes) {
    throw secretError(name, "secret file exceeds the maximum allowed size");
  }
  return validateSecretBytes(name, buffer.subarray(0, offset));
};

const loadSecretFile = (name: string, file: string) => {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      file,
      constants.O_RDONLY |
        constants.O_NONBLOCK |
        (constants.O_NOFOLLOW ?? 0)
    );
    const status = fstatSync(descriptor);
    if (!status.isFile()) {
      throw secretError(name, "must reference a regular file");
    }
    if ((status.mode & 0o444) === 0) {
      throw secretError(name, "secret file must be readable");
    }
    if ((status.mode & 0o222) !== 0) {
      throw secretError(name, "secret file must be read-only");
    }
    return readBoundedSecretFile(name, descriptor, status.size);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${name} `)) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ELOOP") {
      throw secretError(name, "must reference a regular file");
    }
    throw secretError(name, "secret file is missing or cannot be read");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

export const loadPaymentSecret = (source: PaymentSecretSource) => {
  const file = source.file?.trim() || undefined;
  const secretRef = source.secretRef?.trim() || undefined;
  if (Number(Boolean(file)) + Number(Boolean(secretRef)) !== 1) {
    throw secretError(source.name, "requires exactly one secret source");
  }

  if (file) return loadSecretFile(source.name, file);

  const match = envSecretReferencePattern.exec(secretRef!);
  if (!match) {
    throw secretError(
      source.name,
      "secret reference must use env:ENVIRONMENT_VARIABLE"
    );
  }
  const environmentName = match[1];
  const value = (source.environment ?? process.env)[environmentName];
  if (value === undefined || value.length === 0) {
    throw secretError(
      source.name,
      `environment reference ${environmentName} is missing or empty`
    );
  }
  return validateSecretValue(source.name, value);
};
