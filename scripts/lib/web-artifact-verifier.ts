import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

type VerifyWebArtifactsOptions = {
  mainDir: string;
  aiDir: string;
};

const textExtensions = new Set([".css", ".html", ".js", ".json", ".map", ".txt"]);
const forbiddenMainMarkers = [
  "documentReview",
  "AiShell",
  "AI 深度分析",
  "AI会员",
  "providerChain",
  "providerConfig",
  "LLM_PROVIDER",
  "ai-worker",
  "文件签署分析",
  "劳动文件审查"
];
const requiredAiMarker = "AI 深度分析版";

const listTextFiles = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(root, entry.name);
      if (entry.isDirectory()) return listTextFiles(absolutePath);
      return textExtensions.has(path.extname(entry.name)) ? [absolutePath] : [];
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
  const [mainFiles, aiFiles] = await Promise.all([
    listTextFiles(mainDir),
    listTextFiles(aiDir)
  ]);
  const [mainArtifact, aiArtifact] = await Promise.all([
    readArtifact(mainFiles),
    readArtifact(aiFiles)
  ]);

  for (const marker of forbiddenMainMarkers) {
    if (mainArtifact.includes(marker)) {
      throw new Error(`main artifact contains forbidden marker: ${marker}`);
    }
  }

  if (!aiArtifact.includes(requiredAiMarker)) {
    throw new Error(`AI artifact is missing marker: ${requiredAiMarker}`);
  }

  return {
    mainFilesChecked: mainFiles.length,
    aiFilesChecked: aiFiles.length
  };
};
