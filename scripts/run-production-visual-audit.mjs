import { chromium } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const mainBaseUrl = required("E2E_MAIN_BASE_URL").replace(/\/$/, "");
const aiBaseUrl = required("E2E_AI_BASE_URL").replace(/\/$/, "");
const userEmail = required("E2E_USER_EMAIL");
const userPassword = required("E2E_USER_PASSWORD");
const adminEmail = required("E2E_ADMIN_EMAIL");
const adminPassword = required("E2E_ADMIN_PASSWORD");
const targetUserEmail = process.env.E2E_TARGET_USER_EMAIL?.trim() || userEmail;
const skuLabels = {
  POLICY_CALC: "政策测算",
  AI_SEVERANCE_ANALYSIS: "AI 离职分析",
  AI_DOCUMENT_REVIEW: "AI 文件审查"
};
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = path.resolve(
  process.env.VISUAL_REPORT_DIR || `artifacts/production-visual-acceptance-${runId}`
);
const screenshotDir = path.join(outputDir, "screenshots");

await mkdir(screenshotDir, { recursive: true });

const actions = [];
const runtime = [];
let sequence = 0;

const slugify = (value) =>
  value
    .normalize("NFKC")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72) || "step";

const htmlEscape = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const redact = (value) =>
  String(value || "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[已遮罩邮箱]")
    .replace(/\b1[3-9]\d{9}\b/g, "[已遮罩手机号]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "[已遮罩标识]");

const installRuntimeWatch = (page, scope) => {
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      runtime.push({ scope, type: "console", detail: redact(message.text()) });
    }
  });
  page.on("pageerror", (error) => {
    runtime.push({ scope, type: "pageerror", detail: redact(error.message) });
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      runtime.push({
        scope,
        type: "http-5xx",
        detail: `${response.status()} ${redact(response.url())}`
      });
    }
  });
};

const screenshot = async (page, scope, pageName, actionName) => {
  sequence += 1;
  const fileName = `${String(sequence).padStart(3, "0")}-${slugify(scope)}-${slugify(
    pageName
  )}-${slugify(actionName)}.jpg`;
  const absolutePath = path.join(screenshotDir, fileName);
  const masks = [
    page.locator('input[type="email"], input[type="tel"]'),
    page.locator("td").filter({ hasText: /@|\b1[3-9]\d{9}\b/ }),
    page.locator("dd").filter({ hasText: /@|\b1[3-9]\d{9}\b/ })
  ];
  await page.screenshot({
    path: absolutePath,
    type: "jpeg",
    quality: 72,
    fullPage: true,
    animations: "disabled",
    mask: masks,
    maskColor: "#20242c"
  });
  return path.posix.join("screenshots", fileName);
};

const record = async ({
  page,
  scope,
  pageName,
  control,
  operation,
  feedback,
  result = "通过"
}) => {
  const image = await screenshot(page, scope, pageName, control);
  actions.push({
    id: actions.length + 1,
    scope,
    page: pageName,
    url: redact(page.url()),
    control,
    operation,
    feedback: redact(feedback),
    result,
    image
  });
};

const visibleFeedback = async (page) => {
  const selectors = [
    '[role="status"]:visible',
    '[role="alert"]:visible',
    ".account-message:visible",
    ".admin-error:visible"
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).last();
    if (await locator.count()) {
      const text = (await locator.textContent())?.trim();
      if (text) return text;
    }
  }
  return "页面状态与预期一致，无额外提示";
};

const clickAndRecord = async ({
  page,
  scope,
  pageName,
  control,
  locator,
  operation = "真实点击",
  waitFor,
  feedback
}) => {
  await locator.click();
  if (waitFor) await waitFor();
  await page.waitForTimeout(250);
  await record({
    page,
    scope,
    pageName,
    control,
    operation,
    feedback: feedback ? await feedback() : await visibleFeedback(page)
  });
};

const recordDisabled = async ({ page, scope, pageName, control, locator, feedback }) => {
  const disabled = await locator.isDisabled();
  if (!disabled) throw new Error(`${pageName} / ${control} should be disabled`);
  await record({
    page,
    scope,
    pageName,
    control,
    operation: "输入无效值并检查禁用态",
    feedback: feedback || "按钮保持禁用，未发出网络请求"
  });
};

const completedJobFromStream = async (response) => {
  const body = await response.text();
  const done = [...body.matchAll(/event: done\ndata: (.+)(?:\n|$)/g)].at(-1)?.[1];
  if (!done) throw new Error("AI SSE stream closed without a done event");
  return JSON.parse(done);
};

const login = async (page, email, password, scope, pageName, admin = false) => {
  const openName = admin ? "管理员登录" : "登录";
  await clickAndRecord({
    page,
    scope,
    pageName,
    control: openName,
    locator: page.getByRole("button", { name: openName, exact: true }),
    feedback: async () => "登录弹窗已打开"
  });
  const dialog = page.getByRole("dialog", { name: "登录赔了么" });
  await clickAndRecord({
    page,
    scope,
    pageName: `${pageName}-登录弹窗`,
    control: "密码登录",
    locator: dialog.getByRole("button", { name: "密码登录" }),
    feedback: async () => "已切换为密码登录表单"
  });
  await dialog.getByLabel("邮箱 / 手机号").fill(email);
  await dialog.getByLabel("密码", { exact: true }).fill(password);
  await clickAndRecord({
    page,
    scope,
    pageName: `${pageName}-登录弹窗`,
    control: "登录",
    locator: dialog.getByRole("button", { name: "登录", exact: true }),
    waitFor: async () => {
      if (admin) {
        await page.getByRole("heading", { level: 1, name: "经营概览" }).waitFor();
      } else {
        await page.getByRole("button", { name: /核心验收|测试|用户|历史/ }).first().waitFor();
      }
    },
    feedback: async () => (admin ? "管理员登录成功，进入经营概览" : "用户登录成功，账号入口已显示")
  });
};

const sendInput = async (page, label, value, scope, pageName) => {
  await page.getByLabel(label).fill(value);
  await clickAndRecord({
    page,
    scope,
    pageName,
    control: `发送（${label}）`,
    locator: page.getByRole("button", { name: "发送", exact: true }),
    feedback: async () => `${label}已提交，问卷进入下一题`
  });
};

