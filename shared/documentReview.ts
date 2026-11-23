export const MAX_PAGES = 6;
export const MAX_REQUEST_BYTES = 4_000_000;
export const MAX_SOURCE_BYTES = 20_000_000;
export const MAX_DOCUMENT_BYTES = 2_900_000;
export const MAX_PDF_PAGES = 20;
export type ReviewFile = { name: string; kind: "pdf" | "docx"; data: string };

export type ReviewIssue = {
  title: string;
  priority: "high" | "medium" | "low";
  pages: number[];
  quote: string | null;
  explanation: string;
  question_to_hr: string;
};
export type ReviewResult = { issues: ReviewIssue[]; limitations: string[] };
export type ReviewInput = { images: string[]; file?: never; confirmed: true } | { images?: never; file: ReviewFile; confirmed: true };

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 6000;

export function parseReviewResult(value: unknown, pageCount: number | null): ReviewResult {
  if (!object(value) || !Array.isArray(value.issues) || !Array.isArray(value.limitations)
    || value.issues.length > 30 || value.limitations.length > 20
    || !value.limitations.every(text)) throw new Error("分析结果格式不正确，请重试。");
  for (const issue of value.issues) {
    if (!object(issue) || !text(issue.title) || !text(issue.explanation) || !text(issue.question_to_hr)
      || !["high", "medium", "low"].includes(String(issue.priority))
      || !(issue.quote === null || text(issue.quote))
      || !Array.isArray(issue.pages)
      || (pageCount === null ? issue.pages.length !== 0 : issue.pages.length === 0 || issue.pages.length > pageCount)
      || new Set(issue.pages).size !== issue.pages.length
      || !issue.pages.every(page => Number.isInteger(page) && page >= 1 && pageCount !== null && page <= pageCount)) {
      throw new Error("分析结果缺少有效原文定位，请重试。");
    }
  }
  return value as ReviewResult;
}
