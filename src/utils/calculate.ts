import { getTerminationType } from "../data/terminationTypes";
import { getWishEquivalentPool, type WishEquivalentItem } from "../data/wishEquivalents";
import type { Answers } from "../types";

export type ResultEquivalent = {
  id: string;
  category: string;
  name: string;
  unit: string;
  tag: string;
  count: number;
  note?: string;
  displayValue: string;
  lifestyleCopy: string;
};

export type CalculationResult = {
  city: string;
  serviceYears: number;
  serviceDays: number;
  estimatedGrossSalary: number;
  adjustedMonthlySalary: number;
  baseCompensation: number;
  lowAmount: number;
  highAmount: number;
  alternativeLowAmount?: number;
  alternativeHighAmount?: number;
  ruleHint: string;
  ruleReason: string;
  salaryBaseFormula: string;
  compensationFormula: string;
  terminationHint: string;
  terminationInferredType: string;
  terminationNote: string;
  level: string;
  levelCopy: string;
  roast: string;
  equivalents: ResultEquivalent[];
  needsFurtherReview: boolean;
  terminationReasonId: string;
};

const parseMonth = (value?: string) => {
  if (!value) return new Date();
  const [year, month] = value.split("-").map(Number);
  if (!year || !month) return new Date();
  return new Date(year, month - 1, 1);
};

const monthDiff = (start: Date, end: Date) => {
  const months = (end.getFullYear() - start.getFullYear()) * 12 + end.getMonth() - start.getMonth();
  return Math.max(months, 0);
};

const calcServiceYears = (startMonth?: string, endMonth?: string) => {
  const months = monthDiff(parseMonth(startMonth), parseMonth(endMonth));
  const fullYears = Math.floor(months / 12);
  const remainMonths = months % 12;
  if (months === 0) return 0.5;
  if (remainMonths === 0) return fullYears;
  return fullYears + (remainMonths >= 6 ? 1 : 0.5);
};

const bonusMultiplierMap: Record<string, number> = {
  "没有": 0,
  "1个月工资左右": 1,
  "2个月工资左右": 2,
  "3个月以上": 3,
  "不固定 / 说不准": 0
};

type WorkhorsePersona = {
  name: string;
  copy: string;
};

