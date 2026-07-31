import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE_POLICY_RULES } from "../modules/policy/engine.js";
import {
  DEFAULT_POLICY_REGRESSION_EXPECTATIONS,
  policyRegressionExpectationsSchema,
  runPolicyRegression
} from "../modules/policy/regression.js";

describe("semantic policy regression contract", () => {
  it("defines one strict versioned expectation for every fixed case", () => {
    const parsed = policyRegressionExpectationsSchema.parse(
      DEFAULT_POLICY_REGRESSION_EXPECTATIONS
    );
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.cases).toHaveLength(14);
    expect(new Set(parsed.cases.map((item) => item.id)).size).toBe(14);
    for (const item of parsed.cases) {
      expect(item).toMatchObject({
        scenario: expect.any(String),
        path: expect.any(String),
        compensationMonths: expect.any(Number),
        baseCompensationFen: expect.any(Number),
        noticePayFen: expect.any(Number),
        payableDetermined: expect.any(Boolean),
        payableFen: expect.any(Number),
        rangeFen: {
          low: expect.any(Number),
          high: expect.any(Number)
        },
        differenceRangeFen: {
          low: expect.any(Number),
          high: expect.any(Number)
        },
        reviewRequired: expect.any(Boolean),
        continuedPerformanceRequired: expect.any(Boolean),
        formula: {
          scenarioSemantics: expect.any(String),
          baseSemantics: expect.any(String),
          noticeSemantics: expect.any(String),
          effectiveCompensationMultiplier: expect.any(Number),
          effectiveNoticePayMonths: expect.any(Number)
        }
      });
    }

    expect(() =>
      policyRegressionExpectationsSchema.parse({
        ...parsed,
        hiddenOverride: true
      })
    ).toThrow();
    expect(() =>
      policyRegressionExpectationsSchema.parse({
        ...parsed,
        cases: parsed.cases.slice(1)
      })
    ).toThrow();
  });

  it("fails when a rule changes without synchronizing its semantic expectation", () => {
    const rules = structuredClone(DEFAULT_ENGINE_POLICY_RULES);
    rules.termination.article40Notice30Days.compensationMultiplier = 2;

    const summary = runPolicyRegression(
      rules,
      DEFAULT_POLICY_REGRESSION_EXPECTATIONS
    );

    expect(summary).toMatchObject({
      total: 14,
      passed: 13,
      failed: 1
    });
    const failed = summary.cases.find(
      (item) => item.id === "article-40-notice"
    );
    expect(failed).toMatchObject({
      status: "failed",
      expected: {
        scenario: "ARTICLE_40.notice_30_days",
        path:
          "decisionModel.article40EmployerTermination.notice30Days",
        payableFen: 7_000_000
      },
      actual: {
        scenario: "ARTICLE_40.notice_30_days",
        path:
          "decisionModel.article40EmployerTermination.notice30Days",
        payableFen: 14_000_000
      },
      diff: expect.arrayContaining([
        {
          path: "payableFen",
          expected: 7_000_000,
          actual: 14_000_000
        },
        {
          path: "formula.effectiveCompensationMultiplier",
          expected: 1,
          actual: 2
        }
      ])
    });
  });

  it("passes only after the future rule and its exact expectation are synchronized", () => {
    const rules = structuredClone(DEFAULT_ENGINE_POLICY_RULES);
    rules.termination.article40Notice30Days.compensationMultiplier = 2;
    const expectations = structuredClone(
      DEFAULT_POLICY_REGRESSION_EXPECTATIONS
    );
    const article40 = expectations.cases.find(
      (item) => item.id === "article-40-notice"
    )!;
    article40.payableFen = 14_000_000;
    article40.rangeFen = { low: 14_000_000, high: 14_000_000 };
    article40.differenceRangeFen = {
      low: 14_000_000,
      high: 14_000_000
    };
    article40.formula.scenarioSemantics =
      "用人单位依据第四十条解除；当前有效规则配置为2N经济补偿和0个月代通知金";
    article40.formula.effectiveCompensationMultiplier = 2;

    const summary = runPolicyRegression(rules, expectations);

    expect(summary).toMatchObject({
      total: 14,
      passed: 14,
      failed: 0
    });
    expect(summary.cases.every((item) => item.diff.length === 0)).toBe(
      true
    );
  });
});
