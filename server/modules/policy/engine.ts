import { Decimal } from "decimal.js";
import { z } from "zod";
import { PolicyEngineError } from "./types.js";
import type {
  EnginePolicyRules,
  EngineReviewTerminationRule,
  EngineTerminationRule,
  FormulaStep,
  PolicyEngineErrorCode,
  PolicyEngineErrorDetails,
  PolicyInput,
  PolicyOutput,
  TerminationScenario
} from "./types.js";

const PolicyDecimal = Decimal.clone({
  defaults: true,
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP
});

type CalendarDate = {
  year: number;
  month: number;
  day: number;
};

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MILLISECONDS_PER_DAY = 86_400_000;

function fail(
  code: PolicyEngineErrorCode,
  details?: PolicyEngineErrorDetails
): never {
  throw new PolicyEngineError(code, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

const terminationRuleSchema = z
  .object({
    compensationMultiplier: z.number().min(0).max(4),
    noticePayMonths: z.number().min(0).max(3)
  })
  .strict();

const reviewTerminationRuleSchema = z
  .object({
    compensationMultiplier: z.number().min(0).max(4),
    noticePayMonths: z.number().min(0).max(3),
    reviewRange: z
      .object({
        candidates: z.array(terminationRuleSchema).min(1).max(10)
      })
      .strict()
  })
  .strict();

const enginePolicyRulesSchema = z
  .object({
    schemaVersion: z.literal(1),
    serviceYearFraction: z
      .object({
        lessThanSixMonths: z.number().min(0).max(1),
        atLeastSixMonths: z.number().min(0).max(1)
      })
      .strict(),
    highSalaryCap: z
      .object({
        localAverageMultiplier: z.number().min(1).max(10),
        serviceYearCap: z.number().int().min(1).max(50)
      })
      .strict(),
    termination: z
      .object({
        mutualAgreementEmployer: terminationRuleSchema,
        mutualAgreementEmployee: reviewTerminationRuleSchema,
        article40Notice30Days: terminationRuleSchema,
        article40PaymentInLieu: terminationRuleSchema,
        article38EmployeeTermination: terminationRuleSchema,
        statutoryCompensation: terminationRuleSchema,
        article39NoCompensation: terminationRuleSchema,
        voluntaryResignation: terminationRuleSchema,
        unlawfulTermination: terminationRuleSchema,
        unclear: reviewTerminationRuleSchema
      })
      .strict()
  })
  .strict()
  .superRefine((rules, context) => {
    if (
      rules.serviceYearFraction.atLeastSixMonths <
      rules.serviceYearFraction.lessThanSixMonths
    ) {
      context.addIssue({
        code: "custom",
        path: ["serviceYearFraction", "atLeastSixMonths"],
        message:
          "atLeastSixMonths must be greater than or equal to lessThanSixMonths"
      });
    }
  });

export const DEFAULT_ENGINE_POLICY_RULES: EnginePolicyRules = {
  schemaVersion: 1,
  serviceYearFraction: {
    lessThanSixMonths: 0.5,
    atLeastSixMonths: 1
  },
  highSalaryCap: {
    localAverageMultiplier: 3,
    serviceYearCap: 12
  },
  termination: {
    mutualAgreementEmployer: {
      compensationMultiplier: 1,
      noticePayMonths: 0
    },
    mutualAgreementEmployee: {
      compensationMultiplier: 0,
      noticePayMonths: 0,
      reviewRange: {
        candidates: [
          { compensationMultiplier: 0, noticePayMonths: 0 },
          { compensationMultiplier: 1, noticePayMonths: 0 }
        ]
      }
    },
    article40Notice30Days: {
      compensationMultiplier: 1,
      noticePayMonths: 0
    },
    article40PaymentInLieu: {
      compensationMultiplier: 1,
      noticePayMonths: 1
    },
    article38EmployeeTermination: {
      compensationMultiplier: 1,
      noticePayMonths: 0
    },
    statutoryCompensation: {
      compensationMultiplier: 1,
      noticePayMonths: 0
    },
    article39NoCompensation: {
      compensationMultiplier: 0,
      noticePayMonths: 0
    },
    voluntaryResignation: {
      compensationMultiplier: 0,
      noticePayMonths: 0
    },
    unlawfulTermination: {
      compensationMultiplier: 2,
      noticePayMonths: 0
    },
    unclear: {
      compensationMultiplier: 0,
      noticePayMonths: 0,
      reviewRange: {
        candidates: [
          { compensationMultiplier: 0, noticePayMonths: 0 },
          { compensationMultiplier: 2, noticePayMonths: 0 },
          { compensationMultiplier: 1, noticePayMonths: 1 }
        ]
      }
    }
  }
};

const parseEnginePolicyRules = (value: unknown): EnginePolicyRules => {
  const parsed = enginePolicyRulesSchema.safeParse(value);
  if (!parsed.success) {
    fail("INVALID_POLICY_RULES", { field: "rules" });
  }
  return parsed.data;
};

const isLeapYear = (year: number) =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const daysInMonth = (year: number, month: number) => {
  const days = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ];
  return days[month - 1] ?? 0;
};

const parseDate = (value: string): CalendarDate => {
  const match = ISO_DATE.exec(value);
  if (!match) {
    fail("INVALID_EMPLOYMENT_DATE");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    fail("INVALID_EMPLOYMENT_DATE");
  }
  return { year, month, day };
};

const compareDates = (left: CalendarDate, right: CalendarDate) =>
  left.year - right.year ||
  left.month - right.month ||
  left.day - right.day;

const epochMilliseconds = ({ year, month, day }: CalendarDate) => {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getTime();
};

const addClampedMonths = (
  date: CalendarDate,
  months: number
): CalendarDate => {
  const absoluteMonth = date.year * 12 + date.month - 1 + months;
  const year = Math.floor(absoluteMonth / 12);
  const month = (absoluteMonth % 12) + 1;
  return {
    year,
    month,
    day: Math.min(date.day, daysInMonth(year, month))
  };
};

const serviceDuration = (start: string, end: string) => {
  const startDate = parseDate(start);
  const endDate = parseDate(end);
  if (compareDates(endDate, startDate) <= 0) {
    fail("END_DATE_MUST_FOLLOW_START_DATE");
  }

  let serviceMonths =
    (endDate.year - startDate.year) * 12 +
    endDate.month -
    startDate.month;
  let anniversary = addClampedMonths(startDate, serviceMonths);
  if (compareDates(anniversary, endDate) > 0) {
    serviceMonths -= 1;
    anniversary = addClampedMonths(startDate, serviceMonths);
  }
  const serviceRemainderDays =
    (epochMilliseconds(endDate) - epochMilliseconds(anniversary)) /
    MILLISECONDS_PER_DAY;

  return { serviceMonths, serviceRemainderDays };
};

function assertNonNegativeMoney(
  value: unknown,
  error: PolicyEngineErrorCode,
  details?: PolicyEngineErrorDetails
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    Object.is(value, -0)
  ) {
    fail(error, details);
  }
}

