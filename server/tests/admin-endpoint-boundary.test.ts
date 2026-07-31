import { describe, expect, it } from "vitest";
import { isCurrentAdminEndpoint } from "../../src/admin/AdminEndpointBoundary";

describe("admin endpoint request boundary", () => {
  it("drops an old tab refresh that completes after a new tab becomes active", async () => {
    let activeEndpoint = "/api/admin/users?pageSize=100";
    const loaded: string[] = [];
    let finishOldAction!: () => void;
    const oldAction = new Promise<void>((resolve) => {
      finishOldAction = resolve;
    });
    const refreshAfterAction = async (
      capturedEndpoint: string,
      pendingAction: Promise<void>
    ) => {
      await pendingAction;
      if (isCurrentAdminEndpoint(activeEndpoint, capturedEndpoint)) {
        loaded.push(capturedEndpoint);
      }
    };
    const pendingRefresh = refreshAfterAction(activeEndpoint, oldAction);

    activeEndpoint = "/api/admin/uploads?pageSize=100";
    loaded.push(activeEndpoint);
    finishOldAction();
    await pendingRefresh;

    expect(loaded).toEqual(["/api/admin/uploads?pageSize=100"]);
  });

  it("rejects empty and mismatched endpoints", () => {
    expect(isCurrentAdminEndpoint("", "")).toBe(false);
    expect(isCurrentAdminEndpoint("/users", "/uploads")).toBe(false);
    expect(isCurrentAdminEndpoint("/users", "/users")).toBe(true);
  });
});
