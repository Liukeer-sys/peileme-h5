import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const serveAiAtRoot = (): Plugin => ({
  name: "peileme-serve-ai-at-root",
  apply: "serve",
  transformIndexHtml(html) {
    return html
      .replace("/src/main-entry.tsx", "/src/ai-entry.tsx")
      .replace(
        "赔了么：离职补偿政策测算、计算过程、法规依据与证据清单。",
        "赔了么 AI：离职补偿深度分析与劳动文件审查。"
      )
      .replace("赔了么 - 牛马身价预评估", "赔了么 AI - 离职补偿深度分析");
  }
});

const normalizeAiHtmlName = (): Plugin => ({
  name: "peileme-normalize-ai-html-name",
  enforce: "post",
  generateBundle(_options, bundle) {
    const aiHtml = bundle["ai.html"];
    if (!aiHtml || aiHtml.type !== "asset") {
      throw new Error("AI build did not emit ai.html");
    }
    delete bundle["ai.html"];
    aiHtml.fileName = "index.html";
    bundle["index.html"] = aiHtml;
  }
});

export default defineConfig({
  plugins: [serveAiAtRoot(), react(), normalizeAiHtmlName()],
  define: {
    "import.meta.env.VITE_PRODUCT_CHANNEL": JSON.stringify("ai")
  },
  build: {
    outDir: "dist-ai",
    emptyOutDir: true,
    rollupOptions: {
      input: "ai.html",
      output: {
        entryFileNames: "assets/index-[hash].js",
        manualChunks: {
          react: ["react", "react-dom", "react-dom/client"],
          motion: ["motion"]
        }
      }
    }
  },
  server: {
    host: "0.0.0.0",
    port: 5174
  }
});
