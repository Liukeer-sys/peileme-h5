import crypto from "node:crypto";
import type { Request } from "express";
import { z } from "zod";
import { writeAdminAudit } from "../../audit.js";
import { query, withTransaction } from "../../db.js";
import { ApiError } from "../../errors.js";
import type {
  PolicyInput,
  PolicyOutput
} from "./types.js";

export type PolicyRegion = {
  code: string;
  name: string;
  level: "province" | "prefecture";
  parentCode: string | null;
  parameterAvailability?: {
    minimumMonthlyWage: "exact" | "fallback" | "manual-needed";
    employeeAverageMonthlyWage: "exact" | "manual-needed";
  };
};

export const policyDefinitionSchema = z
  .object({
    schemaVersion: z.literal(2),
    decisionModel: z
      .object({
        mutualAgreement: z
          .object({
            employerProposed: z
              .object({ compensation: z.literal("N") })
              .strict(),
            employeeProposed: z
              .object({
                compensation: z.literal("ZERO"),
                agreementReviewRequired: z.literal(true)
              })
              .strict()
          })
          .strict(),
        article40EmployerTermination: z
          .object({
            notice30Days: z
              .object({
                compensation: z.literal("N"),
                noticePayMonths: z.literal(0)
              })
              .strict(),
            paymentInLieu: z
              .object({
                compensation: z.literal("N"),
                noticePayMonths: z.literal(1)
              })
              .strict()
          })
          .strict(),
        employeeTermination: z
          .object({
            article38: z
              .object({ compensation: z.literal("N") })
              .strict(),
            voluntaryResignation: z
              .object({ compensation: z.literal("ZERO") })
              .strict()
          })
          .strict(),
        unlawfulTermination: z
          .object({
            primaryRemedy: z.literal("CONTINUE_PERFORMANCE"),
            fallbackCompensation: z.literal("TWO_N"),
            fallbackWhen: z.tuple([
              z.literal("EMPLOYEE_DOES_NOT_REQUEST_CONTINUATION"),
              z.literal("CONTINUED_PERFORMANCE_IMPOSSIBLE")
            ])
          })
          .strict(),
        unclear: z
          .object({ result: z.literal("REVIEW") })
          .strict()
      })
      .strict(),
    serviceYearFraction: z
      .object({
        lessThanSixMonths: z.literal(0.5),
        atLeastSixMonths: z.literal(1)
      })
      .strict(),
    highSalaryCap: z
      .object({
        localAverageMultiplier: z.literal(3),
        serviceYearCap: z.literal(12)
      })
      .strict()
  })
  .strict();

export type PolicyDefinition = z.infer<typeof policyDefinitionSchema>;

export type ManualPolicyParameters = {
  minimumMonthlyWageFen?: number;
  employeeAverageMonthlyWageFen?: number;
};

export type PolicyFacts = Omit<
  PolicyInput,
  | "regionName"
  | "minimumMonthlyWageFen"
  | "employeeAverageMonthlyWageFen"
> & {
  manualParameters?: ManualPolicyParameters;
};

type ParameterType =
  | "minimum_monthly_wage"
  | "employee_average_monthly_wage";

type ParameterRow = {
  id: string;
  region_code: string;
  region_name: string;
  year: number;
  parameter_type: ParameterType;
  amount_fen: string;
  status: "verified" | "stale";
  source_name: string;
  source_url: string;
  source_published_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
};

export type ParameterProvenance =
  | {
      source: "database";
      parameterId: string;
      status: "verified" | "stale";
      year: number;
      regionCode: string;
      regionName: string;
      fallback: boolean;
      amountFen: number;
      parameterType: ParameterType;
      sourceName: string;
      sourceUrl: string;
      sourcePublishedAt: string;
      reviewedBy: string | null;
      reviewedAt: string | null;
    }
  | {
      source: "manual";
      parameterId: null;
      status: "manual";
      year: null;
      regionCode: string;
      regionName: string;
      fallback: false;
      amountFen: number;
      parameterType: ParameterType;
      sourceName: null;
      sourceUrl: null;
      sourcePublishedAt: null;
      reviewedBy: null;
      reviewedAt: null;
    };

export type CalculationResult = {
  assessmentId: string;
  ruleVersion: number;
  accuracy: "verified" | "estimated" | "stale";
  parameters: {
    minimumMonthlyWage: ParameterProvenance;
    employeeAverageMonthlyWage: ParameterProvenance;
  };
  result: PolicyOutput;
};

type PolicyCalculator = (input: unknown) => PolicyOutput;

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const normalizeHistoryInput = (input: unknown) => {
  const record =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const confirmation = record.wageDataConfirmation;
  const confirmed =
    confirmation &&
    typeof confirmation === "object" &&
    !Array.isArray(confirmation) &&
    (confirmation as Record<string, unknown>).confirmed === true &&
    (confirmation as Record<string, unknown>).basis ===
      "pretax_earned_including_bonus_allowance";
  return {
    ...record,
    wageDataConfirmation: confirmed
      ? {
          confirmed: true as const,
          basis: "pretax_earned_including_bonus_allowance" as const
        }
      : {
          confirmed: false as const,
          basis: "legacy_unverified" as const
        }
  };
};

const formatVersion = (row: {
  id: string;
  version: number;
  status: string;
  definition: unknown;
  source_snapshot: unknown;
  effective_from: string;
  effective_to: string | null;
  published_by?: string | null;
  published_at?: string | null;
  created_at?: string;
}) => ({
  id: row.id,
  version: row.version,
  status: row.status,
  definition: row.definition,
  sourceSnapshot: row.source_snapshot,
  effectiveFrom: row.effective_from,
  effectiveTo: row.effective_to,
  publishedBy: row.published_by ?? null,
  publishedAt: row.published_at ?? null,
  ...(row.created_at ? { createdAt: row.created_at } : {})
});