const chooseWorkhorsePersona = (answers: Answers, years: number, takeHomeSalary: number): WorkhorsePersona => {
  const wish = answers.postExitWish || "";
  const hasHeavyOvertime = ["大小周", "单休"].includes(answers.workSchedule || "");
  const hasLongTenure = years >= 5;
  const hasLowSalary = takeHomeSalary > 0 && takeHomeSalary < 8000;
  const hasHighSalary = takeHomeSalary >= 20000;
  const hasLowBonus =
    answers.bonusLevel === "没有" ||
    /没有年终奖|不固定[，,]?偶尔有一点/.test(answers.bonusInfo || "");

  if (/先.*吃|大吃特吃/.test(wish)) {
    if (hasHeavyOvertime) {
      return {
        name: "加班饿狼（已出笼版",
        copy: "每次加班老板都装模作样给我打气，说“你要有狼性”。我默念：“狼行千里吃肉，狗行千里吃屎。”现在我是一匹自由的孤狼，正在街头吃烤串。"
      };
    }
    return {
      name: "工位出逃饿鬼",
      copy: "前司画的饼薄得如同 A4 纸，硬是把自己饿出了“班味型营养不良”，离职当天就去海底捞怒点12盘小酥肉。内心OS：别跟我谈OKR，吃进肚子的才叫KPI！"
    };
  }

  if (/出门.*痛快/.test(wish)) {
    if (hasHeavyOvertime) {
      return {
        name: "前司假期难民（烟花破防版",
        copy: "上次连续休息两天是什么时候？已经不记得了，可能是上个世纪，也可能是在发热门诊隔离。离职后狂刷三场演唱会，迪士尼暴走三万步，在烟花下嗷嗷哭。不是我矫情，是听到假期二字就会生理性流泪。"
      };
    }
    if (hasLowSalary) {
      return {
        name: "窝囊费特种兵",
        copy: "工资刚好够活，离职后揣着最后一个月窝囊费，买了张硬座票直奔音乐节。正式确诊为“窝囊费特种兵”。吗喽的命也是命，快乐不看月薪多少！"
      };
    }
    return {
      name: "快乐讨债吗喽",
      copy: "三天刷两场演唱会再连刷迪士尼，把被甲方气走的肾上腺素全补回来。被确诊为“快乐讨债吗喽”，症状是听到飞书提示音就过敏，看见 PPT 就应激。口号：吗喽的命也是命，快乐俺要自己抢！"
    };
  }

  if (/宅家|躺.*爽/.test(wish)) {
    if (hasHeavyOvertime) {
      return {
        name: "996缺觉难民（冬眠中",
        copy: "加班把睡眠全偷走了。现在我要把卧室窗帘拉死，通讯录全员静音，甲方与狗不得入内。把这 " + years + " 年的觉一次性睡回来，醒了才算新生。"
      };
    }
    if (hasLongTenure) {
      return {
        name: years + "年陈酿咸鱼",
        copy: "在公司熬了 " + years + " 年，从鲜肉熬成腊肉。离职后终于卸下那死装的松弛感，把积灰的 Switch 搓出火星子。哪怕成为社会边角料，也是妈妈的小骄傲。谁叫我开会，我跟谁拼命。"
      };
    }
    return {
      name: "离职停机躺尸王（峡谷复活版",
      copy: "前司工位没有窗，现在卧室窗帘也不拉开。通讯录全员静音，甲方与狗不得入内。在峡谷重新做人，比在公司做人爽多了。"
    };
  }

  if (/练出新肉身|健身|暴打/.test(wish)) {
    if (hasLowBonus && hasLowSalary) {
      return {
        name: "PUA 供能健身怪",
        copy: "奖金都没有，还要被 PUA“年轻人要吃苦”。当时的窝囊气如今成了免费氮泵，卧推能上 60 公斤，每次发力都想象在暴扣老板脑门。浑身腱子肉，全是被气出来的。"
      };
    }
    if (hasHeavyOvertime) {
      return {
        name: "健身房复仇者（撸铁版",
        copy: "加班加到腰突过劳肥，血压和体脂双双涨停。辞职后我要化身健身狂魔，把受的窝囊气全撸进铁里。老板问离职后干嘛，我说练身体，日后暴打你。"
      };
    }
    if (hasLongTenure) {
      return {
        name: "工位陈年健身怪（回炉复建中",
        copy: "在公司辛勤耕耘 " + years + " 年，腰突过劳肥，血压和体脂双双涨停。辞职后我要化身健身狂魔，把受的窝囊气全撸进铁里。老板问离职后干嘛，我说练身体，日后暴打你。"
      };
    }
    return {
      name: "脆皮牛马重装者（硬拉新生中",
      copy: "上班把自己上成“脆脆鲨”，颈椎腰椎哪哪都突出。辞职即办健身卡，每次力竭脑子里全是领导的脸，复仇动力拉满：惹到我，你算是踢到钢板啦！练成双开门冰箱，日后好好“回馈”前老板。"
    };
  }

  if (/看看世界|旅行|海岛/.test(wish)) {
    if (hasHeavyOvertime) {
      return {
        name: "工位断链野狗（远方撒野版",
        copy: "加班这些年，一响就得应，不分昼夜、周末、假期。脖子上像拴着一根隐形狗链，信号覆盖全城。离职那天退了所有群，第一次抬头看世界。学会了直立行走，下一步是去远方撒野。"
      };
    }
    return {
      name: "工位出逃野人",
      copy: "把钉钉签名改成“此人已死，有事烧纸”，买张去巴厘岛的机票直接消失。在海边发呆时发朋友圈：工位留给舔狗，海风留给老子。老娘（老子）的人生是旷野，不是轨道。"
    };
  }

  if (/装备升级|办公装备/.test(wish)) {
    if (hasHeavyOvertime) {
      return {
        name: "工伤后遗症装备党（科学养牛版",
        copy: "加班加出腱鞘炎和干眼症，离职就换垂直鼠标、升降桌和墨水屏。攒的钱全花在装备上，新工位布置成ICU。科学养牛，再战江湖。"
      };
    }
    if (hasLowBonus || hasLowSalary) {
      return {
        name: "闲鱼捡漏拼装侠",
        copy: "年终奖是张 50 块京东卡，连键盘都不够买。蹲闲鱼、拼多多，把窝囊费掰成八瓣花，硬凑出丐版电竞工位。下一份工可以不涨薪，装备不能再输。"
      };
    }
    return {
      name: "赛博筑巢牛马",
      copy: "嘴上骂着资本家，身体诚实地买了升降桌、人体工学椅和 5090 显卡，确诊为“赛博筑巢牛马”，往桌上塞满装备才有安全感。为下一份工作打好基础。主打一个工欲善其事，必先利其器。"
    };
  }

  if (/去喝|喝酒|喝个痛快|酒吧/.test(wish)) {
    if (hasHeavyOvertime) {
      return {
        name: "幽怨加班酒鬼",
        copy: "长期加班应酬练出的酒量，在散伙饭上大杀四方，把甲方灌我的酒全敬回 HR。敬自由千杯不醉。终于签了那份“离婚协议”，翻身农奴把歌唱，我要一路高歌奔赴下一家酒吧。"
      };
    }
    if (hasLongTenure) {
      return {
        name: "多年班味酒鬼",
        copy: "在公司熬了 " + years + " 年，送走七茬同事三任老板，也是终于轮到自己了。前老板敬酒说“以后常回来”，我在心里说“下辈子吧”。干了这杯，江湖不再见，我还要去别处续摊。"
      };
    }
    return {
      name: "工牌注销醉仙（牛马升天版",
      copy: "办完手续那一刻，签字的手抖成筛子，心里那个激动哇。离开单位就直奔酒吧，放开喝。再把离职证明裱起来挂在床头，比结婚证还令人开心。酒喝干，泪流完，牛马今夜就成仙。"
    };
  }

  if (/自己当老板|创业/.test(wish)) {
    if (hasLowBonus && hasHighSalary) {
      return {
        name: "画饼转行烙饼户（猛猛加蛋版",
        copy: "年终奖永远在画饼。行，那我创业就从煎饼摊开始，现摊现卖，实物结算。从被画饼到自己烙饼，再也不消化虚拟碳水。我是老板，我猛猛加蛋！"
      };
    }
    if (hasHeavyOvertime && hasHighSalary) {
      return {
        name: "自雇型卷王",
        copy: "以前给老板卖命996，现在直接去卖煎饼，给自己007。累是真累，但赚的每一分都进自己口袋。呜呼，终于活成了资本家的模样！"
      };
    }
    return {
      name: "反骨创业野马",
      copy: "前老板说我“没有老板思维”，转身就去注册个体户，法人就是自己。从给资本当狗，到自己咬牙当资本。全身就剩嘴硬和营业执照，势必卷死前东家。"
    };
  }

  return {
    name: "工位出逃自由人",
    copy: "工牌已经交回，下一段人生正在加载。具体去哪里不重要，方向盘终于回到自己手里。"
  };
};

