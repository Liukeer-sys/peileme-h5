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
  getEffectivePrice,
  getProductBySku
} from "../commerce/catalog.js";
import {
  consumeEntitlementInTransaction,
  releaseEntitlement,
  reserveEntitlement,
  type EntitlementReservation
} from "../commerce/entitlements.js";
import { CommerceError } from "../commerce/types.js";
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
import { parseCsvRecords } from "../../lib/csv.js";

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
  z
    .object({
      kind: z.literal("UNCLEAR"),
      factGaps: z.array(z.string().trim().min(1).max(200)).min(1).max(10).optional()
    })
    .strict()
]);
const calculateSchema = z.object({
  regionCode: z.string().regex(/^\d{6}$/),
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  terminationScenario: terminationScenarioSchema,
  monthlyEarnedWagesFen: z.array(safeMoneySchema).min(1).max(12),
  wageDataConfirmation: z
    .object({
      confirmed: z.literal(true),
      basis: z.literal("pretax_earned_including_bonus_allowance")
    })
    .strict(),
  alreadyPaidFen: safeMoneySchema.optional(),
  manualParameters: z
    .object({
      minimumMonthlyWageFen: positiveMoneySchema.optional(),
      employeeAverageMonthlyWageFen: positiveMoneySchema.optional()
    })
    .strict()
    .optional()
});
const calculateRequestSchema = calculateSchema.extend({
  businessDraftId: z.string().uuid().optional()
});

type PolicyCalculate = (input: unknown) => PolicyOutput;
const policyCalculationSku = "POLICY_CALC";

const policyEngineMessage: Record<string, string> = {
  INVALID_POLICY_INPUT: "政策计算输入无效",
  INVALID_REGION: "地区输入无效",
  INVALID_EMPLOYMENT_DATE: "入职或解除日期无效",
  END_DATE_MUST_FOLLOW_START_DATE: "解除日期必须晚于入职日期",
  INVALID_TERMINATION_SCENARIO: "解除情形无效",
  WAGE_MONTHS_OUT_OF_RANGE: "工资月份数量无效",
  INVALID_WAGE_VALUE: "工资金额无效",
  INVALID_WAGE_CONFIRMATION: "请确认税前应发工资口径",
  INVALID_REGIONAL_PARAMETER: "地区参数无效",
  INVALID_ALREADY_PAID: "已支付金额无效",
  COMPUTATION_OVERFLOW: "计算金额超出安全范围"
};

const getPolicyCalculationPriceFen = async () => {
  const product = await getProductBySku(policyCalculationSku);
  const price = product
    ? await getEffectivePrice(product.id, new Date())
    : null;
  if (!product || !price) {
    throw new ApiError(
      503,
      "POLICY_PRICE_UNAVAILABLE",
      "政策测算价格暂不可用"
    );
  }
  return price.amountFen;
};

