import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let browser: Browser;
let baseUrl: string;

beforeAll(async () => {
  server = await createServer({
    configFile: "vite.ai.config.ts",
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false
    }
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("AI Vite dev server did not expose a TCP address");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined
  });
}, 20_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const fetchHtmlNavigation = (pathname: string) =>
  fetch(`${baseUrl}${pathname}`, {
    headers: { accept: "text/html,application/xhtml+xml" },
    redirect: "follow"
  });

describe("AI Vite development navigation fallback", () => {
  it.each(["/", "/admin", "/history/dev-deep-link"])(
    "serves the AI entry for HTML navigation to %s",
    async (pathname) => {
      const response = await fetchHtmlNavigation(pathname);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("/src/ai-entry.tsx");
      expect(html).not.toContain("/src/main-entry.tsx");
      expect(html).toContain("赔了么 AI - 离职补偿深度分析");
    }
  );

  it.each(["/api/health", "/assets/missing.js"])(
    "does not rewrite excluded path %s to an HTML entry",
    async (pathname) => {
      const response = await fetchHtmlNavigation(pathname);
      const body = await response.text();

      expect(response.status).toBe(404);
      expect(body).not.toContain("/src/ai-entry.tsx");
      expect(body).not.toContain("/src/main-entry.tsx");
    }
  );

  it("leaves explicit HTML files addressable", async () => {
    const [mainResponse, aiResponse] = await Promise.all([
      fetchHtmlNavigation("/index.html"),
      fetchHtmlNavigation("/ai.html")
    ]);
    const [mainHtml, aiHtml] = await Promise.all([
      mainResponse.text(),
      aiResponse.text()
    ]);

    expect(mainHtml).toContain("/src/main-entry.tsx");
    expect(aiHtml).toContain("/src/ai-entry.tsx");
  });

  it.each([
    ["/", "AI 深度分析版"],
    ["/admin", "赔了么管理后台"],
    ["/history/dev-browser-deep-link", "AI 深度分析版"]
  ])(
    "boots the AI channel in Chromium at %s",
    async (pathname, visibleText) => {
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      try {
        const response = await page.goto(`${baseUrl}${pathname}`);
        expect(response?.status()).toBe(200);
        await expect
          .poll(() => page.getByText(visibleText, { exact: true }).count())
          .toBeGreaterThan(0);
        expect(pageErrors).toEqual([]);
        expect(await page.locator('script[src*="main-entry"]').count()).toBe(0);
      } finally {
        await page.close();
      }
    }
  );
});
