import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { buildEvidenceChecklist } from "../data/evidenceChecklist";
import { getLaborLawArticle, getLaborLawPack, type LaborLawArticle, type LaborLawCitation } from "../data/laborLawReferences";
import { getTerminationReasonNode, rootTerminationReasonNode } from "../data/terminationReasonFlow";
import type { Answers } from "../types";
import type { CalculationResult } from "../utils/calculate";
import { loadEvidenceProgress, restoreEvidenceSelections, saveEvidenceProgress } from "../utils/storage";
import LegalCaseGallery, { CaseSectionIcon } from "./LegalCaseGallery";
import EvidenceChecklistView from "./EvidenceChecklistView";
import EvidencePreparation from "./EvidencePreparation";
import XiaoPeiAvatar from "./XiaoPeiAvatar";
import DocumentReview from "./DocumentReview";
import ModuleUnlockDialog from "./ModuleUnlockDialog";
import { getPresentedCases, formatPresentedCases } from "../data/legalCasePresentation";

type PaidModuleKey = "caseLawPack" | "evidencePack" | "documentReview";
type CaseLawSectionKey = "laws";

import type { ReactNode } from 'react';

type LegalCaseReference = {
  title: string;
  scenario: string;
  focus: string;
  evidence: string[];
};

type ExpandedLinkedArticle = {
  article: LaborLawArticle;
  sourceArticleId: string;
};

type PaidUpsellCardProps = {
  result: CalculationResult;
  answers: Answers;
  showIntro?: boolean;
};


const caseLawSections: Array<{
  key: CaseLawSectionKey;
  title: string;
  count: string;
  previewTitle: string;
  previewBody: string;
  downloadItems: string[];
}> = [
  {
    key: "laws",
    title: "相关法律与案例卡片",
    count: "3 条",
    previewTitle: "经济补偿的基本口径",
    previewBody: "解除或终止劳动合同时，符合条件的经济补偿通常按工作年限和解除前十二个月平均工资计算。点击重点法条项，可查看对应案例参考。",
    downloadItems: [
      "《劳动合同法》第四十六条：列明用人单位应支付经济补偿的主要情形。",
      "《劳动合同法》第四十七条：经济补偿按本单位工作年限计算，每满一年支付一个月工资。",
      "《劳动合同法》第四十八条：违法解除时，劳动者可要求继续履行或主张赔偿金。"
    ]
  }
];

const noCaseReferenceArticleIds = new Set(["article46", "article47", "article48", "article87"]);
const noHighlightArticleIds = new Set(["article47"]);

const articleTitleBadges: Record<string, string> = {
  article39: "公司主张的解除理由",
  article40: "公司主张的解除理由",
  article41: "公司主张的裁员理由",
  article42: "特殊保护限制",
  article46: "需补偿的合法解除情况",
  article47: "赔偿通用计算规则",
  article48: "违法解除后，你可以怎么选",
  article87: "2N 赔偿依据"
};

const getArticleTitleBadge = (articleId: string) => articleTitleBadges[articleId];
const defaultHighlightsByArticle: Record<string, string[]> = {
  article37: ["提前三十日以书面形式通知"],
  article48: ["违反本法规定解除或者终止劳动合同", "依照本法第八十七条规定支付赔偿金"],
  article87: ["经济补偿标准的二倍"]
};

const getCitationHighlights = (citation: LaborLawCitation) =>
  noHighlightArticleIds.has(citation.articleId)
    ? []
    : citation.highlights?.length ? citation.highlights : defaultHighlightsByArticle[citation.articleId] ?? [];

const normalizeLawText = (value: string) => value.replace(/[（]/g, "(").replace(/[）]/g, ")");

const nestedLawTargets = [
  { text: '第二十六条', articleId: 'article26' }
];

