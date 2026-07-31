import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import {
  api,
  beginAuthTransition,
  completeAuthTransition,
  initializeSession,
  setAccessToken,
  track
} from "../lib/api";

export type User = {
  id: string;
  role:
    | "user"
    | "admin"
    | "policy_editor"
    | "policy_reviewer"
    | "operations"
    | "finance"
    | "support"
    | "ai_operator"
    | "auditor"
    | "analyst";
  email: string | null;
  phone: string | null;
  displayName: string | null;
  status: "active" | "disabled";
};

export type AuthCommitIdentity = {
  userId: string;
  generation: number;
};

export const isCurrentAuthIdentity = (
  currentUserId: string | null,
  currentGeneration: number,
  expected: AuthCommitIdentity
) =>
  currentUserId === expected.userId &&
  currentGeneration === expected.generation;

export function applyAuthScopedReload<T>(
  currentUserId: string | null,
  currentGeneration: number,
  expected: AuthCommitIdentity,
  currentValue: T,
  nextValue: T
) {
  return isCurrentAuthIdentity(
    currentUserId,
    currentGeneration,
    expected
  )
    ? nextValue
    : currentValue;
}

export const applyProfileUpdateForInitiator = (
  current: User | null,
  currentGeneration: number,
  expected: AuthCommitIdentity,
  displayName: string
): User | null =>
  current &&
  isCurrentAuthIdentity(current.id, currentGeneration, expected)
    ? { ...current, displayName }
    : current;

export const grantModules = ["caseLawPack", "evidencePack"] as const;
export type GrantModule = (typeof grantModules)[number];

type Grant = {
  module: GrantModule;
  expires_at: string | null;
};

const isGrantModule = (value: unknown): value is GrantModule =>
  typeof value === "string" &&
  (grantModules as readonly string[]).includes(value);

const sanitizeGrants = (value: unknown): Grant[] => {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (grant): grant is Grant =>
      typeof grant === "object" &&
      grant !== null &&
      isGrantModule((grant as { module?: unknown }).module)
  );
};

const sanitizeGrantModules = (value: unknown): GrantModule[] =>
  Array.isArray(value) ? value.filter(isGrantModule) : [];

type SessionResponse = {
  accessToken: string;
  user: User;
};

type MeResponse = {
  user: User;
  capabilities: unknown;
};

const sanitizeCapabilities = (value: unknown) =>
  Array.isArray(value)
    ? value.filter(
        (capability): capability is string =>
          typeof capability === "string"
      )
    : [];

export type DeviceSession = {
  id: string;
  userAgent: string | null;
  ip: string | null;
  expiresAt: string;
  lastUsedAt: string | null;
  createdAt: string;
  isCurrent: boolean;
};

type AuthContextValue = {
  user: User | null;
  capabilities: string[];
  grants: Grant[];
  sessions: DeviceSession[];
  ready: boolean;
  sendCode: (target: string, purpose: "register" | "login" | "reset_password") => Promise<{ debugCode?: string }>;
  login: (identifier: string, credential: { password?: string; code?: string }) => Promise<void>;
  register: (input: {
    target: string;
    code: string;
    password?: string;
    displayName?: string;
    inviteCode?: string;
  }) => Promise<void>;
  resetPassword: (target: string, code: string, password: string) => Promise<void>;
  updateProfile: (displayName: string) => Promise<void>;
  logout: () => Promise<void>;
  revokeSession: (id: string) => Promise<void>;
  revokeOtherSessions: () => Promise<number>;
  redeemInvite: (code: string) => Promise<GrantModule[]>;
  reloadGrants: () => Promise<void>;
  reloadSessions: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export class LogoutError extends Error {
  readonly code = "LOGOUT_FAILED";
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("远端退出失败，本地登录状态已清除");
    this.name = "LogoutError";
    this.cause = cause;
  }
}

export const logoutWithLocalCleanup = async (
  remoteLogout: () => Promise<void>,
  clearLocal: () => void
) => {
  let failed = false;
  let remoteError: unknown;
  try {
    await remoteLogout();
  } catch (error) {
    failed = true;
    remoteError = error;
  } finally {
    clearLocal();
  }
  if (failed) throw new LogoutError(remoteError);
};

