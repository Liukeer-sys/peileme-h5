import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion, useMotionValue, useSpring, useTransform } from "motion/react";
import type { CalculationResult } from "../utils/calculate";
import { formatMoney } from "../utils/calculate";
import { getPersonaImageSrc, splitPersonaCopy } from "../utils/persona";
import { getEquivalentIconSrc } from "../data/equivalentIconMap";

type ResultCardProps = {
  result: CalculationResult;
  onSticker: (equivalentId: string) => void;
  postExitWish?: string;
  onReselectWish: () => void;
  reasonStepCount: number;
  selectionSummary?: import("react").ReactNode;
  children?: import("react").ReactNode;
};

const renderLevelCopy = (copy: string) =>
  copy.split(/(\d+(?:\.\d+)?\s*(?:年|天|小时))/g).map((part, index) =>
    /^\d+(?:\.\d+)?\s*(?:年|天|小时)$/.test(part) ? (
      <strong className="time-emphasis" key={`${part}-${index}`}>
        {part}
      </strong>
    ) : (
      part
    )
  );

const renderFormulaWithNMarker = (formula: string, serviceYears: number) => {
  const nValue = String(serviceYears);
  const candidates = [`× ${nValue}`, `（${nValue}`];
  const matched = candidates
    .map((token) => ({ token, index: formula.lastIndexOf(token) }))
    .filter(({ index }) => index >= 0)
    .sort((left, right) => right.index - left.index)[0];

  if (!matched) return formula;

  const insertAt = matched.index + matched.token.length;
  return (
    <>
      {formula.slice(0, insertAt)}
      <small className="formula-n-marker">（N）</small>
      {formula.slice(insertAt)}
    </>
  );
};

function AutoFitPersonaName({ name }: { name: string }) {
  const nameRef = useRef<HTMLHeadingElement | null>(null);

  useLayoutEffect(() => {
    const element = nameRef.current;
    if (!element) return;
    let frame = 0;
    let disposed = false;
    const retryTimers: number[] = [];

    const fitName = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (disposed || element.clientWidth <= 0) return;
        element.style.removeProperty("font-size");
        let size = Number.parseFloat(window.getComputedStyle(element).fontSize) || 30;
        element.style.fontSize = `${size}px`;
        while (element.scrollWidth > element.clientWidth && size > 14) {
          size -= 0.5;
          element.style.fontSize = `${size}px`;
        }
      });
    };

    fitName();
    [80, 240, 700].forEach((delay) => retryTimers.push(window.setTimeout(fitName, delay)));
    void document.fonts?.ready.then(() => {
      if (!disposed) fitName();
    });

    const resizeObserver = new ResizeObserver(fitName);
    resizeObserver.observe(element);
    if (element.parentElement) resizeObserver.observe(element.parentElement);
    window.addEventListener("resize", fitName);
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      retryTimers.forEach((timer) => window.clearTimeout(timer));
      resizeObserver.disconnect();
      window.removeEventListener("resize", fitName);
    };
  }, [name]);

  return <h2 ref={nameRef} title={name}>{name}</h2>;
}
function AutoFitAmountRange({
  lowAmount,
  highAmount,
  alternativeLowAmount,
  alternativeHighAmount,
  alternativeDisputeLabel
}: {
  lowAmount: number;
  highAmount: number;
  alternativeLowAmount?: number;
  alternativeHighAmount?: number;
  alternativeDisputeLabel?: string;
}) {
  const amountRef = useRef<HTMLDivElement | null>(null);
  const hasAlternativeRange = alternativeLowAmount !== undefined && alternativeHighAmount !== undefined;
  const mainLabel = hasAlternativeRange
    ? `${formatMoney(0)} 或 ${formatMoney(alternativeLowAmount)} - ${formatMoney(alternativeHighAmount)}`
    : lowAmount === 0 && highAmount === 0
      ? formatMoney(0)
      : `${formatMoney(lowAmount)} - ${formatMoney(highAmount)}`;
  const label = alternativeDisputeLabel ? `${mainLabel}（${alternativeDisputeLabel}）` : mainLabel;

  useLayoutEffect(() => {
    const element = amountRef.current;
    if (!element) return;
    let frame = 0;
    const fitAmount = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        element.style.fontSize = "";
        let size = Number.parseFloat(window.getComputedStyle(element).fontSize) || 52;
        element.style.fontSize = `${size}px`;
        const minimumSize = hasAlternativeRange ? 28 : 36;
        while (element.scrollWidth > element.clientWidth && size > minimumSize) {
          size -= 1;
          element.style.fontSize = `${size}px`;
        }
      });
    };
    fitAmount();
    const resizeObserver = new ResizeObserver(fitAmount);
    resizeObserver.observe(element.parentElement || element);
    window.addEventListener("resize", fitAmount);
    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      window.removeEventListener("resize", fitAmount);
    };
  }, [hasAlternativeRange, label]);

  return (
    <div className={`amount-range${hasAlternativeRange ? " is-discrete" : ""}`} ref={amountRef} title={label}>
      {hasAlternativeRange ? (
        <>
          <span className="amount-range-main">
            <span>{formatMoney(0)}</span>
            <span className="amount-range-or">或</span>
            <span>{formatMoney(alternativeLowAmount)} - {formatMoney(alternativeHighAmount)}</span>
          </span>
          {alternativeDisputeLabel && <span className="amount-range-dispute">（{alternativeDisputeLabel}）</span>}
        </>
      ) : mainLabel}
    </div>
  );
}

