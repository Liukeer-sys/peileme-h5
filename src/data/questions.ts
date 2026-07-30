import { rootTerminationReasonNode } from "./terminationReasonFlow";

export type QuestionKind = "options" | "text" | "number" | "date";

export type BaseQuestion = {
  id: string;
  message: string;
  kind: QuestionKind;
  placeholder?: string;
  options?: string[];
};

export const cityOptions = ["上海", "北京", "深圳", "广州", "杭州", "成都", "西安", "武汉", "其他城市"];

export const baseQuestions: BaseQuestion[] = [
  {
    id: "city",
    message: "你在哪个城市工作？比如上海、北京、深圳。",
    kind: "options",
    options: cityOptions
  },
  {
    id: "startDate",
    message: "你的完整入职日期是哪一天？请按劳动合同或入职记录填写。",
    kind: "date"
  },
  {
    id: "endDate",
    message: "劳动关系实际解除或终止日期是哪一天？",
    kind: "date"
  },
  {
    id: "workSchedule",
    message: "下面哪种最接近你的实际工作节奏？",
    kind: "options",
    options: [
      "基本双休，很少加班",
      "双休，但工作日经常晚下班",
      "大小周",
      "单休，但每天工时还算正常",
      "长期高强度加班（如 996）",
      "工作时间不固定，经常临时加班"
    ]
  },
  {
    id: "avgMonthlySalary",
    message: "你的税前基础月工资大概是多少？后面还会逐月核对奖金、津贴和补贴。",
    kind: "number",
    placeholder: "例如 12000"
  },
  {
    id: "bonusInfo",
    message: "过去一年有没有年终奖、季度奖、绩效奖金之类的？大概多少？",
    kind: "options",
    options: ["没有年终奖", "1个月工资左右", "2个月工资左右", "3个月工资及以上", "不固定，但发得还算多", "不固定，偶尔有一点", "说不清 / 还没发"]
  },
  {
    id: "terminationReason",
    message: rootTerminationReasonNode.question,
    kind: "options",
    options: rootTerminationReasonNode.options.map((item) => item.label)
  },
  {
    id: "postExitWish",
    message: "钱拿到手，你最想先把哪种快乐补回来？",
    kind: "options",
    options: [
      "先大吃特吃一顿",
      "出门玩个痛快",
      "宅家躺到爽",
      "练出新肉身",
      "去看看世界",
      "给自己装备升级",
      "去喝个痛快",
      "这次自己当老板"
    ]
  }
];

export const loadingMessages = [
  "正在分析你的离职情况……",
  "正在计算你的牛马价值……",
  "正在统计你为公司贡献的在线时长……",
  "正在换算你的牛马等价物……",
  "正在生成你的离职身价报告……"
];




