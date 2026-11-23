/**
 * 新案例文档入口：事实、结果、来源、关联说明全部读自一份案例 Markdown。
 * 主动离职、被迫离职、协商离职及过错解除均由此提供展示内容。
 * 本模块不引入旧案例库或阅读文案覆盖表。
 */
import { getTerminationLeafById, getTerminationReasonNode } from "./terminationReasonFlow";

export type CaseRelationLevel = "直接参考" | "同类参考" | "待细化";
export type CaseDisputeFocus = "事实与材料" | "严重程度" | "证据争议";

export type CaseDocumentRelation = {
  reasonId: string;
  /** 分支题的精确选项；有此字段时，不能仅凭最终结果匹配。 */
  optionLabel?: string;
  /** 仅用于排序，不在卡片中显示。 */
  focuses?: CaseDisputeFocus[];
  level: CaseRelationLevel;
  explanation: string;
};

export type LegalCaseDocument = {
  id: string;
  aliases: string[];
  title: string;
  city: string;
  filePath: string;
  /** 未公开的主张读取为空字符串；页面应省略空栏目，不展示资料缺失占位。 */
  facts: {
    background: string;
    events: string;
    workerClaim: string;
    companyClaim: string;
  };
  result: { heading: "判决结果" | "协商结果"; type: string; text: string };
  source: {
    publisher: string;
    publishedAt: string;
    caseNumber: string;
    label: string;
    url: string;
    additional: { label: string; url: string }[];
    checkedAt: string;
    /** 内容维护与核对备注，不作为案例正文展示。 */
    limitations: string;
  };
  relations: CaseDocumentRelation[];
};

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`案例文档缺少或留空：${label}`);
  return value.trim();
}

function claimText(value: string | undefined, label: string): string {
  const text = required(value, label);
  return /^未披露[。]?$/u.test(text) ? "" : text;
}

function sections(text: string, level: number): Map<string, string> {
  const heading = new RegExp(`^${"#".repeat(level)} ([^\\n]+)$`, "gm");
  const matches = [...text.matchAll(heading)];
  const result = new Map<string, string>();
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const name = match[1].trim();
    if (result.has(name)) throw new Error(`案例文档章节重复：${name}`);
    const start = match.index! + match[0].length;
    result.set(name, text.slice(start, matches[index + 1]?.index ?? text.length).trim());
  }
  return result;
}

function field(text: string, name: string): string {
  return required(text.match(new RegExp(`^- ${name}：(.+)$`, "m"))?.[1], name);
}

function link(text: string): { label: string; url: string } {
  const match = text.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
  if (!match) throw new Error(`案例来源不是完整 HTTP(S) Markdown 链接：${text}`);
  const url = new URL(match[2]);
  if (!url.hostname || url.username || url.password) throw new Error("案例来源 URL 无效");
  return { label: match[1], url: match[2] };
}