const getCitationCaseReferences = (citation: LaborLawCitation, highlight: string, summary: string): LegalCaseReference[] => {
  if (citation.articleId === "article38") {
    if (highlight.includes("(一)")) {
      return [
        {
          title: "工作条件被实质降低后被迫解除",
          scenario: "岗位、工作地点、劳动保护或必要工作条件被明显改变，劳动者以单位未提供约定劳动条件为由解除。",
          focus: "重点看劳动合同约定、公司调整通知、实际工作条件变化，以及劳动者解除通知是否写明第三十八条理由。",
          evidence: ["劳动合同 / 岗位说明", "调岗调址或工作条件变化通知", "沟通记录", "解除通知送达记录"]
        }
      ];
    }
    if (highlight.includes("(二)")) {
      return [
        {
          title: "工资迟发、少发后被迫解除",
          scenario: "单位长期拖欠、克扣工资，劳动者因此提出解除并主张经济补偿。",
          focus: "重点看工资应发数、实发数、迟发周期，以及解除前是否明确把欠薪作为离职原因。",
          evidence: ["工资条", "银行流水", "考勤记录", "催发工资聊天记录", "解除通知"]
        }
      ];
    }
    if (highlight.includes("(三)")) {
      return [
        {
          title: "未依法缴纳社保后被迫解除",
          scenario: "单位未缴、少缴或长期断缴社会保险，劳动者以此为由解除劳动合同。",
          focus: "重点看社保缴费记录与实际用工期间是否对应，以及当地仲裁口径对补缴、补偿的处理。",
          evidence: ["社保缴费明细", "劳动合同", "工资流水", "入离职记录", "解除通知"]
        }
      ];
    }
    if (highlight.includes("(四)")) {
      return [
        {
          title: "违法规章损害权益后被迫解除",
          scenario: "单位用罚款、无薪待岗、违规扣款等制度损害劳动者权益，劳动者据此解除。",
          focus: "重点看规章制度是否合法制定、公示，是否实际损害劳动者工资、休息休假等权益。",
          evidence: ["员工手册 / 规章制度", "扣款记录", "制度公示记录", "申诉沟通记录"]
        }
      ];
    }
    if (highlight.includes("(五)") || highlight.includes("暴力") || highlight.includes("违章指挥")) {
      return [
        {
          title: "合同瑕疵或强迫劳动场景下解除",
          scenario: "劳动合同签署存在欺诈、胁迫、乘人之危，或单位存在限制人身自由、威胁、强令冒险作业等情况。",
          focus: "重点看签署过程是否违背真实意思，以及是否有报警、医疗、现场证人、聊天记录等强证据。",
          evidence: ["合同签署沟通记录", "现场录音录像", "报警 / 就医记录", "证人线索", "解除通知"]
        }
      ];
    }
  }

  if (citation.articleId === "article39") {
    return [
      {
        title: "单位以过错解除的举证审查",
        scenario: "单位主张劳动者严重违纪、严重失职、试用期不合格、双重劳动关系或刑事责任等。",
        focus: "重点看单位是否能证明事实存在、程度足够严重、规章制度合法有效并已向劳动者公示。",
        evidence: ["解除通知", "规章制度及公示签收", "违纪事实材料", "损失证明", "申辩或沟通记录"]
      }
    ];
  }

  if (citation.articleId === "article40") {
    return [
      {
        title: "无过失解除是否满足法定步骤",
        scenario: "单位以医疗期满、不能胜任、客观情况重大变化为由解除劳动合同。",
        focus: "重点看具体理由是否落入第四十条，是否经过培训、调岗、协商变更等必要步骤，以及是否提前三十日通知或支付代通知金。",
        evidence: ["岗位调整 / 培训记录", "考核材料", "医疗期材料", "协商变更记录", "解除通知和付款记录"]
      }
    ];
  }

  if (citation.articleId === "article41") {
    return [
      {
        title: "经济性裁员程序是否完整",
        scenario: "单位以经营困难、组织调整或经济性裁员为由批量解除员工。",
        focus: "重点看裁员人数是否达到标准，是否提前三十日向工会或全体职工说明，并向劳动行政部门报告。",
        evidence: ["裁员通知", "职工大会 / 工会说明材料", "裁员方案", "行政部门报告材料", "补偿方案"]
      }
    ];
  }

  if (citation.articleId === "article44") {
    return [
      {
        title: "合同终止或经济补偿触发点",
        scenario: "合同到期公司不续签、降低条件续签，或公司破产、关闭、撤销、提前解散。",
        focus: "重点看终止原因、续签条件是否维持或提高，以及第四十六条对应项是否触发经济补偿。",
        evidence: ["劳动合同", "续签通知 / 不续签通知", "新旧合同条件对比", "工商或破产材料", "工资流水"]
      }
    ];
  }

  if (citation.articleId === "article48" || citation.articleId === "article87") {
    return [
      {
        title: "违法解除主张 2N 的参考路径",
        scenario: "单位解除理由不成立、程序明显违法，或把非法定理由包装成辞退理由。",
        focus: "重点看解除事实和法定理由是否对应；若违法解除成立，通常围绕继续履行或二倍赔偿金展开。",
        evidence: ["解除通知", "HR 沟通记录", "规章制度", "考核 / 调岗 / 裁员程序材料", "工资流水"]
      }
    ];
  }


  return [
    {
      title: "与你当前结论对应的参考方向",
      scenario: summary,
      focus: "重点把离职原因、解除通知、工资流水和公司书面材料串起来，证明法律条文与事实能对上。",
      evidence: ["劳动合同", "解除 / 终止通知", "工资流水", "聊天记录", "社保记录"]
    }
  ];
};