function assertPositiveMoney(
  value: unknown,
  details?: PolicyEngineErrorDetails
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    fail("INVALID_REGIONAL_PARAMETER", details);
  }
}

const safeMoney = (
  value: Decimal.Value,
  error: PolicyEngineErrorCode = "COMPUTATION_OVERFLOW"
) => {
  const number = new PolicyDecimal(value).toNumber();
  if (!Number.isSafeInteger(number) || number < 0) {
    fail(error);
  }
  return number === 0 ? 0 : number;
};

const addMoney = (...values: number[]) =>
  safeMoney(
    values.reduce(
      (total, value) => total.plus(value),
      new PolicyDecimal(0)
    )
  );

const multiplyMoney = (value: number, multiplier: Decimal.Value) =>
  safeMoney(
    new PolicyDecimal(value)
      .mul(multiplier)
      .toDecimalPlaces(0, PolicyDecimal.ROUND_HALF_UP)
  );

const averageFen = (values: number[]) => {
  if (!Array.isArray(values) || values.length < 1 || values.length > 12) {
    fail("WAGE_MONTHS_OUT_OF_RANGE", {
      field: "monthlyEarnedWagesFen"
    });
  }
  for (const value of values) {
    assertNonNegativeMoney(value, "INVALID_WAGE_VALUE");
  }
  const total = values.reduce(
    (sum, value) => sum.plus(value),
    new PolicyDecimal(0)
  );
  const safeTotal = safeMoney(total);
  return safeMoney(
    new PolicyDecimal(safeTotal)
      .div(values.length)
      .toDecimalPlaces(0, PolicyDecimal.ROUND_HALF_UP)
  );
};

