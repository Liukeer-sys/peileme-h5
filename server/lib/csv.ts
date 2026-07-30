import { readFile, stat } from "node:fs/promises";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

type ParsedRow = {
  line: number;
  values: string[];
};

const diagnostic = (
  filePath: string,
  line: number,
  column: number,
  message: string
) => new Error(`${filePath}:${line}:${column}: ${message}`);

const isContinuationByte = (byte: number) =>
  byte >= 0x80 && byte <= 0xbf;

const findInvalidUtf8Offset = (bytes: Uint8Array) => {
  for (let index = 0; index < bytes.length; index += 1) {
    const first = bytes[index];
    if (first <= 0x7f) continue;

    let continuationCount = 0;
    if (first >= 0xc2 && first <= 0xdf) {
      continuationCount = 1;
    } else if (first >= 0xe0 && first <= 0xef) {
      continuationCount = 2;
      const second = bytes[index + 1];
      if (
        second === undefined ||
        !isContinuationByte(second) ||
        (first === 0xe0 && second < 0xa0) ||
        (first === 0xed && second > 0x9f)
      ) {
        return index;
      }
    } else if (first >= 0xf0 && first <= 0xf4) {
      continuationCount = 3;
      const second = bytes[index + 1];
      if (
        second === undefined ||
        !isContinuationByte(second) ||
        (first === 0xf0 && second < 0x90) ||
        (first === 0xf4 && second > 0x8f)
      ) {
        return index;
      }
    } else {
      return index;
    }

    for (let offset = 1; offset <= continuationCount; offset += 1) {
      if (!isContinuationByte(bytes[index + offset] ?? -1)) return index;
    }
    index += continuationCount;
  }
  return -1;
};