const sourceLabel = (snapshot: unknown) => {
  if (!Array.isArray(snapshot) || snapshot.length === 0) return "api";
  const first = snapshot[0];
  if (!first || typeof first !== "object") return "api";
  const record = first as Record<string, unknown>;
  for (const key of ["source", "instrument", "sourceName"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return "api";
};

export class PolicyRepository {
  async listRegions(
    level?: PolicyRegion["level"],
    year?: number
  ): Promise<PolicyRegion[]> {
    const result = await query<{
      code: string;
      name: string;
      level: PolicyRegion["level"];
      parent_code: string | null;
    }>(
      `SELECT child.code, child.name, child.level, child.parent_code
         FROM administrative_regions child
         LEFT JOIN administrative_regions parent
           ON parent.code = child.parent_code
        WHERE child.status = 'active'
          AND (
            child.level = 'province' OR
            (
              parent.level = 'province' AND
              parent.status = 'active'
            )
          )
          AND ($1::text IS NULL OR child.level = $1)
        ORDER BY
          CASE child.level WHEN 'province' THEN 0 ELSE 1 END,
          child.code`,
      [level ?? null]
    );
    const regions: PolicyRegion[] = result.rows.map((row) => ({
      code: row.code,
      name: row.name,
      level: row.level,
      parentCode: row.parent_code
    }));
    if (year === undefined) return regions;
    const availability = new Map(
      (await this.coverage(year)).map((item) => [item.regionCode, item])
    );
    return regions.map((region) => {
      const item = availability.get(region.code);
      return item
        ? {
            ...region,
            parameterAvailability: {
              minimumMonthlyWage: item.minimumMonthlyWage,
              employeeAverageMonthlyWage: item.employeeAverageMonthlyWage
            }
          }
        : region;
    });
  }

  async calculateAndPersist({
    userId,
    visitorId,
    sessionId,
    facts,
    calculate
  }: {
    userId: string;
    visitorId: string;
    sessionId: string;
    facts: PolicyFacts;
    calculate: PolicyCalculator;
  }): Promise<CalculationResult> {
    return withTransaction(async (client) => {
      const discovery = await client.query<{
        code: string;
        name: string;
        level: PolicyRegion["level"];
        parent_code: string | null;
      }>(
        `SELECT code, name, level, parent_code
           FROM administrative_regions
          WHERE code = $1`,
        [facts.regionCode]
      );
      const discoveredRegion = discovery.rows[0];
      if (!discoveredRegion) {
        throw new ApiError(
          422,
          "REGION_UNAVAILABLE",
          "所选地区当前不可用于政策计算"
        );
      }
      const hierarchyCodes = [
        ...new Set(
          [
            discoveredRegion.code,
            discoveredRegion.parent_code
          ].filter((code): code is string => Boolean(code))
        )
      ].sort();
      const lockedHierarchy = await client.query<{
        code: string;
        name: string;
        level: PolicyRegion["level"];
        parent_code: string | null;
        status: "active" | "retired";
      }>(
        `SELECT code, name, level, parent_code, status
           FROM administrative_regions
          WHERE code = ANY($1::text[])
          ORDER BY code
          FOR SHARE`,
        [hierarchyCodes]
      );
      const hierarchyByCode = new Map(
        lockedHierarchy.rows.map((row) => [row.code, row])
      );
      const region = hierarchyByCode.get(discoveredRegion.code);
      const parent = discoveredRegion.parent_code
        ? hierarchyByCode.get(discoveredRegion.parent_code)
        : undefined;
      const hierarchyActive =
        region?.status === "active" &&
        (
          region.level === "province" ||
          (
            region.level === "prefecture" &&
            parent?.level === "province" &&
            parent.status === "active" &&
            region.parent_code === parent.code
          )
        );
      if (!region || !hierarchyActive) {
        throw new ApiError(
          422,
          "REGION_UNAVAILABLE",
          "所选地区当前不可用于政策计算"
        );
      }

      const versionResult = await client.query<{
        id: string;
        version: number;
        definition: unknown;
      }>(
        `SELECT prv.id, prv.version, prv.definition
           FROM policy_rule_sets prs
           JOIN policy_rule_versions prv ON prv.rule_set_id = prs.id
          WHERE prs.code = 'cn-severance'
            AND prs.product_channel = 'main'
            AND prv.status = 'published'
            AND prv.effective_from <= $1::date
            AND (prv.effective_to IS NULL OR prv.effective_to >= $1::date)
          ORDER BY prv.version DESC
          LIMIT 1
          FOR SHARE OF prv`,
        [facts.endDate]
      );
      const version = versionResult.rows[0];
      if (!version) {
        throw new ApiError(
          422,
          "POLICY_RULE_UNAVAILABLE",
          "该日期暂无可用政策规则"
        );
      }
      if (!policyDefinitionSchema.safeParse(version.definition).success) {
        throw new ApiError(
          422,
          "POLICY_DEFINITION_INVALID",
          "政策规则定义不可用于计算"
        );
      }

      const endYear = Number(facts.endDate.slice(0, 4));
      const selectParameter = async (
        regionCode: string,
        parameterType: ParameterType,
        maximumYear: number
      ) => {
        const result = await client.query<ParameterRow>(
          `SELECT rp.id, rp.region_code, rp.region_name, rp.year,
                  rp.parameter_type, rp.amount_fen::text, rp.status,
                  rp.source_name, rp.source_url,
                  rp.source_published_at::text,
                  rp.reviewed_by, rp.reviewed_at::text
             FROM regional_parameters rp
            WHERE rp.region_code = $1
              AND rp.parameter_type = $2
              AND rp.year <= $3
              AND rp.status IN ('verified', 'stale')
            ORDER BY rp.year DESC
            LIMIT 1
            FOR SHARE OF rp`,
          [regionCode, parameterType, maximumYear]
        );
        return result.rows[0];
      };

      let minimum = await selectParameter(
        region.code,
        "minimum_monthly_wage",
        endYear
      );
      let minimumFallback = false;
      if (!minimum && region.level === "prefecture" && region.parent_code) {
        minimum = await selectParameter(
          region.parent_code,
          "minimum_monthly_wage",
          endYear
        );
        minimumFallback = Boolean(minimum);
      }
      const average = await selectParameter(
        region.code,
        "employee_average_monthly_wage",
        endYear - 1
      );

      const missing: string[] = [];
      if (
        !minimum &&
        facts.manualParameters?.minimumMonthlyWageFen === undefined
      ) {
        missing.push("minimumMonthlyWageFen");
      }
      if (
        !average &&
        facts.manualParameters?.employeeAverageMonthlyWageFen === undefined
      ) {
        missing.push("employeeAverageMonthlyWageFen");
      }
      if (missing.length) {
        throw new ApiError(
          422,
          "REGIONAL_PARAMETERS_REQUIRED",
          "需要补充当地政策参数",
          { missing }
        );
      }

      const databaseProvenance = (
        row: ParameterRow,
        fallback: boolean
      ): ParameterProvenance => ({
        source: "database",
        parameterId: row.id,
        status: row.status,
        year: row.year,
        regionCode: row.region_code,
        regionName: row.region_name,
        fallback,
        amountFen: Number(row.amount_fen),
        parameterType: row.parameter_type,
        sourceName: row.source_name,
        sourceUrl: row.source_url,
        sourcePublishedAt: row.source_published_at,
        reviewedBy: row.reviewed_by,
        reviewedAt: row.reviewed_at
      });
      const manualProvenance = (
        parameterType: ParameterType,
        amountFen: number
      ): ParameterProvenance => ({
        source: "manual",
        parameterId: null,
        status: "manual",
        year: null,
        regionCode: region.code,
        regionName: region.name,
        fallback: false,
        amountFen,
        parameterType,
        sourceName: null,
        sourceUrl: null,
        sourcePublishedAt: null,
        reviewedBy: null,
        reviewedAt: null
      });
      const minimumProvenance = minimum
        ? databaseProvenance(minimum, minimumFallback)
        : manualProvenance(
            "minimum_monthly_wage",
            facts.manualParameters!.minimumMonthlyWageFen!
          );
      const averageProvenance = average
        ? databaseProvenance(average, false)
        : manualProvenance(
            "employee_average_monthly_wage",
            facts.manualParameters!.employeeAverageMonthlyWageFen!
          );
      const parameters = {
        minimumMonthlyWage: minimumProvenance,
        employeeAverageMonthlyWage: averageProvenance
      };
      const provenanceValues = Object.values(parameters);
      const accuracy = provenanceValues.some(
        (item) =>
          item.source === "database" && item.status === "stale"
      )
        ? "stale"
        : provenanceValues.some(
              (item) =>
                item.source === "manual" ||
                (item.source === "database" && item.fallback)
            )
          ? "estimated"
          : "verified";
      const canonicalInput: PolicyInput = {
        regionCode: region.code,
        regionName: region.name,
        startDate: facts.startDate,
        endDate: facts.endDate,
        terminationScenario: facts.terminationScenario,
        monthlyEarnedWagesFen: facts.monthlyEarnedWagesFen,
        wageDataConfirmation: facts.wageDataConfirmation,
        minimumMonthlyWageFen: minimumProvenance.amountFen,
        employeeAverageMonthlyWageFen: averageProvenance.amountFen,
        alreadyPaidFen: facts.alreadyPaidFen ?? 0
      };
      const output = calculate(canonicalInput);
      const parameterIds = provenanceValues.flatMap((item) =>
        item.source === "database" ? [item.parameterId] : []
      );
      const assessment = await client.query<{ id: string }>(
        `INSERT INTO assessments(
           user_id, visitor_id, session_id, status, current_step,
           answers, result, completed_at, product_channel, accuracy_level,
           rule_version_id, input_snapshot, result_snapshot
         )
         VALUES (
           $1, $2, $3, 'completed', 'result',
           $4::jsonb, $5::jsonb, now(), 'main', $6, $7,
           $8::jsonb, $5::jsonb
         )
         RETURNING id`,
        [
          userId,
          visitorId,
          sessionId,
          JSON.stringify({ parameterProvenance: parameters }),
          JSON.stringify(output),
          accuracy,
          version.id,
          JSON.stringify(canonicalInput)
        ]
      );
      const assessmentId = assessment.rows[0].id;
      const inputHash = crypto
        .createHash("sha256")
        .update(stableJson(canonicalInput))
        .digest("hex");
      await client.query(
        `INSERT INTO policy_calculation_snapshots(
           assessment_id, rule_version_id, regional_parameter_ids,
           input, output, input_hash, parameter_provenance
         )
         VALUES (
           $1, $2, $3::uuid[], $4::jsonb, $5::jsonb, $6, $7::jsonb
         )`,
        [
          assessmentId,
          version.id,
          parameterIds,
          JSON.stringify(canonicalInput),
          JSON.stringify(output),
          inputHash,
          JSON.stringify(parameters)
        ]
      );
      return {
        assessmentId,
        ruleVersion: version.version,
        accuracy,
        parameters,
        result: output
      };
    });
  }

  async listHistory(
    userId: string,
    page: number,
    pageSize: number
  ) {
    const offset = (page - 1) * pageSize;
    const [items, total] = await Promise.all([
      query<{
        id: string;
        accuracy_level: string;
        version: number;
        input: PolicyInput;
        output: PolicyOutput;
        created_at: string;
      }>(
        `SELECT a.id, a.accuracy_level, prv.version,
                pcs.input, pcs.output, a.created_at
           FROM assessments a
           JOIN policy_calculation_snapshots pcs
             ON pcs.assessment_id = a.id
           JOIN policy_rule_versions prv ON prv.id = pcs.rule_version_id
          WHERE a.user_id = $1
            AND a.product_channel = 'main'
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT $2 OFFSET $3`,
        [userId, pageSize, offset]
      ),
      query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM assessments a
           JOIN policy_calculation_snapshots pcs
             ON pcs.assessment_id = a.id
          WHERE a.user_id = $1
            AND a.product_channel = 'main'`,
        [userId]
      )
    ]);
    return {
      items: items.rows.map((row) => ({
        id: row.id,
        regionCode: row.input.regionCode,
        regionName: row.input.regionName,
        endDate: row.input.endDate,
        scenario: row.input.terminationScenario.kind,
        ruleVersion: row.version,
        accuracy: row.accuracy_level,
        payableDetermined: row.output.payableDetermined,
        payableFen: row.output.payableFen,
        rangeFen: row.output.rangeFen,
        createdAt: row.created_at
      })),
      pagination: {
        page,
        pageSize,
        total: Number(total.rows[0]?.count || 0)
      }
    };
  }

  async getHistory(userId: string, id: string) {
    const result = await query<{
      id: string;
      accuracy_level: string;
      version: number;
      input: unknown;
      output: PolicyOutput;
      parameter_provenance: CalculationResult["parameters"];
      created_at: string;
    }>(
      `SELECT a.id, a.accuracy_level, prv.version,
              pcs.input, pcs.output, pcs.parameter_provenance,
              a.created_at
         FROM assessments a
         JOIN policy_calculation_snapshots pcs
           ON pcs.assessment_id = a.id
         JOIN policy_rule_versions prv ON prv.id = pcs.rule_version_id
        WHERE a.id = $1
          AND a.user_id = $2
          AND a.product_channel = 'main'`,
      [id, userId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new ApiError(
        404,
        "POLICY_HISTORY_NOT_FOUND",
        "计算记录不存在"
      );
    }
    return {
      id: row.id,
      ruleVersion: row.version,
      accuracy: row.accuracy_level,
      parameters: row.parameter_provenance,
      input: normalizeHistoryInput(row.input),
      output: row.output,
      createdAt: row.created_at
    };
  }

  async createShare(
    userId: string,
    assessmentId: string,
    expiresInDays: number
  ) {
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const row = await withTransaction(async (client) => {
      const owned = await client.query<{ id: string; user_id: string }>(
        `SELECT a.id, a.user_id
           FROM assessments a
           JOIN policy_calculation_snapshots pcs
             ON pcs.assessment_id = a.id
          WHERE a.id = $1
            AND a.user_id = $2
            AND a.product_channel = 'main'
          FOR UPDATE OF a`,
        [assessmentId, userId]
      );
      if (!owned.rows[0]) {
        throw new ApiError(
          404,
          "POLICY_HISTORY_NOT_FOUND",
          "计算记录不存在"
        );
      }
      await client.query(
        `UPDATE policy_result_shares
            SET revoked_at = now()
          WHERE assessment_id = $1
            AND owner_user_id = $2
            AND revoked_at IS NULL`,
        [assessmentId, userId]
      );
      const inserted = await client.query<{
        id: string;
        expires_at: string;
      }>(
        `INSERT INTO policy_result_shares(
           assessment_id, owner_user_id, token_hash, expires_at
         )
         VALUES (
           $1, $2, $3, now() + ($4::integer * interval '1 day')
         )
         RETURNING id, expires_at::text`,
        [assessmentId, userId, tokenHash, expiresInDays]
      );
      return inserted.rows[0];
    });
    return {
      shareId: row.id,
      token,
      expiresAt: row.expires_at
    };
  }

  async listShares(userId: string, assessmentId: string) {
    const owned = await query<{ id: string }>(
      `SELECT a.id
         FROM assessments a
         JOIN policy_calculation_snapshots pcs
           ON pcs.assessment_id = a.id
        WHERE a.id = $1
          AND a.user_id = $2
          AND a.product_channel = 'main'`,
      [assessmentId, userId]
    );
    if (!owned.rows[0]) {
      throw new ApiError(
        404,
        "POLICY_HISTORY_NOT_FOUND",
        "计算记录不存在"
      );
    }
    const result = await query<{
      id: string;
      created_at: string;
      expires_at: string;
      status: "active" | "expired" | "revoked";
    }>(
      `SELECT id, created_at::text, expires_at::text,
              CASE
                WHEN revoked_at IS NOT NULL THEN 'revoked'
                WHEN expires_at <= now() THEN 'expired'
                ELSE 'active'
              END AS status
         FROM policy_result_shares
        WHERE assessment_id = $1
          AND owner_user_id = $2
        ORDER BY created_at DESC, id DESC`,
      [assessmentId, userId]
    );
    return result.rows.map((row) => ({
      shareId: row.id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      status: row.status
    }));
  }

  async revokeShare(userId: string, shareId: string) {
    await withTransaction(async (client) => {
      const target = await client.query<{ assessment_id: string }>(
        `SELECT prs.assessment_id
           FROM policy_result_shares prs
           JOIN assessments a ON a.id = prs.assessment_id
          WHERE prs.id = $1
            AND prs.owner_user_id = $2
            AND a.user_id = $2
            AND a.product_channel = 'main'
          FOR UPDATE OF a`,
        [shareId, userId]
      );
      if (!target.rows[0]) {
        throw new ApiError(
          404,
          "POLICY_SHARE_NOT_FOUND",
          "分享链接不存在"
        );
      }
      await client.query(
        `UPDATE policy_result_shares
            SET revoked_at = now()
          WHERE assessment_id = $1
            AND owner_user_id = $2
            AND revoked_at IS NULL`,
        [target.rows[0].assessment_id, userId]
      );
    });
  }

  async getSharedResult(token: string) {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    return withTransaction(async (client) => {
      const result = await client.query<{
        share_id: string;
        expires_at: string;
        accuracy_level: CalculationResult["accuracy"];
        version: number;
        output: PolicyOutput;
        parameter_provenance: CalculationResult["parameters"];
      }>(
        `SELECT prs.id AS share_id, prs.expires_at::text,
                a.accuracy_level, prv.version, pcs.output,
                pcs.parameter_provenance
           FROM policy_result_shares prs
           JOIN assessments a ON a.id = prs.assessment_id
           JOIN policy_calculation_snapshots pcs
             ON pcs.assessment_id = a.id
           JOIN policy_rule_versions prv
             ON prv.id = pcs.rule_version_id
          WHERE prs.token_hash = $1
            AND prs.revoked_at IS NULL
            AND prs.expires_at > now()
            AND a.product_channel = 'main'
          FOR UPDATE OF prs`,
        [tokenHash]
      );
      const row = result.rows[0];
      if (!row) {
        throw new ApiError(
          404,
          "POLICY_SHARE_NOT_FOUND",
          "分享链接不存在或已失效"
        );
      }
      await client.query(
        "UPDATE policy_result_shares SET last_accessed_at = now() WHERE id = $1",
        [row.share_id]
      );
      return {
        shareId: row.share_id,
        expiresAt: row.expires_at,
        ruleVersion: row.version,
        accuracy: row.accuracy_level,
        parameters: row.parameter_provenance,
        result: row.output
      };
    });
  }

  async listVersions(code: string) {
    const result = await query<{
      id: string;
      version: number;
      status: string;
      definition: unknown;
      source_snapshot: unknown;
      effective_from: string;
      effective_to: string | null;
      published_by: string | null;
      published_at: string | null;
      created_at: string;
    }>(
      `SELECT prv.id, prv.version, prv.status, prv.definition,
              prv.source_snapshot, prv.effective_from::text,
              prv.effective_to::text, prv.published_by,
              prv.published_at::text, prv.created_at::text
         FROM policy_rule_sets prs
         JOIN policy_rule_versions prv ON prv.rule_set_id = prs.id
        WHERE prs.code = $1
        ORDER BY prv.version DESC`,
      [code]
    );
    return result.rows.map(formatVersion);
  }

  async createDraft({
    code,
    definition,
    sourceSnapshot,
    effectiveFrom,
    effectiveTo,
    request
  }: {
    code: string;
    definition: PolicyDefinition;
    sourceSnapshot: unknown[];
    effectiveFrom: string;
    effectiveTo?: string | null;
    request: Request;
  }) {
    return withTransaction(async (client) => {
      const ruleSet = await client.query<{ id: string }>(
        `SELECT id
           FROM policy_rule_sets
          WHERE code = $1
          FOR UPDATE`,
        [code]
      );
      if (!ruleSet.rows[0]) {
        throw new ApiError(
          404,
          "POLICY_RULE_SET_NOT_FOUND",
          "政策规则集不存在"
        );
      }
      const nextVersion = await client.query<{ version: number }>(
        `SELECT coalesce(max(version), 0)::int + 1 AS version
           FROM policy_rule_versions
          WHERE rule_set_id = $1`,
        [ruleSet.rows[0].id]
      );
      const inserted = await client.query<{
        id: string;
        version: number;
        status: string;
        definition: unknown;
        source_snapshot: unknown;
        effective_from: string;
        effective_to: string | null;
        created_at: string;
      }>(
        `INSERT INTO policy_rule_versions(
           rule_set_id, version, status, definition, source_snapshot,
           effective_from, effective_to
         )
         VALUES ($1, $2, 'draft', $3::jsonb, $4::jsonb, $5::date, $6::date)
         RETURNING id, version, status, definition, source_snapshot,
                   effective_from::text, effective_to::text, created_at::text`,
        [
          ruleSet.rows[0].id,
          nextVersion.rows[0].version,
          JSON.stringify(definition),
          JSON.stringify(sourceSnapshot),
          effectiveFrom,
          effectiveTo ?? null
        ]
      );
      const row = inserted.rows[0];
      await writeAdminAudit(
        request,
        "policy.version.create",
        "policy_rule_version",
        row.id,
        {
          before: null,
          after: {
            version: row.version,
            status: "draft",
            effectiveFrom: row.effective_from,
            effectiveTo: row.effective_to
          },
          version: row.version,
          source: sourceLabel(sourceSnapshot)
        },
        client
      );
      return formatVersion(row);
    });
  }

  private async updateActivePointer(
    client: {
      query: <T extends Record<string, unknown>>(
        text: string,
        values?: unknown[]
      ) => Promise<{ rows: T[] }>;
    },
    ruleSetId: string
  ) {
    const active = await client.query<{ id: string }>(
      `SELECT id
         FROM policy_rule_versions
        WHERE rule_set_id = $1
          AND status = 'published'
          AND effective_from <= current_date
          AND (effective_to IS NULL OR effective_to >= current_date)
        ORDER BY version DESC
        LIMIT 1`,
      [ruleSetId]
    );
    await client.query(
      `UPDATE policy_rule_sets
          SET active_version_id = $2,
              updated_at = now()
        WHERE id = $1`,
      [ruleSetId, active.rows[0]?.id ?? null]
    );
  }

  private async preparePublishedInterval(
    client: {
      query: <T extends Record<string, unknown>>(
        text: string,
        values?: unknown[]
      ) => Promise<{ rows: T[]; rowCount?: number | null }>;
    },
    ruleSetId: string,
    candidateId: string,
    effectiveFrom: string,
    effectiveTo: string | null
  ) {
    const published = await client.query<{
      id: string;
      effective_from: string;
      effective_to: string | null;
    }>(
      `SELECT id, effective_from::text, effective_to::text
         FROM policy_rule_versions
        WHERE rule_set_id = $1
          AND status = 'published'
        ORDER BY effective_from, version
        FOR UPDATE`,
      [ruleSetId]
    );
    const maximumStart = published.rows.at(-1)?.effective_from;
    const appendOpenEnded =
      effectiveTo === null &&
      (!maximumStart || effectiveFrom > maximumStart);
    if (appendOpenEnded) {
      const preceding = published.rows.at(-1);
      if (
        preceding &&
        (preceding.effective_to === null ||
          preceding.effective_to >= effectiveFrom)
      ) {
        await client.query(
          `UPDATE policy_rule_versions
              SET effective_to = $2::date - 1,
                  updated_at = now()
            WHERE id = $1`,
          [preceding.id, effectiveFrom]
        );
      }
      return;
    }
    const overlap = published.rows.some((row) => {
      const existingEnd = row.effective_to ?? "9999-12-31";
      const candidateEnd = effectiveTo ?? "9999-12-31";
      return (
        row.id !== candidateId &&
        row.effective_from <= candidateEnd &&
        effectiveFrom <= existingEnd
      );
    });
    if (overlap) {
      throw new ApiError(
        409,
        "POLICY_VERSION_OVERLAP",
        "政策版本生效区间重叠"
      );
    }
  }

  async publishVersion({
    code,
    id,
    request
  }: {
    code: string;
    id: string;
    request: Request;
  }) {
    return withTransaction(async (client) => {
      const ruleSet = await client.query<{ id: string }>(
        `SELECT id
           FROM policy_rule_sets
          WHERE code = $1
          FOR UPDATE`,
        [code]
      );
      if (!ruleSet.rows[0]) {
        throw new ApiError(
          404,
          "POLICY_RULE_SET_NOT_FOUND",
          "政策规则集不存在"
        );
      }
      const selected = await client.query<{
        id: string;
        version: number;
        status: string;
        definition: unknown;
        source_snapshot: unknown;
        effective_from: string;
        effective_to: string | null;
      }>(
        `SELECT id, version, status, definition, source_snapshot,
                effective_from::text, effective_to::text
           FROM policy_rule_versions
          WHERE id = $1
            AND rule_set_id = $2
          FOR UPDATE`,
        [id, ruleSet.rows[0].id]
      );
      const draft = selected.rows[0];
      if (!draft) {
        throw new ApiError(
          404,
          "POLICY_VERSION_NOT_FOUND",
          "政策版本不存在"
        );
      }
      if (draft.status !== "draft") {
        throw new ApiError(
          409,
          "POLICY_VERSION_IMMUTABLE",
          "仅草稿版本可以发布"
        );
      }
      if (!policyDefinitionSchema.safeParse(draft.definition).success) {
        throw new ApiError(
          400,
          "INVALID_POLICY_DEFINITION",
          "政策规则定义不符合 schemaVersion 2"
        );
      }
      await this.preparePublishedInterval(
        client,
        ruleSet.rows[0].id,
        draft.id,
        draft.effective_from,
        draft.effective_to
      );
      const published = await client.query<{
        id: string;
        version: number;
        status: string;
        definition: unknown;
        source_snapshot: unknown;
        effective_from: string;
        effective_to: string | null;
        published_by: string | null;
        published_at: string | null;
      }>(
        `UPDATE policy_rule_versions
            SET status = 'published',
                published_by = $2,
                published_at = now(),
                updated_at = now()
          WHERE id = $1
          RETURNING id, version, status, definition, source_snapshot,
                    effective_from::text, effective_to::text, published_by,
                    published_at::text`,
        [draft.id, request.authUser!.id]
      );
      await this.updateActivePointer(client, ruleSet.rows[0].id);
      await writeAdminAudit(
        request,
        "policy.version.publish",
        "policy_rule_version",
        draft.id,
        {
          before: { status: "draft" },
          after: { status: "published" },
          version: draft.version,
          source: sourceLabel(draft.source_snapshot)
        },
        client
      );
      return formatVersion(published.rows[0]);
    });
  }

  async rollback({
    code,
    targetVersion,
    effectiveFrom,
    request
  }: {
    code: string;
    targetVersion: number;
    effectiveFrom: string;
    request: Request;
  }) {
    return withTransaction(async (client) => {
      const ruleSet = await client.query<{ id: string }>(
        `SELECT id
           FROM policy_rule_sets
          WHERE code = $1
          FOR UPDATE`,
        [code]
      );
      if (!ruleSet.rows[0]) {
        throw new ApiError(
          404,
          "POLICY_RULE_SET_NOT_FOUND",
          "政策规则集不存在"
        );
      }
      const target = await client.query<{
        id: string;
        version: number;
        definition: unknown;
        source_snapshot: unknown;
      }>(
        `SELECT id, version, definition, source_snapshot
           FROM policy_rule_versions
          WHERE rule_set_id = $1
            AND version = $2
            AND status IN ('published', 'retired')
          FOR SHARE`,
        [ruleSet.rows[0].id, targetVersion]
      );
      if (!target.rows[0]) {
        throw new ApiError(
          404,
          "POLICY_VERSION_NOT_FOUND",
          "回滚目标版本不存在"
        );
      }
      const maximum = await client.query<{
        version: number;
        effective_from: string | null;
      }>(
        `SELECT coalesce(max(version), 0)::int AS version,
                max(effective_from)
                  FILTER (WHERE status = 'published')::text
                  AS effective_from
           FROM policy_rule_versions
          WHERE rule_set_id = $1`,
        [ruleSet.rows[0].id]
      );
      if (
        maximum.rows[0].effective_from &&
        effectiveFrom <= maximum.rows[0].effective_from
      ) {
        throw new ApiError(
          409,
          "POLICY_VERSION_OVERLAP",
          "回滚生效日期必须晚于已有版本"
        );
      }
      await this.preparePublishedInterval(
        client,
        ruleSet.rows[0].id,
        "",
        effectiveFrom,
        null
      );
      const inserted = await client.query<{
        id: string;
        version: number;
        status: string;
        definition: unknown;
        source_snapshot: unknown;
        effective_from: string;
        effective_to: string | null;
        published_by: string | null;
        published_at: string | null;
      }>(
        `INSERT INTO policy_rule_versions(
           rule_set_id, version, status, definition, source_snapshot,
           effective_from, effective_to, published_by, published_at
         )
         VALUES (
           $1, $2, 'published', $3::jsonb, $4::jsonb,
           $5::date, NULL, $6, now()
         )
         RETURNING id, version, status, definition, source_snapshot,
                   effective_from::text, effective_to::text, published_by,
                   published_at::text`,
        [
          ruleSet.rows[0].id,
          maximum.rows[0].version + 1,
          JSON.stringify(target.rows[0].definition),
          JSON.stringify(target.rows[0].source_snapshot),
          effectiveFrom,
          request.authUser!.id
        ]
      );
      await this.updateActivePointer(client, ruleSet.rows[0].id);
      await writeAdminAudit(
        request,
        "policy.version.rollback",
        "policy_rule_version",
        inserted.rows[0].id,
        {
          before: null,
          after: {
            status: "published",
            effectiveFrom
          },
          targetVersion,
          newVersion: inserted.rows[0].version,
          source: sourceLabel(target.rows[0].source_snapshot)
        },
        client
      );
      return {
        ...formatVersion(inserted.rows[0]),
        rolledBackFromVersion: targetVersion
      };
    });
  }

  async upsertRegionalParameter({
    input,
    request
  }: {
    input: {
      regionCode: string;
      year: number;
      parameterType: ParameterType;
      amountFen: number;
      sourceName: string;
      sourceUrl: string;
      sourcePublishedAt: string;
      status: "draft" | "verified" | "stale";
    };
    request: Request;
  }) {
    return withTransaction(async (client) => {
      const region = await client.query<{ name: string }>(
        `SELECT name
           FROM administrative_regions
          WHERE code = $1
            AND status = 'active'
          FOR SHARE`,
        [input.regionCode]
      );
      if (!region.rows[0]) {
        throw new ApiError(
          422,
          "REGION_UNAVAILABLE",
          "所选地区当前不可用于政策参数"
        );
      }
      const before = await client.query(
        `SELECT id, region_code, region_name, year, parameter_type,
                amount_fen::text, source_name, source_url,
                source_published_at::text, status, reviewed_by
           FROM regional_parameters
          WHERE region_code = $1
            AND year = $2
            AND parameter_type = $3
          FOR UPDATE`,
        [input.regionCode, input.year, input.parameterType]
      );
      const result = await client.query<{
        id: string;
        region_code: string;
        region_name: string;
        year: number;
        parameter_type: ParameterType;
        amount_fen: string;
        source_name: string;
        source_url: string;
        source_published_at: string;
        status: "draft" | "verified" | "stale";
        reviewed_by: string;
      }>(
        `INSERT INTO regional_parameters(
           region_code, region_name, year, parameter_type, amount_fen,
           source_name, source_url, source_published_at, status,
           reviewed_by, reviewed_at
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10, now()
         )
         ON CONFLICT (region_code, year, parameter_type)
         DO UPDATE SET
           region_name = EXCLUDED.region_name,
           amount_fen = EXCLUDED.amount_fen,
           source_name = EXCLUDED.source_name,
           source_url = EXCLUDED.source_url,
           source_published_at = EXCLUDED.source_published_at,
           status = EXCLUDED.status,
           reviewed_by = EXCLUDED.reviewed_by,
           reviewed_at = now(),
           updated_at = now()
         RETURNING id, region_code, region_name, year, parameter_type,
                   amount_fen::text, source_name, source_url,
                   source_published_at::text, status, reviewed_by`,
        [
          input.regionCode,
          region.rows[0].name,
          input.year,
          input.parameterType,
          input.amountFen,
          input.sourceName,
          input.sourceUrl,
          input.sourcePublishedAt,
          input.status,
          request.authUser!.id
        ]
      );
      const row = result.rows[0];
      await writeAdminAudit(
        request,
        "policy.parameter.upsert",
        "regional_parameter",
        row.id,
        {
          before: before.rows[0] ?? null,
          after: {
            regionCode: row.region_code,
            regionName: row.region_name,
            year: row.year,
            parameterType: row.parameter_type,
            amountFen: Number(row.amount_fen),
            status: row.status
          },
          version: row.year,
          source: row.source_name
        },
        client
      );
      return {
        id: row.id,
        regionCode: row.region_code,
        regionName: row.region_name,
        year: row.year,
        parameterType: row.parameter_type,
        amountFen: Number(row.amount_fen),
        sourceName: row.source_name,
        sourceUrl: row.source_url,
        sourcePublishedAt: row.source_published_at,
        status: row.status,
        reviewedBy: row.reviewed_by
      };
    });
  }

  async listRegionalParameters({
    provinceCode,
    cityCode,
    year,
    parameterType,
    status,
    page,
    pageSize
  }: {
    provinceCode?: string;
    cityCode?: string;
    year?: number;
    parameterType?: ParameterType;
    status?: "draft" | "verified" | "stale";
    page: number;
    pageSize: number;
  }) {
    const values = [
      provinceCode ?? null,
      cityCode ?? null,
      year ?? null,
      parameterType ?? null,
      status ?? null
    ];
    const where = `
      WHERE (
        $1::text IS NULL OR
        rp.region_code = $1 OR
        child.parent_code = $1
      )
        AND ($2::text IS NULL OR rp.region_code = $2)
        AND ($3::integer IS NULL OR rp.year = $3)
        AND ($4::text IS NULL OR rp.parameter_type = $4)
        AND ($5::text IS NULL OR rp.status = $5)
    `;
    const [items, total] = await Promise.all([
      query<{
        id: string;
        region_code: string;
        region_name: string;
        province_code: string;
        province_name: string;
        year: number;
        parameter_type: ParameterType;
        amount_fen: string;
        source_name: string;
        source_url: string;
        source_published_at: string;
        status: "draft" | "verified" | "stale";
        reviewed_by: string | null;
        reviewed_at: string | null;
        updated_at: string;
      }>(
        `SELECT rp.id, rp.region_code, rp.region_name,
                CASE
                  WHEN child.level = 'province' THEN child.code
                  ELSE parent.code
                END AS province_code,
                CASE
                  WHEN child.level = 'province' THEN child.name
                  ELSE parent.name
                END AS province_name,
                rp.year, rp.parameter_type, rp.amount_fen::text,
                rp.source_name, rp.source_url,
                rp.source_published_at::text, rp.status,
                rp.reviewed_by, rp.reviewed_at::text, rp.updated_at::text
           FROM regional_parameters rp
           JOIN administrative_regions child ON child.code = rp.region_code
           LEFT JOIN administrative_regions parent
             ON parent.code = child.parent_code
          ${where}
          ORDER BY rp.year DESC, rp.region_code, rp.parameter_type
          LIMIT $6 OFFSET $7`,
        [...values, pageSize, (page - 1) * pageSize]
      ),
      query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM regional_parameters rp
           JOIN administrative_regions child ON child.code = rp.region_code
          ${where}`,
        values
      )
    ]);
    return {
      items: items.rows.map((row) => ({
        id: row.id,
        regionCode: row.region_code,
        regionName: row.region_name,
        provinceCode: row.province_code,
        provinceName: row.province_name,
        year: row.year,
        parameterType: row.parameter_type,
        amountFen: Number(row.amount_fen),
        sourceName: row.source_name,
        sourceUrl: row.source_url,
        sourcePublishedAt: row.source_published_at,
        status: row.status,
        reviewedBy: row.reviewed_by,
        reviewedAt: row.reviewed_at,
        updatedAt: row.updated_at
      })),
      pagination: {
        page,
        pageSize,
        total: Number(total.rows[0]?.count || 0)
      }
    };
  }

  async importRegionalParameters({
    inputs,
    request
  }: {
    inputs: Array<{
      regionCode: string;
      regionName: string;
      year: number;
      parameterType: ParameterType;
      amountFen: number;
      sourceName: string;
      sourceUrl: string;
      sourcePublishedAt: string;
      status: "draft" | "verified" | "stale";
    }>;
    request: Request;
  }) {
    return withTransaction(async (client) => {
      const regionCodes = [...new Set(inputs.map((input) => input.regionCode))]
        .sort();
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
      const byCode = new Map(regions.rows.map((row) => [row.code, row]));
      for (const input of inputs) {
        const region = byCode.get(input.regionCode);
        if (!region) {
          throw new Error(`Unknown administrative region ${input.regionCode}`);
        }
        if (region.status !== "active") {
          throw new Error(
            `Administrative region ${input.regionCode} is not active`
          );
        }
        if (region.name !== input.regionName) {
          throw new Error(
            `Region ${input.regionCode} is named ${region.name}, received ${input.regionName}`
          );
        }
      }

      const imported = [];
      for (const input of inputs) {
        const result = await client.query<{
          id: string;
          region_code: string;
          region_name: string;
          year: number;
          parameter_type: ParameterType;
          amount_fen: string;
          source_name: string;
          source_url: string;
          source_published_at: string;
          status: "draft" | "verified" | "stale";
          reviewed_by: string;
        }>(
          `INSERT INTO regional_parameters(
             region_code, region_name, year, parameter_type, amount_fen,
             source_name, source_url, source_published_at, status,
             reviewed_by, reviewed_at
           )
           VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10, now()
           )
           ON CONFLICT (region_code, year, parameter_type)
           DO UPDATE SET
             region_name = EXCLUDED.region_name,
             amount_fen = EXCLUDED.amount_fen,
             source_name = EXCLUDED.source_name,
             source_url = EXCLUDED.source_url,
             source_published_at = EXCLUDED.source_published_at,
             status = EXCLUDED.status,
             reviewed_by = EXCLUDED.reviewed_by,
             reviewed_at = now(),
             updated_at = now()
           RETURNING id, region_code, region_name, year, parameter_type,
                     amount_fen::text, source_name, source_url,
                     source_published_at::text, status, reviewed_by`,
          [
            input.regionCode,
            input.regionName,
            input.year,
            input.parameterType,
            input.amountFen,
            input.sourceName,
            input.sourceUrl,
            input.sourcePublishedAt,
            input.status,
            request.authUser!.id
          ]
        );
        const row = result.rows[0];
        imported.push({
          id: row.id,
          regionCode: row.region_code,
          regionName: row.region_name,
          year: row.year,
          parameterType: row.parameter_type,
          amountFen: Number(row.amount_fen),
          sourceName: row.source_name,
          sourceUrl: row.source_url,
          sourcePublishedAt: row.source_published_at,
          status: row.status,
          reviewedBy: row.reviewed_by
        });
      }
      const batchId = crypto.randomUUID();
      await writeAdminAudit(
        request,
        "policy.parameter.import",
        "regional_parameters",
        batchId,
        {
          imported: imported.length,
          keys: imported.map(
            (item) =>
              `${item.regionCode}:${item.year}:${item.parameterType}`
          )
        },
        client
      );
      return { imported: imported.length, items: imported, batchId };
    });
  }

  async listAnnouncements() {
    const result = await query<{
      id: string;
      title: string;
      body: string;
      placement: "main" | "ai" | "all";
      status: "draft" | "published" | "archived";
      starts_at: string | null;
      ends_at: string | null;
      created_by: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, title, body, placement, status,
              starts_at::text, ends_at::text, created_by,
              created_at::text, updated_at::text
         FROM announcements
        ORDER BY updated_at DESC, id DESC`
    );
    return result.rows.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      placement: row.placement,
      status: row.status,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  async createAnnouncement({
    input,
    request
  }: {
    input: {
      title: string;
      body: string;
      placement: "main" | "ai" | "all";
      status: "draft" | "published" | "archived";
      startsAt?: string | null;
      endsAt?: string | null;
    };
    request: Request;
  }) {
    return withTransaction(async (client) => {
      const inserted = await client.query<{
        id: string;
        title: string;
        body: string;
        placement: "main" | "ai" | "all";
        status: "draft" | "published" | "archived";
        starts_at: string | null;
        ends_at: string | null;
        created_by: string;
        created_at: string;
        updated_at: string;
      }>(
        `INSERT INTO announcements(
           title, body, placement, status, starts_at, ends_at, created_by
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, title, body, placement, status,
                   starts_at::text, ends_at::text, created_by,
                   created_at::text, updated_at::text`,
        [
          input.title,
          input.body,
          input.placement,
          input.status,
          input.startsAt ?? null,
          input.endsAt ?? null,
          request.authUser!.id
        ]
      );
      const row = inserted.rows[0];
      await writeAdminAudit(
        request,
        "announcement.create",
        "announcement",
        row.id,
        { title: row.title, status: row.status, placement: row.placement },
        client
      );
      return {
        id: row.id,
        title: row.title,
        body: row.body,
        placement: row.placement,
        status: row.status,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    });
  }

  async updateAnnouncement({
    id,
    input,
    request
  }: {
    id: string;
    input: {
      title?: string;
      body?: string;
      placement?: "main" | "ai" | "all";
      status?: "draft" | "published" | "archived";
      startsAt?: string | null;
      endsAt?: string | null;
    };
    request: Request;
  }) {
    return withTransaction(async (client) => {
      const selected = await client.query<{
        id: string;
        title: string;
        body: string;
        placement: "main" | "ai" | "all";
        status: "draft" | "published" | "archived";
        starts_at: string | null;
        ends_at: string | null;
      }>(
        `SELECT id, title, body, placement, status,
                starts_at::text, ends_at::text
           FROM announcements
          WHERE id = $1
          FOR UPDATE`,
        [id]
      );
      const before = selected.rows[0];
      if (!before) {
        throw new ApiError(
          404,
          "ANNOUNCEMENT_NOT_FOUND",
          "公告不存在"
        );
      }
      const startsAt = Object.hasOwn(input, "startsAt")
        ? input.startsAt ?? null
        : before.starts_at;
      const endsAt = Object.hasOwn(input, "endsAt")
        ? input.endsAt ?? null
        : before.ends_at;
      if (
        startsAt &&
        endsAt &&
        new Date(endsAt).getTime() < new Date(startsAt).getTime()
      ) {
        throw new ApiError(
          400,
          "INVALID_ANNOUNCEMENT_SCHEDULE",
          "公告结束时间不得早于开始时间"
        );
      }
      const updated = await client.query<{
        id: string;
        title: string;
        body: string;
        placement: "main" | "ai" | "all";
        status: "draft" | "published" | "archived";
        starts_at: string | null;
        ends_at: string | null;
        created_by: string | null;
        created_at: string;
        updated_at: string;
      }>(
        `UPDATE announcements
            SET title = $2,
                body = $3,
                placement = $4,
                status = $5,
                starts_at = $6,
                ends_at = $7,
                updated_at = now()
          WHERE id = $1
          RETURNING id, title, body, placement, status,
                    starts_at::text, ends_at::text, created_by,
                    created_at::text, updated_at::text`,
        [
          id,
          input.title ?? before.title,
          input.body ?? before.body,
          input.placement ?? before.placement,
          input.status ?? before.status,
          startsAt,
          endsAt
        ]
      );
      const row = updated.rows[0];
      await writeAdminAudit(
        request,
        "announcement.update",
        "announcement",
        id,
        {
          before: {
            title: before.title,
            status: before.status,
            placement: before.placement
          },
          after: {
            title: row.title,
            status: row.status,
            placement: row.placement
          }
        },
        client
      );
      return {
        id: row.id,
        title: row.title,
        body: row.body,
        placement: row.placement,
        status: row.status,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    });
  }

  async deleteAnnouncement({
    id,
    request
  }: {
    id: string;
    request: Request;
  }) {
    return withTransaction(async (client) => {
      const selected = await client.query<{
        id: string;
        title: string;
        status: "draft" | "published" | "archived";
      }>(
        `SELECT id, title, status
           FROM announcements
          WHERE id = $1
          FOR UPDATE`,
        [id]
      );
      const announcement = selected.rows[0];
      if (!announcement) {
        throw new ApiError(
          404,
          "ANNOUNCEMENT_NOT_FOUND",
          "公告不存在"
        );
      }
      if (announcement.status !== "draft") {
        throw new ApiError(
          409,
          "ANNOUNCEMENT_PUBLISHED",
          "已发布或归档公告仅支持保留审计记录"
        );
      }
      await client.query("DELETE FROM announcements WHERE id = $1", [id]);
      await writeAdminAudit(
        request,
        "announcement.delete",
        "announcement",
        id,
        { title: announcement.title, status: announcement.status },
        client
      );
    });
  }

  async coverage(year: number) {
    const result = await query<{
      region_code: string;
      region_name: string;
      level: PolicyRegion["level"];
      parent_code: string | null;
      minimum_status: "exact" | "fallback" | "manual-needed";
      average_status: "exact" | "manual-needed";
    }>(
      `SELECT r.code AS region_code,
              r.name AS region_name,
              r.level,
              r.parent_code,
              CASE
                WHEN exact_min.id IS NOT NULL THEN 'exact'
                WHEN parent_min.id IS NOT NULL THEN 'fallback'
                ELSE 'manual-needed'
              END AS minimum_status,
              CASE
                WHEN exact_avg.id IS NOT NULL THEN 'exact'
                ELSE 'manual-needed'
              END AS average_status
         FROM administrative_regions r
         LEFT JOIN administrative_regions parent_region
           ON parent_region.code = r.parent_code
          AND parent_region.level = 'province'
          AND parent_region.status = 'active'
         LEFT JOIN LATERAL (
           SELECT rp.id
             FROM regional_parameters rp
            WHERE rp.region_code = r.code
              AND rp.parameter_type = 'minimum_monthly_wage'
              AND rp.year <= $1
              AND rp.status IN ('verified', 'stale')
            ORDER BY rp.year DESC
            LIMIT 1
         ) exact_min ON true
         LEFT JOIN LATERAL (
           SELECT rp.id
             FROM regional_parameters rp
            WHERE r.level = 'prefecture'
              AND rp.region_code = parent_region.code
              AND rp.parameter_type = 'minimum_monthly_wage'
              AND rp.year <= $1
              AND rp.status IN ('verified', 'stale')
            ORDER BY rp.year DESC
            LIMIT 1
         ) parent_min ON exact_min.id IS NULL
         LEFT JOIN LATERAL (
           SELECT rp.id
             FROM regional_parameters rp
            WHERE rp.region_code = r.code
              AND rp.parameter_type = 'employee_average_monthly_wage'
              AND rp.year <= $1 - 1
              AND rp.status IN ('verified', 'stale')
            ORDER BY rp.year DESC
            LIMIT 1
         ) exact_avg ON true
        WHERE r.status = 'active'
          AND (
            r.level = 'province' OR
            parent_region.code IS NOT NULL
          )
        ORDER BY
          CASE r.level WHEN 'province' THEN 0 ELSE 1 END,
          r.code`,
      [year]
    );
    return result.rows.map((row) => ({
      regionCode: row.region_code,
      regionName: row.region_name,
      level: row.level,
      parentCode: row.parent_code,
      minimumMonthlyWage: row.minimum_status,
      employeeAverageMonthlyWage: row.average_status
    }));
  }
}
