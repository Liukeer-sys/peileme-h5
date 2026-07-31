import { z } from "zod";
import { calculatePolicy } from "./engine.js";
import type {
  EnginePolicyRules,
  EngineTerminationRule,
  PolicyInput,
  PolicyOutput,
  TerminationScenario
} from "./types.js";

export const POLICY_REGRESSION_CASE_IDS = [
  "mutual-employer",
  "mutual-employee-review",
  "article-40-notice",
  "article-40-payment-in-lieu",
  "article-38",
  "statutory",
  "article-39",
  "voluntary",
  "unlawful-cash",
  "unlawful-continue",
  "unclear-fact-gaps",
  "service-under-six-months",
  "service-at-least-six-months",
  "high-salary-cap"
] as const;

type PolicyRegressionCaseId =
  (typeof POLICY_REGRESSION_CASE_IDS)[number];

const moneySchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const rangeSchema = z
  .object({ low: moneySchema, high: moneySchema })
  .strict()
  .refine((range) => range.low <= range.high, {
    message: "low must not exceed high"
  });
const formulaExpectationSchema = z
  .object({
    scenarioSemantics: z.string().min(1),
    baseSemantics: z.string().min(1),
    noticeSemantics: z.string().min(1),
    effectiveCompensationMultiplier: z.number().min(0).max(4),
    effectiveNoticePayMonths: z.number().min(0).max(3)
  })
  .strict();
const regressionExpectationCaseSchema = z
  .object({
    id: z.enum(POLICY_REGRESSION_CASE_IDS),
    scenario: z.string().min(1),
    path: z.string().min(1),
    compensationMonths: z.number().min(0),
    baseCompensationFen: moneySchema,
    noticePayFen: moneySchema,
    payableDetermined: z.boolean(),
    payableFen: moneySchema,
    rangeFen: rangeSchema,
    differenceRangeFen: rangeSchema,
    reviewRequired: z.boolean(),
    continuedPerformanceRequired: z.boolean(),
    formula: formulaExpectationSchema
  })
  .strict();

export const policyRegressionExpectationsSchema = z
  .object({
    schemaVersion: z.literal(1),
    cases: z.array(regressionExpectationCaseSchema).length(
      POLICY_REGRESSION_CASE_IDS.length
    )
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const [index, item] of value.cases.entries()) {
      if (seen.has(item.id)) {
        context.addIssue({
          code: "custom",
          path: ["cases", index, "id"],
          message: "duplicate regression case"
        });
      }
      seen.add(item.id);
    }
    for (const id of POLICY_REGRESSION_CASE_IDS) {
      if (!seen.has(id)) {
        context.addIssue({
          code: "custom",
          path: ["cases"],
          message: `missing regression case: ${id}`
        });
      }
    }
  });

export type PolicyRegressionExpectations = z.infer<
  typeof policyRegressionExpectationsSchema
>;
export type PolicyRegressionExpected = PolicyRegressionExpectations["cases"][number];
export type PolicyRegressionDiff = {
  path: string;
  expected: unknown;
  actual: unknown;
};
export type PolicyRegressionCaseResult = {
  id: PolicyRegressionCaseId;
  status: "passed" | "failed";
  expected: PolicyRegressionExpected;
  actual: PolicyRegressionExpected | null;
  diff: PolicyRegressionDiff[];
  error?: string;
};
export type PolicyRegressionSummary = {
  expectationSchemaVersion: 1;
  total: number;
  passed: number;
  failed: number;
  cases: PolicyRegressionCaseResult[];
};

const scenario = {
  mutualEmployer: "用人单位提出协商解除，按N计算经济补偿",
  mutualEmployee:
    "劳动者提出协商解除，法定经济补偿需结合协议及事实复核，以待复核区间展示",
  article40Notice: "用人单位依据第四十条解除并已提前三十日书面通知",
  article40Lieu: "用人单位依据第四十条解除并选择支付代通知金",
  article38: "劳动者依据第三十八条解除，按N计算经济补偿",
  statutory: "劳动合同依法解除或终止，按N计算法定经济补偿",
  article39: "用人单位依据第三十九条过失性解除，法定经济补偿为0分",
  voluntary: "劳动者自愿辞职，法定经济补偿按0分计算",
  unlawfulCash: "违法解除，按二倍经济补偿计算赔偿金",
  unlawfulContinue: "违法解除，继续履行劳动合同优先",
  unclear:
    "解除情形尚不明确，现金结果按支持情形的保守范围展示并需复核"
} as const;
const baseSeven = "1000000分×7=7000000分";
const noNotice = "当前情形不适用代通知金，金额为0分";
const fixed = (
  input: Omit<PolicyRegressionExpected, "formula"> & {
    formula: PolicyRegressionExpected["formula"];
  }
): PolicyRegressionExpected => input;

