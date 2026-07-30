import { spawnSync } from "node:child_process";
import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { calculatePolicy } from "../modules/policy/engine.js";
import { PolicyEngineError } from "../modules/policy/types.js";
import type {
  PolicyInput,
  PolicyEngineErrorCode,
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
  output.differenceRangeFen.low,
  output.differenceRangeFen.high,
  output.rangeFen.low,
  output.rangeFen.high
];

const expectPolicyEngineError = (
  callback: () => unknown,
  code: PolicyEngineErrorCode
) => {
  let thrown: unknown;
  try {
    callback();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(PolicyEngineError);
  expect((thrown as PolicyEngineError).name).toBe("PolicyEngineError");
  expect((thrown as PolicyEngineError).code).toBe(code);
  expect((thrown as PolicyEngineError).message).toBe(code);
};

const decimalConfig = () => ({
  precision: Decimal.precision,
  rounding: Decimal.rounding,
  toExpNeg: Decimal.toExpNeg,
  toExpPos: Decimal.toExpPos,
  maxE: Decimal.maxE,
  minE: Decimal.minE,
  modulo: Decimal.modulo,
  crypto: Decimal.crypto
});

describe("PolicyEngineError", () => {
  it("exposes a stable name and closed business error code", () => {
    const error = new PolicyEngineError("INVALID_POLICY_INPUT");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PolicyEngineError");
    expect(error.code).toBe("INVALID_POLICY_INPUT");
    expect(error.message).toBe("INVALID_POLICY_INPUT");
  });
});

describe("calculatePolicy runtime boundary", () => {
  it.each([
    ["null input", null, "INVALID_POLICY_INPUT"],
    ["array input", [], "INVALID_POLICY_INPUT"],
    ["empty object", {}, "INVALID_POLICY_INPUT"],
    [
      "non-six-digit region code",
      { ...baseInput(), regionCode: "abc" },
      "INVALID_REGION"
    ],
    [
      "empty region name",
      { ...baseInput(), regionName: "   " },
      "INVALID_REGION"
    ],
    [
      "non-string start date",
      { ...baseInput(), startDate: 20200101 },
      "INVALID_EMPLOYMENT_DATE"
    ],
    [
      "non-array wages",
      { ...baseInput(), monthlyEarnedWagesFen: "1500000" },
      "WAGE_MONTHS_OUT_OF_RANGE"
    ],
    [
      "null scenario",
      { ...baseInput(), terminationScenario: null },
      "INVALID_TERMINATION_SCENARIO"
    ],
    [
      "wrong unlawful scenario boolean",
      {
        ...baseInput(),
        terminationScenario: {
          kind: "UNLAWFUL_TERMINATION",
          continuedPerformanceRequested: "yes",
          continuedPerformancePossible: true
        }
      },
      "INVALID_TERMINATION_SCENARIO"
    ],
    [
      "null already paid",
      { ...baseInput(), alreadyPaidFen: null },
      "INVALID_ALREADY_PAID"
    ]
  ] as const)("rejects %s with a domain error", (_name, input, code) => {
    expectPolicyEngineError(
      () => calculatePolicy(input),
      code
    );
  });
});

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
    expectPolicyEngineError(
      () => calculatePolicy({ ...baseInput(), startDate, endDate }),
      error as PolicyEngineErrorCode
    );
  });
});

