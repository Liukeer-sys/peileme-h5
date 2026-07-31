import { expect, test, type Page } from "@playwright/test";

const aiBaseUrl = process.env.E2E_AI_BASE_URL?.trim().replace(/\/$/, "");
const userEmail = process.env.E2E_USER_EMAIL;
const userPassword = process.env.E2E_USER_PASSWORD;
const expectedProvider = process.env.E2E_EXPECT_FALLBACK_PROVIDER;

type AiJob = {
  id: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED_FINAL";
  selectedProvider: string | null;
  failureCode: string | null;
  report: { summary: string } | null;
};

const login = async (page: Page) => {
  await page.goto(aiBaseUrl!);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "登录赔了么" });
  await dialog.getByRole("button", { name: "密码登录" }).click();
  await dialog.getByLabel("邮箱 / 手机号").fill(userEmail!);
  await dialog.getByLabel("密码", { exact: true }).fill(userPassword!);
  await dialog.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "离职补偿深度分析" })).toBeVisible();
};

test.describe.configure({ timeout: 180_000 });

test("主 Provider 故障时 Worker 真实降级到指定 Provider 并完成报告", async ({ page }) => {
  test.skip(!expectedProvider, "仅在受控 Provider 降级演练时运行");
  if (!aiBaseUrl || !userEmail || !userPassword) {
    throw new Error("E2E_AI_BASE_URL, E2E_USER_EMAIL and E2E_USER_PASSWORD are required");
  }
  const browserErrors: string[] = [];
  const serverErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      browserErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByLabel("把你的情况说具体一些").fill(
    `Provider 降级演练 ${Date.now()}：公司要求协商离职，我工作四年，月工资一万二，有合同、工资流水和解除通知。`
  );
  const [queuedResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().endsWith("/api/ai/jobs") &&
      response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "开始 AI 分析" }).click()
  ]);
  expect(queuedResponse.status()).toBe(202);
  const queued = (await queuedResponse.json()) as AiJob;
  expect(queued.status).toBe("QUEUED");

  const terminalResponse = await page.waitForResponse(
    async (response) => {
      if (!response.url().endsWith(`/api/ai/jobs/${queued.id}`) || response.status() !== 200) {
        return false;
      }
      const job = (await response.json()) as AiJob;
      return job.status === "COMPLETED" || job.status === "FAILED_FINAL";
    },
    { timeout: 150_000 }
  );
  const terminal = (await terminalResponse.json()) as AiJob;
  expect(terminal.status, terminal.failureCode || "AI job failed").toBe("COMPLETED");
  expect(terminal.selectedProvider).toBe(expectedProvider);
  expect(terminal.report?.summary.length).toBeGreaterThan(10);
  await expect(page.getByRole("heading", { name: "分析报告" })).toBeVisible();
  expect(browserErrors, browserErrors.join("\n")).toEqual([]);
  expect(serverErrors, serverErrors.join("\n")).toEqual([]);
});