export const DEFAULT_POLICY_REGRESSION_EXPECTATIONS: PolicyRegressionExpectations = {
  schemaVersion: 1,
  cases: [
    fixed({
      id: "mutual-employer",
      scenario: "MUTUAL_AGREEMENT.employer",
      path: "decisionModel.mutualAgreement.employerProposed",
      compensationMonths: 7,
      baseCompensationFen: 7_000_000,
      noticePayFen: 0,
      payableDetermined: true,
      payableFen: 7_000_000,
      rangeFen: { low: 7_000_000, high: 7_000_000 },
      differenceRangeFen: { low: 7_000_000, high: 7_000_000 },
      reviewRequired: false,
      continuedPerformanceRequired: false,
      formula: {
        scenarioSemantics: scenario.mutualEmployer,
        baseSemantics: baseSeven,
        noticeSemantics: noNotice,
        effectiveCompensationMultiplier: 1,
        effectiveNoticePayMonths: 0
      }
    }),
    fixed({
      id: "mutual-employee-review",
      scenario: "MUTUAL_AGREEMENT.employee",
      path: "decisionModel.mutualAgreement.employeeProposed",
      compensationMonths: 7,
      baseCompensationFen: 7_000_000,
      noticePayFen: 0,
      payableDetermined: false,
      payableFen: 0,
      rangeFen: { low: 0, high: 7_000_000 },
      differenceRangeFen: { low: 0, high: 7_000_000 },
      reviewRequired: true,
      continuedPerformanceRequired: false,
      formula: {
        scenarioSemantics: scenario.mutualEmployee,
        baseSemantics: baseSeven,
        noticeSemantics: noNotice,
        effectiveCompensationMultiplier: 0,
        effectiveNoticePayMonths: 0
      }
    }),
    fixed({
      id: "article-40-notice",
      scenario: "ARTICLE_40.notice_30_days",
      path: "decisionModel.article40EmployerTermination.notice30Days",
      compensationMonths: 7,
      baseCompensationFen: 7_000_000,
      noticePayFen: 0,
      payableDetermined: true,
      payableFen: 7_000_000,
      rangeFen: { low: 7_000_000, high: 7_000_000 },
      differenceRangeFen: { low: 7_000_000, high: 7_000_000 },
      reviewRequired: false,
      continuedPerformanceRequired: false,
      formula: {
        scenarioSemantics: scenario.article40Notice,
        baseSemantics: baseSeven,
        noticeSemantics: "已提前三十日书面通知，代通知金为0分",
        effectiveCompensationMultiplier: 1,
        effectiveNoticePayMonths: 0
      }
    }),
    fixed({
      id: "article-40-payment-in-lieu",
      scenario: "ARTICLE_40.payment_in_lieu",
      path: "decisionModel.article40EmployerTermination.paymentInLieu",
      compensationMonths: 7,
      baseCompensationFen: 7_000_000,
      noticePayFen: 1_000_000,
      payableDetermined: true,
      payableFen: 8_000_000,
      rangeFen: { low: 8_000_000, high: 8_000_000 },
      differenceRangeFen: { low: 8_000_000, high: 8_000_000 },
      reviewRequired: false,
      continuedPerformanceRequired: false,
      formula: {
        scenarioSemantics: scenario.article40Lieu,
        baseSemantics: baseSeven,
        noticeSemantics:
          "按解除前一个完整工资月1000000分计算，代通知金为1000000分",
        effectiveCompensationMultiplier: 1,
        effectiveNoticePayMonths: 1
      }
    }),
    fixed({
      id: "article-38",
      scenario: "ARTICLE_38_EMPLOYEE_TERMINATION",
      path: "decisionModel.employeeTermination.article38",
      compensationMonths: 7,
      baseCompensationFen: 7_000_000,
      noticePayFen: 0,
      payableDetermined: true,
      payableFen: 7_000_000,
      rangeFen: { low: 7_000_000, high: 7_000_000 },
      differenceRangeFen: { low: 7_000_000, high: 7_000_000 },
      reviewRequired: false,
      continuedPerformanceRequired: false,
      formula: {
        scenarioSemantics: scenario.article38,
        baseSemantics: baseSeven,
        noticeSemantics: noNotice,
        effectiveCompensationMultiplier: 1,
        effectiveNoticePayMonths: 0
      }
    }),
    fixed({
      id: "statutory",
      scenario: "STATUTORY_COMPENSATION",
      path: "decisionModel.statutoryCompensation",
      compensationMonths: 7,
      baseCompensationFen: 7_000_000,
      noticePayFen: 0,
      payableDetermined: true,
      payableFen: 7_000_000,
      rangeFen: { low: 7_000_000, high: 7_000_000 },
      differenceRangeFen: { low: 7_000_000, high: 7_000_000 },
      reviewRequired: false,
      continuedPerformanceRequired: false,
      formula: {
        scenarioSemantics: scenario.statutory,
        baseSemantics: baseSeven,
        noticeSemantics: noNotice,
        effectiveCompensationMultiplier: 1,
        effectiveNoticePayMonths: 0
      }
    }),
    fixed({
      id: "article-39",
      scenario: "ARTICLE_39_NO_COMPENSATION",
      path: "decisionModel.article39NoCompensation",
      compensationMonths: 7,
      baseCompensationFen: 7_000_000,
      noticePayFen: 0,
      payableDetermined: true,
      payableFen: 0,
      rangeFen: { low: 0, high: 0 },
      differenceRangeFen: { low: 0, high: 0 },
      reviewRequired: false,
      continuedPerformanceRequired: false,
      formula: {
        scenarioSemantics: scenario.article39,
        baseSemantics: baseSeven,
        noticeSemantics: noNotice,
        effectiveCompensationMultiplier: 0,
        effectiveNoticePayMonths: 0
      }
    }),
    fixed({
      id: "voluntary",
      scenario: "VOLUNTARY_RESIGNATION",
      path: "decisionModel.employeeTermination.voluntaryResignation",
      compensationMonths: 7,
      baseCompensationFen: 7_000_000,
      noticePayFen: 0,
      payableDetermined: true,
      payableFen: 0,
      rangeFen: { low: 0, high: 0 },
      differenceRangeFen: { low: 0, high: 0 },
      reviewRequired: false,
      continuedPerformanceRequired: false,
      formula: {
        scenarioSemantics: scenario.voluntary,
        baseSemantics: baseSeven,
        noticeSemantics: noNotice,
        effectiveCompensationMultiplier: 0,
        effectiveNoticePayMonths: 0
      }
    }),
    fixed({
      id: "unlawful-cash",
      scenario: "UNLAWFUL_TERMINATION.cash",
      path: "decisionModel.unlawfulTermination.fallbackCompensation",
      compensationMonths: 7,
      baseCompensationFen: 7_000_000,
      noticePayFen: 0,
      payableDetermined: true,
      payableFen: 14_000_000,
      rangeFen: { low: 14_000_000, high: 14_000_000 },
      differenceRangeFen: { low: 14_000_000, high: 14_000_000 },
      reviewRequired: false,
      continuedPerformanceRequired: false,
      formula: {
        scenarioSemantics: scenario.unlawfulCash,
        baseSemantics: baseSeven,
        noticeSemantics: noNotice,
        effectiveCompensationMultiplier: 2,
        effectiveNoticePayMonths: 0
      }
    }),
    fixed({
      id: "unlawful-continue",
      scenario: "UNLAWFUL_TERMINATION.continue",
      path: "decisionModel.unlawfulTermination.primaryRemedy",
      compensationMonths: 7,
      baseCompensationFen: 7_000_000,
      noticePayFen: 0,
      payableDetermined: true,
      payableFen: 0,
      rangeFen: { low: 0, high: 0 },
      differenceRangeFen: { low: 0, high: 0 },
      reviewRequired: false,
      continuedPerformanceRequired: true,
      formula: {
        scenarioSemantics: scenario.unlawfulContinue,
        baseSemantics: baseSeven,
        noticeSemantics: noNotice,
        effectiveCompensationMultiplier: 2,
        effectiveNoticePayMonths: 0
      }
    }),
    fixed({
      id: "unclear-fact-gaps",
      scenario: "UNCLEAR.fact_gaps",
      path: "decisionModel.unclear.reviewCandidates",
      compensationMonths: 7,
      baseCompensationFen: 7_000_000,
      noticePayFen: 0,
      payableDetermined: false,
      payableFen: 0,
      rangeFen: { low: 0, high: 14_000_000 },
      differenceRangeFen: { low: 0, high: 14_000_000 },
      reviewRequired: true,
      continuedPerformanceRequired: false,
      formula: {
        scenarioSemantics: scenario.unclear,
        baseSemantics: baseSeven,
        noticeSemantics: noNotice,
        effectiveCompensationMultiplier: 0,
        effectiveNoticePayMonths: 0
      }
    }),
    fixed({
      id: "service-under-six-months",
      scenario: "STATUTORY_COMPENSATION",
      path: "serviceYearFraction.lessThanSixMonths",
      compensationMonths: 0.5,
      baseCompensationFen: 500_000,
      noticePayFen: 0,
      payableDetermined: true,
      payableFen: 500_000,
      rangeFen: { low: 500_000, high: 500_000 },
      differenceRangeFen: { low: 500_000, high: 500_000 },
      reviewRequired: false,
      continuedPerformanceRequired: false,
      formula: {
        scenarioSemantics: scenario.statutory,
        baseSemantics: "1000000分×0.5=500000分",
        noticeSemantics: noNotice,
        effectiveCompensationMultiplier: 1,
        effectiveNoticePayMonths: 0
      }
    }),
    fixed({
      id: "service-at-least-six-months",
      scenario: "STATUTORY_COMPENSATION",
      path: "serviceYearFraction.atLeastSixMonths",
      compensationMonths: 1,
      baseCompensationFen: 1_000_000,
      noticePayFen: 0,
      payableDetermined: true,
      payableFen: 1_000_000,
      rangeFen: { low: 1_000_000, high: 1_000_000 },
      differenceRangeFen: { low: 1_000_000, high: 1_000_000 },
      reviewRequired: false,
      continuedPerformanceRequired: false,
      formula: {
        scenarioSemantics: scenario.statutory,
        baseSemantics: "1000000分×1=1000000分",
        noticeSemantics: noNotice,
        effectiveCompensationMultiplier: 1,
        effectiveNoticePayMonths: 0
      }
    }),
    fixed({
      id: "high-salary-cap",
      scenario: "STATUTORY_COMPENSATION",
      path: "highSalaryCap",
      compensationMonths: 12,
      baseCompensationFen: 36_000_000,
      noticePayFen: 0,
      payableDetermined: true,
      payableFen: 36_000_000,
      rangeFen: { low: 36_000_000, high: 36_000_000 },
      differenceRangeFen: { low: 36_000_000, high: 36_000_000 },
      reviewRequired: false,
      continuedPerformanceRequired: false,
      formula: {
        scenarioSemantics: scenario.statutory,
        baseSemantics: "3000000分×12=36000000分",
        noticeSemantics: noNotice,
        effectiveCompensationMultiplier: 1,
        effectiveNoticePayMonths: 0
      }
    })
  ]
};

