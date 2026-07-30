import {
  Router,
  type NextFunction,
  type Request,
  type Response
} from "express";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import { isGovernmentHttpsUrl } from "../../lib/official-source.js";
import {
  getRequestIdentity,
  requireAuth,
  requireCapability
} from "../../security.js";
import { calculatePolicy } from "./engine.js";
import {
  PolicyRepository,
  policyDefinitionSchema,
  type PolicyFacts
} from "./repository.js";
import { PolicyEngineError, type PolicyOutput } from "./types.js";

const isCalendarDate = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const maximumDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= maximumDay;
};
const isoDateSchema = z
  .string()
  .refine(isCalendarDate, "日期必须使用有效的 YYYY-MM-DD");
const safeMoneySchema = z.number().safe().int().nonnegative();
const positiveMoneySchema = z.number().safe().int().positive();
const terminationScenarioSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("MUTUAL_AGREEMENT"),
      proposedBy: z.enum(["employer", "employee"])
    })
    .strict(),
  z
    .object({
      kind: z.literal("ARTICLE_40"),
      noticeMethod: z.enum(["notice_30_days", "payment_in_lieu"])
    })
    .strict(),
  z.object({ kind: z.literal("ARTICLE_38_EMPLOYEE_TERMINATION") }).strict(),
  z.object({ kind: z.literal("STATUTORY_COMPENSATION") }).strict(),
  z.object({ kind: z.literal("ARTICLE_39_NO_COMPENSATION") }).strict(),
  z.object({ kind: z.literal("VOLUNTARY_RESIGNATION") }).strict(),
  z
    .object({
      kind: z.literal("UNLAWFUL_TERMINATION"),
      continuedPerformanceRequested: z.boolean(),
      continuedPerformancePossible: z.boolean()
    })
    .strict(),
  z.object({ kind: z.literal("UNCLEAR") }).strict()
]);
const calculateSchema = z.object({
  regionCode: z.string().regex(/^\d{6}$/),
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  terminationScenario: terminationScenarioSchema,
  monthlyEarnedWagesFen: z.array(safeMoneySchema).min(1).max(12),
  alreadyPaidFen: safeMoneySchema.optional(),
  manualParameters: z
    .object({
      minimumMonthlyWageFen: positiveMoneySchema.optional(),
      employeeAverageMonthlyWageFen: positiveMoneySchema.optional()
    })
    .strict()
    .optional()
});

type PolicyCalculate = (input: unknown) => PolicyOutput;

const policyEngineMessage: Record<string, string> = {
  INVALID_POLICY_INPUT: "政策计算输入无效",
  INVALID_REGION: "地区输入无效",
  INVALID_EMPLOYMENT_DATE: "入职或解除日期无效",
  END_DATE_MUST_FOLLOW_START_DATE: "解除日期必须晚于入职日期",
  INVALID_TERMINATION_SCENARIO: "解除情形无效",
  WAGE_MONTHS_OUT_OF_RANGE: "工资月份数量无效",
  INVALID_WAGE_VALUE: "工资金额无效",
  INVALID_REGIONAL_PARAMETER: "地区参数无效",
  INVALID_ALREADY_PAID: "已支付金额无效",
  COMPUTATION_OVERFLOW: "计算金额超出安全范围"
};

export const createPolicyRouter = (
  {
    repository = new PolicyRepository(),
    calculate = calculatePolicy
  }: {
    repository?: PolicyRepository;
    calculate?: PolicyCalculate;
  } = {}
) => {
  const router = Router();

  router.get("/regions", async (request, response) => {
    const query = z
      .object({
        level: z.enum(["province", "prefecture"]).optional(),
        year: z.coerce.number().int().min(2000).max(2100).optional()
      })
      .parse(request.query);
    response.json({
      items: await repository.listRegions(query.level, query.year)
    });
  });

  router.post("/calculate", requireAuth, async (request, response, next) => {
    try {
      const facts = calculateSchema.parse(request.body) as PolicyFacts;
      const identity = getRequestIdentity(request);
      const result = await repository.calculateAndPersist({
        userId: request.authUser!.id,
        visitorId: identity.visitorId,
        sessionId: identity.sessionId,
        facts,
        calculate
      });
      response.status(201).json(result);
    } catch (error) {
      if (error instanceof PolicyEngineError) {
        next(
          new ApiError(
            error.code === "INVALID_POLICY_INPUT" ? 400 : 422,
            error.code,
            policyEngineMessage[error.code] || "政策计算输入无效",
            error.details
          )
        );
        return;
      }
      next(error);
    }
  });

  router.get("/history", requireAuth, async (request, response) => {
    const pagination = z
      .object({
        page: z.coerce.number().int().positive().default(1),
        pageSize: z.coerce.number().int().positive().max(100).default(20)
      })
      .parse(request.query);
    response.json(
      await repository.listHistory(
        request.authUser!.id,
        pagination.page,
        pagination.pageSize
      )
    );
  });

  router.get("/history/:id", requireAuth, async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    response.json(await repository.getHistory(request.authUser!.id, id));
  });

  return router;
};

