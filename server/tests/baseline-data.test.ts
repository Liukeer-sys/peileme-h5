import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, query } from "../db.js";
import { runMigrations } from "../migrate.js";
import { importBundledPolicyData } from "../modules/policy/baseline-data.js";

beforeAll(async () => {
  await runMigrations();
  await query("TRUNCATE TABLE administrative_regions CASCADE");
});

afterAll(async () => {
  await closePool();
});

describe("bundled production policy baseline", () => {
  it("imports the complete region snapshot and current parameters idempotently", async () => {
    await expect(importBundledPolicyData()).resolves.toEqual({
      administrativeRegions: 364,
      regionalParameters: 63
    });
    const first = await query<{
      regions: string;
      parameters: string;
      province_name: string;
      city_parent: string;
      region_updated_at: Date;
      parameter_updated_at: Date;
    }>(
      `SELECT
         (SELECT count(*)::text FROM administrative_regions) AS regions,
         (SELECT count(*)::text FROM regional_parameters) AS parameters,
         (SELECT name FROM administrative_regions WHERE code = '420000') AS province_name,
         (SELECT parent_code FROM administrative_regions WHERE code = '420100') AS city_parent,
         (SELECT max(updated_at) FROM administrative_regions) AS region_updated_at,
         (SELECT max(updated_at) FROM regional_parameters) AS parameter_updated_at`
    );
    expect(first.rows[0]).toMatchObject({
      regions: "364",
      parameters: "63",
      province_name: "湖北省",
      city_parent: "420000"
    });

    await importBundledPolicyData();
    const second = await query<{
      region_updated_at: Date;
      parameter_updated_at: Date;
    }>(
      `SELECT
         (SELECT max(updated_at) FROM administrative_regions) AS region_updated_at,
         (SELECT max(updated_at) FROM regional_parameters) AS parameter_updated_at`
    );
    expect(second.rows[0]).toEqual({
      region_updated_at: first.rows[0].region_updated_at,
      parameter_updated_at: first.rows[0].parameter_updated_at
    });
  });
});
