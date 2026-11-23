import type { Answers } from "../types";
import { legalCaseDocuments, type LegalCaseDocument, type CaseDisputeFocus } from "./legalCaseDocuments";
import { matchLegalCases } from "./legalCaseMatching";
import { getCaseReading } from "./legalCaseReading";
import { getTerminationReasonNode } from "./terminationReasonFlow";

const forcedReasonIds = new Set(getTerminationReasonNode("SELF_RESIGN_REASON")?.options
  .flatMap(option => option.leaf ? [option.leaf.id] : []) ?? []);

// 已迁移方向独立使用MD，即使没有候选，也不回退到旧章节中的案例。
export const documentCaseReasons = new Set([
  "termination_company_disappears",
  "contract_expired_company_not_renew", "contract_expired_protected_status",
  "contract_expired_employee_not_renew", "contract_expired_company_lower_terms",
  "layoff_article42_protected", "layoff_notice_to_union_or_all_yes", "layoff_notice_to_union_or_all_no",
  "self_resign_normal", "forced_unpaid_or_underpaid_wage", "forced_no_social_insurance",
  "forced_bad_conditions", "forced_illegal_rules", "forced_contract_trap",
  "forced_violence_or_restriction", "forced_dangerous_work", "forced_other_or_unclear",
  "company_proposed_mutual_termination",
  "nofault_medical_notice_yes", "nofault_medical_notice_no", "nofault_medical_article42_protected",
  "nofault_not_listed_excuse",
  "nofault_incompetent_notice_yes", "nofault_incompetent_notice_no", "nofault_incompetent_article42_protected",
  "nofault_major_change_notice_yes", "nofault_major_change_notice_no", "nofault_major_change_article42_protected",
]);

const faultFocusByLeaf: Record<string, CaseDisputeFocus> = {
  fault_pot_basically_true: "事实与材料",
  fault_pot_uncertain_severity: "严重程度",
  fault_not_true_or_exaggerated: "证据争议",
};
const faultOptions = getTerminationReasonNode("FAULT_DISMISS_CHECK")!.options
  .filter(option => option.nextId === "FAULT_TRUTH_CHECK").map(option => option.label);

export type PresentedCase = {
  key: string; title: string; city: string; kind: string; paragraphs: string[];
  outcome: string; outcomeLabel: string; relation: string; close: boolean;
  sourceLabel: string; sourceUrl: string;
};

/** 只挑选用户可读字段，不把来源核对备注、内部编号输出到卡片或下载包。 */
export function presentCaseDocument(document: LegalCaseDocument, reasonId: string, optionLabel?: string): PresentedCase | undefined {
  const browseForced = reasonId === "forced_other_or_unclear";
  const browseFault = reasonId === "fault_reason_other_or_unclear";
  const faultRelations = browseFault ? document.relations.filter(item => item.reasonId === "FAULT_DISMISS_CHECK"
    && item.optionLabel && faultOptions.includes(item.optionLabel) && item.level !== "待细化") : [];
  const relation = browseFault ? faultRelations[0] : browseForced
    ? document.relations.find(item => item.reasonId === reasonId)
      ?? document.relations.find(item => forcedReasonIds.has(item.reasonId) && item.level !== "待细化")
    : document.relations.find((item) => item.reasonId === reasonId && item.optionLabel === optionLabel && item.level !== "待细化");
  if (!relation) return undefined;
  const claims = [
    document.facts.workerClaim && `劳动者方面，${document.facts.workerClaim}`,
    document.facts.companyClaim && `公司方面，${document.facts.companyClaim}`,
  ].filter(Boolean).join("");
  return {
    key: document.id, title: document.title,
    city: document.city === "未披露" ? "" : document.city,
    kind: document.result.type,
    paragraphs: [document.facts.background, document.facts.events, claims].filter(Boolean),
    outcome: document.result.text,
    outcomeLabel: document.result.heading === "协商结果" ? "协商结果" : "处理结果",
    relation: browseFault
      ? `以下是过错解除相关情形的参考，尚未按你的具体原因匹配。${faultRelations.map(item => `${item.optionLabel}：${item.explanation}`).join("\n\n")}`
      : browseForced ? `以下是被迫离职相关情形的参考，尚未按你的具体原因匹配。${relation.explanation}` : relation.explanation,
    close: !browseForced && !browseFault && relation.level === "直接参考",
    sourceLabel: document.source.label, sourceUrl: document.source.url,
  };
}

