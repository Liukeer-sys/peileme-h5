export type XiaoPeiAvatarState =
  | "idle"
  | "smirk"
  | "eye_roll"
  | "shocked"
  | "angry"
  | "calculating"
  | "warning"
  | "result";

export const defaultXiaoPeiAvatarState: XiaoPeiAvatarState = "idle";

const eyeRollKeywords = ["加班", "996", "大小周", "低赔偿", "不合理", "离谱", "只给工资"];
const shockedKeywords = ["当天", "马上走", "立刻", "逼", "威胁", "没有任何补偿"];
const angryKeywords = ["拖欠", "不缴社保", "违法", "恶意", "克扣", "枪口只对公司"];
const warningKeywords = ["别签", "先别签", "风险", "协议", "书面通知", "解除协议"];

export function getXiaoPeiAvatarStateForReply(questionId: string, text: string): XiaoPeiAvatarState {
  if (warningKeywords.some((keyword) => text.includes(keyword))) return "warning";
  if (angryKeywords.some((keyword) => text.includes(keyword))) return "angry";
  if (shockedKeywords.some((keyword) => text.includes(keyword))) return "shocked";
  if (eyeRollKeywords.some((keyword) => text.includes(keyword))) return "eye_roll";

  if (questionId === "avgMonthlySalary" || questionId === "bonusInfo") return "calculating";
  if (questionId === "terminationReason" || questionId === "terminationDetail") return "warning";
  if (questionId === "workSchedule") return "eye_roll";
  if (questionId === "city" || questionId === "startDate" || questionId === "endDate") return "smirk";

  return "smirk";
}

export const xiaoPeiAvatarStateByMessageIntent = {
  welcome: "smirk",
  question: "idle",
  roast: "smirk",
  unreasonable: "eye_roll",
  extreme: "shocked",
  unfair: "angry",
  calculating: "calculating",
  warning: "warning",
  result: "result"
} satisfies Record<string, XiaoPeiAvatarState>;
