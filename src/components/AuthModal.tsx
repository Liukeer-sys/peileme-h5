import { useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { ApiError, track } from "../lib/api";

type AuthModalProps = {
  open: boolean;
  initialMode?: "login" | "register" | "reset";
  description?: string;
  privacyNote?: string;
  onClose: () => void;
};

export default function AuthModal({
  open,
  initialMode = "login",
  description = "保存历史测算、兑换邀请码并管理账号。",
  privacyNote = "验证码仅用于身份验证。登录记录可在个人中心管理。",
  onClose
}: AuthModalProps) {
  const { login, register, resetPassword, sendCode } = useAuth();
  const [mode, setMode] = useState(initialMode);
  const [method, setMethod] = useState<"code" | "password">("code");
  const [target, setTarget] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const targetRef = useRef<HTMLInputElement | null>(null);

  useDialogFocus(open, dialogRef, onClose, targetRef);

  useEffect(() => setMode(initialMode), [initialMode, open]);
  useEffect(() => {
    if (!countdown) return;
    const timer = window.setInterval(
      () => setCountdown((current) => Math.max(0, current - 1)),
      1000
    );
    return () => window.clearInterval(timer);
  }, [countdown]);

  if (!open) return null;

  const explainError = (error: unknown) =>
    error instanceof ApiError ? error.message : "操作失败，请检查网络后重试";

  const handleSendCode = async () => {
    if (!target.trim()) {
      setMessage("请输入邮箱或中国大陆手机号");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const result = await sendCode(
        target,
        mode === "register" ? "register" : mode === "reset" ? "reset_password" : "login"
      );
      setCountdown(60);
      setMessage(
        result.debugCode
          ? `开发验证码：${result.debugCode}`
          : "验证码已发送，请留意短信或邮件"
      );
      track("otp_requested", {
        purpose: mode,
        channel: target.includes("@") ? "email" : "sms"
      });
    } catch (error) {
      setMessage(explainError(error));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setMessage("");
    try {
      if (mode === "register") {
        await register({
          target,
          code,
          password: password || undefined,
          displayName: displayName || undefined,
          inviteCode: inviteCode || undefined
        });
      } else if (mode === "reset") {
        await resetPassword(target, code, password);
        setMode("login");
        setMethod("password");
        setCode("");
        setMessage("密码已重置，请使用新密码登录");
        return;
      } else {
        await login(
          target,
          method === "code" ? { code } : { password }
        );
      }
      onClose();
    } catch (error) {
      setMessage(explainError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={dialogRef}
      className="paywall-overlay account-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-dialog-title"
      tabIndex={-1}
    >
      <section className="account-modal">
        <button className="account-close" type="button" onClick={onClose} aria-label="关闭">
          ×
        </button>
        <div className="account-mark">赔</div>
        <h2 id="auth-dialog-title">{mode === "register" ? "建立你的赔了么档案" : mode === "reset" ? "重置登录密码" : "登录赔了么"}</h2>
        <p>{mode === "reset" ? "验证邮箱或手机号后设置新密码。" : description}</p>

        {mode === "login" && (
          <div className="account-tabs">
            <button
              className={method === "code" ? "active" : ""}
              type="button"
              onClick={() => setMethod("code")}
            >
              验证码登录
            </button>
            <button
              className={method === "password" ? "active" : ""}
              type="button"
              onClick={() => setMethod("password")}
            >
              密码登录
            </button>
          </div>
        )}

        <label className="account-field">
          <span>邮箱 / 手机号</span>
          <input
            ref={targetRef}
            value={target}
            autoComplete="username"
            placeholder="name@example.com 或 13800138000"
            onChange={(event) => setTarget(event.target.value)}
          />
        </label>

        {(mode === "register" || mode === "reset" || method === "code") && (
          <label className="account-field">
            <span>验证码</span>
            <div className="account-code-row">
              <input
                value={code}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="6 位验证码"
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
              />
              <button
                type="button"
                disabled={busy || countdown > 0}
                onClick={handleSendCode}
              >
                {countdown ? `${countdown}s` : "获取验证码"}
              </button>
            </div>
          </label>
        )}

        {(mode === "register" || mode === "reset" || method === "password") && (
          <label className="account-field">
            <span>{mode === "register" ? "设置密码（可选）" : mode === "reset" ? "设置新密码" : "密码"}</span>
            <input
              value={password}
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              placeholder={mode === "login" ? "输入登录密码" : "至少 8 位，包含字母和数字"}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
        )}

        {mode === "register" && (
          <>
            <label className="account-field">
              <span>称呼（可选）</span>
              <input
                value={displayName}
                placeholder="怎么称呼你"
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>
            <label className="account-field">
              <span>邀请码（可选）</span>
              <input
                value={inviteCode}
                placeholder="有邀请码可直接解锁完整内容"
                onChange={(event) => setInviteCode(event.target.value.toUpperCase())}
              />
            </label>
          </>
        )}

        {message && <div className="account-message">{message}</div>}
        <button className="primary-button account-submit" type="button" disabled={busy} onClick={submit}>
          {busy ? "处理中…" : mode === "register" ? "注册并登录" : mode === "reset" ? "确认重置" : "登录"}
        </button>
        <div className="account-switch-row">
          <button
            className="account-switch"
            type="button"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setMessage("");
            }}
          >
            {mode === "login" ? "第一次来？注册账号" : "返回账号登录"}
          </button>
          {mode === "login" && (
            <button className="account-switch" type="button" onClick={() => setMode("reset")}>
              忘记密码
            </button>
          )}
        </div>
        <small>{privacyNote}</small>
      </section>
    </div>
  );
}
