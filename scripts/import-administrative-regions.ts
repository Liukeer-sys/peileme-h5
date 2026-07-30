import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, withTransaction } from "../server/db.js";
import { readCsvRecords } from "./lib/csv.js";
import { assertGovernmentHttpsUrl } from "./lib/official-source.js";

const header = [
  "code",
  "name",
  "level",
  "parent_code",
  "status",
  "source_name",
  "source_url",
  "source_snapshot_date"
] as const;

type AdministrativeRegionRow = {
  code: string;
  name: string;
  level: "province" | "prefecture";
  parentCode: string | null;
  status: "active" | "retired";
  sourceName: string;
  sourceUrl: string;
  sourceSnapshotDate: string;
};

const isIsoDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));

const loadAdministrativeRegions = async (csvPath: string) => {
  const records = await readCsvRecords(csvPath, header);
  if (records.length === 0) {
    throw new Error("Administrative-region CSV must contain at least one row");
  }

  const codes = new Set<string>();
  const names = new Set<string>();
  return records.map((record, index): AdministrativeRegionRow => {
    const rowNumber = index + 2;
    if (!/^\d{6}$/.test(record.code)) {
      throw new Error(`Row ${rowNumber}: code must contain exactly six digits`);
    }
    if (!record.name) throw new Error(`Row ${rowNumber}: name is required`);
    if (codes.has(record.code)) {
      throw new Error(`Row ${rowNumber}: duplicate code ${record.code}`);
    }
    if (names.has(record.name)) {
      throw new Error(`Row ${rowNumber}: duplicate name ${record.name}`);
    }
    codes.add(record.code);
    names.add(record.name);

    if (record.level !== "province" && record.level !== "prefecture") {
      throw new Error(`Row ${rowNumber}: invalid level ${record.level}`);
    }
    if (record.status !== "active" && record.status !== "retired") {
      throw new Error(`Row ${rowNumber}: invalid status ${record.status}`);
    }
    if (record.level === "province" && record.parent_code) {
      throw new Error(`Row ${rowNumber}: a province cannot have a parent`);
    }
    if (record.level === "prefecture") {
      if (!/^\d{6}$/.test(record.parent_code)) {
        throw new Error(
          `Row ${rowNumber}: a prefecture requires a six-digit province parent`
        );
      }
      if (
        !record.parent_code.endsWith("0000") ||
        record.parent_code.slice(0, 2) !== record.code.slice(0, 2)
      ) {
        throw new Error(
          `Row ${rowNumber}: prefecture parent must be its province code`
        );
      }
    }
    if (!record.source_name) {
      throw new Error(`Row ${rowNumber}: source_name is required`);
    }
    assertGovernmentHttpsUrl(record.source_url, rowNumber);
    if (!isIsoDate(record.source_snapshot_date)) {
      throw new Error(
        `Row ${rowNumber}: source_snapshot_date must be an ISO date`
      );
    }

    return {
      code: record.code,
      name: record.name,
      level: record.level,
      parentCode: record.parent_code || null,
      status: record.status,
      sourceName: record.source_name,
      sourceUrl: record.source_url,
      sourceSnapshotDate: record.source_snapshot_date
    };
  });
};

export const importAdministrativeRegions = async (csvPath: string) => {
  const rows = await loadAdministrativeRegions(csvPath);
  await withTransaction(async (client) => {
    const parentCodes = [
      ...new Set(
        rows
          .filter((row) => row.level === "prefecture")
          .map((row) => row.parentCode as string)
      )
    ];
    const existingParents = parentCodes.length
      ? await client.query<{ code: string; level: string; status: string }>(
          `SELECT code, level, status
           FROM administrative_regions
           WHERE code = ANY($1::text[])`,
          [parentCodes]
        )
      : { rows: [] };
    const parentState = new Map(
      existingParents.rows.map((row) => [
        row.code,
        { level: row.level, status: row.status }
      ])
    );
    for (const row of rows) {
      if (row.level === "province") {
        parentState.set(row.code, { level: row.level, status: row.status });
      }
    }
    for (const row of rows) {
      if (row.level !== "prefecture") continue;
      const parent = parentState.get(row.parentCode as string);
      if (
        !parent ||
        parent.level !== "province" ||
        (row.status === "active" && parent.status !== "active")
      ) {
        throw new Error(
          `Prefecture ${row.code} requires an active province parent ${row.parentCode}`
        );
      }
    }

    for (const row of rows.filter((item) => item.level === "province")) {
      await client.query(
        `INSERT INTO administrative_regions(
           code, name, level, parent_code, status,
           source_name, source_url, source_snapshot_date
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date)
         ON CONFLICT (code) DO UPDATE
         SET name = EXCLUDED.name,
             level = EXCLUDED.level,
             parent_code = EXCLUDED.parent_code,
             status = EXCLUDED.status,
             source_name = EXCLUDED.source_name,
             source_url = EXCLUDED.source_url,
             source_snapshot_date = EXCLUDED.source_snapshot_date,
             updated_at = now()`,
        [
          row.code,
          row.name,
          row.level,
          row.parentCode,
          row.status,
          row.sourceName,
          row.sourceUrl,
          row.sourceSnapshotDate
        ]
      );
    }
    for (const row of rows.filter((item) => item.level === "prefecture")) {
      await client.query(
        `INSERT INTO administrative_regions(
           code, name, level, parent_code, status,
           source_name, source_url, source_snapshot_date
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date)
         ON CONFLICT (code) DO UPDATE
         SET name = EXCLUDED.name,
             level = EXCLUDED.level,
             parent_code = EXCLUDED.parent_code,
             status = EXCLUDED.status,
             source_name = EXCLUDED.source_name,
             source_url = EXCLUDED.source_url,
             source_snapshot_date = EXCLUDED.source_snapshot_date,
             updated_at = now()`,
        [
          row.code,
          row.name,
          row.level,
          row.parentCode,
          row.status,
          row.sourceName,
          row.sourceUrl,
          row.sourceSnapshotDate
        ]
      );
    }
  });
  return rows.length;
};

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  const csvPath = path.resolve(
    process.argv[2] ?? "database/seeds/administrative-regions.csv"
  );
  importAdministrativeRegions(csvPath)
    .then(async (count) => {
      console.log(`Imported ${count} administrative regions`);
      await closePool();
    })
    .catch(async (error) => {
      console.error(error);
      await closePool();
      process.exitCode = 1;
    });
}
