import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth, type GrantModule } from "../auth/AuthContext";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { api, ApiError, downloadFromApi, track } from "../lib/api";
import {
  AiPanelLifecycleGuard,
  type AiPanelLifecycle
} from "./AiPanelLifecycle";

const documentReviewSku = "AI_DOCUMENT_REVIEW" as const;

type UploadItem = {
  id: string;
  original_name: string;
  size_bytes: string;
  status: string;
  created_at: string;
};

type AiJob = {
  id: string;
  kind: "document_review";
  status: "COMPLETED" | "FAILED_FINAL" | "QUEUED" | "RUNNING";
  failureCode: string | null;
  report: { summary: string } | null;
};

type AiAccountPanelProps = {
  open: boolean;
  onClose: () => void;
};

const moduleNames: Record<GrantModule, string> = {
  caseLawPack: "案例法条包",
  evidencePack: "离职证据包"
};

export default function AiAccountPanel({
  open,
  onClose
}: AiAccountPanelProps) {
  const { user, capabilities, grants, logout, redeemInvite, updateProfile } = useAuth();
  const [invite, setInvite] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [accountMessage, setAccountMessage] = useState("");
  const [uploadMessage, setUploadMessage] = useState("");
  const [documentObjective, setDocumentObjective] = useState(
    "签署前检查放弃权利、补偿金额、付款时间、保密和违约责任"
  );
  const [reviewingUploadId, setReviewingUploadId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const displayNameRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lifecycleGuardRef = useRef<AiPanelLifecycleGuard | null>(null);
  const lifecycleRef = useRef<AiPanelLifecycle | null>(null);
  if (!lifecycleGuardRef.current) {
    lifecycleGuardRef.current = new AiPanelLifecycleGuard();
  }

  useDialogFocus(open && Boolean(user), dialogRef, onClose, displayNameRef);

  const resetPrivateState = useCallback(() => {
    setInvite("");
    setDisplayName("");
    setUploads([]);
    setSelectedFiles([]);
    setAccountMessage("");
    setUploadMessage("");
    setDocumentObjective("签署前检查放弃权利、补偿金额、付款时间、保密和违约责任");
    setReviewingUploadId(null);
    setBusy(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const loadUploads = useCallback(async (
    lifecycle: AiPanelLifecycle
  ): Promise<boolean> => {
    const guard = lifecycleGuardRef.current!;
    const controller = guard.beginRequest("load", lifecycle);
    try {
      const savedUploads = await api<{ files: UploadItem[] }>(
        "/api/uploads/mine",
        { auth: true, signal: controller.signal }
      );
      if (guard.isCurrent(lifecycle) && !controller.signal.aborted) {
        setUploads(savedUploads.files);
        return true;
      }
    } catch {
      if (guard.isCurrent(lifecycle) && !controller.signal.aborted) {
        setUploadMessage("材料加载失败，请重试");
      }
    } finally {
      guard.finishRequest("load", controller);
    }
    return false;
  }, []);

  useEffect(() => {
    const guard = lifecycleGuardRef.current!;
    guard.deactivate();
    lifecycleRef.current = null;
    resetPrivateState();
    if (!open || !user) return undefined;
    const lifecycle = guard.activate(user.id);
    lifecycleRef.current = lifecycle;
    setDisplayName(user.displayName || "");
    void loadUploads(lifecycle);
    return () => {
      guard.deactivate();
      lifecycleRef.current = null;
      resetPrivateState();
    };
  }, [loadUploads, open, resetPrivateState, user?.id]);

  if (!open || !user) return null;

  const explainError = (error: unknown, fallback: string) =>
    error instanceof ApiError ? error.message : fallback;

  const saveProfile = async () => {
    if (!displayName.trim()) return;
    const lifecycle = lifecycleRef.current;
    const guard = lifecycleGuardRef.current!;
    if (!lifecycle || !guard.isCurrent(lifecycle)) {
      resetPrivateState();
      return;
    }
    const controller = guard.beginRequest("account", lifecycle);
    const nextDisplayName = displayName.trim();
    setBusy(true);
    setAccountMessage("");
    try {
      await updateProfile(nextDisplayName);
      if (guard.isCurrent(lifecycle) && !controller.signal.aborted) {
        setAccountMessage("称呼已更新");
      }
    } catch (error) {
      if (guard.isCurrent(lifecycle) && !controller.signal.aborted) {
        setAccountMessage(explainError(error, "更新失败，请稍后重试"));
      }
    } finally {
      guard.finishRequest("account", controller);
      if (guard.isCurrent(lifecycle)) setBusy(false);
    }
  };

  const redeem = async () => {
    const lifecycle = lifecycleRef.current;
    const guard = lifecycleGuardRef.current!;
    if (!lifecycle || !guard.isCurrent(lifecycle)) {
      resetPrivateState();
      return;
    }
    const controller = guard.beginRequest("account", lifecycle);
    const inviteCode = invite;
    setBusy(true);
    setAccountMessage("");
    try {
      const modules = await redeemInvite(inviteCode);
      if (guard.isCurrent(lifecycle) && !controller.signal.aborted) {
        setAccountMessage(
          `已解锁：${modules.map((item) => moduleNames[item]).join("、")}`
        );
        setInvite("");
      }
    } catch (error) {
      if (guard.isCurrent(lifecycle) && !controller.signal.aborted) {
        setAccountMessage(explainError(error, "兑换失败，请稍后重试"));
      }
    } finally {
      guard.finishRequest("account", controller);
      if (guard.isCurrent(lifecycle)) setBusy(false);
    }
  };

  const uploadFiles = async () => {
    if (!selectedFiles.length) {
      setUploadMessage("请先选择要保存的劳动文件");
      return;
    }
    const lifecycle = lifecycleRef.current;
    const guard = lifecycleGuardRef.current!;
    if (!lifecycle || !guard.isCurrent(lifecycle)) {
      resetPrivateState();
      return;
    }
    const formData = new FormData();
    selectedFiles.forEach((file) => formData.append("files", file));
    const selectedFileCount = selectedFiles.length;
    const controller = guard.beginRequest("upload", lifecycle);
    setBusy(true);
    setUploadMessage("");
    try {
      await api<{ files: UploadItem[] }>("/api/uploads", {
        method: "POST",
        auth: true,
        body: formData,
        signal: controller.signal
      });
      if (!guard.isCurrent(lifecycle) || controller.signal.aborted) return;
      setSelectedFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
      const refreshed = await loadUploads(lifecycle);
      if (!guard.isCurrent(lifecycle) || controller.signal.aborted) return;
      setUploadMessage(
        refreshed
          ? "材料已安全保存，可以从材料列表发起文件审查。"
          : "材料已保存，但列表刷新失败，请重试"
      );
      track("ai_document_uploaded", {
        sku: documentReviewSku,
        fileCount: selectedFileCount
      });
    } catch (error) {
      if (guard.isCurrent(lifecycle) && !controller.signal.aborted) {
        setUploadMessage(explainError(error, "上传失败，请检查文件后重试"));
      }
    } finally {
      guard.finishRequest("upload", controller);
      if (guard.isCurrent(lifecycle)) setBusy(false);
    }
  };

  const downloadUpload = async (item: UploadItem) => {
    const lifecycle = lifecycleRef.current;
    const guard = lifecycleGuardRef.current!;
    if (!lifecycle || !guard.isCurrent(lifecycle)) return;
    const controller = guard.beginRequest("download", lifecycle);
    try {
      await downloadFromApi(
        `/api/uploads/${item.id}/download`,
        item.original_name,
        controller.signal
      );
    } catch (error) {
      if (guard.isCurrent(lifecycle) && !controller.signal.aborted) {
        setUploadMessage(explainError(error, "下载失败"));
      }
    } finally {
      guard.finishRequest("download", controller);
    }
  };

  const reviewDocument = async (item: UploadItem) => {
    const lifecycle = lifecycleRef.current;
    const guard = lifecycleGuardRef.current!;
    if (!lifecycle || !guard.isCurrent(lifecycle)) return;
    const controller = guard.beginRequest("upload", lifecycle);
    setReviewingUploadId(item.id);
    setUploadMessage("");
    try {
      const job = await api<AiJob>("/api/ai/jobs", {
        method: "POST",
        auth: true,
        signal: controller.signal,
        body: {
          kind: "document_review",
          idempotencyKey: `document-${crypto.randomUUID()}`,
          input: { objective: documentObjective.trim() },
          uploadIds: [item.id]
        }
      });
      if (!guard.isCurrent(lifecycle) || controller.signal.aborted) return;
      setUploadMessage(
        job.report?.summary ||
          (job.failureCode === "AI_PROVIDER_NOT_CONFIGURED"
            ? "模型通道尚未配置，本次审查次数已退回"
            : "模型通道暂时不可用，本次审查次数已退回")
      );
      track("ai_document_review_completed", {
        jobId: job.id,
        status: job.status,
        failureCode: job.failureCode
      });
    } catch (error) {
      if (guard.isCurrent(lifecycle) && !controller.signal.aborted) {
        setUploadMessage(explainError(error, "文件审查提交失败"));
      }
    } finally {
      guard.finishRequest("upload", controller);
      if (guard.isCurrent(lifecycle)) setReviewingUploadId(null);
    }
  };

  return (
    <div
      ref={dialogRef}
      className="paywall-overlay account-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-account-dialog-title"
      tabIndex={-1}
    >
      <section className="account-modal account-panel ai-account-panel">
        <button className="account-close" type="button" onClick={onClose} aria-label="关闭">
          ×
        </button>
        <div className="profile-head">
          <div className="account-mark">
            {(user.displayName || user.email || user.phone || "赔").slice(0, 1)}
          </div>
          <div>
            <h2 id="ai-account-dialog-title">{user.displayName || "赔了么 AI 用户"}</h2>
            <p>{user.email || user.phone}</p>
          </div>
        </div>

        <div
          className="account-panel-section ai-review-entry"
          data-product-sku={documentReviewSku}
        >
          <div className="ai-review-heading">
            <div>
              <strong>劳动文件 AI 审查</strong>
              <span>上传后按次发起审查</span>
            </div>
            <small>{documentReviewSku}</small>
          </div>
          <p>保存解除协议、劳动合同或相关截图，再选择材料发起签署前风险审查。</p>
          <label className="upload-box" htmlFor="ai-document-upload-input">
            <span>
              {selectedFiles.length
                ? `已选择 ${selectedFiles.length} 个文件`
                : "选择 PDF 或图片"}
            </span>
            <input
              ref={fileInputRef}
              id="ai-document-upload-input"
              className="ai-document-upload-input"
              type="file"
              aria-label="上传劳动文件"
              name="files"
              accept=".pdf,.png,.jpg,.jpeg,.webp"
              multiple
              onChange={(event) =>
                setSelectedFiles(Array.from(event.target.files || []))
              }
            />
          </label>
          <button
            className="primary-button ai-upload-submit"
            type="button"
            disabled={busy || !selectedFiles.length}
            onClick={() => void uploadFiles()}
          >
            {busy ? "保存中…" : "上传并保存"}
          </button>
          {uploadMessage && (
            <div className="account-message" role="status" aria-live="polite">
              {uploadMessage}
            </div>
          )}
        </div>

        <div className="account-panel-section">
          <strong>已上传材料</strong>
          <label className="ai-document-objective">
            <span>审查重点</span>
            <input
              value={documentObjective}
              maxLength={2_000}
              onChange={(event) => setDocumentObjective(event.target.value)}
            />
          </label>
          <div className="history-list">
            {uploads.length ? (
              uploads.slice(0, 12).map((item) => (
                <article key={item.id} className="upload-history-item">
                  <div>
                    <b>{item.original_name}</b>
                    <span>
                      {Math.max(1, Math.round(Number(item.size_bytes) / 1024))} KB ·
                      {item.status === "stored" ? " 已安全保存" : ` ${item.status}`} ·
                      {new Date(item.created_at).toLocaleString("zh-CN")}
                    </span>
                  </div>
                  <div className="upload-history-actions">
                    <button
                      type="button"
                      disabled={Boolean(reviewingUploadId) || documentObjective.trim().length < 8}
                      onClick={() => void reviewDocument(item)}
                    >
                      {reviewingUploadId === item.id ? "审查中…" : "发起文件审查"}
                    </button>
                    <button type="button" onClick={() => void downloadUpload(item)}>
                      下载
                    </button>
                  </div>
                </article>
              ))
            ) : (
              <p>还没有已保存的劳动文件。</p>
            )}
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
            <button
              type="button"
              disabled={busy || !displayName.trim()}
              onClick={() => void saveProfile()}
            >
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
            <button
              type="button"
              disabled={busy || invite.trim().length < 4}
              onClick={() => void redeem()}
            >
              兑换
            </button>
          </div>
          {accountMessage && (
            <div className="account-message" role="status" aria-live="polite">
              {accountMessage}
            </div>
          )}
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

        {capabilities.includes("admin.access") && (
          <a className="admin-entry-link" href="/admin" onClick={() => track("admin_opened")}>
            进入 AI 管理后台 →
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
