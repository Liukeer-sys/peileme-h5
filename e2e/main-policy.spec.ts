import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type Page
} from "@playwright/test";

const baseUrl = process.env.E2E_BASE_URL;
const apiBaseUrl = process.env.E2E_API_URL || baseUrl;
const password = process.env.E2E_POLICY_PASSWORD || "PolicyE2ePass123";
const runId = process.env.E2E_RUN_ID || "task7-local";
const policyUser = {
  email: `policy-${runId}@peileme.test`,
  displayName: "政策验收"
};
const otherUser = {
  email: `other-${runId}@peileme.test`,
  displayName: "其他用户"
};

let apiContext: APIRequestContext;
let otherAccessToken = "";

test.describe.configure({ timeout: 30_000 });

const requireUrls = () => {
  if (!baseUrl) {
    throw new Error("E2E_BASE_URL is required for the main policy acceptance suite");
  }
  if (!apiBaseUrl) {
    throw new Error("E2E_API_URL or E2E_BASE_URL is required for API setup");
  }
};

const ensureUser = async (
  context: APIRequestContext,
  account: { email: string; displayName: string }
) => {
  const existing = await context.post("/api/auth/login", {
    data: { identifier: account.email, password }
  });
  if (existing.status() === 200) {
    return (await existing.json()) as { accessToken: string };
  }
  expect(existing.status()).toBe(401);
  const sent = await context.post("/api/auth/send-code", {
    data: { target: account.email, purpose: "register" }
  });
  expect(sent.status()).toBe(201);
  const { debugCode } = (await sent.json()) as { debugCode?: string };
  expect(debugCode).toMatch(/^\d{6}$/);
  const registered = await context.post("/api/auth/register", {
    data: {
      target: account.email,
      code: debugCode,
      password,
      displayName: account.displayName
    }
  });
  expect(registered.status()).toBe(201);
  return (await registered.json()) as { accessToken: string };
};

const bridgeApi = async (page: Page) => {
  requireUrls();
  const frontend = new URL(baseUrl!);
  const backend = new URL(apiBaseUrl!);
  if (frontend.origin === backend.origin) return;
  await page.route(`${frontend.origin}/api/**`, async (route) => {
    const target = new URL(route.request().url());
    target.protocol = backend.protocol;
    target.host = backend.host;
    await route.continue({ url: target.toString() });
  });
};

const watchRuntime = (page: Page) => {
  const browserErrors: string[] = [];
  const serverErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
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

const loginAs = async (
  page: Page,
  account: { email: string; displayName: string }
) => {
  await bridgeApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "密码登录" }).click();
  await page.getByLabel("邮箱 / 手机号").fill(account.email);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "登录", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: account.displayName, exact: true })
  ).toBeVisible();
};

const sendInput = async (page: Page, label: string, value: string) => {
  await page.getByLabel(label).fill(value);
  await page.getByRole("button", { name: "发送", exact: true }).click();
};

const completeQuestionnaire = async (
  page: Page,
  options: {
    city?: string;
    searchCity?: string;
    startMonth?: string;
    endMonth?: string;
    salary?: string;
    bonus?: string;
    termination?: "notice" | "unlawful";
  } = {}
) => {
  const city = options.city || "上海";
  if (options.searchCity) {
    await page
      .getByRole("button", { name: "选择全部省市", exact: true })
      .click();
    await page.getByLabel("搜索省份或城市").fill(options.searchCity);
    await page
      .getByRole("button", {
        name: new RegExp(options.searchCity)
      })
      .click();
  } else {
    await page.getByRole("button", { name: city, exact: true }).click();
  }

  await sendInput(page, "入职年月", options.startMonth || "2020-01");
  await sendInput(page, "解除年月", options.endMonth || "2026-07");
  await page
    .getByRole("button", { name: "基本双休，很少加班", exact: true })
    .click();
  await sendInput(page, "最近一年平均月工资（元）", options.salary || "15000");
  await page
    .getByRole("button", {
      name: options.bonus || "没有年终奖",
      exact: true
    })
    .click();
  await page.getByRole("button", { name: /单位要辞退我/ }).click();

  if (options.termination === "unlawful") {
    await page.getByRole("button", { name: /单位把锅扣我头上/ }).click();
    await page
      .getByRole("button", { name: /说我工作捅了大篓子/ })
      .click();
    await page
      .getByRole("button", { name: /并无以上问题.*乱扣帽子/ })
      .click();
  } else {
    await page
      .getByRole("button", { name: /我没错.*客观原因要辞退我/ })
      .click();
    await page
      .getByRole("button", { name: /说我没能力干这份工作/ })
      .click();
    await page.getByRole("button", { name: "是", exact: true }).click();
  }

  await page
    .getByRole("button", { name: /先大吃特吃一顿/ })
    .click();
};

