import { describe, expect, it } from "vitest";
import {
  forcedOtherReasonLeaf,
  terminationReasonFlow,
  type TerminationLeaf
} from "../../src/data/terminationReasonFlow";
import type { TerminationScenario } from "../../src/types";
import {
  buildDefaultWageSeries,
  scenarioForLeaf
} from "../../src/main/policyQuestionnaire";

const leaves = [
  ...terminationReasonFlow.flatMap((node) =>
    node.options.flatMap((option) => (option.leaf ? [option.leaf] : []))
  ),
  forcedOtherReasonLeaf
];

const expectedScenarios: Record<string, TerminationScenario> = {
  termination_company_disappears: { kind: "STATUTORY_COMPENSATION" },
  self_resign_normal: { kind: "VOLUNTARY_RESIGNATION" },
  forced_bad_conditions: { kind: "ARTICLE_38_EMPLOYEE_TERMINATION" },
  forced_unpaid_or_underpaid_wage: {
    kind: "ARTICLE_38_EMPLOYEE_TERMINATION"
  },
  forced_no_social_insurance: {
    kind: "ARTICLE_38_EMPLOYEE_TERMINATION"
  },
  forced_illegal_rules: { kind: "ARTICLE_38_EMPLOYEE_TERMINATION" },
  forced_contract_trap: { kind: "ARTICLE_38_EMPLOYEE_TERMINATION" },
  forced_violence_or_restriction: {
    kind: "ARTICLE_38_EMPLOYEE_TERMINATION"
  },
  forced_other_reason: { kind: "ARTICLE_38_EMPLOYEE_TERMINATION" },
  fault_pot_basically_true: { kind: "ARTICLE_39_NO_COMPENSATION" },
  fault_pot_uncertain_severity: { kind: "UNCLEAR" },
  fault_not_true_or_exaggerated: {
    kind: "UNLAWFUL_TERMINATION",
    continuedPerformanceRequested: false,
    continuedPerformancePossible: false
  },
  nofault_not_listed_excuse: {
    kind: "UNLAWFUL_TERMINATION",
    continuedPerformanceRequested: false,
    continuedPerformancePossible: false
  },
  nofault_medical_notice_yes: {
    kind: "ARTICLE_40",
    noticeMethod: "notice_30_days"
  },
  nofault_medical_notice_no: {
    kind: "ARTICLE_40",
    noticeMethod: "payment_in_lieu"
  },
  nofault_incompetent_notice_yes: {
    kind: "ARTICLE_40",
    noticeMethod: "notice_30_days"
  },
  nofault_incompetent_notice_no: {
    kind: "ARTICLE_40",
    noticeMethod: "payment_in_lieu"
  },
  nofault_major_change_notice_yes: {
    kind: "ARTICLE_40",
    noticeMethod: "notice_30_days"
  },
  nofault_major_change_notice_no: {
    kind: "ARTICLE_40",
    noticeMethod: "payment_in_lieu"
  },
  layoff_notice_to_union_or_all_yes: { kind: "STATUTORY_COMPENSATION" },
  layoff_notice_to_union_or_all_no: {
    kind: "UNLAWFUL_TERMINATION",
    continuedPerformanceRequested: false,
    continuedPerformancePossible: false
  },
  contract_expired_company_not_renew: {
    kind: "STATUTORY_COMPENSATION"
  },
  contract_expired_employee_not_renew: {
    kind: "VOLUNTARY_RESIGNATION"
  },
  contract_expired_company_lower_terms: {
    kind: "STATUTORY_COMPENSATION"
  }
};

describe("scenarioForLeaf", () => {
  it("keeps the mapping table exhaustive when questionnaire leaves change", () => {
    expect(leaves.map((leaf) => leaf.id).sort()).toEqual(
      Object.keys(expectedScenarios).sort()
    );
  });

  it.each(leaves.map((leaf) => [leaf.id, leaf] as const))(
    "normalizes leaf %s to its precise legal scenario",
    (id, leaf) => {
      expect(scenarioForLeaf(leaf)).toEqual(expectedScenarios[id]);
    }
  );

  it("uses UNCLEAR only for range or zero-versus-two-N leaves", () => {
    const unclearModes = leaves
      .filter((leaf) => scenarioForLeaf(leaf).kind === "UNCLEAR")
      .map((leaf) => leaf.resultMode);

    expect(unclearModes).toEqual(["zeroOrTwoN"]);
  });

  it("rejects a future leaf until it is deliberately mapped", () => {
    const futureLeaf: TerminationLeaf = {
      id: "future_explicit_n_leaf",
      label: "新增明确 N 情形",
      reply: "测试",
      resultMode: "n",
      inferredType: "测试",
      compensationHint: "N",
      note: "测试"
    };

    expect(() => scenarioForLeaf(futureLeaf)).toThrow(
      "UNMAPPED_TERMINATION_LEAF:future_explicit_n_leaf"
    );
  });
});

describe("buildDefaultWageSeries", () => {
  it("uses only complete employment months, capped to the latest 12", () => {
    expect(
      buildDefaultWageSeries(
        1_000_000,
        "没有年终奖",
        "2026-05",
        "2026-07"
      ).monthlyEarnedWagesFen
    ).toEqual([1_000_000, 1_000_000]);
    expect(
      buildDefaultWageSeries(
        1_000_000,
        "没有年终奖",
        "2020-01",
        "2026-07"
      ).monthlyEarnedWagesFen
    ).toHaveLength(12);
  });

  it.each([
    ["1个月工资左右", 1_000_000],
    ["2个月工资左右", 2_000_000]
  ])(
    "adds the explicit %s annual bonus without losing a fen",
    (bonusInfo, annualBonusFen) => {
      const result = buildDefaultWageSeries(
        1_000_000,
        bonusInfo,
        "2020-01",
        "2026-07"
      );

      expect(result.monthlyEarnedWagesFen).toHaveLength(12);
      expect(
        result.monthlyEarnedWagesFen.reduce(
          (sum, wage) => sum + wage,
          0
        )
      ).toBe(12_000_000 + annualBonusFen);
      expect(result.monthlyEarnedWagesFen).not.toEqual(
        Array(12).fill(1_000_000)
      );
      expect(result.bonusNeedsReview).toBe(false);
      expect(result.explanation).toContain("均摊");
    }
  );

  it.each([
    "3个月工资及以上",
    "不固定，但发得还算多",
    "不固定，偶尔有一点",
    "说不清 / 还没发"
  ])(
    "does not invent a bonus for the uncertain option %s",
    (bonusInfo) => {
      const result = buildDefaultWageSeries(
        1_000_000,
        bonusInfo,
        "2020-01",
        "2026-07"
      );

      expect(result.monthlyEarnedWagesFen).toEqual(
        Array(12).fill(1_000_000)
      );
      expect(result.bonusNeedsReview).toBe(true);
      expect(result.explanation).toContain("未计入");
    }
  );

  it("keeps the series ordered earliest to latest and marks its final month", () => {
    const result = buildDefaultWageSeries(
      1_000_000,
      "没有年终奖",
      "2026-05",
      "2026-07"
    );

    expect(result.explanation).toContain("早到晚");
    expect(result.explanation).toContain("最后一项");
  });
});
