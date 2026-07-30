import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyWebArtifacts } from "../../scripts/lib/web-artifact-verifier";

const temporaryRoots: string[] = [];

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
      "<span>AI 深度分析版</span>"
    );

    await expect(verifyWebArtifacts(directories)).resolves.toEqual({
      mainFilesChecked: 1,
      aiFilesChecked: 1
    });
  });

  it.each([
    "documentReview",
    "AiShell",
    "AI 深度分析",
    "AI会员",
    "providerChain"
  ])(
    "rejects %s in the main artifact",
    async (forbiddenMarker) => {
      const directories = await makeArtifacts(
        `<script>${forbiddenMarker}</script>`,
        "<span>AI 深度分析版</span>"
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
});
