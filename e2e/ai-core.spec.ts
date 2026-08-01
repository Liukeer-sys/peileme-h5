import {
  expect,
  request as playwrightRequest,
  test,
  type Page,
  type Response as PlaywrightResponse
} from "@playwright/test";

const aiBaseUrl = process.env.E2E_AI_BASE_URL?.trim().replace(/\/$/, "");
const userEmail = process.env.E2E_USER_EMAIL;
const userPassword = process.env.E2E_USER_PASSWORD;
const adminEmail = process.env.E2E_ADMIN_EMAIL;
const adminPassword = process.env.E2E_ADMIN_PASSWORD;
const skipAccountSetup = process.env.E2E_SKIP_ACCOUNT_SETUP === "true";
const skipProfileMutation = process.env.E2E_SKIP_PROFILE_MUTATION === "true";
const noEntitlementPassword = "NoEntitlementE2e123";
const noEntitlementEmail = `ai-no-entitlement-${Date.now()}@peileme.test`;

const requiredEnvironment = () => {
  if (!aiBaseUrl || !userEmail || !userPassword || !adminEmail || !adminPassword) {
    throw new Error(
      "E2E_AI_BASE_URL, E2E_USER_EMAIL, E2E_USER_PASSWORD, E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD are required"
    );
  }
};

const watchRuntime = (page: Page) => {
  const browserErrors: string[] = [];
  const serverErrors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource:")
    ) {
      browserErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500) {
      serverErrors.push(`${response.status()} ${response.url()}`);
    }
  });
  return () => {
    expect(browserErrors, browserErrors.join("\n")).toEqual([]);
    expect(serverErrors, serverErrors.join("\n")).toEqual([]);
  };
};

const login = async (page: Page, email: string, password: string) => {
  await page.getByRole("button", { name: "登录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "登录赔了么" });
  await dialog.getByRole("button", { name: "密码登录" }).click();
  await dialog.getByLabel("邮箱 / 手机号").fill(email);
  await dialog.getByLabel("密码", { exact: true }).fill(password);
  await dialog.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "离职补偿深度分析" })).toBeVisible();
};

type CompletedAiJob = {
  id: string;
  status: string;
  selectedProvider: string | null;
  selectedModel: string | null;
  report: { summary: string; findings?: unknown[]; actions?: unknown[] } | null;
};

const completedJobFromStream = async (response: PlaywrightResponse) => {
  const body = await response.text();
  const done = [...body.matchAll(/event: done\ndata: (.+)(?:\n|$)/g)].at(-1)?.[1];
  if (!done) throw new Error("AI SSE stream closed without a done event");
  return JSON.parse(done) as CompletedAiJob;
};

test.describe.configure({ mode: "serial", timeout: 120_000 });

test.beforeAll(async () => {
  requiredEnvironment();
  if (skipAccountSetup) return;
  const context = await playwrightRequest.newContext({
    baseURL: aiBaseUrl,
    extraHTTPHeaders: { origin: new URL(aiBaseUrl!).origin }
  });
  try {
    const sent = await context.post("/api/auth/send-code", {
      data: { target: noEntitlementEmail, purpose: "register" }
    });
    expect(sent.status()).toBe(201);
    const { debugCode } = (await sent.json()) as { debugCode?: string };
    expect(debugCode).toMatch(/^\d{6}$/);
    const registered = await context.post("/api/auth/register", {
      data: {
        target: noEntitlementEmail,
        code: debugCode,
        password: noEntitlementPassword,
        displayName: "无次数验收用户"
      }
    });
    expect(registered.status()).toBe(201);
  } finally {
    await context.dispose();
  }
});