const chooseRoast = (answers: Answers, years: number, amount: number) => {
  const amountText = formatMoney(amount);
  const bonusText = answers.bonusLevel && answers.bonusLevel !== "没有" ? "连年终奖也被算进了回血进度条。" : "没有年终奖也没关系，N 值会替你记账。";
  const cityText = answers.customCity || answers.city || "这座城市";

  const stablePick = (copies: string[]) => {
    const seed = Math.round(amount / 1000) + Math.round(years * 10) + (answers.terminationReason?.length || 0);
    return copies[Math.abs(seed) % copies.length];
  };

  if (answers.terminationReason === "resignation") {
    return stablePick([
      "主动离职四个字先别急着写，手一抖，钱可能就替公司省了。",
      "公司让你体面，你先让方案体面；成年人告别，最好带点余额。",
      `这笔账先按 ${amountText} 看，别让一句“你自己提吧”把钱包静音。`
    ]);
  }

  if (answers.terminationReason === "discipline") {
    return stablePick([
      "严重违纪不是 HR 说出口就自动生效，得先把证据从抽屉里请出来。",
      "先别急着点头，公司要开大招，材料也得跟得上。",
      "这种局别拼嗓门，聊天记录和书面通知才是真正的队友。"
    ]);
  }

  if (answers.terminationReason === "performance") {
    return stablePick([
      "绩效不好不是一张免赔券，PIP 和考核记录也得出来上班。",
      "公司说你不胜任，计算器说：证据呢，培训呢，调岗呢？",
      `先把 ${amountText} 放桌上，别让一次绩效沟通聊成免费告别。`
    ]);
  }

  if (["996 / 长期高强度加班", "长期高强度加班", "长期高强度加班（如 996）", "大小周"].includes(answers.workSchedule || "")) {
    return stablePick([
      "你不是离职，你是在结算青春折旧费。",
      "大小周没写进工牌，但写进了黑眼圈，也该写进账单。",
      "那些晚下班的夜没有白熬，现在统一打包进回血套餐。"
    ]);
  }

  if (amount > 150000) {
    return stablePick([
      "这不是补偿，这是把这些年忍住没走的耐心提现了。",
      `粗算到 ${amountText}，这波离职多少有点“含泪收款”。`,
      "公司画过的饼先放一边，这次计算器给你切了块真的。"
    ]);
  }

  if (years >= 5) {
    return stablePick([
      "公司说你是家人，说到结账才发现家人也要吃饭。",
      `在${cityText}熬了这么久，这次别只带走一句“辛苦了”。`,
      `这 ${years} 年没有白站岗，工龄终于从背景板变成了金额。`
    ]);
  }

  if (["工作时间不固定 / 经常临时加班", "工作时间不固定，经常临时加班"].includes(answers.workSchedule || "")) {
    return stablePick([
      "加班消息可以已读不回，补偿方案建议逐字精读。",
      "那些下班后还在线的夜晚，总得有点精神损耗报销吧。",
      `粗算 ${amountText}，算是给晚高峰和深夜会一个打包价。`
    ]);
  }

  return stablePick([
    `这笔账先看到 ${amountText}，不一定发财，但至少别让公司装糊涂。`,
    `在${cityText}打工，体面可以先放一边，账得先对齐。`,
    `离职不是散伙饭，是把 ${years} 年工龄端上桌算一算。`,
    bonusText === "连年终奖也被算进了回血进度条。" ? "年终奖也别客气，一起进锅算总账。" : "没有年终奖也没事，工龄这张牌还能打。"
  ]);
};

