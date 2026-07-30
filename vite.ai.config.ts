import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { createProductBoundaryPlugin } from "./vite.product-boundary";

const serveAiAtRoot = (): Plugin => ({
  name: "peileme-serve-ai-at-root",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url === "/") {
        response.statusCode = 302;
        response.setHeader("Location", "/ai.html");
        response.end();
        return;
      }
      next();
    });
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
  plugins: [
    serveAiAtRoot(),
    react(),
    normalizeAiHtmlName(),
    createProductBoundaryPlugin("ai")
  ],
  publicDir: "public-ai",
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
          react: ["react", "react-dom", "react-dom/client"]
        }
      }
    }
  },
  server: {
    host: "0.0.0.0",
    port: 5174
  }
});
