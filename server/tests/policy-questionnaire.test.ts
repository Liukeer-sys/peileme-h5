import { describe, expect, it } from "vitest";
import {
  forcedOtherReasonLeaf,
  terminationReasonFlow,
  type TerminationLeaf
} from "../../src/data/terminationReasonFlow";
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

const expectedScenarios: Record<string, Record<string, unknown>> = {
  termination_company_disappears: {
    kind: "UNCLEAR",
    factGaps: ["需核验单位破产、解散、被吊销或关闭的法定状态"]
  },
  self_resign_normal: { kind: "VOLUNTARY_RESIGNATION" },
  forced_bad_conditions: {
    kind: "UNCLEAR",
    factGaps: ["需核验单位违法事实、劳动者解除通知及对应证据"]
  },
  forced_unpaid_or_underpaid_wage: {
    kind: "UNCLEAR",
    factGaps: ["需核验单位违法事实、劳动者解除通知及对应证据"]
  },
  forced_no_social_insurance: {
    kind: "UNCLEAR",
    factGaps: ["需核验单位违法事实、劳动者解除通知及对应证据"]
  },
  forced_illegal_rules: {
    kind: "UNCLEAR",
    factGaps: ["需核验单位违法事实、劳动者解除通知及对应证据"]
  },
  forced_contract_trap: {
    kind: "UNCLEAR",
    factGaps: ["需核验单位违法事实、劳动者解除通知及对应证据"]
  },
  forced_violence_or_restriction: {
    kind: "UNCLEAR",
    factGaps: ["需核验单位违法事实、劳动者解除通知及对应证据"]
  },
  forced_other_reason: {
    kind: "UNCLEAR",
    factGaps: ["需核验单位违法事实、劳动者解除通知及对应证据"]
  },
  fault_pot_basically_true: {
    kind: "UNCLEAR",
    factGaps: ["需核验过错事实、严重程度、规章依据及单位解除程序"]
  },
  fault_pot_uncertain_severity: {
    kind: "UNCLEAR",
    factGaps: ["需核验过错事实、严重程度、规章依据及单位解除程序"]
  },
  fault_not_true_or_exaggerated: {
    kind: "UNCLEAR",
    factGaps: ["需核验过错事实、严重程度、规章依据及单位解除程序"]
  },
  nofault_not_listed_excuse: {
    kind: "UNCLEAR",
    factGaps: ["需核验单位解除理由、事实依据及第四十条适用条件"]
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
  layoff_notice_to_union_or_all_yes: {
    kind: "UNCLEAR",
    factGaps: ["需核验经济性裁员人数、法定事由、说明及报告程序"]
  },
  layoff_notice_to_union_or_all_no: {
    kind: "UNCLEAR",
    factGaps: ["需核验经济性裁员人数、法定事由、说明及报告程序"]
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

  it("uses UNCLEAR for every leaf whose facts or procedure remain unverified", () => {
    const unclearModes = new Set(
      leaves
      .filter((leaf) => scenarioForLeaf(leaf).kind === "UNCLEAR")
      .map((leaf) => leaf.resultMode)
    );

    expect(unclearModes).toEqual(
      new Set(["n", "twoN", "zeroRisk", "zeroOrTwoN"])
    );
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

  it.each(["1个月工资左右", "2个月工资左右"])(
    "never invents or allocates the approximate bonus option %s",
    (bonusInfo) => {
      const result = buildDefaultWageSeries(
        1_000_000,
        bonusInfo,
        "2020-01",
        "2026-07"
      );

      expect(result.monthlyEarnedWagesFen).toHaveLength(12);
      expect(result.monthlyEarnedWagesFen).toEqual(
        Array(12).fill(1_000_000)
      );
      expect(result.bonusNeedsReview).toBe(true);
      expect(result.explanation).toContain("不会自动计入");
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
      expect(result.explanation).toContain("不会自动计入");
    }
  );

  it("keeps the series ordered earliest to latest and marks its final month", () => {
    const result = buildDefaultWageSeries(
      1_000_000,
      "没有年终奖",
      "2026-05",
      "2026-07"
    );

    expect(result.explanation).toContain("税前应发");
    expect(result.explanation).toContain("早到晚");
    expect(result.explanation).toContain("最后一项");
  });
});