const commerceApiError = (error: CommerceError) => {
  const errors: Partial<
    Record<
      CommerceError["code"],
      { status: number; message: string }
    >
  > = {
    IDENTITY_VERIFICATION_REQUIRED: {
      status: 403,
      message: "完成邮箱或手机验证后才可使用测算权益"
    },
    PRODUCT_NOT_FOUND: {
      status: 503,
      message: "政策测算商品暂不可用"
    },
    PRODUCT_INACTIVE: {
      status: 503,
      message: "政策测算商品暂不可用"
    },
    BUSINESS_ID_CONFLICT: {
      status: 409,
      message: "计算草稿的权益记录冲突"
    },
    ENTITLEMENT_USAGE_NOT_FOUND: {
      status: 409,
      message: "计算草稿的权益记录不存在"
    },
    ENTITLEMENT_USAGE_CLOSED: {
      status: 409,
      message: "计算草稿的权益记录已关闭"
    }
  };
  const mapped = errors[error.code] ?? {
    status: 400,
    message: "政策测算权益请求无效"
  };
  return new ApiError(mapped.status, error.code, mapped.message);
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
      const parsed = calculateRequestSchema.parse(request.body);
      const {
        businessDraftId,
        ...validatedFacts
      } = parsed;
      const facts = validatedFacts as PolicyFacts;
      const identity = getRequestIdentity(request);
      const draft = await repository.ensureCalculationDraft({
        businessDraftId,
        userId: request.authUser!.id,
        visitorId: identity.visitorId,
        sessionId: identity.sessionId,
        facts
      });
      if (draft.status === "completed") {
        const replay = await repository.calculateAndPersist({
          assessmentId: draft.assessmentId,
          userId: request.authUser!.id,
          facts,
          calculate
        });
        response.status(201).json(replay);
        return;
      }

      let reservation: EntitlementReservation;
      try {
        reservation = await reserveEntitlement(
          request.authUser!.id,
          policyCalculationSku,
          draft.assessmentId
        );
      } catch (error) {
        if (
          error instanceof CommerceError &&
          error.code === "ENTITLEMENT_NOT_AVAILABLE"
        ) {
          response.status(402).json({
            error: "PAYMENT_REQUIRED",
            message: "本次完整测算需要按次购买",
            sku: policyCalculationSku,
            businessDraftId: draft.assessmentId,
            priceFen: await getPolicyCalculationPriceFen()
          });
          return;
        }
        throw error;
      }

      try {
        const result = await repository.calculateAndPersist({
          assessmentId: draft.assessmentId,
          userId: request.authUser!.id,
          facts,
          calculate,
          beforeComplete: async (client) => {
            if (reservation.status === "reserved") {
              await consumeEntitlementInTransaction(
                client,
                reservation.usageId
              );
            }
          }
        });
        response.status(201).json(result);
      } catch (error) {
        if (reservation.status === "reserved") {
          try {
            await releaseEntitlement(reservation.usageId);
          } catch (releaseError) {
            request.log?.error(releaseError);
          }
        }
        throw error;
      }
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
      if (error instanceof CommerceError) {
        next(commerceApiError(error));
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

  router.get("/share/:token", async (request, response) => {
    const token = z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .parse(request.params.token);
    response.json(await repository.getSharedResult(token));
  });

  router.post(
    "/history/:id/share",
    requireAuth,
    async (request, response) => {
      const assessmentId = z.string().uuid().parse(request.params.id);
      const body = z
        .object({
          expiresInDays: z.number().int().min(1).max(30).default(7)
        })
        .strict()
        .parse(request.body);
      response.status(201).json(
        await repository.createShare(
          request.authUser!.id,
          assessmentId,
          body.expiresInDays
        )
      );
    }
  );

  router.get("/history/:id/shares", requireAuth, async (request, response) => {
    const assessmentId = z.string().uuid().parse(request.params.id);
    response.json({
      items: await repository.listShares(
        request.authUser!.id,
        assessmentId
      )
    });
  });

  router.delete("/shares/:id", requireAuth, async (request, response) => {
    const shareId = z.string().uuid().parse(request.params.id);
    await repository.revokeShare(request.authUser!.id, shareId);
    response.status(204).end();
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
    status: z.enum(["draft", "verified", "stale"]),
    expectedRevision: z.number().int().positive().optional()
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

const regionalParameterCsvHeader = [
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

const safeSpreadsheetText = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !/^[=+\-@]/.test(value), {
    message: "文本字段不得以 =、+、- 或 @ 开头"
  });

const regionalParameterCsvRowSchema = z
  .object({
    region_code: z.string().regex(/^\d{6}$/),
    region_name: safeSpreadsheetText.max(200),
    year: z.string().regex(/^\d{4}$/).transform(Number),
    parameter_type: z.enum([
      "minimum_monthly_wage",
      "employee_average_monthly_wage"
    ]),
    amount_fen: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(positiveMoneySchema),
    source_name: safeSpreadsheetText.max(500),
    source_url: z.string(),
    source_published_at: z.string(),
    status: z.enum(["draft", "verified", "stale"])
  })
  .transform((row) => ({
    regionCode: row.region_code,
    regionName: row.region_name,
    year: row.year,
    parameterType: row.parameter_type,
    amountFen: row.amount_fen,
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    sourcePublishedAt: row.source_published_at,
    status: row.status
  }));

class RegionalParameterCsvError extends Error {}

const announcementFields = {
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20_000),
  placement: z.enum(["main", "ai", "all"]),
  status: z.enum(["draft", "published", "archived"]),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional()
};

const validAnnouncementSchedule = (
  value: { startsAt?: string | null; endsAt?: string | null },
  context: z.RefinementCtx
) => {
  if (
    value.startsAt &&
    value.endsAt &&
    Date.parse(value.endsAt) < Date.parse(value.startsAt)
  ) {
    context.addIssue({
      code: "custom",
      path: ["endsAt"],
      message: "公告结束时间不得早于开始时间"
    });
  }
};

const createAnnouncementSchema = z
  .object({
    ...announcementFields,
    status: z.literal("draft")
  })
  .strict()
  .superRefine(validAnnouncementSchedule);

const updateAnnouncementSchema = z
  .object({
    title: announcementFields.title.optional(),
    body: announcementFields.body.optional(),
    placement: announcementFields.placement.optional(),
    status: announcementFields.status.optional(),
    startsAt: announcementFields.startsAt,
    endsAt: announcementFields.endsAt,
    expectedRevision: z.number().int().positive().optional()
  })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => key !== "expectedRevision"),
    {
    message: "至少提供一个公告字段"
    }
  )
  .superRefine(validAnnouncementSchedule);

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

const requireAnnouncementCapability = (
  request: Request,
  response: Response,
  next: NextFunction
) =>
  requireCapability(
    request.body?.status &&
    request.body.status !== "draft"
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

  router.get(
    "/regional-parameters",
    read,
    async (request, response) => {
      const query = z
        .object({
          provinceCode: z.string().regex(/^\d{6}$/).optional(),
          cityCode: z.string().regex(/^\d{6}$/).optional(),
          year: z.coerce.number().int().min(2000).max(2100).optional(),
          parameterType: z
            .enum([
              "minimum_monthly_wage",
              "employee_average_monthly_wage"
            ])
            .optional(),
          status: z.enum(["draft", "verified", "stale"]).optional(),
          page: z.coerce.number().int().positive().default(1),
          pageSize: z.coerce.number().int().positive().max(100).default(50)
        })
        .parse(request.query);
      response.json(await repository.listRegionalParameters(query));
    }
  );

  router.post(
    "/regional-parameters/import",
    publish,
    async (request, response, next) => {
      let items: Array<
        z.infer<typeof regionalParameterSchema> & {
          regionName: string;
        }
      >;
      try {
        const body = z
          .object({
            csv: z.string().min(1).max(500_000)
          })
          .strict()
          .parse(request.body);
        const records = parseCsvRecords(
          body.csv,
          "regional-parameters.csv",
          regionalParameterCsvHeader,
          500_000
        );
        if (!records.length) {
          throw new Error("Regional-parameter CSV must contain at least one row");
        }
        const seen = new Set<string>();
        items = records.map((record, index) => {
          try {
            const parsedRow = regionalParameterCsvRowSchema.parse(record);
            const parsed = regionalParameterSchema.parse(parsedRow);
            const key = `${parsed.regionCode}:${parsed.year}:${parsed.parameterType}`;
            if (seen.has(key)) {
              throw new RegionalParameterCsvError(
                `第 ${index + 2} 行：区域参数 ${key} 重复`
              );
            }
            seen.add(key);
            return {
              ...parsed,
              regionName: parsedRow.regionName
            };
          } catch (error) {
            if (error instanceof z.ZodError) {
              throw new RegionalParameterCsvError(
                `第 ${index + 2} 行：${error.issues[0]?.message || "字段无效"}`
              );
            }
            throw error;
          }
        });
      } catch (error) {
        next(
          new ApiError(
            400,
            "INVALID_REGIONAL_PARAMETER_CSV",
            error instanceof z.ZodError
              ? error.issues[0]?.message || "CSV 请求无效"
              : error instanceof RegionalParameterCsvError ||
                  error instanceof Error
                ? error.message
                : "CSV 请求无效"
          )
        );
        return;
      }
      response.status(201).json(
        await repository.importRegionalParameters({
          inputs: items,
          request
        })
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

  router.get("/announcements", read, async (_request, response) => {
    response.json({ items: await repository.listAnnouncements() });
  });

  router.post(
    "/announcements",
    requireAnnouncementCapability,
    async (request, response) => {
      const input = createAnnouncementSchema.parse(request.body);
      response.status(201).json(
        await repository.createAnnouncement({ input, request })
      );
    }
  );

  router.patch(
    "/announcements/:id",
    requireAnnouncementCapability,
    async (request, response) => {
      const id = z.string().uuid().parse(request.params.id);
      const input = updateAnnouncementSchema.parse(request.body);
      response.json(
        await repository.updateAnnouncement({ id, input, request })
      );
    }
  );

  router.delete(
    "/announcements/:id",
    write,
    async (request, response) => {
      const id = z.string().uuid().parse(request.params.id);
      await repository.deleteAnnouncement({ id, request });
      response.status(204).end();
    }
  );

  return router;
};
