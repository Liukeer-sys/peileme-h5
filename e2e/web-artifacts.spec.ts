import { expect, test } from "@playwright/test";

const mainBaseUrl = process.env.E2E_MAIN_ARTIFACT_URL;
const aiBaseUrl = process.env.E2E_AI_ARTIFACT_URL;

test.describe("separate main and AI web artifacts", () => {
  test.skip(
    !mainBaseUrl || !aiBaseUrl,
    "需要 E2E_MAIN_ARTIFACT_URL 和 E2E_AI_ARTIFACT_URL"
  );

  test("main artifact keeps the policy questionnaire and excludes AI copy", async ({
    page
  }) => {
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

    await page.goto(mainBaseUrl!);
    await expect(page).toHaveTitle("赔了么 - 牛马身价预评估");
    await expect(page.getByText("AI 深度分析版")).toHaveCount(0);
    await page.getByRole("button", { name: "上海", exact: true }).click();
    await expect(page.locator(".composer input[type=month]")).toBeVisible();

    expect(browserErrors, browserErrors.join("\n")).toEqual([]);
    expect(serverErrors, serverErrors.join("\n")).toEqual([]);
  });

  test("AI artifact renders its own shell and links back to policy calculation", async ({
    page
  }) => {
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

    await page.goto(aiBaseUrl!);
    await expect(page).toHaveTitle("赔了么 AI - 离职补偿深度分析");
    await expect(page.getByText("AI 深度分析版", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "把材料、金额和风险一次讲清楚" })
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "政策测算" })).toHaveAttribute(
      "href",
      "https://peileme.art"
    );
    await expect(page.getByRole("button", { name: "上海", exact: true })).toHaveCount(
      0
    );

    expect(browserErrors, browserErrors.join("\n")).toEqual([]);
    expect(serverErrors, serverErrors.join("\n")).toEqual([]);
  });
});