export function getPresentedCases(reasonId: string, answers: Answers, documents = legalCaseDocuments) {
  const focus = faultFocusByLeaf[reasonId];
  if (focus) {
    // 只在过错解除路径使用这些答案；老存档只接受唯一、完整的选项文字。
    const legacyLines = (answers.terminationReasonText || "").split(/\r?\n/).map(line => line.trim());
    const legacyOptions = faultOptions.filter(label => legacyLines.includes(label));
    const option = answers.followUps?.FAULT_DISMISS_CHECK
      || (legacyOptions.length === 1 ? legacyOptions[0] : "");
    if (!focus || !faultOptions.includes(option)) return { cases: [], needsMoreDetail: true };
    const city = (answers.customCity || answers.city || "").trim().replace(/市$/, "");
    const ranked = documents.flatMap(doc => {
      const relation = doc.relations.find(r => r.reasonId === "FAULT_DISMISS_CHECK" && r.optionLabel === option && r.level !== "待细化");
      const item = presentCaseDocument(doc, "FAULT_DISMISS_CHECK", option);
      if (!relation || !item) return [];
      const focused = Boolean(relation.focuses?.includes(focus));
      return [{ item: { ...item, close: item.close && focused }, direct: relation.level === "直接参考", focused }];
    }).sort((a, b) => Number(b.direct) - Number(a.direct)
      || Number(b.focused) - Number(a.focused)
      || Number(Boolean(city && b.item.city === city)) - Number(Boolean(city && a.item.city === city))
      || a.item.key.localeCompare(b.item.key));
    return { cases: ranked.map(entry => entry.item), needsMoreDetail: false };
  }
  if (documentCaseReasons.has(reasonId) || reasonId === "fault_reason_other_or_unclear") {
    const city = (answers.customCity || answers.city || "").trim().replace(/市$/, "");
    const cases = documents.flatMap((doc) => {
      const item = presentCaseDocument(doc, reasonId);
      return item ? [item] : [];
    }).sort((a, b) => Number(b.close) - Number(a.close)
      || Number(Boolean(city && b.city === city)) - Number(Boolean(city && a.city === city))
      || a.key.localeCompare(b.key));
    return { cases, needsMoreDetail: false };
  }
  // 未迁移方向继续沿用原有的细分条件排序。
  const matching = matchLegalCases(reasonId, answers);
  const cases: PresentedCase[] = matching.cases.map((item) => {
    const reading = getCaseReading(item);
    return {
      key: item.caseKey, title: reading.title, city: item.city === "未披露" ? "" : item.city, kind: "案例参考",
      paragraphs: [...reading.background, reading.issue].filter((text): text is string => Boolean(text)),
      outcome: [reading.outcome, reading.reasoning].filter(Boolean).join(""), outcomeLabel: "处理结果",
      relation: [...item.matchReasons, ...item.differences].join("；"), close: item.matchLevel === "close",
      sourceLabel: reading.sourceLabel || item.sourceLabel, sourceUrl: item.sourceUrl,
    };
  });
  return { cases, needsMoreDetail: !matching.profile.topic };
}

export function formatPresentedCases(cases: PresentedCase[]): string {
  return cases.map((item) => [item.title, [item.city, item.kind].filter(Boolean).join(" · "),
    ...item.paragraphs, item.outcome && `${item.outcomeLabel}：${item.outcome}`, item.relation,
    `来源：${item.sourceLabel}\n${item.sourceUrl}`].filter(Boolean).join("\n\n")).join("\n\n——\n\n");
}