export const revokeCurrentSessionWithTransition = async (
  remoteRevoke: () => Promise<void>,
  clearLocal: () => void
) => {
  await remoteRevoke();
  const transition = await beginAuthTransition();
  try {
    clearLocal();
  } finally {
    completeAuthTransition(transition);
  }
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [ready, setReady] = useState(false);
  const currentUserIdRef = useRef<string | null>(null);
  const authGenerationRef = useRef(0);

  const currentAuthIdentity = useCallback((): AuthCommitIdentity | null => {
    const userId = currentUserIdRef.current;
    return userId
      ? { userId, generation: authGenerationRef.current }
      : null;
  }, []);

  const commitUser = useCallback((nextUser: User | null) => {
    currentUserIdRef.current = nextUser?.id ?? null;
    setUser(nextUser);
  }, []);

  const reloadGrantsForIdentity = useCallback(async (
    expected: AuthCommitIdentity | null
  ) => {
    if (!expected) {
      if (!currentUserIdRef.current) setGrants([]);
      return;
    }
    try {
      const result = await api<{ grants: unknown }>("/api/access/me", { auth: true });
      const nextGrants = sanitizeGrants(result.grants);
      setGrants((current) =>
        applyAuthScopedReload(
          currentUserIdRef.current,
          authGenerationRef.current,
          expected,
          current,
          nextGrants
        )
      );
    } catch {
      setGrants((current) =>
        applyAuthScopedReload(
          currentUserIdRef.current,
          authGenerationRef.current,
          expected,
          current,
          []
        )
      );
    }
  }, []);

  const reloadSessionsForIdentity = useCallback(async (
    expected: AuthCommitIdentity | null
  ) => {
    if (!expected) {
      if (!currentUserIdRef.current) setSessions([]);
      return;
    }
    try {
      const result = await api<{ items: DeviceSession[] }>("/api/auth/sessions", {
        auth: true
      });
      setSessions((current) =>
        applyAuthScopedReload(
          currentUserIdRef.current,
          authGenerationRef.current,
          expected,
          current,
          result.items
        )
      );
    } catch {
      setSessions((current) =>
        applyAuthScopedReload(
          currentUserIdRef.current,
          authGenerationRef.current,
          expected,
          current,
          []
        )
      );
    }
  }, []);

  const reloadGrants = useCallback(
    () => reloadGrantsForIdentity(currentAuthIdentity()),
    [currentAuthIdentity, reloadGrantsForIdentity]
  );

  const reloadSessions = useCallback(
    () => reloadSessionsForIdentity(currentAuthIdentity()),
    [currentAuthIdentity, reloadSessionsForIdentity]
  );

  const acceptSession = useCallback(
    async (session: SessionResponse, generation: number) => {
      if (authGenerationRef.current !== generation) return false;
      setAccessToken(session.accessToken);
      const me = await api<MeResponse>("/api/auth/me", { auth: true });
      if (authGenerationRef.current !== generation) return false;
      commitUser(me.user);
      setCapabilities(sanitizeCapabilities(me.capabilities));
      setGrants([]);
      setSessions([]);
      const identity = { userId: me.user.id, generation };
      await Promise.all([
        reloadGrantsForIdentity(identity),
        reloadSessionsForIdentity(identity),
        api("/api/assessments/claim", { method: "POST", auth: true }).catch(() => undefined)
      ]);
      return authGenerationRef.current === generation;
    },
    [commitUser, reloadGrantsForIdentity, reloadSessionsForIdentity]
  );

  useEffect(() => {
    let active = true;
    const generation = authGenerationRef.current + 1;
    authGenerationRef.current = generation;
    void (async () => {
      const refreshed = await initializeSession();
      if (
        refreshed &&
        active &&
        authGenerationRef.current === generation
      ) {
        try {
          const me = await api<MeResponse>("/api/auth/me", { auth: true });
          if (active && authGenerationRef.current === generation) {
            commitUser(me.user);
            setCapabilities(sanitizeCapabilities(me.capabilities));
            const identity = { userId: me.user.id, generation };
            await Promise.all([
              reloadGrantsForIdentity(identity),
              reloadSessionsForIdentity(identity)
            ]);
          }
        } catch {
          if (active && authGenerationRef.current === generation) {
            setAccessToken(null);
            commitUser(null);
            setCapabilities([]);
            setGrants([]);
            setSessions([]);
          }
        }
      }
      if (active) setReady(true);
    })();
    return () => {
      active = false;
    };
  }, [commitUser, reloadGrantsForIdentity, reloadSessionsForIdentity]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      capabilities,
      grants,
      sessions,
      ready,
      sendCode: (target, purpose) =>
        api("/api/auth/send-code", {
          method: "POST",
          body: { target, purpose }
        }),
      login: async (identifier, credential) => {
        const generation = authGenerationRef.current + 1;
        authGenerationRef.current = generation;
        const transition = await beginAuthTransition();
        try {
          const session = await api<SessionResponse>("/api/auth/login", {
            method: "POST",
            body: { identifier, ...credential }
          });
          if (await acceptSession(session, generation)) {
            track("auth_logged_in", {
              method: credential.code ? "code" : "password"
            });
          }
        } finally {
          completeAuthTransition(transition);
        }
      },
      register: async (input) => {
        const generation = authGenerationRef.current + 1;
        authGenerationRef.current = generation;
        const transition = await beginAuthTransition();
        try {
          const session = await api<SessionResponse>("/api/auth/register", {
            method: "POST",
            body: input
          });
          if (await acceptSession(session, generation)) {
            track("auth_registered", {
              channel: input.target.includes("@") ? "email" : "sms",
              invite: Boolean(input.inviteCode)
            });
          }
        } finally {
          completeAuthTransition(transition);
        }
      },
      resetPassword: async (target, code, password) => {
        await api("/api/auth/reset-password", {
          method: "POST",
          body: { target, code, password }
        });
        track("password_reset");
      },
      updateProfile: async (displayName) => {
        const identity = currentAuthIdentity();
        if (!identity) throw new Error("AUTH_REQUIRED");
        const result = await api<{ displayName: string }>("/api/auth/me", {
          method: "PATCH",
          auth: true,
          body: { displayName }
        });
        setUser((current) =>
          applyProfileUpdateForInitiator(
            current,
            authGenerationRef.current,
            identity,
            result.displayName
          )
        );
      },
      logout: async () => {
        const generation = authGenerationRef.current + 1;
        authGenerationRef.current = generation;
        const transition = await beginAuthTransition();
        try {
          await logoutWithLocalCleanup(
            () => api("/api/auth/logout", { method: "POST" }),
            () => {
              if (authGenerationRef.current !== generation) return;
              setAccessToken(null);
              commitUser(null);
              setCapabilities([]);
              setGrants([]);
              setSessions([]);
              track("auth_logged_out");
            }
          );
        } finally {
          completeAuthTransition(transition);
        }
      },
      revokeSession: async (id) => {
        const identity = currentAuthIdentity();
        const revokedCurrent = sessions.some(
          (session) => session.id === id && session.isCurrent
        );
        const revokeGeneration = revokedCurrent
          ? authGenerationRef.current + 1
          : authGenerationRef.current;
        if (revokedCurrent) {
          authGenerationRef.current = revokeGeneration;
        }
        const remoteRevoke = () =>
          api<void>(`/api/auth/sessions/${id}`, {
            method: "DELETE",
            auth: true
          });
        if (revokedCurrent) {
          await revokeCurrentSessionWithTransition(remoteRevoke, () => {
            if (authGenerationRef.current !== revokeGeneration) return;
            setAccessToken(null);
            commitUser(null);
            setCapabilities([]);
            setGrants([]);
            setSessions([]);
            track("auth_session_revoked", { current: true });
          });
          return;
        }
        await remoteRevoke();
        await reloadSessionsForIdentity(identity);
        track("auth_session_revoked", { current: false });
      },
      revokeOtherSessions: async () => {
        const identity = currentAuthIdentity();
        const result = await api<{ revoked: number }>(
          "/api/auth/sessions/revoke-others",
          { method: "POST", auth: true }
        );
        await reloadSessionsForIdentity(identity);
        track("auth_other_sessions_revoked", { count: result.revoked });
        return result.revoked;
      },
      redeemInvite: async (code) => {
        const identity = currentAuthIdentity();
        if (!identity) throw new Error("AUTH_REQUIRED");
        const result = await api<{ grants: unknown }>("/api/invites/redeem", {
          method: "POST",
          auth: true,
          body: { code }
        });
        await reloadGrantsForIdentity(identity);
        const modules = sanitizeGrantModules(result.grants);
        track("invite_redeemed", { modules });
        return modules;
      },
      reloadGrants,
      reloadSessions
    }),
    [
      acceptSession,
      capabilities,
      commitUser,
      currentAuthIdentity,
      grants,
      ready,
      reloadGrants,
      reloadGrantsForIdentity,
      reloadSessions,
      reloadSessionsForIdentity,
      sessions,
      user
    ]
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth requires an auth context");
  return context;
};
