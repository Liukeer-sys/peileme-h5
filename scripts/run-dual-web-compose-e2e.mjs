import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";

const requiredEnvironment = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const composeProject = requiredEnvironment("E2E_COMPOSE_PROJECT");
requiredEnvironment("E2E_MAIN_BASE_URL");
requiredEnvironment("E2E_AI_BASE_URL");
requiredEnvironment("E2E_ADMIN_EMAIL");
requiredEnvironment("E2E_ADMIN_PASSWORD");

if (!/^[a-z0-9][a-z0-9_-]*$/.test(composeProject)) {
  throw new Error("E2E_COMPOSE_PROJECT contains unsupported characters");
}
if (composeProject === "peileme") {
  throw new Error(
    "Refusing to run the restart harness against the production project"
  );
}

const runCommand = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with ${
            signal ? `signal ${signal}` : `exit code ${code}`
          }`
        )
      );
    });
  });

const runBrowserAcceptance = () =>
  runCommand("npx", [
    "playwright",
    "test",
    "e2e/dual-web-compose.spec.ts",
    "--reporter=list"
  ]);

const sentinel = `task9-restart-${randomUUID()}`;
const runSentinelSql = (sql) =>
  runCommand("docker", [
    "compose",
    "-p",
    composeProject,
    "exec",
    "-T",
    "-e",
    `TASK9_SQL=${sql}`,
    "db",
    "sh",
    "-lc",
    'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$TASK9_SQL"'
  ]);

const insertSentinel = `
  INSERT INTO analytics_events
    (event_name, visitor_id, session_id, path, properties)
  VALUES (
    'task9_restart_sentinel',
    '${sentinel}',
    '${sentinel}',
    '/task9-restart',
    jsonb_build_object('sentinel', '${sentinel}')
  );
`;
const assertSentinel = `
  DO $$
  BEGIN
    IF (
      SELECT count(*)
        FROM analytics_events
       WHERE event_name = 'task9_restart_sentinel'
         AND visitor_id = '${sentinel}'
    ) <> 1 THEN
      RAISE EXCEPTION 'restart sentinel count is not one';
    END IF;
  END
  $$;
`;
const deleteSentinel = `
  DELETE FROM analytics_events
   WHERE event_name = 'task9_restart_sentinel'
     AND visitor_id = '${sentinel}';
`;

let sentinelInserted = false;
let primaryError;
try {
  await runBrowserAcceptance();
  await runSentinelSql(insertSentinel);
  sentinelInserted = true;
  await runSentinelSql(assertSentinel);

  await runCommand("docker", [
    "compose",
    "-p",
    composeProject,
    "restart",
    "api",
    "ai-worker",
    "web-main",
    "web-ai"
  ]);
  await runCommand("docker", ["compose", "-p", composeProject, "up", "-d", "--wait"]);

  await runSentinelSql(assertSentinel);
  await runBrowserAcceptance();
  process.stdout.write(
    "Dual web Compose restart, health, login, and persistence acceptance passed\n"
  );
} catch (error) {
  primaryError = error;
}

if (sentinelInserted) {
  try {
    await runSentinelSql(deleteSentinel);
  } catch (cleanupError) {
    if (!primaryError) throw cleanupError;
    process.stderr.write(
      `Sentinel cleanup also failed: ${cleanupError.message}\n`
    );
  }
}

if (primaryError) throw primaryError;
