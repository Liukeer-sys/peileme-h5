import bcrypt from "bcryptjs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from "vitest";
import { createApp } from "../app.js";
import { closePool, query } from "../db.js";
import { runMigrations } from "../migrate.js";
import { seedPolicyFoundation } from "../modules/policy/seed.js";

const runImport = (script: string, csv: string) => {
  const result = spawnSync(
    path.resolve("node_modules/.bin/tsx"),
    [path.resolve(script), path.resolve(csv)],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: process.env
    }
  );
  if (result.status !== 0) {
    throw new Error(`${script} failed: ${result.stderr || result.stdout}`);
  }
};

const authHeader = (token: string) => ({
  authorization: `Bearer ${token}`
});

const calculationBody = (
  overrides: Record<string, unknown> = {}
) => ({
  regionCode: "420100",
  regionName: "伪造的地区名称",
  startDate: "2020-01-01",
  endDate: "2026-07-01",
  terminationScenario: {
    kind: "ARTICLE_40",
    noticeMethod: "notice_30_days"
  },
  monthlyEarnedWagesFen: Array(12).fill(1_000_000),
  alreadyPaidFen: 100_000,
  clientResult: { payableFen: 1 },
  userId: "00000000-0000-0000-0000-000000000000",
  accuracy: "verified",
  ruleVersion: 999,
  ...overrides
});

let adminToken = "";
let analystToken = "";
let userToken = "";
let otherUserToken = "";
let firstAssessmentId = "";
let firstOutput: unknown;

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

  runImport(
    "scripts/import-administrative-regions.ts",
    "database/seeds/administrative-regions.csv"
  );
  runImport(
    "scripts/import-regional-parameters.ts",
    "database/seeds/regional-parameters.csv"
  );
  await query(
    `INSERT INTO administrative_regions(
       code, name, level, parent_code, status,
       source_name, source_url, source_snapshot_date
     )
     VALUES (
       '429999', '已撤销测试地区', 'prefecture', '420000', 'retired',
       '测试区划', 'https://example.test/regions', DATE '2026-01-01'
     )`
  );

  const passwordHash = await bcrypt.hash("PolicyPass123", 4);
  await query(
    `INSERT INTO users(
       email, display_name, password_hash, role, email_verified_at
     )
     VALUES
       ('policy-admin@peileme.test', '政策管理员', $1, 'admin', now()),
       ('policy-analyst@peileme.test', '政策分析员', $1, 'analyst', now()),
       ('policy-user@peileme.test', '政策用户', $1, 'user', now()),
       ('other-policy-user@peileme.test', '其他用户', $1, 'user', now())`,
    [passwordHash]
  );
  await seedPolicyFoundation();

  const app = createApp();
  const login = async (identifier: string) =>
    (
      await request(app)
        .post("/api/auth/login")
        .send({ identifier, password: "PolicyPass123" })
        .expect(200)
    ).body.accessToken as string;
  adminToken = await login("policy-admin@peileme.test");
  analystToken = await login("policy-analyst@peileme.test");
  userToken = await login("policy-user@peileme.test");
  otherUserToken = await login("other-policy-user@peileme.test");
});

afterAll(async () => {
  await closePool();
});

