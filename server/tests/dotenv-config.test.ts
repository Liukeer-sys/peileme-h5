import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

describe("runtime dotenv configuration", () => {
  it("loads a local .env without overriding explicit process variables", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "peileme-dotenv-"));
    try {
      writeFileSync(
        path.join(directory, ".env"),
        [
          "APP_ORIGIN=http://env-main.test:5100,http://env-ai.test:5200",
          "MAIN_PRODUCT_HOSTS=env-main.test",
          "AI_PRODUCT_HOSTS=env-ai.test",
          "MAIN_APP_ORIGIN=http://env-main.test:5100",
          "AI_APP_ORIGIN=http://env-ai.test:5200"
        ].join("\n") + "\n"
      );
      const environment = { ...process.env };
      for (const name of [
        "NODE_ENV",
        "APP_ORIGIN",
        "MAIN_PRODUCT_HOSTS",
        "AI_PRODUCT_HOSTS",
        "MAIN_APP_ORIGIN",
        "AI_APP_ORIGIN"
      ]) {
        delete environment[name];
      }
      environment.NODE_ENV = "development";
      environment.MAIN_APP_ORIGIN = "http://explicit-main.test:5300";
      environment.MAIN_PRODUCT_HOSTS = "explicit-main.test";
      environment.APP_ORIGIN =
        "http://explicit-main.test:5300,http://env-ai.test:5200";
      const configUrl = pathToFileURL(
        path.resolve("server/config.ts")
      ).href;
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          require.resolve("tsx"),
          "--input-type=module",
          "--eval",
          `import { getConfig } from ${JSON.stringify(configUrl)}; const config = getConfig(); console.log(JSON.stringify({ appOrigin: config.APP_ORIGIN, mainOrigin: config.MAIN_APP_ORIGIN, aiOrigin: config.AI_APP_ORIGIN }));`
        ],
        {
          cwd: directory,
          encoding: "utf8",
          env: environment
        }
      );

      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout.trim())).toEqual({
        appOrigin:
          "http://explicit-main.test:5300,http://env-ai.test:5200",
        mainOrigin: "http://explicit-main.test:5300",
        aiOrigin: "http://env-ai.test:5200"
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
