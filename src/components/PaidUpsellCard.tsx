import { useEffect, useMemo, useState } from "react";
import { buildEvidenceChecklist, getEvidenceCompleteness, priorityLabels } from "../data/evidenceChecklist";
import { getLaborLawArticle, getLaborLawPack, type LaborLawArticle, type LaborLawCitation } from "../data/laborLawReferences";
import type { Answers } from "../types";
import type { CalculationResult } from "../utils/calculate";
import { useAuth } from "../auth/AuthContext";
import { track } from "../lib/api";

type PaidModuleKey = "caseLawPack" | "evidencePack";
type CaseLawSectionKey = "laws";

import type { ReactNode } from 'react';

type LegalCaseReference = {
  title: string;
  scenario: string;
  focus: string;
  evidence: string[];
};

type ActiveLegalCase = {
  articleTitle: string;
  line: string;
  highlight: string;
  cases: LegalCaseReference[];
};

type ExpandedLinkedArticle = {
  article: LaborLawArticle;
  sourceArticleId: string;
  sourceArticleTitle: string;
};

type PaidCoreProps = {
  result: CalculationResult;
  answers: Answers;
};

type PaidUpsellCardProps = PaidCoreProps & {
  showIntro?: boolean;
  assessmentId?: string;
  onRequireAuth?: () => void;
  onOpenAccount?: () => void;
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
  article46: "赔偿情形官方清单",
  article47: "计算赔偿官方方法"
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

const nestedLawTargets = [
  { text: '第二十六条', articleId: 'article26' },
  { text: '第八十七条', articleId: 'article87' },
  { text: '第四十七条', articleId: 'article47' }
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
  sourceArticleTitle: string,
  onLinkedArticle: (article: LaborLawArticle, sourceArticleId: string, sourceArticleTitle: string) => void
) => {
  const linkTargets = [
    { text: '第四十七条', articleId: 'article47' },
    { text: "第二十六条", articleId: "article26" },
    { text: "第八十七条", articleId: "article87" }
  ];
  const target = linkTargets.find((item) => line.includes(item.text));
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
          onLinkedArticle(article, sourceArticleId, sourceArticleTitle);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          onLinkedArticle(article, sourceArticleId, sourceArticleTitle);
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
  articleTitle: string,
  summary: string,
  onCaseReference: (caseReference: ActiveLegalCase) => void,
  onLinkedArticle: (article: LaborLawArticle, sourceArticleId: string, sourceArticleTitle: string) => void
) => {
  const matchedHighlight = getCitationHighlights(citation).find((highlight) => line.includes(highlight));

  if (matchedHighlight) {
    if (noCaseReferenceArticleIds.has(citation.articleId)) {
      return (
        <p className="legal-article-line highlighted" key={line}>
          <span className="legal-highlight-label">重点</span>
          {renderInlineLinkedLawText(line, citation.articleId, articleTitle, onLinkedArticle)}
        </p>
      );
    }

    return (
      <button
        className="legal-article-line highlighted legal-article-button"
        key={line}
        type="button"
        onClick={() =>
          onCaseReference({
            articleTitle,
            line,
            highlight: matchedHighlight,
            cases: getCitationCaseReferences(citation, matchedHighlight, summary)
          })
        }
      >
        <span className="legal-highlight-label">重点</span>
        <span>{renderInlineLinkedLawText(line, citation.articleId, articleTitle, onLinkedArticle)}</span>
        <span className="legal-case-tip">点我看案例参考</span>
      </button>
    );
  }

  return (
    <p className="legal-article-line" key={line}>
      {renderInlineLinkedLawText(line, citation.articleId, articleTitle, onLinkedArticle)}
    </p>
  );
};

const getSelectedReasonPath = (answers: Answers, result: CalculationResult) => {
  const rawText = answers.terminationReasonText || result.terminationHint;
  const seen = new Set<string>();
  return rawText
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => item !== result.terminationInferredType)
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
};

