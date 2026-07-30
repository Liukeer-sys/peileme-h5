import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { createProductBoundaryPlugin } from "./vite.product-boundary";

const excludedDevPrefixes = [
  "/api",
  "/assets",
  "/@",
  "/src",
  "/node_modules"
];

const isAiHtmlNavigation = (request: {
  method?: string;
  url?: string;
  headers: { accept?: string };
}) => {
  if (!["GET", "HEAD"].includes(request.method || "")) return false;
  if (!request.headers.accept?.includes("text/html")) return false;
  const pathname = new URL(request.url || "/", "http://vite.local").pathname;
  if (
    excludedDevPrefixes.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
    )
  ) {
    return false;
  }
  return !/(?:^|\/)[^/]+\.[^/]+$/.test(pathname);
};

const serveAiNavigation = (): Plugin => ({
  name: "peileme-serve-ai-navigation",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use((request, _response, next) => {
      if (isAiHtmlNavigation(request)) {
        const navigationUrl = new URL(request.url || "/", "http://vite.local");
        request.url = `/ai.html${navigationUrl.search}`;
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
  appType: "mpa",
  plugins: [
    serveAiNavigation(),
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
