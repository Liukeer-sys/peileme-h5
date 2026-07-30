import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type Page
} from "@playwright/test";
import { Client } from "pg";

const baseUrl = process.env.E2E_BASE_URL;
const apiBaseUrl = process.env.E2E_API_URL || baseUrl;
const e2eDatabaseUrl = process.env.E2E_DATABASE_URL;
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
let userAccessToken = "";
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
    startDate?: string;
    endDate?: string;
    salary?: string;
    bonus?: string;
    termination?: "notice" | "unverified" | "contract";
    confirmWages?: boolean;
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

  await sendInput(page, "入职日期", options.startDate || "2020-01-01");
  await sendInput(page, "解除日期", options.endDate || "2026-07-01");
  await page
    .getByRole("button", { name: "基本双休，很少加班", exact: true })
    .click();
  await sendInput(page, "税前基础月工资（元）", options.salary || "15000");
  await page
    .getByRole("button", {
      name: options.bonus || "没有年终奖",
      exact: true
    })
    .click();
  if (options.termination === "contract") {
    await page.getByRole("button", { name: /劳动合同期满不续/ }).click();
    await page.getByRole("button", { name: /公司不续签/ }).click();
  } else {
    await page.getByRole("button", { name: /单位要辞退我/ }).click();
  }

  if (options.termination === "unverified") {
    await page.getByRole("button", { name: /单位把锅扣我头上/ }).click();
    await page
      .getByRole("button", { name: /说我工作捅了大篓子/ })
      .click();
    await page
      .getByRole("button", { name: /并无以上问题.*乱扣帽子/ })
      .click();
  } else if (options.termination !== "contract") {
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
  if (options.confirmWages !== false) {
    await page
      .getByRole("checkbox", { name: /我已按工资条或流水逐月核对/ })
      .check();
  }
};

const fillVisibleManualParameters = async (page: Page) => {
  const minimum = page.getByLabel("当地最低月工资（元）");
  if (await minimum.isVisible()) await minimum.fill("2690");
  const average = page.getByLabel("当地上年度职工月平均工资（元）");
  if (await average.isVisible()) await average.fill("12307");
};

const createPolicyFixture = async (
  overrides: Record<string, unknown> = {}
) => {
  const response = await apiContext.post("/api/policy/calculate", {
    headers: { authorization: `Bearer ${userAccessToken}` },
    data: {
      regionCode: "420100",
      startDate: "2020-01-01",
      endDate: "2026-07-01",
      terminationScenario: {
        kind: "ARTICLE_40",
        noticeMethod: "notice_30_days"
      },
      monthlyEarnedWagesFen: Array(12).fill(1_500_000),
      wageDataConfirmation: {
        confirmed: true,
        basis: "pretax_earned_including_bonus_allowance"
      },
      ...overrides
    }
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as { assessmentId: string };
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
  userAccessToken = (await ensureUser(apiContext, policyUser)).accessToken;
  otherAccessToken = (await ensureUser(apiContext, otherUser)).accessToken;
});

test.afterAll(async () => {
  await apiContext?.dispose();
});

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
});

test("登录弹窗支持初始焦点、焦点循环、Escape 与焦点归还", async ({
  page
}) => {
  await bridgeApi(page);
  await page.goto("/");
  const loginButton = page.getByRole("button", { name: "登录", exact: true });
  await loginButton.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("邮箱 / 手机号")).toBeFocused();

  const closeButton = dialog.getByRole("button", {
    name: "关闭",
    exact: true
  });
  await closeButton.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "忘记密码", exact: true })
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeButton).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(loginButton).toBeFocused();
});

