import { afterEach, describe, expect, it, vi } from "vitest";

const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  };
};

const installBrowserGlobals = () => {
  vi.stubGlobal("document", {
    cookie: "peileme_csrf=%E0%A4%A",
    createElement: vi.fn()
  });
  vi.stubGlobal("window", {
    localStorage: storage(),
    sessionStorage: storage(),
    location: { pathname: "/" },
    addEventListener: vi.fn(),
    clearTimeout,
    setTimeout
  });
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("browser authentication safety", () => {
  it("ignores a malformed percent-encoded CSRF cookie without throwing", async () => {
    installBrowserGlobals();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 204 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("../../src/lib/api.js");

    await expect(api("/api/test", { method: "POST" })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("clears local auth state and throws an identifiable error when remote logout fails", async () => {
    installBrowserGlobals();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    );
    const authModule = await import("../../src/auth/AuthContext.js");
    const logoutWithLocalCleanup = (
      authModule as unknown as {
        logoutWithLocalCleanup?: (
          remoteLogout: () => Promise<void>,
          clearLocal: () => void
        ) => Promise<void>;
      }
    ).logoutWithLocalCleanup;
    expect(typeof logoutWithLocalCleanup).toBe("function");
    const clearLocal = vi.fn();
    const remoteError = new Error("network unavailable");

    await expect(
      logoutWithLocalCleanup!(
        async () => {
          throw remoteError;
        },
        clearLocal
      )
    ).rejects.toMatchObject({
      name: "LogoutError",
      code: "LOGOUT_FAILED",
      cause: remoteError
    });
    expect(clearLocal).toHaveBeenCalledOnce();
  });
});