const buildLegalDownloadItems = (legalPack: ReturnType<typeof getLaborLawPack>) =>
  legalPack.citations
    .map((citation) => {
      const article = getLaborLawArticle(citation.articleId);
      if (!article) return "";
      if (citation.articleId === "article47") {
        return [
          article.title,
          "通用说明：这一条说明经济补偿怎么计算，不单独标黄，也不匹配案例参考。",
          article.lines.join("\n")
        ].join("\n");
      }
      const highlights = getCitationHighlights(citation);
      const caseBlocks = noCaseReferenceArticleIds.has(citation.articleId)
        ? "通用说明：这一项说明前面具体解除/终止情形为什么需要支付经济补偿，不单独匹配案例参考。"
        : highlights
            .map((highlight) => {
              const cases = getCitationCaseReferences(citation, highlight, legalPack.summary);
              return [
                `重点项：${highlight}`,
                "可参考案例：",
                ...cases.map((item, index) =>
                  [
                    `${index + 1}. ${item.title}`,
                    `   场景：${item.scenario}`,
                    `   争议重点：${item.focus}`,
                    `   建议证据：${item.evidence.join("、")}`
                  ].join("\n")
                )
              ].join("\n");
            })
            .join("\n\n");

      return [
        article.title,
        highlights.length ? `重点标注：${highlights.join("、")}` : "重点标注：需结合材料进一步判断",
        article.lines.join("\n"),
        caseBlocks
      ].filter(Boolean).join("\n");
    })
    .filter(Boolean);

const renderInlineLinkedLawText = (
  line: string,
  sourceArticleId: string,
  onLinkedArticle: (article: LaborLawArticle, sourceArticleId: string) => void
) => {
  const target = nestedLawTargets.find((item) => line.includes(item.text));
  const article = target ? getLaborLawArticle(target.articleId) : undefined;
  if (!target || !article) return line;

  const [beforeLinkedText, afterLinkedText] = line.split(target.text);

  return (
    <>
      {beforeLinkedText}
      <span
        className="legal-inline-link"
        role="button"
        tabIndex={0}
        onClick={(event) => {
          event.stopPropagation();
          onLinkedArticle(article, sourceArticleId);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          onLinkedArticle(article, sourceArticleId);
        }}
      >
        {target.text}
      </span>
      {afterLinkedText}
    </>
  );
};

const renderLawLine = (
  line: string,
  citation: LaborLawCitation,
  onLinkedArticle: (article: LaborLawArticle, sourceArticleId: string) => void
) => {
  const normalizedLine = normalizeLawText(line);
  const matchedHighlight = getCitationHighlights(citation).find((highlight) => normalizedLine.includes(normalizeLawText(highlight)));

  if (matchedHighlight) {
    return (
      <p className="legal-article-line highlighted" key={line}>
        {renderInlineLinkedLawText(line, citation.articleId, onLinkedArticle)}
      </p>
    );
  }

  return (
    <p className="legal-article-line" key={line}>
      {renderInlineLinkedLawText(line, citation.articleId, onLinkedArticle)}
    </p>
  );
};

type SelectedReasonStep = {
  question: string;
  answer: string;
  side: "left" | "right";
};

const withSelectedReasonSides = (steps: Array<Omit<SelectedReasonStep, "side">>): SelectedReasonStep[] =>
  steps.map((step, index) => ({ ...step, side: index % 2 === 0 ? "right" : "left" }));