const compensationYears = (
  serviceMonths: number,
  serviceRemainderDays: number,
  rules: EnginePolicyRules["serviceYearFraction"]
) => {
  const fullYears = Math.floor(serviceMonths / 12);
  const remainderMonths = serviceMonths % 12;
  if (remainderMonths >= 6) {
    return fullYears + rules.atLeastSixMonths;
  }
  if (remainderMonths > 0 || serviceRemainderDays > 0) {
    return fullYears + rules.lessThanSixMonths;
  }
  return fullYears;
};

const assertScenario = (
  scenario: unknown
): TerminationScenario => {
  if (!isRecord(scenario)) {
    fail("INVALID_TERMINATION_SCENARIO", {
      field: "terminationScenario"
    });
  }
  if (
    scenario.kind === "MUTUAL_AGREEMENT" &&
    (scenario.proposedBy === "employer" || scenario.proposedBy === "employee")
  ) {
    return {
      kind: "MUTUAL_AGREEMENT",
      proposedBy: scenario.proposedBy
    };
  }
  if (
    scenario.kind === "ARTICLE_40" &&
    (scenario.noticeMethod === "notice_30_days" ||
      scenario.noticeMethod === "payment_in_lieu")
  ) {
    return {
      kind: "ARTICLE_40",
      noticeMethod: scenario.noticeMethod
    };
  }
  if (
    scenario.kind === "ARTICLE_38_EMPLOYEE_TERMINATION" ||
    scenario.kind === "STATUTORY_COMPENSATION" ||
    scenario.kind === "ARTICLE_39_NO_COMPENSATION" ||
    scenario.kind === "VOLUNTARY_RESIGNATION"
  ) {
    return { kind: scenario.kind };
  }
  if (
    scenario.kind === "UNCLEAR" &&
    (scenario.factGaps === undefined ||
      (Array.isArray(scenario.factGaps) &&
        scenario.factGaps.length >= 1 &&
        scenario.factGaps.length <= 10 &&
        scenario.factGaps.every(
          (gap) =>
            typeof gap === "string" &&
            gap.trim().length >= 1 &&
            gap.trim().length <= 200
        )))
  ) {
    return {
      kind: "UNCLEAR",
      ...(scenario.factGaps
        ? { factGaps: scenario.factGaps.map((gap) => gap.trim()) }
        : {})
    };
  }
  if (
    scenario.kind === "UNLAWFUL_TERMINATION" &&
    typeof scenario.continuedPerformanceRequested === "boolean" &&
    typeof scenario.continuedPerformancePossible === "boolean"
  ) {
    return {
      kind: "UNLAWFUL_TERMINATION",
      continuedPerformanceRequested:
        scenario.continuedPerformanceRequested,
      continuedPerformancePossible:
        scenario.continuedPerformancePossible
    };
  }
  fail("INVALID_TERMINATION_SCENARIO", {
    field: "terminationScenario"
  });
};

