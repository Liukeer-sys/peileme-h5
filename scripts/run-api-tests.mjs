import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMPOSE_FILE = "docker-compose.test.yml";
const ACTIVE_LOCK_EXIT_CODE = 73;
const SIGNAL_EXIT_CODES = {
  SIGINT: 130,
  SIGTERM: 143
};

export const TEST_DB_LOCK_PATH = path.join(
  tmpdir(),
  "peileme-h5-test-db-55432.lock"
);

class ActiveTestDbLockError extends Error {
  constructor(owner) {
    super(
      `Test database is already owned by PID ${owner.pid} in ${owner.cwd}. ` +
        "Wait for that test lifecycle to finish."
    );
    this.name = "ActiveTestDbLockError";
    this.owner = owner;
  }
}

const isProcessAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

const readLockOwner = async (lockPath) => {
  try {
    return JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
};

export const acquireTestDbLock = async ({
  lockPath = TEST_DB_LOCK_PATH,
  pid = process.pid,
  cwd = process.cwd(),
  isProcessAlive: checkProcessAlive = isProcessAlive
} = {}) => {
  await mkdir(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const owner = {
      pid,
      cwd,
      token: crypto.randomUUID(),
      createdAt: new Date().toISOString()
    };
    const stagingPath = `${lockPath}.${owner.token}.tmp`;
    await mkdir(stagingPath);
    await writeFile(
      path.join(stagingPath, "owner.json"),
      `${JSON.stringify(owner, null, 2)}\n`,
      "utf8"
    );

    try {
      await rename(stagingPath, lockPath);
      return { lockPath, owner };
    } catch (error) {
      await rm(stagingPath, { recursive: true, force: true });
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error?.code)) throw error;
    }

    const currentOwner = await readLockOwner(lockPath);
    if (
      currentOwner &&
      Number.isSafeInteger(currentOwner.pid) &&
      checkProcessAlive(currentOwner.pid)
    ) {
      throw new ActiveTestDbLockError(currentOwner);
    }

    await rm(lockPath, { recursive: true, force: true });
  }

  throw new Error(`Unable to acquire test database lock at ${lockPath}`);
};

export const releaseTestDbLock = async (lock) => {
  const currentOwner = await readLockOwner(lock.lockPath);
  if (currentOwner?.token !== lock.owner.token) return false;
  await rm(lock.lockPath, { recursive: true, force: true });
  return true;
};

export const parseLifecycleArgs = (args = []) => {
  let forcedTestExitCode = null;
  let holdMs = 0;
  const vitestArgs = [];

  for (const argument of args) {
    if (argument.startsWith("--lifecycle-test-exit-code=")) {
      const value = Number(argument.split("=", 2)[1]);
      if (!Number.isInteger(value) || value < 1 || value > 255) {
        throw new Error("--lifecycle-test-exit-code must be an integer from 1 to 255");
      }
      forcedTestExitCode = value;
      continue;
    }
    if (argument.startsWith("--lifecycle-test-hold-ms=")) {
      const value = Number(argument.split("=", 2)[1]);
      if (!Number.isInteger(value) || value < 0 || value > 60_000) {
        throw new Error("--lifecycle-test-hold-ms must be an integer from 0 to 60000");
      }
      holdMs = value;
      continue;
    }
    vitestArgs.push(argument);
  }

  return { forcedTestExitCode, holdMs, vitestArgs };
};

const spawnCommand = ({ command, args, cwd, onSpawn, logError }) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: false
    });
    onSpawn(child);
    child.once("error", (error) => {
      logError(`Failed to start ${command}: ${error.message}`);
      resolve({ exitCode: 1, signal: null });
    });
    child.once("exit", (exitCode, signal) => {
      resolve({ exitCode, signal });
    });
  });

const waitForHold = (holdMs, wasSignalled) =>
  new Promise((resolve) => {
    if (holdMs === 0 || wasSignalled()) {
      resolve();
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (wasSignalled() || Date.now() - startedAt >= holdMs) {
        clearInterval(timer);
        resolve();
      }
    }, Math.min(50, holdMs));
  });

