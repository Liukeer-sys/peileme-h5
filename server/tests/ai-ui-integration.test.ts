import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = (relativePath: string) =>
  fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");

describe("AI site analysis UI integration", () => {
  it("connects the AI landing workspace to persisted analysis jobs", () => {
    const shell = source("src/ai/AiShell.tsx");
    const workspace = source("src/ai/AiAnalysisWorkspace.tsx");

    expect(shell).toContain("AiAnalysisWorkspace");
    expect(workspace).toContain('api<AiJob>("/api/ai/jobs"');
    expect(workspace).toContain('api<AiJobList>("/api/ai/jobs"');
    expect(workspace).toContain("分析报告");
  });

  it("lets an owned uploaded document start a real document review", () => {
    const accountPanel = source("src/ai/AiAccountPanel.tsx");

    expect(accountPanel).toContain('kind: "document_review"');
    expect(accountPanel).toContain("发起文件审查");
    expect(accountPanel).not.toContain("分析能力正在接入");
  });
});
