import { expect, test } from "@playwright/test";

test("生产移动端完整测算链路", async ({ page }) => {
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
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/");
  await expect(page).toHaveTitle(/赔了么/);
  await page.getByRole("button", { name: "上海", exact: true }).click();

  const monthInput = page.locator(".composer input[type=month]");
  await monthInput.fill("2020-01");
  await page.locator(".composer").getByRole("button", { name: "发送" }).click();
  await expect(page.getByText(/公司通知你什么时候离职/)).toBeVisible();
  await page.waitForTimeout(1_800);
  await monthInput.fill("2026-07");
  await page.locator(".composer").getByRole("button", { name: "发送" }).click();

  const scheduleButton = page.getByRole("button", {
    name: "双休，但工作日经常晚下班",
    exact: true
  });
  await expect(scheduleButton).toBeVisible({ timeout: 20_000 });
  await scheduleButton.click();
  const salaryInput = page.locator(".composer input").first();
  await expect(salaryInput).toBeVisible({ timeout: 20_000 });
  await salaryInput.fill("15000");
  await page.locator(".composer").getByRole("button", { name: "发送" }).click();
  const bonusButton = page.getByRole("button", {
    name: "2个月工资左右",
    exact: true
  });
  await expect(bonusButton).toBeVisible({ timeout: 20_000 });
  await bonusButton.click();
  const terminationButton = page.getByRole("button", { name: /完全没有了/ });
  await expect(terminationButton).toBeVisible({ timeout: 20_000 });
  await terminationButton.click();
  const wishButton = page.getByRole("button", { name: /宅家躺到爽/ });
  await expect(wishButton).toBeVisible({ timeout: 20_000 });
  await wishButton.click();
  await page.getByRole("button", { name: "计算你的牛马身价" }).click();

  await expect(page.getByText("你的牛马身价（离职赔偿金）")).toBeVisible();
  await expect(page.getByText(/工作年限 N：约/)).toBeVisible();
  await page.screenshot({
    path: "test-results/production-mobile-result.png",
    fullPage: false
  });
  expect(serverErrors, serverErrors.join("\n")).toEqual([]);
  expect(browserErrors, browserErrors.join("\n")).toEqual([]);
});
