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

  it("aborts and settles a pending refresh before an auth transition continues", async () => {
    installBrowserGlobals();
    const order: string[] = [];
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          order.push("refresh-started");
          init?.signal?.addEventListener("abort", () => {
            order.push("refresh-aborted");
            reject(new DOMException("Aborted", "AbortError"));
          });
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const {
      beginAuthTransition,
      completeAuthTransition,
      initializeSession
    } = await import("../../src/lib/api.js");

    const refresh = initializeSession();
    const transition = await beginAuthTransition();
    order.push("logout-may-start");

    expect(await refresh).toBe(false);
    expect(order).toEqual([
      "refresh-started",
      "refresh-aborted",
      "logout-may-start"
    ]);
    completeAuthTransition(transition);
  });

  it("blocks new refreshes and cannot restore a token after logout cleanup", async () => {
    installBrowserGlobals();
    let resolveRefresh!: (response: Response) => void;
    const pendingRefresh = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => pendingRefresh)
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const {
      api,
      beginAuthTransition,
      completeAuthTransition,
      initializeSession,
      setAccessToken
    } = await import("../../src/lib/api.js");

    const refresh = initializeSession();
    const transitionPromise = beginAuthTransition();
    await expect(initializeSession()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();

    resolveRefresh(
      new Response(JSON.stringify({ accessToken: "late-user-a-token" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    await expect(refresh).resolves.toBe(false);
    const transition = await transitionPromise;
    setAccessToken(null);
    completeAuthTransition(transition);

    await api("/api/probe");
    const probeOptions = fetchMock.mock.calls[1]?.[1] as
      | RequestInit
      | undefined;
    expect(probeOptions?.headers).not.toMatchObject({
      authorization: expect.any(String)
    });
  });

  it("keeps refresh blocked until every overlapping auth transition completes", async () => {
    installBrowserGlobals();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 204 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const {
      beginAuthTransition,
      completeAuthTransition,
      initializeSession
    } = await import("../../src/lib/api.js");

    const olderTransition = await beginAuthTransition();
    const newerTransition = await beginAuthTransition();
    completeAuthTransition(newerTransition);

    await expect(initializeSession()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    completeAuthTransition(olderTransition);
    await expect(initializeSession()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "missing",
      initialToken: null,
      responses: [
        new Response(JSON.stringify({ accessToken: "refreshed-token" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        }),
        new Response(null, { status: 204 })
      ],
      expectedPaths: ["/api/auth/refresh", "/api/auth/sessions/current"]
    },
    {
      label: "expired",
      initialToken: "expired-token",
      responses: [
        new Response(
          JSON.stringify({
            error: "AUTH_REQUIRED",
            message: "登录状态已过期"
          }),
          {
            status: 401,
            headers: { "content-type": "application/json" }
          }
        ),
        new Response(JSON.stringify({ accessToken: "refreshed-token" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        }),
        new Response(null, { status: 204 })
      ],
      expectedPaths: [
        "/api/auth/sessions/current",
        "/api/auth/refresh",
        "/api/auth/sessions/current"
      ]
    }
  ])(
    "revokes the current session with a $label access token before blocking refresh",
    async ({ initialToken, responses, expectedPaths }) => {
      installBrowserGlobals();
      const fetchMock = vi.fn();
      for (const response of responses) {
        fetchMock.mockResolvedValueOnce(response);
      }
      vi.stubGlobal("fetch", fetchMock);
      const { api, setAccessToken } = await import("../../src/lib/api.js");
      const { revokeCurrentSessionWithTransition } = await import(
        "../../src/auth/AuthContext.js"
      );
      const clearLocal = vi.fn();
      setAccessToken(initialToken);

      await revokeCurrentSessionWithTransition(
        () =>
          api("/api/auth/sessions/current", {
            method: "DELETE",
            auth: true
          }),
        clearLocal
      );

      expect(
        fetchMock.mock.calls.map(([path]) => path)
      ).toEqual(expectedPaths);
      expect(clearLocal).toHaveBeenCalledOnce();
      setAccessToken(null);
    }
  );

  it("does not apply a late profile response to a different signed-in user", async () => {
    installBrowserGlobals();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    );
    const { applyProfileUpdateForInitiator } = await import(
      "../../src/auth/AuthContext.js"
    );
    const userB = {
      id: "user-b",
      role: "user" as const,
      email: "b@example.com",
      phone: null,
      displayName: "用户 B",
      status: "active" as const
    };

    expect(
      applyProfileUpdateForInitiator(
        userB,
        2,
        { userId: "user-a", generation: 1 },
        "用户 A 的新称呼"
      )
    ).toBe(userB);
    expect(
      applyProfileUpdateForInitiator(
        userB,
        2,
        { userId: "user-b", generation: 2 },
        "用户 B 的新称呼"
      )
    ).toEqual({ ...userB, displayName: "用户 B 的新称呼" });
  });

  it("does not apply user A's late grant reload after user B signs in", async () => {
    installBrowserGlobals();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    );
    const { applyAuthScopedReload } = await import(
      "../../src/auth/AuthContext.js"
    );
    const userAGrants = [{ module: "caseLawPack", expires_at: null }];
    const userBGrants = [{ module: "evidencePack", expires_at: null }];
    let currentUserId: string | null = "user-a";
    let visibleGrants = userAGrants;
    let resolveUserA!: (grants: typeof userAGrants) => void;
    const userALateResponse = new Promise<typeof userAGrants>((resolve) => {
      resolveUserA = resolve;
    });
    const pendingCommit = userALateResponse.then((nextGrants) => {
      visibleGrants = applyAuthScopedReload(
        currentUserId,
        2,
        { userId: "user-a", generation: 1 },
        visibleGrants,
        nextGrants
      );
    });

    currentUserId = "user-b";
    visibleGrants = userBGrants;
    resolveUserA(userAGrants);
    await pendingCommit;

    expect(visibleGrants).toBe(userBGrants);
  });

  it("does not apply user A's late session reload after user B signs in", async () => {
    installBrowserGlobals();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    );
    const { applyAuthScopedReload } = await import(
      "../../src/auth/AuthContext.js"
    );
    const userASessions = [{ id: "session-a" }];
    const userBSessions = [{ id: "session-b" }];
    let currentUserId: string | null = "user-a";
    let currentGeneration = 1;
    let visibleSessions = userASessions;
    let resolveUserA!: (sessions: typeof userASessions) => void;
    const userALateResponse = new Promise<typeof userASessions>((resolve) => {
      resolveUserA = resolve;
    });
    const pendingCommit = userALateResponse.then((nextSessions) => {
      visibleSessions = applyAuthScopedReload(
        currentUserId,
        currentGeneration,
        { userId: "user-a", generation: 1 },
        visibleSessions,
        nextSessions
      );
    });

    currentUserId = "user-b";
    currentGeneration = 2;
    visibleSessions = userBSessions;
    resolveUserA(userASessions);
    await pendingCommit;

    expect(visibleSessions).toBe(userBSessions);
  });

  it("passes abort through downloads and never clicks after cancellation", async () => {
    const anchor = {
      click: vi.fn(),
      remove: vi.fn(),
      href: "",
      download: ""
    };
    vi.stubGlobal("document", {
      cookie: "",
      createElement: vi.fn(() => anchor),
      body: { appendChild: vi.fn() }
    });
    vi.stubGlobal("window", {
      localStorage: storage(),
      sessionStorage: storage(),
      location: { pathname: "/" },
      addEventListener: vi.fn(),
      clearTimeout,
      setTimeout
    });
    let resolveDownload!: (response: Response) => void;
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          resolveDownload = resolve;
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { downloadFromApi, setAccessToken } = await import(
      "../../src/lib/api.js"
    );
    setAccessToken("download-token");
    const controller = new AbortController();
    const download = downloadFromApi(
      "/api/uploads/a/download",
      "a.pdf",
      controller.signal
    );

    controller.abort();
    resolveDownload(new Response("private-a", { status: 200 }));

    await expect(download).rejects.toMatchObject({ name: "AbortError" });
    expect(anchor.click).not.toHaveBeenCalled();
    setAccessToken(null);
  });
});
