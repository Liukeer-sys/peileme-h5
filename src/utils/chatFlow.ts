import { baseQuestions } from "../data/questions";
import { terminationTypes } from "../data/terminationTypes";
import type { Answers } from "../types";

export type ToneMode = "roast";

type ParsedDate = {
  raw: string;
  month?: string;
  uncertain?: boolean;
};

export const getNextQuestion = (stepIndex: number) => baseQuestions[stepIndex]?.message;

const padMonth = (month: number) => String(Math.min(Math.max(month, 1), 12)).padStart(2, "0");

export const parseLooseMonth = (value: string, now = new Date()): ParsedDate => {
  const raw = value.trim();
  if (!raw) return { raw, uncertain: true };
  if (/还没|未定|不确定|没定|不知道|待定/.test(raw)) return { raw, uncertain: true };

  const numeric = raw.match(/(20\d{2}|19\d{2})\s*[年.\/-]?\s*(1[0-2]|0?[1-9])?/);
  if (numeric) {
    const year = Number(numeric[1]);
    const month = numeric[2] ? Number(numeric[2]) : 1;
    return { raw, month: `${year}-${padMonth(month)}`, uncertain: !numeric[2] };
  }

  const yearOnly = raw.match(/(20\d{2}|19\d{2})/);
  if (yearOnly) return { raw, month: `${Number(yearOnly[1])}-01`, uncertain: true };

  const relativeYearMap: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const relative = raw.match(/(\d+|一|两|二|三|四|五|六|七|八|九|十)\s*年前/);
  if (relative) {
    const years = Number(relative[1]) || relativeYearMap[relative[1]] || 0;
    return { raw, month: `${now.getFullYear() - years}-${padMonth(now.getMonth() + 1)}`, uncertain: true };
  }

  return { raw, uncertain: true };
};

export const parseMoneyAmount = (value: string) => {
  const normalized = value.replace(/[,，\s]/g, "");
  const match = normalized.match(/(\d+(?:\.\d+)?)(万|w|W|k|K)?/);
  if (!match) return undefined;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return undefined;
  const unit = match[2];
  if (unit === "万" || unit === "w" || unit === "W") return Math.round(base * 10000);
  if (unit === "k" || unit === "K") return Math.round(base * 1000);
  return Math.round(base);
};

export const inferBonusLevel = (value: string, monthlySalary?: number) => {
  if (/没有年终奖|没有|无/.test(value) || /^0(?:\.0+)?(?:元|块|个月|月)?$/.test(value.trim())) return "没有";
  if (/不固定[，,]?但发得还算多/.test(value)) return "2个月工资左右";
  if (/不固定[，,]?偶尔有一点|说不清|还没发|不固定|不清楚|说不准|不知道/.test(value)) return "不固定 / 说不准";
  const amount = parseMoneyAmount(value);
  if (amount && monthlySalary) {
    const months = amount / monthlySalary;
    if (months >= 2.5) return "3个月以上";
    if (months >= 1.5) return "2个月工资左右";
    if (months >= 0.5) return "1个月工资左右";
  }
  if (/3个月工资及以上|3|三/.test(value)) return "3个月以上";
  if (/2|两|二/.test(value)) return "2个月工资左右";
  if (/1|一/.test(value)) return "1个月工资左右";
  return "不固定 / 说不准";
};

export const findTerminationTypeByAnswer = (value: string) => {
  const direct = terminationTypes.find((item) => item.label === value);
  if (direct) return direct;
  if (/裁员|业务|部门|优化|调整/.test(value)) return terminationTypes.find((item) => item.id === "layoff")!;
  if (/不胜任|绩效|pip|考核/.test(value.toLowerCase())) return terminationTypes.find((item) => item.id === "performance")!;
  if (/违纪|制度|处分|开除/.test(value)) return terminationTypes.find((item) => item.id === "discipline")!;
  if (/合同.*到期|不续签/.test(value)) return terminationTypes.find((item) => item.id === "contractEnd")!;
  if (/试用期/.test(value)) return terminationTypes.find((item) => item.id === "probation")!;
  if (/主动辞职|自己提|辞职申请/.test(value)) return terminationTypes.find((item) => item.id === "resignation")!;
  if (/协商解除|解除协议|协议/.test(value)) return terminationTypes.find((item) => item.id === "mutual")!;
  if (/口头|没说|不清楚/.test(value)) return terminationTypes.find((item) => item.id === "unclear")!;
  return terminationTypes.find((item) => item.id === "other")!;
};

export const inferWrittenNotice = (value: string) => {
  if (/没有书面|没书面|口头|只是说|电话/.test(value)) return false;
  if (/书面|通知书|邮件|邮件通知|盖章|文件|聊天记录|微信|钉钉|飞书/.test(value)) return true;
  return undefined;
};

