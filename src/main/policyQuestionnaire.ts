import type { TerminationLeaf } from "../data/terminationReasonFlow";
import type { TerminationScenario } from "../types";

const companyEntityUnclear: TerminationScenario = {
  kind: "UNCLEAR",
  factGaps: ["需核验单位破产、解散、被吊销或关闭的法定状态"]
};
const forcedTerminationUnclear: TerminationScenario = {
  kind: "UNCLEAR",
  factGaps: ["需核验单位违法事实、劳动者解除通知及对应证据"]
};
const faultTerminationUnclear: TerminationScenario = {
  kind: "UNCLEAR",
  factGaps: ["需核验过错事实、严重程度、规章依据及单位解除程序"]
};
const noFaultExcuseUnclear: TerminationScenario = {
  kind: "UNCLEAR",
  factGaps: ["需核验单位解除理由、事实依据及第四十条适用条件"]
};
const layoffUnclear: TerminationScenario = {
  kind: "UNCLEAR",
  factGaps: ["需核验经济性裁员人数、法定事由、说明及报告程序"]
};

const scenarioByLeafId: Record<string, TerminationScenario> = {
  termination_company_disappears: companyEntityUnclear,
  self_resign_normal: { kind: "VOLUNTARY_RESIGNATION" },
  forced_bad_conditions: forcedTerminationUnclear,
  forced_unpaid_or_underpaid_wage: forcedTerminationUnclear,
  forced_no_social_insurance: forcedTerminationUnclear,
  forced_illegal_rules: forcedTerminationUnclear,
  forced_contract_trap: forcedTerminationUnclear,
  forced_violence_or_restriction: forcedTerminationUnclear,
  forced_other_reason: forcedTerminationUnclear,
  fault_pot_basically_true: faultTerminationUnclear,
  fault_pot_uncertain_severity: faultTerminationUnclear,
  fault_not_true_or_exaggerated: faultTerminationUnclear,
  nofault_not_listed_excuse: noFaultExcuseUnclear,
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
  layoff_notice_to_union_or_all_yes: layoffUnclear,
  layoff_notice_to_union_or_all_no: layoffUnclear,
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

const monthIndex = (date: string | undefined) => {
  const match = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(date || "");
  if (!match) return null;
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (monthNumber < 1 || monthNumber > 12) return null;
  return year * 12 + monthNumber - 1;
};

const completeWageMonthCount = (
  startDate: string | undefined,
  endDate: string | undefined
) => {
  const start = monthIndex(startDate);
  const end = monthIndex(endDate);
  if (start === null || end === null) return 12;
  return Math.min(12, Math.max(1, end - start));
};

export const buildDefaultWageSeries = (
  salaryFen: number,
  bonusInfo: string | undefined,
  startDate: string | undefined,
  endDate: string | undefined
): WageSeriesPreset => {
  const count = completeWageMonthCount(startDate, endDate);
  const bonusNeedsReview = bonusInfo !== "没有年终奖";
  const monthlyEarnedWagesFen = Array.from(
    { length: count },
    () => salaryFen
  );
  const orderExplanation =
    "税前应发工资按时间从早到晚排列，最后一项是解除前一个完整月";

  if (bonusNeedsReview) {
    return {
      monthlyEarnedWagesFen,
      bonusNeedsReview: true,
      explanation:
        `奖金不会自动计入；请在实际发放月填写包含奖金、津贴、补贴的税前应发总额；` +
        orderExplanation
    };
  }
  return {
    monthlyEarnedWagesFen,
    bonusNeedsReview: false,
    explanation:
      `基础工资仅用于生成初始值，请按工资条核对奖金、津贴和补贴；` +
      orderExplanation
  };
};
