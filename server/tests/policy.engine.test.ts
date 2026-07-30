import { describe, expect, it } from "vitest";
import { calculatePolicy } from "../modules/policy/engine.js";
import type {
  PolicyInput,
  PolicyOutput,
  TerminationScenario
} from "../modules/policy/types.js";

const baseInput = (): PolicyInput => ({
  regionCode: "310100",
  regionName: "上海市",
  startDate: "2020-01-01",
  endDate: "2026-07-01",
  terminationScenario: {
    kind: "ARTICLE_40",
    noticeMethod: "notice_30_days"
  },
  monthlyEarnedWagesFen: Array(12).fill(1_500_000),
  minimumMonthlyWageFen: 269_000,
  employeeAverageMonthlyWageFen: 1_250_000
});

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
};

const monetaryValues = (output: PolicyOutput) => [
  output.rawAverageWageFen,
  output.salaryBasisFen,
  output.baseCompensationFen,
  output.noticePayBasisFen,
  output.noticePayFen,
  output.payableFen,
  output.alreadyPaidFen,
  output.differenceFen,
  output.rangeFen.low,
  output.rangeFen.high
];

describe("calculatePolicy service time", () => {
  it("counts 6 years and 6 complete months as 7 compensation months", () => {
    const result = calculatePolicy(baseInput());

    expect(result.serviceMonths).toBe(78);
    expect(result.serviceRemainderDays).toBe(0);
    expect(result.compensationMonths).toBe(7);
    expect(result.payableFen).toBe(10_500_000);
  });

  it("counts a remainder under 6 months as half a compensation month", () => {
    const result = calculatePolicy({
      ...baseInput(),
      startDate: "2026-03-01"
    });

    expect(result.serviceMonths).toBe(4);
    expect(result.compensationMonths).toBe(0.5);
    expect(result.payableFen).toBe(750_000);
  });

  it("counts exactly 6 months as one compensation month", () => {
    const result = calculatePolicy({
      ...baseInput(),
      startDate: "2026-01-01"
    });

    expect(result.serviceMonths).toBe(6);
    expect(result.compensationMonths).toBe(1);
  });

  it("counts any positive service day as half a compensation month", () => {
    const result = calculatePolicy({
      ...baseInput(),
      startDate: "2024-06-30",
      endDate: "2024-07-01"
    });

    expect(result.serviceMonths).toBe(0);
    expect(result.serviceRemainderDays).toBe(1);
    expect(result.compensationMonths).toBe(0.5);
    expect(result.baseCompensationFen).toBe(750_000);
  });

  it.each([
    ["2024-01-31", "2024-02-29", 1, 0],
    ["2023-01-31", "2023-02-28", 1, 0],
    ["2024-01-31", "2024-02-28", 0, 28],
    ["2024-02-29", "2024-03-29", 1, 0]
  ])(
    "handles month-end and leap-year anniversary %s to %s",
    (startDate, endDate, serviceMonths, serviceRemainderDays) => {
      const result = calculatePolicy({
        ...baseInput(),
        startDate,
        endDate
      });

      expect(result.serviceMonths).toBe(serviceMonths);
      expect(result.serviceRemainderDays).toBe(serviceRemainderDays);
      expect(result.compensationMonths).toBe(0.5);
    }
  );

  it("counts post-anniversary days in the next partial service period", () => {
    const result = calculatePolicy({
      ...baseInput(),
      startDate: "2020-01-01",
      endDate: "2026-01-02"
    });

    expect(result.serviceMonths).toBe(72);
    expect(result.serviceRemainderDays).toBe(1);
    expect(result.compensationMonths).toBe(6.5);
  });

  it.each([
    ["2026-07-01", "2026-07-01", "END_DATE_MUST_FOLLOW_START_DATE"],
    ["2026-07-02", "2026-07-01", "END_DATE_MUST_FOLLOW_START_DATE"],
    ["2026-02-29", "2026-07-01", "INVALID_EMPLOYMENT_DATE"],
    ["2024-02-30", "2026-07-01", "INVALID_EMPLOYMENT_DATE"],
    ["2024-2-01", "2026-07-01", "INVALID_EMPLOYMENT_DATE"],
    ["not-a-date", "2026-07-01", "INVALID_EMPLOYMENT_DATE"]
  ])("rejects invalid employment dates %s to %s", (startDate, endDate, error) => {
    expect(() =>
      calculatePolicy({ ...baseInput(), startDate, endDate })
    ).toThrow(error);
  });
});