const getRuleReason = (mode: string) => {
  switch (mode) {
    case "n":
      return "该情形按经济补偿 N 估算。";
    case "nPlusOne":
      return "该情形按经济补偿 N 加 1 个月代通知金估算。";
    case "twoN":
      return "该情形按违法解除赔偿金 2N 估算。";
    case "zeroRisk":
      return "该情形通常没有经济补偿，按 0 元估算。";
    case "zeroOrN":
      return "是否属于法定被迫解除情形会影响结果，可能从 0 到 N。";
    case "zeroOrTwoN":
      return "过错是否成立、严重程度和解除程序都会影响结果，可能从 0 到 2N。";
    default:
      return "理由和材料还不够清楚，先按区间粗算，别急着替公司定性。";
  }
};

const buildSalaryBaseFormula = (takeHomeSalary: number, bonusMonths: number) => {
  const bonusText = bonusMonths ? `，年终奖按 ${bonusMonths} 个月摊入 12 个月` : "，暂无确定奖金摊入";
  return `${formatMoney(takeHomeSalary)} 到手 × 1.2 估税前${bonusText}`;
};

const buildCompensationFormula = (mode: string, years: number, monthly: number, range: { low: number; high: number }) => {
  const nFormula = `${formatMoney(monthly)} × ${years}`;
  switch (mode) {
    case "n":
      return `${nFormula}，并在估算结果上小幅浮动。`;
    case "nPlusOne":
      return `${formatMoney(monthly)} ×（${years} + 1），并在估算结果上小幅浮动。`;
    case "twoN":
      return `${formatMoney(monthly)} × 2 × ${years}，并在估算结果上小幅浮动。`;
    case "zeroRisk":
      return "按 0 元估算。";
    case "zeroOrN":
      return `不属于法定被迫解除情形时可能为 0；符合时按 ${formatMoney(monthly)} × ${years} 估算。`;
    case "zeroOrTwoN":
      return `过错成立时可能为 0；若构成违法解除，则按 ${formatMoney(monthly)} × 2 × ${years} 估算。`;
    default:
      return `${nFormula}，当前信息不足，估算区间为 ${formatMoney(range.low)} 至 ${formatMoney(range.high)}。`;
  }
};

type CompensationAmountRange = {
  low: number;
  high: number;
  rule: string;
  alternativeLow?: number;
  alternativeHigh?: number;
};