test("真实用户完成 AI 分析、PDF 审查、历史、下载、资料与邀请码异常链路", async ({
  page
}) => {
  const expectNoRuntimeFailures = watchRuntime(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const response = await page.goto(aiBaseUrl!);
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle("赔了么 AI - 离职补偿深度分析");
  await expect(page.getByRole("heading", { name: "把材料、金额和风险一次讲清楚" })).toBeVisible();
  await page.getByRole("link", { name: "政策测算", exact: true }).click();
  await expect(page).toHaveURL(`${aiBaseUrl}/policy`);
  await expect(page.getByRole("button", { name: "上海", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "AI 深度分析", exact: true }).click();
  await expect(page).toHaveURL(`${aiBaseUrl}/`);
  await expect(page.getByRole("heading", { name: "把材料、金额和风险一次讲清楚" })).toBeVisible();

  await page.getByRole("button", { name: "登录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "登录赔了么" });
  await dialog.getByRole("button", { name: "获取验证码" }).click();
  await expect(dialog.locator(".account-message")).toContainText(
    "请输入邮箱或中国大陆手机号"
  );
  await dialog.getByRole("button", { name: "密码登录" }).click();
  await dialog.getByLabel("邮箱 / 手机号").fill(userEmail!);
  await dialog.getByLabel("密码", { exact: true }).fill(userPassword!);
  await dialog.getByRole("button", { name: "登录", exact: true }).click();

  const situation = page.getByLabel("把你的情况说具体一些");
  const analyzeButton = page.getByRole("button", { name: "开始 AI 分析" });
  await situation.fill("内容太短");
  await expect(analyzeButton).toBeDisabled();
  await situation.fill(
    "公司提出协商解除，我工作三年，月工资一万元，有劳动合同、工资流水和解除通知，请分析补偿与证据风险。"
  );
  const [analysisResponse, analysisStream] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/ai/jobs") &&
        candidate.request().method() === "POST",
      { timeout: 100_000 }
    ),
    page.waitForResponse(
      (candidate) =>
        /\/api\/ai\/jobs\/[^/]+\/stream\?/.test(candidate.url()) &&
        candidate.status() === 200,
      { timeout: 100_000 }
    ),
    analyzeButton.click()
  ]);
  expect(analysisResponse.status()).toBe(202);
  const queuedAnalysis = (await analysisResponse.json()) as CompletedAiJob;
  expect(queuedAnalysis.status).toBe("QUEUED");
  expect(analysisStream.url()).toContain(`/api/ai/jobs/${queuedAnalysis.id}/stream`);
  await expect(page.getByLabel("AI 实时回复")).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  const analysis = await completedJobFromStream(analysisStream);
  expect(analysis.status).toBe("COMPLETED");
  expect(["tuzi", "dataeyes"]).toContain(analysis.selectedProvider);
  expect(
    analysis.selectedProvider === "tuzi"
      ? analysis.selectedModel
      : "fallback"
  ).toBe(
    analysis.selectedProvider === "tuzi" ? "gpt-5.6-sol" : "fallback"
  );
  expect(analysis.report?.summary.length).toBeGreaterThan(10);
  expect(analysis.report?.findings?.length).toBeGreaterThan(0);
  expect(analysis.report?.actions?.length).toBeGreaterThan(0);
  await expect(page.getByRole("heading", { name: "分析报告" })).toBeVisible();
  await expect(page.getByText("下一步建议", { exact: true })).toBeVisible();

  if (new URL(aiBaseUrl!).protocol === "https:") await page.reload();
  await expect(page.getByRole("heading", { name: "离职补偿深度分析" })).toBeVisible();
  const recentAnalysis = page.locator(".ai-job-list button").filter({
    hasText: "离职补偿分析"
  }).first();
  await expect(recentAnalysis).toBeVisible();
  await recentAnalysis.click();
  await expect(page.getByRole("heading", { name: "分析报告" })).toBeVisible();

  await page.locator(".ai-top-actions button").click();
  const account = page.getByRole("dialog").filter({
    has: page.locator("#ai-document-upload-input")
  });
  const uploadInput = account.getByLabel("上传劳动文件");
  await uploadInput.setInputFiles({
    name: "unsupported-e2e.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("unsupported")
  });
  const [unsupportedResponse] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/uploads") &&
        candidate.request().method() === "POST"
    ),
    account.getByRole("button", { name: "上传并保存" }).click()
  ]);
  expect(unsupportedResponse.status()).toBe(400);
  await expect(account.locator(".account-message").first()).toContainText("仅支持");

  const uploadName = `core-ai-agreement-${Date.now()}.pdf`;
  await uploadInput.setInputFiles({
    name: uploadName,
    mimeType: "application/pdf",
    buffer: await (await import("node:fs/promises")).readFile(
      "e2e/fixtures/e2e-agreement.pdf"
    )
  });
  const [uploadResponse] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/uploads") &&
        candidate.request().method() === "POST"
    ),
    account.getByRole("button", { name: "上传并保存" }).click()
  ]);
  expect(uploadResponse.status()).toBe(201);
  await expect(account.getByText(uploadName, { exact: true })).toBeVisible();
  const uploadRow = account.getByRole("article").filter({ hasText: uploadName }).first();
  const objective = account.getByLabel("审查重点");
  await objective.fill("太短");
  await expect(uploadRow.getByRole("button", { name: "发起文件审查" })).toBeDisabled();
  await objective.fill("签署前检查补偿金额、付款期限、权利放弃、保密和违约责任");
  const [reviewResponse, reviewStream] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/ai/jobs") &&
        candidate.request().method() === "POST",
      { timeout: 100_000 }
    ),
    page.waitForResponse(
      (candidate) =>
        /\/api\/ai\/jobs\/[^/]+\/stream\?/.test(candidate.url()) &&
        candidate.status() === 200,
      { timeout: 100_000 }
    ),
    uploadRow.getByRole("button", { name: "发起文件审查" }).click()
  ]);
  expect(reviewResponse.status()).toBe(202);
  const queuedReview = (await reviewResponse.json()) as CompletedAiJob;
  expect(queuedReview.status).toBe("QUEUED");
  expect(reviewStream.url()).toContain(`/api/ai/jobs/${queuedReview.id}/stream`);
  await expect(account.getByLabel("AI 文件审查实时回复")).toBeVisible();
  await expect(account.getByRole("progressbar")).toHaveCount(0);
  const review = await completedJobFromStream(reviewStream);
  expect(review.status).toBe("COMPLETED");
  await expect(account.locator(".account-message").first()).toContainText(
    review.report!.summary.slice(0, 12)
  );

  const [downloadResponse] = await Promise.all([
    page.waitForResponse((candidate) => candidate.url().endsWith("/download")),
    uploadRow.getByRole("button", { name: "下载", exact: true }).click()
  ]);
  expect(downloadResponse.status()).toBe(200);
  expect(downloadResponse.headers()["content-disposition"]).toContain(uploadName);

  const profileSection = account.locator(".account-panel-section").filter({
    hasText: "个人资料"
  });
  if (!skipProfileMutation) {
    const profileInput = profileSection.getByPlaceholder("设置你的称呼");
    await profileInput.fill("核心验收改名");
    await profileSection.getByRole("button", { name: "保存" }).click();
    await expect(account.getByRole("status").last()).toContainText("称呼已更新");
    await profileInput.fill("核心验收用户");
    await profileSection.getByRole("button", { name: "保存" }).click();
    await expect(account.getByRole("status").last()).toContainText("称呼已更新");
  }

  const inviteSection = account.locator(".account-panel-section").filter({
    hasText: "邀请码兑换"
  });
  await inviteSection.getByPlaceholder("输入邀请码").fill("NOPE1234");
  await inviteSection.getByRole("button", { name: "兑换" }).click();
  await expect(inviteSection.locator(".account-message")).toContainText("邀请码");

  await account.getByRole("button", { name: "关闭" }).click();
  const documentHistory = page.locator(".ai-job-list button").filter({
    hasText: "文件签署审查"
  }).first();
  await expect(documentHistory).toBeVisible();
  await documentHistory.click();
  await expect(page.getByRole("heading", { name: "分析报告" })).toBeVisible();
  await page.locator(".ai-top-actions button").click();
  await page.getByRole("dialog").getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "把材料、金额和风险一次讲清楚" })).toBeVisible();
  expectNoRuntimeFailures();
});