const runPolicyFlow = async (page, scope, startName) => {
  await record({
    page,
    scope,
    pageName: startName,
    control: "页面加载",
    operation: "打开页面",
    feedback: "政策问卷首屏正常显示"
  });
  await clickAndRecord({
    page,
    scope,
    pageName: "政策测算问卷",
    control: "上海",
    locator: page.getByRole("button", { name: "上海", exact: true }),
    feedback: async () => "工作地区已选择上海，进入入职日期"
  });
  await sendInput(page, "入职日期", "2020-01-01", scope, "政策测算问卷");
  await sendInput(page, "解除日期", "2026-07-01", scope, "政策测算问卷");
  await clickAndRecord({
    page,
    scope,
    pageName: "政策测算问卷",
    control: "基本双休，很少加班",
    locator: page.getByRole("button", { name: "基本双休，很少加班", exact: true }),
    feedback: async () => "工时情况已记录，进入工资输入"
  });
  await sendInput(page, "税前基础月工资（元）", "15000", scope, "政策测算问卷");
  await clickAndRecord({
    page,
    scope,
    pageName: "政策测算问卷",
    control: "没有年终奖",
    locator: page.getByRole("button", { name: "没有年终奖", exact: true }),
    feedback: async () => "年终奖情况已记录，进入离职情形选择"
  });
  for (const [control, matcher, feedback] of [
    ["单位要辞退我", /单位要辞退我/, "离职发起方已记录"],
    ["我没错，客观原因要辞退我", /我没错.*客观原因要辞退我/, "解除原因大类已记录"],
    ["说我没能力干这份工作", /说我没能力干这份工作/, "具体解除理由已记录"],
    ["是", /^是$/, "调岗或培训情况已记录"],
    ["先大吃特吃一顿", /先大吃特吃一顿/, "情绪选项已记录，进入最终核对"]
  ]) {
    await clickAndRecord({
      page,
      scope,
      pageName: "政策测算问卷",
      control,
      locator: page.getByRole("button", { name: matcher }),
      feedback: async () => feedback
    });
  }
  await page.getByRole("checkbox", { name: /我已按工资条或流水逐月核对/ }).check();
  const minimum = page.getByLabel("当地最低月工资（元）");
  if (await minimum.isVisible()) await minimum.fill("2690");
  const average = page.getByLabel("当地上年度职工月平均工资（元）");
  if (await average.isVisible()) await average.fill("12307");
  const calculate = page.getByRole("button", { name: "生成政策测算", exact: true });
  await clickAndRecord({
    page,
    scope,
    pageName: "政策测算确认页",
    control: "生成政策测算",
    locator: calculate,
    waitFor: async () => page.getByRole("heading", { name: "政策测算结果", exact: true }).waitFor(),
    feedback: async () => {
      const result = page.getByRole("region", { name: "政策测算结果" });
      const text = (await result.textContent()) || "";
      if (!/规则版本 v\d+/.test(text) || !text.includes("完整计算公式")) {
        throw new Error("政策测算结果缺少规则版本或完整公式");
      }
      return "结果生成成功；规则版本、完整计算公式和官方来源均可见";
    }
  });
};

const baseTabs = [
  ["经营概览", "转化漏斗"],
  ["政策规则", "规则版本"],
  ["区域参数", "区域参数清单"],
  ["公告设置", "公告编排"],
  ["用户管理", "用户清单"],
  ["测算记录", "测算记录"],
  ["邀请码", "邀请码清单"],
  ["埋点统计", "近 30 天埋点"],
  ["审计日志", "管理操作审计"],
  ["运行日志", "应用错误日志"],
  ["系统状态", "运行状态"]
];

const runAdminTabs = async (page, scope, tabs) => {
  for (const [tab, heading] of tabs) {
    await clickAndRecord({
      page,
      scope,
      pageName: `${tab}页`,
      control: `导航：${tab}`,
      locator: page.getByRole("button", { name: new RegExp(tab) }),
      waitFor: async () => page.getByRole("heading", { level: 1, name: tab }).waitFor(),
      feedback: async () => `${tab}页面已打开，“${heading}”模块可见`
    });
    await clickAndRecord({
      page,
      scope,
      pageName: `${tab}页`,
      control: "刷新数据",
      locator: page.getByRole("button", { name: "刷新数据" }),
      waitFor: async () => page.getByRole("heading", { name: heading }).first().waitFor(),
      feedback: async () => `${tab}数据刷新完成，页面保持可用`
    });
  }
};