describe("versioned policy public API", () => {
  it("lists only the 31 active provinces and 333 active prefectures", async () => {
    const app = createApp();
    const all = await request(app).get("/api/policy/regions").expect(200);
    const provinces = await request(app)
      .get("/api/policy/regions?level=province")
      .expect(200);
    const prefectures = await request(app)
      .get("/api/policy/regions?level=prefecture")
      .expect(200);

    expect(provinces.body.items).toHaveLength(31);
    expect(prefectures.body.items).toHaveLength(333);
    expect(all.body.items).toHaveLength(364);
    expect(all.body.items[0]).toEqual({
      code: "110000",
      name: "北京市",
      level: "province",
      parentCode: null
    });
    expect(all.body.items).not.toContainEqual(
      expect.objectContaining({ code: "429999" })
    );
  });

  it("requires authentication for calculation and history", async () => {
    const app = createApp();
    await request(app)
      .post("/api/policy/calculate")
      .send(calculationBody())
      .expect(401);
    await request(app).get("/api/policy/history").expect(401);
  });

  it("calculates from canonical DB facts and persists an atomic verified snapshot", async () => {
    const response = await request(createApp())
      .post("/api/policy/calculate")
      .set(authHeader(userToken))
      .send(calculationBody())
      .expect(201);

    firstAssessmentId = response.body.assessmentId;
    firstOutput = response.body.result;
    expect(response.body).toMatchObject({
      ruleVersion: 1,
      accuracy: "verified",
      parameters: {
        minimumMonthlyWage: {
          source: "database",
          status: "verified",
          year: 2026,
          regionCode: "420000",
          regionName: "湖北省",
          fallback: true,
          amountFen: 240000
        },
        employeeAverageMonthlyWage: {
          source: "database",
          status: "verified",
          year: 2024,
          regionCode: "420100",
          regionName: "武汉市",
          fallback: false,
          amountFen: 940975
        }
      }
    });
    expect(response.body.result.payableFen).toBeGreaterThan(1);

    const stored = await query<{
      assessment_id: string;
      user_id: string;
      product_channel: string;
      status: string;
      accuracy_level: string;
      version: number;
      input_snapshot: Record<string, unknown>;
      result_snapshot: unknown;
      input: Record<string, unknown>;
      output: unknown;
      input_hash: string;
      regional_parameter_ids: string[];
    }>(
      `SELECT a.id AS assessment_id, a.user_id, a.product_channel, a.status,
              a.accuracy_level, prv.version, a.input_snapshot,
              a.result_snapshot, pcs.input, pcs.output, pcs.input_hash,
              pcs.regional_parameter_ids
         FROM assessments a
         JOIN policy_rule_versions prv ON prv.id = a.rule_version_id
         JOIN policy_calculation_snapshots pcs ON pcs.assessment_id = a.id
        WHERE a.id = $1`,
      [firstAssessmentId]
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({
      assessment_id: firstAssessmentId,
      product_channel: "main",
      status: "completed",
      accuracy_level: "verified",
      version: 1
    });
    expect(stored.rows[0].input_snapshot.regionName).toBe("武汉市");
    expect(stored.rows[0].input).toEqual(stored.rows[0].input_snapshot);
    expect(stored.rows[0].output).toEqual(stored.rows[0].result_snapshot);
    expect(stored.rows[0].output).toEqual(response.body.result);
    expect(stored.rows[0].input).not.toHaveProperty("clientResult");
    expect(stored.rows[0].input).not.toHaveProperty("userId");
    expect(stored.rows[0].input_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.rows[0].regional_parameter_ids.sort()).toEqual(
      [
        response.body.parameters.minimumMonthlyWage.parameterId,
        response.body.parameters.employeeAverageMonthlyWage.parameterId
      ].sort()
    );

    const repeated = await request(createApp())
      .post("/api/policy/calculate")
      .set(authHeader(userToken))
      .send(calculationBody())
      .expect(201);
    const repeatedHash = await query<{ input_hash: string }>(
      `SELECT input_hash
         FROM policy_calculation_snapshots
        WHERE assessment_id = $1`,
      [repeated.body.assessmentId]
    );
    expect(repeatedHash.rows[0].input_hash).toBe(stored.rows[0].input_hash);
  });

  it("uses manual values only for missing parameters and marks accuracy estimated", async () => {
    const response = await request(createApp())
      .post("/api/policy/calculate")
      .set(authHeader(userToken))
      .send(
        calculationBody({
          regionCode: "130100",
          manualParameters: {
            minimumMonthlyWageFen: 999999,
            employeeAverageMonthlyWageFen: 800000
          }
        })
      )
      .expect(201);

    expect(response.body.accuracy).toBe("estimated");
    expect(response.body.parameters.minimumMonthlyWage).toMatchObject({
      source: "database",
      regionCode: "130000",
      fallback: true,
      amountFen: 238000
    });
    expect(response.body.parameters.employeeAverageMonthlyWage).toEqual({
      source: "manual",
      amountFen: 800000
    });
  });

  it("marks stale DB provenance and requires absent values", async () => {
    const inserted = await query<{ id: string }>(
      `INSERT INTO regional_parameters(
         region_code, region_name, year, parameter_type, amount_fen,
         source_name, source_url, source_published_at, status
       )
       VALUES (
         '420100', '武汉市', 2026, 'minimum_monthly_wage', 250000,
         '过期测试来源', 'https://example.test/stale', DATE '2026-01-01', 'stale'
       )
       RETURNING id`
    );
    try {
      const stale = await request(createApp())
        .post("/api/policy/calculate")
        .set(authHeader(userToken))
        .send(calculationBody())
        .expect(201);
      expect(stale.body.accuracy).toBe("stale");
      expect(stale.body.parameters.minimumMonthlyWage).toMatchObject({
        parameterId: inserted.rows[0].id,
        status: "stale",
        regionCode: "420100",
        fallback: false
      });
    } finally {
      await query("DELETE FROM regional_parameters WHERE id = $1", [
        inserted.rows[0].id
      ]);
    }

    const missing = await request(createApp())
      .post("/api/policy/calculate")
      .set(authHeader(userToken))
      .send(calculationBody({ regionCode: "130100" }))
      .expect(422);
    expect(missing.body).toMatchObject({
      error: "REGIONAL_PARAMETERS_REQUIRED",
      detail: {
        missing: ["employeeAverageMonthlyWageFen"]
      }
    });
  });

  it("enforces date-aware parameter semantics and active canonical regions", async () => {
    await query(
      `INSERT INTO regional_parameters(
         region_code, region_name, year, parameter_type, amount_fen,
         source_name, source_url, source_published_at, status
       )
       VALUES
         ('420100', '武汉市', 2026, 'employee_average_monthly_wage', 999999,
          '未来平均工资', 'https://example.test/future-average',
          DATE '2026-06-01', 'verified')`
    );
    try {
      const response = await request(createApp())
        .post("/api/policy/calculate")
        .set(authHeader(userToken))
        .send(calculationBody())
        .expect(201);
      expect(
        response.body.parameters.employeeAverageMonthlyWage
      ).toMatchObject({ year: 2024, amountFen: 940975 });
    } finally {
      await query(
        `DELETE FROM regional_parameters
          WHERE region_code = '420100'
            AND year = 2026
            AND parameter_type = 'employee_average_monthly_wage'`
      );
    }

    const retired = await request(createApp())
      .post("/api/policy/calculate")
      .set(authHeader(userToken))
      .send(
        calculationBody({
          regionCode: "429999",
          manualParameters: {
            minimumMonthlyWageFen: 1,
            employeeAverageMonthlyWageFen: 1
          }
        })
      )
      .expect(422);
    expect(retired.body.error).toBe("REGION_UNAVAILABLE");

    await query(
      "UPDATE administrative_regions SET status = 'retired' WHERE code = '420000'"
    );
    try {
      const inactiveParent = await request(createApp())
        .post("/api/policy/calculate")
        .set(authHeader(userToken))
        .send(calculationBody())
        .expect(422);
      expect(inactiveParent.body).toMatchObject({
        error: "REGIONAL_PARAMETERS_REQUIRED",
        detail: { missing: ["minimumMonthlyWageFen"] }
      });
    } finally {
      await query(
        "UPDATE administrative_regions SET status = 'active' WHERE code = '420000'"
      );
    }
  });

  it("maps validation and engine errors without leaking unknown exception stacks", async () => {
    const app = createApp();
    const invalidBoundary = await request(app)
      .post("/api/policy/calculate")
      .set(authHeader(userToken))
      .send(calculationBody({ startDate: 20200101 }))
      .expect(400);
    expect(invalidBoundary.body.error).toBe("VALIDATION_ERROR");

    const invalidCalendarDate = await request(app)
      .post("/api/policy/calculate")
      .set(authHeader(userToken))
      .send(calculationBody({ endDate: "2026-02-30" }))
      .expect(400);
    expect(invalidCalendarDate.body.error).toBe("VALIDATION_ERROR");

    const invalidBusiness = await request(app)
      .post("/api/policy/calculate")
      .set(authHeader(userToken))
      .send(
        calculationBody({
          startDate: "2026-07-02",
          endDate: "2026-07-01"
        })
      )
      .expect(422);
    expect(invalidBusiness.body).toMatchObject({
      error: "END_DATE_MUST_FOLLOW_START_DATE"
    });

    const invalidManual = await request(app)
      .post("/api/policy/calculate")
      .set(authHeader(userToken))
      .send(
        calculationBody({
          regionCode: "130100",
          manualParameters: {
            employeeAverageMonthlyWageFen: Number.MAX_SAFE_INTEGER + 1
          }
        })
      )
      .expect(400);
    expect(invalidManual.body.error).toBe("VALIDATION_ERROR");

    const sentinel = await request(
      createApp({
        policyCalculate: () => {
          throw new Error("policy sentinel secret");
        }
      })
    )
      .post("/api/policy/calculate")
      .set(authHeader(userToken))
      .send(calculationBody())
      .expect(500);
    expect(sentinel.body.error).toBe("INTERNAL_ERROR");
    expect(sentinel.body.message).not.toContain("sentinel");
    expect(sentinel.body).not.toHaveProperty("stack");
  });

  it("rolls back the assessment when snapshot persistence fails", async () => {
    const before = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM assessments"
    );
    await query(`
      CREATE FUNCTION fail_policy_snapshot_for_test()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced snapshot failure';
      END;
      $$;
      CREATE TRIGGER fail_policy_snapshot_trigger
      BEFORE INSERT ON policy_calculation_snapshots
      FOR EACH ROW EXECUTE FUNCTION fail_policy_snapshot_for_test()
    `);
    try {
      await request(createApp())
        .post("/api/policy/calculate")
        .set(authHeader(userToken))
        .send(calculationBody())
        .expect(500);
    } finally {
      await query(`
        DROP TRIGGER IF EXISTS fail_policy_snapshot_trigger
          ON policy_calculation_snapshots;
        DROP FUNCTION IF EXISTS fail_policy_snapshot_for_test()
      `);
    }
    const after = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM assessments"
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  it("paginates owner-only history and hides foreign details behind 404", async () => {
    const pageOne = await request(createApp())
      .get("/api/policy/history?page=1&pageSize=1")
      .set(authHeader(userToken))
      .expect(200);
    const pageTwo = await request(createApp())
      .get("/api/policy/history?page=2&pageSize=1")
      .set(authHeader(userToken))
      .expect(200);
    expect(pageOne.body.items).toHaveLength(1);
    expect(pageTwo.body.items).toHaveLength(1);
    expect(pageOne.body.items[0].id).not.toBe(pageTwo.body.items[0].id);
    expect(pageOne.body.pagination.total).toBeGreaterThanOrEqual(2);

    const detail = await request(createApp())
      .get(`/api/policy/history/${firstAssessmentId}`)
      .set(authHeader(userToken))
      .expect(200);
    expect(detail.body).toMatchObject({
      id: firstAssessmentId,
      ruleVersion: 1,
      accuracy: "verified",
      output: firstOutput
    });
    expect(detail.body.input).not.toHaveProperty("clientResult");

    await request(createApp())
      .get(`/api/policy/history/${firstAssessmentId}`)
      .set(authHeader(otherUserToken))
      .expect(404);
  });
});

describe("policy capability administration", () => {
  it("enforces unauthenticated, user, analyst, and admin capability boundaries", async () => {
    const path = "/api/admin/policy/rule-sets/cn-severance/versions";
    await request(createApp()).get(path).expect(401);
    await request(createApp())
      .get(path)
      .set(authHeader(userToken))
      .expect(403);
    const analystRead = await request(createApp())
      .get(path)
      .set(authHeader(analystToken))
      .expect(200);
    expect(analystRead.body.items[0]).toMatchObject({
      version: 1,
      status: "published"
    });

    const definition = analystRead.body.items[0].definition;
    await request(createApp())
      .post(path)
      .set(authHeader(analystToken))
      .send({
        definition,
        sourceSnapshot: [],
        effectiveFrom: "2030-01-01"
      })
      .expect(403);
    await request(createApp())
      .get(path)
      .set(authHeader(adminToken))
      .expect(200);
  });

  it("forwards capability lookup failures to the central 500 handler", async () => {
    await query(
      "ALTER TABLE role_capabilities RENAME TO role_capabilities_hidden_for_test"
    );
    try {
      const response = await request(createApp())
        .get("/api/admin/policy/rule-sets/cn-severance/versions")
        .set(authHeader(adminToken))
        .expect(500);
      expect(response.body).toEqual({
        error: "INTERNAL_ERROR",
        message: "服务暂时开小差了"
      });
    } finally {
      await query(
        "ALTER TABLE role_capabilities_hidden_for_test RENAME TO role_capabilities"
      );
    }
  });

  it("creates concurrent draft versions uniquely and audits the writes", async () => {
    const path = "/api/admin/policy/rule-sets/cn-severance/versions";
    const listed = await request(createApp())
      .get(path)
      .set(authHeader(adminToken))
      .expect(200);
    const definition = listed.body.items[0].definition;

    const responses = await Promise.all(
      ["2030-01-01", "2050-01-01"].map((effectiveFrom) =>
        request(createApp())
          .post(path)
          .set(authHeader(adminToken))
          .send({
            definition,
            sourceSnapshot: [{ source: "parallel draft test" }],
            effectiveFrom
          })
      )
    );
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const versions = responses.map((response) => response.body.version);
    expect(new Set(versions).size).toBe(2);

    const audits = await query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM admin_audit_logs
        WHERE action = 'policy.version.create'
          AND detail->>'source' = 'parallel draft test'`
    );
    expect(audits.rows[0].count).toBe("2");
  });

  it("keeps a failed policy write and its audit in the same transaction", async () => {
    const path = "/api/admin/policy/rule-sets/cn-severance/versions";
    const listed = await request(createApp())
      .get(path)
      .set(authHeader(adminToken))
      .expect(200);
    const before = listed.body.items.length;
    await query(`
      CREATE FUNCTION fail_policy_audit_for_test()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'policy.version.create' THEN
          RAISE EXCEPTION 'forced audit failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER fail_policy_audit_trigger
      BEFORE INSERT ON admin_audit_logs
      FOR EACH ROW EXECUTE FUNCTION fail_policy_audit_for_test()
    `);
    try {
      await request(createApp())
        .post(path)
        .set(authHeader(adminToken))
        .send({
          definition: listed.body.items[0].definition,
          sourceSnapshot: [{ source: "must rollback" }],
          effectiveFrom: "2070-01-01"
        })
        .expect(500);
    } finally {
      await query(`
        DROP TRIGGER IF EXISTS fail_policy_audit_trigger ON admin_audit_logs;
        DROP FUNCTION IF EXISTS fail_policy_audit_for_test()
      `);
    }
    const after = await request(createApp())
      .get(path)
      .set(authHeader(adminToken))
      .expect(200);
    expect(after.body.items).toHaveLength(before);
  });

  it("publishes future policy versions without breaking current or historical selection", async () => {
    const path = "/api/admin/policy/rule-sets/cn-severance/versions";
    const listed = await request(createApp())
      .get(path)
      .set(authHeader(adminToken))
      .expect(200);
    const futureDraft = listed.body.items.find(
      (item: { effectiveFrom: string; status: string }) =>
        item.effectiveFrom === "2030-01-01" && item.status === "draft"
    );
    expect(futureDraft).toBeTruthy();

    await request(createApp())
      .post(`${path}/${futureDraft.id}/publish`)
      .set(authHeader(adminToken))
      .expect(200);

    const current = await request(createApp())
      .post("/api/policy/calculate")
      .set(authHeader(userToken))
      .send(calculationBody())
      .expect(201);
    expect(current.body.ruleVersion).toBe(1);

    const future = await request(createApp())
      .post("/api/policy/calculate")
      .set(authHeader(userToken))
      .send(calculationBody({ endDate: "2031-07-01" }))
      .expect(201);
    expect(future.body.ruleVersion).toBe(futureDraft.version);

    const oldDetail = await request(createApp())
      .get(`/api/policy/history/${firstAssessmentId}`)
      .set(authHeader(userToken))
      .expect(200);
    expect(oldDetail.body).toMatchObject({
      ruleVersion: 1,
      output: firstOutput
    });
  });

  it("rejects overlapping publication without partial state or audit", async () => {
    const path = "/api/admin/policy/rule-sets/cn-severance/versions";
    const listed = await request(createApp())
      .get(path)
      .set(authHeader(adminToken))
      .expect(200);
    const definition = listed.body.items[0].definition;
    const draft = await request(createApp())
      .post(path)
      .set(authHeader(adminToken))
      .send({
        definition,
        sourceSnapshot: [{ source: "overlap test" }],
        effectiveFrom: "2029-01-01",
        effectiveTo: "2031-01-01"
      })
      .expect(201);
    const beforeAudit = await query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM admin_audit_logs
        WHERE action = 'policy.version.publish'
          AND target_id = $1`,
      [draft.body.id]
    );

    const rejected = await request(createApp())
      .post(`${path}/${draft.body.id}/publish`)
      .set(authHeader(adminToken))
      .expect(409);
    expect(rejected.body.error).toBe("POLICY_VERSION_OVERLAP");

    const state = await query<{ status: string }>(
      "SELECT status FROM policy_rule_versions WHERE id = $1",
      [draft.body.id]
    );
    const afterAudit = await query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM admin_audit_logs
        WHERE action = 'policy.version.publish'
          AND target_id = $1`,
      [draft.body.id]
    );
    expect(state.rows[0].status).toBe("draft");
    expect(afterAudit.rows[0].count).toBe(beforeAudit.rows[0].count);
  });

  it("serializes concurrent publish and rollback operations with traceable new versions", async () => {
    const path = "/api/admin/policy/rule-sets/cn-severance/versions";
    const listed = await request(createApp())
      .get(path)
      .set(authHeader(adminToken))
      .expect(200);
    const definition = listed.body.items[0].definition;
    const drafts = await Promise.all(
      ["2060-01-01", "2060-01-01"].map((effectiveFrom, index) =>
        request(createApp())
          .post(path)
          .set(authHeader(adminToken))
          .send({
            definition,
            sourceSnapshot: [{ source: `publish race ${index}` }],
            effectiveFrom
          })
      )
    );
    const publishResults = await Promise.all(
      drafts.map((draft) =>
        request(createApp())
          .post(`${path}/${draft.body.id}/publish`)
          .set(authHeader(adminToken))
      )
    );
    expect(publishResults.map((response) => response.status).sort()).toEqual([
      200,
      409
    ]);

    await request(createApp())
      .post(path)
      .set(authHeader(adminToken))
      .send({
        definition,
        sourceSnapshot: [{ source: "later unpublished draft" }],
        effectiveFrom: "2090-01-01"
      })
      .expect(201);

    const rollbacks = await Promise.all(
      [0, 1].map(() =>
        request(createApp())
          .post("/api/admin/policy/rule-sets/cn-severance/rollback")
          .set(authHeader(adminToken))
          .send({ targetVersion: 1, effectiveFrom: "2080-01-01" })
      )
    );
    expect(rollbacks.map((response) => response.status).sort()).toEqual([
      201,
      409
    ]);
    const rolledBack = rollbacks.find((response) => response.status === 201)!;
    expect(rolledBack.body).toMatchObject({
      status: "published",
      rolledBackFromVersion: 1,
      effectiveFrom: "2080-01-01"
    });
    expect(rolledBack.body.version).toBeGreaterThan(1);

    const audit = await query<{ detail: Record<string, unknown> }>(
      `SELECT detail
         FROM admin_audit_logs
        WHERE action = 'policy.version.rollback'
          AND target_id = $1`,
      [rolledBack.body.id]
    );
    expect(audit.rows[0].detail).toMatchObject({
      targetVersion: 1,
      newVersion: rolledBack.body.version
    });
  });

  it("strictly validates drafts and transactionally upserts reviewed parameters", async () => {
    const path = "/api/admin/policy/rule-sets/cn-severance/versions";
    const listed = await request(createApp())
      .get(path)
      .set(authHeader(adminToken))
      .expect(200);
    await request(createApp())
      .post(path)
      .set(authHeader(adminToken))
      .send({
        definition: {
          ...listed.body.items[0].definition,
          schemaVersion: 1,
          hiddenOverride: true
        },
        sourceSnapshot: [],
        effectiveFrom: "2090-01-01"
      })
      .expect(400);

    const response = await request(createApp())
      .put("/api/admin/policy/regional-parameters")
      .set(authHeader(adminToken))
      .send({
        regionCode: "420100",
        year: 2026,
        parameterType: "minimum_monthly_wage",
        amountFen: 260000,
        sourceName: "武汉最低工资官方公告",
        sourceUrl: "https://example.test/wuhan-minimum",
        sourcePublishedAt: "2026-02-01",
        status: "verified",
        reviewerId: "00000000-0000-0000-0000-000000000000"
      })
      .expect(200);
    expect(response.body).toMatchObject({
      regionCode: "420100",
      regionName: "武汉市",
      year: 2026,
      amountFen: 260000,
      status: "verified"
    });
    const persisted = await query<{
      reviewed_by: string;
      action: string;
      detail: Record<string, unknown>;
    }>(
      `SELECT rp.reviewed_by, aal.action, aal.detail
         FROM regional_parameters rp
         JOIN admin_audit_logs aal
           ON aal.target_id = rp.id::text
          AND aal.action = 'policy.parameter.upsert'
        WHERE rp.id = $1`,
      [response.body.id]
    );
    expect(persisted.rows[0].reviewed_by).not.toBe(
      "00000000-0000-0000-0000-000000000000"
    );
    expect(persisted.rows[0].detail).toMatchObject({
      source: "武汉最低工资官方公告"
    });
  });

  it("reports active-region coverage with exact, fallback, and manual-needed status", async () => {
    const response = await request(createApp())
      .get("/api/admin/policy/coverage?year=2026")
      .set(authHeader(analystToken))
      .expect(200);

    expect(response.body.items).toHaveLength(364);
    expect(response.body.items).not.toContainEqual(
      expect.objectContaining({ regionCode: "429999" })
    );
    expect(
      response.body.items.find(
        (item: { regionCode: string }) => item.regionCode === "420100"
      )
    ).toMatchObject({
      minimumMonthlyWage: "exact",
      employeeAverageMonthlyWage: "exact"
    });
    expect(
      response.body.items.find(
        (item: { regionCode: string }) => item.regionCode === "130100"
      )
    ).toMatchObject({
      minimumMonthlyWage: "fallback",
      employeeAverageMonthlyWage: "manual-needed"
    });
  });
});