test("新用户两项 AI 首次权益各成功一次且第二次进入次数不足边界", async ({ page }) => {
  test.skip(skipAccountSetup, "外部环境由真实邮箱用例验证首次权益");
  const expectNoRuntimeFailures = watchRuntime(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(aiBaseUrl!);
  await login(page, noEntitlementEmail, noEntitlementPassword);

  await page.getByLabel("把你的情况说具体一些").fill(
    "公司要求立即离职，没有书面通知，我工作两年，月工资八千元，需要分析补偿。"
  );
  const [firstAnalysisResponse, firstAnalysisStream] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/ai/jobs") &&
        candidate.request().method() === "POST"
    ),
    page.waitForResponse((candidate) => /\/api\/ai\/jobs\/[^/]+\/stream\?/.test(candidate.url())),
    page.getByRole("button", { name: "开始 AI 分析" }).click()
  ]);
  expect(firstAnalysisResponse.status()).toBe(202);
  const firstQueued = (await firstAnalysisResponse.json()) as CompletedAiJob;
  expect(firstAnalysisStream.url()).toContain(`/api/ai/jobs/${firstQueued.id}/stream`);
  const firstCompleted = await completedJobFromStream(firstAnalysisStream);
  expect(firstCompleted.status).toBe("COMPLETED");
  await expect(page.getByRole("heading", { name: "分析报告" })).toBeVisible();

  const [analysisResponse] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/ai/jobs") &&
        candidate.request().method() === "POST"
    ),
    page.getByRole("button", { name: "开始 AI 分析" }).click()
  ]);
  expect(analysisResponse.status()).toBe(402);
  await expect(page.getByRole("status")).toContainText("需要可用次数");

  await page.locator(".ai-top-actions button").click();
  const account = page.getByRole("dialog");
  const uploadName = `no-entitlement-${Date.now()}.pdf`;
  await account.getByLabel("上传劳动文件").setInputFiles({
    name: uploadName,
    mimeType: "application/pdf",
    buffer: await (await import("node:fs/promises")).readFile(
      "e2e/fixtures/e2e-agreement.pdf"
    )
  });
  await account.getByRole("button", { name: "上传并保存" }).click();
  const uploadRow = account.getByRole("article").filter({ hasText: uploadName }).first();
  await expect(uploadRow).toBeVisible();
  const [firstReviewResponse, firstReviewStream] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/ai/jobs") &&
        candidate.request().method() === "POST"
    ),
    page.waitForResponse((candidate) => /\/api\/ai\/jobs\/[^/]+\/stream\?/.test(candidate.url())),
    uploadRow.getByRole("button", { name: "发起文件审查" }).click()
  ]);
  expect(firstReviewResponse.status()).toBe(202);
  const firstReviewQueued = (await firstReviewResponse.json()) as CompletedAiJob;
  expect(firstReviewStream.url()).toContain(`/api/ai/jobs/${firstReviewQueued.id}/stream`);
  const firstReviewCompleted = await completedJobFromStream(firstReviewStream);
  expect(firstReviewCompleted.status).toBe("COMPLETED");
  await expect(account.locator(".account-message").first()).toContainText(
    firstReviewCompleted.report!.summary.slice(0, 12)
  );

  const [reviewResponse] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/ai/jobs") &&
        candidate.request().method() === "POST"
    ),
    uploadRow.getByRole("button", { name: "发起文件审查" }).click()
  ]);
  expect(reviewResponse.status()).toBe(402);
  await expect(account.locator(".account-message").first()).toContainText(
    "需要可用次数"
  );
  await account.getByRole("button", { name: "退出登录" }).click();
  expectNoRuntimeFailures();
});