const positionAtByteOffset = (bytes: Uint8Array, byteOffset: number) => {
  const prefix = new TextDecoder("utf-8").decode(bytes.slice(0, byteOffset));
  let line = 1;
  let column = 1;
  for (const character of prefix) {
    if (character === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
};

const parseCsv = (input: string, filePath: string) => {
  const rows: ParsedRow[] = [];
  let row: string[] = [];
  let field = "";
  let state: "unquoted" | "quoted" | "afterQuote" = "unquoted";
  let line = 1;
  let column = 1;
  let rowLine = 1;
  let index = 0;

  const endField = () => {
    row.push(field);
    field = "";
    state = "unquoted";
  };
  const endRow = () => {
    endField();
    rows.push({ line: rowLine, values: row });
    row = [];
  };

  while (index < input.length) {
    const character = input[index];

    if (state === "quoted") {
      if (character === '"') {
        state = "afterQuote";
        index += 1;
        column += 1;
      } else if (character === "\r") {
        if (input[index + 1] !== "\n") {
          throw diagnostic(
            filePath,
            line,
            column,
            "isolated carriage return"
          );
        }
        field += "\r\n";
        index += 2;
        line += 1;
        column = 1;
      } else if (character === "\n") {
        field += character;
        index += 1;
        line += 1;
        column = 1;
      } else {
        field += character;
        index += 1;
        column += 1;
      }
      continue;
    }

    if (state === "afterQuote") {
      if (character === '"') {
        field += '"';
        state = "quoted";
        index += 1;
        column += 1;
      } else if (character === ",") {
        endField();
        index += 1;
        column += 1;
      } else if (character === "\r") {
        if (input[index + 1] !== "\n") {
          throw diagnostic(
            filePath,
            line,
            column,
            "isolated carriage return"
          );
        }
        endRow();
        index += 2;
        line += 1;
        column = 1;
        rowLine = line;
      } else if (character === "\n") {
        endRow();
        index += 1;
        line += 1;
        column = 1;
        rowLine = line;
      } else {
        throw diagnostic(
          filePath,
          line,
          column,
          "unexpected character after closing quote"
        );
      }
      continue;
    }

    if (character === '"') {
      if (field.length > 0) {
        throw diagnostic(
          filePath,
          line,
          column,
          "quote inside an unquoted field"
        );
      }
      state = "quoted";
      index += 1;
      column += 1;
    } else if (character === ",") {
      endField();
      index += 1;
      column += 1;
    } else if (character === "\r") {
      if (input[index + 1] !== "\n") {
        throw diagnostic(
          filePath,
          line,
          column,
          "isolated carriage return"
        );
      }
      endRow();
      index += 2;
      line += 1;
      column = 1;
      rowLine = line;
    } else if (character === "\n") {
      endRow();
      index += 1;
      line += 1;
      column = 1;
      rowLine = line;
    } else {
      field += character;
      index += 1;
      column += 1;
    }
  }

  if (state === "quoted") {
    throw diagnostic(filePath, line, column, "unterminated quoted field");
  }
  if (field.length > 0 || row.length > 0 || state === "afterQuote") {
    endRow();
  }
  return rows.filter(
    (currentRow, rowIndex) =>
      rowIndex === 0 ||
      currentRow.values.some((value) => value.trim().length > 0)
  );
};

export const parseCsvRecords = (
  contentsInput: string,
  sourceName: string,
  expectedHeader: readonly string[],
  maxBytes = DEFAULT_MAX_BYTES
) => {
  const byteLength = new TextEncoder().encode(contentsInput).byteLength;
  if (byteLength === 0) {
    throw diagnostic(sourceName, 1, 1, "CSV is empty");
  }
  if (byteLength > maxBytes) {
    throw diagnostic(sourceName, 1, 1, `CSV exceeds ${maxBytes} bytes`);
  }
  const contents = contentsInput.replace(/^\uFEFF/, "");
  const nullIndex = contents.indexOf("\0");
  if (nullIndex >= 0) {
    const prefix = new TextEncoder().encode(contents.slice(0, nullIndex));
    const position = positionAtByteOffset(prefix, prefix.length);
    throw diagnostic(
      sourceName,
      position.line,
      position.column,
      "null byte"
    );
  }

  const rows = parseCsv(contents, sourceName);
  if (rows.length === 0) {
    throw diagnostic(sourceName, 1, 1, "CSV is empty");
  }

  const header = rows[0].values.map((value) => value.trim());
  if (
    header.length !== expectedHeader.length ||
    header.some((value, index) => value !== expectedHeader[index])
  ) {
    throw diagnostic(
      sourceName,
      rows[0].line,
      1,
      `CSV header must be exactly: ${expectedHeader.join(",")}`
    );
  }

  return rows.slice(1).map(({ line, values }) => {
    if (values.length !== header.length) {
      throw diagnostic(
        sourceName,
        line,
        1,
        `CSV row has ${values.length} fields; expected ${header.length}`
      );
    }
    return Object.fromEntries(
      header.map((column, columnIndex) => [
        column,
        values[columnIndex].trim()
      ])
    );
  });
};

export const readCsvRecords = async (
  filePath: string,
  expectedHeader: readonly string[],
  maxBytes = DEFAULT_MAX_BYTES
) => {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw diagnostic(filePath, 1, 1, "CSV path is not a file");
  }
  if (fileStat.size === 0) {
    throw diagnostic(filePath, 1, 1, "CSV is empty");
  }
  if (fileStat.size > maxBytes) {
    throw diagnostic(filePath, 1, 1, `CSV exceeds ${maxBytes} bytes`);
  }

  const bytes = await readFile(filePath);
  const invalidOffset = findInvalidUtf8Offset(bytes);
  if (invalidOffset >= 0) {
    const position = positionAtByteOffset(bytes, invalidOffset);
    throw diagnostic(
      filePath,
      position.line,
      position.column,
      "invalid UTF-8"
    );
  }
  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw diagnostic(filePath, 1, 1, "invalid UTF-8");
  }
  return parseCsvRecords(contents, filePath, expectedHeader, maxBytes);
};
