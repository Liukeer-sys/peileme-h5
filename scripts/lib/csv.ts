import { readFile, stat } from "node:fs/promises";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

const parseCsv = (input: string) => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      if (field.length > 0) {
        throw new Error("CSV contains a quote inside an unquoted field");
      }
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }

  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter(
    (currentRow, index) =>
      index === 0 || currentRow.some((value) => value.trim().length > 0)
  );
};

export const readCsvRecords = async (
  filePath: string,
  expectedHeader: readonly string[],
  maxBytes = DEFAULT_MAX_BYTES
) => {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) throw new Error(`CSV path is not a file: ${filePath}`);
  if (fileStat.size === 0) throw new Error(`CSV is empty: ${filePath}`);
  if (fileStat.size > maxBytes) {
    throw new Error(`CSV exceeds ${maxBytes} bytes: ${filePath}`);
  }

  const contents = (await readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
  if (contents.includes("\0")) throw new Error("CSV contains a null byte");
  const rows = parseCsv(contents);
  if (rows.length === 0) throw new Error(`CSV is empty: ${filePath}`);

  const header = rows[0].map((value) => value.trim());
  if (
    header.length !== expectedHeader.length ||
    header.some((value, index) => value !== expectedHeader[index])
  ) {
    throw new Error(
      `CSV header must be exactly: ${expectedHeader.join(",")}`
    );
  }

  return rows.slice(1).map((values, rowIndex) => {
    if (values.length !== header.length) {
      throw new Error(
        `CSV row ${rowIndex + 2} has ${values.length} fields; expected ${header.length}`
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
