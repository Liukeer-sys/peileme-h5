import bcrypt from "bcryptjs";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it
} from "vitest";
import { createApp } from "../app.js";
import { closePool, getPool, query } from "../db.js";
import { runMigrations } from "../migrate.js";
import { seedPolicyFoundation } from "../modules/policy/seed.js";
import { signAccessToken, type AuthUser } from "../security.js";
import { importAdministrativeRegions } from "../../scripts/import-administrative-regions.js";
import { importRegionalParameters } from "../../scripts/import-regional-parameters.js";

const authHeader = (token: string) => ({
  authorization: `Bearer ${token}`
});

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
let passwordHash = "";

beforeAll(async () => {
  await runMigrations();
  passwordHash = await bcrypt.hash("PolicyPass123", 4);
});

beforeEach(async () => {
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

  await importAdministrativeRegions(
    "database/seeds/administrative-regions.csv"
  );
  await importRegionalParameters(
    "database/seeds/regional-parameters.csv"
  );
  await query(
    `INSERT INTO administrative_regions(
       code, name, level, parent_code, status,
       source_name, source_url, source_snapshot_date
     )
     VALUES (
       '429999', '已撤销测试地区', 'prefecture', '420000', 'retired',
       '测试区划', 'https://www.mca.gov.cn/test/regions', DATE '2026-01-01'
     )`
  );

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

  const users = await query<{
    id: string;
    role: AuthUser["role"];
    email: string;
    phone: string | null;
    display_name: string;
    status: AuthUser["status"];
  }>(
    `SELECT id, role, email, phone, display_name, status
       FROM users
      WHERE email LIKE '%@peileme.test'`
  );
  const tokenFor = async (email: string) => {
    const user = users.rows.find((row) => row.email === email)!;
    return signAccessToken({
      id: user.id,
      role: user.role,
      email: user.email,
      phone: user.phone,
      displayName: user.display_name,
      status: user.status
    });
  };
  adminToken = await tokenFor("policy-admin@peileme.test");
  analystToken = await tokenFor("policy-analyst@peileme.test");
  userToken = await tokenFor("policy-user@peileme.test");
  otherUserToken = await tokenFor("other-policy-user@peileme.test");
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

  it("marks a verified parent fallback estimated and persists an atomic snapshot", async () => {
    const response = await request(createApp())
      .post("/api/policy/calculate")
      .set(authHeader(userToken))
      .send(calculationBody())
      .expect(201);

    const assessmentId = response.body.assessmentId;
    expect(response.body).toMatchObject({
      ruleVersion: 1,
      accuracy: "estimated",
      parameters: {
        minimumMonthlyWage: {
          source: "database",
          status: "verified",
          year: 2026,
          regionCode: "420000",
          regionName: "湖北省",
          fallback: true,
          amountFen: 240000,
          parameterType: "minimum_monthly_wage",
          sourceName:
            "人力资源社会保障部劳动关系司：全国各省、自治区、直辖市最低工资标准情况（截至2026年1月1日）",
          sourceUrl:
            "https://www.mohrss.gov.cn/SYrlzyhshbzb/laodongguanxi_/fwyd/202601/t20260112_565296.html",
          sourcePublishedAt: "2026-01-12",
          reviewedBy: null,
          reviewedAt: null
        },
        employeeAverageMonthlyWage: {
          source: "database",
          status: "verified",
          year: 2024,
          regionCode: "420100",
          regionName: "武汉市",
          fallback: false,
          amountFen: 940975,
          parameterType: "employee_average_monthly_wage",
          sourceName: "武汉市统计局：关于2024年劳动工资统计数据的公告",
          sourceUrl:
            "https://tjj.wuhan.gov.cn/xwzx/tzgg/202506/t20250620_2598379.shtml",
          sourcePublishedAt: "2025-06-20",
          reviewedBy: null,
          reviewedAt: null
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
      parameter_provenance: unknown;
    }>(
      `SELECT a.id AS assessment_id, a.user_id, a.product_channel, a.status,
              a.accuracy_level, prv.version, a.input_snapshot,
              a.result_snapshot, pcs.input, pcs.output, pcs.input_hash,
              pcs.regional_parameter_ids, pcs.parameter_provenance
         FROM assessments a
         JOIN policy_rule_versions prv ON prv.id = a.rule_version_id
         JOIN policy_calculation_snapshots pcs ON pcs.assessment_id = a.id
        WHERE a.id = $1`,
      [assessmentId]
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({
      assessment_id: assessmentId,
      product_channel: "main",
      status: "completed",
      accuracy_level: "estimated",
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
    expect(stored.rows[0].parameter_provenance).toEqual(
      response.body.parameters
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

  it("hashes engine-equivalent canonical inputs identically", async () => {
    const omittedDefault = {
      regionCode: "420100",
      startDate: "2020-01-01",
      endDate: "2026-07-01",
      terminationScenario: {
        kind: "ARTICLE_40",
        noticeMethod: "notice_30_days"
      },
      monthlyEarnedWagesFen: Array(12).fill(1_000_000),
      clientResult: { payableFen: 1 },
      unknownFact: "ignored"
    };
    const explicitDefaultScrambled = {
      unknownFact: "also ignored",
      alreadyPaidFen: 0,
      monthlyEarnedWagesFen: Array(12).fill(1_000_000),
      terminationScenario: {
        noticeMethod: "notice_30_days",
        kind: "ARTICLE_40"
      },
      endDate: "2026-07-01",
      startDate: "2020-01-01",
      regionName: "客户端名称",
      regionCode: "420100"
    };
    const calculateAndRead = async (body: Record<string, unknown>) => {
      const response = await request(createApp())
        .post("/api/policy/calculate")
        .set(authHeader(userToken))
        .send(body)
        .expect(201);
      const snapshot = await query<{
        input_hash: string;
        input: Record<string, unknown>;
      }>(
        `SELECT input_hash, input
           FROM policy_calculation_snapshots
          WHERE assessment_id = $1`,
        [response.body.assessmentId]
      );
      return snapshot.rows[0];
    };

    const omitted = await calculateAndRead(omittedDefault);
    const explicit = await calculateAndRead(explicitDefaultScrambled);
    const changed = await calculateAndRead({
      ...omittedDefault,
      monthlyEarnedWagesFen: Array(12).fill(1_000_001)
    });

    expect(omitted.input.alreadyPaidFen).toBe(0);
    expect(explicit.input.alreadyPaidFen).toBe(0);
    expect(omitted.input).not.toHaveProperty("unknownFact");
    expect(omitted.input_hash).toBe(explicit.input_hash);
    expect(changed.input_hash).not.toBe(omitted.input_hash);
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
    expect(response.body.parameters.employeeAverageMonthlyWage).toMatchObject({
      source: "manual",
      parameterType: "employee_average_monthly_wage",
      regionCode: "130100",
      regionName: "石家庄市",
      fallback: false,
      amountFen: 800000
    });
  });

  it("marks stale DB provenance and requires absent values", async () => {
    const inserted = await query<{ id: string; region_code: string }>(
      `INSERT INTO regional_parameters(
         region_code, region_name, year, parameter_type, amount_fen,
         source_name, source_url, source_published_at, status
       )
       VALUES
         (
           '420100', '武汉市', 2026, 'minimum_monthly_wage', 250000,
           '过期测试来源', 'https://www.mohrss.gov.cn/test/stale',
           DATE '2026-01-01', 'stale'
         ),
         (
           '130100', '石家庄市', 2026, 'minimum_monthly_wage', 230000,
           '过期测试来源', 'https://www.mohrss.gov.cn/test/stale-manual',
           DATE '2026-01-01', 'stale'
         )
       RETURNING id, region_code`
    );
    try {
      const wuhanStale = inserted.rows.find(
        (row) => row.region_code === "420100"
      )!;
      const stale = await request(createApp())
        .post("/api/policy/calculate")
        .set(authHeader(userToken))
        .send(calculationBody())
        .expect(201);
      expect(stale.body.accuracy).toBe("stale");
      expect(stale.body.parameters.minimumMonthlyWage).toMatchObject({
        parameterId: wuhanStale.id,
        status: "stale",
        regionCode: "420100",
        fallback: false
      });

      const staleWithManual = await request(createApp())
        .post("/api/policy/calculate")
        .set(authHeader(userToken))
        .send(
          calculationBody({
            regionCode: "130100",
            manualParameters: {
              employeeAverageMonthlyWageFen: 800000
            }
          })
        )
        .expect(201);
      expect(staleWithManual.body.accuracy).toBe("stale");
      expect(staleWithManual.body.parameters).toMatchObject({
        minimumMonthlyWage: {
          source: "database",
          status: "stale",
          fallback: false
        },
        employeeAverageMonthlyWage: {
          source: "manual"
        }
      });
    } finally {
      await query(
        "DELETE FROM regional_parameters WHERE id = ANY($1::uuid[])",
        [inserted.rows.map((row) => row.id)]
      );
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
          '未来平均工资', 'https://tjj.wuhan.gov.cn/test/future-average',
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
      const regions = await request(createApp())
        .get("/api/policy/regions?level=prefecture")
        .expect(200);
      expect(regions.body.items).not.toContainEqual(
        expect.objectContaining({ code: "420100" })
      );

      const coverage = await request(createApp())
        .get("/api/admin/policy/coverage?year=2026")
        .set(authHeader(adminToken))
        .expect(200);
      expect(coverage.body.items).not.toContainEqual(
        expect.objectContaining({ regionCode: "420100" })
      );

      const inactiveParent = await request(createApp())
        .post("/api/policy/calculate")
        .set(authHeader(userToken))
        .send(calculationBody())
        .expect(422);
      expect(inactiveParent.body).toMatchObject({
        error: "REGION_UNAVAILABLE"
      });
    } finally {
      await query(
        "UPDATE administrative_regions SET status = 'active' WHERE code = '420000'"
      );
    }
  });

  it("locks child and parent in global order against concurrent retirement", async () => {
    const retireClient = await getPool().connect();
    const before = await query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM assessments a
         JOIN users u ON u.id = a.user_id
        WHERE u.email = 'policy-user@peileme.test'`
    );
    let retireError: unknown;
    let transactionOpen = false;
    try {
      await retireClient.query("BEGIN");
      transactionOpen = true;
      await retireClient.query("SET LOCAL deadlock_timeout = '100ms'");
      const backend = await retireClient.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid"
      );
      await retireClient.query(
        `SELECT code
           FROM administrative_regions
          WHERE code = '420000'
          FOR UPDATE`
      );

      const calculationPromise = request(createApp())
        .post("/api/policy/calculate")
        .set(authHeader(userToken))
        .send(calculationBody())
        .then((response) => response);
      await waitUntil(async () => {
        const waiting = await query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1
               FROM pg_stat_activity
              WHERE datname = current_database()
                AND pid <> $1
                AND wait_event_type = 'Lock'
           ) AS waiting`,
          [backend.rows[0].pid]
        );
        return waiting.rows[0].waiting;
      });

      try {
        await retireClient.query(
          `UPDATE administrative_regions
              SET status = 'retired'
            WHERE code = '420100'`
        );
        await retireClient.query(
          `UPDATE administrative_regions
              SET status = 'retired'
            WHERE code = '420000'`
        );
        await retireClient.query("COMMIT");
        transactionOpen = false;
      } catch (error) {
        retireError = error;
        await retireClient.query("ROLLBACK");
        transactionOpen = false;
      }
      const calculation = await calculationPromise;
      expect((retireError as { code?: string } | undefined)?.code).not.toBe(
        "40P01"
      );
      expect([201, 404, 422]).toContain(calculation.status);

      const after = await query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM assessments a
           JOIN users u ON u.id = a.user_id
          WHERE u.email = 'policy-user@peileme.test'`
      );
      expect(Number(after.rows[0].count) - Number(before.rows[0].count)).toBe(
        calculation.status === 201 ? 1 : 0
      );
    } finally {
      if (transactionOpen) await retireClient.query("ROLLBACK");
      retireClient.release();
      await query(
        `UPDATE administrative_regions
            SET status = 'active'
          WHERE code = ANY($1::text[])`,
        [["420000", "420100"]]
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

  it("keeps full parameter provenance immutable in owner-only history", async () => {
    const first = await request(createApp())
      .post("/api/policy/calculate")
      .set(authHeader(userToken))
      .send(calculationBody())
      .expect(201);
    const firstAssessmentId = first.body.assessmentId as string;
    const firstOutput = first.body.result;
    const frozenParameters = first.body.parameters;

    await query(
      `UPDATE regional_parameters
          SET amount_fen = 999999,
              source_name = '后续更新的参数来源',
              source_url = 'https://tjj.wuhan.gov.cn/changed-after-calculation',
              source_published_at = DATE '2026-07-01',
              reviewed_at = now()
        WHERE id = $1`,
      [frozenParameters.employeeAverageMonthlyWage.parameterId]
    );
    await query(
      `UPDATE assessments
          SET answers = '{"parameterProvenance":{"tampered":true}}'::jsonb
        WHERE id = $1`,
      [firstAssessmentId]
    );
    await request(createApp())
      .post("/api/policy/calculate")
      .set(authHeader(userToken))
      .send(calculationBody({ alreadyPaidFen: 200_000 }))
      .expect(201);

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
      accuracy: "estimated",
      parameters: frozenParameters,
      output: firstOutput
    });
    expect(detail.body.parameters.employeeAverageMonthlyWage).toMatchObject({
      amountFen: 940975,
      sourceName: "武汉市统计局：关于2024年劳动工资统计数据的公告",
      sourceUrl:
        "https://tjj.wuhan.gov.cn/xwzx/tzgg/202506/t20250620_2598379.shtml",
      sourcePublishedAt: "2025-06-20"
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
    const historical = await request(createApp())
      .post("/api/policy/calculate")
      .set(authHeader(userToken))
      .send(calculationBody())
      .expect(201);
    const futureDraft = (
      await request(createApp())
        .post(path)
        .set(authHeader(adminToken))
        .send({
          definition: listed.body.items[0].definition,
          sourceSnapshot: [{ source: "future publication test" }],
          effectiveFrom: "2030-01-01"
        })
        .expect(201)
    ).body;

    await request(createApp())
      .post(`${path}/${futureDraft.id}/publish`)
      .set(authHeader(adminToken))
      .expect(200);

    const managedBeforeSeed = await query<{
      definition: unknown;
      source_snapshot: unknown;
    }>(
      `SELECT definition, source_snapshot
         FROM policy_rule_versions
        WHERE id = $1`,
      [futureDraft.id]
    );
    await seedPolicyFoundation();
    await seedPolicyFoundation();
    const seedState = await query<{
      active_version_id: string | null;
      current_version_id: string | null;
      baseline_effective_to: string | null;
      overlap_count: string;
      managed_definition: unknown;
      managed_source_snapshot: unknown;
    }>(
      `SELECT prs.active_version_id,
              (
                SELECT id
                  FROM policy_rule_versions
                 WHERE rule_set_id = prs.id
                   AND status = 'published'
                   AND effective_from <= current_date
                   AND (
                     effective_to IS NULL OR
                     effective_to >= current_date
                   )
                 ORDER BY version DESC
                 LIMIT 1
              ) AS current_version_id,
              (
                SELECT effective_to::text
                  FROM policy_rule_versions
                 WHERE rule_set_id = prs.id
                   AND version = 1
              ) AS baseline_effective_to,
              (
                SELECT count(*)::text
                  FROM policy_rule_versions left_version
                  JOIN policy_rule_versions right_version
                    ON right_version.rule_set_id = left_version.rule_set_id
                   AND right_version.id > left_version.id
                   AND right_version.status = 'published'
                   AND left_version.status = 'published'
                   AND right_version.effective_from <=
                       coalesce(left_version.effective_to, DATE '9999-12-31')
                   AND left_version.effective_from <=
                       coalesce(right_version.effective_to, DATE '9999-12-31')
                 WHERE left_version.rule_set_id = prs.id
              ) AS overlap_count,
              managed.definition AS managed_definition,
              managed.source_snapshot AS managed_source_snapshot
         FROM policy_rule_sets prs
         JOIN policy_rule_versions managed ON managed.id = $1
        WHERE prs.code = 'cn-severance'`,
      [futureDraft.id]
    );
    expect(seedState.rows[0]).toMatchObject({
      baseline_effective_to: "2029-12-31",
      overlap_count: "0",
      managed_definition: managedBeforeSeed.rows[0].definition,
      managed_source_snapshot: managedBeforeSeed.rows[0].source_snapshot
    });
    expect(seedState.rows[0].active_version_id).toBe(
      seedState.rows[0].current_version_id
    );

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
      .get(`/api/policy/history/${historical.body.assessmentId}`)
      .set(authHeader(userToken))
      .expect(200);
    expect(oldDetail.body).toMatchObject({
      ruleVersion: 1,
      output: historical.body.result
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

  it("strictly validates policy rule drafts", async () => {
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
  });

  it("requires publish review and trustworthy official evidence for calculation parameters", async () => {
    await query(
      `INSERT INTO role_capabilities(role, capability)
       VALUES ('analyst', 'policy.write')
       ON CONFLICT DO NOTHING`
    );
    const base = {
      regionCode: "420100",
      year: 2026,
      parameterType: "minimum_monthly_wage",
      amountFen: 260000,
      sourceName: "武汉最低工资官方公告",
      sourceUrl:
        "https://rsj.wuhan.gov.cn/zwgk_17/zc/qtzdgkwj/202602/t20260201_000001.shtml",
      sourcePublishedAt: "2026-02-01"
    };

    await request(createApp())
      .put("/api/admin/policy/regional-parameters")
      .set(authHeader(analystToken))
      .send({ ...base, status: "draft" })
      .expect(200);
    for (const status of ["verified", "stale"]) {
      const forbiddenReview = await request(createApp())
        .put("/api/admin/policy/regional-parameters")
        .set(authHeader(analystToken))
        .send({ ...base, status })
        .expect(403);
      expect(forbiddenReview.body.error).toBe("CAPABILITY_REQUIRED");
    }

    for (const invalid of [
      {
        ...base,
        sourceUrl: "https://gov.cn.attacker.example/source",
        status: "verified"
      },
      {
        ...base,
        sourceUrl: "https://gov.cn.attacker.example/stale-source",
        status: "stale"
      },
      {
        ...base,
        sourceUrl: "http://www.gov.cn/source",
        status: "verified"
      },
      {
        ...base,
        sourcePublishedAt: "2099-01-01",
        status: "verified"
      },
      {
        ...base,
        year: 2100,
        sourcePublishedAt: "2026-02-01",
        status: "verified"
      },
      {
        ...base,
        year: 2026,
        sourcePublishedAt: "2025-12-31",
        status: "verified"
      }
    ]) {
      const rejected = await request(createApp())
        .put("/api/admin/policy/regional-parameters")
        .set(authHeader(adminToken))
        .send(invalid)
        .expect(400);
      expect(rejected.body.error).toBe("VALIDATION_ERROR");
    }

    const staleResponse = await request(createApp())
      .put("/api/admin/policy/regional-parameters")
      .set(authHeader(adminToken))
      .send({ ...base, status: "stale" })
      .expect(200);
    expect(staleResponse.body.status).toBe("stale");

    const response = await request(createApp())
      .put("/api/admin/policy/regional-parameters")
      .set(authHeader(adminToken))
      .send({
        ...base,
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

    const exactCalculation = await request(createApp())
      .post("/api/policy/calculate")
      .set(authHeader(userToken))
      .send(calculationBody())
      .expect(201);
    expect(exactCalculation.body.accuracy).toBe("verified");
    expect(exactCalculation.body.parameters.minimumMonthlyWage).toMatchObject({
      source: "database",
      fallback: false,
      status: "verified",
      sourceUrl: base.sourceUrl
    });
  });

  it("reports active-region coverage with exact, fallback, and manual-needed status", async () => {
    await request(createApp())
      .put("/api/admin/policy/regional-parameters")
      .set(authHeader(adminToken))
      .send({
        regionCode: "420100",
        year: 2026,
        parameterType: "minimum_monthly_wage",
        amountFen: 260000,
        sourceName: "武汉最低工资官方公告",
        sourceUrl:
          "https://rsj.wuhan.gov.cn/zwgk_17/zc/qtzdgkwj/202602/t20260201_000001.shtml",
        sourcePublishedAt: "2026-02-01",
        status: "verified"
      })
      .expect(200);
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

  it("keeps a retired baseline retired when repeated seed recomputes the active pointer", async () => {
    const baseline = await query<{
      id: string;
      rule_set_id: string;
      definition: unknown;
      source_snapshot: unknown;
    }>(
      `SELECT prv.id, prv.rule_set_id, prv.definition, prv.source_snapshot
         FROM policy_rule_versions prv
         JOIN policy_rule_sets prs ON prs.id = prv.rule_set_id
        WHERE prs.code = 'cn-severance'
          AND prv.version = 1`
    );
    await query(
      `UPDATE policy_rule_versions
          SET status = 'retired',
              effective_to = current_date - 1
        WHERE id = $1`,
      [baseline.rows[0].id]
    );
    const promoted = await query<{ id: string }>(
      `INSERT INTO policy_rule_versions(
         rule_set_id, version, status, definition, source_snapshot,
         effective_from, effective_to, published_at
       )
       VALUES (
         $1, 2, 'published', $2::jsonb, $3::jsonb,
         current_date, NULL, now()
       )
       RETURNING id`,
      [
        baseline.rows[0].rule_set_id,
        JSON.stringify(baseline.rows[0].definition),
        JSON.stringify([{ source: "admin-managed-v2" }])
      ]
    );
    await query(
      `UPDATE policy_rule_sets
          SET active_version_id = $1
        WHERE code = 'cn-severance'`,
      [baseline.rows[0].id]
    );

    await seedPolicyFoundation();
    await seedPolicyFoundation();
    const active = await query<{
      active_version_id: string | null;
      baseline_status: string;
      baseline_effective_to: string | null;
      promoted_source_snapshot: unknown;
      overlap_count: string;
    }>(
      `SELECT prs.active_version_id,
              baseline.status AS baseline_status,
              baseline.effective_to::text AS baseline_effective_to,
              promoted.source_snapshot AS promoted_source_snapshot,
              (
                SELECT count(*)::text
                  FROM policy_rule_versions left_version
                  JOIN policy_rule_versions right_version
                    ON right_version.rule_set_id = left_version.rule_set_id
                   AND right_version.id > left_version.id
                   AND right_version.status = 'published'
                   AND left_version.status = 'published'
                   AND right_version.effective_from <=
                       coalesce(left_version.effective_to, DATE '9999-12-31')
                   AND left_version.effective_from <=
                       coalesce(right_version.effective_to, DATE '9999-12-31')
                 WHERE left_version.rule_set_id = prs.id
              ) AS overlap_count
         FROM policy_rule_sets prs
         JOIN policy_rule_versions baseline
           ON baseline.rule_set_id = prs.id
          AND baseline.version = 1
         JOIN policy_rule_versions promoted ON promoted.id = $1
        WHERE prs.code = 'cn-severance'`,
      [promoted.rows[0].id]
    );
    expect(active.rows[0]).toEqual({
      active_version_id: promoted.rows[0].id,
      baseline_status: "retired",
      baseline_effective_to: expect.any(String),
      promoted_source_snapshot: [{ source: "admin-managed-v2" }],
      overlap_count: "0"
    });
  });
});