export const inferAgreement = (value: string) => {
  if (/没有协议|没协议|没让签/.test(value)) return false;
  if (/协议|协商解除|补偿确认|离职申请|主动离职单|签字|签署/.test(value)) return true;
  return undefined;
};

export const isDetailedTerminationDescription = (value: string) =>
  value.length >= 18 || inferWrittenNotice(value) !== undefined || inferAgreement(value) !== undefined;

const pick = (_seedText: string, copies: string[]) => copies[Math.floor(Math.random() * copies.length)];

const parseMonthIndex = (value?: string) => {
  if (!value) return undefined;
  const [year, month] = value.split("-").map(Number);
  if (!year || !month) return undefined;
  return year * 12 + month - 1;
};

const getServiceMonths = (answers: Answers) => {
  const start = parseMonthIndex(answers.startDateParsed || answers.startMonth);
  const end = parseMonthIndex(answers.endDateParsed || answers.endMonth);
  if (start === undefined || end === undefined) return undefined;
  return end - start;
};

export const hasServiceDateConflict = (answers: Answers) => {
  const months = getServiceMonths(answers);
  return months !== undefined && months < 0;
};

const formatServiceDuration = (months: number) => {
  const safeMonths = Math.max(0, months);
  return `${Math.floor(safeMonths / 12)} 年 ${safeMonths % 12} 个月`;
};

const serviceDateConflictReplies = [
  "这个时间线有点穿越，公司再离谱应该也没离谱到发明时光裁员。入职或离职时间可能填反了，帮我重新确认一下？",
  "这个日期看起来不太对，离职时间早于入职时间了。公司可以乱来，时间线先别乱。",
  "这里像是填反了，先把入职和离职时间重新确认一下，别让公司还没出手，咱们自己先把账算歪。",
  "这个时间线有 bug，先别急着骂公司，咱先把日期捋顺，不然赔偿都不好算。"
];