type FixedCase = {
  id: PolicyRegressionCaseId;
  scenario: string;
  path: string;
  input: PolicyInput;
  rule: (rules: EnginePolicyRules) => EngineTerminationRule;
};

const baseInput = (
  overrides: Partial<PolicyInput> = {}
): PolicyInput => ({
  regionCode: "310000",
  regionName: "上海市",
  startDate: "2020-01-01",
  endDate: "2026-07-01",
  terminationScenario: { kind: "STATUTORY_COMPENSATION" },
  monthlyEarnedWagesFen: Array(12).fill(1_000_000),
  wageDataConfirmation: {
    confirmed: true,
    basis: "pretax_earned_including_bonus_allowance"
  },
  minimumMonthlyWageFen: 250_000,
  employeeAverageMonthlyWageFen: 1_250_000,
  alreadyPaidFen: 0,
  ...overrides
});

const fixedCase = (
  id: PolicyRegressionCaseId,
  scenarioName: string,
  path: string,
  terminationScenario: TerminationScenario,
  rule: FixedCase["rule"],
  overrides: Partial<PolicyInput> = {}
): FixedCase => ({
  id,
  scenario: scenarioName,
  path,
  input: baseInput({ ...overrides, terminationScenario }),
  rule
});

const fixedCases: FixedCase[] = [
  fixedCase(
    "mutual-employer",
    "MUTUAL_AGREEMENT.employer",
    "decisionModel.mutualAgreement.employerProposed",
    { kind: "MUTUAL_AGREEMENT", proposedBy: "employer" },
    (rules) => rules.termination.mutualAgreementEmployer
  ),
  fixedCase(
    "mutual-employee-review",
    "MUTUAL_AGREEMENT.employee",
    "decisionModel.mutualAgreement.employeeProposed",
    { kind: "MUTUAL_AGREEMENT", proposedBy: "employee" },
    (rules) => rules.termination.mutualAgreementEmployee
  ),
  fixedCase(
    "article-40-notice",
    "ARTICLE_40.notice_30_days",
    "decisionModel.article40EmployerTermination.notice30Days",
    { kind: "ARTICLE_40", noticeMethod: "notice_30_days" },
    (rules) => rules.termination.article40Notice30Days
  ),
  fixedCase(
    "article-40-payment-in-lieu",
    "ARTICLE_40.payment_in_lieu",
    "decisionModel.article40EmployerTermination.paymentInLieu",
    { kind: "ARTICLE_40", noticeMethod: "payment_in_lieu" },
    (rules) => rules.termination.article40PaymentInLieu
  ),
  fixedCase(
    "article-38",
    "ARTICLE_38_EMPLOYEE_TERMINATION",
    "decisionModel.employeeTermination.article38",
    { kind: "ARTICLE_38_EMPLOYEE_TERMINATION" },
    (rules) => rules.termination.article38EmployeeTermination
  ),
  fixedCase(
    "statutory",
    "STATUTORY_COMPENSATION",
    "decisionModel.statutoryCompensation",
    { kind: "STATUTORY_COMPENSATION" },
    (rules) => rules.termination.statutoryCompensation
  ),
  fixedCase(
    "article-39",
    "ARTICLE_39_NO_COMPENSATION",
    "decisionModel.article39NoCompensation",
    { kind: "ARTICLE_39_NO_COMPENSATION" },
    (rules) => rules.termination.article39NoCompensation
  ),
  fixedCase(
    "voluntary",
    "VOLUNTARY_RESIGNATION",
    "decisionModel.employeeTermination.voluntaryResignation",
    { kind: "VOLUNTARY_RESIGNATION" },
    (rules) => rules.termination.voluntaryResignation
  ),
  fixedCase(
    "unlawful-cash",
    "UNLAWFUL_TERMINATION.cash",
    "decisionModel.unlawfulTermination.fallbackCompensation",
    {
      kind: "UNLAWFUL_TERMINATION",
      continuedPerformanceRequested: false,
      continuedPerformancePossible: true
    },
    (rules) => rules.termination.unlawfulTermination
  ),
  fixedCase(
    "unlawful-continue",
    "UNLAWFUL_TERMINATION.continue",
    "decisionModel.unlawfulTermination.primaryRemedy",
    {
      kind: "UNLAWFUL_TERMINATION",
      continuedPerformanceRequested: true,
      continuedPerformancePossible: true
    },
    (rules) => rules.termination.unlawfulTermination
  ),
  fixedCase(
    "unclear-fact-gaps",
    "UNCLEAR.fact_gaps",
    "decisionModel.unclear.reviewCandidates",
    { kind: "UNCLEAR", factGaps: ["解除依据", "通知证据"] },
    (rules) => rules.termination.unclear
  ),
  fixedCase(
    "service-under-six-months",
    "STATUTORY_COMPENSATION",
    "serviceYearFraction.lessThanSixMonths",
    { kind: "STATUTORY_COMPENSATION" },
    (rules) => rules.termination.statutoryCompensation,
    { startDate: "2026-03-01" }
  ),
  fixedCase(
    "service-at-least-six-months",
    "STATUTORY_COMPENSATION",
    "serviceYearFraction.atLeastSixMonths",
    { kind: "STATUTORY_COMPENSATION" },
    (rules) => rules.termination.statutoryCompensation,
    { startDate: "2026-01-01" }
  ),
  fixedCase(
    "high-salary-cap",
    "STATUTORY_COMPENSATION",
    "highSalaryCap",
    { kind: "STATUTORY_COMPENSATION" },
    (rules) => rules.termination.statutoryCompensation,
    {
      startDate: "2000-01-01",
      monthlyEarnedWagesFen: Array(12).fill(4_000_000),
      employeeAverageMonthlyWageFen: 1_000_000
    }
  )
];

