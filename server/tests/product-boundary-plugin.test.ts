import { describe, expect, it } from "vitest";
import { aiOnlyCssSelectors } from "../../product-boundary-markers";
import { createProductBoundaryPlugin } from "../../vite.product-boundary";

type OutputChunk = {
  type: "chunk";
  fileName: string;
  modules: Record<string, object>;
  code: string;
};

type OutputAsset = {
  type: "asset";
  fileName: string;
  source: string;
};

const runBundleCheck = (
  channel: "main" | "ai",
  bundle: Record<string, OutputChunk | OutputAsset>
) => {
  const plugin = createProductBoundaryPlugin(channel);
  const hook = plugin.generateBundle;
  if (typeof hook !== "function") {
    throw new Error("product boundary plugin has no generateBundle hook");
  }
  return hook.call({} as never, {} as never, bundle as never, false);
};

describe("Rollup product module graph boundary", () => {
  it("rejects an AI source module in a main chunk", () => {
    expect(() =>
      runBundleCheck("main", {
        "index.js": {
          type: "chunk",
          fileName: "assets/index.js",
          modules: { "/repo/src/ai/AiShell.tsx": {} },
          code: ""
        },
        "main.css": {
          type: "asset",
          fileName: "assets/main.css",
          source: ".app-shell{}"
        }
      })
    ).toThrow("main bundle imports forbidden module");
  });

  it("rejects a main source module in an AI chunk", () => {
    expect(() =>
      runBundleCheck("ai", {
        "index.js": {
          type: "chunk",
          fileName: "assets/index.js",
          modules: { "/repo/src/main/MainApp.tsx": {} },
          code: "AI 深度分析版"
        },
        "ai.css": {
          type: "asset",
          fileName: "assets/ai.css",
          source: ".ai-intro{}"
        }
      })
    ).toThrow("ai bundle imports forbidden module");
  });

  it("requires channel-owned CSS in actual emitted assets", () => {
    expect(() =>
      runBundleCheck("main", {
        "index.js": {
          type: "chunk",
          fileName: "assets/index.js",
          modules: { "/repo/src/main/MainApp.tsx": {} },
          code: ""
        },
        "main.css": {
          type: "asset",
          fileName: "assets/main.css",
          source: ".ai-intro{}"
        }
      })
    ).toThrow("main CSS contains AI-only selector: .ai-intro");

    expect(() =>
      runBundleCheck("ai", {
        "index.js": {
          type: "chunk",
          fileName: "assets/index.js",
          modules: { "/repo/src/ai/AiShell.tsx": {} },
          code: "AI 深度分析版"
        },
        "ai.css": {
          type: "asset",
          fileName: "assets/ai.css",
          source: ".app-shell{}"
        }
      })
    ).toThrow("AI CSS is missing AI-only selectors");
  });

  it.each(aiOnlyCssSelectors)(
    "rejects the AI-only selector %s in main CSS",
    (selector) => {
    expect(() =>
      runBundleCheck("main", {
        "index.js": {
          type: "chunk",
          fileName: "assets/index.js",
          modules: { "/repo/src/main/MainApp.tsx": {} },
          code: ""
        },
        "main.css": {
          type: "asset",
          fileName: "assets/main.css",
          source: `${selector}{}`
        }
      })
    ).toThrow(`main CSS contains AI-only selector: ${selector}`);
    }
  );
});
