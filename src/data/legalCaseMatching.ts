import type { Answers } from "../types";
import { legalCaseCards, type LegalCaseCard } from "./legalCases";
import { terminationReasonFlow } from "./terminationReasonFlow";
import {
  caseMatchingMetadata, caseTopicLabels,
  type CaseTopic, type FaultFocus, type CaseMatchingMetadata,
} from "./legalCaseMatchingMetadata";

export type CaseUserProfile = {
  topic?: CaseTopic;
  city: string;
  protectedStatus?: boolean;
  notice30Days?: boolean;
  faultFocus?: FaultFocus;
};

export type MatchedLegalCase = LegalCaseCard & {
  caseKey: string;
  matchLevel: "close" | "related";
  matchReasons: string[];
  differences: string[];
  score: number;
};

const topicByLeaf: Record<string, CaseTopic> = {
  self_resign_normal: "voluntary",
  forced_unpaid_or_underpaid_wage: "wages",
  forced_no_social_insurance: "insurance",
  forced_bad_conditions: "conditions",
  forced_illegal_rules: "illegalRules",
  forced_contract_trap: "contractCoercion",
  forced_violence_or_restriction: "forcedLabor",
  forced_dangerous_work: "dangerousWork",
  company_proposed_mutual_termination: "mutual",
  termination_company_disappears: "closure",
  contract_expired_company_not_renew: "employerNonRenewal",
  contract_expired_protected_status: "employerNonRenewal",
  contract_expired_employee_not_renew: "employeeNonRenewal",
  contract_expired_company_lower_terms: "lowerRenewalTerms",
};

const faultTopics: Record<string, CaseTopic> = {
  "试用期没通过": "probation",
  "严重违反公司制度": "discipline",
  "严重失职，造成重大损失": "dereliction",
  "还在其他单位工作": "dualEmployment",
  "入职时提供了虚假信息": "falseInformation",
  "被依法追究刑事责任": "criminal",
};

/** 只读当前路径上的回答；历史重选残留的其他分支答案不参与匹配。 */
export const getCaseUserProfile = (reasonId: string, answers: Answers): CaseUserProfile => {
  const profile: CaseUserProfile = {
    topic: topicByLeaf[reasonId],
    city: (answers.customCity || answers.city || "").trim().replace(/市$/, ""),
  };
  if (!terminationReasonFlow.some((node) => node.options.some((option) => option.leaf?.id === reasonId))) {
    return { city: profile.city };
  }
  const faultFocusByLeaf: Record<string, FaultFocus> = {
    fault_pot_basically_true: "established",
    fault_pot_uncertain_severity: "severity",
    fault_not_true_or_exaggerated: "evidence",
  };
  if (faultFocusByLeaf[reasonId]) {
    // 多个过错原因共用相同的最终叶子，必须读取前面的具体原因。
    const answer = answers.followUps?.FAULT_DISMISS_CHECK;
    const legacyLines = (answers.terminationReasonText || "").split(/\r?\n/).map((line) => line.trim());
    const legacyReasons = Object.keys(faultTopics).filter((label) => legacyLines.includes(label));
    const selected = answer || (legacyReasons.length === 1 ? legacyReasons[0] : "");
    profile.topic = faultTopics[selected];
    profile.faultFocus = faultFocusByLeaf[reasonId];
  }

  if (/^nofault_(medical|incompetent|major_change)_/.test(reasonId)) {
    profile.topic = reasonId.startsWith("nofault_medical_") ? "medical"
      : reasonId.startsWith("nofault_incompetent_") ? "incompetence" : "objectiveChange";
    profile.protectedStatus = reasonId.endsWith("article42_protected");
    if (reasonId.endsWith("notice_yes")) profile.notice30Days = true;
    if (reasonId.endsWith("notice_no")) profile.notice30Days = false;
  }
  if (reasonId.startsWith("layoff_")) {
    profile.topic = "layoff";
    profile.protectedStatus = reasonId === "layoff_article42_protected";
    if (reasonId.endsWith("_yes")) profile.notice30Days = true;
    if (reasonId.endsWith("_no")) profile.notice30Days = false;
  }
  if (reasonId === "contract_expired_protected_status") profile.protectedStatus = true;
  if (reasonId === "contract_expired_company_not_renew") profile.protectedStatus = false;

  return profile;
};

export const getLegalCaseKey = (item: Pick<LegalCaseCard, "city" | "id">) => `${item.city}|${item.id}`;

