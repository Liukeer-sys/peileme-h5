import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { aiOnlyCssSelectors } from "../../product-boundary-markers";
import { verifyWebArtifacts } from "../../scripts/lib/web-artifact-verifier";

const temporaryRoots: string[] = [];
const validAiArtifact = [
  "<span>AI 深度分析版</span>",
  '<section data-product-sku="AI_DOCUMENT_REVIEW">',
  '<input class="ai-document-upload-input" type="file">',
  '<script>fetch("/api/uploads");fetch("/api/uploads/mine");',
  'fetch("/api/uploads/abc/download");fetch("/api/admin/uploads")</script>',
  "</section>"
].join("");

const makeArtifacts = async (mainSource: string, aiSource: string) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "peileme-web-artifacts-"));
  temporaryRoots.push(root);
  const mainDir = path.join(root, "dist-main");
  const aiDir = path.join(root, "dist-ai");
  await Promise.all([mkdir(mainDir), mkdir(aiDir)]);
  await Promise.all([
    writeFile(path.join(mainDir, "index.html"), mainSource),
    writeFile(path.join(aiDir, "index.html"), aiSource)
  ]);
  return { mainDir, aiDir };
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("built web artifact verifier", () => {
  it("accepts isolated main and AI artifacts", async () => {
    const directories = await makeArtifacts(
      "<title>赔了么政策测算</title>",
      validAiArtifact
    );

    await expect(verifyWebArtifacts(directories)).resolves.toEqual({
      mainFilesChecked: 1,
      aiFilesChecked: 1
    });
  });

  it.each([
    "documentReview",
    "AI_DOCUMENT_REVIEW",
    "document_review",
    "AiShell",
    "AI 深度分析",
    "providerChain",
    "/api/uploads",
    "/api/admin/uploads",
    "已上传材料",
    "上传 HR 协议或截图",
    "安全管理你上传的材料",
    "材料默认私有保存",
    "材料管理",
    ...aiOnlyCssSelectors
  ])(
    "rejects %s in the main artifact",
    async (forbiddenMarker) => {
      const directories = await makeArtifacts(
        `<script>${forbiddenMarker}</script>`,
        validAiArtifact
      );

      await expect(verifyWebArtifacts(directories)).rejects.toThrow(
        `main artifact contains forbidden marker: ${forbiddenMarker}`
      );
    }
  );

  it("requires the AI landing marker in the AI artifact", async () => {
    const directories = await makeArtifacts(
      "<title>赔了么政策测算</title>",
      "<title>赔了么</title>"
    );

    await expect(verifyWebArtifacts(directories)).rejects.toThrow(
      "AI artifact is missing marker: AI 深度分析版"
    );
  });

  it.each([
    "AI_DOCUMENT_REVIEW",
    "/api/uploads",
    "/api/uploads/mine",
    "/api/uploads/",
    "/api/admin/uploads",
    "ai-document-upload-input",
    'type="file"'
  ])("requires the AI upload capability marker %s", async (requiredMarker) => {
    const directories = await makeArtifacts(
      "<title>赔了么政策测算</title>",
      validAiArtifact.replaceAll(requiredMarker, "")
    );

    await expect(verifyWebArtifacts(directories)).rejects.toThrow(
      `AI artifact is missing marker: ${requiredMarker}`
    );
  });

  it("requires the AI document input itself to be a file control", async () => {
    const directories = await makeArtifacts(
      "<title>赔了么政策测算</title>",
      `${validAiArtifact.replace(
        'class="ai-document-upload-input" type="file"',
        'class="ai-document-upload-input" type="text"'
      )}<input class="admin-csv-input" type="file">`
    );

    await expect(verifyWebArtifacts(directories)).rejects.toThrow(
      'AI artifact is missing marker: type="file"'
    );
  });

  it("requires an AI user-owned upload download route", async () => {
    const directories = await makeArtifacts(
      "<title>赔了么政策测算</title>",
      validAiArtifact.replace(
        "/api/uploads/abc/download",
        "/api/uploads/abc"
      )
    );

    await expect(verifyWebArtifacts(directories)).rejects.toThrow(
      "AI artifact is missing marker: /api/uploads/:id/download"
    );
  });

  it("rejects persona image payloads copied into the AI artifact", async () => {
    const directories = await makeArtifacts(
      "<title>赔了么政策测算</title>",
      validAiArtifact
    );
    const personaDir = path.join(directories.aiDir, "persona_images");
    await mkdir(personaDir);
    await writeFile(path.join(personaDir, "unused.png"), Buffer.alloc(1024));

    await expect(verifyWebArtifacts(directories)).rejects.toThrow(
      "AI artifact contains main-only static payload: persona_images/unused.png"
    );
  });
});
