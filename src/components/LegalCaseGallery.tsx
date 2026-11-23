import { useId, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { Answers } from "../types";
import type { CalculationResult } from "../utils/calculate";
import { getPresentedCases, type PresentedCase } from "../data/legalCasePresentation";
import { getCaseStackPositions } from "../utils/caseStack";

export function CaseSectionIcon({ kind }: { kind: "result" | "tip" }) {
  return <svg className="case-reader-section-icon" viewBox="0 0 24 24" width="14" height="14"
    fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false">
    {kind === "result" ? <>
      <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" />
      <path d="M14 3v5h5M9 12h6M9 16h6" />
    </> : <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6" />
      <circle cx="12" cy="7.5" r="1" fill="currentColor" stroke="none" />
    </>}
  </svg>;
}

function CaseReader({ cases }: { cases: PresentedCase[] }) {
  const [index, setIndex] = useState(0);
  const readerId = useId();
  const reduceMotion = useReducedMotion();
  const cardRef = useRef<HTMLElement>(null);
  const scrollAfterSwitch = useRef(false);
  const changeCase = (delta: number) => {
    scrollAfterSwitch.current = true;
    setIndex(current => (current + delta + cases.length) % cases.length);
  };
  const visiblePositions = getCaseStackPositions(cases.length, index);
  const duration = reduceMotion ? 0 : 0.36;
  return (
    <>
      <div className="case-reader-stack">
      {visiblePositions.map((position, stackPosition) => {
        const item = cases[position];
        const expanded = position === index;
        const panelId = `${readerId}-panel-${position}`;
        return <motion.article ref={expanded ? cardRef : undefined}
          layout={reduceMotion ? false : "position"}
          initial={false}
          transition={{ duration, ease: [0.22, 1, 0.36, 1] }}
          style={{ zIndex: expanded ? 6 : stackPosition + 1 }}
          className={`case-reader-card ${expanded ? "is-expanded" : "is-collapsed"}`}
          key={item.key} aria-label={item.title}>
        <div className="case-reader-topline">
          <button type="button" className="case-reader-toggle" aria-expanded={expanded}
            aria-controls={panelId} aria-label={`${expanded ? "当前" : "展开"}案例：${item.title}`}
            onClick={() => {
              if (expanded) return;
              scrollAfterSwitch.current = false;
              setIndex(position);
            }}>
            <span className="case-reader-meta">
              {item.city && <span className="case-reader-city">{item.city}</span>}
              <span className="case-reader-kind">{item.kind}</span>
            </span>
            <span className="case-reader-chevron" aria-hidden="true">{expanded ? "" : "+"}</span>
          </button>
          {expanded && <a className="case-reader-source" href={item.sourceUrl} target="_blank" rel="noreferrer">
            查看原文 <span className="case-reader-source-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor"
                strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" focusable="false">
                <path d="M4 12 12 4M4 4h8v8" />
              </svg>
            </span>
          </a>}
        </div>
        <motion.div id={panelId} className="case-reader-panel" aria-hidden={!expanded} inert={!expanded}
          initial={false}
          animate={{ height: expanded ? "auto" : 0, opacity: expanded ? 1 : 0 }}
          transition={{ duration, ease: [0.22, 1, 0.36, 1] }}
          onAnimationComplete={() => {
            if (expanded && scrollAfterSwitch.current) {
              scrollAfterSwitch.current = false;
              const card = cardRef.current;
              // 仅当标题已在可视区上方时定位，避免动画结束后再做一次平滑位移。
              if (card && card.getBoundingClientRect().top < 0) {
                card.scrollIntoView({ block: "start", inline: "nearest", behavior: "instant" });
              }
            }
          }}>
        <div className="case-reader-body">
        <h3 className="case-reader-title">{item.title}</h3>
        <div className="case-reader-story">
          {item.paragraphs.map((paragraph, paragraphIndex) => <p key={paragraphIndex}>{paragraph}</p>)}
        </div>
        {item.outcome && <div className="case-reader-result">
          <span><CaseSectionIcon kind="result" />{item.outcomeLabel}</span>
          <p>{item.outcome}</p>
        </div>}
        <div className="case-reader-result case-reader-tip">
          <span><CaseSectionIcon kind="tip" />小提示</span>
          <p>{item.relation}</p>
        </div>
        </div>
        </motion.div>
      </motion.article>;
      })}
      </div>
      {cases.length > 1 && <nav className="case-reader-navigation" aria-label="切换参考案例">
        <button type="button" onClick={() => changeCase(-1)} aria-label="上一例">← 上一例</button>
        <span aria-live="polite" aria-atomic="true">案例 {index + 1} / {cases.length}</span>
        <button type="button" onClick={() => changeCase(1)} aria-label="下一例">下一例 →</button>
      </nav>}
    </>
  );
}

export default function LegalCaseGallery({ result, answers }: { result: CalculationResult; answers: Answers }) {
  const matching = useMemo(() => getPresentedCases(result.terminationReasonId, answers), [result.terminationReasonId, answers]);
  const experience = result.terminationReasonId === "company_proposed_mutual_termination";
  const browseForced = result.terminationReasonId === "forced_other_or_unclear";
  const browseFault = result.terminationReasonId === "fault_reason_other_or_unclear";
  const browseCompensation = result.terminationReasonId === "nofault_not_listed_excuse";
  const title = browseCompensation ? "违法解除赔偿参考案例" : browseFault ? "过错解除参考案例" : browseForced ? "被迫离职参考案例" : experience ? "协商离职经历参考" : "与你情况相关的案例";
  return (
    <section className="case-reader" aria-label={title}>
      <div className="case-reader-heading"><h3>{title}</h3><span>{matching.cases.length} {experience ? "段经历" : "个案例"}</span></div>
      {browseForced && <p className="case-reader-note">这里汇总了被迫离职的各类案例，你可以浏览与自己经历相似的情况。</p>}
      {browseFault && <p className="case-reader-note">这里汇总了公司以员工过错为由解除劳动合同的各类案例，你可以浏览与自己经历相似的情况。</p>}
      {browseCompensation && <p className="case-reader-note">以下案例均支持了违法解除赔偿。你可以对照公司的解除理由和证据，是否适用你的情况还需具体判断。</p>}
      {matching.cases.length ? <CaseReader
        key={`${result.terminationReasonId}:${matching.cases.map((item) => item.key).join(",")}`}
        cases={matching.cases}
      /> : <div className="case-reader-empty">
        <strong>{matching.needsMoreDetail ? "还需要更具体的离职原因" : "暂未找到与你情况接近的案例"}</strong>
        <p>{matching.needsMoreDetail ? "可以返回离职情况，补充公司具体做了什么，再查看相关案例。" : "目前收录的案例还不足以对应这一情形。"}</p>
      </div>}
      <p className="case-reader-note">{experience
        ? "个人经历仅供参考，协商条件因人、因公司而异。"
        : "案例仅供参考，具体结果取决于你的实际情况、证据和当地裁审口径。"}</p>
    </section>
  );
}