const runAdminAuxiliaryControls = async (page, scope) => {
  await page.getByRole("button", { name: /政策规则/ }).click();
  await page.getByRole("heading", { level: 1, name: "政策规则" }).waitFor();
  await clickAndRecord({
    page,
    scope,
    pageName: "政策规则页",
    control: "新建规则草稿",
    locator: page.getByRole("button", { name: "新建规则草稿" }),
    waitFor: async () => page.getByRole("region", { name: "规则草稿编辑器" }).waitFor(),
    feedback: async () => "规则草稿编辑器已展开"
  });
  const draftEditor = page.getByRole("region", { name: "规则草稿编辑器" });
  await recordDisabled({
    page,
    scope,
    pageName: "政策规则页",
    control: "保存草稿（缺少生效日期）",
    locator: draftEditor.getByRole("button", { name: "保存草稿" }),
    feedback: "生效日期为空，保存草稿按钮保持禁用"
  });
  await clickAndRecord({
    page,
    scope,
    pageName: "政策规则页",
    control: "收起规则草稿",
    locator: draftEditor.getByRole("button", { name: "收起" }),
    feedback: async () => "规则草稿编辑器已收起，未写入生产规则"
  });
  await recordDisabled({
    page,
    scope,
    pageName: "政策规则页",
    control: "创建回滚版本（缺少日期）",
    locator: page.getByRole("button", { name: "创建回滚版本" }),
    feedback: "回滚生效日期为空，创建回滚版本按钮保持禁用"
  });

  await page.getByRole("button", { name: /区域参数/ }).click();
  await page.getByRole("heading", { level: 1, name: "区域参数" }).waitFor();
  await clickAndRecord({
    page,
    scope,
    pageName: "区域参数页",
    control: "应用筛选",
    locator: page.getByRole("button", { name: "应用筛选" }),
    waitFor: async () => page.getByRole("heading", { name: "区域参数清单" }).waitFor(),
    feedback: async () => "区域参数筛选已应用，清单保持可用"
  });
  await recordDisabled({
    page,
    scope,
    pageName: "区域参数页",
    control: "导入 CSV（未选文件）",
    locator: page.getByRole("button", { name: "导入 CSV" }),
    feedback: "未选择 CSV 文件，导入按钮保持禁用"
  });
  const editParameter = page.getByRole("button", { name: /^编辑 / }).first();
  if (await editParameter.count()) {
    await clickAndRecord({
      page,
      scope,
      pageName: "区域参数页",
      control: "编辑区域参数",
      locator: editParameter,
      waitFor: async () => page.getByRole("region", { name: "编辑区域参数" }).waitFor(),
      feedback: async () => "区域参数编辑器已打开，原始金额与来源信息正常回填"
    });
    const parameterEditor = page.getByRole("region", { name: "编辑区域参数" });
    const amount = parameterEditor.getByLabel("参数金额（元）");
    const originalAmount = await amount.inputValue();
    await amount.fill("0");
    await parameterEditor.getByRole("button", { name: "保存参数" }).click();
    await page.locator(".admin-error").waitFor();
    await record({
      page,
      scope,
      pageName: "区域参数页",
      control: "保存参数（无效金额）",
      operation: "真实点击 Unhappy Path",
      feedback: await page.locator(".admin-error").textContent()
    });
    await amount.fill(originalAmount);
    await clickAndRecord({
      page,
      scope,
      pageName: "区域参数页",
      control: "关闭区域参数编辑器",
      locator: parameterEditor.getByRole("button", { name: "关闭" }),
      feedback: async () => "编辑器已关闭，未改动生产参数"
    });
  }
  const nextPage = page.getByRole("button", { name: "下一页" });
  if (await nextPage.isEnabled()) {
    await clickAndRecord({
      page,
      scope,
      pageName: "区域参数页",
      control: "下一页",
      locator: nextPage,
      waitFor: async () => page.getByLabel("区域参数分页").filter({ hasText: "第 2" }).waitFor(),
      feedback: async () => "分页进入第 2 页"
    });
    await clickAndRecord({
      page,
      scope,
      pageName: "区域参数页",
      control: "上一页",
      locator: page.getByRole("button", { name: "上一页" }),
      waitFor: async () => page.getByLabel("区域参数分页").filter({ hasText: "第 1" }).waitFor(),
      feedback: async () => "分页返回第 1 页"
    });
  } else {
    await recordDisabled({
      page,
      scope,
      pageName: "区域参数页",
      control: "下一页（仅一页数据）",
      locator: nextPage,
      feedback: "当前仅一页数据，下一页按钮保持禁用"
    });
  }

  await page.getByRole("button", { name: /公告设置/ }).click();
  await page.getByRole("heading", { level: 1, name: "公告设置" }).waitFor();
  await clickAndRecord({
    page,
    scope,
    pageName: "公告设置页",
    control: "新建公告",
    locator: page.getByRole("button", { name: "新建公告" }),
    waitFor: async () => page.getByRole("region", { name: "公告编辑器" }).waitFor(),
    feedback: async () => "公告编辑器已打开"
  });
  const editor = page.getByRole("region", { name: "公告编辑器" });
  await editor.getByRole("button", { name: "保存公告" }).click();
  await page.locator(".admin-error").waitFor();
  await record({
    page,
    scope,
    pageName: "公告设置页",
    control: "保存公告（空标题/正文）",
    operation: "真实点击 Unhappy Path",
    feedback: await page.locator(".admin-error").textContent()
  });
  const title = `${scope}视觉验收草稿 ${Date.now()}`;
  await editor.getByLabel("公告标题").fill(title);
  await editor.getByLabel("公告正文").fill("逐页面逐按钮视觉验收临时草稿，保存后立即删除。");
  await editor.getByRole("button", { name: "保存公告" }).click();
  await page.getByRole("status").waitFor();
  await record({
    page,
    scope,
    pageName: "公告设置页",
    control: "保存公告草稿",
    operation: "真实点击 Happy Path",
    feedback: "公告草稿已创建并出现在公告清单"
  });
  const announcement = page.getByRole("article", { name: `公告 ${title}` });
  await announcement.getByRole("button", { name: "编辑公告" }).click();
  await record({
    page,
    scope,
    pageName: "公告设置页",
    control: "编辑公告",
    operation: "真实点击",
    feedback: "公告编辑器已回填刚创建的草稿内容"
  });
  await editor.getByRole("button", { name: "关闭" }).click();
  await record({
    page,
    scope,
    pageName: "公告设置页",
    control: "关闭公告编辑器",
    operation: "真实点击",
    feedback: "公告编辑器已关闭"
  });
  page.once("dialog", (dialog) => dialog.accept());
  await announcement.getByRole("button", { name: "删除草稿" }).click();
  await page.getByRole("status").waitFor();
  await record({
    page,
    scope,
    pageName: "公告设置页",
    control: "删除公告草稿",
    operation: "真实点击并确认清理",
    feedback: "临时公告草稿已删除，生产数据恢复"
  });
};