const getServiceDurationReply = (seed: string, answers: Answers) => {
  const months = getServiceMonths(answers);
  if (months === undefined) return "时间先记下了。月份如果只是大概也没关系，后面可以再校准。";
  if (months < 0) return pick(seed, serviceDateConflictReplies);

  return `OK，你在这家公司大概待了 ${formatServiceDuration(months)}。`;
};
const getRoastReply = (stepId: string, userAnswer: string, parsedData: Answers) => {
  const city = parsedData.customCity || parsedData.city || userAnswer;
  const salary = parsedData.avgMonthlySalary || parsedData.takeHomeSalary;
  const seed = `${stepId}-${userAnswer}-${city}-${salary || ""}`;

  if (stepId === "city") {
    const cityReplies: Record<string, string[]> = {
      上海: [
        "上海啊，听起来很体面，钱包可能不太体面。",
        "上海啊，白天给公司打工，晚上给房东上供。",
        "上海这地方，工资看着高，活着也贵。"
      ],
      北京: [
        "北京啊，通勤都够申请工伤了。",
        "北京啊，地铁把人挤扁，公司把人榨干。"
      ],
      深圳: [
        "深圳啊，老板画饼都带着融资味。",
        "深圳啊，机会很多，命也挺费。",
        "深圳啊，连谈梦想都像要融资。",
        "深圳啊，公司最爱谈增长，轮到赔钱就开始谈困难。"
      ],
      广州: [
        "广州啊，早茶可以叹，裁员不能随便叹口气就算了。",
        "广州啊，肠粉都知道要加料，公司赔偿别想只给白粥。"
      ],
      杭州: [
        "杭州啊，风景像天堂，工位像炼丹炉。",
        "杭州啊，这些互联网公司最会把裁员说成“组织升级”。",
        "杭州啊，听起来是人间天堂，上班卷得像下了地狱。"
      ],
      成都: [
        "成都啊，生活巴适，公司不一定巴适。",
        "成都啊，城市节奏慢，公司裁人可一点不慢。",
        "成都啊，大家都说安逸，结果安逸的是老板，不是你。"
      ],
      西安: [
        "西安啊，十三朝古都，轮到你这第十四朝就是打工人被优化。",
        "西安啊，我羡慕那里的兵马俑，他们可有永久坑位呢。"
      ],
      武汉: [
        "武汉啊，夏天热得要命，HR 的赔偿方案却令人心寒。",
        "武汉啊，东湖那么大，老板的格局怎么就一小碗热干面。",
        "武汉啊，热干面至少给芝麻酱，公司画饼连酱都不给。",
        "武汉啊，九省通衢不是让老板九种理由通通裁你。",
        "武汉啊，城市火辣辣，公司抠搜搜，打工人夹中间烤得刚刚好。"
      ]
    };
    const otherCityReplies = [
      `${city}收到，打工人到了哪儿都能被精准消耗，公司真是全国统一考试。`,
      `行，${city}先记下，接下来看看公司准备怎么把算盘打到你脸上。`,
      `懂了，${city}也逃不开 HR 全国统一进货的话术。`,
      `收到，人在${city}，重点是公司别想把你当临期商品处理。`,
      `行，先定位到${city}，接下来看看这家公司到底想省你多少钱。`
    ];

    return pick(seed, cityReplies[city] || otherCityReplies);
  }

  if (stepId === "startDate") {
    return "好嘞，入职时间小赔记下了。公司通知你什么时候离职呢？";
  }

  if (stepId === "endDate") {
    return getServiceDurationReply(seed, parsedData);
  }

  if (stepId === "workSchedule") {
    const workScheduleReplies: Record<string, string[]> = {
      双休不加班: [
        `基本双休，算打工界珍稀动物了喔。`,
        `双休不加班，听起来公司还算做人。`,
        `这作息算正常，但公司可不能把“正常上班”包装成额外恩赐。`,
        `工作时间还算规矩，那接下来就看公司赔钱规不规矩了。`
      ],
      双休偶尔加班: [
        `双休是双休，就是“临时需求”总爱挑下班后和周末冒出来。`,
        `偶尔晚下班、周末临时响应，这些零碎时间加起来也不少。`
      ],
      大小周: [
        `大小周，老板最爱的“周末薛定谔”：有时活着，有时死了。`,
        `一周双休一周单休，公司嘴上叫安排灵活，身体上叫稳定消耗。`,
        `大小周，打工人每两周才完整当一次人。`
      ],
      单休: [
        `单休最阴的地方就是：每天不算太狠，但一年下来很会偷命。`,
        `一周休一天，洗衣服睡个觉，周末就自动蒸发了。`,
        `公司可能觉得你休一天够了，毕竟牛马不需要太多私人生活。`
      ]
    };

    return pick(seed, workScheduleReplies[userAnswer] || workScheduleReplies["双休偶尔加班"]);
  }

  if (stepId === "avgMonthlySalary") {
    if (!salary) return "工资口径先按你说的存着。钱可以含糊，赔偿基数最好别含糊。";

    if (["北京", "上海", "广州", "深圳"].includes(city)) {
      if (salary < 6000) return `这个数在${city}，工资刚到账，房租恐怕要先吞掉大半。`;
      if (salary < 10000) return `这个数在${city}，活是能活，就是每一笔消费都得细细斟酌。`;
      if (salary < 15000) return `过万听着不错，但放到${city}，也就是从“活着”升级成“比较努力地活着”。`;
      if (salary < 25000) return "这个数看着挺体面，但每月一放开消费，钱包立刻开始缩水。";
      if (salary < 40000) return "可以，这收入真实不错！就是焦虑估计也跟着升舱了。";
      return "可以，这个数在一线城市算是站稳脚跟了！就是焦虑估计也跟着升舱了。";
    }

    if (city === "杭州") {
      if (salary < 5000) return "这个数在杭州，活着不难，活得松弛比较难。";
      if (salary < 8000) return "这个数在杭州，日常能转，余额不能细看。";
      if (salary < 12000) return "还行，算是杭州打工人的基础续命包，别太放飞就能撑住。";
      if (salary < 20000) return "这个数在杭州算有点样子了，但体面的工资下压力恐怕也不小！";
      if (salary < 30000) return "这个数在杭州已经挺能打了，生活开始有点选择空间。";
      return "可以，杭州打工人高配版，钱包比普通人硬一点，焦虑也硬一点。";
    }

    if (["成都", "西安", "武汉"].includes(city)) {
      if (salary < 4000) return `这个数在${city}，日子恐怕需要精打细算呢，但慢慢来也能过。`;
      if (salary < 7000) return "这个数属于能过，但不能乱过，一乱花钱余额就开始提醒你。";
      if (salary < 10000) return "还不错，至少点外卖的时候不用每次都先深呼吸。";
      if (salary < 15000) return `这个数在${city}算挺能打了，生活开始有点余地。`;
      if (salary < 20000) return `这个数已经进入${city}薪资体面区，日常开销基本不用太纠结。`;
      return `可以，已经是${city}高配打工人，生活和选择一定都很从容吧！`;
    }

    if (salary < 4000) return `这个数在${city}主打一个朴素，花钱还是得稍微多想一步。`;
    if (salary < 7000) return "能过，但不敢太会过，生活稍微任性一点就开始反噬。";
    if (salary < 10000) return "还行，算是从“活着”往“生活”挪了一小步。";
    if (salary < 15000) return `这个数在${city}挺能打了，至少不是每天都被余额教育。`;
    if (salary < 20000) return `这个数在${city}已经挺体面了，生活开始有点松弛感。`;
    return "可以，收入有点东西，日子基本可以按自己想法来过了。";
  }

  if (stepId === "bonusInfo") {
    const bonusReplies: Record<string, string[]> = {
      "没有年终奖": [
        "没有年终奖，年底总结倒是照写，主打一个精神分红。",
        "没有年终奖也正常，很多公司擅长把“辛苦了”当货币用。"
      ],
      "1个月工资左右": [
        "这个数尚可入眼，像公司从抽屉里摸出来的一点良心。",
        "一个月左右，还行，至少不是纯靠“感谢付出”发电。"
      ],
      "2个月工资左右": [
        "两个月左右，还可以，终于不是“谢谢参与奖”了。",
        "这个数算有点东西，年底的时候还是很爽的。",
        "这个数还能看，至少不像从预算边角料里抠出来的。"
      ],
      "3个月工资及以上": [
        "三个月以上，可以，年终奖开始有点尊严了。",
        "这个数很牛逼，平时被压榨时还能幻想一下年底。",
        "三个月以上，年底可以拿到一个回血包！",
        "可以，这奖金至少让人感觉自己不是纯耗材。"
      ]
    };

    return pick(seed, bonusReplies[userAnswer] || bonusReplies["没有年终奖"]);
  }

  if (stepId === "terminationReason") {
    if (/主动辞职/.test(userAnswer)) return "让你主动辞职？好家伙，省钱算盘打得我隔着屏幕都听见了。";
    if (/协商解除/.test(userAnswer)) return "协商解除，翻译一下：公司想优雅地把钱谈少一点。咱们先看纸面。";
    if (/违纪|违反制度/.test(userAnswer)) return "违纪这顶帽子别急着戴，帽子大不大，得看证据够不够硬。";
    if (/不胜任/.test(userAnswer)) return "不胜任？公司一句话不能当判决书，PIP 和培训记录先出来走两步。";
    if (/裁员|业务调整|部门取消/.test(userAnswer)) return "裁员/调整收到。公司战略一拐弯，打工人钱包先系安全带。";
    if (/合同到期/.test(userAnswer)) return "合同到期不续签，听着平静，实际里面很适合藏小账。";
    if (/试用期/.test(userAnswer)) return "试用期被辞退也不是免赔金牌，公司别拿试用期当万能橡皮。";
    if (/口头通知|没说清楚/.test(userAnswer)) return "只口头说？这话轻得像风，咱们得找点能落地的证据。";
    return "行，你自己描述这类通常最有戏，也最容易藏坑。慢慢说，我接着。";
  }

  if (stepId === "terminationDetail") {
    return pick(seed, [
      "细节记下了。现在不是吵架时间，是把证据装进弹夹的时间。",
      "好，这些材料线索很有用。公司讲故事，我们看截图。",
      "收到，先把话术和材料分开放，别让 HR 的语气盖过事实。"
    ]);
  }

  if (stepId === "postExitWish") {
    if (/先吃|大吃特吃/.test(userAnswer)) return "可以，前司画的饼不顶饿，赔偿可得一分不少地算回来。";
    if (/出门.*痛快/.test(userAnswer)) return "懂了，前司已经散场，你真正想看的好戏才刚开场。";
    if (/去喝|喝酒|酒吧|庆祝|消愁|fancy.*bar/i.test(userAnswer)) return "这杯敬自由，但协议和收款数字得趁清醒看清楚。";
    if (/宅家躺.*爽/.test(userAnswer)) return "可以，会议先关掉，剧和游戏打开，赔偿也得一分不少。";
    if (/消愁/.test(userAnswer)) return "这杯先记公司账上，伤心可以有，签字可不能迷糊。";
    if (/练出新肉身|健身|暴打/.test(userAnswer)) return "很好，先拿赔偿，再练核心，肉体和钱包都要硬起来。";
    if (/看看世界|海岛|躺平/.test(userAnswer)) return "远方可以慢慢看，赔偿先别含糊。我们把该拿的算清楚再出发。";
    if (/自己当老板|创业/.test(userAnswer)) return "老板有眼无珠，不赏识我们没关系，咱们来自己当老板。";
    if (/给自己.*升级|电脑|磨吧/.test(userAnswer)) return "下一段工作先不急，自己的生活可以先升级。";
    return "好，这个愿望先记下。接下来给你把离职身价算出来。";
  }

  return "收到，这条先记进打工人账本。公司可以糊弄，咱们不糊涂。";
};

export const getReply = (_tone: ToneMode, stepId: string, userAnswer: string, parsedData: Answers) => getRoastReply(stepId, userAnswer, parsedData);
