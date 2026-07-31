import { calculatePolicy } from "./engine.js";
import type {
  EnginePolicyRules,
  PolicyInput,
  PolicyOutput,
  TerminationScenario
} from "./types.js";

export type PolicyRegressionSummary = {
  total: number;
  passed: number;
  failed: number;
  cases: Array<{
    name: string;
    status: "passed" | "failed";
    error?: string;
  }>;
};

const baseInput = (
  overrides: Partial<PolicyInput> = {}
): PolicyInput => ({
  regionCode: "310000",
  regionName: "上海市",
  startDate: "2020-01-01",
  endDate: "2026-07-01",
  terminationScenario: {
    kind: "STATUTORY_COMPENSATION"
  },
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

const assertOutput = (
  output: PolicyOutput,
  expected: {
    reviewRequired?: boolean;
    continuedPerformanceRequired?: boolean;
  } = {}
) => {
  const money = [
    output.rawAverageWageFen,
    output.salaryBasisFen,
    output.baseCompensationFen,
    output.noticePayBasisFen,
    output.noticePayFen,
    output.payableFen,
    output.differenceFen,
    output.rangeFen.low,
    output.rangeFen.high,
    output.differenceRangeFen.low,
    output.differenceRangeFen.high
  ];
  if (
    money.some(
      (value) => !Number.isSafeInteger(value) || value < 0
    ) ||
    output.rangeFen.low > output.rangeFen.high ||
    output.differenceRangeFen.low > output.differenceRangeFen.high ||
    output.formulaSteps.length < 7
  ) {
    throw new Error("output-invariant");
  }
  if (
    expected.reviewRequired !== undefined &&
    output.reviewRequired !== expected.reviewRequired
  ) {
    throw new Error("review-state");
  }
  if (
    expected.continuedPerformanceRequired !== undefined &&
    output.continuedPerformanceRequired !==
      expected.continuedPerformanceRequired
  ) {
    throw new Error("continued-performance-state");
  }
};

const scenarios: Array<{
  name: string;
  scenario: TerminationScenario;
  expected?: {
    reviewRequired?: boolean;
    continuedPerformanceRequired?: boolean;
  };
}> = [
  {
    name: "mutual-employer",
    scenario: { kind: "MUTUAL_AGREEMENT", proposedBy: "employer" },
    expected: { reviewRequired: false }
  },
  {
    name: "mutual-employee-review",
    scenario: { kind: "MUTUAL_AGREEMENT", proposedBy: "employee" },
    expected: { reviewRequired: true }
  },
  {
    name: "article-40-notice",
    scenario: { kind: "ARTICLE_40", noticeMethod: "notice_30_days" }
  },
  {
    name: "article-40-payment-in-lieu",
    scenario: { kind: "ARTICLE_40", noticeMethod: "payment_in_lieu" }
  },
  {
    name: "article-38",
    scenario: { kind: "ARTICLE_38_EMPLOYEE_TERMINATION" }
  },
  {
    name: "statutory",
    scenario: { kind: "STATUTORY_COMPENSATION" }
  },
  {
    name: "article-39",
    scenario: { kind: "ARTICLE_39_NO_COMPENSATION" }
  },
  {
    name: "voluntary",
    scenario: { kind: "VOLUNTARY_RESIGNATION" }
  },
  {
    name: "unlawful-cash",
    scenario: {
      kind: "UNLAWFUL_TERMINATION",
      continuedPerformanceRequested: false,
      continuedPerformancePossible: true
    },
    expected: { continuedPerformanceRequired: false }
  },
  {
    name: "unlawful-continue",
    scenario: {
      kind: "UNLAWFUL_TERMINATION",
      continuedPerformanceRequested: true,
      continuedPerformancePossible: true
    },
    expected: { continuedPerformanceRequired: true }
  },
  {
    name: "unclear-fact-gaps",
    scenario: {
      kind: "UNCLEAR",
      factGaps: ["解除依据", "通知证据"]
    },
    expected: { reviewRequired: true }
  }
];

export const runPolicyRegression = (
  rules: EnginePolicyRules
): PolicyRegressionSummary => {
  const cases: PolicyRegressionSummary["cases"] = [];
  const run = (
    name: string,
    input: PolicyInput,
    expected?: {
      reviewRequired?: boolean;
      continuedPerformanceRequired?: boolean;
    }
  ) => {
    try {
      assertOutput(calculatePolicy(input, rules), expected);
      cases.push({ name, status: "passed" });
    } catch (error) {
      cases.push({
        name,
        status: "failed",
        error:
          error instanceof Error && error.name === "PolicyEngineError"
            ? error.message
            : "regression-invariant"
      });
    }
  };

  for (const item of scenarios) {
    run(
      item.name,
      baseInput({ terminationScenario: item.scenario }),
      item.expected
    );
  }
  run(
    "service-under-six-months",
    baseInput({ startDate: "2026-03-01" })
  );
  run(
    "service-at-least-six-months",
    baseInput({ startDate: "2026-01-01" })
  );
  run(
    "high-salary-cap",
    baseInput({
      startDate: "2000-01-01",
      monthlyEarnedWagesFen: Array(12).fill(4_000_000),
      employeeAverageMonthlyWageFen: 1_000_000
    })
  );

  const failed = cases.filter(
    (item) => item.status === "failed"
  ).length;
  return {
    total: cases.length,
    passed: cases.length - failed,
    failed,
    cases
  };
};