const parsePolicyInput = (value: unknown): PolicyInput => {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    fail("INVALID_POLICY_INPUT", { field: "input" });
  }
  if (
    typeof value.regionCode !== "string" ||
    !/^\d{6}$/.test(value.regionCode) ||
    typeof value.regionName !== "string" ||
    !value.regionName.trim()
  ) {
    fail("INVALID_REGION", {
      field:
        typeof value.regionCode !== "string" ||
        !/^\d{6}$/.test(value.regionCode)
          ? "regionCode"
          : "regionName"
    });
  }
  if (
    typeof value.startDate !== "string" ||
    typeof value.endDate !== "string"
  ) {
    fail("INVALID_EMPLOYMENT_DATE", {
      field:
        typeof value.startDate !== "string" ? "startDate" : "endDate"
    });
  }

  const terminationScenario = assertScenario(value.terminationScenario);
  if (
    !Array.isArray(value.monthlyEarnedWagesFen) ||
    value.monthlyEarnedWagesFen.length < 1 ||
    value.monthlyEarnedWagesFen.length > 12
  ) {
    fail("WAGE_MONTHS_OUT_OF_RANGE", {
      field: "monthlyEarnedWagesFen"
    });
  }
  const monthlyEarnedWagesFen = value.monthlyEarnedWagesFen.map(
    (wage) => {
      assertNonNegativeMoney(wage, "INVALID_WAGE_VALUE", {
        field: "monthlyEarnedWagesFen"
      });
      return wage;
    }
  );
  if (
    !isRecord(value.wageDataConfirmation) ||
    value.wageDataConfirmation.confirmed !== true ||
    value.wageDataConfirmation.basis !==
      "pretax_earned_including_bonus_allowance"
  ) {
    fail("INVALID_WAGE_CONFIRMATION", {
      field: "wageDataConfirmation"
    });
  }

  assertPositiveMoney(value.minimumMonthlyWageFen, {
    field: "minimumMonthlyWageFen"
  });
  assertPositiveMoney(value.employeeAverageMonthlyWageFen, {
    field: "employeeAverageMonthlyWageFen"
  });

  let alreadyPaidFen: number | undefined;
  if (value.alreadyPaidFen !== undefined) {
    assertNonNegativeMoney(
      value.alreadyPaidFen,
      "INVALID_ALREADY_PAID",
      { field: "alreadyPaidFen" }
    );
    alreadyPaidFen = value.alreadyPaidFen;
  }

  return {
    regionCode: value.regionCode,
    regionName: value.regionName,
    startDate: value.startDate,
    endDate: value.endDate,
    terminationScenario,
    monthlyEarnedWagesFen,
    wageDataConfirmation: {
      confirmed: true,
      basis: "pretax_earned_including_bonus_allowance"
    },
    minimumMonthlyWageFen: value.minimumMonthlyWageFen,
    employeeAverageMonthlyWageFen:
      value.employeeAverageMonthlyWageFen,
    alreadyPaidFen
  };
};

const evaluateTerminationRule = (
  rule: EngineTerminationRule,
  baseCompensationFen: number,
  noticePayBasisFen: number
) => {
  const compensationFen = multiplyMoney(
    baseCompensationFen,
    rule.compensationMultiplier
  );
  const noticePayFen = multiplyMoney(
    noticePayBasisFen,
    rule.noticePayMonths
  );
  return {
    noticePayFen,
    payableFen: addMoney(compensationFen, noticePayFen)
  };
};

const evaluateReviewRange = (
  rule: EngineReviewTerminationRule,
  baseCompensationFen: number,
  noticePayBasisFen: number
) => {
  const candidates = rule.reviewRange.candidates.map(
    (candidate) =>
      evaluateTerminationRule(
        candidate,
        baseCompensationFen,
        noticePayBasisFen
      ).payableFen
  );
  return {
    low: Math.min(...candidates),
    high: Math.max(...candidates)
  };
};

