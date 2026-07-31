import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MainPanelLifecycleGuard,
  createMainPanelPrivateState
} from "../../src/main/MainPanelLifecycle";

describe("main account panel lifecycle", () => {
  it("creates a clean private state for close and account changes", () => {
    expect(createMainPanelPrivateState()).toEqual({
      invite: "",
      message: "",
      displayName: "",
      busy: false
    });
    expect(createMainPanelPrivateState("用户 B")).toEqual({
      invite: "",
      message: "",
      displayName: "用户 B",
      busy: false
    });
  });

  it("rejects user A's late mutation as soon as user B is rendered", () => {
    const guard = new MainPanelLifecycleGuard();
    guard.activate("user-a");
    const userAMutation = guard.beginMutation("user-a");

    expect(userAMutation).not.toBeNull();
    expect(guard.isCurrent(userAMutation!, "user-b")).toBe(false);

    guard.activate("user-b");
    expect(guard.isCurrent(userAMutation!, "user-b")).toBe(false);
    expect(guard.beginMutation("user-b")).not.toBeNull();
  });

  it("rejects late mutation commits after the panel closes", () => {
    const guard = new MainPanelLifecycleGuard();
    guard.activate("user-a");
    const mutation = guard.beginMutation("user-a");

    guard.deactivate();

    expect(guard.isCurrent(mutation!, null)).toBe(false);
  });

  it("only lets the latest local mutation update message, invite and busy", () => {
    const guard = new MainPanelLifecycleGuard();
    guard.activate("user-a");
    const saveProfile = guard.beginMutation("user-a");
    const redeemInvite = guard.beginMutation("user-a");

    expect(guard.isCurrent(saveProfile!, "user-a")).toBe(false);
    expect(guard.isCurrent(redeemInvite!, "user-a")).toBe(true);
  });

  it("wires reset and lifecycle checks without importing AI modules", async () => {
    const [source, mainApp] = await Promise.all([
      readFile(
        resolve(process.cwd(), "src/main/MainAccountPanel.tsx"),
        "utf8"
      ),
      readFile(resolve(process.cwd(), "src/main/MainApp.tsx"), "utf8")
    ]);

    expect(source).toContain(
      'import {\\n  MainPanelLifecycleGuard,\\n  createMainPanelPrivateState\\n} from "./MainPanelLifecycle"'
        .replaceAll("\\n", "\n")
    );
    expect(source).toContain("resetPrivateState");
    expect(source).toContain("beginMutation(user.id)");
    expect(source).toMatch(
      /isCurrent\(\s*lifecycle,\s*visibleUserIdRef\.current\s*\)/
    );
    expect(source).toContain(".finally(onClose)");
    expect(source).not.toContain('"../ai/');
    expect(source).not.toContain("'../ai/");
    expect(mainApp).toContain('key={user?.id ?? "signed-out"}');
  });
});