test("忘记密码覆盖弱密码拒绝、验证码重置和新密码登录", async ({ page }) => {
  test.skip(skipAccountSetup, "外部环境不创建或重置测试账号");
  const expectNoRuntimeFailures = watchRuntime(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(aiBaseUrl!);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "登录赔了么" });
  await dialog.getByRole("button", { name: "忘记密码" }).click();
  await expect(page.getByRole("dialog", { name: "重置登录密码" })).toBeVisible();
  dialog = page.getByRole("dialog", { name: "重置登录密码" });
  await dialog.getByLabel("邮箱 / 手机号").fill(noEntitlementEmail);
  await dialog.getByRole("button", { name: "获取验证码" }).click();
  const message = dialog.locator(".account-message");
  await expect(message).toContainText("开发验证码：");
  const code = (await message.textContent())?.match(/\d{6}/)?.[0];
  expect(code).toMatch(/^\d{6}$/);
  await dialog.getByPlaceholder("6 位验证码").fill(code!);
  await dialog.getByLabel("设置新密码").fill("weak");
  await dialog.getByRole("button", { name: "确认重置" }).click();
  await expect(message).toContainText("密码至少 8 位");
  const nextPassword = "NoEntitlementReset123";
  await dialog.getByLabel("设置新密码").fill(nextPassword);
  await dialog.getByRole("button", { name: "确认重置" }).click();
  dialog = page.getByRole("dialog", { name: "登录赔了么" });
  await expect(dialog.locator(".account-message")).toContainText("密码已重置");
  await dialog.getByLabel("密码", { exact: true }).fill(nextPassword);
  await dialog.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "离职补偿深度分析" })).toBeVisible();
  await page.locator(".ai-top-actions button").click();
  await page.getByRole("dialog").getByRole("button", { name: "退出登录" }).click();
  expectNoRuntimeFailures();
});

