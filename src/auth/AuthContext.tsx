import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";
import { api, initializeSession, setAccessToken, track } from "../lib/api";

export type User = {
  id: string;
  role: "user" | "admin" | "analyst";
  email: string | null;
  phone: string | null;
  displayName: string | null;
  status: "active" | "disabled";
};

type Grant = {
  module: "caseLawPack" | "evidencePack" | "documentReview";
  expires_at: string | null;
};

type SessionResponse = {
  accessToken: string;
  user: User;
};

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
  redeemInvite: (code: string) => Promise<string[]>;
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [ready, setReady] = useState(false);

  const reloadGrants = useCallback(async () => {
    try {
      const result = await api<{ grants: Grant[] }>("/api/access/me", { auth: true });
      setGrants(result.grants);
    } catch {
      setGrants([]);
    }
  }, []);

  const reloadSessions = useCallback(async () => {
    try {
      const result = await api<{ items: DeviceSession[] }>("/api/auth/sessions", {
        auth: true
      });
      setSessions(result.items);
    } catch {
      setSessions([]);
    }
  }, []);

  const acceptSession = useCallback(
    async (session: SessionResponse) => {
      setAccessToken(session.accessToken);
      setUser(session.user);
      await Promise.all([
        reloadGrants(),
        reloadSessions(),
        api("/api/assessments/claim", { method: "POST", auth: true }).catch(() => undefined)
      ]);
    },
    [reloadGrants, reloadSessions]
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      const refreshed = await initializeSession();
      if (refreshed) {
        try {
          const me = await api<{ user: User }>("/api/auth/me", { auth: true });
          if (active) {
            setUser(me.user);
            await Promise.all([reloadGrants(), reloadSessions()]);
          }
        } catch {
          setAccessToken(null);
        }
      }
      if (active) setReady(true);
    })();
    return () => {
      active = false;
    };
  }, [reloadGrants, reloadSessions]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      grants,
      sessions,
      ready,
      sendCode: (target, purpose) =>
        api("/api/auth/send-code", {
          method: "POST",
          body: { target, purpose }
        }),
      login: async (identifier, credential) => {
        const session = await api<SessionResponse>("/api/auth/login", {
          method: "POST",
          body: { identifier, ...credential }
        });
        await acceptSession(session);
        track("auth_logged_in", { method: credential.code ? "code" : "password" });
      },
      register: async (input) => {
        const session = await api<SessionResponse>("/api/auth/register", {
          method: "POST",
          body: input
        });
        await acceptSession(session);
        track("auth_registered", {
          channel: input.target.includes("@") ? "email" : "sms",
          invite: Boolean(input.inviteCode)
        });
      },
      resetPassword: async (target, code, password) => {
        await api("/api/auth/reset-password", {
          method: "POST",
          body: { target, code, password }
        });
        track("password_reset");
      },
      updateProfile: async (displayName) => {
        const result = await api<{ displayName: string }>("/api/auth/me", {
          method: "PATCH",
          auth: true,
          body: { displayName }
        });
        setUser((current) => current ? { ...current, displayName: result.displayName } : current);
      },
      logout: async () => {
        await logoutWithLocalCleanup(
          () => api("/api/auth/logout", { method: "POST" }),
          () => {
            setAccessToken(null);
            setUser(null);
            setGrants([]);
            setSessions([]);
            track("auth_logged_out");
          }
        );
      },
      revokeSession: async (id) => {
        const revokedCurrent = sessions.some(
          (session) => session.id === id && session.isCurrent
        );
        await api(`/api/auth/sessions/${id}`, {
          method: "DELETE",
          auth: true
        });
        if (revokedCurrent) {
          setAccessToken(null);
          setUser(null);
          setGrants([]);
          setSessions([]);
          track("auth_session_revoked", { current: true });
          return;
        }
        await reloadSessions();
        track("auth_session_revoked", { current: false });
      },
      revokeOtherSessions: async () => {
        const result = await api<{ revoked: number }>(
          "/api/auth/sessions/revoke-others",
          { method: "POST", auth: true }
        );
        await reloadSessions();
        track("auth_other_sessions_revoked", { count: result.revoked });
        return result.revoked;
      },
      redeemInvite: async (code) => {
        const result = await api<{ grants: string[] }>("/api/invites/redeem", {
          method: "POST",
          auth: true,
          body: { code }
        });
        await reloadGrants();
        track("invite_redeemed", { modules: result.grants });
        return result.grants;
      },
      reloadGrants,
      reloadSessions
    }),
    [
      acceptSession,
      grants,
      ready,
      reloadGrants,
      reloadSessions,
      sessions,
      user
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
};