const faultFocusText: Record<FaultFocus, string> = {
  established: "解除所依据行为的事实与材料",
  severity: "行为是否达到解除程度",
  evidence: "公司能否证明解除理由",
};

const rankCase = (item: LegalCaseCard, metadata: CaseMatchingMetadata, profile: CaseUserProfile): MatchedLegalCase => {
  const matchReasons = [`同样涉及${caseTopicLabels[profile.topic!]}`];
  const differences: string[] = [];
  let score = 100;
  let matchedConditions = 0;
  let uncertainConditions = 0;
  let differentConditions = 0;

  const compareCondition = (
    actual: boolean | undefined, expected: boolean | undefined,
    matched: string, different: string, unknown: string,
  ) => {
    if (expected === undefined) return;
    if (actual === undefined) {
      uncertainConditions++;
      differences.push(unknown);
    } else if (actual === expected) {
      matchedConditions++;
      score += 10;
      matchReasons.push(matched);
    } else {
      differentConditions++;
      score -= 20;
      differences.push(different);
    }
  };

  compareCondition(metadata.protectedStatus, profile.protectedStatus,
    profile.protectedStatus ? "同样涉及特殊保护情形" : "特殊保护条件的记录与你接近",
    profile.protectedStatus ? "你选择了存在特殊保护情形，本案明确不具备该条件。" : "你选择了不属于所列特殊情形，本案涉及特殊保护，不能直接类比结果。",
    "现有案例摘要未明确特殊保护条件，不能视为与你完全一致。");
  compareCondition(metadata.notice30Days, profile.notice30Days,
    profile.notice30Days ? "同样提前30天通知" : "同样没有提前30天通知",
    profile.notice30Days ? "你选择了提前30天通知，本案明确未提前通知。" : "你选择了未提前30天通知，本案明确已提前通知。",
    "现有案例摘要未明确是否提前30天通知；已支付代通知金也不等于已确认通知天数。");

  if (profile.faultFocus) {
    if (metadata.faultFocus === profile.faultFocus) {
      score += 10;
      matchedConditions++;
      matchReasons.push(`重点可对照${faultFocusText[profile.faultFocus]}`);
    } else {
      uncertainConditions++;
      if (metadata.faultFocus) differences.push(`本案更侧重${faultFocusText[metadata.faultFocus]}，与你当前的争议重点有所不同。`);
    }
    differences.push("你对事实的回答是自述，仍需与本案已查明的事实、证据逐项核对。");
  }
  if (metadata.note) differences.push(metadata.note);
  if (!differences.length) differences.push("目前仅匹配到具体离职原因，解除材料、时间和处理程序仍需逐项核对。");
  const sameCity = Boolean(profile.city && profile.city === item.city);
  if (sameCity) score += 1;
  const matchLevel = !metadata.relatedOnly && !differentConditions &&
    (!uncertainConditions || matchedConditions > 0) ? "close" : "related";
  return { ...item, caseKey: getLegalCaseKey(item), matchLevel, matchReasons, differences, score };
};

/** 原因是准入条件；后续条件优先于城市。不按赔偿额或胜败结果筛选。 */
export const matchLegalCases = (
  reasonId: string, answers: Answers,
  cases: LegalCaseCard[] = legalCaseCards,
): { profile: CaseUserProfile; cases: MatchedLegalCase[]; total: number } => {
  const profile = getCaseUserProfile(reasonId, answers);
  if (!profile.topic) return { profile, cases: [], total: 0 };
  const unique = new Map<string, LegalCaseCard>();
  for (const item of cases) {
    const key = getLegalCaseKey(item);
    const metadata = caseMatchingMetadata[key];
    if (!metadata?.topics.includes(profile.topic) || !/^https?:\/\//.test(item.sourceUrl)) continue;
    const previous = unique.get(key);
    // 同案被多个章节重复收录时保留信息更完整的记录。
    if (!previous || (item.summary.length + (item.outcome?.length || 0)) >
      (previous.summary.length + (previous.outcome?.length || 0))) unique.set(key, item);
  }
  const ranked = [...unique.values()].map((item) => rankCase(item, caseMatchingMetadata[getLegalCaseKey(item)], profile));
  ranked.sort((a, b) => {
    if (a.matchLevel !== b.matchLevel) return a.matchLevel === "close" ? -1 : 1;
    return b.score - a.score || a.caseKey.localeCompare(b.caseKey, "zh-CN");
  });
  return { profile, cases: ranked.slice(0, 5), total: ranked.length };
};
