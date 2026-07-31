import { expect, request as playwrightRequest, test, type Page } from "@playwright/test";

const mainBaseUrl = process.env.E2E_MAIN_BASE_URL?.trim().replace(/\/$/, "");
const aiBaseUrl = process.env.E2E_AI_BASE_URL?.trim().replace(/\/$/, "");
const enabled = process.env.E2E_REAL_EMAIL_OTP === "true";
const expectOtpDebug = process.env.E2E_EXPECT_OTP_DEBUG === "true";

type MailTmCollection<T> = { "hydra:member": T[] };
type MailTmDomain = { domain: string; isActive: boolean };
type MailTmMessage = { id: string; subject: string; intro: string };
type MailTmDetail = { text?: string; html?: string[] | string; intro?: string; subject?: string };

const watchRuntime = (page: Page) => {
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
  return () => {
    expect(browserErrors, browserErrors.join("\n")).toEqual([]);
    expect(serverErrors, serverErrors.join("\n")).toEqual([]);
  };
};

const createInbox = async () => {
  const api = await playwrightRequest.newContext({ baseURL: "https://api.mail.tm" });
  const domainsResponse = await api.get("/domains?page=1");
  expect(domainsResponse.status()).toBe(200);
  const domains = (await domainsResponse.json()) as MailTmCollection<MailTmDomain>;
  const domain = domains["hydra:member"].find((item) => item.isActive)?.domain;
  expect(domain).toBeTruthy();
  const password = `MailTm-${crypto.randomUUID()}-A1`;
  const address = `peileme-e2e-${Date.now()}-${crypto.randomUUID().slice(0, 8)}@${domain}`;
  const account = await api.post("/accounts", { data: { address, password } });
  expect(account.status()).toBe(201);
  const tokenResponse = await api.post("/token", { data: { address, password } });
  expect(tokenResponse.status()).toBe(200);
  const { token } = (await tokenResponse.json()) as { token: string };
  return { api, address, token };
};

const waitForOtp = async (
  api: Awaited<ReturnType<typeof playwrightRequest.newContext>>,
  token: string
) => {
  const headers = { authorization: `Bearer ${token}` };
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await api.get("/messages?page=1", { headers });
    expect(response.status()).toBe(200);
    const collection = (await response.json()) as MailTmCollection<MailTmMessage>;
    const message = collection["hydra:member"].find((item) =>
      item.subject.includes("赔了么验证码")
    );
    if (message) {
      const detailResponse = await api.get(`/messages/${message.id}`, { headers });
      expect(detailResponse.status()).toBe(200);
      const detail = (await detailResponse.json()) as MailTmDetail;
      const body = [
        detail.subject,
        detail.intro,
        detail.text,
        ...(Array.isArray(detail.html) ? detail.html : [detail.html])
      ].filter(Boolean).join(" ");
      const code = body.match(/\b\d{6}\b/)?.[0];
      if (code) return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("120 秒内未收到赔了么真实验证码邮件");
};

test.describe.configure({ mode: "serial", timeout: 300_000 });

test("真实外部邮箱收到验证码并覆盖错误码、注册、刷新会话和退出", async ({ page }) => {
  test.skip(!enabled, "仅在明确开启真实外部邮箱验收时运行");
  if (!mainBaseUrl || !aiBaseUrl) {
    throw new Error("E2E_MAIN_BASE_URL and E2E_AI_BASE_URL are required");
  }
  const expectNoRuntimeFailures = watchRuntime(page);
  const inbox = await createInbox();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mainBaseUrl);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "登录赔了么" });
    await dialog.getByRole("button", { name: "第一次来？注册账号" }).click();
    dialog = page.getByRole("dialog", { name: "建立你的赔了么档案" });
    await dialog.getByLabel("邮箱 / 手机号").fill(inbox.address);
    const [sendResponse] = await Promise.all([
      page.waitForResponse((response) =>
        response.url().endsWith("/api/auth/send-code") &&
        response.request().method() === "POST"
      ),
      dialog.getByRole("button", { name: "获取验证码" }).click()
    ]);
    expect(sendResponse.status()).toBe(201);
    const sendBody = (await sendResponse.json()) as { debugCode?: string };
    if (expectOtpDebug) {
      expect(sendBody.debugCode).toMatch(/^\d{6}$/);
    } else {
      expect(sendBody.debugCode).toBeUndefined();
    }
    await expect(dialog.locator(".account-message")).toContainText(
      expectOtpDebug ? "开发验证码" : "验证码已发送"
    );

    const code = await waitForOtp(inbox.api, inbox.token);
    const wrongCode = code === "111111" ? "222222" : "111111";
    await dialog.getByPlaceholder("6 位验证码").fill(wrongCode);
    await dialog.getByLabel("设置密码（可选）").fill("RealMailE2EPass123");
    await dialog.getByLabel("称呼（可选）").fill("真实邮箱验收");
    await dialog.getByRole("button", { name: "注册并登录" }).click();
    await expect(dialog.locator(".account-message")).toContainText("验证码错误或已过期");

    await dialog.getByPlaceholder("6 位验证码").fill(code);
    await dialog.getByRole("button", { name: "注册并登录" }).click();
    await expect(page.getByRole("button", { name: "真实邮箱验收" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "真实邮箱验收" })).toBeVisible();

    await page.goto(aiBaseUrl);
    await expect(page.getByRole("button", { name: "真实邮箱验收" })).toBeVisible();
    await page.getByLabel("把你的情况说具体一些").fill(
      "公司要求协商离职，我工作三年，月工资一万元，有劳动合同和解除通知，请分析补偿与证据风险。"
    );
    const [firstUseResponse] = await Promise.all([
      page.waitForResponse((response) =>
        response.url().endsWith("/api/ai/jobs") &&
        response.request().method() === "POST"
      ),
      page.getByRole("button", { name: "开始 AI 分析" }).click()
    ]);
    expect(firstUseResponse.status()).toBe(202);
    await expect(page.getByRole("heading", { name: "分析报告" })).toBeVisible({
      timeout: 120_000
    });
    const [exhaustedResponse] = await Promise.all([
      page.waitForResponse((response) =>
        response.url().endsWith("/api/ai/jobs") &&
        response.request().method() === "POST"
      ),
      page.getByRole("button", { name: "开始 AI 分析" }).click()
    ]);
    expect(exhaustedResponse.status()).toBe(402);
    await expect(page.getByRole("status")).toContainText("需要可用次数");
    await page.getByRole("button", { name: "真实邮箱验收" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "退出登录" }).click();
    await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
    expectNoRuntimeFailures();
  } finally {
    await inbox.api.dispose();
  }
});