describe("calculatePolicy wage basis", () => {
  it("uses complete private defaults when Decimal is polluted before first import", () => {
    const parentConfigBefore = decimalConfig();
    const childScript = `
      import { Decimal } from "decimal.js";

      Decimal.set({
        precision: 1,
        rounding: Decimal.ROUND_DOWN,
        toExpNeg: 0,
        toExpPos: 0,
        maxE: 1,
        minE: -1,
        modulo: Decimal.EUCLID,
        crypto: true
      });

      const { calculatePolicy } = await import(
        "./server/modules/policy/engine.ts"
      );
      const input = {
        regionCode: "310000",
        regionName: "上海市",
        startDate: "2024-06-30",
        endDate: "2024-07-01",
        terminationScenario: {
          kind: "ARTICLE_40",
          noticeMethod: "notice_30_days"
        },
        monthlyEarnedWagesFen: [100, 101],
        minimumMonthlyWageFen: 1,
        employeeAverageMonthlyWageFen: 1_000
      };
      const importedAfterPollution = calculatePolicy(input);

      Decimal.set({
        precision: 2,
        rounding: Decimal.ROUND_UP,
        toExpNeg: -1,
        toExpPos: 1,
        maxE: 2,
        minE: -2,
        modulo: Decimal.ROUND_FLOOR,
        crypto: false
      });
      const pollutedAfterImport = calculatePolicy(input);

      console.log(JSON.stringify({
        importedAfterPollution,
        pollutedAfterImport
      }));
    `;
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", childScript],
      {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    );

    if (child.status !== 0) {
      throw new Error(
        `fresh Decimal import child failed (${child.status}): ${child.stderr}`
      );
    }
    const childResult = JSON.parse(child.stdout) as {
      importedAfterPollution: PolicyOutput;
      pollutedAfterImport: PolicyOutput;
    };
    expect(childResult.importedAfterPollution.rawAverageWageFen).toBe(101);
    expect(childResult.importedAfterPollution.baseCompensationFen).toBe(51);
    expect(childResult.pollutedAfterImport).toEqual(
      childResult.importedAfterPollution
    );
    expect(decimalConfig()).toEqual(parentConfigBefore);
  });

  it("is unaffected by external Decimal global precision and rounding", () => {
    const input = {
      ...baseInput(),
      startDate: "2024-06-30",
      endDate: "2024-07-01",
      monthlyEarnedWagesFen: [100, 101],
      minimumMonthlyWageFen: 1,
      employeeAverageMonthlyWageFen: 1_000
    };
    const expected = calculatePolicy(input);
    const priorDecimalConfig = {
      precision: Decimal.precision,
      rounding: Decimal.rounding
    };

    try {
      Decimal.set({ precision: 1, rounding: Decimal.ROUND_DOWN });
      expect(calculatePolicy(input)).toEqual(expected);
    } finally {
      Decimal.set(priorDecimalConfig);
    }
  });

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
    expectPolicyEngineError(
      () => calculatePolicy({ ...baseInput(), monthlyEarnedWagesFen }),
      error as PolicyEngineErrorCode
    );
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
    expectPolicyEngineError(
      () => calculatePolicy({ ...baseInput(), [key]: value }),
      "INVALID_REGIONAL_PARAMETER"
    );
  });

  it("rejects computed money outside the safe-integer range", () => {
    const largeSafeValue = Math.floor(Number.MAX_SAFE_INTEGER / 3);

    expectPolicyEngineError(
      () => calculatePolicy({
        ...baseInput(),
        startDate: "2000-01-01",
        monthlyEarnedWagesFen: [largeSafeValue],
        minimumMonthlyWageFen: 1,
        employeeAverageMonthlyWageFen: largeSafeValue
      }),
      "COMPUTATION_OVERFLOW"
    );
  });

  it("rejects an earned-wage total that overflows before averaging", () => {
    expectPolicyEngineError(
      () => calculatePolicy({
        ...baseInput(),
        monthlyEarnedWagesFen: [
          Number.MAX_SAFE_INTEGER,
          Number.MAX_SAFE_INTEGER
        ]
      }),
      "COMPUTATION_OVERFLOW"
    );
  });

  it("rejects negative zero in the earned-wage series", () => {
    expectPolicyEngineError(
      () => calculatePolicy({
        ...baseInput(),
        monthlyEarnedWagesFen: [-0],
        terminationScenario: {
          kind: "ARTICLE_40",
          noticeMethod: "payment_in_lieu"
        }
      }),
      "INVALID_WAGE_VALUE"
    );
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
      alreadyPaidFen: 500_000,
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
    expect(result.payableDetermined).toBe(false);
    expect(result.differenceRangeFen).toEqual({
      low: 0,
      high: 10_000_000
    });
    expect(result.reviewRequired).toBe(true);
    expect(
      result.formulaSteps.find((step) => step.key === "payment")
    ).toEqual({
      key: "payment",
      label: "待复核金额",
      value:
        "待复核金额区间 0–10500000 分；已支付 500000 分；剩余金额区间 0–10000000 分，待事实复核"
    });
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

  it("reports the paid-adjusted remaining range for an unclear scenario", () => {
    const result = calculatePolicy({
      ...baseInput(),
      alreadyPaidFen: 500_000,
      terminationScenario: { kind: "UNCLEAR" }
    });

    expect(result.payableDetermined).toBe(false);
    expect(result.rangeFen).toEqual({ low: 0, high: 21_000_000 });
    expect(result.differenceRangeFen).toEqual({
      low: 0,
      high: 20_500_000
    });
    expect(
      result.formulaSteps.find((step) => step.key === "payment")
    ).toEqual({
      key: "payment",
      label: "待复核金额",
      value:
        "待复核金额区间 0–21000000 分；已支付 500000 分；剩余金额区间 0–20500000 分，待事实复核"
    });
    const explanation = result.formulaSteps
      .map(({ label, value }) => `${label}：${value}`)
      .join("\n");
    expect(explanation).not.toContain("应付0");
    expect(explanation).not.toContain("剩余应付0");
  });

  it("uses a dedicated continued-performance explanation", () => {
    const result = calculatePolicy({
      ...baseInput(),
      terminationScenario: {
        kind: "UNLAWFUL_TERMINATION",
        continuedPerformanceRequested: true,
        continuedPerformancePossible: true
      }
    });

    expect(result.payableDetermined).toBe(true);
    expect(result.differenceRangeFen).toEqual({ low: 0, high: 0 });
    expect(
      result.formulaSteps.find((step) => step.key === "payment")
    ).toEqual({
      key: "payment",
      label: "继续履行优先",
      value: "继续履行劳动合同优先；当前现金金额为0分；已支付0分"
    });
    expect(
      result.formulaSteps.some((step) => step.value.includes("待事实复核"))
    ).toBe(false);
  });
});

describe("calculatePolicy payment reconciliation and explanations", () => {
  it.each([
    [-1],
    [1.5],
    [Number.MAX_SAFE_INTEGER + 1]
  ])("rejects invalid alreadyPaidFen=%s", (alreadyPaidFen) => {
    expectPolicyEngineError(
      () => calculatePolicy({ ...baseInput(), alreadyPaidFen }),
      "INVALID_ALREADY_PAID"
    );
  });

  it("rejects negative zero already paid", () => {
    expectPolicyEngineError(
      () => calculatePolicy({ ...baseInput(), alreadyPaidFen: -0 }),
      "INVALID_ALREADY_PAID"
    );
  });

  it("returns zero remaining payment when the paid amount exceeds payable", () => {
    const result = calculatePolicy({
      ...baseInput(),
      alreadyPaidFen: 20_000_000
    });

    expect(result.alreadyPaidFen).toBe(20_000_000);
    expect(result.differenceFen).toBe(0);
    expect(result.payableDetermined).toBe(true);
    expect(result.differenceRangeFen).toEqual({ low: 0, high: 0 });
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
