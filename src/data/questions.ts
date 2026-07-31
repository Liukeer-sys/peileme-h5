import { rootTerminationReasonNode } from "./terminationReasonFlow";

export type QuestionKind = "options" | "text" | "number" | "month";

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
    message: "你在哪座城市工作？",
    kind: "options",
    options: cityOptions
  },
  {
    id: "startDate",
    message: "那你是什么时候入职的？",
    kind: "month"
  },
  {
    id: "endDate",
    message: "公司通知你什么时候离职呢？",
    kind: "month"
  },
  {
    id: "workSchedule",
    message: "下面哪种最接近你的实际工作节奏？",
    kind: "options",
    options: [
      "基本双休，很少加班",
      "双休，但不定期加班",
      "大小周",
      "单休"
    ]
  },
  {
    id: "avgMonthlySalary",
    message: "你最近一年平均每月大概拿多少钱？",
    kind: "number",
    placeholder: "例如 12000"
  },
  {
    id: "bonusInfo",
    message: "过去一年有没有年终奖、季度奖、绩效奖金之类的？大概多少？",
    kind: "options",
    options: ["没有年终奖", "1个月工资左右", "2个月工资左右", "3个月工资及以上"]
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