test("登录后完整问卷使用服务端结果并在刷新后恢复", async ({ page }) => {
  const assertCleanRuntime = watchRuntime(page);
  await loginAs(page, policyUser);
  await completeQuestionnaire(page, {
    city: "上海",
    bonus: "1个月工资左右",
    confirmWages: false
  });
  await expect(
    page.getByRole("region", { name: "提交政策测算" })
  ).toContainText("补充后本次结果会标记为估算");
  await expect(
    page.getByRole("region", { name: "近12个月税前应发工资" })
  ).toContainText("从早到晚");
  await expect(
    page.getByRole("button", { name: "生成政策测算", exact: true })
  ).toBeDisabled();
  await page
    .getByLabel(
      "第1个月税前应发工资（含奖金、津贴、补贴，元，最早）"
    )
    .fill("16001");
  await page
    .getByLabel(
      "第2个月税前应发工资（含奖金、津贴、补贴，元）"
    )
    .fill("30000");
  await page
    .getByLabel(
      "第12个月税前应发工资（含奖金、津贴、补贴，元，解除前完整月）"
    )
    .fill("17002");
  await page
    .getByRole("checkbox", { name: /我已按工资条或流水逐月核对/ })
    .check();
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
    wageDataConfirmation: unknown;
  };
  expect(submitted.terminationScenario).toEqual({
    kind: "ARTICLE_40",
    noticeMethod: "notice_30_days"
  });
  expect(submitted.monthlyEarnedWagesFen).toHaveLength(12);
  expect(submitted.monthlyEarnedWagesFen[0]).toBe(1_600_100);
  expect(submitted.monthlyEarnedWagesFen[1]).toBe(3_000_000);
  expect(submitted.monthlyEarnedWagesFen[2]).toBe(1_500_000);
  expect(submitted.monthlyEarnedWagesFen[11]).toBe(1_700_200);
  expect(submitted.wageDataConfirmation).toEqual({
    confirmed: true,
    basis: "pretax_earned_including_bonus_allowance"
  });
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
    page.getByRole("region", { name: "近12个月税前应发工资" })
  ).toContainText("奖金不会自动计入");
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

for (const [
  boundaryName,
  boundaryStartDate,
  boundaryEndDate,
  boundaryCompensationMonths
] of [
  ["5个月29天按0.5N", "2026-01-02", "2026-07-01", 0.5],
  ["完整6个月按1N", "2026-01-01", "2026-07-01", 1]
] as const) {
  test(`完整日期边界：${boundaryName}`, async ({ page }) => {
    await loginAs(page, policyUser);
    await completeQuestionnaire(page, {
      city: "武汉",
      startDate: boundaryStartDate,
      endDate: boundaryEndDate,
      termination: "contract"
    });
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
      startDate: string;
      endDate: string;
    };
    expect(submitted).toMatchObject({
      startDate: boundaryStartDate,
      endDate: boundaryEndDate
    });
    expect(
      ((await created.json()) as { result: { compensationMonths: number } })
        .result.compensationMonths
    ).toBe(boundaryCompensationMonths);
  });
}

test("服务端 422 会保留问卷并显示可恢复错误", async ({ page }) => {
  await loginAs(page, policyUser);
  await completeQuestionnaire(page, { city: "武汉" });
  await page.route("**/api/policy/calculate", async (route) => {
    await route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({
        error: "REGIONAL_PARAMETERS_REQUIRED",
        message: "当前地区缺少官方参数",
        details: { missing: ["minimumMonthlyWageFen"] }
      })
    });
  });
  await page
    .getByRole("button", { name: "生成政策测算", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "当前地区缺少官方参数"
  );
  await expect(page.getByLabel("当地最低月工资（元）")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "生成政策测算", exact: true })
  ).toBeEnabled();
});

test("双击提交只创建一次政策测算", async ({ page }) => {
  await loginAs(page, policyUser);
  await completeQuestionnaire(page, { city: "武汉" });
  let calculateRequests = 0;
  await page.route("**/api/policy/calculate", async (route) => {
    calculateRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 180));
    await route.fallback();
  });
  const submit = page.getByRole("button", {
    name: "生成政策测算",
    exact: true
  });
  await submit.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });

  await expect(
    page.getByRole("heading", { name: "政策测算结果", exact: true })
  ).toBeVisible();
  expect(calculateRequests).toBe(1);
});