const sourceSnapshotSchema = z
  .array(z.record(z.string(), z.unknown()))
  .max(100);

export const calendarDateInShanghai = (now = new Date()) =>
  new Date(now.getTime() + 8 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 10);

const regionalParameterSchema = z
  .object({
    regionCode: z.string().regex(/^\d{6}$/),
    year: z.number().int().min(2000).max(2100),
    parameterType: z.enum([
      "minimum_monthly_wage",
      "employee_average_monthly_wage"
    ]),
    amountFen: positiveMoneySchema,
    sourceName: z.string().trim().min(1).max(500),
    sourceUrl: z
      .string()
      .url()
      .refine((url) => new URL(url).protocol === "https:", {
        message: "来源地址必须使用 HTTPS"
      }),
    sourcePublishedAt: isoDateSchema,
    status: z.enum(["draft", "verified", "stale"])
  })
  .superRefine((value, context) => {
    if (value.status === "draft") return;
    const currentDate = calendarDateInShanghai();
    const currentYear = Number(currentDate.slice(0, 4));
    if (!isGovernmentHttpsUrl(value.sourceUrl)) {
      context.addIssue({
        code: "custom",
        path: ["sourceUrl"],
        message: "已审核参数必须使用政府官方 HTTPS 来源"
      });
    }
    if (value.sourcePublishedAt > currentDate) {
      context.addIssue({
        code: "custom",
        path: ["sourcePublishedAt"],
        message: "来源发布日期不得晚于当前日期"
      });
    }
    if (
      value.year > currentYear ||
      Number(value.sourcePublishedAt.slice(0, 4)) < value.year
    ) {
      context.addIssue({
        code: "custom",
        path: ["year"],
        message: "参数年份必须已由该来源发布且不得晚于当前年份"
      });
    }
  });

const requireRegionalParameterCapability = (
  request: Request,
  response: Response,
  next: NextFunction
) =>
  requireCapability(
    request.body?.status === "verified" ||
    request.body?.status === "stale"
      ? "policy.publish"
      : "policy.write"
  )(request, response, next);

export const createAdminPolicyRouter = (
  repository = new PolicyRepository()
) => {
  const router = Router();
  const read = requireCapability("policy.read");
  const write = requireCapability("policy.write");
  const publish = requireCapability("policy.publish");

  router.get(
    "/rule-sets/:code/versions",
    read,
    async (request, response) => {
      const code = z.string().trim().min(1).max(100).parse(request.params.code);
      response.json({ items: await repository.listVersions(code) });
    }
  );

  router.post(
    "/rule-sets/:code/versions",
    write,
    async (request, response) => {
      const code = z.string().trim().min(1).max(100).parse(request.params.code);
      const body = z
        .object({
          definition: policyDefinitionSchema,
          sourceSnapshot: sourceSnapshotSchema.default([]),
          effectiveFrom: isoDateSchema,
          effectiveTo: isoDateSchema.nullable().optional()
        })
        .strict()
        .refine(
          (value) =>
            !value.effectiveTo ||
            value.effectiveTo >= value.effectiveFrom,
          {
            path: ["effectiveTo"],
            message: "结束日期不得早于开始日期"
          }
        )
        .parse(request.body);
      response.status(201).json(
        await repository.createDraft({
          code,
          ...body,
          request
        })
      );
    }
  );

  router.post(
    "/rule-sets/:code/versions/:id/publish",
    publish,
    async (request, response) => {
      const code = z.string().trim().min(1).max(100).parse(request.params.code);
      const id = z.string().uuid().parse(request.params.id);
      response.json(
        await repository.publishVersion({ code, id, request })
      );
    }
  );

  router.post(
    "/rule-sets/:code/rollback",
    publish,
    async (request, response) => {
      const code = z.string().trim().min(1).max(100).parse(request.params.code);
      const body = z
        .object({
          targetVersion: z.number().int().positive(),
          effectiveFrom: isoDateSchema
        })
        .strict()
        .parse(request.body);
      response.status(201).json(
        await repository.rollback({ code, ...body, request })
      );
    }
  );

  router.put(
    "/regional-parameters",
    requireRegionalParameterCapability,
    async (request, response) => {
      const input = regionalParameterSchema.parse(request.body);
      response.json(
        await repository.upsertRegionalParameter({ input, request })
      );
    }
  );

  router.get("/coverage", read, async (request, response) => {
    const query = z
      .object({
        year: z.coerce.number().int().min(2000).max(2100)
      })
      .parse(request.query);
    response.json({ year: query.year, items: await repository.coverage(query.year) });
  });

  return router;
};