describe("calculatePolicy wage basis", () => {
  it("uses 1 to 12 earned-wage months and rounds the Decimal average half-up", () => {
    const result = calculatePolicy({
      ...baseInput(),
      startDate: "2024-06-30",
      endDate: "2024-07-01",
      monthlyEarnedWagesFen: [100, 101],
      minimumMonthlyWageFen: 1,
      employeeAverageMonthlyWageFen: 1_000
    });

    expect(result.rawAverageWageFen).toBe(101);
    expect(result.salaryBasisFen).toBe(101);
    expect(result.baseCompensationFen).toBe(51);
  });

  it("raises a below-minimum average to the local minimum wage", () => {
    const result = calculatePolicy({
      ...baseInput(),
      monthlyEarnedWagesFen: [200_000, 250_000]
    });

    expect(result.rawAverageWageFen).toBe(225_000);
    expect(result.salaryBasisFen).toBe(269_000);
    expect(result.salaryCapped).toBe(false);
  });

  it("applies the three-times wage cap and 12-year service cap together", () => {
    const result = calculatePolicy({
      ...baseInput(),
      startDate: "2008-01-01",
      monthlyEarnedWagesFen: Array(12).fill(5_000_000)
    });

    expect(result.salaryCapped).toBe(true);
    expect(result.compensationMonths).toBe(12);
    expect(result.salaryBasisFen).toBe(3_750_000);
    expect(result.payableFen).toBe(45_000_000);
  });

  it("does not mark or year-cap a salary exactly at the three-times boundary", () => {
    const result = calculatePolicy({
      ...baseInput(),
      startDate: "2008-01-01",
      monthlyEarnedWagesFen: Array(12).fill(3_750_000)
    });

    expect(result.salaryCapped).toBe(false);
    expect(result.compensationMonths).toBe(19);
    expect(result.salaryBasisFen).toBe(3_750_000);
  });

  it.each([
    [[], "WAGE_MONTHS_OUT_OF_RANGE"],
    [Array(13).fill(1), "WAGE_MONTHS_OUT_OF_RANGE"],
    [[-1], "INVALID_WAGE_VALUE"],
    [[1.5], "INVALID_WAGE_VALUE"],
    [[Number.MAX_SAFE_INTEGER + 1], "INVALID_WAGE_VALUE"]
  ])("rejects an invalid earned-wage series %#", (monthlyEarnedWagesFen, error) => {
    expect(() =>
      calculatePolicy({ ...baseInput(), monthlyEarnedWagesFen })
    ).toThrow(error);
  });

  it.each([
    ["minimumMonthlyWageFen", 0],
    ["minimumMonthlyWageFen", -1],
    ["minimumMonthlyWageFen", 1.5],
    ["minimumMonthlyWageFen", Number.MAX_SAFE_INTEGER + 1],
    ["employeeAverageMonthlyWageFen", 0],
    ["employeeAverageMonthlyWageFen", -1],
    ["employeeAverageMonthlyWageFen", 1.5],
    ["employeeAverageMonthlyWageFen", Number.MAX_SAFE_INTEGER + 1]
  ] as const)("rejects invalid positive regional parameter %s=%s", (key, value) => {
    expect(() => calculatePolicy({ ...baseInput(), [key]: value })).toThrow(
      "INVALID_REGIONAL_PARAMETER"
    );
  });

  it("rejects computed money outside the safe-integer range", () => {
    const largeSafeValue = Math.floor(Number.MAX_SAFE_INTEGER / 3);

    expect(() =>
      calculatePolicy({
        ...baseInput(),
        startDate: "2000-01-01",
        monthlyEarnedWagesFen: [largeSafeValue],
        minimumMonthlyWageFen: 1,
        employeeAverageMonthlyWageFen: largeSafeValue
      })
    ).toThrow("COMPUTATION_OVERFLOW");
  });
});