function AutoFitEquivalentName({ name }: { name: string }) {
  const nameRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const element = nameRef.current;
    if (!element) return;
    let frame = 0;
    const fitName = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        element.classList.remove("is-wrapped");
        element.style.fontSize = "";
        let size = Number.parseFloat(window.getComputedStyle(element).fontSize) || 22;
        element.style.fontSize = `${size}px`;
        while (element.scrollWidth > element.clientWidth && size > 12) {
          size -= 0.5;
          element.style.fontSize = `${size}px`;
        }
        element.classList.toggle("is-wrapped", element.scrollWidth > element.clientWidth);
      });
    };
    fitName();
    window.addEventListener("resize", fitName);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", fitName);
    };
  }, [name]);

  return <div className="equivalent-name" ref={nameRef} title={name}>{name}</div>;
}

function AutoFitEquivalentQuantity({ count, unit }: { count: number; unit: string }) {
  const quantityRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const element = quantityRef.current;
    if (!element) return;
    let frame = 0;
    const fitQuantity = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        element.style.fontSize = "";
        let size = Number.parseFloat(window.getComputedStyle(element).fontSize) || 48;
        element.style.fontSize = `${size}px`;
        while (element.scrollWidth > element.clientWidth && size > 26) {
          size -= 1;
          element.style.fontSize = `${size}px`;
        }
      });
    };
    fitQuantity();
    window.addEventListener("resize", fitQuantity);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", fitQuantity);
    };
  }, [count, unit]);

  return (
    <strong className="equivalent-quantity" ref={quantityRef} title={`${count}${unit}`}>
      <span>{count}</span><em>{unit}</em>
    </strong>
  );
}

const splitLifestyleCopy = (copy?: string) => {
  if (!copy) return { lead: "", roast: "" };
  const firstSentence = copy.match(/^.*?[。！？!?](?=\s*.)/);
  if (!firstSentence) return { lead: copy.trim(), roast: "" };
  return {
    lead: firstSentence[0].trim(),
    roast: copy.slice(firstSentence[0].length).trim()
  };
};

function OrphanAwareRoast({ text }: { text: string }) {
  const textRef = useRef<HTMLSpanElement | null>(null);

  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element) return;
    let frame = 0;

    const readLines = () => {
      const textNode = element.firstChild;
      if (!(textNode instanceof Text)) return [] as string[];
      const lines: Array<{ top: number; text: string }> = [];
      let offset = 0;

      Array.from(textNode.data).forEach((character) => {
        const range = document.createRange();
        const nextOffset = offset + character.length;
        range.setStart(textNode, offset);
        range.setEnd(textNode, nextOffset);
        const rect = range.getBoundingClientRect();
        offset = nextOffset;
        if (!rect.width && !rect.height) return;

        const currentLine = lines.find((line) => Math.abs(line.top - rect.top) < 1);
        if (currentLine) currentLine.text += character;
        else lines.push({ top: rect.top, text: character });
      });

      return lines.sort((left, right) => left.top - right.top).map((line) => line.text);
    };

    const isSingleCharacterPeriodLine = (line = "") => {
      const compactLine = line.replace(/\s/g, "");
      return Array.from(compactLine).length === 2 && compactLine.endsWith("。");
    };

    const fitOrphanEnding = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        element.style.letterSpacing = "";
        const initialLines = readLines();
        if (!isSingleCharacterPeriodLine(initialLines[initialLines.length - 1])) return;

        for (let spacing = -0.1; spacing >= -2; spacing -= 0.1) {
          element.style.letterSpacing = `${spacing.toFixed(1)}px`;
          if (readLines().length < initialLines.length) return;
        }

        element.style.letterSpacing = "";
      });
    };

    fitOrphanEnding();
    void document.fonts.ready.then(fitOrphanEnding);
    window.addEventListener("resize", fitOrphanEnding);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", fitOrphanEnding);
    };
  }, [text]);

  return <span className="equivalent-lifestyle-roast" ref={textRef}>{text}</span>;
}