const formulaValue = (output: PolicyOutput, key: string) =>
  output.formulaSteps.find((step) => step.key === key)?.value ?? "";

const actualFor = (
  item: FixedCase,
  output: PolicyOutput,
  rules: EnginePolicyRules
): PolicyRegressionExpected => {
  const rule = item.rule(rules);
  return {
    id: item.id,
    scenario: item.scenario,
    path: item.path,
    compensationMonths: output.compensationMonths,
    baseCompensationFen: output.baseCompensationFen,
    noticePayFen: output.noticePayFen,
    payableDetermined: output.payableDetermined,
    payableFen: output.payableFen,
    rangeFen: output.rangeFen,
    differenceRangeFen: output.differenceRangeFen,
    reviewRequired: output.reviewRequired,
    continuedPerformanceRequired: output.continuedPerformanceRequired,
    formula: {
      scenarioSemantics: formulaValue(output, "scenario"),
      baseSemantics: formulaValue(output, "base"),
      noticeSemantics: formulaValue(output, "notice"),
      effectiveCompensationMultiplier: rule.compensationMultiplier,
      effectiveNoticePayMonths: rule.noticePayMonths
    }
  };
};

const compareExpected = (
  expected: PolicyRegressionExpected,
  actual: PolicyRegressionExpected
): PolicyRegressionDiff[] => {
  const diff: PolicyRegressionDiff[] = [];
  const compare = (
    path: string,
    expectedValue: unknown,
    actualValue: unknown
  ) => {
    if (JSON.stringify(expectedValue) !== JSON.stringify(actualValue)) {
      diff.push({ path, expected: expectedValue, actual: actualValue });
    }
  };
  compare("id", expected.id, actual.id);
  compare("scenario", expected.scenario, actual.scenario);
  compare("path", expected.path, actual.path);
  compare(
    "compensationMonths",
    expected.compensationMonths,
    actual.compensationMonths
  );
  compare(
    "baseCompensationFen",
    expected.baseCompensationFen,
    actual.baseCompensationFen
  );
  compare("noticePayFen", expected.noticePayFen, actual.noticePayFen);
  compare(
    "payableDetermined",
    expected.payableDetermined,
    actual.payableDetermined
  );
  compare("payableFen", expected.payableFen, actual.payableFen);
  compare("rangeFen", expected.rangeFen, actual.rangeFen);
  compare(
    "differenceRangeFen",
    expected.differenceRangeFen,
    actual.differenceRangeFen
  );
  compare(
    "reviewRequired",
    expected.reviewRequired,
    actual.reviewRequired
  );
  compare(
    "continuedPerformanceRequired",
    expected.continuedPerformanceRequired,
    actual.continuedPerformanceRequired
  );
  compare(
    "formula.scenarioSemantics",
    expected.formula.scenarioSemantics,
    actual.formula.scenarioSemantics
  );
  compare(
    "formula.baseSemantics",
    expected.formula.baseSemantics,
    actual.formula.baseSemantics
  );
  compare(
    "formula.noticeSemantics",
    expected.formula.noticeSemantics,
    actual.formula.noticeSemantics
  );
  compare(
    "formula.effectiveCompensationMultiplier",
    expected.formula.effectiveCompensationMultiplier,
    actual.formula.effectiveCompensationMultiplier
  );
  compare(
    "formula.effectiveNoticePayMonths",
    expected.formula.effectiveNoticePayMonths,
    actual.formula.effectiveNoticePayMonths
  );
  return diff;
};

