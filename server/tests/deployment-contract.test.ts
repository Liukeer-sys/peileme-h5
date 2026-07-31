import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const readProjectFile = (relativePath: string) =>
  readFile(path.join(projectRoot, relativePath), "utf8");

const serviceBlock = (compose: string, service: string) => {
  const match = compose.match(
    new RegExp(
      `^  ${service}:\\n[\\s\\S]*?(?=^  [a-z][a-z0-9-]*:\\n|^networks:\\n)`,
      "m"
    )
  );
  if (!match) throw new Error(`Compose service ${service} was not found`);
  return match[0];
};

describe("dual web deployment contract", () => {
  it("runs independent loopback web services behind the same healthy API", async () => {
    const compose = await readProjectFile("docker-compose.yml");
    const main = serviceBlock(compose, "web-main");
    const ai = serviceBlock(compose, "web-ai");

    expect(compose).not.toMatch(/^  web:\n/m);
    expect(main).toContain("dockerfile: Dockerfile.web-main");
    expect(main).toContain("container_name: peileme-web-main");
    expect(main).toContain(
      '"127.0.0.1:${WEB_MAIN_PORT:-18083}:80"'
    );
    expect(ai).toContain("dockerfile: Dockerfile.web-ai");
    expect(ai).toContain("container_name: peileme-web-ai");
    expect(ai).toContain('"127.0.0.1:${WEB_AI_PORT:-18084}:80"');

    for (const web of [main, ai]) {
      expect(web).toContain("api:");
      expect(web).toContain("condition: service_healthy");
      expect(web).toContain(
        "wget -qO- http://127.0.0.1/api/health"
      );
      expect(web).toContain("mem_limit: 128m");
      expect(web).toContain("cpus: 0.5");
      expect(web).toContain("logging: *logging");
      expect(web).toContain("- internal");
    }
    expect(main).toContain(
      "VITE_SHARE_URL: ${VITE_MAIN_URL:-https://peileme.art/}"
    );
    expect(ai).toContain(
      "VITE_SHARE_URL: ${VITE_AI_URL:-https://ai.peileme.art/}"
    );
    expect(serviceBlock(compose, "api")).toContain(
      "fetch('http://127.0.0.1:3001/api/health')"
    );
  });

  it("documents both local ports and public build URLs", async () => {
    const example = await readProjectFile(".env.example");

    expect(example).toContain("WEB_MAIN_PORT=18083");
    expect(example).toContain("WEB_AI_PORT=18084");
    expect(example).toContain("VITE_MAIN_URL=https://peileme.art/");
    expect(example).toContain("VITE_AI_URL=https://ai.peileme.art/");
    expect(example).not.toMatch(/^WEB_PORT=/m);
  });

  it("routes both domains through isolated TLS logs and certificates", async () => {
    const template = await readProjectFile(
      "deploy/openresty-site.conf.template"
    );

    expect(
      template.match(/server_name peileme\.art www\.peileme\.art;/g)
    ).toHaveLength(2);
    expect(
      template.match(/server_name ai\.peileme\.art;/g)
    ).toHaveLength(2);
    expect(template).toContain("proxy_pass http://127.0.0.1:18083;");
    expect(template).toContain("proxy_pass http://127.0.0.1:18084;");
    expect(template).toContain(
      "/www/sites/peileme.art/log/access.log"
    );
    expect(template).toContain(
      "/www/sites/ai.peileme.art/log/access.log"
    );
    expect(template).toContain(
      "/www/sites/peileme.art/ssl/fullchain.pem"
    );
    expect(template).toContain(
      "/www/sites/ai.peileme.art/ssl/fullchain.pem"
    );
    expect(template.match(/listen 443 ssl;/g)).toHaveLength(2);
    expect(
      template.match(/add_header Strict-Transport-Security/g)
    ).toHaveLength(2);
    expect(
      template.match(/add_header X-Content-Type-Options/g)
    ).toHaveLength(2);
    expect(template.match(/add_header X-Frame-Options/g)).toHaveLength(2);
    expect(template.match(/add_header Referrer-Policy/g)).toHaveLength(2);
  });

  it("keeps deploy, health, backup, migration and image rollback executable", async () => {
    const [runbook, backupScript] = await Promise.all([
      readProjectFile("docs/production-runbook.md"),
      readProjectFile("deploy/backup.sh")
    ]);

    expect(runbook).toContain("web-main");
    expect(runbook).toContain("web-ai");
    expect(runbook).toContain("127.0.0.1:18083");
    expect(runbook).toContain("127.0.0.1:18084");
    expect(runbook).toContain(
      "docker compose up -d --build --wait"
    );
    expect(runbook).toContain(
      "docker compose restart api web-main web-ai"
    );
    expect(runbook).toContain(
      "curl -fsS http://127.0.0.1:18083/api/health"
    );
    expect(runbook).toContain(
      "curl -fsS http://127.0.0.1:18084/api/health"
    );
    expect(runbook).toContain(
      "E2E_MAIN_BASE_URL=https://peileme.art"
    );
    expect(runbook).toContain(
      "E2E_AI_BASE_URL=https://ai.peileme.art"
    );
    expect(runbook).toContain("e2e/dual-web-compose.spec.ts");
    const browserSection = runbook.slice(
      runbook.indexOf("真实浏览器验收："),
      runbook.indexOf("## 发布")
    );
    expect(browserSection).not.toContain("e2e/web-artifacts.spec.ts");
    expect(runbook).toContain("规则迁移前必须完成数据库备份");
    const releaseSection = runbook.slice(
      runbook.indexOf("## 发布"),
      runbook.indexOf("## 镜像回滚")
    );
    const backupCommand =
      "/opt/1panel/docker/compose/peileme/deploy/backup.sh";
    expect(releaseSection).toContain(backupCommand);
    expect(releaseSection).toContain(
      'backup_output="$('
    );
    expect(releaseSection).toContain(
      'sed -n \'s/^Peileme backup completed: //p\''
    );
    expect(releaseSection).toContain(
      'gzip -t "$latest/database.sql.gz"'
    );
    expect(releaseSection).toContain(
      'tar -tzf "$latest/uploads.tar.gz" >/dev/null'
    );
    expect(releaseSection.indexOf(backupCommand)).toBeLessThan(
      releaseSection.indexOf("docker compose up -d --build --wait")
    );
    expect(
      releaseSection.indexOf('gzip -t "$latest/database.sql.gz"')
    ).toBeLessThan(
      releaseSection.indexOf("docker compose up -d --build --wait")
    );
    expect(
      releaseSection.indexOf(
        'tar -tzf "$latest/uploads.tar.gz" >/dev/null'
      )
    ).toBeLessThan(
      releaseSection.indexOf("docker compose up -d --build --wait")
    );
    expect(runbook).toContain("docker image tag peileme-web-main:latest");
    expect(runbook).toContain("docker image tag peileme-web-ai:latest");
    expect(runbook).toContain("rollback-");
    expect(backupScript).toMatch(
      /flock -n 9 \|\| \{[\s\S]*?exit 1/
    );
  });

  it("automates deliberate restart and database persistence acceptance", async () => {
    const [harness, packageJson] = await Promise.all([
      readProjectFile("scripts/run-dual-web-compose-e2e.mjs"),
      readProjectFile("package.json")
    ]);

    expect(harness).toContain("E2E_COMPOSE_PROJECT");
    expect(harness).not.toContain("E2E_DATABASE_URL");
    expect(harness).toContain("task9_restart_sentinel");
    expect(harness).toContain('"exec",');
    expect(harness).toContain('"db",');
    expect(harness).toContain(
      '["compose", "-p", composeProject, "restart"'
    );
    expect(harness).toContain(
      '"api", "web-main", "web-ai"'
    );
    expect(harness).toContain(
      '["compose", "-p", composeProject, "up", "-d", "--wait"]'
    );
    expect(harness).toContain("e2e/dual-web-compose.spec.ts");
    expect(packageJson).toContain(
      '"test:e2e:dual-compose": "node scripts/run-dual-web-compose-e2e.mjs"'
    );
  });
});
