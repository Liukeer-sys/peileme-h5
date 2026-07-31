import bcrypt from "bcryptjs";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { closePool, getPool, query } from "../db.js";
import { runMigrations } from "../migrate.js";
import { seed } from "../seed.js";

let adminToken = "";
let userToken = "";
let analystToken = "";
let inviteCode = "";
let anonymousAssessmentId = "";
let aiAssessmentId = "";
let aiUploadId = "";

const visitorHeaders = {
  "x-visitor-id": "visitor_test_12345678",
  "x-session-id": "session_test_12345678"
};

beforeAll(async () => {
  await runMigrations();
  await query(`
    TRUNCATE TABLE
      admin_audit_logs,
      uploads,
      policy_calculation_snapshots,
      regional_parameters,
      administrative_regions,
      policy_rule_versions,
      policy_rule_sets,
      role_capabilities,
      announcements,
      assessments,
      analytics_events,
      visitor_sessions,
      access_grants,
      invite_redemptions,
      invite_codes,
      refresh_sessions,
      otp_codes,
      users
    RESTART IDENTITY CASCADE
  `);
  const passwordHash = await bcrypt.hash("AdminPass123", 4);
  await query(
    `INSERT INTO users
       (email, display_name, password_hash, role, email_verified_at)
     VALUES ('admin@peileme.test', '测试管理员', $1, 'admin', now())`,
    [passwordHash]
  );
});

afterAll(async () => {
  await closePool();
});

