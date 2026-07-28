type OptionButtonsProps = {
  options: string[];
  onChoose: (option: string) => void;
  variant?: "default" | "wish" | "termination-root" | "contract-expired";
};

type StructuredOptionLabel = {
  title: string;
  legalType: string;
  detail: string;
};

type WishOptionCopy = {
  title: string;
  detail: string;
};

const terminationRootLabels: StructuredOptionLabel[] = [
  { title: "自己提出辞职", legalType: "劳动合同解除", detail: "包括单位太恶毒，被迫辞职" },
  { title: "单位要辞退我", legalType: "劳动合同解除", detail: "由单位提出解除劳动合同" },
  { title: "劳动合同期满不续", legalType: "劳动合同终止", detail: "合同到期后不再续签" },
  { title: "完全没有了", legalType: "劳动合同终止", detail: "公司遇到变故，呜呜呜" }
];

const contractExpiredLabels: StructuredOptionLabel[] = [
  { title: "公司不续签", legalType: "通常参考 N", detail: "有眼无珠，不要续签我了" },
  { title: "我不续签", legalType: "通常无补偿", detail: "老娘（老子）不干了" },
  { title: "公司降低续签条件", legalType: "通常参考 N", detail: "原来的条件都不给，我不签了，我值得更好的" }
];

const getWishOptionCopy = (option: string, index: number): WishOptionCopy => {
  const copies: WishOptionCopy[] = [
    { title: "先大吃特吃一顿", detail: "前司画的饼不顶饿，吃点实在的把自己喂饱" },
    { title: "出门玩个痛快", detail: "去演唱会、去看剧、去游乐场，把快乐补回来" },
    { title: "宅家躺到爽", detail: "毫无顾虑地追剧、打游戏，谁也别想叫我开会" },
    { title: "练出新肉身", detail: "要强身健体，日后好暴打老板" },
    { title: "去看看世界", detail: "工位留给别人，海风和远方留给自己" },
    { title: "给自己装备升级", detail: "忧愁下一段工作，先给自己升级下办公装备吧" },
    { title: "去喝个痛快", detail: "敬自由一杯，但签字的时候记得清醒" },
    { title: "这次自己当老板", detail: "老板有眼无珠，我自己当老板不比ta弱！" }
  ];
  return copies[index] || { title: option, detail: "离职之后，先把自己照顾好" };
};

function WishOptionIcon({ index }: { index: number }) {
  const commonProps = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true
  };

  switch (index) {
    case 0:
      return <svg {...commonProps}><path d="M4 11h16c-.5 4.4-3.4 7-8 7s-7.5-2.6-8-7Z"/><path d="M8 7c-1-1.2.8-2.1 0-3.3M12 7c-1-1.2.8-2.1 0-3.3M16 7c-1-1.2.8-2.1 0-3.3"/><path d="M7 20h10"/></svg>;
    case 1:
      return <svg {...commonProps}><path d="M4 7a2 2 0 0 0 2-2h12a2 2 0 0 0 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 0-2 2H6a2 2 0 0 0-2-2v-3a2 2 0 0 0 0-4V7Z"/><path d="M12 6v2M12 11v2M12 16v2"/><path d="m8.5 10 .6 1.2 1.4.2-1 .9.2 1.4-1.2-.7-1.2.7.2-1.4-1-.9 1.4-.2.6-1.2Z"/></svg>;
    case 2:
      return <svg {...commonProps}><rect x="3" y="5" width="18" height="13" rx="2"/><path d="m10 9 5 2.5-5 2.5V9ZM8 21h8M12 18v3"/></svg>;
    case 3:
      return <svg {...commonProps}><path d="M7 8v8M4 10v4M17 8v8M20 10v4M7 12h10M2 11v2M22 11v2"/></svg>;
    case 4:
      return <svg {...commonProps}><circle cx="17" cy="6" r="2.5"/><path d="M3 16c2-1.7 4-1.7 6 0s4 1.7 6 0 4-1.7 6 0M3 20c2-1.7 4-1.7 6 0s4 1.7 6 0 4-1.7 6 0"/><path d="M8 13c.3-4 1.8-6.8 4.5-8M10 8c-1.8-1.2-3.5-1.2-5 0M11 6c1.7-1.5 3.4-1.7 5-.7"/></svg>;
    case 5:
      return <svg {...commonProps}><path d="m12 3 1.4 4.6L18 9l-4.6 1.4L12 15l-1.4-4.6L6 9l4.6-1.4L12 3Z"/><path d="m18.5 14 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2ZM5 14l.6 1.5L7 16l-1.4.5L5 18l-.6-1.5L3 16l1.4-.5L5 14Z"/></svg>;
    case 6:
      return <svg {...commonProps}><path d="M5 4h14l-6 7v7M9 20h8"/><path d="M7 7h10"/><path d="M17 3v3M15.5 4.5h3"/></svg>;
    default:
      return <svg {...commonProps}><path d="M14 4c2.7-1.4 5-1.5 6-1-0.1 2.5-1.3 5.4-3.7 7.8l-4.2 4.2-4.8-4.8L11.5 6c.8-.8 1.6-1.4 2.5-2Z"/><circle cx="15.5" cy="7.5" r="1.5"/><path d="M8.5 12.5 5 13l-2 2 5.2.8M11.5 15.5 11 19l-2 2-.8-5.2M5 19c.5-1.7 1.5-2.7 3-3"/></svg>;
  }
}

export default function OptionButtons({ options, onChoose, variant = "default" }: OptionButtonsProps) {
  const isStructuredTermination = variant === "termination-root" || variant === "contract-expired";
  const structuredLabels = variant === "contract-expired" ? contractExpiredLabels : terminationRootLabels;
  const gridClassName =
    variant === "wish"
      ? "option-grid wish-option-grid"
      : variant === "termination-root"
        ? "option-grid termination-root-option-grid"
        : variant === "contract-expired"
          ? "option-grid contract-expired-option-grid"
          : "option-grid";

  return (
    <div className={gridClassName}>
      {options.map((option, index) => {
        const wishCopy = variant === "wish" ? getWishOptionCopy(option, index) : undefined;
        return (
          <button
            key={option}
            className={
              variant === "wish"
                ? "option-button wish-option-button"
                : variant === "termination-root"
                  ? "option-button termination-root-option"
                  : variant === "contract-expired"
                    ? "option-button termination-root-option contract-expired-option"
                    : "option-button"
            }
            type="button"
            onClick={() => onChoose(option)}
          >
            {wishCopy && (
              <>
                <span className="wish-option-icon"><WishOptionIcon index={index} /></span>
                <span className="wish-option-copy">
                  <strong>{wishCopy.title}</strong>
                  <small>{wishCopy.detail}</small>
                </span>
              </>
            )}
            {isStructuredTermination ? (
              <>
                <span className="termination-legal-type">{structuredLabels[index]?.legalType || "离职情形"}</span>
                <strong>{structuredLabels[index]?.title || option}</strong>
                <small>{structuredLabels[index]?.detail}</small>
              </>
            ) : variant !== "wish" ? (
              <span>{option}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}