const fillVisibleManualParameters = async (page: Page) => {
  const minimum = page.getByLabel("当地最低月工资（元）");
  if (await minimum.isVisible()) await minimum.fill("2690");
  const average = page.getByLabel("当地上年度职工月平均工资（元）");
  if (await average.isVisible()) await average.fill("12307");
};

test.beforeAll(async () => {
  requireUrls();
  apiContext = await playwrightRequest.newContext({
    baseURL: apiBaseUrl,
    extraHTTPHeaders: {
      origin: new URL(baseUrl!).origin,
      "x-visitor-id": `visitor_${runId.replace(/\W/g, "")}`,
      "x-session-id": `session_${runId.replace(/\W/g, "")}`
    }
  });
  const health = await apiContext.get("/api/health");
  expect(health.status()).toBe(200);
  await ensureUser(apiContext, policyUser);
  otherAccessToken = (await ensureUser(apiContext, otherUser)).accessToken;
});

test.afterAll(async () => {
  await apiContext?.dispose();
});

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
});

test("登录后完整问卷使用服务端结果并在刷新后恢复", async ({ page }) => {
  const assertCleanRuntime = watchRuntime(page);
  await loginAs(page, policyUser);
  await completeQuestionnaire(page, {
    city: "上海",
    bonus: "1个月工资左右"
  });
  await expect(
    page.getByRole("region", { name: "提交政策测算" })
  ).toContainText("补充后本次结果会标记为估算");
  await expect(
    page.getByRole("region", { name: "近12个月应发工资" })
  ).toContainText("从早到晚");
  await page
    .getByLabel("第1个月应发工资（元，最早）")
    .fill("16001");
  await page
    .getByLabel("第12个月应发工资（元，解除前完整月）")
    .fill("17002");
  await page.screenshot({
    path: "test-results/task7-wage-series.png",
    fullPage: true
  });
  await fillVisibleManualParameters(page);

  const calculation = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/policy/calculate") &&
      response.request().method() === "POST"
  );
  await page
    .getByRole("button", { name: "生成政策测算", exact: true })
    .click();
  const created = await calculation;
  expect(created.status()).toBe(201);
  const submitted = created.request().postDataJSON() as {
    terminationScenario: unknown;
    monthlyEarnedWagesFen: number[];
  };
  expect(submitted.terminationScenario).toEqual({
    kind: "ARTICLE_40",
    noticeMethod: "notice_30_days"
  });
  expect(submitted.monthlyEarnedWagesFen).toHaveLength(12);
  expect(submitted.monthlyEarnedWagesFen[0]).toBe(1_600_100);
  expect(submitted.monthlyEarnedWagesFen[1]).toBe(1_625_000);
  expect(submitted.monthlyEarnedWagesFen[11]).toBe(1_700_200);
  await expect(
    page.getByRole("heading", { name: "政策测算结果", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "政策测算结果" })
  ).toContainText(/规则版本 v\d+/);
  await expect(page.getByRole("link", { name: /查看官方来源/ }).first()).toBeVisible();
  await page.screenshot({
    path: "test-results/task7-main-policy-result.png",
    fullPage: true
  });

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "政策测算结果", exact: true })
  ).toBeVisible();
  const restoredAnswers = await page.evaluate(() => {
    const raw = window.sessionStorage.getItem("peileme-policy-answers");
    return raw ? JSON.parse(raw) : null;
  });
  expect(restoredAnswers.monthlyEarnedWagesFen).toEqual(
    submitted.monthlyEarnedWagesFen
  );
  assertCleanRuntime();
});