describe("CORS policy", () => {
  it("authorizes configured main and AI origins", async () => {
    for (const origin of [
      "http://localhost:5173",
      "http://ai.localhost:5174"
    ]) {
      const response = await request(createApp())
        .get("/api/public/config")
        .set("origin", origin)
        .expect(200);
      expect(response.headers["access-control-allow-origin"]).toBe(origin);
      expect(response.headers["access-control-allow-credentials"]).toBe("true");
    }
  });

  it("does not authorize an unknown origin", async () => {
    const response = await request(createApp())
      .get("/api/public/config")
      .set("origin", "https://unknown.example")
      .expect(200);

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("publishes upload limits only on the AI product host", async () => {
    const main = await request(createApp())
      .get("/api/public/config")
      .set("host", "localhost")
      .expect(200);
    const ai = await request(createApp())
      .get("/api/public/config")
      .set("host", "ai.localhost")
      .expect(200);

    expect(main.body).not.toHaveProperty("maxUploadMb");
    expect(ai.body.maxUploadMb).toBeGreaterThan(0);
  });
});

describe("policy persistence foundation", () => {
  const runImport = (script: string, csvPath: string) =>
    spawnSync(
      path.resolve("node_modules/.bin/tsx"),
      [path.resolve(script), csvPath],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: process.env
      }
    );

  const runImportAsync = (
    script: string,
    csvPath: string,
    env: NodeJS.ProcessEnv = process.env,
    timeoutMs = 8_000
  ) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          path.resolve("node_modules/.bin/tsx"),
          [path.resolve(script), csvPath],
          {
            cwd: path.resolve("."),
            env,
            stdio: ["ignore", "pipe", "pipe"]
          }
        );
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`Import timed out after ${timeoutMs}ms: ${script}`));
        }, timeoutMs);
        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once("close", (status) => {
          clearTimeout(timeout);
          resolve({ status, stdout, stderr });
        });
      }
    );

  const waitUntil = async (
    predicate: () => Promise<boolean>,
    timeoutMs = 3_000
  ) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Condition was not met within ${timeoutMs}ms`);
  };

  it("installs the versioned policy schema", async () => {
    const tables = await query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [[
        "administrative_regions",
        "announcements",
        "policy_calculation_snapshots",
        "policy_rule_sets",
        "policy_rule_versions",
        "regional_parameters",
        "role_capabilities"
      ]]
    );

    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "administrative_regions",
      "announcements",
      "policy_calculation_snapshots",
      "policy_rule_sets",
      "policy_rule_versions",
      "regional_parameters",
      "role_capabilities"
    ]);
  });

  it("adds assessment policy provenance columns and indexes", async () => {
    const columns = await query<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'assessments'
         AND column_name = ANY($1::text[])
       ORDER BY column_name`,
      [[
        "accuracy_level",
        "input_snapshot",
        "product_channel",
        "result_snapshot",
        "rule_version_id"
      ]]
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "accuracy_level",
      "input_snapshot",
      "product_channel",
      "result_snapshot",
      "rule_version_id"
    ]);
    expect(columns.rows.find((row) => row.column_name === "product_channel")).toMatchObject({
      is_nullable: "NO",
      column_default: "'main'::text"
    });

    const indexes = await query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = ANY($1::text[])
       ORDER BY indexname`,
      [[
        "administrative_regions_parent_idx",
        "assessments_channel_time_idx",
        "policy_rule_versions_status_idx",
        "regional_parameters_lookup_idx"
      ]]
    );
    expect(indexes.rows).toHaveLength(4);
    expect(
      indexes.rows.find((row) => row.indexname === "administrative_regions_parent_idx")
        ?.indexdef
    ).toContain("(parent_code, status, name)");
    expect(
      indexes.rows.find((row) => row.indexname === "assessments_channel_time_idx")
        ?.indexdef
    ).toContain("(product_channel, created_at DESC)");
    expect(
      indexes.rows.find((row) => row.indexname === "regional_parameters_lookup_idx")
        ?.indexdef
    ).toContain("(region_code, parameter_type, year DESC)");
    expect(
      indexes.rows.find((row) => row.indexname === "policy_rule_versions_status_idx")
        ?.indexdef
    ).toContain("(rule_set_id, status, effective_from DESC)");
  });

  it("installs policy administration lifecycle columns", async () => {
    const columns = await query<{
      table_name: string;
      column_name: string;
    }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (
           (table_name = 'announcements' AND column_name = ANY($1::text[])) OR
           (table_name = 'role_capabilities' AND column_name = 'created_at')
         )
       ORDER BY table_name, column_name`,
      [["starts_at", "ends_at"]]
    );
    expect(columns.rows).toEqual([
      { table_name: "announcements", column_name: "ends_at" },
      { table_name: "announcements", column_name: "starts_at" },
      { table_name: "role_capabilities", column_name: "created_at" }
    ]);
  });

  it("enforces policy foreign keys and check constraints", async () => {
    const constraints = await query<{
      table_name: string;
      constraint_type: string;
      definition: string;
    }>(
      `SELECT c.relname AS table_name,
              CASE con.contype
                WHEN 'c' THEN 'CHECK'
                WHEN 'f' THEN 'FOREIGN KEY'
                WHEN 'u' THEN 'UNIQUE'
                WHEN 'p' THEN 'PRIMARY KEY'
              END AS constraint_type,
              pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = ANY($1::text[])`,
      [[
        "administrative_regions",
        "announcements",
        "assessments",
        "policy_calculation_snapshots",
        "policy_rule_sets",
        "policy_rule_versions",
        "regional_parameters",
        "role_capabilities"
      ]]
    );
    const definitions = constraints.rows.map(
      (row) => `${row.table_name}:${row.constraint_type}:${row.definition}`
    );
    expect(definitions.some((value) =>
      value.includes("assessments:FOREIGN KEY:FOREIGN KEY (rule_version_id)")
    )).toBe(true);
    expect(definitions.some((value) =>
      value.includes(
        "policy_rule_sets:FOREIGN KEY:FOREIGN KEY (id, active_version_id) " +
          "REFERENCES policy_rule_versions(rule_set_id, id) " +
          "ON DELETE SET NULL (active_version_id)"
      )
    )).toBe(true);
    expect(definitions.some((value) =>
      value.includes("regional_parameters:FOREIGN KEY:FOREIGN KEY (region_code)")
    )).toBe(true);
    expect(definitions.some((value) =>
      value.includes("policy_calculation_snapshots:UNIQUE:UNIQUE (assessment_id)")
    )).toBe(true);
    expect(definitions.some((value) =>
      value.includes("role_capabilities:PRIMARY KEY:PRIMARY KEY (role, capability)")
    )).toBe(true);
    expect(definitions.some((value) =>
      value.includes("policy_rule_versions:CHECK:CHECK ((version > 0))")
    )).toBe(true);
    expect(definitions.some((value) =>
      value.includes(
        "announcements:CHECK:CHECK (((ends_at IS NULL) OR " +
          "(starts_at IS NULL) OR (ends_at >= starts_at)))"
      )
    )).toBe(true);
  });

  it("rejects an announcement whose end precedes its start", async () => {
    let invalidRejected = false;
    try {
      await query(
        `INSERT INTO announcements(
           title, body, placement, status, starts_at, ends_at
         )
         VALUES (
           '时间约束测试', '结束时间不得早于开始时间', 'all', 'draft',
           TIMESTAMPTZ '2026-08-02 00:00:00+08',
           TIMESTAMPTZ '2026-08-01 00:00:00+08'
         )`
      );
    } catch {
      invalidRejected = true;
    } finally {
      await query("DELETE FROM announcements WHERE title = '时间约束测试'");
    }
    expect(invalidRejected).toBe(true);
  });

  it("keeps an active version inside its owning rule set", async () => {
    const ruleSets = await query<{ id: string; code: string }>(
      `INSERT INTO policy_rule_sets(code, name, product_channel)
       VALUES
         ('cross-fk-a', '复合外键测试 A', 'main'),
         ('cross-fk-b', '复合外键测试 B', 'main')
       RETURNING id, code`
    );
    const ruleSetA = ruleSets.rows.find((row) => row.code === "cross-fk-a")!;
    const ruleSetB = ruleSets.rows.find((row) => row.code === "cross-fk-b")!;
    const versions = await query<{ id: string; rule_set_id: string }>(
      `INSERT INTO policy_rule_versions(
         rule_set_id, version, status, definition, effective_from, published_at
       )
       VALUES
         ($1, 1, 'published', '{}'::jsonb, DATE '2026-01-01', now()),
         ($2, 1, 'published', '{}'::jsonb, DATE '2026-01-01', now())
       RETURNING id, rule_set_id`,
      [ruleSetA.id, ruleSetB.id]
    );
    const versionA = versions.rows.find(
      (row) => row.rule_set_id === ruleSetA.id
    )!;
    const versionB = versions.rows.find(
      (row) => row.rule_set_id === ruleSetB.id
    )!;

    let crossRuleSetRejected = false;
    let pointerAfterDelete: string | null = "not-queried";
    try {
      try {
        await query(
          "UPDATE policy_rule_sets SET active_version_id = $2 WHERE id = $1",
          [ruleSetA.id, versionB.id]
        );
      } catch {
        crossRuleSetRejected = true;
      }

      await query(
        "UPDATE policy_rule_sets SET active_version_id = $2 WHERE id = $1",
        [ruleSetA.id, versionA.id]
      );
      await query("DELETE FROM policy_rule_versions WHERE id = $1", [versionA.id]);
      const afterDelete = await query<{ active_version_id: string | null }>(
        "SELECT active_version_id FROM policy_rule_sets WHERE id = $1",
        [ruleSetA.id]
      );
      pointerAfterDelete = afterDelete.rows[0].active_version_id;
    } finally {
      await query(
        "DELETE FROM policy_rule_sets WHERE id = ANY($1::uuid[])",
        [[ruleSetA.id, ruleSetB.id]]
      );
    }

    expect(crossRuleSetRejected).toBe(true);
    expect(pointerAfterDelete).toBeNull();
  });

  it("seeds the published severance baseline idempotently", async () => {
    await seed();
    await seed();

    const ruleSet = await query<{
      code: string;
      name: string;
      product_channel: string;
      active_version_id: string | null;
    }>(
      `SELECT code, name, product_channel, active_version_id
       FROM policy_rule_sets
       WHERE code = 'cn-severance'`
    );
    expect(ruleSet.rows).toHaveLength(1);
    expect(ruleSet.rows[0]).toMatchObject({
      name: "中国大陆离职经济补偿规则",
      product_channel: "main"
    });

    const versions = await query<{
      id: string;
      version: number;
      status: string;
      definition: Record<string, unknown>;
      source_snapshot: unknown;
      effective_from: string;
      published_at: string;
      published_after_effective: boolean;
    }>(
      `SELECT id, version, status, definition, source_snapshot,
              effective_from::text, published_at::text,
              published_at > effective_from::timestamptz
                AS published_after_effective
       FROM policy_rule_versions
       WHERE rule_set_id = (
         SELECT id FROM policy_rule_sets WHERE code = 'cn-severance'
       )`
    );
    expect(versions.rows).toHaveLength(1);
    expect(versions.rows[0]).toMatchObject({
      version: 1,
      status: "published",
      effective_from: "2013-07-01",
      published_after_effective: true,
      definition: {
        schemaVersion: 2,
        decisionModel: {
          mutualAgreement: {
            employerProposed: {
              compensation: "N"
            },
            employeeProposed: {
              compensation: "ZERO",
              agreementReviewRequired: true
            }
          },
          article40EmployerTermination: {
            notice30Days: {
              compensation: "N",
              noticePayMonths: 0
            },
            paymentInLieu: {
              compensation: "N",
              noticePayMonths: 1
            }
          },
          employeeTermination: {
            article38: {
              compensation: "N"
            },
            voluntaryResignation: {
              compensation: "ZERO"
            }
          },
          unlawfulTermination: {
            primaryRemedy: "CONTINUE_PERFORMANCE",
            fallbackCompensation: "TWO_N",
            fallbackWhen: [
              "EMPLOYEE_DOES_NOT_REQUEST_CONTINUATION",
              "CONTINUED_PERFORMANCE_IMPOSSIBLE"
            ]
          },
          unclear: {
            result: "REVIEW"
          }
        },
        serviceYearFraction: {
          lessThanSixMonths: 0.5,
          atLeastSixMonths: 1
        },
        highSalaryCap: {
          localAverageMultiplier: 3,
          serviceYearCap: 12
        }
      }
    });
    expect(versions.rows[0].definition).not.toHaveProperty("terminationModes");
    expect(versions.rows[0].definition).not.toHaveProperty("serviceFraction");
    expect(versions.rows[0].source_snapshot).toEqual([
      {
        instrument: "中华人民共和国劳动合同法",
        article: "第三十六条",
        canonicalUrl:
          "https://www.mohrss.gov.cn/xxgk2020/fdzdgknr/zcfg/fl/202011/t20201102_394622_wap.html",
        appliesTo: "mutual_agreement"
      },
      {
        instrument: "中华人民共和国劳动合同法",
        article: "第三十七条",
        canonicalUrl:
          "https://www.mohrss.gov.cn/xxgk2020/fdzdgknr/zcfg/fl/202011/t20201102_394622_wap.html",
        appliesTo: "voluntary_resignation"
      },
      {
        instrument: "中华人民共和国劳动合同法",
        article: "第三十八条",
        canonicalUrl:
          "https://www.mohrss.gov.cn/xxgk2020/fdzdgknr/zcfg/fl/202011/t20201102_394622_wap.html",
        appliesTo: "employee_statutory_termination"
      },
      {
        instrument: "中华人民共和国劳动合同法",
        article: "第四十条",
        canonicalUrl:
          "https://www.mohrss.gov.cn/xxgk2020/fdzdgknr/zcfg/fl/202011/t20201102_394622_wap.html",
        appliesTo: "employer_notice_or_payment_in_lieu"
      },
      {
        instrument: "中华人民共和国劳动合同法",
        article: "第四十六条",
        canonicalUrl:
          "https://www.mohrss.gov.cn/xxgk2020/fdzdgknr/zcfg/fl/202011/t20201102_394622_wap.html",
        appliesTo: "statutory_compensation_eligibility"
      },
      {
        instrument: "中华人民共和国劳动合同法",
        article: "第四十七条",
        canonicalUrl:
          "https://www.mohrss.gov.cn/xxgk2020/fdzdgknr/zcfg/fl/202011/t20201102_394622_wap.html",
        appliesTo: "compensation_years_and_salary_cap"
      },
      {
        instrument: "中华人民共和国劳动合同法",
        article: "第四十八条",
        canonicalUrl:
          "https://www.mohrss.gov.cn/xxgk2020/fdzdgknr/zcfg/fl/202011/t20201102_394622_wap.html",
        appliesTo: "unlawful_termination_remedy_priority"
      },
      {
        instrument: "中华人民共和国劳动合同法",
        article: "第八十七条",
        canonicalUrl:
          "https://www.mohrss.gov.cn/xxgk2020/fdzdgknr/zcfg/fl/202011/t20201102_394622_wap.html",
        appliesTo: "unlawful_termination_two_n"
      },
      {
        instrument: "中华人民共和国劳动合同法实施条例",
        article: "第二十七条",
        canonicalUrl:
          "https://www.mohrss.gov.cn/xxgk2020/fdzdgknr/zcfg/fg/202011/t20201103_394939_wap.html",
        appliesTo: "average_monthly_wage_definition"
      }
    ]);
    expect(ruleSet.rows[0].active_version_id).toBe(versions.rows[0].id);

    await seed();
    const reseeded = await query<{ published_at: string }>(
      `SELECT published_at::text
       FROM policy_rule_versions
       WHERE id = $1`,
      [versions.rows[0].id]
    );
    expect(reseeded.rows[0].published_at).toBe(versions.rows[0].published_at);

    const capabilities = await query<{ role: string; capability: string }>(
      `SELECT role, capability
       FROM role_capabilities
       ORDER BY role, capability`
    );
    expect(capabilities.rows).toEqual([
      { role: "admin", capability: "policy.publish" },
      { role: "admin", capability: "policy.read" },
      { role: "admin", capability: "policy.write" },
      { role: "analyst", capability: "policy.read" }
    ]);
  });

  it("keeps all baseline timestamps stable when seed data is unchanged", async () => {
    await seed();
    const readTimestamps = () =>
      query<{
        rule_set_created_at: string;
        rule_set_updated_at: string;
        version_created_at: string;
        version_updated_at: string;
        published_at: string;
      }>(
        `SELECT
           prs.created_at::text AS rule_set_created_at,
           prs.updated_at::text AS rule_set_updated_at,
           prv.created_at::text AS version_created_at,
           prv.updated_at::text AS version_updated_at,
           prv.published_at::text AS published_at
         FROM policy_rule_sets prs
         JOIN policy_rule_versions prv ON prv.rule_set_id = prs.id
         WHERE prs.code = 'cn-severance' AND prv.version = 1`
      );
    const before = await readTimestamps();
    await seed();
    const after = await readTimestamps();
    expect(after.rows).toEqual(before.rows);
  });

  it("never mutates an existing published baseline definition or source", async () => {
    await seed();
    const original = await query<{
      id: string;
      definition: unknown;
      source_snapshot: unknown;
    }>(
      `SELECT id, definition, source_snapshot
         FROM policy_rule_versions
        WHERE rule_set_id = (
          SELECT id FROM policy_rule_sets WHERE code = 'cn-severance'
        )
          AND version = 1`
    );
    const customized = await query<{
      definition_text: string;
      source_snapshot_text: string;
      updated_at: string;
    }>(
      `UPDATE policy_rule_versions
          SET definition = '{"schemaVersion":2,"managedBy":"admin"}'::jsonb,
              source_snapshot =
                '[{"source":"admin-published-custom-source"}]'::jsonb
        WHERE rule_set_id = (
          SELECT id FROM policy_rule_sets WHERE code = 'cn-severance'
        )
          AND version = 1
          AND status = 'published'
        RETURNING definition::text AS definition_text,
                  source_snapshot::text AS source_snapshot_text,
                  updated_at::text`
    );
    try {
      await seed();
      const afterSeed = await query<{
        definition_text: string;
        source_snapshot_text: string;
        updated_at: string;
      }>(
        `SELECT definition::text AS definition_text,
                source_snapshot::text AS source_snapshot_text,
                updated_at::text
           FROM policy_rule_versions
          WHERE id = $1`,
        [original.rows[0].id]
      );
      expect(afterSeed.rows[0]).toEqual(customized.rows[0]);
    } finally {
      await query(
        `UPDATE policy_rule_versions
            SET definition = $2::jsonb,
                source_snapshot = $3::jsonb
          WHERE id = $1`,
        [
          original.rows[0].id,
          JSON.stringify(original.rows[0].definition),
          JSON.stringify(original.rows[0].source_snapshot)
        ]
      );
    }
  });

  it("imports the official administrative-region snapshot idempotently", async () => {
    const csvPath = path.resolve("database/seeds/administrative-regions.csv");
    const first = runImport("scripts/import-administrative-regions.ts", csvPath);
    expect(first.status, first.stderr).toBe(0);
    const second = runImport("scripts/import-administrative-regions.ts", csvPath);
    expect(second.status, second.stderr).toBe(0);

    const coverage = await query<{
      province_count: string;
      prefecture_count: string;
      orphan_count: string;
    }>(
      `SELECT
         count(*) FILTER (
           WHERE child.level = 'province' AND child.status = 'active'
         )::text AS province_count,
         count(*) FILTER (
           WHERE child.level = 'prefecture' AND child.status = 'active'
         )::text AS prefecture_count,
         count(*) FILTER (
           WHERE child.level = 'prefecture'
             AND child.status = 'active'
             AND (
               parent.code IS NULL OR
               parent.level <> 'province' OR
               parent.status <> 'active'
             )
         )::text AS orphan_count
       FROM administrative_regions child
       LEFT JOIN administrative_regions parent
         ON parent.code = child.parent_code`
    );
    expect(coverage.rows[0]).toEqual({
      province_count: "31",
      prefecture_count: "333",
      orphan_count: "0"
    });

    const samples = await query<{
      code: string;
      name: string;
      parent_code: string | null;
      source_url: string;
      source_snapshot_date: string;
    }>(
      `SELECT code, name, parent_code, source_url, source_snapshot_date::text
       FROM administrative_regions
       WHERE code = ANY($1::text[])
       ORDER BY code`,
      [["110000", "130100", "310000", "420100", "500000", "510100", "650100"]]
    );
    expect(samples.rows).toEqual([
      expect.objectContaining({ code: "110000", name: "北京市", parent_code: null }),
      expect.objectContaining({ code: "130100", name: "石家庄市", parent_code: "130000" }),
      expect.objectContaining({ code: "310000", name: "上海市", parent_code: null }),
      expect.objectContaining({ code: "420100", name: "武汉市", parent_code: "420000" }),
      expect.objectContaining({ code: "500000", name: "重庆市", parent_code: null }),
      expect.objectContaining({ code: "510100", name: "成都市", parent_code: "510000" }),
      expect.objectContaining({ code: "650100", name: "乌鲁木齐市", parent_code: "650000" })
    ]);
    expect(samples.rows.every((row) =>
      row.source_url ===
        "https://www.mca.gov.cn/mzsj/xzqh/2025/202401xzqh.html" &&
      row.source_snapshot_date === "2024-12-31"
    )).toBe(true);

    const csv = await readFile(csvPath, "utf8");
    const lines = csv.trim().split(/\r?\n/);
    expect(lines[0]).toBe(
      "code,name,level,parent_code,status,source_name,source_url,source_snapshot_date"
    );
    expect(lines).toHaveLength(365);
  });

  it("rejects administrative identity changes and rolls back the batch", async () => {
    const canonicalPath = path.resolve(
      "database/seeds/administrative-regions.csv"
    );
    const tempDir = await mkdtemp(path.join(tmpdir(), "peileme-region-identity-"));
    const header =
      "code,name,level,parent_code,status,source_name,source_url,source_snapshot_date\n";
    const official =
      "民政部,https://www.mca.gov.cn/mzsj/xzqh/2025/202401xzqh.html,2024-12-31\n";
    const mutablePrefix =
      "120000,天津市,province,,active,篡改来源," +
      "https://www.mca.gov.cn/example,2026-01-01\n";
    const renamePath = path.join(tempDir, "rename.csv");
    const reparentPath = path.join(tempDir, "reparent.csv");
    await writeFile(
      renamePath,
      header +
        mutablePrefix +
        `110000,篡改北京市,province,,active,${official}`,
      "utf8"
    );
    await writeFile(
      reparentPath,
      header +
        mutablePrefix +
        `130100,石家庄市,prefecture,139000,active,${official}`,
      "utf8"
    );
    await query(
      `INSERT INTO administrative_regions(
         code, name, level, status, source_name, source_url, source_snapshot_date
       )
       VALUES (
         '139000', '并发身份测试省', 'province', 'active', '测试',
         'https://www.mca.gov.cn/example', DATE '2024-12-31'
       )`
    );

    let renameResult: ReturnType<typeof runImport>;
    let reparentResult: ReturnType<typeof runImport>;
    let afterRename: Array<{
      code: string;
      name: string;
      parent_code: string | null;
      source_name: string;
    }> = [];
    let afterReparent: typeof afterRename = [];
    try {
      renameResult = runImport(
        "scripts/import-administrative-regions.ts",
        renamePath
      );
      afterRename = (
        await query<{
          code: string;
          name: string;
          parent_code: string | null;
          source_name: string;
        }>(
          `SELECT code, name, parent_code, source_name
           FROM administrative_regions
           WHERE code = ANY($1::text[])
           ORDER BY code`,
          [["110000", "120000"]]
        )
      ).rows;
      runImport("scripts/import-administrative-regions.ts", canonicalPath);

      reparentResult = runImport(
        "scripts/import-administrative-regions.ts",
        reparentPath
      );
      afterReparent = (
        await query<{
          code: string;
          name: string;
          parent_code: string | null;
          source_name: string;
        }>(
          `SELECT code, name, parent_code, source_name
           FROM administrative_regions
           WHERE code = ANY($1::text[])
           ORDER BY code`,
          [["120000", "130100"]]
        )
      ).rows;
    } finally {
      runImport("scripts/import-administrative-regions.ts", canonicalPath);
      await query("DELETE FROM administrative_regions WHERE code = '139000'");
      await rm(tempDir, { recursive: true, force: true });
    }

    expect(renameResult!.status, renameResult!.stderr).not.toBe(0);
    expect(reparentResult!.status, reparentResult!.stderr).not.toBe(0);
    expect(afterRename).toEqual([
      {
        code: "110000",
        name: "北京市",
        parent_code: null,
        source_name: "中华人民共和国民政部"
      },
      {
        code: "120000",
        name: "天津市",
        parent_code: null,
        source_name: "中华人民共和国民政部"
      }
    ]);
    expect(afterReparent).toEqual([
      {
        code: "120000",
        name: "天津市",
        parent_code: null,
        source_name: "中华人民共和国民政部"
      },
      {
        code: "130100",
        name: "石家庄市",
        parent_code: "130000",
        source_name: "中华人民共和国民政部"
      }
    ]);
  });

  it(
    "retires a province only when every active child is retired in the same batch",
    async () => {
      const canonicalPath = path.resolve(
        "database/seeds/administrative-regions.csv"
      );
      const tempDir = await mkdtemp(path.join(tmpdir(), "peileme-region-retire-"));
      const partialPath = path.join(tempDir, "partial.csv");
      const completePath = path.join(tempDir, "complete.csv");
      const header =
        "code,name,level,parent_code,status,source_name,source_url,source_snapshot_date\n";
      const source =
        "中华人民共和国民政部," +
        "https://www.mca.gov.cn/mzsj/xzqh/2025/202401xzqh.html,2024-12-31";
      await writeFile(
        partialPath,
        header + `130000,河北省,province,,retired,${source}\n`,
        "utf8"
      );

      let partialResult: ReturnType<typeof runImport>;
      let stateAfterPartial: { parent_status: string; active_children: string };
      let completeResult: ReturnType<typeof runImport>;
      let stateAfterComplete: typeof stateAfterPartial;
      try {
        partialResult = runImport(
          "scripts/import-administrative-regions.ts",
          partialPath
        );
        stateAfterPartial = (
          await query<{
            parent_status: string;
            active_children: string;
          }>(
            `SELECT
               max(status) FILTER (WHERE code = '130000') AS parent_status,
               count(*) FILTER (
                 WHERE parent_code = '130000' AND status = 'active'
               )::text AS active_children
             FROM administrative_regions
             WHERE code = '130000' OR parent_code = '130000'`
          )
        ).rows[0];

        const restored = runImport(
          "scripts/import-administrative-regions.ts",
          canonicalPath
        );
        expect(restored.status, restored.stderr).toBe(0);
        const hebeiRows = await query<{
          code: string;
          name: string;
          level: string;
          parent_code: string | null;
        }>(
          `SELECT code, name, level, parent_code
           FROM administrative_regions
           WHERE code = '130000' OR parent_code = '130000'
           ORDER BY code`
        );
        await writeFile(
          completePath,
          header +
            hebeiRows.rows
              .map(
                (row) =>
                  [
                    row.code,
                    row.name,
                    row.level,
                    row.parent_code ?? "",
                    "retired",
                    source
                  ].join(",")
              )
              .join("\n") +
            "\n",
          "utf8"
        );
        completeResult = runImport(
          "scripts/import-administrative-regions.ts",
          completePath
        );
        stateAfterComplete = (
          await query<{
            parent_status: string;
            active_children: string;
          }>(
            `SELECT
               max(status) FILTER (WHERE code = '130000') AS parent_status,
               count(*) FILTER (
                 WHERE parent_code = '130000' AND status = 'active'
               )::text AS active_children
             FROM administrative_regions
             WHERE code = '130000' OR parent_code = '130000'`
          )
        ).rows[0];
      } finally {
        runImport("scripts/import-administrative-regions.ts", canonicalPath);
        await rm(tempDir, { recursive: true, force: true });
      }

      expect(partialResult!.status, partialResult!.stderr).not.toBe(0);
      expect(stateAfterPartial!).toEqual({
        parent_status: "active",
        active_children: expect.not.stringMatching(/^0$/)
      });
      expect(completeResult!.status, completeResult!.stderr).toBe(0);
      expect(stateAfterComplete!).toEqual({
        parent_status: "retired",
        active_children: "0"
      });
    },
    15_000
  );

  it(
    "serializes province retirement with a concurrent active-child import",
    async () => {
      const canonicalPath = path.resolve(
        "database/seeds/administrative-regions.csv"
      );
      const initialImport = runImport(
        "scripts/import-administrative-regions.ts",
        canonicalPath
      );
      expect(initialImport.status, initialImport.stderr).toBe(0);
      const tempDir = await mkdtemp(
        path.join(tmpdir(), "peileme-region-retire-race-")
      );
      const retirementPath = path.join(tempDir, "retirement.csv");
      const childPath = path.join(tempDir, "child.csv");
      const retirementApplication = `region-retirement-${process.pid}`;
      const childApplication = `region-child-${process.pid}`;
      const advisoryKey = 7_302_027;
      const source =
        "中华人民共和国民政部," +
        "https://www.mca.gov.cn/mzsj/xzqh/2025/202401xzqh.html,2024-12-31";
      const header =
        "code,name,level,parent_code,status,source_name,source_url,source_snapshot_date\n";
      const hebeiRows = await query<{
        code: string;
        name: string;
        level: string;
        parent_code: string | null;
      }>(
        `SELECT code, name, level, parent_code
         FROM administrative_regions
         WHERE code = '130000' OR parent_code = '130000'
         ORDER BY code`
      );
      await writeFile(
        retirementPath,
        header +
          hebeiRows.rows
            .map(
              (row) =>
                [
                  row.code,
                  row.name,
                  row.level,
                  row.parent_code ?? "",
                  "retired",
                  source
                ].join(",")
            )
            .join("\n") +
          "\n",
        "utf8"
      );
      await writeFile(
        childPath,
        header + `139999,并发新增市,prefecture,130000,active,${source}\n`,
        "utf8"
      );
      const retirementUrl = new URL(process.env.DATABASE_URL!);
      retirementUrl.searchParams.set(
        "application_name",
        retirementApplication
      );
      const childUrl = new URL(process.env.DATABASE_URL!);
      childUrl.searchParams.set("application_name", childApplication);

      const gateClient = await getPool().connect();
      let gateHeld = false;
      let retirementPromise:
        | ReturnType<typeof runImportAsync>
        | undefined;
      let childPromise:
        | ReturnType<typeof runImportAsync>
        | undefined;
      let retirementResult:
        | Awaited<ReturnType<typeof runImportAsync>>
        | undefined;
      let childResult:
        | Awaited<ReturnType<typeof runImportAsync>>
        | undefined;
      try {
        await query(
          `CREATE OR REPLACE FUNCTION region_retirement_gate()
           RETURNS trigger
           LANGUAGE plpgsql
           AS $$
           BEGIN
             IF NEW.code = '130000' AND NEW.status = 'retired' THEN
               PERFORM pg_advisory_xact_lock(${advisoryKey});
             END IF;
             RETURN NEW;
           END
           $$`
        );
        await query(
          `CREATE TRIGGER region_retirement_gate_trigger
           BEFORE UPDATE ON administrative_regions
           FOR EACH ROW EXECUTE FUNCTION region_retirement_gate()`
        );
        await gateClient.query("SELECT pg_advisory_lock($1)", [advisoryKey]);
        gateHeld = true;

        retirementPromise = runImportAsync(
          "scripts/import-administrative-regions.ts",
          retirementPath,
          { ...process.env, DATABASE_URL: retirementUrl.toString() }
        );
        await waitUntil(async () => {
          const waiting = await query<{ waiting: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM pg_stat_activity
               WHERE application_name = $1 AND wait_event = 'advisory'
             ) AS waiting`,
            [retirementApplication]
          );
          return waiting.rows[0].waiting;
        });

        childPromise = runImportAsync(
          "scripts/import-administrative-regions.ts",
          childPath,
          { ...process.env, DATABASE_URL: childUrl.toString() }
        );
        await waitUntil(async () => {
          const waiting = await query<{ waiting: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM pg_stat_activity
               WHERE application_name = $1
                 AND wait_event_type = 'Lock'
             ) AS waiting`,
            [childApplication]
          );
          return waiting.rows[0].waiting;
        });

        await gateClient.query("SELECT pg_advisory_unlock($1)", [advisoryKey]);
        gateHeld = false;
        [retirementResult, childResult] = await Promise.all([
          retirementPromise,
          childPromise
        ]);
        const finalState = await query<{
          parent_status: string;
          active_children: string;
          concurrent_child_count: string;
        }>(
          `SELECT
             max(status) FILTER (WHERE code = '130000') AS parent_status,
             count(*) FILTER (
               WHERE parent_code = '130000' AND status = 'active'
             )::text AS active_children,
             count(*) FILTER (WHERE code = '139999')::text
               AS concurrent_child_count
           FROM administrative_regions
           WHERE code = '130000' OR parent_code = '130000'`
        );
        expect(finalState.rows[0]).toEqual({
          parent_status: "retired",
          active_children: "0",
          concurrent_child_count: "0"
        });
      } finally {
        if (gateHeld) {
          await gateClient.query("SELECT pg_advisory_unlock($1)", [advisoryKey]);
        }
        gateClient.release();
        await Promise.allSettled([
          retirementPromise,
          childPromise
        ].filter((item): item is Promise<unknown> => Boolean(item)));
        await query(
          "DROP TRIGGER IF EXISTS region_retirement_gate_trigger ON administrative_regions"
        );
        await query("DROP FUNCTION IF EXISTS region_retirement_gate()");
        await query("DELETE FROM administrative_regions WHERE code = '139999'");
        const restored = runImport(
          "scripts/import-administrative-regions.ts",
          canonicalPath
        );
        expect(restored.status, restored.stderr).toBe(0);
        await rm(tempDir, { recursive: true, force: true });
      }

      expect(retirementResult?.status, retirementResult?.stderr).toBe(0);
      expect(childResult?.status, childResult?.stderr).not.toBe(0);
    },
    15_000
  );

  it("rejects invalid administrative-region batches without partial writes", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "peileme-region-import-"));
    const header =
      "code,name,level,parent_code,status,source_name,source_url,source_snapshot_date\n";
    const official =
      "民政部,https://www.mca.gov.cn/mzsj/xzqh/2025/202401xzqh.html,2024-12-31\n";
    const invalidBatches = [
      `110000,被篡改的北京市,province,,active,${official}` +
        `ABC123,非法代码,prefecture,110000,active,${official}`,
      `110000,被篡改的北京市,province,,active,${official}` +
        `130100,石家庄市,prefecture,130000,active,${official}` +
        `130100,重复石家庄市,prefecture,130000,active,${official}`,
      `110000,被篡改的北京市,province,,active,${official}` +
        `990100,孤立市,prefecture,990000,active,${official}`,
      "110000,被篡改的北京市,province,,active,民政部," +
        "http://www.mca.gov.cn/example,2024-12-31\n",
      "110000,被篡改的北京市,province,,active,非政府来源," +
        "https://gov.cn.attacker.example/source,2024-12-31\n"
    ];

    try {
      for (const [index, body] of invalidBatches.entries()) {
        const csvPath = path.join(tempDir, `invalid-${index}.csv`);
        await writeFile(csvPath, header + body, "utf8");
        const result = runImport("scripts/import-administrative-regions.ts", csvPath);
        expect(result.status, `batch ${index}: ${result.stdout}\n${result.stderr}`).not.toBe(0);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    const unchanged = await query<{ name: string }>(
      "SELECT name FROM administrative_regions WHERE code = '110000'"
    );
    expect(unchanged.rows).toEqual([{ name: "北京市" }]);
    const count = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM administrative_regions"
    );
    expect(count.rows[0].count).toBe("364");
  });

  it("imports verified regional parameters idempotently", async () => {
    const csvPath = path.resolve("database/seeds/regional-parameters.csv");
    const first = runImport("scripts/import-regional-parameters.ts", csvPath);
    expect(first.status, first.stderr).toBe(0);
    const second = runImport("scripts/import-regional-parameters.ts", csvPath);
    expect(second.status, second.stderr).toBe(0);

    const coverage = await query<{
      minimum_count: string;
      average_count: string;
      invalid_amount_count: string;
    }>(
      `SELECT
         count(*) FILTER (
           WHERE parameter_type = 'minimum_monthly_wage'
         )::text AS minimum_count,
         count(*) FILTER (
           WHERE parameter_type = 'employee_average_monthly_wage'
         )::text AS average_count,
         count(*) FILTER (WHERE amount_fen <= 0)::text AS invalid_amount_count
       FROM regional_parameters`
    );
    expect(coverage.rows[0]).toEqual({
      minimum_count: "31",
      average_count: "1",
      invalid_amount_count: "0"
    });

    const samples = await query<{
      region_code: string;
      region_name: string;
      year: number;
      parameter_type: string;
      amount_fen: string;
      source_url: string;
      source_published_at: string;
      status: string;
    }>(
      `SELECT region_code, region_name, year, parameter_type,
              amount_fen::text, source_url, source_published_at::text, status
       FROM regional_parameters
       WHERE region_code = ANY($1::text[])
       ORDER BY region_code, parameter_type`,
      [["110000", "310000", "420100", "440000", "540000", "650000"]]
    );
    expect(samples.rows).toEqual([
      expect.objectContaining({
        region_code: "110000",
        year: 2026,
        parameter_type: "minimum_monthly_wage",
        amount_fen: "254000"
      }),
      expect.objectContaining({
        region_code: "310000",
        year: 2026,
        parameter_type: "minimum_monthly_wage",
        amount_fen: "274000"
      }),
      expect.objectContaining({
        region_code: "420100",
        year: 2024,
        parameter_type: "employee_average_monthly_wage",
        amount_fen: "940975"
      }),
      expect.objectContaining({
        region_code: "440000",
        year: 2026,
        parameter_type: "minimum_monthly_wage",
        amount_fen: "250000"
      }),
      expect.objectContaining({
        region_code: "540000",
        year: 2026,
        parameter_type: "minimum_monthly_wage",
        amount_fen: "236000"
      }),
      expect.objectContaining({
        region_code: "650000",
        year: 2026,
        parameter_type: "minimum_monthly_wage",
        amount_fen: "207000"
      })
    ]);
    expect(samples.rows.every((row) => row.status === "verified")).toBe(true);

    const minimumWageProvenance = await query<{
      count: string;
      distinct_urls: string;
      distinct_names: string;
      distinct_dates: string;
      exact_url_count: string;
      canonical_url: string;
    }>(
      `SELECT
         count(*)::text AS count,
         count(DISTINCT source_url)::text AS distinct_urls,
         count(DISTINCT source_name)::text AS distinct_names,
         count(DISTINCT source_published_at)::text AS distinct_dates,
         min(source_url) AS canonical_url,
         count(*) FILTER (
           WHERE source_url =
             'https://www.mohrss.gov.cn/SYrlzyhshbzb/laodongguanxi_/fwyd/202601/t20260112_565296.html'
             AND source_name =
               '人力资源社会保障部劳动关系司：全国各省、自治区、直辖市最低工资标准情况（截至2026年1月1日）'
             AND source_published_at = DATE '2026-01-12'
         )::text AS exact_url_count
       FROM regional_parameters
       WHERE parameter_type = 'minimum_monthly_wage'`
    );
    expect(minimumWageProvenance.rows[0]).toEqual({
      count: "31",
      distinct_urls: "1",
      distinct_names: "1",
      distinct_dates: "1",
      exact_url_count: "31",
      canonical_url:
        "https://www.mohrss.gov.cn/SYrlzyhshbzb/laodongguanxi_/fwyd/202601/t20260112_565296.html"
    });
    expect(
      new URL(minimumWageProvenance.rows[0].canonical_url).hostname
    ).toBe("www.mohrss.gov.cn");

    const csv = await readFile(csvPath, "utf8");
    const lines = csv.trim().split(/\r?\n/);
    expect(lines[0]).toBe(
      "region_code,region_name,year,parameter_type,amount_fen,source_name,source_url,source_published_at,status"
    );
    expect(lines).toHaveLength(33);
  });

  it("rejects invalid regional-parameter batches without partial writes", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "peileme-parameter-import-"));
    const header =
      "region_code,region_name,year,parameter_type,amount_fen,source_name,source_url,source_published_at,status\n";
    const validChanged =
      "110000,北京市,2026,minimum_monthly_wage,999999,人社部," +
      "https://zwfw.gansu.gov.cn/official,2026-01-15,verified\n";
    const invalidBatches = [
      validChanged +
        "999999,未知地区,2026,minimum_monthly_wage,200000,人社部," +
        "https://zwfw.gansu.gov.cn/official,2026-01-15,verified\n",
      validChanged +
        "110000,北京市,2026,minimum_monthly_wage,254000,人社部," +
        "https://zwfw.gansu.gov.cn/official,2026-01-15,verified\n",
      validChanged +
        "120000,天津市,2026,minimum_monthly_wage,0,人社部," +
        "https://zwfw.gansu.gov.cn/official,2026-01-15,verified\n",
      validChanged +
        "120000,天津市,2026,minimum_monthly_wage,251000,非政府来源," +
        "https://example.com/source,2026-01-15,verified\n"
    ];

    try {
      for (const [index, body] of invalidBatches.entries()) {
        const csvPath = path.join(tempDir, `invalid-${index}.csv`);
        await writeFile(csvPath, header + body, "utf8");
        const result = runImport("scripts/import-regional-parameters.ts", csvPath);
        expect(result.status, `batch ${index}: ${result.stdout}\n${result.stderr}`).not.toBe(0);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    const unchanged = await query<{ amount_fen: string }>(
      `SELECT amount_fen::text
       FROM regional_parameters
       WHERE region_code = '110000'
         AND year = 2026
         AND parameter_type = 'minimum_monthly_wage'`
    );
    expect(unchanged.rows).toEqual([{ amount_fen: "254000" }]);
    const count = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM regional_parameters"
    );
    expect(count.rows[0].count).toBe("32");
  });

  it(
    "serializes parameter validation with concurrent region retirement",
    async () => {
      const tempDir = await mkdtemp(path.join(tmpdir(), "peileme-parameter-race-"));
      const csvPath = path.join(tempDir, "race.csv");
      const applicationName = `parameter-race-${process.pid}`;
      const advisoryKey = 7_302_026;
      const databaseUrl = new URL(process.env.DATABASE_URL!);
      databaseUrl.searchParams.set("application_name", applicationName);
      await writeFile(
        csvPath,
        "region_code,region_name,year,parameter_type,amount_fen,source_name," +
          "source_url,source_published_at,status\n" +
          "110000,北京市,2099,minimum_monthly_wage,300000,人社部," +
          "https://www.mohrss.gov.cn/official,2026-01-15,verified\n",
        "utf8"
      );

      const gateClient = await getPool().connect();
      let gateHeld = false;
      let importPromise:
        | ReturnType<typeof runImportAsync>
        | undefined;
      let updatePromise: Promise<unknown> | undefined;
      let updateSettledBeforeRelease = false;
      let importResult:
        | Awaited<ReturnType<typeof runImportAsync>>
        | undefined;
      try {
        await query("DROP TABLE IF EXISTS parameter_race_audit");
        await query(
          "CREATE TABLE parameter_race_audit(observed_status TEXT NOT NULL)"
        );
        await query(
          `CREATE OR REPLACE FUNCTION parameter_race_gate()
           RETURNS trigger
           LANGUAGE plpgsql
           AS $$
           DECLARE observed TEXT;
           BEGIN
             IF NEW.region_code = '110000' AND NEW.year = 2099 THEN
               PERFORM pg_advisory_xact_lock(${advisoryKey});
               SELECT status INTO observed
               FROM administrative_regions
               WHERE code = NEW.region_code;
               INSERT INTO parameter_race_audit(observed_status)
               VALUES (observed);
             END IF;
             RETURN NEW;
           END
           $$`
        );
        await query(
          `CREATE TRIGGER parameter_race_gate_trigger
           BEFORE INSERT OR UPDATE ON regional_parameters
           FOR EACH ROW EXECUTE FUNCTION parameter_race_gate()`
        );
        await gateClient.query("SELECT pg_advisory_lock($1)", [advisoryKey]);
        gateHeld = true;

        importPromise = runImportAsync(
          "scripts/import-regional-parameters.ts",
          csvPath,
          { ...process.env, DATABASE_URL: databaseUrl.toString() }
        );
        await waitUntil(async () => {
          const waiting = await query<{ waiting: boolean }>(
            `SELECT EXISTS (
               SELECT 1
               FROM pg_stat_activity
               WHERE application_name = $1
                 AND wait_event = 'advisory'
             ) AS waiting`,
            [applicationName]
          );
          return waiting.rows[0].waiting;
        });

        let updateSettled = false;
        updatePromise = query(
          `UPDATE administrative_regions
           SET status = 'retired', updated_at = now()
           WHERE code = '110000'`
        ).finally(() => {
          updateSettled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
        updateSettledBeforeRelease = updateSettled;

        await gateClient.query("SELECT pg_advisory_unlock($1)", [advisoryKey]);
        gateHeld = false;
        [importResult] = await Promise.all([importPromise, updatePromise]);
        const audit = await query<{ observed_status: string }>(
          "SELECT observed_status FROM parameter_race_audit"
        );
        expect(audit.rows).toEqual([{ observed_status: "active" }]);
      } finally {
        if (gateHeld) {
          await gateClient.query("SELECT pg_advisory_unlock($1)", [advisoryKey]);
        }
        gateClient.release();
        await Promise.allSettled([
          importPromise,
          updatePromise
        ].filter((item): item is Promise<unknown> => Boolean(item)));
        await query(
          "DELETE FROM regional_parameters WHERE region_code = '110000' AND year = 2099"
        );
        await query(
          "UPDATE administrative_regions SET status = 'active' WHERE code = '110000'"
        );
        await query(
          "DROP TRIGGER IF EXISTS parameter_race_gate_trigger ON regional_parameters"
        );
        await query("DROP FUNCTION IF EXISTS parameter_race_gate()");
        await query("DROP TABLE IF EXISTS parameter_race_audit");
        await rm(tempDir, { recursive: true, force: true });
      }

      expect(updateSettledBeforeRelease).toBe(false);
      expect(importResult?.status, importResult?.stderr).toBe(0);
    },
    12_000
  );

  it(
    "uses one global code order for a province retirement and parameter import",
    async () => {
      const canonicalPath = path.resolve(
        "database/seeds/administrative-regions.csv"
      );
      const initialImport = runImport(
        "scripts/import-administrative-regions.ts",
        canonicalPath
      );
      expect(initialImport.status, initialImport.stderr).toBe(0);
      const tempDir = await mkdtemp(
        path.join(tmpdir(), "peileme-region-parameter-order-")
      );
      const retirementPath = path.join(tempDir, "hubei-retirement.csv");
      const parameterPath = path.join(tempDir, "hubei-parameters.csv");
      const retirementApplication = `hubei-retirement-${process.pid}`;
      const parameterApplication = `hubei-parameters-${process.pid}`;
      const regionHeader =
        "code,name,level,parent_code,status,source_name,source_url,source_snapshot_date\n";
      const regionSource =
        "中华人民共和国民政部," +
        "https://www.mca.gov.cn/mzsj/xzqh/2025/202401xzqh.html,2024-12-31";
      const hubeiRows = await query<{
        code: string;
        name: string;
        level: string;
        parent_code: string | null;
      }>(
        `SELECT code, name, level, parent_code
         FROM administrative_regions
         WHERE code = '420000' OR parent_code = '420000'
         ORDER BY code`
      );
      await writeFile(
        retirementPath,
        regionHeader +
          hubeiRows.rows
            .map(
              (row) =>
                [
                  row.code,
                  row.name,
                  row.level,
                  row.parent_code ?? "",
                  "retired",
                  regionSource
                ].join(",")
            )
            .join("\n") +
          "\n",
        "utf8"
      );
      await writeFile(
        parameterPath,
        "region_code,region_name,year,parameter_type,amount_fen,source_name," +
          "source_url,source_published_at,status\n" +
          "420000,湖北省,2098,minimum_monthly_wage,300000,人社部," +
          "https://www.mohrss.gov.cn/official,2026-01-15,verified\n" +
          "420100,武汉市,2098,minimum_monthly_wage,310000,人社部," +
          "https://www.mohrss.gov.cn/official,2026-01-15,verified\n",
        "utf8"
      );
      const retirementUrl = new URL(process.env.DATABASE_URL!);
      retirementUrl.searchParams.set(
        "application_name",
        retirementApplication
      );
      const parameterUrl = new URL(process.env.DATABASE_URL!);
      parameterUrl.searchParams.set(
        "application_name",
        parameterApplication
      );

      const blocker = await getPool().connect();
      let blockerInTransaction = false;
      let retirementPromise:
        | ReturnType<typeof runImportAsync>
        | undefined;
      let parameterPromise:
        | ReturnType<typeof runImportAsync>
        | undefined;
      let retirementResult:
        | Awaited<ReturnType<typeof runImportAsync>>
        | undefined;
      let parameterResult:
        | Awaited<ReturnType<typeof runImportAsync>>
        | undefined;
      let finalState:
        | {
            parent_status: string;
            active_children: string;
            imported_parameters: string;
          }
        | undefined;
      try {
        await blocker.query("BEGIN");
        blockerInTransaction = true;
        await blocker.query(
          `SELECT code
           FROM administrative_regions
           WHERE code = '420000'
           FOR UPDATE`
        );

        parameterPromise = runImportAsync(
          "scripts/import-regional-parameters.ts",
          parameterPath,
          { ...process.env, DATABASE_URL: parameterUrl.toString() }
        );
        await waitUntil(async () => {
          const waiting = await query<{ waiting: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM pg_stat_activity
               WHERE application_name = $1
                 AND wait_event_type = 'Lock'
             ) AS waiting`,
            [parameterApplication]
          );
          return waiting.rows[0].waiting;
        });

        retirementPromise = runImportAsync(
          "scripts/import-administrative-regions.ts",
          retirementPath,
          { ...process.env, DATABASE_URL: retirementUrl.toString() }
        );
        await waitUntil(async () => {
          const waiting = await query<{ waiting: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM pg_stat_activity
               WHERE application_name = $1
                 AND wait_event_type = 'Lock'
             ) AS waiting`,
            [retirementApplication]
          );
          return waiting.rows[0].waiting;
        });

        await blocker.query("COMMIT");
        blockerInTransaction = false;
        [retirementResult, parameterResult] = await Promise.all([
          retirementPromise,
          parameterPromise
        ]);
        finalState = (
          await query<{
            parent_status: string;
            active_children: string;
            imported_parameters: string;
          }>(
            `SELECT
               max(status) FILTER (WHERE code = '420000') AS parent_status,
               count(*) FILTER (
                 WHERE parent_code = '420000' AND status = 'active'
               )::text AS active_children,
               (
                 SELECT count(*)::text
                 FROM regional_parameters
                 WHERE year = 2098
                   AND region_code = ANY(ARRAY['420000', '420100'])
               ) AS imported_parameters
             FROM administrative_regions
             WHERE code = '420000' OR parent_code = '420000'`
          )
        ).rows[0];
      } finally {
        if (blockerInTransaction) await blocker.query("ROLLBACK");
        blocker.release();
        await Promise.allSettled([
          retirementPromise,
          parameterPromise
        ].filter((item): item is Promise<unknown> => Boolean(item)));
        await query(
          `DELETE FROM regional_parameters
           WHERE year = 2098
             AND region_code = ANY(ARRAY['420000', '420100'])`
        );
        const restored = runImport(
          "scripts/import-administrative-regions.ts",
          canonicalPath
        );
        expect(restored.status, restored.stderr).toBe(0);
        await rm(tempDir, { recursive: true, force: true });
      }

      expect(
        retirementResult?.status,
        `${retirementResult?.stdout}\n${retirementResult?.stderr}`
      ).toBe(0);
      expect(
        parameterResult?.status,
        `${parameterResult?.stdout}\n${parameterResult?.stderr}`
      ).toBe(0);
      expect(finalState).toEqual({
        parent_status: "retired",
        active_children: "0",
        imported_parameters: "2"
      });
    },
    15_000
  );

  it("re-runs migrations without changing imported policy data", async () => {
    await runMigrations();
    await runMigrations();

    const migrations = await query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version"
    );
    expect(migrations.rows).toEqual([
      { version: "001_initial.sql" },
      { version: "002_policy_foundation.sql" },
      { version: "003_policy_parameter_provenance.sql" },
      { version: "004_refresh_session_rotation.sql" },
      { version: "005_remove_document_review_grants.sql" },
      { version: "006_policy_result_shares.sql" },
      { version: "007_policy_rule_regressions.sql" },
      { version: "008_commerce.sql" },
      { version: "009_payment_reconciliation.sql" },
      { version: "010_order_channel_lookup.sql" },
      { version: "011_real_payments.sql" },
      { version: "012_refunds_payment_transaction_index.sql" },
      { version: "013_ai_analysis_pipeline.sql" }
    ]);

    const preserved = await query<{
      regions: string;
      parameters: string;
      rule_versions: string;
      beijing_wage: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM administrative_regions) AS regions,
         (SELECT count(*)::text FROM regional_parameters) AS parameters,
         (SELECT count(*)::text FROM policy_rule_versions) AS rule_versions,
         (
           SELECT amount_fen::text
           FROM regional_parameters
           WHERE region_code = '110000'
             AND year = 2026
             AND parameter_type = 'minimum_monthly_wage'
         ) AS beijing_wage`
    );
    expect(preserved.rows[0]).toEqual({
      regions: "364",
      parameters: "32",
      rule_versions: "1",
      beijing_wage: "254000"
    });
  });
});

describe("health and authentication", () => {
  it("reports database and OTP channel status", async () => {
    const response = await request(createApp()).get("/api/health").expect(200);
    expect(response.body.status).toBe("healthy");
    expect(response.body.database).toBe(true);
    expect(response.body.channels.debug).toBe(true);
  });

  it("registers an email account with a one-time code", async () => {
    const app = createApp();
    const codeResponse = await request(app)
      .post("/api/auth/send-code")
      .send({ target: "user@peileme.test", purpose: "register" })
      .expect(201);
    expect(codeResponse.body.debugCode).toMatch(/^\d{6}$/);

    const registerResponse = await request(app)
      .post("/api/auth/register")
      .send({
        target: "user@peileme.test",
        code: codeResponse.body.debugCode,
        password: "UserPass123",
        displayName: "测试用户"
      })
      .expect(201);
    expect(registerResponse.body.user.email).toBe("user@peileme.test");
    expect(registerResponse.body.accessToken).toBeTruthy();
    userToken = registerResponse.body.accessToken;

    const meResponse = await request(app)
      .get("/api/auth/me")
      .set("authorization", `Bearer ${userToken}`)
      .expect(200);
    expect(meResponse.body.user.displayName).toBe("测试用户");
  });

  it("logs in the administrator with a password", async () => {
    const response = await request(createApp())
      .post("/api/auth/login")
      .send({ identifier: "admin@peileme.test", password: "AdminPass123" })
      .expect(200);
    expect(response.body.user.role).toBe("admin");
    adminToken = response.body.accessToken;
  });

  it("resets a password with a one-time code and revokes old sessions", async () => {
    const app = createApp();
    const codeResponse = await request(app)
      .post("/api/auth/send-code")
      .send({ target: "user@peileme.test", purpose: "reset_password" })
      .expect(201);
    await request(app)
      .post("/api/auth/reset-password")
      .send({
        target: "user@peileme.test",
        code: codeResponse.body.debugCode,
        password: "NewUserPass123"
      })
      .expect(200);
    const loginResponse = await request(app)
      .post("/api/auth/login")
      .send({ identifier: "user@peileme.test", password: "NewUserPass123" })
      .expect(200);
    userToken = loginResponse.body.accessToken;
  });
});

describe("invites and access grants", () => {
  it("rejects the removed document review grant", async () => {
    await request(createApp())
      .post("/api/admin/invites")
      .set("authorization", `Bearer ${adminToken}`)
      .send({
        maxUses: 1,
        grants: ["documentReview"]
      })
      .expect(400);
  });

  it("creates and redeems a scoped invite", async () => {
    const app = createApp();
    const created = await request(app)
      .post("/api/admin/invites")
      .set("authorization", `Bearer ${adminToken}`)
      .send({
        maxUses: 2,
        description: "API 测试邀请码",
        grants: ["caseLawPack", "evidencePack"]
      })
      .expect(201);
    inviteCode = created.body.code;
    expect(inviteCode).toMatch(/^PLM-/);

    const redeemed = await request(app)
      .post("/api/invites/redeem")
      .set("authorization", `Bearer ${userToken}`)
      .send({ code: inviteCode })
      .expect(200);
    expect(redeemed.body.grants).toEqual(["caseLawPack", "evidencePack"]);

    const access = await request(app)
      .get("/api/access/me")
      .set("authorization", `Bearer ${userToken}`)
      .expect(200);
    expect(access.body.grants.map((item: { module: string }) => item.module)).toEqual([
      "caseLawPack",
      "evidencePack"
    ]);
  });

  it("keeps analyst accounts read-only", async () => {
    await query(
      `INSERT INTO users(email, display_name, role, email_verified_at)
       VALUES ('analyst@peileme.test', '测试分析员', 'analyst', now())`
    );
    const otp = await request(createApp())
      .post("/api/auth/send-code")
      .send({ target: "analyst@peileme.test", purpose: "login" })
      .expect(201);
    const loggedIn = await request(createApp())
      .post("/api/auth/login")
      .send({ identifier: "analyst@peileme.test", code: otp.body.debugCode })
      .expect(200);
    analystToken = loggedIn.body.accessToken;
    await request(createApp())
      .get("/api/admin/overview")
      .set("authorization", `Bearer ${analystToken}`)
      .expect(200);
    await request(createApp())
      .post("/api/admin/invites")
      .set("authorization", `Bearer ${analystToken}`)
      .send({ maxUses: 1 })
      .expect(403);
  });
});

describe("assessments, events and uploads", () => {
  it("persists and completes an anonymous assessment", async () => {
    const app = createApp();
    const created = await request(app)
      .post("/api/assessments")
      .set(visitorHeaders)
      .send({
        status: "in_progress",
        currentStep: "city",
        answers: { city: "上海" }
      })
      .expect(201);
    anonymousAssessmentId = created.body.id;
    expect(anonymousAssessmentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );

    await request(app)
      .patch(`/api/assessments/${anonymousAssessmentId}`)
      .set(visitorHeaders)
      .send({
        status: "completed",
        currentStep: "result",
        answers: { city: "上海", avgMonthlySalary: 12000 },
        result: { lowAmount: 12000, highAmount: 24000 }
      })
      .expect(200);

    const row = await query<{ status: string; completed_at: Date | null }>(
      "SELECT status, completed_at FROM assessments WHERE id = $1",
      [anonymousAssessmentId]
    );
    expect(row.rows[0].status).toBe("completed");
    expect(row.rows[0].completed_at).toBeTruthy();
  });

  it("stores a batch of analytics events and exposes admin aggregates", async () => {
    const app = createApp();
    const events = await request(app)
      .post("/api/events/batch")
      .set(visitorHeaders)
      .send({
        events: [
          { name: "page_view", path: "/" },
          { name: "assessment_started", path: "/", properties: { source: "test" } },
          { name: "assessment_completed", path: "/result" }
        ]
      })
      .expect(202);
    expect(events.body.accepted).toBe(3);

    const overview = await request(app)
      .get("/api/admin/overview?days=30")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(Number(overview.body.summary.visitors)).toBeGreaterThanOrEqual(1);
    expect(Number(overview.body.summary.completed_assessments)).toBeGreaterThanOrEqual(1);
  });

  it("hides material metadata from shared main-host admin pages", async () => {
    await request(createApp())
      .post("/api/events/batch")
      .set("host", "ai.localhost")
      .set(visitorHeaders)
      .send({
        events: [
          { name: "document_uploaded", path: "/account" },
          { name: "ai_document_uploaded", path: "/account" },
          { name: "ai_document_downloaded", path: "/account" }
        ]
      })
      .expect(202);
    await query(
      `INSERT INTO admin_audit_logs(action, target_type, detail)
       VALUES
         ('upload.delete', 'upload', '{}'::jsonb),
         ('policy.rules.update', 'policy', '{}'::jsonb)`
    );

    const authenticatedGet = (host: string, path: string) =>
      request(createApp())
        .get(path)
        .set("host", host)
        .set("authorization", `Bearer ${adminToken}`);
    const [mainOverview, aiOverview, mainEvents, aiEvents] =
      await Promise.all([
        authenticatedGet("localhost", "/api/admin/overview?days=30").expect(
          200
        ),
        authenticatedGet(
          "ai.localhost",
          "/api/admin/overview?days=30"
        ).expect(200),
        authenticatedGet("localhost", "/api/admin/events?days=30").expect(
          200
        ),
        authenticatedGet(
          "ai.localhost",
          "/api/admin/events?days=30"
        ).expect(200)
      ]);
    expect(mainOverview.body.summary).not.toHaveProperty("uploaded_files");
    expect(aiOverview.body.summary).toHaveProperty("uploaded_files");
    const mainEventNames = mainEvents.body.items.map(
      (item: { event_name: string }) => item.event_name
    );
    const aiEventNames = aiEvents.body.items.map(
      (item: { event_name: string }) => item.event_name
    );
    expect(mainEventNames).not.toContain("document_uploaded");
    expect(mainEventNames).not.toContain("ai_document_uploaded");
    expect(mainEventNames).not.toContain("ai_document_downloaded");
    expect(aiEventNames).toEqual(
      expect.arrayContaining([
        "document_uploaded",
        "ai_document_uploaded",
        "ai_document_downloaded"
      ])
    );

    const [mainAudit, aiAudit, mainSystem, aiSystem] = await Promise.all([
      authenticatedGet(
        "localhost",
        "/api/admin/audit-logs?pageSize=100"
      ).expect(200),
      authenticatedGet(
        "ai.localhost",
        "/api/admin/audit-logs?pageSize=100"
      ).expect(200),
      authenticatedGet("localhost", "/api/admin/system").expect(200),
      authenticatedGet("ai.localhost", "/api/admin/system").expect(200)
    ]);
    expect(
      mainAudit.body.items.map((item: { action: string }) => item.action)
    ).not.toContain("upload.delete");
    expect(
      aiAudit.body.items.map((item: { action: string }) => item.action)
    ).toContain("upload.delete");
    expect(
      mainSystem.body.tableCounts.map(
        (item: { name: string }) => item.name
      )
    ).not.toContain("uploads");
    expect(
      aiSystem.body.tableCounts.map((item: { name: string }) => item.name)
    ).toContain("uploads");
  });

  it("stores a private document upload", async () => {
    const assessment = await request(createApp())
      .post("/api/assessments")
      .set("host", "ai.localhost")
      .set(visitorHeaders)
      .send({
        status: "in_progress",
        currentStep: "document",
        answers: { city: "上海" }
      })
      .expect(201);
    aiAssessmentId = assessment.body.id;
    await request(createApp())
      .post("/api/assessments/claim")
      .set("host", "ai.localhost")
      .set("authorization", `Bearer ${userToken}`)
      .set(visitorHeaders)
      .expect(200);
    const response = await request(createApp())
      .post("/api/uploads")
      .set("host", "ai.localhost")
      .set("authorization", `Bearer ${userToken}`)
      .set(visitorHeaders)
      .field("assessmentId", aiAssessmentId)
      .attach("files", Buffer.from("%PDF-1.4 test document"), {
        filename: "解除协议.pdf",
        contentType: "application/pdf"
      })
      .expect(201);
    expect(response.body.files[0].original_name).toBe("解除协议.pdf");
    expect(response.body.files[0].status).toBe("stored");
    aiUploadId = response.body.files[0].id;
  });

  it("keeps authenticated AI user and admin material APIs operational", async () => {
    const userFiles = await request(createApp())
      .get("/api/uploads/mine")
      .set("host", "ai.localhost")
      .set("authorization", `Bearer ${userToken}`)
      .expect(200);
    expect(
      userFiles.body.files.map((file: { id: string }) => file.id)
    ).toContain(aiUploadId);
    const userDownload = await request(createApp())
      .get(`/api/uploads/${aiUploadId}/download`)
      .set("host", "ai.localhost")
      .set("authorization", `Bearer ${userToken}`)
      .expect(200);
    expect(userDownload.headers["content-disposition"]).toContain(
      "attachment"
    );

    const adminFiles = await request(createApp())
      .get("/api/admin/uploads?pageSize=100")
      .set("host", "ai.localhost")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(
      adminFiles.body.items.map((file: { id: string }) => file.id)
    ).toContain(aiUploadId);
    const adminDownload = await request(createApp())
      .get(`/api/admin/uploads/${aiUploadId}/download`)
      .set("host", "ai.localhost")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(adminDownload.headers["content-disposition"]).toContain(
      "attachment"
    );
  });

  it("scopes assessment history and updates to the active product host", async () => {
    await request(createApp())
      .post("/api/assessments/claim")
      .set("host", "localhost")
      .set("authorization", `Bearer ${userToken}`)
      .set(visitorHeaders)
      .expect(200);
    const [mainHistory, aiHistory] = await Promise.all([
      request(createApp())
        .get("/api/assessments/mine?pageSize=100")
        .set("host", "localhost")
        .set("authorization", `Bearer ${userToken}`)
        .expect(200),
      request(createApp())
        .get("/api/assessments/mine?pageSize=100")
        .set("host", "ai.localhost")
        .set("authorization", `Bearer ${userToken}`)
        .expect(200)
    ]);
    const ids = (response: typeof mainHistory) =>
      response.body.items.map((item: { id: string }) => item.id);
    expect(ids(mainHistory)).toContain(anonymousAssessmentId);
    expect(ids(mainHistory)).not.toContain(aiAssessmentId);
    expect(ids(aiHistory)).toContain(aiAssessmentId);
    expect(ids(aiHistory)).not.toContain(anonymousAssessmentId);

    await request(createApp())
      .patch(`/api/assessments/${aiAssessmentId}`)
      .set("host", "localhost")
      .set("authorization", `Bearer ${userToken}`)
      .set(visitorHeaders)
      .send({ currentStep: "cross-host-write" })
      .expect(404);
    await request(createApp())
      .patch(`/api/assessments/${anonymousAssessmentId}`)
      .set("host", "ai.localhost")
      .set("authorization", `Bearer ${userToken}`)
      .set(visitorHeaders)
      .send({ currentStep: "cross-host-write" })
      .expect(404);
  });

  it("scopes admin user counts and assessment details to the product Host", async () => {
    const expectedCounts = await query<{
      product_channel: string;
      count: string;
    }>(
      `SELECT a.product_channel, count(*)::text AS count
         FROM assessments a
         JOIN users u ON u.id = a.user_id
        WHERE u.email = 'user@peileme.test'
        GROUP BY a.product_channel`
    );
    const counts = new Map(
      expectedCounts.rows.map((row) => [row.product_channel, row.count])
    );
    const authenticatedAdminGet = (host: string, path: string) =>
      request(createApp())
        .get(path)
        .set("host", host)
        .set("authorization", `Bearer ${adminToken}`);
    const [mainUsers, aiUsers, mainAssessments, aiAssessments] =
      await Promise.all([
        authenticatedAdminGet(
          "localhost",
          "/api/admin/users?search=user%40peileme.test&pageSize=100"
        ).expect(200),
        authenticatedAdminGet(
          "ai.localhost",
          "/api/admin/users?search=user%40peileme.test&pageSize=100"
        ).expect(200),
        authenticatedAdminGet(
          "localhost",
          "/api/admin/assessments?pageSize=100"
        ).expect(200),
        authenticatedAdminGet(
          "ai.localhost",
          "/api/admin/assessments?pageSize=100"
        ).expect(200)
      ]);
    const selectedUser = (response: typeof mainUsers) =>
      response.body.items.find(
        (item: { email: string }) => item.email === "user@peileme.test"
      );
    expect(String(selectedUser(mainUsers).assessment_count)).toBe(
      counts.get("main")
    );
    expect(String(selectedUser(aiUsers).assessment_count)).toBe(
      counts.get("ai")
    );
    const mainIds = mainAssessments.body.items.map(
      (item: { id: string }) => item.id
    );
    const aiIds = aiAssessments.body.items.map(
      (item: { id: string }) => item.id
    );
    expect(mainIds).toContain(anonymousAssessmentId);
    expect(mainIds).not.toContain(aiAssessmentId);
    expect(aiIds).toContain(aiAssessmentId);
    expect(aiIds).not.toContain(anonymousAssessmentId);
    expect(
      mainAssessments.body.items.find(
        (item: { id: string }) => item.id === anonymousAssessmentId
      ).answers
    ).toMatchObject({ city: "上海" });
    expect(
      aiAssessments.body.items.find(
        (item: { id: string }) => item.id === aiAssessmentId
      ).answers
    ).toMatchObject({ city: "上海" });
  });

  it("rejects spoofed file content and foreign assessment attachments", async () => {
    const before = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM uploads"
    );
    await request(createApp())
      .post("/api/uploads")
      .set("host", "ai.localhost")
      .set("authorization", `Bearer ${userToken}`)
      .set(visitorHeaders)
      .attach("files", Buffer.from("plain text disguised as PDF"), {
        filename: "伪装文件.pdf",
        contentType: "application/pdf"
      })
      .expect(400);

    const foreign = await request(createApp())
      .post("/api/assessments")
      .set("host", "ai.localhost")
      .set({
        "x-visitor-id": "visitor_foreign_12345678",
        "x-session-id": "session_foreign_12345678"
      })
      .send({ status: "in_progress", currentStep: "city", answers: { city: "北京" } })
      .expect(201);
    await request(createApp())
      .post("/api/uploads")
      .set("host", "ai.localhost")
      .set("authorization", `Bearer ${userToken}`)
      .set(visitorHeaders)
      .field("assessmentId", foreign.body.id)
      .attach("files", Buffer.from("%PDF-1.4 valid header"), {
        filename: "他人材料.pdf",
        contentType: "application/pdf"
      })
      .expect(404);

    const after = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM uploads"
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });
});
