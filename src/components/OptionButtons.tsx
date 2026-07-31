import { useEffect, useRef, useState } from "react";

type OptionButtonsProps = {
  options: string[];
  onChoose: (option: string) => void;
  variant?: "default" | "city" | "bonus" | "work-schedule" | "wish" | "termination-root" | "forced-reason" | "dismiss-reason" | "no-fault-reason" | "contract-expired";
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
  { title: "我自己想离职", legalType: "", detail: "单纯因为个人原因不干了" },
  { title: "公司逼得我不得不走", legalType: "", detail: "比如公司欠薪、不交社保等，我只能被迫辞职" },
  { title: "公司要我走", legalType: "", detail: "合同还没到期，公司就想提前让我离职" },
  { title: "合同到期，不再续签", legalType: "", detail: "到期后，公司或我不准备继续签" },
  { title: "公司完全没有了", legalType: "", detail: "比如公司破产、解散、注销，没法继续雇人了" }
];

const forcedReasonLabels: StructuredOptionLabel[] = [
  { title: "工资被拖欠或克扣", legalType: "", detail: "该发的钱没按时、足额发给我" },
  { title: "公司没依法给我交社保", legalType: "", detail: "该交的社保一直没给我交" },
  { title: "工作条件没按约定提供", legalType: "", detail: "该有的工作条件、劳动保护，公司没给" },
  { title: "公司制度违法，还坑到了我", legalType: "", detail: "违法的规定实际损害了我的权益" },
  { title: "签劳动合同时被坑了", legalType: "", detail: "被骗、被逼着签，或者合同里有违法内容" },
  { title: "公司威胁我，甚至限制我自由", legalType: "", detail: "暴力、威胁、不让我走，强迫我继续工作" },
  { title: "公司逼我做危险的事", legalType: "", detail: "明知有危险，还强令我冒险作业" },
  { title: "其他情况", legalType: "", detail: "上面都不太像，我自己描述" }
];

const companyDismissReasonLabels: StructuredOptionLabel[] = [
  { title: "公司说是我的错", legalType: "", detail: "违纪、失职、试用不合格之类" },
  { title: "我没犯错，但公司说没法继续用我", legalType: "", detail: "身体、能力或岗位变化等原因" },
  { title: "公司要大规模裁员", legalType: "", detail: "裁员20人以上，或达到员工总数10%" }
];

const noFaultReasonLabels: StructuredOptionLabel[] = [
  { title: "身体原因，实在干不了了", legalType: "", detail: "医疗期结束，原岗位和公司另安排的岗位都做不了" },
  { title: "公司说我不能胜任工作", legalType: "", detail: "培训过或换过岗位，还是说我干不了" },
  { title: "原来的工作条件变了，双方没谈拢", legalType: "", detail: "比如工作地点、业务等发生大变化，没谈拢新的安排" },
  { title: "都不是，公司就是想赶我走", legalType: "", detail: "上面的情况都对不上，我认为公司是在找理由辞退" }
];

const contractExpiredLabels: StructuredOptionLabel[] = [
  { title: "公司不续签", legalType: "通常参考 N", detail: "有眼无珠，不要续签我了" },
  { title: "我不续签", legalType: "通常无补偿", detail: "老娘（老子）不干了" },
  { title: "公司降低续签条件", legalType: "通常参考 N", detail: "原来的条件都不给，我不签了，我值得更好的" }
];

