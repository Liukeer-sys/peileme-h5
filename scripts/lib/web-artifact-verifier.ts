import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { aiOnlyCssSelectors } from "../../product-boundary-markers.js";

type VerifyWebArtifactsOptions = {
  mainDir: string;
  aiDir: string;
};

const textExtensions = new Set([".css", ".html", ".js", ".json", ".map", ".txt"]);
const forbiddenMainMarkers = [
  "documentReview",
  "AI_DOCUMENT_REVIEW",
  "document_review",
  "AiShell",
  "AI 深度分析",
  "providerChain",
  "providerConfig",
  "LLM_PROVIDER",
  "ai-worker",
  "文件签署分析",
  "劳动文件审查",
  "/api/admin/uploads",
  "/api/uploads/mine",
  "/api/uploads/",
  "/api/uploads",
  "已上传材料",
  "上传 HR 协议或截图",
  "安全管理你上传的材料",
  "材料默认私有保存",
  "材料管理",
  ...aiOnlyCssSelectors
];
const requiredAiMarkers = [
  "AI 深度分析版",
  "AI_DOCUMENT_REVIEW",
  "/api/uploads",
  "/api/uploads/mine",
  "/api/uploads/",
  "/api/admin/uploads",
  "ai-document-upload-input"
];
const aiDocumentInputAssignment =
  String.raw`class(?:Name)?\s*(?:=|:)\s*["']ai-document-upload-input["']`;
const fileTypeAssignment =
  String.raw`type\s*(?:=|:)\s*["']file["']`;
const aiDocumentFileInputPattern = new RegExp(
  `(?:${aiDocumentInputAssignment}[^<>{}]{0,160}${fileTypeAssignment}|` +
    `${fileTypeAssignment}[^<>{}]{0,160}${aiDocumentInputAssignment})`
);
const aiUserDownloadPattern = /\/api\/uploads\/[^"'`\s]{1,160}\/download/;

const listFiles = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(root, entry.name);
      if (entry.isDirectory()) return listFiles(absolutePath);
      return [absolutePath];
    })
  );
  return nested.flat();
};

const readArtifact = async (files: string[]) =>
  (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");

export const verifyWebArtifacts = async ({
  mainDir,
  aiDir
}: VerifyWebArtifactsOptions) => {
  const [mainAllFiles, aiAllFiles] = await Promise.all([
    listFiles(mainDir),
    listFiles(aiDir)
  ]);
  const mainFiles = mainAllFiles.filter((file) =>
    textExtensions.has(path.extname(file))
  );
  const aiFiles = aiAllFiles.filter((file) =>
    textExtensions.has(path.extname(file))
  );
  const mainOnlyAiFile = aiAllFiles
    .map((file) => path.relative(aiDir, file).replaceAll("\\", "/"))
    .find((file) => file.startsWith("persona_images/"));
  if (mainOnlyAiFile) {
    throw new Error(
      `AI artifact contains main-only static payload: ${mainOnlyAiFile}`
    );
  }
  const [mainArtifact, aiArtifact] = await Promise.all([
    readArtifact(mainFiles),
    readArtifact(aiFiles)
  ]);

  for (const marker of forbiddenMainMarkers) {
    if (mainArtifact.includes(marker)) {
      throw new Error(`main artifact contains forbidden marker: ${marker}`);
    }
  }

  for (const marker of requiredAiMarkers) {
    if (!aiArtifact.includes(marker)) {
      throw new Error(`AI artifact is missing marker: ${marker}`);
    }
  }

  if (!aiDocumentFileInputPattern.test(aiArtifact)) {
    throw new Error('AI artifact is missing marker: type="file"');
  }
  if (!aiUserDownloadPattern.test(aiArtifact)) {
    throw new Error(
      "AI artifact is missing marker: /api/uploads/:id/download"
    );
  }

  return {
    mainFilesChecked: mainFiles.length,
    aiFilesChecked: aiFiles.length
  };
};
