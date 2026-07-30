import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { api, ApiError, downloadFromApi, track } from "../lib/api";

type AssessmentItem = {
  id: string;
  status: string;
  answers: { city?: string; terminationReason?: string };
  completed_at: string | null;
  created_at: string;
};

type UploadItem = {
  id: string;
  original_name: string;
  size_bytes: string;
  status: string;
  created_at: string;
};

type AccountPanelProps = {
  open: boolean;
  onClose: () => void;
};

const moduleNames: Record<string, string> = {
  caseLawPack: "案例法条包",
  evidencePack: "离职证据包"
};

export default function AccountPanel({ open, onClose }: AccountPanelProps) {
  const { user, grants, logout, redeemInvite, updateProfile } = useAuth();
  const [invite, setInvite] = useState("");
  const [message, setMessage] = useState("");
  const [history, setHistory] = useState<AssessmentItem[]>([]);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !user) return;
    setDisplayName(user.displayName || "");
    void Promise.all([
      api<{ items: AssessmentItem[] }>("/api/assessments/mine?pageSize=6", {
        auth: true
      }),
      api<{ files: UploadItem[] }>("/api/uploads/mine", { auth: true })
    ])
      .then(([assessments, savedUploads]) => {
        setHistory(assessments.items);
        setUploads(savedUploads.files);
      })
      .catch(() => {
        setHistory([]);
        setUploads([]);
      });
  }, [open, user]);

  if (!open || !user) return null;

  const redeem = async () => {
    setBusy(true);
    setMessage("");
    try {
      const modules = await redeemInvite(invite);
      setMessage(`已解锁：${modules.map((item) => moduleNames[item] || item).join("、")}`);
      setInvite("");
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : "兑换失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const saveProfile = async () => {
    if (!displayName.trim()) return;
    setBusy(true);
    setMessage("");
    try {
      await updateProfile(displayName.trim());
      setMessage("称呼已更新");
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : "更新失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="paywall-overlay account-overlay" role="dialog" aria-modal="true">
      <section className="account-modal account-panel">
        <button className="account-close" type="button" onClick={onClose} aria-label="关闭">
          ×
        </button>
        <div className="profile-head">
          <div className="account-mark">{(user.displayName || user.email || user.phone || "赔").slice(0, 1)}</div>
          <div>
            <h2>{user.displayName || "赔了么用户"}</h2>
            <p>{user.email || user.phone}</p>
          </div>
        </div>

        <div className="account-panel-section">
          <strong>个人资料</strong>
          <div className="account-code-row">
            <input
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
                <span key={grant.module}>✓ {moduleNames[grant.module] || grant.module}</span>
              ))
            ) : (
              <p>当前没有已解锁的增值内容。</p>
            )}
          </div>
        </div>

        <div className="account-panel-section">
          <strong>最近测算</strong>
          <div className="history-list">
            {history.length ? (
              history.map((item) => (
                <article key={item.id}>
                  <b>{item.answers.city || "未填写城市"} · {item.status === "completed" ? "已完成" : "进行中"}</b>
                  <span>{new Date(item.completed_at || item.created_at).toLocaleString("zh-CN")}</span>
                </article>
              ))
            ) : (
              <p>完成一次测算后，记录会出现在这里。</p>
            )}
          </div>
        </div>

        <div className="account-panel-section">
          <strong>已上传材料</strong>
          <div className="history-list">
            {uploads.length ? (
              uploads.slice(0, 6).map((item) => (
                <article key={item.id} className="upload-history-item">
                  <div>
                    <b>{item.original_name}</b>
                    <span>
                      {Math.max(1, Math.round(Number(item.size_bytes) / 1024))} KB ·
                      {item.status === "stored" ? " 已安全保存" : ` ${item.status}`} ·
                      {new Date(item.created_at).toLocaleString("zh-CN")}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      void downloadFromApi(
                        `/api/uploads/${item.id}/download`,
                        item.original_name
                      ).catch((error) =>
                        setMessage(error instanceof ApiError ? error.message : "下载失败")
                      )
                    }
                  >
                    下载
                  </button>
                </article>
              ))
            ) : (
              <p>上传 HR 协议或截图后，材料会显示在这里。</p>
            )}
          </div>
        </div>

        {["admin", "analyst"].includes(user.role) && (
          <a className="admin-entry-link" href="/admin" onClick={() => track("admin_opened")}>
            进入管理后台 →
          </a>
        )}
        <button
          className="ghost-button account-logout"
          type="button"
          onClick={() => void logout().then(onClose)}
        >
          退出登录
        </button>
      </section>
    </div>
  );
}