test("完整省市搜索可选择非快捷城市并补录缺失参数", async ({ page }) => {
  const assertCleanRuntime = watchRuntime(page);
  await loginAs(page, policyUser);
  await completeQuestionnaire(page, {
    searchCity: "阿拉善盟",
    bonus: "说不清 / 还没发"
  });
  await expect(
    page.getByRole("region", { name: "提交政策测算" })
  ).toContainText(/内蒙古自治区.*阿拉善盟/);
  await expect(
    page.getByRole("region", { name: "提交政策测算" })
  ).toContainText("补充后本次结果会标记为估算");
  await expect(
    page.getByRole("region", { name: "近12个月应发工资" })
  ).toContainText("奖金金额不确定，默认未计入");
  await fillVisibleManualParameters(page);
  const calculation = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/policy/calculate") &&
      response.request().method() === "POST"
  );
  await page
    .getByRole("button", { name: "生成政策测算", exact: true })
    .click();
  const created = await calculation;
  expect(created.status()).toBe(201);
  const submitted = created.request().postDataJSON() as {
    monthlyEarnedWagesFen: number[];
  };
  expect(submitted.monthlyEarnedWagesFen).toEqual(
    Array(12).fill(1_500_000)
  );
  await expect(
    page.getByRole("region", { name: "政策测算结果" })
  ).toContainText("估算");
  assertCleanRuntime();
});

test("服务端 422 会保留问卷并显示可恢复错误", async ({ page }) => {
  await loginAs(page, policyUser);
  await completeQuestionnaire(page, { city: "武汉" });
  await page.route("**/api/policy/calculate", async (route) => {
    await route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({
        error: "POLICY_RULE_UNAVAILABLE",
        message: "该日期暂无可用政策规则"
      })
    });
  });
  await page
    .getByRole("button", { name: "生成政策测算", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "该日期暂无可用政策规则"
  );
  await expect(
    page.getByRole("button", { name: "生成政策测算", exact: true })
  ).toBeEnabled();
});

test("网络失败会回到可重试状态并保留输入", async ({ page }) => {
  await loginAs(page, policyUser);
  await completeQuestionnaire(page, { city: "武汉" });
  await page.route("**/api/policy/calculate", (route) =>
    route.abort("connectionfailed")
  );
  await page
    .getByRole("button", { name: "生成政策测算", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("测算失败，请稍后重试");
  await expect(
    page.getByRole("region", { name: "提交政策测算" })
  ).toContainText("武汉市");
});

test("工资月明细支持1个月并在无效时阻止提交", async ({ page }) => {
  await loginAs(page, policyUser);
  await completeQuestionnaire(page, { city: "武汉" });
  await page.getByLabel("应发工资月份数").selectOption("1");
  await page
    .getByLabel("第1个月应发工资（元，最早，解除前完整月）")
    .fill("-1");
  let calculateRequests = 0;
  page.on("request", (request) => {
    if (
      request.url().endsWith("/api/policy/calculate") &&
      request.method() === "POST"
    ) {
      calculateRequests += 1;
    }
  });
  await page
    .getByRole("button", { name: "生成政策测算", exact: true })
    .click();

  await expect(page.getByRole("alert")).toContainText(
    "请检查近1至12个月的应发工资"
  );
  expect(calculateRequests).toBe(0);
  await expect(
    page.getByRole("region", { name: "近1个月应发工资" })
  ).toBeVisible();
  await page
    .getByLabel("第1个月应发工资（元，最早，解除前完整月）")
    .fill("12345");
  const calculation = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/policy/calculate") &&
      response.request().method() === "POST"
  );
  await page
    .getByRole("button", { name: "生成政策测算", exact: true })
    .click();
  const created = await calculation;
  expect(created.status()).toBe(201);
  expect(
    (
      created.request().postDataJSON() as {
        monthlyEarnedWagesFen: number[];
      }
    ).monthlyEarnedWagesFen
  ).toEqual([1_234_500]);
});

test("未登录用户提交时进入登录流程且不会创建计算记录", async ({ page }) => {
  await bridgeApi(page);
  await page.goto("/");
  await completeQuestionnaire(page, { city: "武汉" });
  let calculateRequests = 0;
  page.on("request", (request) => {
    if (
      request.url().endsWith("/api/policy/calculate") &&
      request.method() === "POST"
    ) {
      calculateRequests += 1;
    }
  });
  await page
    .getByRole("button", { name: "生成政策测算", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "登录赔了么", exact: true })
  ).toBeVisible();
  expect(calculateRequests).toBe(0);
});