const renderHighlightedEquivalentLead = (lead: string, count: number) => {
  const countText = String(count);
  const start = lead.indexOf(countText);
  if (start < 0) return lead;
  const remaining = lead.slice(start);
  const punctuationOffset = remaining.search(/[。！？!?]/);
  const end = punctuationOffset >= 0 ? start + punctuationOffset : lead.length;
  return (
    <>
      {lead.slice(0, start)}
      <strong>{lead.slice(start, end)}</strong>
      {lead.slice(end)}
    </>
  );
};

const getIconGroup = (category: string) => {
  if (["咖啡", "奶茶", "加班续命", "酒精疗愈"].includes(category)) return "drink";
  if (["午饭", "外卖", "早餐", "城市美食"].includes(category)) return "food";
  if (["数码", "AI会员", "会员", "办公装备"].includes(category)) return "tech";
  if (category === "新能源车") return "car";
  if (["租房", "生活成本", "家电", "家具"].includes(category)) return "home";
  if (["旅行", "学习提升"].includes(category)) return "travel";
  if (category === "黄金") return "gold";
  return "health";
};

const paletteMap: Record<string, string[]> = {
  food: ["#fff8ea", "#e8d3ad", "#c8a46b", "#785f42"],
  drink: ["#fff4df", "#e3c89e", "#b88d5b", "#66513f"],
  tech: ["#eef1f4", "#c7cfd8", "#6d7c90", "#3d4f6b"],
  home: ["#f7f0e2", "#e6d7bc", "#b9a074", "#6e5a3d"],
  travel: ["#f4f1e9", "#d8dee3", "#8796a8", "#4e6077"],
  car: ["#f5f0e6", "#dfd5c3", "#a99779", "#596679"],
  gold: ["#fff1cf", "#d8b871", "#b08a57", "#705633"],
  health: ["#f7eee0", "#e5d2b5", "#c19b68", "#755a3f"]
};