const amountRange = (mode: string, base: number, monthly: number): CompensationAmountRange => {
  switch (mode) {
    case "n":
      return { low: base * 0.95, high: base * 1.08, rule: "N" };
    case "nPlusOne": {
      const target = base + monthly;
      return { low: target * 0.95, high: target * 1.08, rule: "N+1" };
    }
    case "twoN": {
      const target = base * 2;
      return { low: target * 0.95, high: target * 1.08, rule: "2N" };
    }
    case "zeroRisk":
      return { low: 0, high: 0, rule: "无经济补偿" };
    case "zeroOrN":
      return {
        low: 0,
        high: base,
        rule: "0 / N 争议区间",
        alternativeLow: base * 0.95,
        alternativeHigh: base * 1.08
      };
    case "zeroOrTwoN":
      return {
        low: 0,
        high: base * 2,
        rule: "0 / 2N 争议区间",
        alternativeLow: base * 2 * 0.95,
        alternativeHigh: base * 2 * 1.08
      };
    case "range":
    default:
      return { low: base * 0.7, high: base + monthly, rule: "N / N+1 / 需进一步判断" };
  }
};

const chooseWishEquivalents = (amount: number, wish?: string, city?: string): ResultEquivalent[] => {
  const safeAmount = Math.max(1, amount);
  const pool = getWishEquivalentPool(wish, city);
  const available = pool.filter((item) => item.unitPrice <= safeAmount);
  const selectedPool = available.length
    ? available
    : [pool.reduce((cheapest, item) => item.unitPrice < cheapest.unitPrice ? item : cheapest)];
  const usedTags = new Set<string>();
  const distinctPool = selectedPool.filter((item) => {
    if (item.tag === "0") return true;
    if (usedTags.has(item.tag)) return false;
    usedTags.add(item.tag);
    return true;
  });

  return distinctPool.map((item: WishEquivalentItem) => {
    const count = Math.max(1, Math.floor(safeAmount / item.unitPrice));
    const monthsAtThreePerDay = Number((count / 3 / 30).toFixed(1));
    const monthsAtOnePerDay = Number((count / 30).toFixed(1));
    return {
      id: item.id,
      category: item.category,
      name: item.name,
      unit: item.unit,
      tag: item.tag,
      count,
      displayValue: `${count} ${item.unit}${item.name}`,
      lifestyleCopy: item.text
        .replace(/`?\{count\}`?/g, String(count))
        .replace("{monthsAtThreePerDay}", String(monthsAtThreePerDay))
        .replace("{monthsAtOnePerDay}", String(monthsAtOnePerDay))
    };
  });
};

export const formatMoney = (value: number) =>
  new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    maximumFractionDigits: 0
  }).format(Math.max(0, Math.round(value)));

export const calculateCompensation = (answers: Answers): CalculationResult => {
  const termination = getTerminationType(answers.terminationReason);
  const serviceYears = calcServiceYears(answers.startMonth, answers.endMonth);
  const takeHomeSalary = Number(answers.takeHomeSalary || 0);
  const estimatedGrossSalary = takeHomeSalary * 1.2;
  const bonusMonths = bonusMultiplierMap[answers.bonusLevel || "没有"] ?? 0;
  const adjustedMonthlySalary = estimatedGrossSalary + (estimatedGrossSalary * bonusMonths) / 12;
  const baseCompensation = adjustedMonthlySalary * serviceYears;
  const range = amountRange(termination.resultMode, baseCompensation, adjustedMonthlySalary);
  const midpoint = (range.low + range.high) / 2;
  const persona = chooseWorkhorsePersona(answers, serviceYears, takeHomeSalary);
  const serviceDays = Math.max(1, Math.round(serviceYears * 365));

  return {
    city: answers.customCity || answers.city || "你的城市",
    serviceYears,
    serviceDays,
    estimatedGrossSalary,
    adjustedMonthlySalary,
    baseCompensation,
    lowAmount: range.low,
    highAmount: range.high,
    alternativeLowAmount: range.alternativeLow,
    alternativeHighAmount: range.alternativeHigh,
    ruleHint: range.rule,
    ruleReason: getRuleReason(termination.resultMode),
    salaryBaseFormula: buildSalaryBaseFormula(takeHomeSalary, bonusMonths),
    compensationFormula: buildCompensationFormula(termination.resultMode, serviceYears, adjustedMonthlySalary, range),
    terminationHint: termination.compensationHint,
    terminationInferredType: termination.inferredType,
    terminationNote: termination.note,
    level: persona.name,
    levelCopy: persona.copy,
    roast: chooseRoast(answers, serviceYears, midpoint),
    equivalents: chooseWishEquivalents(midpoint, answers.postExitWish, answers.customCity || answers.city),
    needsFurtherReview: termination.id === "unclear" || termination.riskLevel === "critical" || termination.resultMode === "zeroOrN" || termination.resultMode === "zeroOrTwoN",
    terminationReasonId: termination.id
  };
};

export const currentMonthValue = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
};


