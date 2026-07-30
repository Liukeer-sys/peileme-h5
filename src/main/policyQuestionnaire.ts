import type { TerminationLeaf } from "../data/terminationReasonFlow";
import type { TerminationScenario } from "../types";

const unlawfulTermination: TerminationScenario = {
  kind: "UNLAWFUL_TERMINATION",
  continuedPerformanceRequested: false,
  continuedPerformancePossible: false
};

const scenarioByLeafId: Record<string, TerminationScenario> = {
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
  fault_not_true_or_exaggerated: unlawfulTermination,
  nofault_not_listed_excuse: unlawfulTermination,
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
    kind: "STATUTORY_COMPENSATION"
  },
  layoff_notice_to_union_or_all_no: unlawfulTermination,
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

export const scenarioForLeaf = (
  leaf: TerminationLeaf
): TerminationScenario => {
  const scenario = scenarioByLeafId[leaf.id];
  if (!scenario) {
    throw new Error(`UNMAPPED_TERMINATION_LEAF:${leaf.id}`);
  }
  return scenario;
};

export type WageSeriesPreset = {
  monthlyEarnedWagesFen: number[];
  bonusNeedsReview: boolean;
  explanation: string;
};

const monthIndex = (month: string | undefined) => {
  const match = /^(\d{4})-(\d{2})$/.exec(month || "");
  if (!match) return null;
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (monthNumber < 1 || monthNumber > 12) return null;
  return year * 12 + monthNumber - 1;
};

const completeWageMonthCount = (
  startMonth: string | undefined,
  endMonth: string | undefined
) => {
  const start = monthIndex(startMonth);
  const end = monthIndex(endMonth);
  if (start === null || end === null) return 12;
  return Math.min(12, Math.max(1, end - start));
};

export const buildDefaultWageSeries = (
  salaryFen: number,
  bonusInfo: string | undefined,
  startMonth: string | undefined,
  endMonth: string | undefined
): WageSeriesPreset => {
  const count = completeWageMonthCount(startMonth, endMonth);
  const explicitBonusMonths =
    bonusInfo === "1个月工资左右"
      ? 1
      : bonusInfo === "2个月工资左右"
        ? 2
        : 0;
  const bonusNeedsReview =
    bonusInfo !== "没有年终奖" && explicitBonusMonths === 0;
  const annualBonusFen = salaryFen * explicitBonusMonths;
  const bonusPerMonthFen = Math.floor(annualBonusFen / count);
  const remainderFen = annualBonusFen % count;
  const monthlyEarnedWagesFen = Array.from(
    { length: count },
    (_, index) =>
      salaryFen + bonusPerMonthFen + (index < remainderFen ? 1 : 0)
  );
  const orderExplanation =
    "工资月按时间从早到晚排列，最后一项是解除前一个完整月";

  if (bonusNeedsReview) {
    return {
      monthlyEarnedWagesFen,
      bonusNeedsReview: true,
      explanation: `奖金金额不确定，默认未计入；${orderExplanation}`
    };
  }
  if (explicitBonusMonths > 0) {
    return {
      monthlyEarnedWagesFen,
      bonusNeedsReview: false,
      explanation: `已根据明确奖金生成均摊初始值；${orderExplanation}`
    };
  }
  return {
    monthlyEarnedWagesFen,
    bonusNeedsReview: false,
    explanation: `未填写额外奖金；${orderExplanation}`
  };
};