export function EquivalentIcon({ id, category, name }: { id: string; category: string; name: string }) {
  const equivalentIconSrc = getEquivalentIconSrc(id, name);
  if (equivalentIconSrc) {
    return <img src={equivalentIconSrc} alt={name} />;
  }

  const group = getIconGroup(category);
  const [soft, mid, deep, ink] = paletteMap[group];
  const gradientId = `icon-${group}-${name.replace(/\W/g, "")}`;

  const common = (
    <>
      <rect width="128" height="128" rx="30" fill={`url(#${gradientId}-bg)`} />
      <circle cx="91" cy="34" r="7" fill="rgba(255,255,255,.76)" />
    </>
  );

  const body =
    group === "drink" ? (
      <>
        <rect x="35" y="34" width="58" height="68" rx="18" fill={`url(#${gradientId}-body)`} />
        <path d="M43 45h42l-5 49H48z" fill="rgba(255,255,255,.35)" />
        <rect x="44" y="58" width="40" height="18" rx="9" fill="rgba(255,255,255,.58)" />
        <path d="M86 52c16 0 18 30 1 34" fill="none" stroke={deep} strokeWidth="8" strokeLinecap="round" />
      </>
    ) : group === "food" ? (
      <>
        <ellipse cx="64" cy="80" rx="42" ry="18" fill="rgba(71,55,42,.13)" />
        <rect x="26" y="48" width="76" height="42" rx="18" fill={`url(#${gradientId}-body)`} />
        <ellipse cx="64" cy="50" rx="38" ry="18" fill="rgba(255,255,255,.55)" />
        <circle cx="51" cy="48" r="8" fill="rgba(255,255,255,.72)" />
        <path d="M39 64h50" stroke="rgba(255,255,255,.58)" strokeWidth="6" strokeLinecap="round" />
      </>
    ) : group === "tech" ? (
      <>
        <rect x="30" y="34" width="68" height="56" rx="16" fill={`url(#${gradientId}-body)`} />
        <rect x="38" y="43" width="52" height="32" rx="10" fill="rgba(255,255,255,.55)" />
        <rect x="48" y="93" width="32" height="8" rx="4" fill={deep} opacity=".55" />
        <path d="M54 59h21" stroke={ink} strokeWidth="5" strokeLinecap="round" opacity=".34" />
      </>
    ) : group === "car" ? (
      <>
        <path d="M27 72c5-18 18-29 37-29s33 10 40 29" fill={`url(#${gradientId}-body)`} />
        <rect x="24" y="64" width="80" height="28" rx="14" fill={`url(#${gradientId}-body)`} />
        <path d="M48 50h33c7 0 13 7 16 14H34c4-8 8-14 14-14z" fill="rgba(255,255,255,.62)" />
        <circle cx="43" cy="92" r="8" fill={ink} opacity=".62" />
        <circle cx="88" cy="92" r="8" fill={ink} opacity=".62" />
      </>
    ) : group === "home" ? (
      <>
        <path d="M31 62l33-27 33 27v36c0 5-4 9-9 9H40c-5 0-9-4-9-9z" fill={`url(#${gradientId}-body)`} />
        <path d="M42 61l22-18 22 18" fill="none" stroke="rgba(255,255,255,.76)" strokeWidth="7" strokeLinecap="round" />
        <rect x="54" y="76" width="20" height="31" rx="8" fill="rgba(255,255,255,.58)" />
      </>
    ) : group === "travel" ? (
      <>
        <rect x="39" y="40" width="50" height="64" rx="14" fill={`url(#${gradientId}-body)`} />
        <path d="M52 40v-7c0-5 4-9 9-9h6c5 0 9 4 9 9v7" fill="none" stroke={deep} strokeWidth="7" strokeLinecap="round" />
        <path d="M50 58h28M50 73h28" stroke="rgba(255,255,255,.6)" strokeWidth="6" strokeLinecap="round" />
      </>
    ) : group === "gold" ? (
      <>
        <path d="M34 78l10-28h40l10 28z" fill={`url(#${gradientId}-body)`} />
        <path d="M48 78l8-22h37l9 22z" fill="rgba(255,255,255,.35)" />
        <ellipse cx="52" cy="91" rx="17" ry="9" fill={mid} opacity=".88" />
      </>
    ) : (
      <>
        <rect x="34" y="36" width="60" height="66" rx="18" fill={`url(#${gradientId}-body)`} />
        <path d="M48 57h32M48 72h25" stroke="rgba(255,255,255,.68)" strokeWidth="6" strokeLinecap="round" />
        <path d="M64 37v22M53 48h22" stroke={deep} strokeWidth="7" strokeLinecap="round" />
      </>
    );

  return (
    <svg viewBox="0 0 128 128" role="img" aria-label={name}>
      <defs>
        <linearGradient id={`${gradientId}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={soft} />
          <stop offset="1" stopColor="#efe4c9" />
        </linearGradient>
        <linearGradient id={`${gradientId}-body`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity=".9" />
          <stop offset=".48" stopColor={mid} />
          <stop offset="1" stopColor={deep} />
        </linearGradient>
        <filter id={`${gradientId}-shadow`} x="-20%" y="-20%" width="140%" height="150%">
          <feDropShadow dx="0" dy="8" stdDeviation="8" floodColor="#3d4f6b" floodOpacity=".16" />
        </filter>
      </defs>
      {common}
      <g filter={`url(#${gradientId}-shadow)`}>{body}</g>
    </svg>
  );
}

type RuleItemProps = {
  children: import("react").ReactNode;
};

function RuleItem({ children }: RuleItemProps) {
  return <li>{children}</li>;
}

function CalculationFooter() {
  return (
    <div className="calculation-note-stage">
      <p className="legal-note calculation-note-copy">
        本结果仅为离职赔偿预评估，不构成正式法律意见。具体金额和风险需结合材料进一步判断。
      </p>
    </div>
  );
}
export default function ResultCard({ result, onSticker, postExitWish, onReselectWish, reasonStepCount, selectionSummary, children }: ResultCardProps) {
  const [equivalentIndex, setEquivalentIndex] = useState(0);
  const [personaImageFailed, setPersonaImageFailed] = useState(false);
  const experienceRef = useRef<HTMLElement | null>(null);


  const personaScrollTarget = useMotionValue(0);
  const personaSpring = useSpring(personaScrollTarget, { stiffness: 245, damping: 10.5, mass: 0.68 });
  const heroScale = useTransform(personaSpring, [0, 1], [1, 0.89]);
  const heroY = useTransform(personaSpring, [0, 1], [0, 30]);
  const heroRadius = useTransform(personaSpring, [0, 1], ["0px 0px 28px 28px", "28px"]);
  const imageScale = useTransform(personaSpring, [0, 0.62, 1], [1, 1.22, 1.34]);
  const imageY = useTransform(personaSpring, [0, 0.62, 1], [0, -44, -76]);
  const overlayY = useTransform(personaSpring, [0, 1], [0, -20]);
  const storyOpacity = useTransform(personaSpring, [0, 0.68, 1], [1, 0.48, 0.2]);
  const copyOpacity = useTransform(personaSpring, [0, 1], [1, 0.5]);
  const heroShadow = useTransform(personaSpring, [0, 1], ["0 0 0 rgba(35, 28, 42, 0)", "0 24px 58px rgba(35, 28, 42, 0.34)"]);
  const currentEquivalent = result.equivalents[equivalentIndex] || result.equivalents[0];
  const lifestyleCopy = splitLifestyleCopy(currentEquivalent?.lifestyleCopy);
  const personaParagraphs = splitPersonaCopy(result.levelCopy);
  const personaImageSrc = getPersonaImageSrc(result.level);

  useEffect(() => setEquivalentIndex(0), [result]);

  useEffect(() => setPersonaImageFailed(false), [personaImageSrc]);
  useEffect(() => {
    const root = experienceRef.current;
    const scrollParent = root?.closest(".result-page") as HTMLElement | null;
    if (!root || !scrollParent) return;
    let frame = 0;

    const updatePersonaMotion = () => {
      if (scrollParent.scrollLeft !== 0) scrollParent.scrollLeft = 0;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const motionDistance = Math.max(220, scrollParent.clientHeight * 0.42);
        const scrollOffset = Math.max(scrollParent.scrollTop, window.scrollY);
        personaScrollTarget.set(Math.min(1, Math.max(0, scrollOffset / motionDistance)));
      });
    };

    updatePersonaMotion();
    scrollParent.addEventListener("scroll", updatePersonaMotion, { passive: true });
    window.addEventListener("scroll", updatePersonaMotion, { passive: true });
    window.addEventListener("resize", updatePersonaMotion);
    return () => {
      window.cancelAnimationFrame(frame);
      scrollParent.removeEventListener("scroll", updatePersonaMotion);
      window.removeEventListener("scroll", updatePersonaMotion);
      window.removeEventListener("resize", updatePersonaMotion);
    };
  }, [personaScrollTarget, result.level]);


  const changeEquivalent = () => {
    if (result.equivalents.length < 2) return;
    setEquivalentIndex((current) => (current + 1) % result.equivalents.length);
  };

  const calculationRules = [
    <><b>经济补偿年限 N：</b>{result.serviceYears}（按 {result.serviceYears} 个月工资计算）</>,
    <><b>估算月工资基数：</b>{formatMoney(result.adjustedMonthlySalary)}（{result.salaryBaseFormula}）</>,
    <><b>可能适用规则：</b>{result.ruleHint}</>,
    <><b>赔偿计算公式：</b>{renderFormulaWithNMarker(result.compensationFormula, result.serviceYears)}</>,
  ];

  return (
    <section className="result-stack interactive-result" ref={experienceRef}>
      <div className="persona-visual-stage" aria-label="牛马身份互动封面">
        <motion.div className="persona-hero-media" style={{ y: heroY, scale: heroScale, borderRadius: heroRadius, boxShadow: heroShadow }}>

          {!personaImageFailed ? (
            <motion.img
              className="persona-hero-image"
              style={{ y: imageY, scale: imageScale }}
              src={personaImageSrc}
              alt={result.level}
              onError={() => setPersonaImageFailed(true)}
            />
          ) : (
            <div className="persona-hero-fallback" aria-hidden="true">
              <span>牛</span>
              <small>身份图鉴</small>
            </div>
          )}
          <div className="persona-hero-scrim" />
          <motion.div className="persona-hero-story" style={{ y: overlayY, opacity: storyOpacity }}>
            {personaParagraphs.map((paragraph, index) => (
              <p className={index === personaParagraphs.length - 1 ? "persona-story-punchline" : "persona-story-lead"} key={index}>
                {renderLevelCopy(paragraph)}
              </p>
            ))}
          </motion.div>
          <motion.div className="persona-hero-copy" style={{ y: overlayY, opacity: copyOpacity }}>
            <div className="card-label">你的牛马身份</div>
            <AutoFitPersonaName name={result.level} />
          </motion.div>
        </motion.div>
      </div>

      <section className="persona-bottom-sheet">
        <div className="persona-sheet-grabber" aria-label="上拉查看牛马身价">
          <span />
          <b>上拉查看牛马身价</b>
        </div>

        <div className="persona-sheet-summary">
          <div className="worth-summary">
            <div className="eyebrow">你的牛马身价（离职赔偿金）</div>
            <AutoFitAmountRange
              lowAmount={result.lowAmount}
              highAmount={result.highAmount}
              alternativeLowAmount={result.alternativeLowAmount}
              alternativeHighAmount={result.alternativeHighAmount}
              alternativeDisputeLabel={
                result.ruleHint === "0 / N 争议区间"
                  ? "0/N 争议"
                  : result.ruleHint === "0 / 2N 争议区间"
                    ? "0/2N 争议"
                    : undefined
              }
            />
          </div>

          {postExitWish && (
            <div className="wish-choice-summary">
              <div className="wish-choice-summary-copy">
                <span>离职后，你选择了：</span>
                <strong>{postExitWish}</strong>
              </div>
              <button className="result-reset-button" type="button" onClick={onReselectWish}>重选</button>
            </div>
          )}

          <div className="equivalent-grid" aria-label="赔偿金额等价物">
            {currentEquivalent && (
              <div className="equivalent-pill" key={currentEquivalent.id}>
                <button className="equivalent-change-button" type="button" onClick={changeEquivalent}>换一换</button>
                <div className="equivalent-lifestyle-copy">
                  <div className="equivalent-lifestyle-lead">
                    {renderHighlightedEquivalentLead(lifestyleCopy.lead, currentEquivalent.count)}
                  </div>
                  {lifestyleCopy.roast && <OrphanAwareRoast text={lifestyleCopy.roast} />}
                </div>
                <div className="equivalent-side-actions">
                  <div className="equivalent-icon" aria-hidden="true">
                    <EquivalentIcon id={currentEquivalent.id} category={currentEquivalent.category} name={currentEquivalent.name} />
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="hero-result-actions">
            <button
              className="persona-sticker-button"
              type="button"
              onClick={() => currentEquivalent && onSticker(currentEquivalent.id)}
              disabled={!currentEquivalent}
            >
              生成我的牛马身份卡
            </button>
            <button
              className="calculation-details-link"
              type="button"
              onClick={() => document.getElementById("calculation-details")?.scrollIntoView({ behavior: "smooth" })}
            >
              查看赔偿怎么算 ↓
            </button>
          </div>
        </div>

        <div className="info-card persona-calculation-details module-section-card" id="calculation-details">
          <div className="module-section-header">
            <div className="feature-badge raised-layer raised-layer-square" aria-hidden="true">算</div>
            <div className="module-section-heading">
              <h2>计算过程与规则说明</h2>
              <p>你的赔偿是怎么算出来的？</p>
            </div>
          </div>
          {selectionSummary}
          <div className={`calculation-rule-motion ${reasonStepCount % 2 === 0 ? "line-from-left" : "line-from-right"}`}>
            <ul className="rule-list calculation-rule-copy">
              {calculationRules.map((rule, index) => (
                <RuleItem key={index}>{rule}</RuleItem>
              ))}
            </ul>
            <CalculationFooter />
          </div>
        </div>      </section>
      {children && <div className="persona-sticky-tail">{children}</div>}
    </section>
  );
}


