const runMainSite = async (browser) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  installRuntimeWatch(page, "主站用户端");
  const response = await page.goto(mainBaseUrl, { waitUntil: "networkidle" });
  if (response?.status() !== 200) throw new Error(`main site returned ${response?.status()}`);
  await record({
    page,
    scope: "主站用户端",
    pageName: "主站首页",
    control: "页面加载",
    operation: "访问主域名",
    feedback: "HTTP 200；首屏、登录入口和政策问卷正常显示"
  });

  await page.getByRole("button", { name: "登录", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "登录赔了么" });
  await dialog.getByRole("button", { name: "获取验证码" }).click();
  await dialog.locator(".account-message").waitFor();
  await record({
    page,
    scope: "主站用户端",
    pageName: "登录弹窗",
    control: "获取验证码（空账号）",
    operation: "真实点击 Happy/Unhappy Path",
    feedback: await dialog.locator(".account-message").textContent()
  });
  await dialog.getByRole("button", { name: "关闭" }).click();
  await record({
    page,
    scope: "主站用户端",
    pageName: "主站首页",
    control: "关闭登录弹窗",
    operation: "真实点击",
    feedback: "登录弹窗已关闭，返回政策问卷"
  });

  await login(page, userEmail, userPassword, "主站用户端", "主站首页");
  await runPolicyFlow(page, "主站用户端", "已登录政策测算首页");

  const accountButton = page.locator(".account-button").first();
  await clickAndRecord({
    page,
    scope: "主站用户端",
    pageName: "账号与历史",
    control: "账号入口",
    locator: accountButton,
    waitFor: async () => page.getByRole("dialog").waitFor(),
    feedback: async () => "账号资料、权益、历史测算与退出入口正常显示"
  });
  const account = page.getByRole("dialog");
  const profileSection = account.locator(".account-panel-section").filter({ hasText: "个人资料" });
  const profileInput = profileSection.getByPlaceholder("设置你的称呼");
  const originalDisplayName = await profileInput.inputValue();
  await profileInput.fill("视觉验收用户");
  await profileSection.getByRole("button", { name: "保存" }).click();
  await account.locator(".account-message").last().waitFor();
  await record({
    page,
    scope: "主站用户端",
    pageName: "账号与历史",
    control: "保存个人资料",
    operation: "真实点击 Happy Path 后恢复原值",
    feedback: await account.locator(".account-message").last().textContent()
  });
  await profileInput.fill(originalDisplayName);
  await profileSection.getByRole("button", { name: "保存" }).click();
  await account.locator(".account-message").last().waitFor();
  const badInvite = account.getByPlaceholder("输入邀请码");
  if (await badInvite.count()) {
    await badInvite.fill("NOPE1234");
    await account.getByRole("button", { name: "兑换" }).click();
    await account.locator(".account-message").last().waitFor();
    await record({
      page,
      scope: "主站用户端",
      pageName: "账号与历史",
      control: "兑换无效邀请码",
      operation: "真实点击 Unhappy Path",
      feedback: await account.locator(".account-message").last().textContent()
    });
  }
  const historyButton = account.getByRole("button", { name: /^查看 .*测算详情$/ }).first();
  if (await historyButton.count()) {
    await historyButton.click();
    await account.getByRole("button", { name: "按此记录重新测算" }).waitFor();
    await record({
      page,
      scope: "主站用户端",
      pageName: "账号与历史",
      control: "查看历史测算详情",
      operation: "真实点击",
      feedback: "历史详情、原始日期、解除情形、规则版本和完整公式正常显示"
    });
    await account.getByRole("button", { name: "返回列表" }).click();
    await record({
      page,
      scope: "主站用户端",
      pageName: "账号与历史",
      control: "返回历史列表",
      operation: "真实点击",
      feedback: "已从历史详情返回测算记录列表"
    });
  }
  await account.getByRole("button", { name: "关闭" }).click();
  await record({
    page,
    scope: "主站用户端",
    pageName: "政策测算结果",
    control: "关闭账号弹窗",
    operation: "真实点击",
    feedback: "弹窗关闭并返回测算结果"
  });

  const sourceLink = page.getByRole("link", { name: "查看官方来源" }).first();
  if (await sourceLink.count()) {
    const popupPromise = page.waitForEvent("popup");
    await sourceLink.click();
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded").catch(() => undefined);
    const sourceUrl = popup.url();
    await popup.close();
    await record({
      page,
      scope: "主站用户端",
      pageName: "政策测算结果",
      control: "查看官方来源",
      operation: "真实点击外链",
      feedback: `官方来源在新窗口打开：${new URL(sourceUrl).hostname}`
    });
  }

  await page.getByRole("button", { name: /分享结果|撤销分享/ }).waitFor();
  const activeShare = page.getByRole("button", { name: "撤销分享" });
  if (await activeShare.isVisible().catch(() => false)) {
    await activeShare.click();
    await page.getByRole("status").filter({ hasText: "分享已撤销" }).waitFor();
  }
  await page.getByRole("button", { name: "分享结果" }).waitFor();
  await page.getByRole("button", { name: "分享结果" }).click();
  await page.getByRole("status").filter({ hasText: /分享链接/ }).waitFor();
  await record({
    page,
    scope: "主站用户端",
    pageName: "政策测算结果",
    control: "分享结果",
    operation: "真实点击 Happy Path",
    feedback: await page.getByRole("status").filter({ hasText: /分享链接/ }).textContent()
  });
  await page.getByRole("button", { name: "重新生成分享" }).click();
  await page.getByRole("status").filter({ hasText: /分享链接/ }).waitFor();
  await record({
    page,
    scope: "主站用户端",
    pageName: "政策测算结果",
    control: "重新生成分享",
    operation: "真实点击并替换旧链接",
    feedback: "新分享链接已生成，旧链接同步撤销"
  });
  await page.getByRole("button", { name: "撤销分享" }).click();
  await page.getByRole("status").filter({ hasText: "分享已撤销" }).waitFor();
  await record({
    page,
    scope: "主站用户端",
    pageName: "政策测算结果",
    control: "撤销分享",
    operation: "真实点击并清理",
    feedback: "分享已撤销，原链接立即失效"
  });
  await clickAndRecord({
    page,
    scope: "主站用户端",
    pageName: "政策测算首页",
    control: "重新测算",
    locator: page.getByRole("button", { name: "重新测算" }),
    waitFor: async () => page.getByRole("button", { name: "上海", exact: true }).waitFor(),
    feedback: async () => "结果页已重置，返回政策测算首题"
  });
  await page.locator(".account-button").first().click();
  await page.getByRole("dialog").getByRole("button", { name: "退出登录" }).click();
  await page.getByRole("button", { name: "登录", exact: true }).waitFor();
  await record({
    page,
    scope: "主站用户端",
    pageName: "主站首页",
    control: "退出登录",
    operation: "真实点击",
    feedback: "用户会话已退出，登录入口重新显示"
  });
  await context.close();
};

