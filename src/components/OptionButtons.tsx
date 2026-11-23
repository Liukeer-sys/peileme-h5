import { useEffect, useRef, useState } from "react";

type OptionButtonsProps = {
  options: string[];
  onChoose: (option: string) => void;
  variant?: "default" | "city" | "bonus" | "work-schedule" | "wish" | "termination-root" | "forced-reason" | "dismiss-reason" | "fault-reason" | "fault-truth" | "no-fault-reason" | "contract-expired";
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
  { title: "劳动合同没到期，公司要我走", legalType: "", detail: "公司想提前让我离职，包括协商、犯错、客观变化等情况" },
  { title: "劳动合同到期，不再续签", legalType: "", detail: "合同到期后，公司或我不准备继续签" },
  { title: "公司完全没有了", legalType: "", detail: "比如公司破产、解散、注销，没法继续雇人了" }
];

const forcedReasonLabels: StructuredOptionLabel[] = [
  { title: "工资被拖欠或克扣", legalType: "", detail: "该发的钱没按时、足额发给我" },
  { title: "公司没依法给我交社保", legalType: "", detail: "该交的社保一直没给我交" },
  { title: "工作条件没按约定提供", legalType: "", detail: "该有的工作条件、劳动保护，公司没给" },
  { title: "公司制度违法，还坑到了我", legalType: "", detail: "违法的规定实际损害了我的权益" },
  { title: "签劳动合同时被坑了", legalType: "", detail: "被骗、被逼着签，或者合同里有违法内容" },
  { title: "公司用暴力、威胁逼我工作", legalType: "", detail: "比如打人、威胁伤害或限制自由，不让我离开" },
  { title: "公司逼我冒险作业", legalType: "", detail: "明知可能危及人身安全，仍违规命令我去做" },
  { title: "其他情况", legalType: "", detail: "不属于以上情况，但公司的做法仍让我不得不离职" }
];

const companyDismissReasonLabels: StructuredOptionLabel[] = [
  { title: "公司找我协商解除劳动合同", legalType: "", detail: "公司主动和我谈补偿，希望双方同意后离职" },
  { title: "公司说是我的错", legalType: "", detail: "违纪、失职、试用不合格之类" },
  { title: "我没犯错，但公司说没法继续用我", legalType: "", detail: "身体、能力或岗位变化等原因" },
  { title: "公司要大规模裁员", legalType: "", detail: "裁员20人以上，或达到员工总数10%" }
];

const faultReasonLabels: StructuredOptionLabel[] = [
  { title: "试用期没通过", legalType: "", detail: "公司说我不符合入职时约定的录用条件" },
  { title: "严重违反公司制度", legalType: "", detail: "公司说我的行为已经达到严重违纪" },
  { title: "严重失职，造成重大损失", legalType: "", detail: "公司说我犯了大错，给公司造成重大损失" },
  { title: "还在其他单位工作", legalType: "", detail: "严重影响本职工作，或被要求改正后仍没改" },
  { title: "入职时提供了虚假信息", legalType: "", detail: "公司说我用欺骗方式签订合同，导致合同无效" },
  { title: "被依法追究刑事责任", legalType: "", detail: "不是只被调查，而是已经被追究刑事责任" },
  { title: "其他问题或没说清楚", legalType: "", detail: "公司说的理由不在上面，或者只笼统说我不合适" }
];

const faultTruthLabels: StructuredOptionLabel[] = [
  { title: "基本属实", legalType: "", detail: "公司说的情况大体没错" },
  { title: "有这回事，但不确定严重程度", legalType: "", detail: "不知道是否严重到可以直接辞退我" },
  { title: "公司在乱扣帽子", legalType: "", detail: "事情不存在，或者公司夸大其词" }
];

const noFaultReasonLabels: StructuredOptionLabel[] = [
  { title: "身体原因，实在干不了了", legalType: "", detail: "医疗期结束，原岗位和公司另安排的岗位都做不了" },
  { title: "公司说我不能胜任工作", legalType: "", detail: "培训过或换过岗位，还是说我干不了" },
  { title: "原来的工作条件变了，双方没谈拢", legalType: "", detail: "比如工作地点、业务等发生大变化，没谈拢新的安排" },
  { title: "都不是，公司就是想赶我走", legalType: "", detail: "上面的情况都对不上，我认为公司是在找理由辞退" }
];

const contractExpiredLabels: StructuredOptionLabel[] = [
  { title: "公司不愿意续签", legalType: "", detail: "合同到期后，公司明确不再和我签下一份合同" },
  { title: "公司照旧续，是我不想续", legalType: "", detail: "公司愿意按原来或更好的条件续签，是我自己决定离开" },
  { title: "公司降低续签条件，我没同意", legalType: "", detail: "公司愿意续签，但工资、岗位等条件比原来差" }
];

const workScheduleLabels = [
  { title: "双休不加班", detail: "基本到点走人" },
  { title: "双休偶尔加班", detail: "工作日有时晚下班，周末偶有“临时需求”" },
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
  const isStructuredTermination = variant === "termination-root" || variant === "forced-reason" || variant === "dismiss-reason" || variant === "fault-reason" || variant === "fault-truth" || variant === "no-fault-reason" || variant === "contract-expired";
  const structuredLabels = variant === "contract-expired" ? contractExpiredLabels : variant === "forced-reason" ? forcedReasonLabels : variant === "dismiss-reason" ? companyDismissReasonLabels : variant === "fault-reason" ? faultReasonLabels : variant === "fault-truth" ? faultTruthLabels : variant === "no-fault-reason" ? noFaultReasonLabels : terminationRootLabels;
  const gridClassName =
    variant === "city"
      ? "option-grid city-option-grid"
      : variant === "bonus"
        ? "option-grid bonus-option-grid"
      : variant === "work-schedule"
        ? "option-grid work-schedule-option-grid"
      : variant === "wish"
        ? "option-grid wish-option-grid"
      : (variant === "termination-root" || variant === "forced-reason" || variant === "dismiss-reason" || variant === "fault-reason" || variant === "fault-truth" || variant === "no-fault-reason" || variant === "contract-expired")
        ? "option-grid termination-root-option-grid"
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
                : (variant === "termination-root" || variant === "forced-reason" || variant === "dismiss-reason" || variant === "fault-reason" || variant === "fault-truth" || variant === "no-fault-reason" || variant === "contract-expired")
                  ? `option-button termination-root-option${isSelectedOption ? " is-selected" : ""}`
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

  const pickerHeading = (detail: string) => (
    <div className="city-picker-heading">
      <span className="city-picker-heading-copy">
        <small>{detail}</small>
      </span>
    </div>
  );

  if (variant === "city") {
    return (
      <div className="city-picker">
        {pickerHeading("用于匹配当地工资与社保口径")}
        {optionGrid}
      </div>
    );
  }

  if (variant === "work-schedule") {
    return (
      <div className="work-schedule-picker">
        {pickerHeading("不用特别精确，按长期工作状态判断")}
        {optionGrid}
      </div>
    );
  }

  if (variant === "bonus") {
    return (
      <div className="city-picker bonus-picker">
        {pickerHeading("按过去一年实际发放情况选择")}
        {optionGrid}
      </div>
    );
  }

  if (variant === "wish") {
    return (
      <div className="city-picker wish-picker">
        {pickerHeading("按你最想实现的愿望选择")}
        {optionGrid}
      </div>
    );
  }

  return (
    <div className="city-picker standard-option-picker">
      {pickerHeading("按实际情况选择最接近的一项")}
      {optionGrid}
    </div>
  );
}