test("加载中重新测算后旧响应不会覆盖新流程", async ({ page }) => {
  await loginAs(page, policyUser);
  await completeQuestionnaire(page, { city: "武汉" });
  let releaseResponse!: () => void;
  let markBackendDone!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const backendDone = new Promise<void>((resolve) => {
    markBackendDone = resolve;
  });
  await page.route("**/api/policy/calculate", async (route) => {
    const response = await route.fetch();
    markBackendDone();
    await responseGate;
    await route.fulfill({ response }).catch(() => undefined);
  });
  await page
    .getByRole("button", { name: "生成政策测算", exact: true })
    .click();
  await backendDone;
  await page.getByRole("button", { name: "重算", exact: true }).click();
  releaseResponse();

  await expect(page.getByRole("main")).toContainText("你在哪个城市工作？");
  await expect(
    page.getByRole("heading", { name: "政策测算结果", exact: true })
  ).toHaveCount(0);
});

test("地区年份请求乱序时只采用最后一次选择", async ({ page }) => {
  await loginAs(page, policyUser);
  await completeQuestionnaire(page, { city: "武汉" });
  const regionsResponse = await apiContext.get("/api/policy/regions?year=2026");
  const payload = (await regionsResponse.json()) as {
    items: Array<Record<string, unknown> & { code: string }>;
  };
  const regionsFor = (manualNeeded: boolean) => ({
    items: payload.items.map((item) =>
      item.code === "420100"
        ? {
            ...item,
            parameterAvailability: {
              minimumMonthlyWage: manualNeeded ? "manual-needed" : "exact",
              employeeAverageMonthlyWage: manualNeeded
                ? "manual-needed"
                : "exact"
            }
          }
        : item
    )
  });
  await page.route("**/api/policy/regions?year=*", async (route) => {
    const year = new URL(route.request().url()).searchParams.get("year");
    if (year === "2025") {
      await new Promise((resolve) => setTimeout(resolve, 280));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(regionsFor(true))
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(regionsFor(false))
    });
  });
  await page.getByLabel("复核解除日期").fill("2025-07-01");
  await page.getByLabel("复核解除日期").fill("2024-07-01");

  await expect(page.getByLabel("当地最低月工资（元）")).toHaveCount(0);
  await expect(page.getByLabel("复核解除日期")).toHaveValue("2024-07-01");
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
    .getByLabel(
      "第1个月税前应发工资（含奖金、津贴、补贴，元，最早，解除前完整月）"
    )
    .fill("-1");
  await page
    .getByRole("checkbox", { name: /我已按工资条或流水逐月核对/ })
    .check();
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
    page.getByRole("region", { name: "近1个月税前应发工资" })
  ).toBeVisible();
  await page
    .getByLabel(
      "第1个月税前应发工资（含奖金、津贴、补贴，元，最早，解除前完整月）"
    )
    .fill("12345");
  await page
    .getByRole("checkbox", { name: /我已按工资条或流水逐月核对/ })
    .check();
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

test("旧历史快照先进入工资复核，重新确认后才创建结果", async ({
  page
}) => {
  test.skip(!e2eDatabaseUrl, "E2E_DATABASE_URL is required for legacy fixture");
  const legacy = await createPolicyFixture();
  const database = new Client({ connectionString: e2eDatabaseUrl });
  await database.connect();
  try {
    await database.query(
      `UPDATE policy_calculation_snapshots
          SET input = input - 'wageDataConfirmation'
        WHERE assessment_id = $1`,
      [legacy.assessmentId]
    );
  } finally {
    await database.end();
  }

  await loginAs(page, policyUser);
  await page
    .getByRole("button", { name: policyUser.displayName, exact: true })
    .click();
  await page
    .getByRole("button", { name: /查看.*武汉/ })
    .first()
    .click();
  const accountDialog = page.getByRole("dialog");
  await expect(accountDialog).toContainText("工资明细尚未复核");

  let calculateRequests = 0;
  page.on("request", (request) => {
    if (
      request.url().endsWith("/api/policy/calculate") &&
      request.method() === "POST"
    ) {
      calculateRequests += 1;
    }
  });
  await accountDialog
    .getByRole("button", { name: "按此记录重新测算", exact: true })
    .click();
  const submitPanel = page.getByRole("region", { name: "提交政策测算" });
  await expect(submitPanel).toBeVisible();
  await expect(submitPanel).toContainText("请重新核对逐月税前应发工资");
  const confirmation = page.getByRole("checkbox", {
    name: /我已按工资条或流水逐月核对/
  });
  await expect(confirmation).not.toBeChecked();
  expect(calculateRequests).toBe(0);

  await confirmation.check();
  const recalculation = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/policy/calculate") &&
      response.request().method() === "POST"
  );
  await page
    .getByRole("button", { name: "生成政策测算", exact: true })
    .click();
  expect((await recalculation).status()).toBe(201);
  expect(calculateRequests).toBe(1);
});