export function parseLegalCaseDocument(raw: string, filePath = ""): LegalCaseDocument {
  const markdown = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  const titles = [...markdown.matchAll(/^# ([^\n]+)$/gm)];
  if (titles.length !== 1 || !markdown.startsWith("# ")) throw new Error("每份案例文档必须恰有一个开头标题");
  const blocks = sections(markdown, 2);
  const resultHeading = blocks.has("协商结果") ? "协商结果" : "判决结果";
  const expected = ["案情简介", resultHeading, "来源信息", "和用户离职方式的关系"];
  if (blocks.size !== expected.length || expected.some((name) => !blocks.has(name))) {
    throw new Error("案例文档必须包含约定的四个二级章节");
  }
  const facts = sections(required(blocks.get("案情简介"), "案情简介"), 3);
  if (facts.size !== 4) throw new Error("案情简介必须包含背景、经过、劳动者主张、公司主张");
  const result = required(blocks.get(resultHeading), resultHeading);
  const source = required(blocks.get("来源信息"), "来源信息");
  const sourceLink = link(field(source, "原文"));
  const id = field(source, "案例标识");
  if (!/^[A-Z]{2}-[SN]\d{3}$/.test(id)) throw new Error(`案例标识格式错误：${id}`);
  if (filePath && !filePath.endsWith(`/${id}.md`)) throw new Error(`案例标识与文件名不一致：${filePath}`);
  const aliasesText = field(source, "历史标识");
  const aliases = aliasesText === "无" ? [] : aliasesText.split("、");
  if (aliases.some((alias) => !/^[A-Z]{2}-[SN]\d{3}$/.test(alias))) throw new Error("历史标识格式错误");
  const checkedAt = field(source, "核对日期");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkedAt)) throw new Error("核对日期必须为 YYYY-MM-DD");
  const relations = [...sections(required(blocks.get("和用户离职方式的关系"), "关联"), 3)]
    .map(([heading, body]): CaseDocumentRelation => {
      const [reasonId, optionLabel, extra] = heading.split("｜");
      const level = field(body, "关联程度");
      if (!["直接参考", "同类参考", "待细化"].includes(level)) throw new Error(`未知关联程度：${level}`);
      if (heading.includes("｜")) {
        const option = getTerminationReasonNode(reasonId)?.options.find((item) => item.label === optionLabel);
        if (reasonId !== "FAULT_DISMISS_CHECK" || !optionLabel || extra !== undefined || option?.nextId !== "FAULT_TRUTH_CHECK") {
          throw new Error(`无效分支选项：${heading}`);
        }
      } else if (!getTerminationLeafById(reasonId)) throw new Error(`无效选项标识：${reasonId}`);
      if (reasonId === "forced_other_or_unclear" && level !== "待细化") {
        throw new Error("其他情况只能标为待细化，不能自动推荐");
      }
      const focuses = optionLabel ? field(body, "争议侧重").split("、") : undefined;
      if (focuses?.some(value => !["事实与材料", "严重程度", "证据争议"].includes(value))) {
        throw new Error(`无效争议侧重：${heading}`);
      }
      return {
        reasonId,
        ...(optionLabel ? { optionLabel } : {}),
        ...(focuses ? { focuses: focuses as CaseDisputeFocus[] } : {}),
        level: level as CaseRelationLevel,
        explanation: required(body.replace(/^- (关联程度|争议侧重)：.*$/gm, ""), `${reasonId} 的关联说明`),
      };
    });
  if (!relations.length) throw new Error("案例至少需要一个关联选项");
  return {
    id, aliases, title: titles[0][1].trim(), city: field(source, "城市"), filePath,
    facts: {
      background: required(facts.get("背景"), "背景"),
      events: required(facts.get("经过"), "经过"),
      workerClaim: claimText(facts.get("劳动者主张"), "劳动者主张"),
      companyClaim: claimText(facts.get("公司主张"), "公司主张"),
    },
    result: {
      heading: resultHeading,
      type: field(result, "处理类型"),
      text: required(result.replace(/^- 处理类型：.*$/m, ""), "处理结果正文"),
    },
    source: {
      publisher: field(source, "发布机构"), publishedAt: field(source, "发布日期"),
      caseNumber: field(source, "案号或定位"), ...sourceLink,
      additional: [...source.matchAll(/^- 补充来源：(.+)$/gm)].map((match) => link(match[1])),
      checkedAt, limitations: field(source, "信息边界"),
    },
    relations,
  };
}

export function readLegalCaseDocuments(files: Record<string, string>): LegalCaseDocument[] {
  const occupiedIds = new Set<string>();
  return Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([path, raw]) => {
    try {
      const document = parseLegalCaseDocument(raw, path);
      for (const id of [document.id, ...document.aliases]) {
        if (occupiedIds.has(id)) throw new Error(`案例标识或历史标识重复：${id}`);
        occupiedIds.add(id);
      }
      return document;
    } catch (error) {
      throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

const caseMarkdownFiles = import.meta.glob<string>("../../content/legal-cases/*-*.md", {
  query: "?raw", import: "default", eager: true,
});

export const legalCaseDocuments = readLegalCaseDocuments(caseMarkdownFiles);

/** 候选查询，不替代完整的用户条件排序；分支关系必须传精确选项，“待细化”不返回。 */
export function getCaseDocumentsForReason(reasonId: string, optionLabel?: string) {
  return legalCaseDocuments.flatMap((document) => {
    const relation = document.relations.find((item) => item.reasonId === reasonId
      && item.optionLabel === optionLabel && item.level !== "待细化");
    return relation ? [{ document, relation }] : [];
  }).sort((a, b) => Number(a.relation.level === "同类参考") - Number(b.relation.level === "同类参考"));
}