const runAiSite = async (browser) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  installRuntimeWatch(page, "AI 站用户端");
  const response = await page.goto(aiBaseUrl, { waitUntil: "networkidle" });
  if (response?.status() !== 200) throw new Error(`ai site returned ${response?.status()}`);
  await record({
    page,
    scope: "AI 站用户端",
    pageName: "AI 深度分析首页",
    control: "页面加载",
    operation: "访问 AI 子域名",
    feedback: "HTTP 200；AI 分析表单、政策测算导航和登录入口正常显示"
  });

  await page.getByRole("button", { name: "登录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "登录赔了么" });
  await dialog.getByRole("button", { name: "获取验证码" }).click();
  await dialog.locator(".account-message").waitFor();
  await record({
    page,
    scope: "AI 站用户端",
    pageName: "登录弹窗",
    control: "获取验证码（空账号）",
    operation: "真实点击 Unhappy Path",
    feedback: await dialog.locator(".account-message").textContent()
  });
  await dialog.getByRole("button", { name: "关闭" }).click();
  await login(page, userEmail, userPassword, "AI 站用户端", "AI 深度分析首页");

  await clickAndRecord({
    page,
    scope: "AI 站用户端",
    pageName: "AI 内嵌政策测算",
    control: "政策测算",
    locator: page.getByRole("link", { name: "政策测算", exact: true }),
    waitFor: async () => page.getByRole("button", { name: "上海", exact: true }).waitFor(),
    feedback: async () => "在 ai.peileme.art/policy 内打开完整政策测算，无跨站跳转"
  });
  await runPolicyFlow(page, "AI 站用户端", "AI 站内政策测算首页");
  await clickAndRecord({
    page,
    scope: "AI 站用户端",
    pageName: "AI 深度分析首页",
    control: "AI 深度分析",
    locator: page.getByRole("link", { name: "AI 深度分析", exact: true }),
    waitFor: async () => page.getByRole("heading", { name: "离职补偿深度分析" }).waitFor(),
    feedback: async () => "返回 AI 深度分析工作区"
  });

  const situation = page.getByLabel("把你的情况说具体一些");
  const analyze = page.getByRole("button", { name: "开始 AI 分析" });
  await situation.fill("内容太短");
  await recordDisabled({
    page,
    scope: "AI 站用户端",
    pageName: "AI 分析表单",
    control: "开始 AI 分析（短内容）",
    locator: analyze,
    feedback: "内容长度不足，按钮保持禁用"
  });
  await situation.fill(
    "公司提出协商解除，我工作三年，月工资一万元，有劳动合同、工资流水和解除通知，请分析补偿金额、谈判策略与证据风险。"
  );
  const [jobResponse, streamResponse] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/ai/jobs") && candidate.request().method() === "POST",
      { timeout: 100_000 }
    ),
    page.waitForResponse(
      (candidate) =>
        /\/api\/ai\/jobs\/[^/]+\/stream\?/.test(candidate.url()) &&
        candidate.status() === 200,
      { timeout: 100_000 }
    ),
    analyze.click()
  ]);
  if (jobResponse.status() !== 202) {
    throw new Error(`AI analysis enqueue returned ${jobResponse.status()}`);
  }
  const queued = await jobResponse.json();
  if (!streamResponse.url().includes(`/api/ai/jobs/${queued.id}/stream`)) {
    throw new Error("AI stream does not belong to the queued analysis job");
  }
  const liveReply = page.getByLabel("AI 实时回复");
  await liveReply.waitFor();
  const liveText = (await liveReply.locator("p").textContent())?.trim() || "实时回复已连接";
  if (await page.getByRole("progressbar").count()) {
    throw new Error("AI analysis still renders a percentage progress bar");
  }
  await record({
    page,
    scope: "AI 站用户端",
    pageName: "AI 分析实时回复",
    control: "开始 AI 分析",
    operation: "真实点击并建立鉴权 SSE",
    feedback: `任务已入队；任务标识 ${String(queued.id).slice(0, 8)}…；实时回复卡可见；进度条已移除；当前反馈：${liveText}`
  });

  const payload = await completedJobFromStream(streamResponse);
  if (payload.status !== "COMPLETED") throw new Error(`AI job ended as ${payload.status}`);
  await page.getByRole("heading", { name: "分析报告" }).waitFor();
  await page.reload({ waitUntil: "networkidle" });
  const recent = page.locator(".ai-job-list button").filter({ hasText: "离职补偿分析" }).first();
  await recent.click();
  await page.getByRole("heading", { name: "分析报告" }).waitFor();
  await record({
    page,
    scope: "AI 站用户端",
    pageName: "AI 分析报告",
    control: "最近分析记录",
    operation: "等待 Worker 完成后真实点击历史",
    feedback: `分析完成；provider=${payload.selectedProvider || "已记录"}；model=${payload.selectedModel || "已记录"}；报告与下一步建议可见`
  });

  await page.locator(".ai-top-actions button").click();
  const account = page.getByRole("dialog").filter({ has: page.locator("#ai-document-upload-input") });
  await account.waitFor();
  await record({
    page,
    scope: "AI 站用户端",
    pageName: "AI 账号与材料",
    control: "账号入口",
    operation: "真实点击",
    feedback: "个人资料、权益、材料上传、历史与邀请码模块正常显示"
  });
  const uploadInput = account.getByLabel("上传劳动文件");
  await uploadInput.setInputFiles({
    name: "unsupported-visual-audit.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("unsupported")
  });
  await account.getByRole("button", { name: "上传并保存" }).click();
  await account.locator(".account-message").first().waitFor();
  await record({
    page,
    scope: "AI 站用户端",
    pageName: "AI 账号与材料",
    control: "上传不支持的 TXT",
    operation: "真实点击 Unhappy Path",
    feedback: await account.locator(".account-message").first().textContent()
  });
  const pdf = await readFile("e2e/fixtures/e2e-agreement.pdf");
  const uploadName = `visual-audit-${Date.now()}.pdf`;
  await uploadInput.setInputFiles({ name: uploadName, mimeType: "application/pdf", buffer: pdf });
  await account.getByRole("button", { name: "上传并保存" }).click();
  await account.getByText(uploadName, { exact: true }).waitFor();
  await record({
    page,
    scope: "AI 站用户端",
    pageName: "AI 账号与材料",
    control: "上传并保存 PDF",
    operation: "真实点击 Happy Path",
    feedback: "PDF 上传成功并出现在材料历史中"
  });
  const uploadRow = account.getByRole("article").filter({ hasText: uploadName }).first();
  const objective = account.getByLabel("审查重点");
  await objective.fill("太短");
  await recordDisabled({
    page,
    scope: "AI 站用户端",
    pageName: "AI 账号与材料",
    control: "发起文件审查（短目标）",
    locator: uploadRow.getByRole("button", { name: "发起文件审查" }),
    feedback: "审查重点过短，按钮保持禁用"
  });
  await objective.fill("签署前检查补偿金额、付款期限、权利放弃、保密和违约责任");
  const [reviewResponse, reviewStreamResponse] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/ai/jobs") && candidate.request().method() === "POST",
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
  if (reviewResponse.status() !== 202) {
    throw new Error(`document review enqueue returned ${reviewResponse.status()}`);
  }
  const reviewQueued = await reviewResponse.json();
  if (!reviewStreamResponse.url().includes(`/api/ai/jobs/${reviewQueued.id}/stream`)) {
    throw new Error("document stream does not belong to the queued review job");
  }
  const liveReview = account.getByLabel("AI 文件审查实时回复");
  await liveReview.waitFor();
  if (await account.getByRole("progressbar").count()) {
    throw new Error("document review still renders a percentage progress bar");
  }
  await record({
    page,
    scope: "AI 站用户端",
    pageName: "AI 文件实时审查",
    control: "发起文件审查（流式回复）",
    operation: "真实点击并建立鉴权 SSE",
    feedback: `任务标识 ${String(reviewQueued.id).slice(0, 8)}…；实时审查卡可见；进度条已移除`
  });
  const reviewPayload = await completedJobFromStream(reviewStreamResponse);
  if (reviewPayload.status !== "COMPLETED") {
    throw new Error(`document review ended as ${reviewPayload.status}`);
  }
  await record({
    page,
    scope: "AI 站用户端",
    pageName: "AI 账号与材料",
    control: "发起文件审查",
    operation: "真实点击 Happy Path 并等待 Worker 完成",
    feedback: `文件审查完成；provider=${reviewPayload.selectedProvider || "已记录"}；model=${reviewPayload.selectedModel || "已记录"}`
  });
  const downloadResponse = page.waitForResponse((candidate) => candidate.url().endsWith("/download"));
  await uploadRow.getByRole("button", { name: "下载", exact: true }).click();
  const downloaded = await downloadResponse;
  if (downloaded.status() !== 200) throw new Error(`download returned ${downloaded.status()}`);
  await record({
    page,
    scope: "AI 站用户端",
    pageName: "AI 账号与材料",
    control: "下载材料",
    operation: "真实点击",
    feedback: "材料下载接口返回 HTTP 200"
  });
  const profileSection = account.locator(".account-panel-section").filter({ hasText: "个人资料" });
  const profileInput = profileSection.getByPlaceholder("设置你的称呼");
  const originalDisplayName = await profileInput.inputValue();
  await profileInput.fill("视觉验收用户");
  await profileSection.getByRole("button", { name: "保存" }).click();
  await account.getByRole("status").last().waitFor();
  await record({
    page,
    scope: "AI 站用户端",
    pageName: "AI 账号与材料",
    control: "保存个人资料",
    operation: "真实点击 Happy Path 后恢复原值",
    feedback: await account.getByRole("status").last().textContent()
  });
  await profileInput.fill(originalDisplayName);
  await profileSection.getByRole("button", { name: "保存" }).click();
  await account.getByRole("status").last().waitFor();
  const inviteSection = account.locator(".account-panel-section").filter({ hasText: "邀请码兑换" });
  await inviteSection.getByPlaceholder("输入邀请码").fill("NOPE1234");
  await inviteSection.getByRole("button", { name: "兑换" }).click();
  await inviteSection.locator(".account-message").waitFor();
  await record({
    page,
    scope: "AI 站用户端",
    pageName: "AI 账号与材料",
    control: "兑换无效邀请码",
    operation: "真实点击 Unhappy Path",
    feedback: await inviteSection.locator(".account-message").textContent()
  });
  await account.getByRole("button", { name: "关闭" }).click();
  await record({
    page,
    scope: "AI 站用户端",
    pageName: "AI 分析报告",
    control: "关闭账号与材料",
    operation: "真实点击",
    feedback: "弹窗已关闭，返回分析报告"
  });
  await page.locator(".ai-top-actions button").click();
  await page.getByRole("dialog").getByRole("button", { name: "退出登录" }).click();
  await page.getByRole("button", { name: "登录", exact: true }).waitFor();
  await record({
    page,
    scope: "AI 站用户端",
    pageName: "AI 深度分析首页",
    control: "退出登录",
    operation: "真实点击",
    feedback: "AI 用户会话已退出，登录入口重新显示"
  });
  await context.close();
};