export const runPolicyRegression = (
  rules: EnginePolicyRules,
  expectationsValue: unknown = DEFAULT_POLICY_REGRESSION_EXPECTATIONS
): PolicyRegressionSummary => {
  const expectations =
    policyRegressionExpectationsSchema.parse(expectationsValue);
  const byId = new Map(
    expectations.cases.map((item) => [item.id, item])
  );
  const cases: PolicyRegressionCaseResult[] = fixedCases.map((item) => {
    const expected = byId.get(item.id)!;
    try {
      const actual = actualFor(
        item,
        calculatePolicy(item.input, rules),
        rules
      );
      const diff = compareExpected(expected, actual);
      return {
        id: item.id,
        status: diff.length === 0 ? "passed" : "failed",
        expected,
        actual,
        diff
      };
    } catch (error) {
      return {
        id: item.id,
        status: "failed",
        expected,
        actual: null,
        diff: [
          {
            path: "execution",
            expected: "successful calculation",
            actual:
              error instanceof Error ? error.message : "unknown error"
          }
        ],
        error:
          error instanceof Error && error.name === "PolicyEngineError"
            ? error.message
            : "regression-execution-error"
      };
    }
  });
  const failed = cases.filter((item) => item.status === "failed").length;
  return {
    expectationSchemaVersion: expectations.schemaVersion,
    total: cases.length,
    passed: cases.length - failed,
    failed,
    cases
  };
};
