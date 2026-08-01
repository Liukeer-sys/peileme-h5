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
    expect(shell).toContain("refreshKey={workspaceRevision}");
    expect(workspace).toContain("streamAiJob<AiJob>");
    expect(workspace).toContain("AI 实时回复");
    expect(workspace).not.toContain("AiJobProgress");
  });

  it("keeps the full policy calculator inside the AI product navigation", () => {
    const shell = source("src/ai/AiShell.tsx");
    const main = source("src/main/MainApp.tsx");

    expect(shell).toContain('import MainApp from "../main/MainApp"');
    expect(shell).toContain("<MainApp");
    expect(shell).toContain("accountRequestKey={policyAccountRequestKey}");
    expect(shell).toContain('aria-pressed={activeView === "policy"}');
    expect(shell).not.toContain('href="https://peileme.art"');
    expect(main).toContain("embedded = false");
  });

  it("lets an owned uploaded document start a real document review", () => {
    const accountPanel = source("src/ai/AiAccountPanel.tsx");

    expect(accountPanel).toContain('kind: "document_review"');
    expect(accountPanel).toContain("发起文件审查");
    expect(accountPanel).toContain("onJobCreated?.(job.id)");
    expect(accountPanel).not.toContain("分析能力正在接入");
  });

  it("renders current backend-managed announcements on both product sites", () => {
    const announcement = source("src/components/AnnouncementBanner.tsx");
    const main = source("src/main/MainApp.tsx");
    const ai = source("src/ai/AiShell.tsx");

    expect(announcement).toContain('"/api/public/announcements"');
    expect(main).toContain("<AnnouncementBanner />");
    expect(ai).toContain("<AnnouncementBanner />");
  });
});
