import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chromium,
  expect as playwrightExpect,
  type Browser
} from "@playwright/test";
import react from "@vitejs/plugin-react";
import {
  createServer,
  type Plugin,
  type ViteDevServer
} from "vite";

const harnessId = "/virtual-main-account-switch-harness.tsx";

const mainAccountHarness = (): Plugin => ({
  name: "main-account-switch-harness",
  resolveId(id) {
    if (id === "/@main-account-switch-harness.tsx") return harnessId;
    return null;
  },
  load(id) {
    if (id !== harnessId) return null;
    return `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { AuthProvider, useAuth } from "/src/auth/AuthContext.tsx";
      import MainAccountPanel from "/src/main/MainAccountPanel.tsx";

      function Harness() {
        const { user, login } = useAuth();
        return (
          <>
            <nav style={{
              position: "fixed",
              inset: "0 auto auto 0",
              zIndex: 9999,
              background: "white",
              padding: "8px"
            }}>
              <button id="login-a" onClick={() => void login(
                "a@example.test",
                { password: "password-a" }
              )}>登录 A</button>
              <button id="login-b" onClick={() => void login(
                "b@example.test",
                { password: "password-b" }
              )}>登录 B</button>
              <output id="current-user">{user?.id || "signed-out"}</output>
            </nav>
            <MainAccountPanel
              key={user?.id ?? "signed-out"}
              open={Boolean(user)}
              onClose={() => undefined}
              onPolicyRecalculate={async () => false}
            />
          </>
        );
      }

      createRoot(document.getElementById("root")).render(
        <AuthProvider><Harness /></AuthProvider>
      );
    `;
  },
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (request.url !== "/") {
        next();
        return;
      }
      const html = await server.transformIndexHtml(
        "/",
        '<!doctype html><html><body><div id="root"></div>' +
          '<script type="module" src="/@main-account-switch-harness.tsx"></script>' +
          "</body></html>"
      );
      response.statusCode = 200;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(html);
    });
  }
});

let server: ViteDevServer;
let browser: Browser;
let baseUrl: string;

beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: "custom",
    plugins: [react(), mainAccountHarness()],
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false
    }
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("Main account harness did not expose a TCP address");
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

describe("main account panel browser identity boundary", () => {
  it("never exposes user A private state in user B's first observable DOM", async () => {
    const page = await browser.newPage();
    let currentUser = {
      id: "user-a",
      role: "user",
      email: "a@example.test",
      phone: null,
      displayName: "用户 A",
      status: "active"
    };
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === "/api/auth/refresh") {
        await route.fulfill({ status: 204 });
        return;
      }
      if (pathname === "/api/auth/login") {
        const body = request.postDataJSON() as { identifier: string };
        currentUser =
          body.identifier === "b@example.test"
            ? {
                id: "user-b",
                role: "user",
                email: "b@example.test",
                phone: null,
                displayName: "用户 B",
                status: "active"
              }
            : {
                id: "user-a",
                role: "user",
                email: "a@example.test",
                phone: null,
                displayName: "用户 A",
                status: "active"
              };
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            accessToken: `${currentUser.id}-token`,
            user: currentUser
          })
        });
        return;
      }
      if (pathname === "/api/auth/me") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ user: currentUser, capabilities: [] })
        });
        return;
      }
      if (pathname === "/api/access/me") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ grants: [] })
        });
        return;
      }
      if (pathname === "/api/auth/sessions") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ items: [] })
        });
        return;
      }
      if (pathname === "/api/policy/history") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            items: [],
            pagination: { page: 1, pageSize: 20, total: 0 }
          })
        });
        return;
      }
      if (pathname === "/api/invites/redeem") {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            error: "INVALID_INVITE",
            message: "A-MESSAGE-SECRET"
          })
        });
        return;
      }
      await route.fulfill({ status: 204 });
    });

    try {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      const response = await page.goto(baseUrl);
      expect(response?.status()).toBe(200);
      await page.waitForTimeout(200);
      if ((await page.locator("#login-a").count()) === 0) {
        throw new Error(
          JSON.stringify({
            pageErrors,
            html: await page.content()
          })
        );
      }
      await playwrightExpect(page.locator("#login-a")).toBeVisible({
        timeout: 5_000
      });
      expect(pageErrors).toEqual([]);
      await page.locator("#login-a").click();
      await playwrightExpect(
        page.getByRole("heading", { name: "用户 A" })
      ).toBeVisible();
      await page
        .getByPlaceholder("设置你的称呼")
        .fill("A-DISPLAY-SECRET");
      await page.getByPlaceholder("输入邀请码").fill("A-INVITE-SECRET");
      await page.getByRole("button", { name: "兑换" }).click();
      await playwrightExpect(page.getByText("A-MESSAGE-SECRET")).toBeVisible();

      await page.evaluate(() => {
        const secrets = [
          "A-DISPLAY-SECRET",
          "A-INVITE-SECRET",
          "A-MESSAGE-SECRET"
        ];
        const leaks: string[] = [];
        const inspect = () => {
          const panel = document.querySelector(".account-panel");
          const heading = panel?.querySelector("h2");
          if (heading?.textContent !== "用户 B") return;
          const snapshot = [
            panel?.textContent || "",
            ...Array.from(panel?.querySelectorAll("input") || []).map(
              (input) => input.value
            )
          ].join("\n");
          if (secrets.some((secret) => snapshot.includes(secret))) {
            leaks.push(snapshot);
          }
        };
        const observer = new MutationObserver(inspect);
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true
        });
        Object.assign(window, {
          __mainPanelLeaks: leaks,
          __mainPanelObserver: observer
        });
      });

      await page.locator("#login-b").click();
      await playwrightExpect(
        page.getByRole("heading", { name: "用户 B" })
      ).toBeVisible();
      await page.waitForTimeout(50);

      expect(
        await page.evaluate(() => {
          const globalWindow = window as typeof window & {
            __mainPanelLeaks?: string[];
            __mainPanelObserver?: MutationObserver;
          };
          globalWindow.__mainPanelObserver?.disconnect();
          return globalWindow.__mainPanelLeaks || [];
        })
      ).toEqual([]);
      await playwrightExpect(page.locator(".account-panel")).not.toContainText(
        "A-MESSAGE-SECRET"
      );
      await playwrightExpect(
        page.getByPlaceholder("设置你的称呼")
      ).toHaveValue("用户 B");
      await playwrightExpect(page.getByPlaceholder("输入邀请码")).toHaveValue(
        ""
      );
    } finally {
      await page.close();
    }
  });
});
