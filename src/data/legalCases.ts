import casebookRaw from "../../work/产品案例库_按路径与城市_核验工作版.md?raw";
import { getTerminationReasonNode } from "./terminationReasonFlow";
import type { Answers } from "../types";

export const supportedCaseCities = ["北京", "上海", "广州", "深圳", "杭州", "武汉", "成都", "西安"] as const;
export type SupportedCaseCity = (typeof supportedCaseCities)[number];

export const legalCaseCategoryIds = [
  "self_resign_normal",
  "SELF_RESIGN_REASON",
  "company_proposed_mutual_termination",
  "FAULT_DISMISS_CHECK",
  "NO_FAULT_DISMISS_CHECK",
  "ARTICLE_42_LAYOFF_CHECK",
  "CONTRACT_EXPIRED_CHECK",
  "termination_company_disappears"
] as const;

export type LegalCaseCategoryId = (typeof legalCaseCategoryIds)[number];

const legalCaseCategoryIdSet = new Set<string>(legalCaseCategoryIds);

export type LegalCaseCard = {
  id: string;
  categoryId: LegalCaseCategoryId;
  city: SupportedCaseCity | "未披露";
  summary: string;
  outcome?: string;
  reasoning?: string;
  match?: string;
  sourceLabel: string;
  sourceUrl: string;
};

const cleanMarkdown = (value: string) =>
  value
    .replace(/\*\*/g, "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1")
    .trim();

const parseSource = (value: string) => {
  const markdownLink = value.match(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
  if (markdownLink) return { sourceLabel: cleanMarkdown(markdownLink[1]), sourceUrl: markdownLink[2] };
  const url = value.match(/https?:\/\/\S+/)?.[0]?.replace(/[，。；）)]+$/, "") ?? "";
  return { sourceLabel: url ? "查看公开来源" : "来源待补充", sourceUrl: url };
};

const parseCasebook = (markdown: string): LegalCaseCard[] => {
  const lines = markdown.split(/\r?\n/);
  const cases: LegalCaseCard[] = [];
  let categoryIds: LegalCaseCategoryId[] = [];
  let city: SupportedCaseCity | "" = "";
  let draft: Partial<LegalCaseCard> | null = null;

  const flush = () => {
    if (!draft || !categoryIds.length || !city || !draft.id || !draft.summary) return;
    for (const categoryId of categoryIds) {
      cases.push({
        id: draft.id,
        categoryId,
        city: draft.city || city,
        summary: draft.summary,
        outcome: draft.outcome,
        reasoning: draft.reasoning,
        match: draft.match,
        sourceLabel: draft.sourceLabel || "查看公开来源",
        sourceUrl: draft.sourceUrl || ""
      });
    }
    draft = null;
  };

  for (const line of lines) {
    const categoryMatch = line.match(/^##\s+([A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*)｜/);
    if (categoryMatch) {
      flush();
      categoryIds = categoryMatch[1]
        .split("/")
        .filter((categoryId): categoryId is LegalCaseCategoryId => legalCaseCategoryIdSet.has(categoryId));
      city = "";
      continue;
    }

    const cityMatch = line.match(/^###\s+(北京|上海|广州|深圳|杭州|武汉|成都|西安)\s*$/);
    if (cityMatch) {
      flush();
      city = cityMatch[1] as SupportedCaseCity;
      continue;
    }

    const cardMatch = line.match(/^####\s+案例\s+\d+｜(.+)$/);
    if (cardMatch) {
      flush();
      draft = { id: cleanMarkdown(cardMatch[1]) };
      continue;
    }

    if (!draft) continue;
    if (line === "- 城市：未披露") draft.city = "未披露";
    if (line.startsWith("- 简要案情：")) draft.summary = cleanMarkdown(line.slice(7));
    if (line.startsWith("- 裁判/赔偿结果：")) draft.outcome = cleanMarkdown(line.slice(10));
    if (line.startsWith("- 条款贴合：")) draft.reasoning = cleanMarkdown(line.slice(7));
    if (line.startsWith("- 分类说明：")) draft.match = cleanMarkdown(line.slice(7));
    if (line.startsWith("- 官方/可靠来源：")) Object.assign(draft, parseSource(line.slice(9)));
    if (line.startsWith("- 来源：")) Object.assign(draft, parseSource(line.slice(5)));
  }
  flush();
  return cases;
};

export const legalCaseCards = parseCasebook(casebookRaw);

const mutualTerminationPattern = /协商解除|解除协议|协议解除|双方.{0,8}解除/;

const isMutualTerminationCase = (item: LegalCaseCard) =>
  mutualTerminationPattern.test(`${item.summary} ${item.outcome || ""} ${item.match || ""}`);

const mutualTerminationCaseKeys = new Set(
  legalCaseCards
    .filter((item) => item.categoryId === "company_proposed_mutual_termination" && isMutualTerminationCase(item))
    .map((item) => `${item.city}-${item.id}`)
);

const collectLeafIdsFromNode = (nodeId: string, visited = new Set<string>()): string[] => {
  if (visited.has(nodeId)) return [];
  visited.add(nodeId);
  const node = getTerminationReasonNode(nodeId);
  if (!node) return [];

  return node.options.flatMap((option) => [
    ...(option.leaf ? [option.leaf.id] : []),
    ...(option.nextId ? collectLeafIdsFromNode(option.nextId, visited) : [])
  ]);
};

const caseCategoryByLeafId = new Map<string, LegalCaseCategoryId>([
  ["self_resign_normal", "self_resign_normal"],
  ["company_proposed_mutual_termination", "company_proposed_mutual_termination"],
  ["termination_company_disappears", "termination_company_disappears"]
]);

([
  "SELF_RESIGN_REASON",
  "FAULT_DISMISS_CHECK",
  "NO_FAULT_DISMISS_CHECK",
  "ARTICLE_42_LAYOFF_CHECK",
  "CONTRACT_EXPIRED_CHECK"
] as const).forEach((categoryId) => {
  collectLeafIdsFromNode(categoryId).forEach((leafId) => caseCategoryByLeafId.set(leafId, categoryId));
});

export const getCaseCategoryId = (reasonId: string) => caseCategoryByLeafId.get(reasonId) || "";

export const getCasesForCategory = (categoryId: LegalCaseCategoryId, city?: SupportedCaseCity) => {
  const seen = new Set<string>();

  return legalCaseCards.filter((item) => {
    if (item.categoryId !== categoryId || (city && item.city !== city)) return false;
    if (categoryId === "company_proposed_mutual_termination" && !isMutualTerminationCase(item)) return false;
    const key = `${item.city}-${item.id}`;
    if (categoryId === "SELF_RESIGN_REASON" && mutualTerminationCaseKeys.has(key)) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const normalizeCaseCity = (answers: Answers): SupportedCaseCity => {
  const raw = answers.customCity || answers.city || "";
  return supportedCaseCities.find((city) => raw.includes(city)) || "北京";
};