const describeScenario = (
  scenario: TerminationScenario,
  continuedPerformanceRequired: boolean,
  appliedRule: EngineTerminationRule
) => {
  const defaultRule: EngineTerminationRule = (() => {
    switch (scenario.kind) {
      case "MUTUAL_AGREEMENT":
        return {
          compensationMultiplier:
            scenario.proposedBy === "employer" ? 1 : 0,
          noticePayMonths: 0
        };
      case "ARTICLE_40":
        return {
          compensationMultiplier: 1,
          noticePayMonths:
            scenario.noticeMethod === "payment_in_lieu" ? 1 : 0
        };
      case "ARTICLE_38_EMPLOYEE_TERMINATION":
      case "STATUTORY_COMPENSATION":
        return { compensationMultiplier: 1, noticePayMonths: 0 };
      case "UNLAWFUL_TERMINATION":
        return { compensationMultiplier: 2, noticePayMonths: 0 };
      case "ARTICLE_39_NO_COMPENSATION":
      case "VOLUNTARY_RESIGNATION":
      case "UNCLEAR":
        return { compensationMultiplier: 0, noticePayMonths: 0 };
    }
  })();
  const usesDefaultRule =
    appliedRule.compensationMultiplier ===
      defaultRule.compensationMultiplier &&
    appliedRule.noticePayMonths === defaultRule.noticePayMonths;

  const defaultDescription = (() => {
    switch (scenario.kind) {
      case "MUTUAL_AGREEMENT":
        return scenario.proposedBy === "employer"
          ? "用人单位提出协商解除，按N计算经济补偿"
          : "劳动者提出协商解除，法定经济补偿需结合协议及事实复核，以待复核区间展示";
      case "ARTICLE_40":
        return scenario.noticeMethod === "notice_30_days"
          ? "用人单位依据第四十条解除并已提前三十日书面通知"
          : "用人单位依据第四十条解除并选择支付代通知金";
      case "ARTICLE_38_EMPLOYEE_TERMINATION":
        return "劳动者依据第三十八条解除，按N计算经济补偿";
      case "STATUTORY_COMPENSATION":
        return "劳动合同依法解除或终止，按N计算法定经济补偿";
      case "ARTICLE_39_NO_COMPENSATION":
        return "用人单位依据第三十九条过失性解除，法定经济补偿为0分";
      case "VOLUNTARY_RESIGNATION":
        return "劳动者自愿辞职，法定经济补偿按0分计算";
      case "UNLAWFUL_TERMINATION":
        return continuedPerformanceRequired
          ? "违法解除，继续履行劳动合同优先"
          : "违法解除，按二倍经济补偿计算赔偿金";
      case "UNCLEAR":
        return "解除情形尚不明确，现金结果按支持情形的保守范围展示并需复核";
    }
  })();
  if (usesDefaultRule || continuedPerformanceRequired) {
    return defaultDescription;
  }

  const ruleBasis = (() => {
    switch (scenario.kind) {
      case "MUTUAL_AGREEMENT":
        return scenario.proposedBy === "employer"
          ? "用人单位提出协商解除"
          : "劳动者提出协商解除";
      case "ARTICLE_40":
        return "用人单位依据第四十条解除";
      case "ARTICLE_38_EMPLOYEE_TERMINATION":
        return "劳动者依据第三十八条解除";
      case "STATUTORY_COMPENSATION":
        return "劳动合同依法解除或终止";
      case "ARTICLE_39_NO_COMPENSATION":
        return "用人单位依据第三十九条过失性解除";
      case "VOLUNTARY_RESIGNATION":
        return "劳动者自愿辞职";
      case "UNLAWFUL_TERMINATION":
        return "违法解除";
      case "UNCLEAR":
        return "解除情形尚不明确";
    }
  })();
  return (
    `${ruleBasis}；当前有效规则配置为` +
    `${appliedRule.compensationMultiplier}N经济补偿和` +
    `${appliedRule.noticePayMonths}个月代通知金`
  );
};

const noticePayExplanation = (
  scenario: TerminationScenario,
  noticePayBasisFen: number,
  noticePayFen: number,
  noticePayMonths: number
) => {
  if (noticePayMonths > 0) {
    if (
      scenario.kind === "ARTICLE_40" &&
      scenario.noticeMethod === "payment_in_lieu" &&
      noticePayMonths === 1
    ) {
      return `按解除前一个完整工资月${noticePayBasisFen}分计算，代通知金为${noticePayFen}分`;
    }
    return (
      `按有效规则配置的${noticePayMonths}个月×` +
      `解除前一个完整工资月${noticePayBasisFen}分计算，` +
      `代通知金为${noticePayFen}分`
    );
  }
  if (scenario.kind !== "ARTICLE_40") {
    return `当前情形不适用代通知金，金额为${noticePayFen}分`;
  }
  if (scenario.noticeMethod === "notice_30_days") {
    return "已提前三十日书面通知，代通知金为0分";
  }
  return "当前有效规则未配置代通知金，金额为0分";
};

