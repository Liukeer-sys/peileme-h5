import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { dateTime, value } from "../adminShared";

type PolicyVersion = {
  id: string;
  version: number;
  status: "draft" | "published" | "retired";
  definition: Record<string, unknown>;
  sourceSnapshot: unknown[];
  effectiveFrom: string;
  effectiveTo: string | null;
  publishedAt: string | null;
  createdAt?: string;
  regressionStatus: "pending" | "passed" | "failed";
  regressionSummary: {
    total?: number;
    passed?: number;
    failed?: number;
  };
  regressionRunAt: string | null;
};

const policyToday = () => new Date().toISOString().slice(0, 10);
const policyVersionStatus = (status: PolicyVersion["status"]) =>
  ({ draft: "草稿", published: "已发布", retired: "已退役" })[status];
export default function PolicyRulesPanel({
  canWrite,
  canPublish,
  refreshKey
}: {
  canWrite: boolean;
  canPublish: boolean;
  refreshKey: number;
}) {
  const [versions, setVersions] = useState<PolicyVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [draftOpen, setDraftOpen] = useState(false);
  const [definitionText, setDefinitionText] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [rollbackTarget, setRollbackTarget] = useState("");
  const [rollbackDate, setRollbackDate] = useState("");

  const loadVersions = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api<{ items: PolicyVersion[] }>(
        "/api/admin/policy/rule-sets/cn-severance/versions",
        { auth: true }
      );
      setVersions(result.items);
      const template =
        result.items.find((item) => item.status === "published") ||
        result.items[0];
      if (template) {
        setDefinitionText((current) =>
          current || JSON.stringify(template.definition, null, 2)
        );
        setRollbackTarget((current) => current || String(template.version));
      }
    } catch (requestError) {
      setError(
        requestError instanceof ApiError
          ? requestError.message
          : "规则版本加载失败"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadVersions();
  }, [loadVersions, refreshKey]);

  const active = versions.find(
    (item) =>
      item.status === "published" &&
      item.effectiveFrom <= policyToday() &&
      (!item.effectiveTo || item.effectiveTo >= policyToday())
  );
  const comparison = active || versions.find((item) => item.status === "published");

  const createDraft = async () => {
    setError("");
    setMessage("");
    let definition: Record<string, unknown>;
    try {
      definition = JSON.parse(definitionText) as Record<string, unknown>;
    } catch {
      setError("规则定义 JSON 格式无效");
      return;
    }
    try {
      await api("/api/admin/policy/rule-sets/cn-severance/versions", {
        method: "POST",
        auth: true,
        body: {
          definition,
          sourceSnapshot: comparison?.sourceSnapshot || [],
          effectiveFrom
        }
      });
      setMessage("草稿已创建");
      setDraftOpen(false);
      await loadVersions();
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : "草稿创建失败"
      );
    }
  };

  const publishVersion = async (version: PolicyVersion) => {
    if (!window.confirm(`确认发布规则版本 v${version.version}？`)) return;
    setError("");
    setMessage("");
    try {
      await api(
        `/api/admin/policy/rule-sets/cn-severance/versions/${version.id}/publish`,
        { method: "POST", auth: true }
      );
      setMessage("版本已发布");
      await loadVersions();
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : "版本发布失败"
      );
    }
  };

  const rollback = async () => {
    if (!window.confirm(`确认从 v${rollbackTarget} 创建回滚版本？`)) return;
    setError("");
    setMessage("");
    try {
      await api("/api/admin/policy/rule-sets/cn-severance/rollback", {
        method: "POST",
        auth: true,
        body: {
          targetVersion: Number(rollbackTarget),
          effectiveFrom: rollbackDate
        }
      });
      setMessage("回滚版本已创建");
      await loadVersions();
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : "回滚创建失败"
      );
    }
  };

  return (
    <div className="admin-policy-stack">
      <section className="admin-card admin-policy-hero">
        <div>
          <span className="admin-eyebrow">CN · 劳动关系政策引擎</span>
          <h2>规则版本</h2>
          <p>
            {active
              ? `当前生效 v${active.version} · ${active.effectiveFrom} 起`
              : "当前日期没有生效版本"}
          </p>
        </div>
        <button
          type="button"
          disabled={!canWrite}
          onClick={() => setDraftOpen((open) => !open)}
        >
          新建规则草稿
        </button>
      </section>

      {message && <p className="admin-success" role="status">{message}</p>}
      {error && <p className="admin-error" role="alert">{error}</p>}

      {draftOpen && (
        <section className="admin-card admin-editor" aria-label="规则草稿编辑器">
          <div className="admin-section-title">
            <div><span>版本工作区</span><h2>新建规则草稿</h2></div>
            <button type="button" onClick={() => setDraftOpen(false)}>收起</button>
          </div>
          <label>
            <span>生效日期</span>
            <input
              aria-label="生效日期"
              type="date"
              value={effectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
            />
          </label>
          <label>
            <span>规则定义 JSON</span>
            <textarea
              aria-label="规则定义 JSON"
              value={definitionText}
              onChange={(event) => setDefinitionText(event.target.value)}
            />
          </label>
          <button
            className="admin-primary-action"
            type="button"
            disabled={!canWrite || loading || !effectiveFrom}
            onClick={() => void createDraft()}
          >
            保存草稿
          </button>
        </section>
      )}

      <section className="admin-version-grid" aria-label="规则版本清单">
        {versions.map((item) => {
          const sameAsCurrent =
            comparison &&
            JSON.stringify(comparison.definition) ===
              JSON.stringify(item.definition);
          return (
            <article
              className={`admin-version-card ${item.status}`}
              aria-label={`规则版本 v${item.version}`}
              key={item.id}
            >
              <header>
                <div>
                  <span>v{item.version}</span>
                  <strong>{policyVersionStatus(item.status)}</strong>
                </div>
                <time>{item.effectiveFrom}</time>
              </header>
              <dl>
                <div>
                  <dt>回归状态</dt>
                  <dd
                    className={
                      item.regressionStatus === "passed"
                        ? "pass"
                        : "warn"
                    }
                  >
                    {item.regressionStatus === "passed"
                      ? "服务端回归通过"
                      : item.regressionStatus === "failed"
                        ? "服务端回归失败"
                        : "等待服务端回归"}
                  </dd>
                </div>
                <div>
                  <dt>回归摘要</dt>
                  <dd>
                    固定案例 {item.regressionSummary.passed ?? 0}/
                    {item.regressionSummary.total ?? 0}
                    {item.regressionRunAt
                      ? ` · ${dateTime(item.regressionRunAt)}`
                      : ""}
                  </dd>
                </div>
                <div>
                  <dt>差异摘要</dt>
                  <dd>
                    {sameAsCurrent
                      ? "与当前版本一致"
                      : `与当前版本有差异 · schema v${value(item.definition.schemaVersion)}`}
                  </dd>
                </div>
                <div><dt>有效区间</dt><dd>{item.effectiveFrom} — {item.effectiveTo || "长期"}</dd></div>
              </dl>
              <button
                type="button"
                disabled={!canPublish || item.status !== "draft"}
                onClick={() => void publishVersion(item)}
              >
                发布版本
              </button>
            </article>
          );
        })}
      </section>

      <section className="admin-card admin-rollback" aria-label="版本回滚">
        <div>
          <span className="admin-eyebrow">安全回滚</span>
          <h2>从历史版本创建新版本</h2>
          <p>历史版本保持不可变，回滚会生成新的可审计版本。</p>
        </div>
        <label>
          <span>回滚目标版本</span>
          <select
            aria-label="回滚目标版本"
            value={rollbackTarget}
            onChange={(event) => setRollbackTarget(event.target.value)}
          >
            {versions
              .filter((item) => item.status !== "draft")
              .map((item) => (
                <option key={item.id} value={item.version}>v{item.version}</option>
              ))}
          </select>
        </label>
        <label>
          <span>回滚生效日期</span>
          <input
            aria-label="回滚生效日期"
            type="date"
            value={rollbackDate}
            onChange={(event) => setRollbackDate(event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={!canPublish || !rollbackTarget || !rollbackDate}
          onClick={() => void rollback()}
        >
          创建回滚版本
        </button>
      </section>
    </div>
  );
}