test("历史重算双击只创建一个结果且按钮显示忙碌", async ({ page }) => {
  await createPolicyFixture();
  const before = await apiContext.get("/api/policy/history", {
    headers: { authorization: `Bearer ${userAccessToken}` }
  });
  const beforeTotal = ((await before.json()) as {
    pagination: { total: number };
  }).pagination.total;

  await loginAs(page, policyUser);
  await page
    .getByRole("button", { name: policyUser.displayName, exact: true })
    .click();
  await page
    .getByRole("button", { name: /查看.*武汉/ })
    .first()
    .click();
  let calculateRequests = 0;
  await page.route("**/api/policy/calculate", async (route) => {
    calculateRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 180));
    await route.fallback();
  });
  const recalculate = page.getByRole("button", {
    name: "按此记录重新测算",
    exact: true
  });
  const completed = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/policy/calculate") &&
      response.request().method() === "POST" &&
      response.status() === 201
  );
  await recalculate.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(
    page.getByRole("button", { name: "正在重新测算…", exact: true })
  ).toBeDisabled();
  await completed;
  await expect(
    page.getByRole("heading", { name: "政策测算结果", exact: true })
  ).toBeVisible();
  expect(calculateRequests).toBe(1);

  const after = await apiContext.get("/api/policy/history", {
    headers: { authorization: `Bearer ${userAccessToken}` }
  });
  expect(
    ((await after.json()) as { pagination: { total: number } }).pagination.total
  ).toBe(beforeTotal + 1);
});

test("关闭历史重算并开始新流程后旧响应不会覆盖", async ({ page }) => {
  await loginAs(page, policyUser);
  await completeQuestionnaire(page, { city: "武汉" });
  await page
    .getByRole("button", { name: "生成政策测算", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "政策测算结果", exact: true })
  ).toBeVisible();
  await page
    .getByRole("button", { name: policyUser.displayName, exact: true })
    .click();
  await page
    .getByRole("button", { name: /查看.*武汉/ })
    .first()
    .click();

  let releaseResponse!: () => void;
  let markBackendDone!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const backendDone = new Promise<void>((resolve) => {
    markBackendDone = resolve;
  });
  await page.route("**/api/policy/calculate", async (route) => {
    const target = new URL(route.request().url());
    const backend = new URL(apiBaseUrl!);
    target.protocol = backend.protocol;
    target.host = backend.host;
    const response = await route.fetch({ url: target.toString() });
    markBackendDone();
    await responseGate;
    await route.fulfill({ response }).catch(() => undefined);
  });
  await page
    .getByRole("button", { name: "按此记录重新测算", exact: true })
    .click();
  await backendDone;
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "重算", exact: true }).click();
  releaseResponse();
  await page.waitForTimeout(350);

  await expect(page.getByRole("main")).toContainText("你在哪个城市工作？");
  await expect(
    page.getByRole("heading", { name: "政策测算结果", exact: true })
  ).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      window.sessionStorage.getItem("peileme-latest-policy-result")
    )
  ).toBeNull();
});