const getSelectedReasonQuestion = (nodeId: string, question: string) =>
  nodeId.startsWith("ARTICLE_42_") ? "是否属于首保户的特殊情况？" : question;

const getSelectedReasonSteps = (answers: Answers, result: CalculationResult): SelectedReasonStep[] => {
  const steps: Array<Omit<SelectedReasonStep, "side">> = [];
  let node = rootTerminationReasonNode;
  const visited = new Set<string>();

  while (node && !visited.has(node.id)) {
    visited.add(node.id);
    const answer = answers.followUps[node.id];
    if (!answer) break;

    steps.push({ question: getSelectedReasonQuestion(node.id, node.question), answer });
    const option = node.options.find((item) => item.label === answer);
    if (!option?.nextId) break;

    const nextNode = getTerminationReasonNode(option.nextId);
    if (!nextNode) break;
    node = nextNode;
  }

  if (steps.length > 0) return withSelectedReasonSides(steps);

  const rawText = answers.terminationReasonText || result.terminationHint;
  return withSelectedReasonSides(
    rawText
      .split(/\n+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .filter((item) => item !== result.terminationInferredType)
      .map((answer, index) => ({ question: `第 ${index + 1} 步选择`, answer }))
  );
};

export const getSelectedReasonStepCount = (answers: Answers, result: CalculationResult) =>
  getSelectedReasonSteps(answers, result).length;

const getSelectedReasonCopySize = (answer: string) => {
  if (answer.length <= 8) return "is-compact";
  if (answer.length <= 20) return "is-medium";
  return "is-long";
};

const getSelectedReasonTurnX = (answer: string, side: SelectedReasonStep["side"]) => {
  const size = getSelectedReasonCopySize(answer);
  const inset = size === "is-compact" ? 45 : size === "is-medium" ? 24 : 12;
  return side === "right" ? 100 - inset : inset;
};

const buildSelectedReasonRoadPath = (turnXs: number[]) => {
  if (turnXs.length === 0) return "";

  const rowHeight = 76;
  let path = `M -4 0 H ${turnXs[0]}`;

  turnXs.forEach((turnX, index) => {
    const bottom = (index + 1) * rowHeight;
    path += index % 2 === 0
      ? ` A 10 38 0 0 1 ${turnX} ${bottom}`
      : ` A 10 38 0 0 0 ${turnX} ${bottom}`;
    if (index < turnXs.length - 1) path += ` H ${turnXs[index + 1]}`;
  });

  return `${path} H ${turnXs.length % 2 === 0 ? 104 : -4}`;
};

type SelectedReasonStepViewProps = {
  step: SelectedReasonStep;
  index: number;
};

function SelectedReasonStepView({ step, index }: SelectedReasonStepViewProps) {
  return (
    <div className={`selected-reason-step is-${step.side} ${getSelectedReasonCopySize(step.answer)}`} role="listitem">
      <span className="selected-reason-marker" aria-hidden="true">{index + 1}</span>
      <div className="selected-reason-step-copy">
        <small>{step.question}</small>
        <b>{step.answer}</b>
      </div>
    </div>
  );
}

type SelectedReasonConclusionViewProps = {
  answer: string;
  side: SelectedReasonStep["side"];
};

function SelectedReasonConclusionView({ answer, side }: SelectedReasonConclusionViewProps) {
  return (
    <div className={`selected-reason-conclusion is-${side} ${getSelectedReasonCopySize(answer)}`} role="listitem">
      <span className="selected-reason-marker selected-reason-marker-final" aria-hidden="true">✓</span>
      <div className="selected-reason-conclusion-copy">
        结论：<strong>{answer}</strong>
      </div>
    </div>
  );
}

export function SelectedReasonCard({ result, answers }: Omit<PaidUpsellCardProps, "showIntro">) {
  const selectedReasonSteps = useMemo(() => getSelectedReasonSteps(answers, result), [answers, result]);
  const nodeCount = selectedReasonSteps.length + 1;
  const conclusionSide: SelectedReasonStep["side"] = selectedReasonSteps.length % 2 === 0 ? "right" : "left";
  const roadTurnXs = useMemo(
    () => [
      ...selectedReasonSteps.map((step) => getSelectedReasonTurnX(step.answer, step.side)),
      getSelectedReasonTurnX(result.terminationInferredType, conclusionSide),
    ],
    [conclusionSide, result.terminationInferredType, selectedReasonSteps]
  );
  const roadPath = useMemo(() => buildSelectedReasonRoadPath(roadTurnXs), [roadTurnXs]);

  return (
    <div className="selected-reason-card">
      <span>你刚刚选择的是：</span>
      <div className="selected-reason-road">
        <svg className="selected-reason-road-line" viewBox={`0 0 100 ${nodeCount * 76}`} preserveAspectRatio="none" aria-hidden="true">
          <path className="selected-reason-road-dash" d={roadPath} vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="selected-reason-path" role="list">
          {selectedReasonSteps.map((step, index) => (
            <SelectedReasonStepView step={step} index={index} key={`${step.question}-${step.answer}-${index}`} />
          ))}
          <SelectedReasonConclusionView answer={result.terminationInferredType} side={conclusionSide} />
        </div>
      </div>
    </div>
  );
}
export function PaidNextStepCard() {
  return (
    <div className="paid-intro paid-card paid-next-step-card">
      <div className="card-label paid-next-label">下一步，别着急签</div>
    </div>
  );
}

type EvidencePrintDocumentProps = {
  checklist: ReturnType<typeof buildEvidenceChecklist>;
  selectedEvidence: Record<string, boolean>;
  reasonText: string;
  generatedAt: string;
};

export function EvidencePrintDocument({ checklist, selectedEvidence, reasonText, generatedAt }: EvidencePrintDocumentProps) {
  const { sections } = checklist;
  const allItems = sections.flatMap((section) => section.items);
  const preparedCount = allItems.filter((item) => selectedEvidence[item.id]).length;

  return (
    <article className="evidence-print-root" aria-hidden="true">
      <header className="evidence-print-header">
        <div>
          <span>赔了么 · 离职材料整理</span>
          <h1>{checklist.title ?? "离职证据准备清单"}</h1>
          <p>{reasonText || checklist.leafText}</p>
        </div>
        <div className="evidence-print-progress">
          <strong>{preparedCount}/{allItems.length}</strong>
          <span>{checklist.savedLabel ? checklist.savedLabel + "材料" : "已准备材料"}</span>
        </div>
      </header>

      <p className="evidence-pack-tip"><CaseSectionIcon kind="tip" />{checklist.userTip}</p>

      <div className="evidence-print-sections">
        {sections.map((section) => (
          <section className="evidence-print-section" key={section.id}>
            <header>
              <h2>{section.title}</h2>
            </header>
            <div>
              {section.items.map((item) => (
                <article className="evidence-print-item" key={item.id}>
                  <span className={selectedEvidence[item.id] ? "evidence-print-check is-ready" : "evidence-print-check"}>
                    {selectedEvidence[item.id] ? "✓" : "□"}
                  </span>
                  <span className="evidence-print-number">{String(allItems.indexOf(item) + 1).padStart(2, "0")}</span>
                  <div>
                    <h3>{item.name}{item.priority === "optional" && <em>有则保留</em>}</h3>
                    <EvidencePreparation item={item} />
                  </div>
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>

      {checklist.supplementaryEvidence?.map(section => (
        <section className="evidence-print-section" key={section.id}>
          <header><h2>{section.title}</h2>{section.description && <p>{section.description}</p>}</header>
          {section.items.map((item, index) => <article className="evidence-print-item evidence-print-supplement" key={item.id}>
            <span className="evidence-print-number">{String(index + 1).padStart(2, "0")}</span>
            <div><h3>{item.name}</h3><EvidencePreparation item={item} /></div>
          </article>)}
        </section>
      ))}
      <footer className="evidence-print-footer">
        {checklist.reminder && <p>{checklist.reminder}</p>}
        <span>生成时间：{generatedAt}</span>
        <p>本清单用于材料整理参考，不构成正式法律意见。涉及人身安全时，请优先确保安全并及时联系有关部门或专业人士。</p>
      </footer>
    </article>
  );
}
export function PaidIntroCard(props: Omit<PaidUpsellCardProps, "showIntro">) {
  return (
    <>
      <SelectedReasonCard {...props} />
      <PaidNextStepCard />
    </>
  );
}
export default function PaidUpsellCard({ result, answers, showIntro = true }: PaidUpsellCardProps) {
  const [selectedEvidence, setSelectedEvidence] = useState<Record<string, boolean>>({});
  const [evidenceHydratedKey, setEvidenceHydratedKey] = useState("");
  const [evidenceSaveFailed, setEvidenceSaveFailed] = useState(false);
  const [paidModules, setPaidModules] = useState<Record<PaidModuleKey, boolean>>({
    caseLawPack: false,
    evidencePack: false,
    documentReview: false
  });
  const [paywallModule, setPaywallModule] = useState<PaidModuleKey | null>(null);
  const [expandedLinkedArticles, setExpandedLinkedArticles] = useState<ExpandedLinkedArticle[]>([]);
  const [toast, setToast] = useState("");

  const evidenceChecklist = useMemo(() => buildEvidenceChecklist(result, answers), [answers, result]);
  const visibleEvidenceSelections = evidenceHydratedKey === evidenceChecklist.key ? selectedEvidence : {};
  const legalPack = useMemo(() => getLaborLawPack(result.terminationReasonId, answers), [answers, result.terminationReasonId]);
  const rootLegalCitations = useMemo(() => {
    const nestedArticleIds = new Set<string>();
    legalPack.citations.forEach((citation) => {
      const article = getLaborLawArticle(citation.articleId);
      article?.lines.forEach((line) => {
        nestedLawTargets.forEach((target) => {
          if (line.includes(target.text)) nestedArticleIds.add(target.articleId);
        });
      });
    });
    return legalPack.citations.filter((citation) => !nestedArticleIds.has(citation.articleId));
  }, [legalPack]);
  const selectedReasonPath = useMemo(
    () => getSelectedReasonSteps(answers, result).map((step) => step.answer),
    [answers, result]
  );
  const displayedCaseLawSections = useMemo(
    () =>
      caseLawSections.map((section) => ({
        ...section,
        count: `${legalPack.citations.length} 条`,
        previewTitle: `参考结论：${legalPack.result}`,
        previewBody: legalPack.summary,
        downloadItems: buildLegalDownloadItems(legalPack)
      })),
    [legalPack]
  );
  useEffect(() => {
    const progress = loadEvidenceProgress(result.terminationReasonId);
    setSelectedEvidence(restoreEvidenceSelections(progress, evidenceChecklist));
    setEvidenceSaveFailed(false);
    setPaidModules((current) => ({
      ...current,
      evidencePack: Boolean(progress?.evidencePackUnlocked)
    }));
    setEvidenceHydratedKey(evidenceChecklist.key);
  }, [result.terminationReasonId, evidenceChecklist]);

  useEffect(() => {
    if (evidenceHydratedKey !== evidenceChecklist.key) return;
    const updatedAt = new Date().toISOString();
    try {
      saveEvidenceProgress({
        version: 1,
        terminationReasonId: result.terminationReasonId,
        checklistKey: evidenceChecklist.key,
        selectedEvidence,
        evidencePackUnlocked: paidModules.evidencePack,
        updatedAt
      });
      setEvidenceSaveFailed(false);
    } catch {
      setEvidenceSaveFailed(true);
    }
  }, [evidenceHydratedKey, evidenceChecklist.key, paidModules.evidencePack, result.terminationReasonId, selectedEvidence]);


  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 1800);
  };

  const expandLinkedArticle = (article: LaborLawArticle, sourceArticleId: string) => {
    const expansionId = 'linked-' + sourceArticleId + '-' + article.id;
    setExpandedLinkedArticles((current) => {
      if (current.some((item) => item.sourceArticleId === sourceArticleId && item.article.id === article.id)) return current;
      return [...current, { article, sourceArticleId }];
    });
    window.setTimeout(() => document.getElementById(expansionId)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0);
  };

  const collapseLinkedArticle = (sourceArticleId: string, articleId: string) => {
    setExpandedLinkedArticles((current) =>
      current.filter((item) => item.sourceArticleId !== sourceArticleId || item.article.id !== articleId)
    );
  };

  const renderExpandedLinkedArticles = (sourceArticleId: string): ReactNode[] =>
    expandedLinkedArticles
      .filter((item) => item.sourceArticleId === sourceArticleId)
      .map((linkedArticle) => (
        <article
          className={'legal-article-card legal-linked-article-card'}
          id={'linked-' + linkedArticle.sourceArticleId + '-' + linkedArticle.article.id}
          key={linkedArticle.sourceArticleId + '-' + linkedArticle.article.id}
        >
          <h3>{linkedArticle.article.title.replace(/^《[^》]+》\s*/, "")}</h3>
          {linkedArticle.article.lines.map((line) => (
            <p className={'legal-article-line'} key={line}>
              {renderInlineLinkedLawText(
                line,
                linkedArticle.article.id,
                expandLinkedArticle
              )}
            </p>
          ))}
          {renderExpandedLinkedArticles(linkedArticle.article.id)}
          <button
            className={'legal-linked-collapse'}
            type={'button'}
            onClick={() => collapseLinkedArticle(linkedArticle.sourceArticleId, linkedArticle.article.id)}
          >
            收起关联法条
          </button>
        </article>
      ));

  const unlockModule = (module: PaidModuleKey) => {
    setPaidModules((current) => ({ ...current, [module]: true }));
    setPaywallModule(null);
    showToast("已解锁，感谢支持！");
  };

  const toggleEvidence = (item: string) => {
    setSelectedEvidence((current) => ({ ...current, [item]: !current[item] }));
  };

  const downloadCaseLawPack = () => {
    const content = displayedCaseLawSections
      .map((section) => [section.title, ...section.downloadItems.map((item, index) => `${index + 1}. ${item}`)].join("\n"))
      .join("\n\n");
    const caseContent = formatPresentedCases(getPresentedCases(result.terminationReasonId, answers).cases);
    const blob = new Blob([`赔了么案例法条包\n\n${content}${caseContent ? `\n\n参考案例\n\n${caseContent}` : ""}`], { type: "text/plain;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "赔了么-案例法条包.txt";
    link.click();
    window.URL.revokeObjectURL(url);
    showToast("案例法条包已开始下载。");
  };

  const downloadEvidencePack = () => {
    const previousTitle = document.title;
    const restoreTitle = () => {
      document.title = previousTitle;
      window.removeEventListener("afterprint", restoreTitle);
    };
    const dateLabel = new Date().toISOString().slice(0, 10);
    document.title = `赔了么-离职证据准备清单-${dateLabel}`;
    window.addEventListener("afterprint", restoreTitle, { once: true });
    showToast("正在打开 PDF 保存界面，请选择“存储为 PDF”。");
    window.setTimeout(() => window.print(), 80);
    window.setTimeout(restoreTitle, 30000);
  };

  return (
    <section className="paid-section paid-upgrade-section">
      {showIntro && <PaidIntroCard result={result} answers={answers} />}

      <article className={paidModules.caseLawPack ? "paid-card paid-feature-card module-section-card lavender active" : "paid-card paid-feature-card module-section-card paid-preview-card lavender active"}>
        <div className="module-section-header">
          <div className="feature-badge raised-layer raised-layer-square" aria-hidden="true">法</div>
          <div className="module-section-heading">
            <h2>案例法条包</h2>
            <p>你这种情况对应的劳动法与相关案例</p>
          </div>
        </div>
        <div className="case-law-delivery">
          <div className="legal-pack-summary">
            <p>{legalPack.summary}</p>
          </div>
          <div className={paidModules.caseLawPack ? "paid-unlocked-content" : "paid-preview-lock locked-output"}>
          <section className="legal-pack-section" aria-label="与你情况相关的法条（由《劳动合同法》中筛选）">
          <div className="legal-pack-section-heading">
            <h3>与你情况相关的法条（由《劳动合同法》中筛选）</h3>
            <span>{rootLegalCitations.filter(citation => getLaborLawArticle(citation.articleId)).length} 条法条</span>
          </div>
          <div className="legal-articles-deck">
          {rootLegalCitations.map((citation, citationIndex) => {
            const article = getLaborLawArticle(citation.articleId);
            if (!article) return null;

            return (
              <article
                className={`legal-article-card legal-article-card--showcase legal-article-card--${citationIndex % 2 === 0 ? "yellow" : "blue"}`}
                key={citation.articleId}
              >
                <div className="legal-article-layout">
                  <aside className="legal-article-index" aria-hidden="true">
                    <strong>{String(citationIndex + 1).padStart(2, "0")}</strong>
                  </aside>
                  <div className="legal-article-content">
                    <h3 className={getArticleTitleBadge(article.id) ? "has-title-badge" : undefined}>
                      <span>{article.title}</span>
                      {getArticleTitleBadge(article.id) && <em className="legal-article-title-badge">{getArticleTitleBadge(article.id)}</em>}
                    </h3>
                    <div className="legal-article-rule" aria-hidden="true" />
                    <div className="legal-article-copy">
                      {article.lines.map((line) =>
                        renderLawLine(
                          line,
                          citation,
                          expandLinkedArticle
                        )
                      )}
                    </div>
                    {renderExpandedLinkedArticles(citation.articleId)}
                  </div>
                </div>
              </article>
            );
          })}
          </div>
          </section>
          <LegalCaseGallery result={result} answers={answers} />
          </div>
          {paidModules.caseLawPack ? (
            <button className="download-pack-button raised-layer raised-layer-primary" type="button" onClick={downloadCaseLawPack}>
              下载案例法条包
            </button>
          ) : (
            <button className="download-pack-button raised-layer raised-layer-primary" type="button" onClick={() => setPaywallModule("caseLawPack")}>
              解锁完整案例法条包
            </button>
          )}
        </div>
        {!paidModules.caseLawPack && <button className="paid-preview-cta raised-layer raised-layer-primary" type="button" onClick={() => setPaywallModule("caseLawPack")}>解锁完整案例法条包</button>}
      </article>

      <article className={paidModules.evidencePack ? "paid-card paid-feature-card module-section-card active" : "paid-card paid-feature-card module-section-card paid-preview-card active"}>
        <div className="module-section-header">
          <div className="feature-badge raised-layer raised-layer-square" aria-hidden="true">证</div>
          <div className="module-section-heading">
            <h2>离职证据包</h2>
            <p>需要准备什么证据？</p>
          </div>
        </div>
        <div className="legal-pack-summary evidence-pack-intro">
          <p>{evidenceChecklist.userTip}</p>
        </div>
        {paidModules.evidencePack ? (
          <>
            <EvidenceChecklistView key={evidenceChecklist.key} checklist={evidenceChecklist}
              selected={visibleEvidenceSelections} onToggle={toggleEvidence} />
            <div className="evidence-download-panel evidence-download-simple">
              {evidenceSaveFailed && <small className="evidence-storage-warning" role="alert">
                进度未能保存到当前设备，刷新后可能丢失。可先下载清单留存。
              </small>}
              <button className="download-pack-button raised-layer raised-layer-primary" type="button" onClick={downloadEvidencePack}>下载证据准备清单（PDF）</button>
            </div>
          </>
        ) : (
          <div className="legal-pack-section evidence-preview-panel">
            <div className="legal-pack-section-heading"><h3>{evidenceChecklist.title ?? "证据准备清单"}</h3></div>
            <div className="evidence-preview-tags">
              {evidenceChecklist.sections[0].items.map(item => <em key={item.id}>{item.name}</em>)}
            </div>
          </div>
        )}
        {!paidModules.evidencePack && <button className="paid-preview-cta raised-layer raised-layer-primary" type="button" onClick={() => setPaywallModule("evidencePack")}>解锁完整离职证据包</button>}
      </article>

      <article className="paid-card paid-feature-card module-section-card document-review-module lavender active">
        <div className="module-section-header">
          <div className="feature-badge raised-layer raised-layer-square" aria-hidden="true">签</div>
          <div className="module-section-heading">
            <h2>签前文件检查</h2>
            <p>HR给的文件能不能签？</p>
          </div>
        </div>
        <DocumentReview unlocked={paidModules.documentReview} onUnlock={() => setPaywallModule("documentReview")} />
      </article>

      <EvidencePrintDocument
        checklist={evidenceChecklist}
        selectedEvidence={visibleEvidenceSelections}
        reasonText={selectedReasonPath.join(" → ")}
        generatedAt={new Intl.DateTimeFormat("zh-CN", { dateStyle: "long", timeStyle: "short" }).format(new Date())}
      />

      <p className="legal-note paid-legal-note">
        本功能仅提供离职协议风险初步识别和材料整理参考，不构成正式法律意见。重大争议或高金额案件建议咨询专业律师。
      </p>

      {toast && <div className="paid-toast">{toast}</div>}

      {paywallModule && <ModuleUnlockDialog onClose={() => setPaywallModule(null)} onConfirm={() => unlockModule(paywallModule)} />}

    </section>
  );
}


