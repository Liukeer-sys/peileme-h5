import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCsvRecords } from "../../scripts/lib/csv.js";

const tempDirs: string[] = [];

const createCsvPath = async (name: string, contents: string | Uint8Array) => {
  const directory = await mkdtemp(path.join(tmpdir(), "peileme-csv-test-"));
  tempDirs.push(directory);
  const filePath = path.join(directory, name);
  await writeFile(filePath, contents);
  return filePath;
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("strict CSV reader", () => {
  it("accepts a BOM, CRLF, multiline quoted fields and escaped quotes", async () => {
    const csvPath = await createCsvPath(
      "valid.csv",
      '\uFEFFfirst,second\r\n"line one\r\nline two","say ""hello"""\r\n'
    );

    await expect(readCsvRecords(csvPath, ["first", "second"])).resolves.toEqual([
      {
        first: "line one\r\nline two",
        second: 'say "hello"'
      }
    ]);
  });

  it("rejects malformed UTF-8 with file and position diagnostics", async () => {
    const csvPath = await createCsvPath(
      "invalid-utf8.csv",
      Buffer.from([
        ...Buffer.from("first,second\nvalue,", "utf8"),
        0xc3,
        0x28,
        0x0a
      ])
    );

    await expect(readCsvRecords(csvPath, ["first", "second"])).rejects.toThrow(
      `${csvPath}:2:7: invalid UTF-8`
    );
  });

  it("rejects trailing characters after a closing quote without leaking the row", async () => {
    const secret = "PRIVATE-SALARY-987654";
    const csvPath = await createCsvPath(
      "trailing.csv",
      `first,second\n"value"${secret},ok\n`
    );

    let message = "";
    try {
      await readCsvRecords(csvPath, ["first", "second"]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(`${csvPath}:2:8:`);
    expect(message).toContain("closing quote");
    expect(message).not.toContain(secret);
  });

  it("rejects an isolated carriage return", async () => {
    const csvPath = await createCsvPath(
      "bare-cr.csv",
      "first,second\rvalue,ok\n"
    );

    await expect(readCsvRecords(csvPath, ["first", "second"])).rejects.toThrow(
      `${csvPath}:1:13: isolated carriage return`
    );
  });

  it("rejects files over the configured limit with bounded diagnostics", async () => {
    const csvPath = await createCsvPath(
      "large.csv",
      "first,second\nvalue,ok\n"
    );

    await expect(
      readCsvRecords(csvPath, ["first", "second"], 8)
    ).rejects.toThrow(`${csvPath}:1:1: CSV exceeds 8 bytes`);
  });
});