test("历史列表展示完整详情且其他用户访问返回 404", async ({ page }) => {
  const assertCleanRuntime = watchRuntime(page);
  await loginAs(page, policyUser);
  await completeQuestionnaire(page, {
    city: "武汉",
    termination: "unverified",
    bonus: "2个月工资左右"
  });
  await page
    .getByLabel(
      "第1个月税前应发工资（含奖金、津贴、补贴，元，最早）"
    )
    .fill("17777");
  await page
    .getByLabel(
      "第12个月税前应发工资（含奖金、津贴、补贴，元，解除前完整月）"
    )
    .fill("18888");
  await page
    .getByRole("checkbox", { name: /我已按工资条或流水逐月核对/ })
    .check();
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
    kind: "UNCLEAR",
    factGaps: ["需核验过错事实、严重程度、规章依据及单位解除程序"]
  });
  expect(originalInput.monthlyEarnedWagesFen[0]).toBe(1_777_700);
  expect(originalInput.monthlyEarnedWagesFen[11]).toBe(1_888_800);
  const { assessmentId } = (await created.json()) as { assessmentId: string };

  await page
    .getByRole("button", { name: policyUser.displayName, exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "政策测算历史" })).toBeVisible();
  await expect(
    page.getByRole("article", { name: /武汉市.*参考区间/ }).first()
  ).toBeVisible();
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

test("结果分享可匿名查看且创建者撤销后立即失效", async ({
  browser,
  page
}) => {
  const assertCleanRuntime = watchRuntime(page);
  await loginAs(page, policyUser);
  await completeQuestionnaire(page, { city: "武汉" });
  await page
    .getByRole("button", { name: "生成政策测算", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "政策测算结果", exact: true })
  ).toBeVisible();
  const createdShare = page.waitForResponse(
    (response) =>
      /\/api\/policy\/history\/[^/]+\/share$/.test(response.url()) &&
      response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "分享结果", exact: true }).click();
  const shareResponse = await createdShare;
  expect(shareResponse.status()).toBe(201);
  const share = (await shareResponse.json()) as {
    shareId: string;
    token: string;
  };
  await expect(page.getByRole("status")).toContainText(/分享链接/);

  const anonymousContext = await browser.newContext();
  const anonymousPage = await anonymousContext.newPage();
  await bridgeApi(anonymousPage);
  await anonymousPage.goto(`/?share=${encodeURIComponent(share.token)}`);
  await expect(
    anonymousPage.getByRole("heading", {
      name: "政策测算结果",
      exact: true
    })
  ).toBeVisible();
  await expect(
    anonymousPage.getByRole("button", { name: "查看历史" })
  ).toHaveCount(0);

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "政策测算结果", exact: true })
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText("已有有效分享");
  await expect(
    page.getByRole("button", { name: "撤销分享", exact: true })
  ).toBeVisible();
  const replacedShare = page.waitForResponse(
    (response) =>
      /\/api\/policy\/history\/[^/]+\/share$/.test(response.url()) &&
      response.request().method() === "POST" &&
      response.status() === 201
  );
  await page
    .getByRole("button", { name: "重新生成分享", exact: true })
    .click();
  const replacement = (await (await replacedShare).json()) as {
    token: string;
  };
  await anonymousPage.reload();
  await expect(
    anonymousPage.getByRole("heading", { name: "分享链接已失效" })
  ).toBeVisible();

  const replacementContext = await browser.newContext();
  const replacementPage = await replacementContext.newPage();
  await bridgeApi(replacementPage);
  await replacementPage.goto(
    `/?share=${encodeURIComponent(replacement.token)}`
  );
  await expect(
    replacementPage.getByRole("heading", {
      name: "政策测算结果",
      exact: true
    })
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole("status")).toContainText("已有有效分享");
  await page.getByRole("button", { name: "撤销分享", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("分享已撤销");
  await replacementPage.reload();
  await expect(
    replacementPage.getByRole("heading", { name: "分享链接已失效" })
  ).toBeVisible();
  await replacementContext.close();
  await anonymousContext.close();
  assertCleanRuntime();
});