const resultExitCode = (result) => {
  if (result.signal && result.signal in SIGNAL_EXIT_CODES) {
    return SIGNAL_EXIT_CODES[result.signal];
  }
  return result.exitCode ?? 1;
};

export const runApiTestLifecycle = async ({
  cwd = process.cwd(),
  lockPath = TEST_DB_LOCK_PATH,
  lifecycleArgs = [],
  runCommand = spawnCommand,
  signalSource = process,
  logError = (message) => console.error(message)
} = {}) => {
  let parsedArgs;
  try {
    parsedArgs = parseLifecycleArgs(lifecycleArgs);
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error));
    return { exitCode: 2, signal: null };
  }

  let lock;
  try {
    lock = await acquireTestDbLock({ lockPath, cwd });
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error));
    return {
      exitCode: error instanceof ActiveTestDbLockError ? ACTIVE_LOCK_EXIT_CODE : 1,
      signal: null
    };
  }

  const { forcedTestExitCode, holdMs, vitestArgs } = parsedArgs;
  let activeChild = null;
  let phase = "up";
  let requestedSignal = null;
  let primaryExitCode = 0;

  const handleSignal = (signal) => {
    if (requestedSignal) return;
    requestedSignal = signal;
    if (phase !== "down") activeChild?.kill(signal);
  };
  const onSigint = () => handleSignal("SIGINT");
  const onSigterm = () => handleSignal("SIGTERM");
  signalSource.on("SIGINT", onSigint);
  signalSource.on("SIGTERM", onSigterm);

  const runPhase = async (nextPhase, command, args) => {
    phase = nextPhase;
    const result = await runCommand({
      phase: nextPhase,
      command,
      args,
      cwd,
      logError,
      onSpawn: (child) => {
        activeChild = child;
      }
    });
    activeChild = null;
    if (result.signal && !requestedSignal) requestedSignal = result.signal;
    return result;
  };

  try {
    const up = await runPhase("up", "docker", [
      "compose",
      "-f",
      COMPOSE_FILE,
      "up",
      "-d",
      "--wait"
    ]);
    primaryExitCode = resultExitCode(up);

    if (primaryExitCode === 0 && !requestedSignal) {
      await waitForHold(holdMs, () => Boolean(requestedSignal));
    }

    if (primaryExitCode === 0 && !requestedSignal) {
      const testCommand = process.execPath;
      const testArgs =
        forcedTestExitCode === null
          ? [
              path.join(cwd, "node_modules", "vitest", "vitest.mjs"),
              "run",
              "server/tests",
              ...vitestArgs
            ]
          : ["-e", `process.exit(${forcedTestExitCode})`];
      const test = await runPhase("test", testCommand, testArgs);
      primaryExitCode = resultExitCode(test);
    }

    if (requestedSignal) {
      primaryExitCode =
        SIGNAL_EXIT_CODES[requestedSignal] ?? (primaryExitCode || 1);
    }
  } finally {
    try {
      const down = await runPhase("down", "docker", [
        "compose",
        "-f",
        COMPOSE_FILE,
        "down",
        "--volumes",
        "--remove-orphans"
      ]);
      const downExitCode = resultExitCode(down);
      if (primaryExitCode === 0 && downExitCode !== 0) {
        primaryExitCode = downExitCode;
      } else if (downExitCode !== 0) {
        logError(`Test database cleanup failed with exit code ${downExitCode}`);
      }
    } catch (error) {
      logError(
        `Test database cleanup failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      if (primaryExitCode === 0) primaryExitCode = 1;
    } finally {
      try {
        await releaseTestDbLock(lock);
      } finally {
        signalSource.off("SIGINT", onSigint);
        signalSource.off("SIGTERM", onSigterm);
      }
    }
  }

  return { exitCode: primaryExitCode, signal: requestedSignal };
};

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  try {
    const result = await runApiTestLifecycle({
      lifecycleArgs: process.argv.slice(2)
    });
    if (result.signal) {
      process.kill(process.pid, result.signal);
    } else {
      process.exitCode = result.exitCode;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
