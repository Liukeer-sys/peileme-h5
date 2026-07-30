import { spawn } from "node:child_process";
import crypto from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { createServer } from "node:net";
import { constants as osConstants, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMPOSE_FILE = "docker-compose.test.yml";
const ACTIVE_LOCK_EXIT_CODE = 73;
const STUBBORN_ACCEPTANCE_MISSED_SIGNAL_EXIT_CODE = 97;
const TEST_UPLOAD_BASENAME_PREFIX = "peileme-test-uploads-";
const TEST_UPLOAD_PATH_PREFIX = path.join(
  tmpdir(),
  TEST_UPLOAD_BASENAME_PREFIX
);
const TEST_UPLOAD_OWNER_FILENAME = ".peileme-wrapper-owner.json";

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

const createLifecycleUploadOwnership = async () => {
  const directory = path.resolve(await mkdtemp(TEST_UPLOAD_PATH_PREFIX));
  const token = crypto.randomUUID();
  const markerPath = path.join(directory, TEST_UPLOAD_OWNER_FILENAME);
  const markerContents = `${JSON.stringify({ token })}\n`;
  try {
    const ownership = {
      directory,
      markerContents,
      markerPath,
      realDirectory: await realpath(directory),
      token
    };
    await writeFile(
      ownership.markerPath,
      ownership.markerContents,
      { encoding: "utf8", flag: "wx" }
    );
    return ownership;
  } catch (error) {
    await rm(ownership.directory, { recursive: true, force: true });
    throw error;
  }
};

const validateLifecycleUploadOwnership = async (ownership) => {
  const directory = path.resolve(ownership.directory);
  try {
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("upload path is not the owned directory");
    }

    const currentRealDirectory = await realpath(directory);
    if (currentRealDirectory !== ownership.realDirectory) {
      throw new Error("upload directory realpath changed");
    }

    const markerStat = await lstat(ownership.markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
      throw new Error("ownership marker is not a regular file");
    }

    const currentMarkerRealpath = await realpath(ownership.markerPath);
    const expectedMarkerRealpath = path.join(
      ownership.realDirectory,
      TEST_UPLOAD_OWNER_FILENAME
    );
    if (currentMarkerRealpath !== expectedMarkerRealpath) {
      throw new Error("ownership marker realpath changed");
    }

    const markerContents = await readFile(ownership.markerPath, "utf8");
    const marker = JSON.parse(markerContents);
    if (
      markerContents !== ownership.markerContents ||
      marker?.token !== ownership.token
    ) {
      throw new Error("ownership marker token changed");
    }
  } catch (error) {
    throw new Error(
      `Lifecycle upload ownership validation failed for ${directory}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
};

const cleanupLifecycleUploadOwnership = async (ownership) => {
  if (!ownership) return false;
  const directory = path.resolve(ownership.directory);
  if (
    path.dirname(directory) !== path.resolve(tmpdir()) ||
    !path.basename(directory).startsWith(TEST_UPLOAD_BASENAME_PREFIX)
  ) {
    throw new Error(`Refusing to remove unowned upload directory: ${directory}`);
  }
  await validateLifecycleUploadOwnership(ownership);
  // Node has no directory-handle recursive removal; revalidate immediately
  // before rm to narrow the remaining same-user replacement race.
  await validateLifecycleUploadOwnership(ownership);
  await rm(directory, { recursive: true, force: true });
  return true;
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

const spawnCommand = ({ command, args, cwd, env, onSpawn, logError }) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
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

const signalExitCode = (signal) => {
  const signalNumber = osConstants.signals[signal];
  return Number.isInteger(signalNumber) ? 128 + signalNumber : null;
};

const resultExitCode = (result) => {
  if (result.signal) return signalExitCode(result.signal) ?? 1;
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

  let uploadOwnership;
  try {
    uploadOwnership = await createLifecycleUploadOwnership();
  } catch (error) {
    logError(
      `Failed to create lifecycle upload directory: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    try {
      await releaseLock(lock);
    } catch (releaseError) {
      logError(
        `Test database lock release failed: ${
          releaseError instanceof Error
            ? releaseError.message
            : String(releaseError)
        }`
      );
    }
    return { exitCode: 1, signal: null };
  }

  const testEnvironment = {
    ...process.env,
    UPLOAD_DIR: uploadOwnership.directory,
    TEST_WRAPPER_UPLOAD_DIR: uploadOwnership.directory,
    TEST_WRAPPER_UPLOAD_TOKEN: uploadOwnership.token
  };
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

  const runPhase = async (nextPhase, command, args, env = process.env) => {
    phase = nextPhase;
    const result = await runCommand({
      phase: nextPhase,
      command,
      args,
      cwd,
      env,
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
    const childOriginatedSignal = Boolean(result.signal && !requestedSignal);
    if (childOriginatedSignal) requestedSignal = result.signal;
    activeChild = null;
    if (childOriginatedSignal && activeProcessGroupId !== null) {
      forwardFirstSignal();
    }
    if (requestedSignal && nextPhase !== "down") {
      await waitForTrackedTreeExit();
    } else {
      clearTrackedProcessGroup();
    }
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
          "const fs = require('node:fs');" +
            "const path = require('node:path');" +
            "const peilemeLifecycleStubborn = true;" +
            "const uploadDir = process.env.TEST_WRAPPER_UPLOAD_DIR;" +
            "if (uploadDir) fs.writeFileSync(path.join(uploadDir, 'stubborn-child-started'), 'started');" +
            "process.on('SIGINT', () => {});" +
            "process.on('SIGTERM', () => {});" +
            `setTimeout(() => process.exit(peilemeLifecycleStubborn ? ${STUBBORN_ACCEPTANCE_MISSED_SIGNAL_EXIT_CODE} : 1), ${stubbornMs});`
        ];
      } else {
        testArgs = [
          path.join(cwd, "node_modules", "vitest", "vitest.mjs"),
          "run",
          "server/tests",
          ...vitestArgs
        ];
      }
      const test = await runPhase(
        "test",
        testCommand,
        testArgs,
        testEnvironment
      );
      primaryExitCode = resultExitCode(test);
    }

    if (requestedSignal) {
      primaryExitCode =
        signalExitCode(requestedSignal) ?? (primaryExitCode || 1);
    }
  } finally {
    try {
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
    } finally {
      try {
        await cleanupLifecycleUploadOwnership(uploadOwnership);
      } catch (error) {
        logError(
          `Test upload cleanup failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        if (primaryExitCode === 0) primaryExitCode = 1;
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
