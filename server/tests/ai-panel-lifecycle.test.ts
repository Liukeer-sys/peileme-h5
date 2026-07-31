import { describe, expect, it } from "vitest";
import {
  AiPanelLifecycleGuard,
  type AiPanelLifecycle
} from "../../src/ai/AiPanelLifecycle";

describe("AI private panel lifecycle guard", () => {
  it("invalidates user A requests and aborts them when user B becomes active", () => {
    const guard = new AiPanelLifecycleGuard();
    const userA = guard.activate("user-a");
    const slowLoad = guard.beginRequest("load", userA);
    const pendingUpload = guard.beginRequest("upload", userA);
    const pendingDownload = guard.beginRequest("download", userA);

    const userB = guard.activate("user-b");

    expect(slowLoad.signal.aborted).toBe(true);
    expect(pendingUpload.signal.aborted).toBe(true);
    expect(pendingDownload.signal.aborted).toBe(true);
    expect(guard.isCurrent(userA)).toBe(false);
    expect(guard.isCurrent(userB)).toBe(true);
  });

  it("rejects late responses after close even when a transport ignores abort", () => {
    const guard = new AiPanelLifecycleGuard();
    const lifecycle = guard.activate("user-a");
    guard.beginRequest("load", lifecycle);

    guard.deactivate();

    expect(guard.isCurrent(lifecycle)).toBe(false);
    expect(guard.current("user-a")).toBeNull();
  });

  it("only lets the latest request of one kind remain active", () => {
    const guard = new AiPanelLifecycleGuard();
    const lifecycle = guard.activate("user-a");
    const first = guard.beginRequest("load", lifecycle);
    const second = guard.beginRequest("load", lifecycle);

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(guard.isCurrent(lifecycle)).toBe(true);
  });

  it("invalidates a pending account mutation before another account mutation starts", () => {
    const guard = new AiPanelLifecycleGuard();
    const lifecycle = guard.activate("user-a");
    const saveProfile = guard.beginRequest("account", lifecycle);
    const redeemInvite = guard.beginRequest("account", lifecycle);

    expect(saveProfile.signal.aborted).toBe(true);
    expect(redeemInvite.signal.aborted).toBe(false);
  });

  it("does not create a request for a stale lifecycle", () => {
    const guard = new AiPanelLifecycleGuard();
    const stale: AiPanelLifecycle = { generation: 1, userId: "user-a" };

    const request = guard.beginRequest("upload", stale);

    expect(request.signal.aborted).toBe(true);
  });
});