describe("calculatePolicy legal scenario matrix", () => {
  const scenarios: Array<{
    name: string;
    scenario: TerminationScenario;
    payableMultiplier: number;
    reviewRequired: boolean;
    continuedPerformanceRequired: boolean;
    scenarioText: string;
  }> = [
    {
      name: "employer-proposed mutual agreement",
      scenario: { kind: "MUTUAL_AGREEMENT", proposedBy: "employer" },
      payableMultiplier: 1,
      reviewRequired: false,
      continuedPerformanceRequired: false,
      scenarioText: "用人单位提出协商解除"
    },
    {
      name: "employee-proposed mutual agreement",
      scenario: { kind: "MUTUAL_AGREEMENT", proposedBy: "employee" },
      payableMultiplier: 0,
      reviewRequired: true,
      continuedPerformanceRequired: false,
      scenarioText: "劳动者提出协商解除"
    },
    {
      name: "article 38 employee termination",
      scenario: { kind: "ARTICLE_38_EMPLOYEE_TERMINATION" },
      payableMultiplier: 1,
      reviewRequired: false,
      continuedPerformanceRequired: false,
      scenarioText: "劳动者依据第三十八条解除"
    },
    {
      name: "voluntary resignation",
      scenario: { kind: "VOLUNTARY_RESIGNATION" },
      payableMultiplier: 0,
      reviewRequired: false,
      continuedPerformanceRequired: false,
      scenarioText: "劳动者自愿辞职"
    },
    {
      name: "unlawful termination with continued performance",
      scenario: {
        kind: "UNLAWFUL_TERMINATION",
        continuedPerformanceRequested: true,
        continuedPerformancePossible: true
      },
      payableMultiplier: 0,
      reviewRequired: false,
      continuedPerformanceRequired: true,
      scenarioText: "违法解除，继续履行劳动合同优先"
    },
    {
      name: "unlawful termination without a continuation request",
      scenario: {
        kind: "UNLAWFUL_TERMINATION",
        continuedPerformanceRequested: false,
        continuedPerformancePossible: true
      },
      payableMultiplier: 2,
      reviewRequired: false,
      continuedPerformanceRequired: false,
      scenarioText: "违法解除，按二倍经济补偿计算赔偿金"
    },
    {
      name: "unlawful termination when continuation is impossible",
      scenario: {
        kind: "UNLAWFUL_TERMINATION",
        continuedPerformanceRequested: true,
        continuedPerformancePossible: false
      },
      payableMultiplier: 2,
      reviewRequired: false,
      continuedPerformanceRequired: false,
      scenarioText: "违法解除，按二倍经济补偿计算赔偿金"
    }
  ];

  it.each(scenarios)(
    "applies $name",
    ({
      scenario,
      payableMultiplier,
      reviewRequired,
      continuedPerformanceRequired,
      scenarioText
    }) => {
      const result = calculatePolicy({
        ...baseInput(),
        terminationScenario: scenario
      });

      expect(result.payableFen).toBe(
        result.baseCompensationFen * payableMultiplier
      );
      expect(result.reviewRequired).toBe(reviewRequired);
      expect(result.continuedPerformanceRequired).toBe(
        continuedPerformanceRequired
      );
      expect(
        result.formulaSteps.find((step) => step.key === "scenario")?.value
      ).toContain(scenarioText);
    }
  );

  it("gives employee-proposed mutual agreement a conservative review range", () => {
    const result = calculatePolicy({
      ...baseInput(),
      terminationScenario: {
        kind: "MUTUAL_AGREEMENT",
        proposedBy: "employee"
      }
    });

    expect(result.payableFen).toBe(0);
    expect(result.rangeFen).toEqual({
      low: 0,
      high: result.baseCompensationFen
    });
    expect(result.reviewRequired).toBe(true);
  });

  it("does not add notice pay after 30 days' written notice", () => {
    const result = calculatePolicy(baseInput());

    expect(result.noticePayBasisFen).toBe(1_500_000);
    expect(result.noticePayFen).toBe(0);
    expect(result.payableFen).toBe(10_500_000);
  });

  it("uses the final chronological wage month for Article 40 payment in lieu", () => {
    const result = calculatePolicy({
      ...baseInput(),
      monthlyEarnedWagesFen: [1_000_000, 2_000_000],
      terminationScenario: {
        kind: "ARTICLE_40",
        noticeMethod: "payment_in_lieu"
      }
    });

    expect(result.rawAverageWageFen).toBe(1_500_000);
    expect(result.salaryBasisFen).toBe(1_500_000);
    expect(result.noticePayBasisFen).toBe(2_000_000);
    expect(result.noticePayFen).toBe(2_000_000);
    expect(result.payableFen).toBe(12_500_000);
  });

  it("does not apply the compensation wage cap to Article 40 notice pay", () => {
    const result = calculatePolicy({
      ...baseInput(),
      startDate: "2026-06-30",
      monthlyEarnedWagesFen: [1_000_000, 9_000_000],
      terminationScenario: {
        kind: "ARTICLE_40",
        noticeMethod: "payment_in_lieu"
      }
    });

    expect(result.salaryBasisFen).toBe(3_750_000);
    expect(result.baseCompensationFen).toBe(1_875_000);
    expect(result.noticePayFen).toBe(9_000_000);
    expect(result.payableFen).toBe(10_875_000);
  });

  it("covers both 2N and N plus prior-month wage in an unclear-case range", () => {
    const result = calculatePolicy({
      ...baseInput(),
      startDate: "2026-06-30",
      monthlyEarnedWagesFen: [1, 999],
      minimumMonthlyWageFen: 1,
      employeeAverageMonthlyWageFen: 10_000,
      terminationScenario: { kind: "UNCLEAR" }
    });

    expect(result.baseCompensationFen).toBe(250);
    expect(result.rangeFen).toEqual({ low: 0, high: 1_249 });
    expect(result.reviewRequired).toBe(true);
  });
});

