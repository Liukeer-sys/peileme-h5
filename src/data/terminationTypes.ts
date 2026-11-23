import { getTerminationLeafById } from "./terminationReasonFlow";

export type FollowUpQuestion = {
  id: string;
  question: string;
  options: string[];
};

export type TerminationType = {
  id: string;
  label: string;
  inferredType: string;
  riskLevel: "low" | "medium" | "high" | "critical" | "unknown";
  compensationHint: string;
  resultMode: "n" | "nPlusOne" | "twoN" | "zeroRisk" | "zeroOrN" | "zeroOrTwoN" | "range";
  followUpQuestions: FollowUpQuestion[];
  note: string;
};

export const terminationTypes: TerminationType[] = [
  {
    id: "layoff",
    label: "公司裁员 / 业务调整 / 部门取消",
    inferredType: "经济性裁员/客观情况变化",
    riskLevel: "medium",
    compensationHint: "通常参考 N 或 N+1",
    resultMode: "nPlusOne",
    followUpQuestions: [],
    note: "如果公司有正式裁员流程、通知和补偿方案，重点看 N、N+1 以及工资基数是否算足。"
  },
  {
    id: "performance",
    label: "公司说我不胜任工作",
    inferredType: "不能胜任工作/绩效争议",
    riskLevel: "high",
    compensationHint: "常见谈判参考 N+1，但证据要求较高",
    resultMode: "nPlusOne",
    followUpQuestions: [],
    note: "不胜任解除通常需要公司证明考核规则、改进过程、培训或调岗等材料，口头说不胜任并不等于结论成立。"
  },
  {
    id: "discipline",
    label: "公司说我违纪 / 违反制度",
    inferredType: "违纪解除/制度争议",
    riskLevel: "critical",
    compensationHint: "风险最高，可能无补偿，也可能进入违法解除争议",
    resultMode: "zeroRisk",
    followUpQuestions: [],
    note: "违纪解除要看规章制度、告知流程、证据链和处罚比例。这里不适合直接下确定结论。"
  },
  {
    id: "contractEnd",
    label: "合同到期不续签",
    inferredType: "劳动合同期满不续签",
    riskLevel: "medium",
    compensationHint: "通常参考 N，但要看是谁不续签以及续签条件",
    resultMode: "n",
    followUpQuestions: [],
    note: "如果公司不续签，通常会有经济补偿参考；如果员工拒绝不低于原条件的续签，结论会不同。"
  },
  {
    id: "probation",
    label: "试用期被辞退",
    inferredType: "试用期解除争议",
    riskLevel: "high",
    compensationHint: "需要看录用条件、考核证据和通知程序",
    resultMode: "range",
    followUpQuestions: [],
    note: "试用期解除也需要说明不符合录用条件并有证据，不能只靠一句试用期不合适。"
  },
  {
    id: "resignation",
    label: "公司让我主动辞职",
    inferredType: "疑似诱导主动辞职",
    riskLevel: "critical",
    compensationHint: "主动辞职风险很高，可能无补偿",
    resultMode: "zeroRisk",
    followUpQuestions: [],
    note: "不要轻易写主动辞职申请。是否能主张补偿，要看沟通记录、胁迫迹象和公司真实安排。"
  },
  {
    id: "mutual",
    label: "HR 让我签协商解除协议",
    inferredType: "协商解除",
    riskLevel: "medium",
    compensationHint: "通常参考 N，也常以 N+1 作为谈判锚点",
    resultMode: "nPlusOne",
    followUpQuestions: [],
    note: "协商解除的核心是方案是否写清楚、付款时间是否明确、社保公积金和离职证明是否处理好。"
  },
  {
    id: "unclear",
    label: "没说清楚，只是口头通知",
    inferredType: "待进一步判断",
    riskLevel: "unknown",
    compensationHint: "先给粗略区间，需进一步结合材料判断",
    resultMode: "range",
    followUpQuestions: [],
    note: "口头通知、理由不清或材料缺失时，先保存沟通证据，后续需要结合书面材料进一步判断。"
  },
  {
    id: "other",
    label: "其他，我自己描述",
    inferredType: "待进一步判断",
    riskLevel: "unknown",
    compensationHint: "先给粗略区间，需进一步结合描述和材料判断",
    resultMode: "range",
    followUpQuestions: [],
    note: "描述型情况 demo 阶段先保存文本，结果页会提示需要结合材料进一步判断。"
  }
];

export const getTerminationType = (id?: string) =>
  terminationTypes.find((item) => item.id === id) ??
  (() => {
    const leaf = getTerminationLeafById(id);
    if (!leaf) return undefined;

    return {
      id: leaf.id,
      label: leaf.label,
      inferredType: leaf.inferredType,
      riskLevel: leaf.resultMode === "twoN" ? "high" : leaf.resultMode === "zeroRisk" || leaf.resultMode === "zeroOrN" || leaf.resultMode === "zeroOrTwoN" ? "critical" : "medium",
      compensationHint: leaf.compensationHint,
      resultMode: leaf.resultMode,
      followUpQuestions: [],
      note: leaf.note
    } satisfies TerminationType;
  })() ??
  terminationTypes.find((item) => item.id === "unclear") ??
  terminationTypes[0];



