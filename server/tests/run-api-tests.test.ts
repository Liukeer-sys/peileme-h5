import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error The executable JavaScript wrapper intentionally has no TypeScript declarations.
import * as wrapperModule from "../../scripts/run-api-tests.mjs";

const wrapperPath = path.resolve("scripts/run-api-tests.mjs");
const loadWrapper = async () => wrapperModule;

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
    expect(String(losers[0].reason)).toContain("already owned");

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
    expect(errors.join("\n")).toContain("already owned");
    expect(errors.join("\n")).toContain(String(process.pid));
    await expect(access(lockPath)).resolves.toBeUndefined();
    await releaseTestDbLock(active);
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

  it("parses explicit lifecycle-only failure and hold controls", async () => {
    const { parseLifecycleArgs } = await loadWrapper();

    expect(
      parseLifecycleArgs([
        "--lifecycle-test-exit-code=31",
        "--lifecycle-test-hold-ms=250",
        "--reporter=dot"
      ])
    ).toEqual({
      forcedTestExitCode: 31,
      holdMs: 250,
      vitestArgs: ["--reporter=dot"]
    });
  });
});