export function SelectedReasonCard({ result, answers }: PaidCoreProps) {
  const selectedReasonPath = useMemo(() => getSelectedReasonPath(answers, result), [answers, result]);
  return (
    <div className="selected-reason-card">
      <span>你刚刚选择的是：</span>
      <div className="selected-reason-path">
        {selectedReasonPath.map((item, index) => (
          <div className="selected-reason-step" key={`${item}-${index}`}>
            {index > 0 && <small aria-hidden="true">↓</small>}
            <b>{item}</b>
          </div>
        ))}
      </div>
      <div className="selected-reason-conclusion">
        结论：<strong>{result.terminationInferredType}</strong>
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

export function PaidIntroCard(props: PaidCoreProps) {
  return (
    <>
      <SelectedReasonCard {...props} />
      <PaidNextStepCard />
    </>
  );
}
export default function PaidUpsellCard({
  result,
  answers,
  showIntro = true,
  onRequireAuth,
  onOpenAccount
}: PaidUpsellCardProps) {
  const { user, grants } = useAuth();
  const [selectedEvidence, setSelectedEvidence] = useState<Record<string, boolean>>({});
  const [paidModules, setPaidModules] = useState<Record<PaidModuleKey, boolean>>({
    caseLawPack: false,
    evidencePack: false
  });
  const [paywallModule, setPaywallModule] = useState<PaidModuleKey | null>(null);
  const [activeLegalCase, setActiveLegalCase] = useState<ActiveLegalCase | null>(null);
  const [expandedLinkedArticles, setExpandedLinkedArticles] = useState<ExpandedLinkedArticle[]>([]);
  const [activeLinkedArticle, setActiveLinkedArticle] = useState<LaborLawArticle | null>(null);
  const [toast, setToast] = useState("");

  useEffect(() => {
    setPaidModules({
      caseLawPack: grants.some((grant) => grant.module === "caseLawPack"),
      evidencePack: grants.some((grant) => grant.module === "evidencePack")
    });
  }, [grants]);

  const evidenceChecklist = useMemo(() => buildEvidenceChecklist(result, answers), [answers, result]);
  const evidenceCompleteness = getEvidenceCompleteness(evidenceChecklist, selectedEvidence);
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
  const selectedReasonPath = useMemo(() => getSelectedReasonPath(answers, result), [answers, result]);
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

  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 1800);
  };

  const expandLinkedArticle = (article: LaborLawArticle, sourceArticleId: string, sourceArticleTitle: string) => {
    const expansionId = 'linked-' + sourceArticleId + '-' + article.id;
    setExpandedLinkedArticles((current) => {
      if (current.some((item) => item.sourceArticleId === sourceArticleId && item.article.id === article.id)) return current;
      return [...current, { article, sourceArticleId, sourceArticleTitle }];
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
          <div className={'legal-linked-origin'}>
            <span>嵌套法条</span>
            <b>由{linkedArticle.sourceArticleTitle.replace('《劳动合同法》', '')}中的链接展开</b>
          </div>
          <h3>{linkedArticle.article.title}</h3>
          {linkedArticle.article.lines.map((line) => (
            <p className={'legal-article-line'} key={line}>
              {renderInlineLinkedLawText(
                line,
                linkedArticle.article.id,
                linkedArticle.article.title,
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
    setPaywallModule(null);
    track("paid_module_unlock_clicked", { module, loggedIn: Boolean(user) });
    if (!user) {
      onRequireAuth?.();
      return;
    }
    onOpenAccount?.();
  };

  const toggleEvidence = (item: string) => {
    setSelectedEvidence((current) => ({ ...current, [item]: !current[item] }));
  };

  const downloadCaseLawPack = () => {
    const content = displayedCaseLawSections
      .map((section) => [section.title, ...section.downloadItems.map((item, index) => `${index + 1}. ${item}`)].join("\n"))
      .join("\n\n");
    const blob = new Blob([`赔了么案例法条包\n\n${content}`], { type: "text/plain;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "赔了么-案例法条包.txt";
    link.click();
    window.URL.revokeObjectURL(url);
    showToast("案例法条包已开始下载。");
  };

  return (
    <section className="paid-section paid-upgrade-section">
      {showIntro && <PaidIntroCard result={result} answers={answers} />}

      <article className={paidModules.caseLawPack ? "paid-card paid-feature-card lavender active" : "paid-card paid-feature-card paid-preview-card lavender active"}>
        <div className="feature-badge">法</div>
        <h2>案例法条包</h2>
        <p className="paid-module-lead">你的这种情况对应劳动法：</p>
        <div className="case-law-delivery">
          <div className="legal-pack-summary">
            <p>{legalPack.summary}</p>
            <span>以下法条是根据你的情况，从《劳动合同法》中筛选出来的适配条款。</span>
          </div>
          <div className={paidModules.caseLawPack ? "paid-unlocked-content" : "paid-preview-lock locked-output"}>
          {rootLegalCitations.map((citation) => {
            const article = getLaborLawArticle(citation.articleId);
            if (!article) return null;

            return (
              <article className="legal-article-card" key={citation.articleId}>
                <h3>
                  <span>{article.title}</span>
                  {getArticleTitleBadge(article.id) && <em className="legal-article-title-badge">{getArticleTitleBadge(article.id)}</em>}
                </h3>
                {article.lines.map((line) => renderLawLine(line, citation, article.title, legalPack.summary, setActiveLegalCase, expandLinkedArticle))}
                {renderExpandedLinkedArticles(citation.articleId)}
              </article>
            );
          })}
          </div>
          {paidModules.caseLawPack ? (
            <button className="download-pack-button" type="button" onClick={downloadCaseLawPack}>
              下载案例法条包
            </button>
          ) : (
            <button className="download-pack-button" type="button" onClick={() => setPaywallModule("caseLawPack")}>
              解锁完整案例法条包
            </button>
          )}
        </div>
        {!paidModules.caseLawPack && <button className="paid-preview-cta" type="button" onClick={() => setPaywallModule("caseLawPack")}>解锁完整案例法条包</button>}
      </article>

      <article className={paidModules.evidencePack ? "paid-card paid-feature-card active" : "paid-card paid-feature-card paid-preview-card active"}>
        <div className="feature-badge">证</div>
        <h2>离职证据包</h2>
        <p className="paid-module-lead">我需要准备什么证据？</p>
        <div className="evidence-meter"><span style={{ width: `${evidenceCompleteness}%` }} />证据完整度：{evidenceCompleteness}%</div>
        {paidModules.evidencePack ? (
          <>
            <div className="review-output">
              <strong>重点要证明</strong>
              {evidenceChecklist.proofFocus.slice(0, 4).map((focus) => <span key={focus}>{focus}</span>)}
              <b>{evidenceChecklist.userTip}</b>
              {evidenceChecklist.riskTip && <span>{evidenceChecklist.riskTip}</span>}
            </div>
            <div className="evidence-card-list paid-unlocked-content">
              {[...evidenceChecklist.commonEvidence, ...evidenceChecklist.reasonEvidence].map((section) => (
                <details className="evidence-card" key={section.id} open={section.id === "termination_fact" || section.id === evidenceChecklist.reasonEvidence[0]?.id}>
                  <summary>
                    <strong>{section.title}</strong>
                    <span>{section.description}</span>
                  </summary>
                  <div className="evidence-chip-list">
                    {section.items.map((item) => (
                      <label className="evidence-chip" key={item.id} title={`${item.purpose} 可上传：${item.examples.join("、")}`}>
                        <input type="checkbox" checked={Boolean(selectedEvidence[item.id])} onChange={() => toggleEvidence(item.id)} />
                        <span>{item.name}</span>
                        <em>{priorityLabels[item.priority]}</em>
                      </label>
                    ))}
                  </div>
                </details>
              ))}
            </div>
            <div className="review-output">
              <strong>证据包摘要</strong>
              <span>已按你的离职原因生成基础证据和个性化证据清单。</span>
              <span>勾选已有材料后，可以先看证据完整度；未勾选的必备项就是下一步要补的重点。</span>
            </div>
          </>
        ) : (
          <div className="evidence-preview-panel">
            <strong>重点要证明</strong>
            {evidenceChecklist.proofFocus.slice(0, 2).map((focus) => <span key={focus}>{focus}</span>)}
            <b>{evidenceChecklist.userTip}</b>
            <div className="evidence-preview-tags">
              {[...evidenceChecklist.commonEvidence, ...evidenceChecklist.reasonEvidence].slice(0, 4).map((section) => (
                <em key={section.id}>{section.title}</em>
              ))}
            </div>
          </div>
        )}
        {!paidModules.evidencePack && <button className="paid-preview-cta" type="button" onClick={() => setPaywallModule("evidencePack")}>解锁完整离职证据包</button>}
      </article>

      <p className="legal-note paid-legal-note">
        本功能提供政策测算、法规依据和证据整理参考，不构成正式法律意见。重大争议或高金额案件建议咨询专业律师。
      </p>

      {toast && <div className="paid-toast">{toast}</div>}

      {paywallModule && (
        <div className="paywall-overlay" role="dialog" aria-modal="true">
          <div className="paywall-modal paid-card">
            <div className="card-label">完整内容权限</div>
            <h2>{user ? "兑换邀请码解锁" : "登录后解锁完整内容"}</h2>
            <p>{user ? "在个人中心输入有效邀请码，即可开通案例法条包和证据包。" : "登录后可保存测算，并使用邀请码解锁完整内容。"}</p>
            <button className="primary-button" type="button" onClick={() => unlockModule(paywallModule)}>
              {user ? "前往个人中心兑换" : "登录 / 注册"}
            </button>
            <button className="ghost-button" type="button" onClick={() => setPaywallModule(null)}>先不解锁</button>
          </div>
        </div>
      )}

      {activeLegalCase && (
        <div className="paywall-overlay" role="dialog" aria-modal="true">
          <div className="paywall-modal paid-card">
            <div className="card-label">案例参考</div>
            <h2>{activeLegalCase.articleTitle}</h2>
            <p className="legal-selected-line">
              <strong>你点的是：{activeLegalCase.highlight}</strong>
              <span>{activeLegalCase.line}</span>
            </p>
            <div className="legal-case-reference-list">
              {activeLegalCase.cases.map((item) => (
                <article className="legal-case-reference-card" key={item.title}>
                  <h3>{item.title}</h3>
                  <p><b>场景：</b>{item.scenario}</p>
                  <p><b>争议重点：</b>{item.focus}</p>
                  <p><b>建议证据：</b>{item.evidence.join("、")}</p>
                </article>
              ))}
            </div>
            <button className="primary-button" type="button" onClick={() => setActiveLegalCase(null)}>返回法条</button>
          </div>
        </div>
      )}

      {activeLinkedArticle && (
        <div className="paywall-overlay" role="dialog" aria-modal="true">
          <div className="paywall-modal paid-card">
            <div className="card-label">嵌套法条</div>
            <h2>{activeLinkedArticle.title}</h2>
            <div className="legal-article-list linked-article-lines">
              {activeLinkedArticle.lines.map((line) => (
                <p className="legal-article-line" key={line}>{line}</p>
              ))}
            </div>
            <button className="primary-button" type="button" onClick={() => setActiveLinkedArticle(null)}>返回第三十九条</button>
          </div>
        </div>
      )}
    </section>
  );
}
























