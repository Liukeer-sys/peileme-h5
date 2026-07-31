import path from "node:path";
import { withTransaction } from "../../db.js";
import { readCsvRecords } from "../../lib/csv.js";
import { assertGovernmentHttpsUrl } from "../../lib/official-source.js";

const regionHeader = [
  "code",
  "name",
  "level",
  "parent_code",
  "status",
  "source_name",
  "source_url",
  "source_snapshot_date"
] as const;

const parameterHeader = [
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

const isIsoDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value;
};

const requireIsoDate = (value: string, field: string) => {
  if (!isIsoDate(value)) throw new Error(`${field} must be an ISO date`);
  return value;
};

const requireGovernmentUrl = (value: string, row: number) => {
  assertGovernmentHttpsUrl(value, row);
  return value;
};

export const importBundledPolicyData = async (
  seedDirectory = path.resolve(process.cwd(), "database/seeds")
) => {
  const regionRecords = await readCsvRecords(
    path.join(seedDirectory, "administrative-regions.csv"),
    regionHeader
  );
  const parameterRecords = await readCsvRecords(
    path.join(seedDirectory, "regional-parameters.csv"),
    parameterHeader
  );
  const regionCodes = new Set<string>();
  const regions = regionRecords.map((record, index) => {
    const row = index + 2;
    if (!/^\d{6}$/.test(record.code) || regionCodes.has(record.code)) {
      throw new Error(`Administrative region row ${row} has an invalid or duplicate code`);
    }
    regionCodes.add(record.code);
    if (!record.name.trim()) throw new Error(`Administrative region row ${row} has no name`);
    if (!(["province", "prefecture"] as const).includes(record.level as never)) {
      throw new Error(`Administrative region row ${row} has an invalid level`);
    }
    if (!(["active", "retired"] as const).includes(record.status as never)) {
      throw new Error(`Administrative region row ${row} has an invalid status`);
    }
    if (record.level === "province" && record.parent_code) {
      throw new Error(`Province ${record.code} cannot have a parent`);
    }
    if (
      record.level === "prefecture" &&
      (!/^\d{6}$/.test(record.parent_code) ||
        !record.parent_code.endsWith("0000") ||
        record.parent_code.slice(0, 2) !== record.code.slice(0, 2))
    ) {
      throw new Error(`Prefecture ${record.code} has an invalid parent`);
    }
    return {
      code: record.code,
      name: record.name,
      level: record.level as "province" | "prefecture",
      parentCode: record.parent_code || null,
      status: record.status as "active" | "retired",
      sourceName: record.source_name,
      sourceUrl: requireGovernmentUrl(record.source_url, row),
      sourceSnapshotDate: requireIsoDate(
        record.source_snapshot_date,
        `Administrative region row ${row} source_snapshot_date`
      )
    };
  });
  const parameterKeys = new Set<string>();
  const parameters = parameterRecords.map((record, index) => {
    const row = index + 2;
    const key = `${record.region_code}:${record.year}:${record.parameter_type}`;
    if (!/^\d{6}$/.test(record.region_code) || parameterKeys.has(key)) {
      throw new Error(`Regional parameter row ${row} has an invalid or duplicate key`);
    }
    parameterKeys.add(key);
    const year = Number(record.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new Error(`Regional parameter row ${row} has an invalid year`);
    }
    if (!/^\d+$/.test(record.amount_fen) || BigInt(record.amount_fen) <= 0n) {
      throw new Error(`Regional parameter row ${row} has an invalid amount`);
    }
    if (
      !["minimum_monthly_wage", "employee_average_monthly_wage"].includes(
        record.parameter_type
      )
    ) {
      throw new Error(`Regional parameter row ${row} has an invalid type`);
    }
    if (!(["draft", "verified", "stale"] as const).includes(record.status as never)) {
      throw new Error(`Regional parameter row ${row} has an invalid status`);
    }
    return {
      regionCode: record.region_code,
      regionName: record.region_name,
      year,
      parameterType: record.parameter_type,
      amountFen: record.amount_fen,
      sourceName: record.source_name,
      sourceUrl: requireGovernmentUrl(record.source_url, row),
      sourcePublishedAt: requireIsoDate(
        record.source_published_at,
        `Regional parameter row ${row} source_published_at`
      ),
      status: record.status
    };
  });

  await withTransaction(async (client) => {
    await client.query(
      "LOCK TABLE administrative_regions IN SHARE ROW EXCLUSIVE MODE"
    );
    const existing = await client.query<{
      code: string;
      name: string;
      level: string;
      parent_code: string | null;
    }>(
      `SELECT code, name, level, parent_code
         FROM administrative_regions
        WHERE code = ANY($1::text[])
        ORDER BY code
        FOR UPDATE`,
      [[...regionCodes].sort()]
    );
    const existingByCode = new Map(existing.rows.map((row) => [row.code, row]));
    for (const region of regions) {
      const current = existingByCode.get(region.code);
      if (
        current &&
        (current.name !== region.name ||
          current.level !== region.level ||
          current.parent_code !== region.parentCode)
      ) {
        throw new Error(`Administrative identity mismatch for ${region.code}`);
      }
    }

    const upsertRegion = (region: (typeof regions)[number]) =>
      client.query(
        `INSERT INTO administrative_regions(
           code, name, level, parent_code, status,
           source_name, source_url, source_snapshot_date
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date)
         ON CONFLICT (code) DO UPDATE
         SET status = EXCLUDED.status,
             source_name = EXCLUDED.source_name,
             source_url = EXCLUDED.source_url,
             source_snapshot_date = EXCLUDED.source_snapshot_date,
             updated_at = now()
         WHERE (administrative_regions.status,
                administrative_regions.source_name,
                administrative_regions.source_url,
                administrative_regions.source_snapshot_date)
           IS DISTINCT FROM
               (EXCLUDED.status,
                EXCLUDED.source_name,
                EXCLUDED.source_url,
                EXCLUDED.source_snapshot_date)`,
        [
          region.code,
          region.name,
          region.level,
          region.parentCode,
          region.status,
          region.sourceName,
          region.sourceUrl,
          region.sourceSnapshotDate
        ]
      );
    for (const region of regions.filter((item) => item.level === "province")) {
      await upsertRegion(region);
    }
    for (const region of regions.filter((item) => item.level === "prefecture")) {
      await upsertRegion(region);
    }

    const parameterRegionCodes = [...new Set(parameters.map((row) => row.regionCode))];
    const parameterRegions = await client.query<{
      code: string;
      name: string;
      status: string;
    }>(
      `SELECT code, name, status
         FROM administrative_regions
        WHERE code = ANY($1::text[])
        ORDER BY code
        FOR SHARE`,
      [parameterRegionCodes.sort()]
    );
    const parameterRegionByCode = new Map(
      parameterRegions.rows.map((region) => [region.code, region])
    );
    for (const parameter of parameters) {
      const region = parameterRegionByCode.get(parameter.regionCode);
      if (
        !region ||
        region.name !== parameter.regionName ||
        region.status !== "active"
      ) {
        throw new Error(`Regional parameter identity mismatch for ${parameter.regionCode}`);
      }
      await client.query(
        `INSERT INTO regional_parameters(
           region_code, region_name, year, parameter_type, amount_fen,
           source_name, source_url, source_published_at, status
         ) VALUES ($1, $2, $3, $4, $5::bigint, $6, $7, $8::date, $9)
         ON CONFLICT (region_code, year, parameter_type) DO UPDATE
         SET region_name = EXCLUDED.region_name,
             amount_fen = EXCLUDED.amount_fen,
             source_name = EXCLUDED.source_name,
             source_url = EXCLUDED.source_url,
             source_published_at = EXCLUDED.source_published_at,
             status = EXCLUDED.status,
             updated_at = now()
         WHERE (regional_parameters.region_name,
                regional_parameters.amount_fen,
                regional_parameters.source_name,
                regional_parameters.source_url,
                regional_parameters.source_published_at,
                regional_parameters.status)
           IS DISTINCT FROM
               (EXCLUDED.region_name,
                EXCLUDED.amount_fen,
                EXCLUDED.source_name,
                EXCLUDED.source_url,
                EXCLUDED.source_published_at,
                EXCLUDED.status)`,
        [
          parameter.regionCode,
          parameter.regionName,
          parameter.year,
          parameter.parameterType,
          parameter.amountFen,
          parameter.sourceName,
          parameter.sourceUrl,
          parameter.sourcePublishedAt,
          parameter.status
        ]
      );
    }
  });

  return {
    administrativeRegions: regions.length,
    regionalParameters: parameters.length
  };
};