export const calculatePolicy = (
  value: unknown,
  rulesValue: unknown = DEFAULT_ENGINE_POLICY_RULES
): PolicyOutput => {
  const input = parsePolicyInput(value);
  const rules = parseEnginePolicyRules(rulesValue);
  const scenario = input.terminationScenario;
  const { serviceMonths, serviceRemainderDays } = serviceDuration(
    input.startDate,
    input.endDate
  );
  const alreadyPaidFen = input.alreadyPaidFen ?? 0;

  const rawAverageWageFen = averageFen(input.monthlyEarnedWagesFen);
  const noticePayBasisFen =
    input.monthlyEarnedWagesFen[input.monthlyEarnedWagesFen.length - 1]!;
  const minimumAdjusted =
    rawAverageWageFen < input.minimumMonthlyWageFen
      ? input.minimumMonthlyWageFen
      : rawAverageWageFen;
  const highSalaryCapFen = multiplyMoney(
    input.employeeAverageMonthlyWageFen,
    rules.highSalaryCap.localAverageMultiplier
  );
  const salaryCapped = rawAverageWageFen > highSalaryCapFen;
  const salaryBasisFen = salaryCapped
    ? highSalaryCapFen
    : minimumAdjusted;
  const uncappedCompensationMonths = compensationYears(
    serviceMonths,
    serviceRemainderDays,
    rules.serviceYearFraction
  );
  const compensationMonths = salaryCapped
    ? Math.min(
        rules.highSalaryCap.serviceYearCap,
        uncappedCompensationMonths
      )
    : uncappedCompensationMonths;
  const baseCompensationFen = multiplyMoney(
    salaryBasisFen,
    compensationMonths
  );

  let noticePayFen = 0;
  let payableFen = 0;
  let reviewRequired = false;
  let continuedPerformanceRequired = false;
  let rangeFen = { low: 0, high: 0 };
  let appliedRule: EngineTerminationRule = {
    compensationMultiplier: 0,
    noticePayMonths: 0
  };

  const applyRule = (rule: EngineTerminationRule) => {
    appliedRule = rule;
    const result = evaluateTerminationRule(
      rule,
      baseCompensationFen,
      noticePayBasisFen
    );
    noticePayFen = result.noticePayFen;
    payableFen = result.payableFen;
    rangeFen = { low: payableFen, high: payableFen };
  };
  const applyReviewRule = (rule: EngineReviewTerminationRule) => {
    applyRule(rule);
    reviewRequired = true;
    rangeFen = evaluateReviewRange(
      rule,
      baseCompensationFen,
      noticePayBasisFen
    );
  };

  switch (scenario.kind) {
    case "MUTUAL_AGREEMENT":
      if (scenario.proposedBy === "employer") {
        applyRule(rules.termination.mutualAgreementEmployer);
      } else {
        applyReviewRule(
          rules.termination.mutualAgreementEmployee
        );
      }
      break;
    case "ARTICLE_40":
      applyRule(
        scenario.noticeMethod === "payment_in_lieu"
          ? rules.termination.article40PaymentInLieu
          : rules.termination.article40Notice30Days
      );
      break;
    case "ARTICLE_38_EMPLOYEE_TERMINATION":
      applyRule(
        rules.termination.article38EmployeeTermination
      );
      break;
    case "STATUTORY_COMPENSATION":
      applyRule(rules.termination.statutoryCompensation);
      break;
    case "ARTICLE_39_NO_COMPENSATION":
      applyRule(rules.termination.article39NoCompensation);
      break;
    case "VOLUNTARY_RESIGNATION":
      applyRule(rules.termination.voluntaryResignation);
      break;
    case "UNLAWFUL_TERMINATION":
      continuedPerformanceRequired =
        scenario.continuedPerformanceRequested &&
        scenario.continuedPerformancePossible;
      if (!continuedPerformanceRequired) {
        applyRule(rules.termination.unlawfulTermination);
      }
      break;
    case "UNCLEAR":
      applyReviewRule(rules.termination.unclear);
      break;
  }

  const remainingAfterPaid = (amountFen: number) =>
    amountFen > alreadyPaidFen
      ? safeMoney(
          new PolicyDecimal(amountFen).minus(alreadyPaidFen)
        )
      : 0;
  const payableDetermined = !reviewRequired;
  const differenceFen = remainingAfterPaid(payableFen);
  const differenceRangeFen = {
    low: remainingAfterPaid(rangeFen.low),
    high: remainingAfterPaid(rangeFen.high)
  };
  const formulaSteps: FormulaStep[] = [
    {
      key: "service",
      label: "补偿工龄",
      value: `[入职日,解除日)共${serviceMonths}个完整月、余${serviceRemainderDays}日，折算${compensationMonths}个月工资`
    },
    {
      key: "wage-confirmation",
      label: "工资口径确认",
      value:
        "用户已逐月确认：税前应发工资，包含奖金、津贴和补贴；工作不满12个月时按实际月数"
    },
    {
      key: "average",
      label: "解除前平均工资",
      value: `${input.monthlyEarnedWagesFen.length}个月应得工资按时间从早到晚求平均并四舍五入，为${rawAverageWageFen}分`
    },
    {
      key: "minimum",
      label: "最低工资调整",
      value:
        rawAverageWageFen < input.minimumMonthlyWageFen
          ? `平均工资低于当地最低工资，基数提高到${input.minimumMonthlyWageFen}分`
          : `平均工资未低于当地最低工资${input.minimumMonthlyWageFen}分`
    },
    {
      key: "cap",
      label:
        "当地职工月平均工资" +
        (rules.highSalaryCap.localAverageMultiplier === 3
          ? "三"
          : rules.highSalaryCap.localAverageMultiplier) +
        "倍上限",
      value: salaryCapped
        ? `触发${highSalaryCapFen}分上限，工资基数为${salaryBasisFen}分且计发年限最多${rules.highSalaryCap.serviceYearCap}年`
        : `未触发${highSalaryCapFen}分上限，工资基数为${salaryBasisFen}分`
    },
    {
      key: "base",
      label: "经济补偿N",
      value: `${salaryBasisFen}分×${compensationMonths}=${baseCompensationFen}分`
    },
    {
      key: "scenario",
      label: "解除情形",
      value: describeScenario(
        scenario,
        continuedPerformanceRequired,
        appliedRule
      )
    },
    {
      key: "notice",
      label: "代通知金",
      value: noticePayExplanation(
        scenario,
        noticePayBasisFen,
        noticePayFen,
        appliedRule.noticePayMonths
      )
    }
  ];
  if (reviewRequired) {
    if (scenario.kind === "UNCLEAR" && scenario.factGaps?.length) {
      formulaSteps.push({
        key: "fact-gaps",
        label: "待核验事实",
        value: scenario.factGaps
          .map((gap, index) => `${index + 1}. ${gap}`)
          .join("；")
      });
    }
    formulaSteps.push({
      key: "payment",
      label: "待复核金额",
      value:
        `待复核金额区间 ${rangeFen.low}–${rangeFen.high} 分；` +
        `已支付 ${alreadyPaidFen} 分；` +
        `剩余金额区间 ${differenceRangeFen.low}–${differenceRangeFen.high} 分，待事实复核`
    });
  } else if (continuedPerformanceRequired) {
    formulaSteps.push({
      key: "payment",
      label: "继续履行优先",
      value:
        "继续履行劳动合同优先；" +
        `当前现金金额为${payableFen}分；已支付${alreadyPaidFen}分`
    });
  } else {
    formulaSteps.push({
      key: "payment",
      label: "已支付与剩余应付",
      value: `应付${payableFen}分，已支付${alreadyPaidFen}分，剩余应付${differenceFen}分`
    });
  }

  return {
    serviceMonths,
    serviceRemainderDays,
    compensationMonths,
    rawAverageWageFen,
    salaryBasisFen,
    salaryCapped,
    baseCompensationFen,
    noticePayBasisFen,
    noticePayFen,
    payableDetermined,
    payableFen,
    alreadyPaidFen,
    differenceFen,
    differenceRangeFen,
    rangeFen,
    reviewRequired,
    continuedPerformanceRequired,
    formulaSteps
  };
};