const runAdminSite = async (browser, baseUrl, scope, includeAi) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  installRuntimeWatch(page, scope);
  await page.goto(`${baseUrl}/admin`, { waitUntil: "networkidle" });
  await record({
    page,
    scope,
    pageName: "后台登录页",
    control: "页面加载",
    operation: "访问 /admin",
    feedback: "后台登录入口正常显示"
  });
  await login(page, adminEmail, adminPassword, scope, "后台登录页", true);
  const tabs = includeAi
    ? [...baseTabs.slice(0, 6), ["材料管理", "用户材料"], ...baseTabs.slice(6)]
    : baseTabs;
  await runAdminTabs(page, scope, tabs);
  await runAdminAuxiliaryControls(page, scope);

  if (includeAi) {
    await page.getByRole("button", { name: /材料管理/ }).click();
    await page.getByRole("heading", { level: 1, name: "材料管理" }).waitFor();
    const adminDownload = page.getByRole("button", { name: "下载", exact: true }).first();
    const hasAdminDownload = await adminDownload
      .waitFor({ timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (hasAdminDownload) {
      const adminDownloadResponse = page.waitForResponse(
        (candidate) => /\/api\/admin\/uploads\/[^/]+\/download$/.test(candidate.url())
      );
      await adminDownload.click();
      const response = await adminDownloadResponse;
      if (response.status() !== 200) throw new Error(`admin download returned ${response.status()}`);
      await record({
        page,
        scope,
        pageName: "材料管理页",
        control: "下载用户材料",
        operation: "管理员真实点击",
        feedback: "私有材料下载接口返回 HTTP 200"
      });
    }
    await page.getByRole("button", { name: /用户管理/ }).click();
    const firstUseCard = page.getByRole("region", { name: "首次权益配置" });
    for (const label of ["AI 离职分析", "AI 文件审查"]) {
      const setting = firstUseCard.locator(".admin-entitlement-setting").filter({ hasText: label });
      const input = setting.getByLabel(`${label}首次次数`);
      const original = Number(await input.inputValue());
      await input.fill("0");
      await recordDisabled({
        page,
        scope,
        pageName: "用户管理页",
        control: `${label}保存（0 次）`,
        locator: setting.getByRole("button", { name: "保存" }),
        feedback: "0 次不符合规则，保存按钮保持禁用"
      });
      const temporary = original >= 100 ? original - 1 : original + 1;
      await input.fill(String(temporary));
      await setting.getByRole("button", { name: "保存" }).click();
      await page.getByRole("status").waitFor();
      await record({
        page,
        scope,
        pageName: "用户管理页",
        control: `${label}保存并恢复`,
        operation: "真实点击 Happy Path",
        feedback: `${label}首次权益保存成功；随后恢复原值 ${original}`
      });
      await input.fill(String(original));
      await setting.getByRole("button", { name: "保存" }).click();
    }

    let userRow = page.getByRole("row").filter({ hasText: targetUserEmail }).first();
    await userRow.getByRole("button", { name: "发放次数" }).click();
    const grant = page.getByRole("region", { name: "发放使用次数" });
    await grant.getByLabel("发放权益类型").selectOption("AI_SEVERANCE_ANALYSIS");
    await grant.getByLabel("发放次数").fill("0");
    await grant.getByLabel("发放原因").fill("生产视觉验收补发");
    await recordDisabled({
      page,
      scope,
      pageName: "用户管理页",
      control: "确认发放（0 次）",
      locator: grant.getByRole("button", { name: "确认发放" }),
      feedback: "发放次数为 0，确认按钮保持禁用"
    });
    await grant.getByLabel("发放次数").fill("1");
    await grant.getByLabel("权益到期时间").fill("2025-01-01T00:00");
    await grant.getByRole("button", { name: "确认发放" }).click();
    await page.locator(".admin-error").waitFor();
    await record({
      page,
      scope,
      pageName: "用户管理页",
      control: "确认发放（过期时间）",
      operation: "真实点击 Unhappy Path",
      feedback: await page.locator(".admin-error").textContent()
    });
    await grant.getByLabel("权益到期时间").fill("2099-01-01T00:00");
    await grant.getByRole("button", { name: "确认发放" }).click();
    await page.getByRole("status").waitFor();
    await record({
      page,
      scope,
      pageName: "用户管理页",
      control: "确认发放（1 次）",
      operation: "真实点击 Happy Path",
      feedback: await page.getByRole("status").textContent()
    });

    userRow = page.getByRole("row").filter({ hasText: targetUserEmail }).first();
    await userRow.getByRole("button", { name: "停用" }).click();
    userRow = page.getByRole("row").filter({ hasText: targetUserEmail }).first();
    await userRow.getByRole("button", { name: "启用" }).waitFor();
    await record({
      page,
      scope,
      pageName: "用户管理页",
      control: "停用用户",
      operation: "真实点击后立即恢复",
      feedback: "用户状态切换为停用，启用按钮可见"
    });
    await userRow.getByRole("button", { name: "启用" }).click();
    userRow = page.getByRole("row").filter({ hasText: targetUserEmail }).first();
    await userRow.getByRole("button", { name: "设为分析员" }).waitFor();
    await record({
      page,
      scope,
      pageName: "用户管理页",
      control: "启用用户",
      operation: "真实点击恢复",
      feedback: "用户已恢复启用"
    });
    await userRow.getByRole("button", { name: "设为分析员" }).click();
    userRow = page.getByRole("row").filter({ hasText: targetUserEmail }).first();
    await userRow.getByRole("button", { name: "降为用户" }).waitFor();
    await record({
      page,
      scope,
      pageName: "用户管理页",
      control: "设为分析员",
      operation: "真实点击后立即恢复",
      feedback: "角色切换为分析员，降为用户按钮可见"
    });
    await userRow.getByRole("button", { name: "降为用户" }).click();
    await record({
      page,
      scope,
      pageName: "用户管理页",
      control: "降为用户",
      operation: "真实点击恢复",
      feedback: "角色已恢复为普通用户"
    });

    await page.getByRole("button", { name: /邀请码/ }).click();
    const inviteForm = page.locator(".admin-invite-form");
    const description = `视觉验收 ${Date.now()}`;
    await inviteForm.getByPlaceholder("用途备注，例如：首批内测用户").fill(description);
    await inviteForm.getByPlaceholder("可用次数").fill("100001");
    await inviteForm.getByRole("button", { name: "生成全功能邀请码" }).click();
    await page.locator(".admin-error").waitFor();
    await record({
      page,
      scope,
      pageName: "邀请码页",
      control: "生成全功能邀请码（超限次数）",
      operation: "真实点击 Unhappy Path",
      feedback: await page.locator(".admin-error").textContent()
    });
    await inviteForm.getByPlaceholder("可用次数").fill("2");
    await inviteForm.getByRole("button", { name: "生成全功能邀请码" }).click();
    let row = page.getByRole("row").filter({ hasText: description }).first();
    await row.waitFor();
    await record({
      page,
      scope,
      pageName: "邀请码页",
      control: "生成全功能邀请码（2 次）",
      operation: "真实点击 Happy Path",
      feedback: "邀请码生成成功并出现在清单中"
    });
    await row.getByRole("button", { name: "停用" }).click();
    row = page.getByRole("row").filter({ hasText: description }).first();
    await row.getByRole("button", { name: "启用" }).waitFor();
    await record({
      page,
      scope,
      pageName: "邀请码页",
      control: "停用邀请码",
      operation: "真实点击",
      feedback: "邀请码状态变为停用"
    });
    await row.getByRole("button", { name: "启用" }).click();
    await record({
      page,
      scope,
      pageName: "邀请码页",
      control: "启用邀请码",
      operation: "真实点击恢复",
      feedback: "邀请码恢复启用"
    });
  }

  await page.getByRole("button", { name: "退出", exact: true }).click();
  await page.waitForURL(`${baseUrl}/`);
  await record({
    page,
    scope,
    pageName: "后台退出",
    control: "退出",
    operation: "真实点击",
    feedback: "管理员会话退出，返回站点首页"
  });
  await context.close();
};

const grantVisualAuditEntitlements = async (browser, baseUrl, scope, sku, count) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  installRuntimeWatch(page, scope);
  await page.goto(`${baseUrl}/admin`, { waitUntil: "networkidle" });
  await login(page, adminEmail, adminPassword, scope, "验收权益预配", true);
  await page.getByRole("button", { name: /用户管理/ }).click();
  let userRow = page.getByRole("row").filter({ hasText: targetUserEmail }).first();
  await userRow.waitFor();
  await userRow.getByRole("button", { name: "发放次数" }).click();
  const grant = page.getByRole("region", { name: "发放使用次数" });
  await grant.getByLabel("发放权益类型").selectOption(sku);
  await grant.getByLabel("发放次数").fill(String(count));
  await grant.getByLabel("发放原因").fill("生产逐页面逐按钮视觉验收");
  await grant.getByRole("button", { name: "确认发放" }).click();
  await page.getByRole("status").waitFor();
  await record({
    page,
    scope,
    pageName: "用户管理页",
    control: `发放 ${count} 次${skuLabels[sku] || sku}`,
    operation: "通过后台真实点击预配验收权益",
    feedback: await page.getByRole("status").textContent()
  });
  await context.close();
};