describe("calculatePolicy payment reconciliation and explanations", () => {
  it.each([
    [-1],
    [1.5],
    [Number.MAX_SAFE_INTEGER + 1]
  ])("rejects invalid alreadyPaidFen=%s", (alreadyPaidFen) => {
    expect(() =>
      calculatePolicy({ ...baseInput(), alreadyPaidFen })
    ).toThrow("INVALID_ALREADY_PAID");
  });

  it("returns zero remaining payment when the paid amount exceeds payable", () => {
    const result = calculatePolicy({
      ...baseInput(),
      alreadyPaidFen: 20_000_000
    });

    expect(result.alreadyPaidFen).toBe(20_000_000);
    expect(result.differenceFen).toBe(0);
  });

  it("returns Chinese formula steps for every required decision", () => {
    const result = calculatePolicy({
      ...baseInput(),
      alreadyPaidFen: 500_000
    });
    const explanation = result.formulaSteps
      .map(({ label, value }) => `${label}：${value}`)
      .join("\n");

    expect(explanation).toContain("工龄");
    expect(explanation).toContain("平均工资");
    expect(explanation).toContain("最低工资");
    expect(explanation).toContain("三倍上限");
    expect(explanation).toContain("三十日书面通知");
    expect(explanation).toContain("代通知金");
    expect(explanation).toContain("已支付");
    expect(explanation).toContain("剩余应付");
    expect(explanation).not.toContain("ARTICLE_40");
  });

  it("does not mutate a deeply frozen input and is deterministic over 100 calls", () => {
    const input = deepFreeze({
      ...baseInput(),
      monthlyEarnedWagesFen: [
        1_100_001,
        1_200_002,
        1_300_003,
        1_400_004
      ],
      terminationScenario: {
        kind: "ARTICLE_40" as const,
        noticeMethod: "payment_in_lieu" as const
      }
    });

    const first = calculatePolicy(input);
    for (let index = 0; index < 100; index += 1) {
      expect(calculatePolicy(input)).toEqual(first);
    }
  });

  it("returns safe integer fen values without NaN, Infinity or negative zero", () => {
    const result = calculatePolicy({
      ...baseInput(),
      alreadyPaidFen: 20_000_000,
      terminationScenario: {
        kind: "ARTICLE_40",
        noticeMethod: "payment_in_lieu"
      }
    });

    for (const value of monetaryValues(result)) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(Number.isFinite(value)).toBe(true);
      expect(Object.is(value, -0)).toBe(false);
    }
  });
});
