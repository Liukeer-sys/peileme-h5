import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error The executable JavaScript wrapper intentionally has no TypeScript declarations.
import * as wrapperModule from "../../scripts/run-api-tests.mjs";

const wrapperPath = path.resolve("scripts/run-api-tests.mjs");
const loadWrapper = async () => wrapperModule;

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  description: string
) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const withWatchdog = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  description: string
) => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${description} exceeded ${timeoutMs}ms`)),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

const isProcessGroupAlive = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

const runSpawnedCommand = ({
  command,
  args,
  cwd,
  env,
  onSpawn
}: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onSpawn: (
    child: ChildProcess,
    metadata?: { processGroupId: number | null }
  ) => void;
}) =>
  new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env,
        detached: process.platform !== "win32",
        stdio: "ignore"
      });
      onSpawn(child, {
        processGroupId:
          process.platform !== "win32" && child.pid ? child.pid : null
      });
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
    }
  );

const spawnLeaderWithStubbornDescendant = (
  readyPath: string,
  leaderHandlesSignals = true
) => {
  const descendantSource = [
    "const fs = require('node:fs');",
    "process.on('SIGINT', () => {});",
    "process.on('SIGTERM', () => {});",
    `fs.writeFileSync(${JSON.stringify(readyPath)}, String(process.pid));`,
    "setInterval(() => {}, 1000);"
  ].join("");
  const leaderSource = [
    "const { spawn } = require('node:child_process');",
    `spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: 'ignore' });`,
    leaderHandlesSignals
      ? "process.on('SIGINT', () => process.exit(0));"
      : "",
    leaderHandlesSignals
      ? "process.on('SIGTERM', () => process.exit(0));"
      : "",
    "setInterval(() => {}, 1000);"
  ].join("");

  return spawn(process.execPath, ["-e", leaderSource], {
    detached: true,
    stdio: "ignore"
  });
};

const getAvailablePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Expected a TCP test mutex address"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });

let tempRoot = "";
let lockPath = "";
let lockPort = 0;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), "peileme-lifecycle-test-"));
  lockPath = path.join(tempRoot, "test-db.lock");
  lockPort = await getAvailablePort();
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("API test lifecycle wrapper", () => {
  const exerciseLifecycleUploadReplacement = async ({
    replacement,
    testExitCode = 0,
    testSignal = null
  }: {
    replacement: "missing-marker" | "wrong-token" | "symlink";
    testExitCode?: number;
    testSignal?: NodeJS.Signals | null;
  }) => {
    const { runApiTestLifecycle } = await loadWrapper();
    const errors: string[] = [];
    let wrapperUploadDir = "";
    let replacementRoot = "";
    let sentinelPath = "";

    try {
      const result = await withWatchdog(
        runApiTestLifecycle({
          lockPath,
          lockPort,
          logError: (message: string) => errors.push(message),
          runCommand: async ({
            phase,
            env
          }: {
            phase: string;
            env?: NodeJS.ProcessEnv;
          }) => {
            if (phase !== "test") return { exitCode: 0, signal: null };
            wrapperUploadDir = env?.TEST_WRAPPER_UPLOAD_DIR ?? "";
            if (!wrapperUploadDir) return { exitCode: 91, signal: null };

            await rm(wrapperUploadDir, { recursive: true, force: true });
            if (replacement === "symlink") {
              replacementRoot = await mkdtemp(
                path.join(tmpdir(), "peileme-unknown-upload-")
              );
              sentinelPath = path.join(replacementRoot, "sentinel.txt");
              await writeFile(sentinelPath, "keep", "utf8");
              await symlink(replacementRoot, wrapperUploadDir, "dir");
            } else {
              await mkdir(wrapperUploadDir);
              sentinelPath = path.join(wrapperUploadDir, "sentinel.txt");
              await writeFile(sentinelPath, "keep", "utf8");
              if (replacement === "wrong-token") {
                await writeFile(
                  path.join(
                    wrapperUploadDir,
                    ".peileme-wrapper-owner.json"
                  ),
                  `${JSON.stringify({ token: "wrong-token" })}\n`,
                  "utf8"
                );
              }
            }
            return {
              exitCode: testSignal ? null : testExitCode,
              signal: testSignal
            };
          }
        }),
        1_000,
        `${replacement} upload replacement lifecycle`
      );
      return {
        errors,
        result,
        sentinelPath,
        wrapperUploadDir,
        replacementRoot,
        cleanup: async () => {
          if (wrapperUploadDir) {
            await rm(wrapperUploadDir, { recursive: true, force: true });
          }
          if (replacementRoot) {
            await rm(replacementRoot, { recursive: true, force: true });
          }
        }
      };
    } catch (error) {
      if (wrapperUploadDir) {
        await rm(wrapperUploadDir, { recursive: true, force: true });
      }
      if (replacementRoot) {
        await rm(replacementRoot, { recursive: true, force: true });
      }
      throw error;
    }
  };

  const exerciseLeaderExitWithStubbornDescendant = async ({
    signal,
    secondSignal,
    signalOrigin = "wrapper"
  }: {
    signal: "SIGINT" | "SIGTERM";
    secondSignal: boolean;
    signalOrigin?: "wrapper" | "child";
  }) => {
    const { releaseTestDbLock, runApiTestLifecycle } = await loadWrapper();
    const signalSource = new EventEmitter();
    const phases: string[] = [];
    const readyPath = path.join(tempRoot, "descendant-ready");
    let processGroupId = 0;
    let descendantPid = 0;
    let groupAliveAtDown: boolean | null = null;
    let groupAliveAtRelease: boolean | null = null;
    let resolveLeaderExit!: () => void;
    const leaderExit = new Promise<void>((resolve) => {
      resolveLeaderExit = resolve;
    });
    let resolveSecondSignal!: () => void;
    const secondSignalSent = new Promise<void>((resolve) => {
      resolveSecondSignal = resolve;
    });
    let lifecyclePromise: Promise<{
      exitCode: number;
      signal: string | null;
    }> | null = null;

    try {
      lifecyclePromise = runApiTestLifecycle({
        lockPath,
        lockPort,
        signalSource,
        signalGraceMs: secondSignal ? 500 : 50,
        releaseLock: async (lock: unknown) => {
          groupAliveAtRelease =
            processGroupId > 0 && isProcessGroupAlive(processGroupId);
          return releaseTestDbLock(lock);
        },
        runCommand: async ({
          phase,
          onSpawn
        }: {
          phase: string;
          onSpawn: (
            child: ChildProcess,
            metadata?: { processGroupId: number }
          ) => void;
        }) => {
          phases.push(phase);
          if (phase === "up") return { exitCode: 0, signal: null };
          if (phase === "down") {
            groupAliveAtDown =
              processGroupId > 0 && isProcessGroupAlive(processGroupId);
            if (secondSignal) await secondSignalSent;
            return { exitCode: 0, signal: null };
          }

          const leader = spawnLeaderWithStubbornDescendant(
            readyPath,
            signalOrigin === "wrapper"
          );
          if (!leader.pid || leader.pid === process.pid) {
            throw new Error("Expected a distinct detached process-group leader");
          }
          processGroupId = leader.pid;
          onSpawn(leader, { processGroupId });
          return await new Promise((resolve, reject) => {
            leader.once("error", reject);
            leader.once("exit", (exitCode, childSignal) => {
              resolveLeaderExit();
              resolve({ exitCode, signal: childSignal });
            });
          });
        }
      });

      await waitFor(
        async () => {
          try {
            descendantPid = Number(await readFile(readyPath, "utf8"));
            return Number.isInteger(descendantPid) && descendantPid > 0;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
          }
        },
        500,
        "stubborn descendant readiness"
      );

      if (signalOrigin === "wrapper") {
        signalSource.emit(signal);
      } else {
        process.kill(processGroupId, signal);
      }
      if (secondSignal) {
        await withWatchdog(leaderExit, 500, "leader exit");
        await new Promise((resolve) => setImmediate(resolve));
        signalSource.emit(signal);
        resolveSecondSignal();
      }

      const result = await withWatchdog(
        lifecyclePromise,
        1_000,
        "real process-tree lifecycle"
      );
      return {
        result,
        phases,
        groupAliveAtDown,
        groupAliveAtRelease,
        groupAliveAfterLifecycle: isProcessGroupAlive(processGroupId),
        descendantAliveAfterLifecycle: isProcessAlive(descendantPid)
      };
    } finally {
      resolveSecondSignal();
      if (processGroupId > 1 && isProcessGroupAlive(processGroupId)) {
        process.kill(-processGroupId, "SIGKILL");
      }
      if (descendantPid > 1 && isProcessAlive(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
      if (processGroupId > 1) {
        await waitFor(
          () => !isProcessGroupAlive(processGroupId),
          1_000,
          "test process-group cleanup"
        );
      }
      if (lifecyclePromise) {
        await withWatchdog(
          lifecyclePromise,
          1_000,
          "lifecycle cleanup after test"
        ).catch(() => {});
      }
    }
  };

  it("exports the lifecycle implementation", async () => {
    await expect(access(wrapperPath)).resolves.toBeUndefined();
    const wrapper = await loadWrapper();
    expect(wrapper.runApiTestLifecycle).toBeTypeOf("function");
    expect(wrapper.acquireTestDbLock).toBeTypeOf("function");
    expect(wrapper.releaseTestDbLock).toBeTypeOf("function");
  });

  it("runs up, tests, and down on success", async () => {
    const { runApiTestLifecycle } = await loadWrapper();
    const phases: string[] = [];
    const commands: Array<{ phase: string; args: string[] }> = [];
    const result = await runApiTestLifecycle({
      lockPath,
      lockPort,
      runCommand: async ({ phase, args }: { phase: string; args: string[] }) => {
        phases.push(phase);
        commands.push({ phase, args });
        return { exitCode: 0, signal: null };
      }
    });

    expect(result).toEqual({ exitCode: 0, signal: null });
    expect(phases).toEqual(["up", "test", "down"]);
    expect(commands.find(({ phase }) => phase === "down")?.args).toEqual([
      "compose",
      "-f",
      "docker-compose.test.yml",
      "down",
      "--volumes",
      "--remove-orphans"
    ]);
  });

  it("always runs down and preserves a failing test exit code", async () => {
    const { runApiTestLifecycle } = await loadWrapper();
    const phases: string[] = [];
    const result = await runApiTestLifecycle({
      lockPath,
      lockPort,
      runCommand: async ({ phase }: { phase: string }) => {
        phases.push(phase);
        return { exitCode: phase === "test" ? 23 : 0, signal: null };
      }
    });

    expect(result).toEqual({ exitCode: 23, signal: null });
    expect(phases).toEqual(["up", "test", "down"]);
  });

  it("cleans a partially started database and preserves the up exit code", async () => {
    const { runApiTestLifecycle } = await loadWrapper();
    const phases: string[] = [];
    const result = await runApiTestLifecycle({
      lockPath,
      lockPort,
      runCommand: async ({ phase }: { phase: string }) => {
        phases.push(phase);
        return { exitCode: phase === "up" ? 19 : 0, signal: null };
      }
    });

    expect(result).toEqual({ exitCode: 19, signal: null });
    expect(phases).toEqual(["up", "down"]);
  });

  it("returns exit 1 when release fails after a successful lifecycle", async () => {
    const { releaseTestDbLock, runApiTestLifecycle } = await loadWrapper();
    const errors: string[] = [];
    const result = await runApiTestLifecycle({
      lockPath,
      lockPort,
      runCommand: async () => ({ exitCode: 0, signal: null }),
      releaseLock: async (lock: unknown) => {
        await releaseTestDbLock(lock);
        throw new Error("release failed");
      },
      logError: (message: string) => errors.push(message)
    });

    expect(result).toEqual({ exitCode: 1, signal: null });
    expect(errors.join("\n")).toContain("release failed");
  });

  it("preserves a test failure when down also fails", async () => {
    const { runApiTestLifecycle } = await loadWrapper();
    const errors: string[] = [];
    const result = await runApiTestLifecycle({
      lockPath,
      lockPort,
      runCommand: async ({ phase }: { phase: string }) => ({
        exitCode: phase === "test" ? 23 : phase === "down" ? 29 : 0,
        signal: null
      }),
      logError: (message: string) => errors.push(message)
    });

    expect(result).toEqual({ exitCode: 23, signal: null });
    expect(errors.join("\n")).toContain("cleanup failed with exit code 29");
  });

  it("preserves a test failure when down and release also fail", async () => {
    const { releaseTestDbLock, runApiTestLifecycle } = await loadWrapper();
    const errors: string[] = [];
    const result = await runApiTestLifecycle({
      lockPath,
      lockPort,
      runCommand: async ({ phase }: { phase: string }) => ({
        exitCode: phase === "test" ? 23 : phase === "down" ? 29 : 0,
        signal: null
      }),
      releaseLock: async (lock: unknown) => {
        await releaseTestDbLock(lock);
        throw new Error("release failed");
      },
      logError: (message: string) => errors.push(message)
    });

    expect(result).toEqual({ exitCode: 23, signal: null });
    expect(errors.join("\n")).toContain("cleanup failed with exit code 29");
    expect(errors.join("\n")).toContain("release failed");
  });

  it("reclaims a lock owned by a dead process", async () => {
    const { acquireTestDbLock, releaseTestDbLock } = await loadWrapper();
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 41001,
        cwd: "/stale/worktree",
        token: "stale-token"
      }),
      "utf8"
    );
    const reclaimed = await acquireTestDbLock({
      lockPath,
      lockPort,
      pid: 41002,
      cwd: "/current/worktree"
    });
    const persistedOwner = JSON.parse(await readFile(lockPath, "utf8"));

    expect(reclaimed.owner.token).not.toBe("stale-token");
    expect(reclaimed.owner.pid).toBe(41002);
    expect(persistedOwner).toEqual(reclaimed.owner);
    await releaseTestDbLock(reclaimed);
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replaces a stale sidecar when its PID has been reused by a live process", async () => {
    const { acquireTestDbLock, releaseTestDbLock } = await loadWrapper();
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        cwd: "/former/worktree",
        token: "pid-reuse-token"
      }),
      "utf8"
    );

    const acquired = await acquireTestDbLock({
      lockPath,
      lockPort,
      pid: 41502,
      cwd: "/new/worktree"
    });
    const persistedOwner = JSON.parse(await readFile(lockPath, "utf8"));

    expect(acquired.owner.token).not.toBe("pid-reuse-token");
    expect(persistedOwner).toEqual(acquired.owner);
    await releaseTestDbLock(acquired);
  });

  it("releases the mutex promptly while a client tries to stay connected", async () => {
    const { acquireTestDbLock, releaseTestDbLock } = await loadWrapper();
    const acquired = await acquireTestDbLock({
      lockPath,
      lockPort,
      pid: 41701,
      cwd: "/mutex-client"
    });
    const client = createConnection({
      host: "127.0.0.1",
      port: lockPort
    });
    client.on("error", () => {});
    await once(client, "connect");
    client.write("keep-open");

    const releasePromise = releaseTestDbLock(acquired);
    let releasedPromptly: boolean;
    try {
      releasedPromptly = await Promise.race([
        releasePromise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 50))
      ]);
    } finally {
      if ("resetAndDestroy" in client) client.resetAndDestroy();
      else client.destroy();
      acquired.mutex.closeAllConnections?.();
      await Promise.race([
        releasePromise,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("mutex release cleanup exceeded 200ms")),
            200
          )
        )
      ]);
    }

    expect(releasedPromptly).toBe(true);
  });

  it("allows only one synchronized contender to recover the same stale lock", async () => {
    const { acquireTestDbLock, releaseTestDbLock } = await loadWrapper();
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 42000,
        cwd: "/dead/worktree",
        token: "shared-stale-token"
      }),
      "utf8"
    );

    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const contend = async (pid: number) => {
      await barrier;
      return acquireTestDbLock({
        lockPath,
        lockPort,
        pid,
        cwd: `/contender-${pid}`
      });
    };
    const attempts = [contend(42001), contend(42002)];
    releaseBarrier();
    const results = await Promise.allSettled(attempts);

    const winners = results.filter(
      (result): result is PromiseFulfilledResult<any> =>
        result.status === "fulfilled"
    );
    const losers = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(String(losers[0].reason)).toContain("mutex port occupied");

    const winner = winners[0].value;
    const persistedOwner = JSON.parse(await readFile(lockPath, "utf8"));
    expect(persistedOwner).toEqual(winner.owner);
    expect(persistedOwner.token).not.toBe("shared-stale-token");
    await releaseTestDbLock(winner);
  });

  it("fails fast for an active lock without running or cleaning Compose", async () => {
    const { acquireTestDbLock, releaseTestDbLock, runApiTestLifecycle } =
      await loadWrapper();
    const active = await acquireTestDbLock({
      lockPath,
      lockPort,
      pid: process.pid,
      cwd: "/active/worktree"
    });
    const runCommand = vi.fn();
    const errors: string[] = [];

    const result = await runApiTestLifecycle({
      lockPath,
      lockPort,
      runCommand,
      logError: (message: string) => errors.push(message)
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.signal).toBeNull();
    expect(runCommand).not.toHaveBeenCalled();
    expect(errors.join("\n")).toContain("mutex port occupied");
    expect(errors.join("\n")).toContain(String(process.pid));
    expect(errors.join("\n")).toContain("for diagnostics only");
    expect(errors.join("\n")).toContain("no Compose command was run");
    await expect(access(lockPath)).resolves.toBeUndefined();
    await releaseTestDbLock(active);
  });

  it("reports an occupied mutex without a sidecar as an unknown owner", async () => {
    const { runApiTestLifecycle } = await loadWrapper();
    const mutex = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      mutex.once("error", reject);
      mutex.listen(
        { host: "127.0.0.1", port: lockPort, exclusive: true },
        resolve
      );
    });
    const runCommand = vi.fn();
    const errors: string[] = [];

    try {
      const result = await runApiTestLifecycle({
        lockPath,
        lockPort,
        runCommand,
        logError: (message: string) => errors.push(message)
      });

      expect(result).toEqual({ exitCode: 73, signal: null });
      expect(runCommand).not.toHaveBeenCalled();
      expect(errors.join("\n")).toContain("mutex port occupied");
      expect(errors.join("\n")).toContain("owner unknown");
      expect(errors.join("\n")).toContain("no Compose command was run");
    } finally {
      await new Promise<void>((resolve, reject) => {
        mutex.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("interrupts the active child, cleans up, and maps SIGTERM to exit 143", async () => {
    const { runApiTestLifecycle } = await loadWrapper();
    const signalSource = new EventEmitter();
    const phases: string[] = [];
    const kill = vi.fn();

    const result = await runApiTestLifecycle({
      lockPath,
      lockPort,
      signalSource,
      runCommand: async ({
        phase,
        onSpawn
      }: {
        phase: string;
        onSpawn: (child: { kill: (signal: string) => boolean }) => void;
      }) => {
        phases.push(phase);
        if (phase !== "test") return { exitCode: 0, signal: null };
        return await new Promise((resolve) => {
          onSpawn({
            kill: (signal: string) => {
              kill(signal);
              resolve({ exitCode: null, signal });
              return true;
            }
          });
          queueMicrotask(() => signalSource.emit("SIGTERM"));
        });
      }
    });

    expect(result).toEqual({ exitCode: 143, signal: "SIGTERM" });
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(phases).toEqual(["up", "test", "down"]);
  });

  it("escalates a first signal after the grace period and still cleans up", async () => {
    const { runApiTestLifecycle } = await loadWrapper();
    const signalSource = new EventEmitter();
    const phases: string[] = [];
    const kills: string[] = [];

    const result = await runApiTestLifecycle({
      lockPath,
      lockPort,
      signalSource,
      signalGraceMs: 10,
      runCommand: async ({
        phase,
        onSpawn
      }: {
        phase: string;
        onSpawn: (child: { kill: (signal: string) => boolean }) => void;
      }) => {
        phases.push(phase);
        if (phase !== "test") return { exitCode: 0, signal: null };
        return await new Promise((resolve) => {
          const fallback = setTimeout(
            () => resolve({ exitCode: 98, signal: null }),
            100
          );
          onSpawn({
            kill: (signal: string) => {
              kills.push(signal);
              if (signal === "SIGKILL") {
                clearTimeout(fallback);
                resolve({ exitCode: null, signal });
              }
              return true;
            }
          });
          queueMicrotask(() => signalSource.emit("SIGTERM"));
        });
      }
    });

    expect(result).toEqual({ exitCode: 143, signal: "SIGTERM" });
    expect(kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(phases).toEqual(["up", "test", "down"]);
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("escalates a second signal immediately and still cleans up", async () => {
    const { runApiTestLifecycle } = await loadWrapper();
    const signalSource = new EventEmitter();
    const phases: string[] = [];
    const kills: string[] = [];

    const result = await runApiTestLifecycle({
      lockPath,
      lockPort,
      signalSource,
      signalGraceMs: 1_000,
      runCommand: async ({
        phase,
        onSpawn
      }: {
        phase: string;
        onSpawn: (child: { kill: (signal: string) => boolean }) => void;
      }) => {
        phases.push(phase);
        if (phase !== "test") return { exitCode: 0, signal: null };
        return await new Promise((resolve) => {
          const fallback = setTimeout(
            () => resolve({ exitCode: 98, signal: null }),
            100
          );
          onSpawn({
            kill: (signal: string) => {
              kills.push(signal);
              if (signal === "SIGKILL") {
                clearTimeout(fallback);
                resolve({ exitCode: null, signal });
              }
              return true;
            }
          });
          queueMicrotask(() => {
            signalSource.emit("SIGINT");
            signalSource.emit("SIGINT");
          });
        });
      }
    });

    expect(result).toEqual({ exitCode: 130, signal: "SIGINT" });
    expect(kills).toEqual(["SIGINT", "SIGKILL"]);
    expect(phases).toEqual(["up", "test", "down"]);
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "win32")(
    "kills a stubborn descendant after its detached leader exits during grace",
    async () => {
      const observation = await exerciseLeaderExitWithStubbornDescendant({
        signal: "SIGTERM",
        secondSignal: false
      });

      expect(observation.result).toEqual({
        exitCode: 143,
        signal: "SIGTERM"
      });
      expect(observation.phases).toEqual(["up", "test", "down"]);
      expect(observation.groupAliveAtDown).toBe(false);
      expect(observation.groupAliveAtRelease).toBe(false);
      expect(observation.groupAliveAfterLifecycle).toBe(false);
      expect(observation.descendantAliveAfterLifecycle).toBe(false);
      await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it.runIf(process.platform !== "win32")(
    "kills a stubborn descendant on a second signal after its leader exits",
    async () => {
      const observation = await exerciseLeaderExitWithStubbornDescendant({
        signal: "SIGINT",
        secondSignal: true
      });

      expect(observation.result).toEqual({
        exitCode: 130,
        signal: "SIGINT"
      });
      expect(observation.phases).toEqual(["up", "test", "down"]);
      expect(observation.groupAliveAtDown).toBe(false);
      expect(observation.groupAliveAtRelease).toBe(false);
      expect(observation.groupAliveAfterLifecycle).toBe(false);
      expect(observation.descendantAliveAfterLifecycle).toBe(false);
      await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it.runIf(process.platform !== "win32")(
    "kills a stubborn descendant when the leader receives a signal directly",
    async () => {
      const observation = await exerciseLeaderExitWithStubbornDescendant({
        signal: "SIGTERM",
        secondSignal: false,
        signalOrigin: "child"
      });

      expect(observation.result).toEqual({
        exitCode: 143,
        signal: "SIGTERM"
      });
      expect(observation.phases).toEqual(["up", "test", "down"]);
      expect(observation.groupAliveAtDown).toBe(false);
      expect(observation.groupAliveAtRelease).toBe(false);
      expect(observation.groupAliveAfterLifecycle).toBe(false);
      expect(observation.descendantAliveAfterLifecycle).toBe(false);
      await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it("returns 97 when the stubborn acceptance child reaches its timeout", async () => {
    const { runApiTestLifecycle } = await loadWrapper();

    const result = await withWatchdog(
      runApiTestLifecycle({
        lockPath,
        lockPort,
        lifecycleArgs: ["--lifecycle-test-stubborn-ms=10"],
        runCommand: async ({
          phase,
          ...command
        }: {
          phase: string;
          command: string;
          args: string[];
          cwd: string;
          env?: NodeJS.ProcessEnv;
          onSpawn: (
            child: ChildProcess,
            metadata?: { processGroupId: number | null }
          ) => void;
        }) =>
          phase === "test"
            ? runSpawnedCommand(command)
            : { exitCode: 0, signal: null }
      }),
      1_000,
      "stubborn acceptance timeout"
    );

    expect(result).toEqual({ exitCode: 97, signal: null });
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes its upload directory after SIGKILL and preserves an unknown directory", async () => {
    const { releaseTestDbLock, runApiTestLifecycle } = await loadWrapper();
    const unknownUploadDir = await mkdtemp(
      path.join(tmpdir(), "peileme-unknown-upload-")
    );
    const unknownSentinel = path.join(unknownUploadDir, "sentinel.txt");
    await writeFile(unknownSentinel, "keep", "utf8");
    const previousWrapperUploadDir = process.env.TEST_WRAPPER_UPLOAD_DIR;
    process.env.TEST_WRAPPER_UPLOAD_DIR = unknownUploadDir;
    let wrapperUploadDir = "";
    const errors: string[] = [];

    try {
      const result = await withWatchdog(
        runApiTestLifecycle({
          lockPath,
          lockPort,
          logError: (message: string) => errors.push(message),
          releaseLock: async (lock: unknown) => {
            await releaseTestDbLock(lock);
            throw new Error("release failed");
          },
          runCommand: async ({
            phase,
            cwd,
            env,
            onSpawn
          }: {
            phase: string;
            cwd: string;
            env?: NodeJS.ProcessEnv;
            onSpawn: (
              child: ChildProcess,
              metadata?: { processGroupId: number | null }
            ) => void;
          }) => {
            if (phase === "up") return { exitCode: 0, signal: null };
            if (phase === "down") return { exitCode: 29, signal: null };
            wrapperUploadDir = env?.TEST_WRAPPER_UPLOAD_DIR ?? "";
            if (!wrapperUploadDir) return { exitCode: 91, signal: null };
            return runSpawnedCommand({
              command: process.execPath,
              args: [
                "-e",
                "const fs = require('node:fs');" +
                  "const path = require('node:path');" +
                  "fs.writeFileSync(path.join(process.env.TEST_WRAPPER_UPLOAD_DIR, 'marker.txt'), 'started');" +
                  "process.kill(process.pid, 'SIGKILL');"
              ],
              cwd,
              env,
              onSpawn
            });
          }
        }),
        1_000,
        "SIGKILL upload cleanup lifecycle"
      );

      expect(result).toEqual({ exitCode: 137, signal: "SIGKILL" });
      expect(wrapperUploadDir).not.toBe("");
      expect(wrapperUploadDir).not.toBe(unknownUploadDir);
      await expect(access(wrapperUploadDir)).rejects.toMatchObject({
        code: "ENOENT"
      });
      await expect(access(unknownSentinel)).resolves.toBeUndefined();
      expect(errors.join("\n")).toContain("cleanup failed with exit code 29");
      expect(errors.join("\n")).toContain("release failed");
    } finally {
      if (previousWrapperUploadDir === undefined) {
        delete process.env.TEST_WRAPPER_UPLOAD_DIR;
      } else {
        process.env.TEST_WRAPPER_UPLOAD_DIR = previousWrapperUploadDir;
      }
      await rm(unknownUploadDir, { recursive: true, force: true });
    }
  });

  it("preserves a same-path replacement without its ownership marker", async () => {
    const observation = await exerciseLifecycleUploadReplacement({
      replacement: "missing-marker"
    });

    try {
      expect(observation.result).toEqual({ exitCode: 1, signal: null });
      await expect(access(observation.wrapperUploadDir)).resolves.toBeUndefined();
      await expect(access(observation.sentinelPath)).resolves.toBeUndefined();
      expect(observation.errors.join("\n")).toContain(
        "Test upload cleanup failed"
      );
    } finally {
      await observation.cleanup();
    }
  });

  it("preserves the test exit code and a same-path replacement with the wrong token", async () => {
    const observation = await exerciseLifecycleUploadReplacement({
      replacement: "wrong-token",
      testExitCode: 23
    });

    try {
      expect(observation.result).toEqual({ exitCode: 23, signal: null });
      await expect(access(observation.wrapperUploadDir)).resolves.toBeUndefined();
      await expect(access(observation.sentinelPath)).resolves.toBeUndefined();
      expect(observation.errors.join("\n")).toContain(
        "Test upload cleanup failed"
      );
    } finally {
      await observation.cleanup();
    }
  });

  it.runIf(process.platform !== "win32")(
    "preserves a symlink that replaces its owned upload directory",
    async () => {
      const observation = await exerciseLifecycleUploadReplacement({
        replacement: "symlink",
        testSignal: "SIGTERM"
      });

      try {
        expect(observation.result).toEqual({
          exitCode: 143,
          signal: "SIGTERM"
        });
        expect(
          (await lstat(observation.wrapperUploadDir)).isSymbolicLink()
        ).toBe(true);
        await expect(access(observation.sentinelPath)).resolves.toBeUndefined();
        expect(observation.errors.join("\n")).toContain(
          "Test upload cleanup failed"
        );
      } finally {
        await observation.cleanup();
      }
    }
  );

  it("parses explicit lifecycle-only failure, hold, and stubborn controls", async () => {
    const { parseLifecycleArgs } = await loadWrapper();

    expect(
      parseLifecycleArgs([
        "--lifecycle-test-exit-code=31",
        "--lifecycle-test-hold-ms=250",
        "--lifecycle-test-stubborn-ms=60000",
        "--reporter=dot"
      ])
    ).toEqual({
      forcedTestExitCode: 31,
      holdMs: 250,
      stubbornMs: 60_000,
      vitestArgs: ["--reporter=dot"]
    });
  });
});
