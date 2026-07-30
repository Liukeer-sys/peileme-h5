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

type AuthContextValue = {
  user: User | null;
  grants: Grant[];
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
  redeemInvite: (code: string) => Promise<string[]>;
  reloadGrants: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [ready, setReady] = useState(false);

  const reloadGrants = useCallback(async () => {
    try {
      const result = await api<{ grants: Grant[] }>("/api/access/me", { auth: true });
      setGrants(result.grants);
    } catch {
      setGrants([]);
    }
  }, []);

  const acceptSession = useCallback(
    async (session: SessionResponse) => {
      setAccessToken(session.accessToken);
      setUser(session.user);
      await Promise.all([
        reloadGrants(),
        api("/api/assessments/claim", { method: "POST", auth: true }).catch(() => undefined)
      ]);
    },
    [reloadGrants]
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
            await reloadGrants();
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
  }, [reloadGrants]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      grants,
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
        await api("/api/auth/logout", { method: "POST" });
        setAccessToken(null);
        setUser(null);
        setGrants([]);
        track("auth_logged_out");
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
      reloadGrants
    }),
    [acceptSession, grants, ready, reloadGrants, user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
};