const workScheduleLabels = [
  { title: "双休，很少加班", detail: "基本到点走人" },
  { title: "双休，但不定期加班", detail: "工作日有时晚下班，周末偶有“临时需求”" },
  { title: "大小周", detail: "隔周休一天" },
  { title: "单休", detail: "每周仅休一天" }
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

const wishOptionImages = [
  "/whattodo/1大吃.png",
  "/whattodo/2出门玩.png",
  "/whattodo/3宅家.png",
  "/whattodo/4练出.png",
  "/whattodo/5看世界.png",
  "/whattodo/6升级.png",
  "/whattodo/7喝酒.png",
  "/whattodo/8当老板.png"
];

function WishOptionIcon({ index }: { index: number }) {
  return <img src={wishOptionImages[index]} alt="" aria-hidden="true" />;
}
export default function OptionButtons({ options, onChoose, variant = "default" }: OptionButtonsProps) {
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const selectionTimerRef = useRef<number | null>(null);
  const isStructuredTermination = variant === "termination-root" || variant === "forced-reason" || variant === "dismiss-reason" || variant === "no-fault-reason" || variant === "contract-expired";
  const structuredLabels = variant === "contract-expired" ? contractExpiredLabels : variant === "forced-reason" ? forcedReasonLabels : variant === "dismiss-reason" ? companyDismissReasonLabels : variant === "no-fault-reason" ? noFaultReasonLabels : terminationRootLabels;
  const gridClassName =
    variant === "city"
      ? "option-grid city-option-grid"
      : variant === "bonus"
        ? "option-grid bonus-option-grid"
      : variant === "work-schedule"
        ? "option-grid work-schedule-option-grid"
      : variant === "wish"
        ? "option-grid wish-option-grid"
      : (variant === "termination-root" || variant === "forced-reason" || variant === "dismiss-reason" || variant === "no-fault-reason")
        ? "option-grid termination-root-option-grid"
        : variant === "contract-expired"
          ? "option-grid contract-expired-option-grid"
          : "option-grid";

  useEffect(
    () => () => {
      if (selectionTimerRef.current !== null) window.clearTimeout(selectionTimerRef.current);
    },
    []
  );

  const chooseOption = (option: string) => {
    if (selectedOption) return;
    setSelectedOption(option);
    selectionTimerRef.current = window.setTimeout(() => onChoose(option), 180);
  };

  const optionGrid = (
    <div className={gridClassName}>
      {options.map((option, index) => {
        const wishCopy = variant === "wish" ? getWishOptionCopy(option, index) : undefined;
        const isSelectedOption = selectedOption === option;

        return (
          <button
            key={option}
            className={
              variant === "city"
                ? `option-button city-option-button${isSelectedOption ? " is-selected" : ""}`
                : variant === "bonus"
                  ? `option-button city-option-button bonus-option-button${isSelectedOption ? " is-selected" : ""}`
                : variant === "work-schedule"
                  ? `option-button work-schedule-option-button work-schedule-option-${index + 1}${isSelectedOption ? " is-selected" : ""}`
                : variant === "wish"
                  ? `option-button wish-option-button${isSelectedOption ? " is-selected" : ""}`
                : (variant === "termination-root" || variant === "forced-reason" || variant === "dismiss-reason" || variant === "no-fault-reason")
                  ? `option-button termination-root-option${isSelectedOption ? " is-selected" : ""}`
                  : variant === "contract-expired"
                    ? `option-button termination-root-option contract-expired-option${isSelectedOption ? " is-selected" : ""}`
                    : `option-button city-option-button standard-option-button${isSelectedOption ? " is-selected" : ""}`
            }
            type="button"
            disabled={selectedOption !== null}
            aria-pressed={isSelectedOption}
            onClick={() => chooseOption(option)}
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
            {variant === "work-schedule" && (
              <>
                <span className="work-schedule-copy">
                  <strong>{workScheduleLabels[index]?.title || option}</strong>
                  <small>{workScheduleLabels[index]?.detail}</small>
                </span>
              </>
            )}
            {isStructuredTermination ? (
              <>
                {structuredLabels[index]?.legalType && (
                  <span className="termination-legal-type">{structuredLabels[index].legalType}</span>
                )}
                <strong>{structuredLabels[index]?.title || option}</strong>
                <small>{structuredLabels[index]?.detail}</small>
              </>
            ) : variant !== "wish" && variant !== "work-schedule" ? (
              <span>
                {option}
                {variant === "city" && option === "其他城市" && <span className="city-option-chevron">›</span>}
              </span>
            ) : null}
            {isSelectedOption && (
              <span className="option-selected-check">✓</span>
            )}
          </button>
        );
      })}
    </div>
  );

  if (variant === "city") {
    return (
      <div className="city-picker">
        <div className="city-picker-heading">
          <strong>选择工作城市</strong>
          <small>用于匹配当地工资与社保口径</small>
        </div>
        {optionGrid}
      </div>
    );
  }

  if (variant === "work-schedule") {
    return (
      <div className="work-schedule-picker">
        <div className="city-picker-heading">
          <strong>选择工作节奏</strong>
          <small>不用特别精确，按长期工作状态判断</small>
        </div>
        {optionGrid}
      </div>
    );
  }

  if (variant === "bonus") {
    return (
      <div className="city-picker bonus-picker">
        <div className="city-picker-heading">
          <strong>选择年终奖情况</strong>
          <small>按过去一年实际发放情况选择</small>
        </div>
        {optionGrid}
      </div>
    );
  }

  if (variant !== "default" && variant !== "forced-reason" && variant !== "dismiss-reason" && variant !== "no-fault-reason") return optionGrid;

  return (
    <div className="city-picker standard-option-picker">
      <div className="city-picker-heading">
        <strong>选择具体情况</strong>
        <small>按实际情况选择最接近的一项</small>
      </div>
      {optionGrid}
    </div>
  );
}


