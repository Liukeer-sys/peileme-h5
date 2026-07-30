import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
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
export const TEST_DB_LOCK_PORT = 55431;

class ActiveTestDbLockError extends Error {
  constructor(owner, lockPort) {
    const ownerDetails = owner
      ? `sidecar reports PID ${owner.pid ?? "unknown"} in ${
          owner.cwd ?? "an unknown worktree"
        } for diagnostics only`
      : "owner unknown";
    super(
      `Test database mutex port occupied (${lockPort}); ${ownerDetails}; ` +
        "no Compose command was run."
    );
    this.name = "ActiveTestDbLockError";
    this.owner = owner;
  }
}

const readLockOwner = async (lockPath) => {
  try {
    const lockStat = await stat(lockPath);
    const ownerPath = lockStat.isDirectory()
      ? path.join(lockPath, "owner.json")
      : lockPath;
    return JSON.parse(await readFile(ownerPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
};

const closeMutex = (mutex) =>
  new Promise((resolve, reject) => {
    mutex.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    mutex.closeAllConnections?.();
  });

const acquireMutex = (lockPort) =>
  new Promise((resolve, reject) => {
    const mutex = createServer((socket) => socket.destroy());
    mutex.once("error", reject);
    mutex.listen(
      {
        host: "127.0.0.1",
        port: lockPort,
        exclusive: true
      },
      () => {
        mutex.removeListener("error", reject);
        resolve(mutex);
      }
    );
  });

const persistLockOwner = async (lockPath, owner) => {
  const stagingPath = `${lockPath}.${owner.token}.tmp`;
  try {
    await writeFile(
      stagingPath,
      `${JSON.stringify(owner, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" }
    );
    await rm(lockPath, { recursive: true, force: true });
    await rename(stagingPath, lockPath);
  } finally {
    await rm(stagingPath, { force: true });
  }
};

export const acquireTestDbLock = async ({
  lockPath = TEST_DB_LOCK_PATH,
  lockPort = TEST_DB_LOCK_PORT,
  pid = process.pid,
  cwd = process.cwd()
} = {}) => {
  let mutex;
  try {
    mutex = await acquireMutex(lockPort);
  } catch (error) {
    if (error?.code === "EADDRINUSE") {
      throw new ActiveTestDbLockError(
        await readLockOwner(lockPath),
        lockPort
      );
    }
    throw error;
  }

  const owner = {
    pid,
    cwd,
    token: crypto.randomUUID(),
    createdAt: new Date().toISOString()
  };

  try {
    await persistLockOwner(lockPath, owner);
    return { lockPath, lockPort, owner, mutex };
  } catch (error) {
    await closeMutex(mutex);
    throw error;
  }
};

export const releaseTestDbLock = async (lock) => {
  let releasedOwner = false;
  try {
    const currentOwner = await readLockOwner(lock.lockPath);
    if (currentOwner?.token === lock.owner.token) {
      await rm(lock.lockPath, { recursive: true, force: true });
      releasedOwner = true;
    }
    return releasedOwner;
  } finally {
    await closeMutex(lock.mutex);
  }
};

export const parseLifecycleArgs = (args = []) => {
  let forcedTestExitCode = null;
  let holdMs = 0;
  let stubbornMs = null;
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
    if (argument.startsWith("--lifecycle-test-stubborn-ms=")) {
      const value = Number(argument.split("=", 2)[1]);
      if (!Number.isInteger(value) || value < 1 || value > 60_000) {
        throw new Error(
          "--lifecycle-test-stubborn-ms must be an integer from 1 to 60000"
        );
      }
      stubbornMs = value;
      continue;
    }
    vitestArgs.push(argument);
  }

  return { forcedTestExitCode, holdMs, stubbornMs, vitestArgs };
};

const spawnCommand = ({ command, args, cwd, onSpawn, logError }) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: false,
      detached: process.platform !== "win32"
    });
    onSpawn(child, {
      processGroupId:
        process.platform !== "win32" && Number.isInteger(child.pid)
          ? child.pid
          : null
    });
    child.once("error", (error) => {
      logError(`Failed to start ${command}: ${error.message}`);
      resolve({ exitCode: 1, signal: null });
    });
    child.once("exit", (exitCode, signal) => {
      resolve({ exitCode, signal });
    });
  });

const signalChild = (child, signal) => {
  try {
    return child?.kill(signal) ?? false;
  } catch {
    return false;
  }
};

const inspectProcessGroup = (processGroupId) => {
  if (
    process.platform === "win32" ||
    !Number.isInteger(processGroupId) ||
    processGroupId <= 1
  ) {
    return "unsupported";
  }
  try {
    process.kill(-processGroupId, 0);
    return "alive";
  } catch (error) {
    if (error?.code === "ESRCH") return "missing";
    if (error?.code === "EPERM") return "inaccessible";
    return "unknown";
  }
};

const signalProcessGroup = (processGroupId, signal) => {
  if (inspectProcessGroup(processGroupId) === "unsupported") {
    return "unsupported";
  }
  try {
    process.kill(-processGroupId, signal);
    return "sent";
  } catch (error) {
    if (error?.code === "ESRCH") return "missing";
    if (error?.code === "EPERM") return "inaccessible";
    return "unknown";
  }
};

const waitForPoll = (pollMs) =>
  new Promise((resolve) => setTimeout(resolve, pollMs));

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
  lockPort = TEST_DB_LOCK_PORT,
  lifecycleArgs = [],
  runCommand = spawnCommand,
  releaseLock = releaseTestDbLock,
  signalSource = process,
  signalGraceMs = 2_000,
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
    lock = await acquireTestDbLock({ lockPath, lockPort, cwd });
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error));
    return {
      exitCode: error instanceof ActiveTestDbLockError ? ACTIVE_LOCK_EXIT_CODE : 1,
      signal: null
    };
  }

  const { forcedTestExitCode, holdMs, stubbornMs, vitestArgs } = parsedArgs;
  let activeChild = null;
  let activeProcessGroupId = null;
  let phase = "up";
  let requestedSignal = null;
  let primaryExitCode = 0;
  let signalEscalationTimer = null;
  let processGroupFallbackWarningLogged = false;

  const clearSignalEscalation = () => {
    if (signalEscalationTimer) {
      clearTimeout(signalEscalationTimer);
      signalEscalationTimer = null;
    }
  };

  const clearTrackedProcessGroup = () => {
    activeProcessGroupId = null;
    clearSignalEscalation();
  };

  const signalTrackedTree = (signal) => {
    if (activeProcessGroupId !== null) {
      const groupResult = signalProcessGroup(activeProcessGroupId, signal);
      if (groupResult === "sent") return true;
      if (groupResult === "missing") {
        clearTrackedProcessGroup();
        return true;
      }
      if (groupResult === "inaccessible" || groupResult === "unknown") {
        if (!processGroupFallbackWarningLogged) {
          logError(
            `Unable to signal child process group ${activeProcessGroupId}; ` +
              "falling back to the direct child while retaining group tracking."
          );
          processGroupFallbackWarningLogged = true;
        }
      }
    }
    return signalChild(activeChild, signal);
  };

  const escalateTrackedTree = () => {
    clearSignalEscalation();
    if (activeProcessGroupId !== null || (phase !== "down" && activeChild)) {
      signalTrackedTree("SIGKILL");
    }
  };

  const forwardFirstSignal = () => {
    if (
      phase === "down" ||
      (!activeChild && activeProcessGroupId === null) ||
      !requestedSignal
    ) {
      return;
    }
    signalTrackedTree(requestedSignal);
    clearSignalEscalation();
    if (activeChild || activeProcessGroupId !== null) {
      signalEscalationTimer = setTimeout(escalateTrackedTree, signalGraceMs);
    }
  };

  const waitForTrackedTreeExit = async () => {
    if (activeProcessGroupId === null) {
      clearSignalEscalation();
      return;
    }

    while (activeProcessGroupId !== null) {
      const groupState = inspectProcessGroup(activeProcessGroupId);
      if (groupState === "missing") {
        clearTrackedProcessGroup();
        return;
      }
      if (groupState === "unsupported") {
        clearTrackedProcessGroup();
        return;
      }
      if (groupState === "inaccessible" || groupState === "unknown") {
        if (!processGroupFallbackWarningLogged) {
          logError(
            `Unable to inspect child process group ${activeProcessGroupId}; ` +
              "retaining group tracking after the direct-child fallback."
          );
          processGroupFallbackWarningLogged = true;
        }
      }
      await waitForPoll(10);
    }
  };

  const handleSignal = (signal) => {
    if (!requestedSignal) {
      requestedSignal = signal;
      forwardFirstSignal();
      return;
    }
    escalateTrackedTree();
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
      onSpawn: (child, metadata = {}) => {
        activeChild = child;
        processGroupFallbackWarningLogged = false;
        activeProcessGroupId =
          process.platform !== "win32" &&
          nextPhase !== "down" &&
          metadata.processGroupId === child?.pid &&
          Number.isInteger(metadata.processGroupId) &&
          metadata.processGroupId > 1 &&
          metadata.processGroupId !== process.pid
            ? metadata.processGroupId
            : null;
        if (requestedSignal) forwardFirstSignal();
      }
    });
    activeChild = null;
    if (requestedSignal && nextPhase !== "down") {
      await waitForTrackedTreeExit();
    } else {
      clearTrackedProcessGroup();
    }
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
      let testArgs;
      if (forcedTestExitCode !== null) {
        testArgs = ["-e", `process.exit(${forcedTestExitCode})`];
      } else if (stubbornMs !== null) {
        testArgs = [
          "-e",
          "const peilemeLifecycleStubborn = true;" +
            "process.on('SIGINT', () => {});" +
            "process.on('SIGTERM', () => {});" +
            `setTimeout(() => process.exit(peilemeLifecycleStubborn ? 0 : 1), ${stubbornMs});`
        ];
      } else {
        testArgs = [
          path.join(cwd, "node_modules", "vitest", "vitest.mjs"),
          "run",
          "server/tests",
          ...vitestArgs
        ];
      }
      const test = await runPhase("test", testCommand, testArgs);
      primaryExitCode = resultExitCode(test);
    }

    if (requestedSignal) {
      primaryExitCode =
        SIGNAL_EXIT_CODES[requestedSignal] ?? (primaryExitCode || 1);
    }
  } finally {
    await waitForTrackedTreeExit();
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
        await releaseLock(lock);
      } catch (error) {
        logError(
          `Test database lock release failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        if (primaryExitCode === 0) primaryExitCode = 1;
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