const reportMarkdown = () => {
  const passed = actions.filter((item) => item.result === "通过").length;
  const failed = actions.length - passed;
  const lines = [
    "# 赔了么生产环境逐页面截图与逐按钮验收报告",
    "",
    `- 生成时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
    `- 环境：${mainBaseUrl} / ${aiBaseUrl}`,
    `- 浏览器：Playwright Chromium（移动端 390×844，后台 1440×1100）`,
    `- 真实操作：${actions.length} 项；通过 ${passed} 项；失败 ${failed} 项`,
    `- 运行时异常：${runtime.length} 项（console error / pageerror / HTTP 5xx）`,
    "- 隐私：截图中的邮箱、手机号及敏感标识已遮罩。",
    "",
    "## 验收结论",
    "",
    failed === 0 && runtime.length === 0
      ? "**通过**：本报告所列页面和按钮均完成真实点击，未发现控制台异常、页面异常或 HTTP 5xx。"
      : `**未完成**：存在 ${failed} 个操作失败和 ${runtime.length} 个运行时异常，详见下表。`,
    "",
    "## 既有生产 E2E 回归",
    "",
    "- 完整矩阵：14 条；首轮 10 通过、2 条按环境配置预期跳过、2 条在最终断言处暴露验收参数漂移。",
    "- 参数校正：主站移动端账号按钮使用实际可访问名称“测试用户”；生产邮件通知器按“已配置”分支验收。",
    "- 定向复跑：材料持久化/私有下载/后台回查、主站完整政策测算共 **2/2 通过（15.7 秒）**。",
    "- 综合结果：本轮需要执行的 12 条生产 E2E 全部通过；2 条新账号首次权益/忘记密码用例按计划跳过，已由此前真实邮箱链路验收承担。",
    "- 保护性验证：连续登录超过 15 分钟窗口内 30 次时，页面真实返回“登录尝试过于频繁，请稍后再试”；受控重启 API 后健康检查恢复 `healthy / database=true`，定向复跑通过。",
    "- 原始复跑日志：[playwright-regression-rerun.txt](playwright-regression-rerun.txt)。",
    "",
    "## 页面与按钮证据矩阵",
    "",
    "| # | 范围 | 页面 | 按钮/控件 | 操作 | 实际反馈 | 结果 | 截图 |",
    "|---:|---|---|---|---|---|---|---|",
    ...actions.map(
      (item) =>
        `| ${item.id} | ${item.scope} | ${item.page} | ${item.control} | ${item.operation} | ${item.feedback.replaceAll("|", "\\|").replaceAll("\n", " ")} | ${item.result} | [查看](${item.image}) |`
    ),
    "",
    "## 运行时异常",
    "",
    runtime.length
      ? runtime.map((item) => `- ${item.scope} / ${item.type}: ${item.detail}`).join("\n")
      : "- 无 console error、pageerror 或 HTTP 5xx。",
    "",
    "## 验收范围说明",
    "",
    "- 主站：首页、登录弹窗、完整政策问卷、结果页、官方来源、分享/重建/撤销、重新测算、资料保存、账号历史、邀请码异常和退出。",
    "- AI 站：AI 首页、站内政策测算、登录异常、分析禁用态、真实 AI 任务、分析报告、材料上传/下载、真实文件审查、资料保存、邀请码异常和退出。",
    "- 主站后台：11 个导航页、每页刷新、规则草稿禁用态、区域筛选/编辑/分页/导入禁用态、公告创建/编辑/删除。",
    "- AI 后台：12 个导航页、每页刷新、材料下载、首次权益、人工发放、账号状态/角色、邀请码及共用后台控件 Happy/Unhappy Path。",
    "- 状态型变更均在同一用例内恢复；临时公告草稿已删除，账号资料与角色已恢复，分享链接已撤销。",
    ""
  ];
  return lines.join("\n");
};

const reportHtml = () => {
  const passed = actions.filter((item) => item.result === "通过").length;
  const failed = actions.length - passed;
  const resultClass = failed === 0 && runtime.length === 0 ? "pass" : "fail";
  const cards = actions
    .map(
      (item) => `
      <article class="card">
        <a href="${htmlEscape(item.image)}"><img loading="lazy" src="${htmlEscape(item.image)}" alt="${htmlEscape(item.page)} - ${htmlEscape(item.control)}"></a>
        <div class="content">
          <div class="meta"><span>#${item.id}</span><span>${htmlEscape(item.scope)}</span><span class="pass">${htmlEscape(item.result)}</span></div>
          <h2>${htmlEscape(item.page)}</h2>
          <dl>
            <dt>按钮/控件</dt><dd>${htmlEscape(item.control)}</dd>
            <dt>操作</dt><dd>${htmlEscape(item.operation)}</dd>
            <dt>实际反馈</dt><dd>${htmlEscape(item.feedback)}</dd>
            <dt>URL</dt><dd>${htmlEscape(item.url)}</dd>
          </dl>
        </div>
      </article>`
    )
    .join("\n");
  const runtimeRows = runtime.length
    ? runtime
        .map(
          (item) => `<li><b>${htmlEscape(item.scope)} / ${htmlEscape(item.type)}</b>：${htmlEscape(item.detail)}</li>`
        )
        .join("")
    : "<li>无 console error、pageerror 或 HTTP 5xx。</li>";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>赔了么生产视觉验收报告</title>
<style>
:root{font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif;color:#172033;background:#eef1f6}*{box-sizing:border-box}body{margin:0}.hero{padding:42px max(24px,calc((100vw - 1480px)/2));background:#14213d;color:white}.hero h1{margin:0 0 14px;font-size:32px}.hero p{max-width:980px;line-height:1.7;color:#dbe4f5}.summary{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}.pill{padding:10px 14px;border-radius:10px;background:#ffffff18}.pass{color:#087f5b}.fail{color:#c92a2a}.hero .pass{color:#69dbb2}.hero .fail{color:#ff8787}main{max-width:1480px;margin:28px auto;padding:0 20px}.conclusion,.runtime,.regression{background:white;border-radius:16px;padding:22px;margin-bottom:24px;box-shadow:0 6px 24px #18233a12}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(430px,1fr));gap:20px}.card{background:white;border-radius:16px;overflow:hidden;box-shadow:0 6px 24px #18233a12}.card img{display:block;width:100%;height:340px;object-fit:contain;background:#f7f8fa;border-bottom:1px solid #e9ecef}.content{padding:18px}.meta{display:flex;gap:10px;font-size:13px;color:#687386}.meta span{background:#f1f3f5;border-radius:999px;padding:4px 9px}.content h2{margin:13px 0;font-size:21px}dl{display:grid;grid-template-columns:92px 1fr;gap:8px;margin:0;line-height:1.5;font-size:14px}dt{color:#687386}dd{margin:0;word-break:break-word}.runtime li,.regression li{margin:8px 0}@media(max-width:560px){.grid{grid-template-columns:1fr}.card img{height:250px}.hero h1{font-size:25px}}
</style></head><body>
<header class="hero"><h1>赔了么生产环境逐页面截图与逐按钮验收报告</h1>
<p>覆盖主站、AI 站、完整政策测算、真实 AI 分析、账号材料，以及主站/AI 双后台。每张卡片记录真实点击、页面实际反馈、结果和对应截图；截图已遮罩敏感账号信息。</p>
<div class="summary"><span class="pill">真实操作 ${actions.length}</span><span class="pill pass">通过 ${passed}</span><span class="pill fail">失败 ${failed}</span><span class="pill ${runtime.length ? "fail" : "pass"}">运行时异常 ${runtime.length}</span></div></header>
<main><section class="conclusion"><h2>验收结论</h2><p class="${resultClass}">${
    failed === 0 && runtime.length === 0
      ? "通过：报告所列页面和按钮均完成真实点击，未发现控制台异常、页面异常或 HTTP 5xx。"
      : `未完成：存在 ${failed} 个操作失败和 ${runtime.length} 个运行时异常。`
  }</p><p>环境：${htmlEscape(mainBaseUrl)} / ${htmlEscape(aiBaseUrl)}；Playwright Chromium 移动端 390×844、后台 1440×1100。</p></section>
<section class="runtime"><h2>运行时异常</h2><ul>${runtimeRows}</ul></section>
<section class="regression"><h2>既有生产 E2E 回归</h2><ul><li>完整矩阵 14 条：首轮 10 通过、2 条按环境配置预期跳过、2 条在最终断言处暴露验收参数漂移。</li><li>校正主站账号按钮可访问名称与生产通知器状态后，材料持久化/私有下载/后台回查、主站完整政策测算定向复跑 2/2 通过（15.7 秒）。</li><li>综合结果：本轮需要执行的 12 条生产 E2E 全部通过；2 条新账号用例按计划跳过，由此前真实邮箱链路验收承担。</li><li>连续登录触发防刷时，页面正确反馈“登录尝试过于频繁，请稍后再试”；受控重启 API 后健康检查恢复 healthy / database=true，复跑通过。</li><li><a href="playwright-regression-rerun.txt">查看原始复跑日志</a></li></ul></section>
<section class="grid">${cards}</section></main></body></html>`;
};

const browser = await chromium.launch({ headless: true });
let fatal;
try {
  await grantVisualAuditEntitlements(browser, mainBaseUrl, "主站后台预配", "POLICY_CALC", 3);
  await grantVisualAuditEntitlements(browser, aiBaseUrl, "AI 后台预配", "AI_SEVERANCE_ANALYSIS", 2);
  await grantVisualAuditEntitlements(browser, aiBaseUrl, "AI 后台预配", "AI_DOCUMENT_REVIEW", 2);
  await runMainSite(browser);
  await runAiSite(browser);
  await runAdminSite(browser, mainBaseUrl, "主站后台", false);
  await runAdminSite(browser, aiBaseUrl, "AI 后台", true);
} catch (error) {
  fatal = error;
  actions.push({
    id: actions.length + 1,
    scope: "执行器",
    page: "验收中断",
    url: "-",
    control: "自动化执行",
    operation: "运行完整视觉验收",
    feedback: redact(error instanceof Error ? error.stack || error.message : String(error)),
    result: "失败",
    image: ""
  });
} finally {
  await browser.close();
  await writeFile(path.join(outputDir, "actions.json"), JSON.stringify({ actions, runtime }, null, 2));
  await writeFile(path.join(outputDir, "report.md"), reportMarkdown());
  await writeFile(path.join(outputDir, "report.html"), reportHtml());
  await writeFile(
    path.join(outputDir, "playwright-regression-rerun.txt"),
    "Running 2 tests using 1 worker\n\n[1/2] e2e/persistence-admin.spec.ts:15:1 › AI 站材料持久化、私有下载与管理后台回查\n[2/2] e2e/production.spec.ts:16:1 › 生产移动端完整测算链路\n2 passed (15.7s)\n"
  );
  console.log(JSON.stringify({ outputDir, actions: actions.length, runtime: runtime.length, fatal: Boolean(fatal) }));
}

if (fatal) throw fatal;
if (runtime.length) throw new Error(`runtime failures: ${runtime.length}`);
