import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const readProjectFile = (relativePath: string) =>
  readFile(path.join(projectRoot, relativePath), "utf8");

describe("compile-time product channel", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each(["main", "ai"] as const)("accepts the %s channel", async (channel) => {
    vi.stubEnv("VITE_PRODUCT_CHANNEL", channel);
    vi.resetModules();

    const module = await import("../../src/product-channel");

    expect(module.productChannel).toBe(channel);
  });

  it("rejects an invalid channel before the application mounts", async () => {
    vi.stubEnv("VITE_PRODUCT_CHANNEL", "preview");
    vi.resetModules();

    await expect(import("../../src/product-channel")).rejects.toThrow(
      "VITE_PRODUCT_CHANNEL must be main or ai"
    );
  });
});

describe("independent web artifact contracts", () => {
  it("uses separate static roots without cross-channel imports", async () => {
    const [mainEntry, aiEntry, indexHtml, aiHtml, aiStyles] = await Promise.all([
      readProjectFile("src/main-entry.tsx"),
      readProjectFile("src/ai-entry.tsx"),
      readProjectFile("index.html"),
      readProjectFile("ai.html"),
      readProjectFile("src/ai/ai.css")
    ]);

    expect(mainEntry).toContain('import MainApp from "./main/MainApp"');
    expect(mainEntry).not.toMatch(/(?:import|import\().*(?:\/ai\/|AiShell)/);
    expect(aiEntry).toContain('import AiShell from "./ai/AiShell"');
    expect(aiEntry).not.toMatch(/(?:import|import\().*(?:\/main\/|MainApp)/);
    expect(indexHtml).toContain('src="/src/main-entry.tsx"');
    expect(indexHtml).not.toMatch(/AI|文件签署|文件审查/);
    expect(aiHtml).toContain('src="/src/ai-entry.tsx"');
    expect(aiEntry).toContain('import "./ai/ai.css"');
    expect(mainEntry).not.toContain("ai.css");
    expect(aiStyles).toContain(".ai-intro");
  });

  it("pins channels and output directories in dedicated Vite configs", async () => {
    const [mainConfig, aiConfig] = await Promise.all([
      readProjectFile("vite.main.config.ts"),
      readProjectFile("vite.ai.config.ts")
    ]);

    expect(mainConfig).toContain('JSON.stringify("main")');
    expect(mainConfig).toContain('outDir: "dist-main"');
    expect(aiConfig).toContain('JSON.stringify("ai")');
    expect(aiConfig).toContain('outDir: "dist-ai"');
    expect(aiConfig).toContain('input: "ai.html"');
    expect(aiConfig).toContain('bundle["index.html"]');
    expect(mainConfig).toContain("createProductBoundaryPlugin(\"main\")");
    expect(aiConfig).toContain("createProductBoundaryPlugin(\"ai\")");
    expect(aiConfig).toContain('publicDir: "public-ai"');
    expect(aiConfig).not.toContain("transformIndexHtml");
    expect(aiConfig).not.toContain(".replace(");
    expect(aiConfig).not.toContain('motion: ["motion"]');
  });

  it("keeps the independent AI template stable when main metadata changes", async () => {
    const [indexHtml, aiHtml] = await Promise.all([
      readProjectFile("index.html"),
      readProjectFile("ai.html")
    ]);
    const changedMain = indexHtml
      .replace("牛马身价预评估", "主站元数据变更")
      .replace("政策测算", "主站政策试算");

    expect(changedMain).toContain("主站元数据变更");
    expect(aiHtml).toContain("赔了么 AI - 离职补偿深度分析");
    expect(aiHtml).not.toContain("主站元数据变更");
    expect(aiHtml).not.toContain("主站政策试算");
  });

  it("uses a channel-aware Vite config for local development and previews", async () => {
    const packageJson = JSON.parse(await readProjectFile("package.json")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts.dev).toContain("vite.main.config.ts");
    expect(packageJson.scripts["dev:web:ai"]).toContain("vite.ai.config.ts");
    expect(packageJson.scripts.preview).toContain("vite.main.config.ts");
    expect(packageJson.scripts["preview:web:ai"]).toContain("vite.ai.config.ts");
  });

  it("copies each artifact into its dedicated Nginx image", async () => {
    const [mainDockerfile, aiDockerfile, legacyDockerfile, mainNginx, aiNginx] =
      await Promise.all([
        readProjectFile("Dockerfile.web-main"),
        readProjectFile("Dockerfile.web-ai"),
        readProjectFile("Dockerfile.web"),
        readProjectFile("deploy/nginx-main.conf"),
        readProjectFile("deploy/nginx-ai.conf")
      ]);

    expect(mainDockerfile).toContain("/app/dist-main");
    expect(mainDockerfile).toContain("deploy/nginx-main.conf");
    expect(mainDockerfile).not.toContain("/app/dist-ai");
    expect(aiDockerfile).toContain("/app/dist-ai");
    expect(aiDockerfile).toContain("deploy/nginx-ai.conf");
    expect(aiDockerfile).not.toContain("/app/dist-main");
    expect(aiDockerfile).toContain("COPY public-ai ./public-ai");
    expect(aiDockerfile).not.toContain("COPY public ./public");
    expect(legacyDockerfile).toContain("npm run build:web:main");
    expect(legacyDockerfile).toContain("/app/dist-main");
    expect(legacyDockerfile).toContain("deploy/nginx-main.conf");
    expect(legacyDockerfile).not.toContain("deploy/nginx.conf");
    expect(legacyDockerfile).toBe(mainDockerfile);

    for (const config of [mainNginx, aiNginx]) {
      expect(config).toContain("listen 80;");
      expect(config).toContain("set $api_upstream http://api:3001;");
      expect(config).toContain("proxy_pass $api_upstream;");
      expect(config).toContain("try_files $uri $uri/ /index.html;");
      expect(config).toContain('add_header Content-Security-Policy');
      expect(config).toContain('add_header Permissions-Policy');
      expect(config).not.toContain('add_header Cache-Control "public, immutable"');
      expect(config).not.toContain('add_header Cache-Control "no-cache"');
    }
  });

  it("styles the AI landing shell for the existing mobile frame", async () => {
    const [styles, aiStyles] = await Promise.all([
      readProjectFile("src/styles.css"),
      readProjectFile("src/ai/ai.css")
    ]);

    expect(styles).not.toContain(".ai-intro");
    expect(styles).not.toContain(".status-pill");
    expect(aiStyles).toContain(".ai-intro");
    expect(aiStyles).toContain(".status-pill");
  });
});
