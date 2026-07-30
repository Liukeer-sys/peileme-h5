import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, withTransaction } from "../server/db.js";
import { readCsvRecords } from "./lib/csv.js";
import { assertGovernmentHttpsUrl } from "./lib/official-source.js";

const header = [
  "region_code",
  "region_name",
  "year",
  "parameter_type",
  "amount_fen",
  "source_name",
  "source_url",
  "source_published_at",
  "status"
] as const;

type RegionalParameterRow = {
  regionCode: string;
  regionName: string;
  year: number;
  parameterType:
    | "minimum_monthly_wage"
    | "employee_average_monthly_wage";
  amountFen: string;
  sourceName: string;
  sourceUrl: string;
  sourcePublishedAt: string;
  status: "draft" | "verified" | "stale";
};

const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;

const isIsoDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
};

const loadRegionalParameters = async (csvPath: string) => {
  const records = await readCsvRecords(csvPath, header);
  if (records.length === 0) {
    throw new Error("Regional-parameter CSV must contain at least one row");
  }

  const keys = new Set<string>();
  return records.map((record, index): RegionalParameterRow => {
    const rowNumber = index + 2;
    if (!/^\d{6}$/.test(record.region_code)) {
      throw new Error(
        `Row ${rowNumber}: region_code must contain exactly six digits`
      );
    }
    if (!record.region_name) {
      throw new Error(`Row ${rowNumber}: region_name is required`);
    }
    if (!/^\d{4}$/.test(record.year)) {
      throw new Error(`Row ${rowNumber}: year must contain four digits`);
    }
    const year = Number(record.year);
    if (year < 2000 || year > 2100) {
      throw new Error(`Row ${rowNumber}: year must be between 2000 and 2100`);
    }
    if (
      record.parameter_type !== "minimum_monthly_wage" &&
      record.parameter_type !== "employee_average_monthly_wage"
    ) {
      throw new Error(
        `Row ${rowNumber}: invalid parameter_type ${record.parameter_type}`
      );
    }
    if (!/^\d+$/.test(record.amount_fen)) {
      throw new Error(`Row ${rowNumber}: amount_fen must be a positive integer`);
    }
    const amountFen = BigInt(record.amount_fen);
    if (amountFen <= 0n || amountFen > MAX_POSTGRES_BIGINT) {
      throw new Error(
        `Row ${rowNumber}: amount_fen must fit a positive PostgreSQL BIGINT`
      );
    }
    if (!record.source_name) {
      throw new Error(`Row ${rowNumber}: source_name is required`);
    }
    assertGovernmentHttpsUrl(record.source_url, rowNumber);
    if (!isIsoDate(record.source_published_at)) {
      throw new Error(
        `Row ${rowNumber}: source_published_at must be an ISO date`
      );
    }
    if (
      record.status !== "draft" &&
      record.status !== "verified" &&
      record.status !== "stale"
    ) {
      throw new Error(`Row ${rowNumber}: invalid status ${record.status}`);
    }

    const key = `${record.region_code}:${year}:${record.parameter_type}`;
    if (keys.has(key)) {
      throw new Error(`Row ${rowNumber}: duplicate regional parameter ${key}`);
    }
    keys.add(key);

    return {
      regionCode: record.region_code,
      regionName: record.region_name,
      year,
      parameterType: record.parameter_type,
      amountFen: amountFen.toString(),
      sourceName: record.source_name,
      sourceUrl: record.source_url,
      sourcePublishedAt: record.source_published_at,
      status: record.status
    };
  });
};

export const importRegionalParameters = async (csvPath: string) => {
  const rows = await loadRegionalParameters(csvPath);
  await withTransaction(async (client) => {
    const regionCodes = [...new Set(rows.map((row) => row.regionCode))].sort();
    const regions = await client.query<{
      code: string;
      name: string;
      status: string;
    }>(
      `SELECT code, name, status
       FROM administrative_regions
       WHERE code = ANY($1::text[])
       ORDER BY code
       FOR SHARE`,
      [regionCodes]
    );
    const regionState = new Map(
      regions.rows.map((region) => [
        region.code,
        { name: region.name, status: region.status }
      ])
    );
    for (const row of rows) {
      const region = regionState.get(row.regionCode);
      if (!region) {
        throw new Error(`Unknown administrative region ${row.regionCode}`);
      }
      if (region.name !== row.regionName) {
        throw new Error(
          `Region ${row.regionCode} is named ${region.name}, received ${row.regionName}`
        );
      }
      if (region.status !== "active") {
        throw new Error(`Administrative region ${row.regionCode} is not active`);
      }
    }

    for (const row of rows) {
      await client.query(
        `INSERT INTO regional_parameters(
           region_code, region_name, year, parameter_type, amount_fen,
           source_name, source_url, source_published_at, status
         )
         VALUES ($1, $2, $3, $4, $5::bigint, $6, $7, $8::date, $9)
         ON CONFLICT (region_code, year, parameter_type) DO UPDATE
         SET region_name = EXCLUDED.region_name,
             amount_fen = EXCLUDED.amount_fen,
             source_name = EXCLUDED.source_name,
             source_url = EXCLUDED.source_url,
             source_published_at = EXCLUDED.source_published_at,
             status = EXCLUDED.status,
             updated_at = now()`,
        [
          row.regionCode,
          row.regionName,
          row.year,
          row.parameterType,
          row.amountFen,
          row.sourceName,
          row.sourceUrl,
          row.sourcePublishedAt,
          row.status
        ]
      );
    }
  });
  return rows.length;
};

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  const csvPath = path.resolve(
    process.argv[2] ?? "database/seeds/regional-parameters.csv"
  );
  importRegionalParameters(csvPath)
    .then(async (count) => {
      console.log(`Imported ${count} regional parameters`);
      await closePool();
    })
    .catch(async (error) => {
      console.error(error);
      await closePool();
      process.exitCode = 1;
    });
}
