import bcrypt from "bcryptjs";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { closePool, query } from "../db.js";
import { runMigrations } from "../migrate.js";
import { seed } from "../seed.js";

let adminToken = "";
let userToken = "";
let analystToken = "";
let inviteCode = "";
let anonymousAssessmentId = "";

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
      value.includes("policy_rule_sets:FOREIGN KEY:FOREIGN KEY (active_version_id)")
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
        schemaVersion: 1,
        terminationModes: {
          mutual_agreement: "N",
          employer_notice: "N_PLUS_ONE",
          unlawful_termination: "TWO_N",
          employee_resignation: "ZERO",
          unclear: "REVIEW"
        },
        serviceFraction: {
          lessThanSixMonths: 0.5,
          atLeastSixMonths: 1
        },
        highSalaryCapMultiplier: 3,
        highSalaryServiceYearCap: 12
      }
    });
    expect(versions.rows[0].source_snapshot).toEqual([
      expect.objectContaining({
        name: "中华人民共和国劳动合同法",
        article: "第四十七条"
      })
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
      average_count: "2",
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
      [["110000", "310000", "420100", "430700", "440000", "540000", "650000"]]
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
        region_code: "430700",
        year: 2024,
        parameter_type: "employee_average_monthly_wage",
        amount_fen: "693750"
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

    const csv = await readFile(csvPath, "utf8");
    const lines = csv.trim().split(/\r?\n/);
    expect(lines[0]).toBe(
      "region_code,region_name,year,parameter_type,amount_fen,source_name,source_url,source_published_at,status"
    );
    expect(lines).toHaveLength(34);
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
    expect(count.rows[0].count).toBe("33");
  });

  it("re-runs migrations without changing imported policy data", async () => {
    await runMigrations();
    await runMigrations();

    const migrations = await query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version"
    );
    expect(migrations.rows).toEqual([
      { version: "001_initial.sql" },
      { version: "002_policy_foundation.sql" }
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
      parameters: "33",
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

  it("stores a private document upload", async () => {
    await request(createApp())
      .post("/api/assessments/claim")
      .set("authorization", `Bearer ${userToken}`)
      .set(visitorHeaders)
      .expect(200);
    const response = await request(createApp())
      .post("/api/uploads")
      .set("authorization", `Bearer ${userToken}`)
      .set(visitorHeaders)
      .field("assessmentId", anonymousAssessmentId)
      .attach("files", Buffer.from("%PDF-1.4 test document"), {
        filename: "解除协议.pdf",
        contentType: "application/pdf"
      })
      .expect(201);
    expect(response.body.files[0].original_name).toBe("解除协议.pdf");
    expect(response.body.files[0].status).toBe("stored");
  });

  it("rejects spoofed file content and foreign assessment attachments", async () => {
    const before = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM uploads"
    );
    await request(createApp())
      .post("/api/uploads")
      .set("authorization", `Bearer ${userToken}`)
      .set(visitorHeaders)
      .attach("files", Buffer.from("plain text disguised as PDF"), {
        filename: "伪装文件.pdf",
        contentType: "application/pdf"
      })
      .expect(400);

    const foreign = await request(createApp())
      .post("/api/assessments")
      .set({
        "x-visitor-id": "visitor_foreign_12345678",
        "x-session-id": "session_foreign_12345678"
      })
      .send({ status: "in_progress", currentStep: "city", answers: { city: "北京" } })
      .expect(201);
    await request(createApp())
      .post("/api/uploads")
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