test("历史列表展示完整详情且其他用户访问返回 404", async ({ page }) => {
  const assertCleanRuntime = watchRuntime(page);
  await loginAs(page, policyUser);
  await completeQuestionnaire(page, {
    city: "武汉",
    termination: "unlawful",
    bonus: "2个月工资左右"
  });
  await page
    .getByLabel("第1个月应发工资（元，最早）")
    .fill("17777");
  await page
    .getByLabel("第12个月应发工资（元，解除前完整月）")
    .fill("18888");
  const calculation = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/policy/calculate") &&
      response.request().method() === "POST"
  );
  await page
    .getByRole("button", { name: "生成政策测算", exact: true })
    .click();
  const created = await calculation;
  expect(created.status()).toBe(201);
  const originalInput = created.request().postDataJSON() as {
    terminationScenario: unknown;
    monthlyEarnedWagesFen: number[];
  };
  expect(originalInput.terminationScenario).toEqual({
    kind: "UNLAWFUL_TERMINATION",
    continuedPerformanceRequested: false,
    continuedPerformancePossible: false
  });
  expect(originalInput.monthlyEarnedWagesFen[0]).toBe(1_777_700);
  expect(originalInput.monthlyEarnedWagesFen[11]).toBe(1_888_800);
  const { assessmentId } = (await created.json()) as { assessmentId: string };

  await page
    .getByRole("button", { name: policyUser.displayName, exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "政策测算历史" })).toBeVisible();
  await page
    .getByRole("button", { name: new RegExp(`查看.*武汉`) })
    .first()
    .click();
  const accountDialog = page.getByRole("dialog");
  await expect(accountDialog).toContainText(/规则版本 v\d+/);
  await expect(
    accountDialog.getByRole("heading", { name: "完整计算公式" })
  ).toBeVisible();
  await expect(accountDialog).toContainText(/解除情形/);

  const forbidden = await apiContext.get(
    `/api/policy/history/${assessmentId}`,
    { headers: { authorization: `Bearer ${otherAccessToken}` } }
  );
  expect(forbidden.status()).toBe(404);
  const recalculation = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/policy/calculate") &&
      response.request().method() === "POST"
  );
  await accountDialog
    .getByRole("button", { name: "按此记录重新测算", exact: true })
    .click();
  const recalculated = await recalculation;
  expect(recalculated.status()).toBe(201);
  const restoredInput = recalculated.request().postDataJSON() as {
    terminationScenario: unknown;
    monthlyEarnedWagesFen: number[];
  };
  expect(restoredInput.terminationScenario).toEqual(
    originalInput.terminationScenario
  );
  expect(restoredInput.monthlyEarnedWagesFen).toEqual(
    originalInput.monthlyEarnedWagesFen
  );
  await expect(
    page.getByRole("heading", { name: "政策测算结果", exact: true })
  ).toBeVisible();
  assertCleanRuntime();
});

test("结果支持分享与重新测算", async ({ page }) => {
  const assertCleanRuntime = watchRuntime(page);
  await loginAs(page, policyUser);
  await completeQuestionnaire(page, { city: "武汉" });
  await page
    .getByRole("button", { name: "生成政策测算", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "政策测算结果", exact: true })
  ).toBeVisible();
  await page.getByRole("button", { name: "分享结果", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(/分享链接/);
  await page.getByRole("button", { name: "重新测算", exact: true }).click();
  await expect(page.getByRole("main")).toContainText("你在哪个城市工作？");
  await expect(
    page.getByRole("heading", { name: "政策测算结果", exact: true })
  ).toHaveCount(0);
  assertCleanRuntime();
});
