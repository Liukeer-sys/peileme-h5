import type { OutputAsset, OutputBundle, OutputChunk } from "rollup";
import type { Plugin } from "vite";
import { aiOnlyCssSelectors } from "./product-boundary-markers";

export type ProductBoundaryChannel = "main" | "ai";

const normalizeModuleId = (moduleId: string) => moduleId.replaceAll("\\", "/");

const assetSource = (asset: OutputAsset) =>
  typeof asset.source === "string"
    ? asset.source
    : Buffer.from(asset.source).toString("utf8");

export const assertProductBoundary = (
  channel: ProductBoundaryChannel,
  bundle: OutputBundle
) => {
  const forbiddenSourceDirectory = channel === "main" ? "/src/ai/" : null;
  const chunks = Object.values(bundle).filter(
    (entry): entry is OutputChunk => entry.type === "chunk"
  );
  const cssAssets = Object.values(bundle).filter(
    (entry): entry is OutputAsset =>
      entry.type === "asset" && entry.fileName.endsWith(".css")
  );

  for (const chunk of chunks) {
    for (const moduleId of Object.keys(chunk.modules)) {
      if (
        forbiddenSourceDirectory &&
        normalizeModuleId(moduleId).includes(forbiddenSourceDirectory)
      ) {
        throw new Error(
          `${channel} bundle imports forbidden module: ${normalizeModuleId(moduleId)}`
        );
      }
    }
  }

  const emittedCss = cssAssets.map(assetSource).join("\n");
  if (channel === "main") {
    for (const selector of aiOnlyCssSelectors) {
      if (emittedCss.includes(selector)) {
        throw new Error(`main CSS contains AI-only selector: ${selector}`);
      }
    }
  }
  if (channel === "ai" && !emittedCss.includes(".ai-intro")) {
    throw new Error("AI CSS is missing AI-only selectors");
  }
};

export const createProductBoundaryPlugin = (
  channel: ProductBoundaryChannel
): Plugin => ({
  name: `peileme-${channel}-product-boundary`,
  enforce: "post",
  generateBundle(_options, bundle) {
    assertProductBoundary(channel, bundle);
  }
});