test("AI 管理后台覆盖全部导航并将发布公告送达用户端", async ({ page, browser }) => {
  const expectNoRuntimeFailures = watchRuntime(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${aiBaseUrl}/admin`);
  await page.getByRole("button", { name: "管理员登录" }).click();
  const dialog = page.getByRole("dialog", { name: "登录赔了么" });
  await dialog.getByRole("button", { name: "密码登录" }).click();
  await dialog.getByLabel("邮箱 / 手机号").fill(adminEmail!);
  await dialog.getByLabel("密码", { exact: true }).fill(adminPassword!);
  await dialog.getByRole("button", { name: "登录", exact: true }).click();

  const tabs = [
    ["经营概览", "转化漏斗"],
    ["政策规则", "规则版本"],
    ["区域参数", "区域参数清单"],
    ["公告设置", "公告编排"],
    ["用户管理", "用户清单"],
    ["测算记录", "测算记录"],
    ["材料管理", "用户材料"],
    ["邀请码", "邀请码清单"],
    ["埋点统计", "近 30 天埋点"],
    ["审计日志", "管理操作审计"],
    ["运行日志", "应用错误日志"],
    ["系统状态", "运行状态"]
  ] as const;
  for (const [tab, heading] of tabs) {
    await page.getByRole("button", { name: new RegExp(tab) }).click();
    await expect(page.getByRole("heading", { level: 1, name: tab })).toBeVisible();
    await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
  }
  await expect(page.getByRole("cell", { name: "tuzi", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "dataeyes", exact: true })).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "gpt-5.6-sol", exact: true })
  ).toHaveCount(2);

  await page.getByRole("button", { name: /用户管理/ }).click();
  await expect(page.getByText(userEmail!, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /材料管理/ }).click();
  await expect(page.getByText(/core-ai-agreement-/).first()).toBeVisible();

  const announcementTitle = `AI 全链路公告 ${Date.now()}`;
  await page.getByRole("button", { name: /公告设置/ }).click();
  await page.getByRole("button", { name: "新建公告" }).click();
  let editor = page.getByRole("region", { name: "公告编辑器" });
  await editor.getByLabel("公告标题").fill(announcementTitle);
  await editor.getByLabel("公告正文").fill("AI 站公告发布与用户端展示已打通。");
  await editor.getByLabel("投放位置").selectOption("ai");
  await editor.getByRole("button", { name: "保存公告" }).click();
  const announcement = page.getByRole("article", {
    name: `公告 ${announcementTitle}`
  });
  await announcement.getByRole("button", { name: "编辑公告" }).click();
  editor = page.getByRole("region", { name: "公告编辑器" });
  await editor.getByLabel("公告状态").selectOption("published");
  await editor.getByRole("button", { name: "保存公告" }).click();

  const publicContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const publicPage = await publicContext.newPage();
  await publicPage.goto(aiBaseUrl!);
  await expect(publicPage.getByText(announcementTitle, { exact: true })).toBeVisible();
  await expect(
    publicPage.getByText("AI 站公告发布与用户端展示已打通。", { exact: true })
  ).toBeVisible();
  await publicContext.close();

  await announcement.getByRole("button", { name: "编辑公告" }).click();
  editor = page.getByRole("region", { name: "公告编辑器" });
  await editor.getByLabel("公告状态").selectOption("archived");
  await editor.getByRole("button", { name: "保存公告" }).click();
  expectNoRuntimeFailures();
});
