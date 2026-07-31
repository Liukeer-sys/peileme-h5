import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth, type GrantModule } from "../auth/AuthContext";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { ApiError, track } from "../lib/api";
import {
  MainPanelLifecycleGuard,
  createMainPanelPrivateState
} from "./MainPanelLifecycle";
import PolicyHistory from "./PolicyHistory";
import type { PolicyHistoryDetail } from "../types";

type MainAccountPanelProps = {
  open: boolean;
  onClose: () => void;
  historyRefreshKey?: string;
  policyRecalculating?: boolean;
  onPolicyRecalculate?: (detail: PolicyHistoryDetail) => Promise<boolean>;
};

const moduleNames: Record<GrantModule, string> = {
  caseLawPack: "案例法条包",
  evidencePack: "离职证据包"
};

export default function MainAccountPanel({
  open,
  onClose,
  historyRefreshKey,
  policyRecalculating = false,
  onPolicyRecalculate
}: MainAccountPanelProps) {
  const { user, capabilities, grants, logout, redeemInvite, updateProfile } = useAuth();
  const [invite, setInvite] = useState("");
  const [message, setMessage] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const displayNameRef = useRef<HTMLInputElement | null>(null);
  const lifecycleGuardRef = useRef(new MainPanelLifecycleGuard());
  const visibleUserIdRef = useRef<string | null>(null);
  visibleUserIdRef.current = open && user ? user.id : null;

  const resetPrivateState = useCallback((nextDisplayName = "") => {
    const nextState = createMainPanelPrivateState(nextDisplayName);
    setInvite(nextState.invite);
    setMessage(nextState.message);
    setDisplayName(nextState.displayName);
    setBusy(nextState.busy);
  }, []);

  useDialogFocus(open && Boolean(user), dialogRef, onClose, displayNameRef);

  useEffect(() => {
    if (!open || !user) {
      lifecycleGuardRef.current.deactivate();
      resetPrivateState();
      return;
    }
    const guard = lifecycleGuardRef.current;
    guard.activate(user.id);
    resetPrivateState(user.displayName || "");
    return () => guard.deactivate();
  }, [open, resetPrivateState, user?.id]);

  useEffect(() => {
    if (open && user) setDisplayName(user.displayName || "");
  }, [open, user?.displayName, user?.id]);

  if (!open || !user) return null;

  const redeem = async () => {
    const lifecycle = lifecycleGuardRef.current.beginMutation(user.id);
    if (!lifecycle) return;
    const inviteCode = invite.trim();
    setBusy(true);
    setMessage("");
    try {
      const modules = await redeemInvite(inviteCode);
      if (
        !lifecycleGuardRef.current.isCurrent(
          lifecycle,
          visibleUserIdRef.current
        )
      ) {
        return;
      }
      setMessage(`已解锁：${modules.map((item) => moduleNames[item]).join("、")}`);
      setInvite("");
    } catch (error) {
      if (
        !lifecycleGuardRef.current.isCurrent(
          lifecycle,
          visibleUserIdRef.current
        )
      ) {
        return;
      }
      setMessage(error instanceof ApiError ? error.message : "兑换失败，请稍后重试");
    } finally {
      if (
        lifecycleGuardRef.current.isCurrent(
          lifecycle,
          visibleUserIdRef.current
        )
      ) {
        setBusy(false);
      }
    }
  };

  const saveProfile = async () => {
    const nextDisplayName = displayName.trim();
    if (!nextDisplayName) return;
    const lifecycle = lifecycleGuardRef.current.beginMutation(user.id);
    if (!lifecycle) return;
    setBusy(true);
    setMessage("");
    try {
      await updateProfile(nextDisplayName);
      if (
        !lifecycleGuardRef.current.isCurrent(
          lifecycle,
          visibleUserIdRef.current
        )
      ) {
        return;
      }
      setMessage("称呼已更新");
    } catch (error) {
      if (
        !lifecycleGuardRef.current.isCurrent(
          lifecycle,
          visibleUserIdRef.current
        )
      ) {
        return;
      }
      setMessage(error instanceof ApiError ? error.message : "更新失败，请稍后重试");
    } finally {
      if (
        lifecycleGuardRef.current.isCurrent(
          lifecycle,
          visibleUserIdRef.current
        )
      ) {
        setBusy(false);
      }
    }
  };

  return (
    <div
      ref={dialogRef}
      className="paywall-overlay account-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-dialog-title"
      tabIndex={-1}
    >
      <section className="account-modal account-panel">
        <button className="account-close" type="button" onClick={onClose} aria-label="关闭">
          ×
        </button>
        <div className="profile-head">
          <div className="account-mark">{(user.displayName || user.email || user.phone || "赔").slice(0, 1)}</div>
          <div>
            <h2 id="account-dialog-title">{user.displayName || "赔了么用户"}</h2>
            <p>{user.email || user.phone}</p>
          </div>
        </div>

        <div className="account-panel-section">
          <strong>个人资料</strong>
          <div className="account-code-row">
            <input
              ref={displayNameRef}
              value={displayName}
              maxLength={80}
              placeholder="设置你的称呼"
              onChange={(event) => setDisplayName(event.target.value)}
            />
            <button type="button" disabled={busy || !displayName.trim()} onClick={() => void saveProfile()}>
              保存
            </button>
          </div>
        </div>

        <div className="account-panel-section">
          <strong>邀请码兑换</strong>
          <div className="account-code-row">
            <input
              value={invite}
              placeholder="输入邀请码"
              onChange={(event) => setInvite(event.target.value.toUpperCase())}
            />
            <button type="button" disabled={busy || invite.trim().length < 4} onClick={redeem}>
              兑换
            </button>
          </div>
          {message && <div className="account-message">{message}</div>}
        </div>

        <div className="account-panel-section">
          <strong>已解锁权益</strong>
          <div className="grant-list">
            {grants.length ? (
              grants.map((grant) => (
                <span key={grant.module}>✓ {moduleNames[grant.module]}</span>
              ))
            ) : (
              <p>当前没有已解锁的增值内容。</p>
            )}
          </div>
        </div>

        <div className="account-panel-section">
          <PolicyHistory
            refreshKey={historyRefreshKey}
            recalculating={policyRecalculating}
            onRecalculate={async (detail) => {
              const completed = onPolicyRecalculate
                ? await onPolicyRecalculate(detail)
                : false;
              if (completed) onClose();
              return completed;
            }}
          />
        </div>

        {capabilities.includes("admin.access") && (
          <a className="admin-entry-link" href="/admin" onClick={() => track("admin_opened")}>
            进入管理后台 →
          </a>
        )}
        <button
          className="ghost-button account-logout"
          type="button"
          onClick={() => void logout().finally(onClose).catch(() => undefined)}
        >
          退出登录
        </button>
      </section>
    </div>
  );
}
