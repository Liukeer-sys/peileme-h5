import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import AuthModal from "../components/AuthModal";
import { api, ApiError, downloadFromApi } from "../lib/api";

type Tab =
  | "overview"
  | "policyRules"
  | "regionalData"
  | "announcements"
  | "users"
  | "assessments"
  | "uploads"
  | "invites"
  | "events"
  | "audit"
  | "system";
type UnknownRow = Record<string, unknown>;

const navItems: Array<{ id: Tab; label: string; icon: string }> = [
  { id: "overview", label: "经营概览", icon: "⌁" },
  { id: "policyRules", label: "政策规则", icon: "规" },
  { id: "regionalData", label: "区域参数", icon: "域" },
  { id: "announcements", label: "公告设置", icon: "告" },
  { id: "users", label: "用户管理", icon: "人" },
  { id: "assessments", label: "测算记录", icon: "算" },
  { id: "uploads", label: "材料管理", icon: "件" },
  { id: "invites", label: "邀请码", icon: "码" },
  { id: "events", label: "埋点统计", icon: "数" },
  { id: "audit", label: "审计日志", icon: "审" },
  { id: "system", label: "系统状态", icon: "稳" }
];

const value = (input: unknown) => String(input ?? "—");
const dateTime = (input: unknown) =>
  input ? new Date(String(input)).toLocaleString("zh-CN") : "—";

function DataTable({
  rows,
  columns
}: {
  rows: UnknownRow[];
  columns: Array<{ key: string; label: string; render?: (row: UnknownRow) => React.ReactNode }>;
}) {
  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>{columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((row, index) => (
              <tr key={String(row.id || row.event_name || index)}>
                {columns.map((column) => (
                  <td key={column.key}>{column.render ? column.render(row) : value(row[column.key])}</td>
                ))}
              </tr>
            ))
          ) : (
            <tr><td colSpan={columns.length}>暂无数据</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

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
};

const policyToday = () => new Date().toISOString().slice(0, 10);
const policyVersionStatus = (status: PolicyVersion["status"]) =>
  ({ draft: "草稿", published: "已发布", retired: "已退役" })[status];
const policyDefinitionRegression = (definition: Record<string, unknown>) =>
  definition.schemaVersion === 2 &&
  Boolean(definition.decisionModel) &&
  Boolean(definition.serviceYearFraction) &&
  Boolean(definition.highSalaryCap);

function PolicyRulesPanel({
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
                  <dd className={policyDefinitionRegression(item.definition) ? "pass" : "warn"}>
                    {policyDefinitionRegression(item.definition)
                      ? "回归校验通过"
                      : "规则结构需检查"}
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
              {item.status === "draft" && (
                <button
                  type="button"
                  disabled={!canPublish}
                  onClick={() => void publishVersion(item)}
                >
                  发布版本
                </button>
              )}
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

type AdminRegion = {
  code: string;
  name: string;
  level: "province" | "prefecture";
  parentCode: string | null;
};
type RegionalParameter = {
  id: string;
  regionCode: string;
  regionName: string;
  provinceCode: string;
  provinceName: string;
  year: number;
  parameterType: "minimum_monthly_wage" | "employee_average_monthly_wage";
  amountFen: number;
  sourceName: string;
  sourceUrl: string;
  sourcePublishedAt: string;
  status: "draft" | "verified" | "stale";
};

const parameterLabel = (type: RegionalParameter["parameterType"]) =>
  type === "minimum_monthly_wage" ? "最低月工资" : "职工月平均工资";
const parameterStatus = (status: RegionalParameter["status"]) =>
  ({ draft: "草稿", verified: "已核验", stale: "已过期" })[status];

function RegionalDataPanel({
  canWrite,
  canPublish,
  refreshKey
}: {
  canWrite: boolean;
  canPublish: boolean;
  refreshKey: number;
}) {
  const [regions, setRegions] = useState<AdminRegion[]>([]);
  const [items, setItems] = useState<RegionalParameter[]>([]);
  const [province, setProvince] = useState("");
  const [city, setCity] = useState("");
  const [year, setYear] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [editing, setEditing] = useState<RegionalParameter | null>(null);
  const [amountYuan, setAmountYuan] = useState("");
  const [editStatus, setEditStatus] =
    useState<RegionalParameter["status"]>("draft");
  const [sourceName, setSourceName] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceDate, setSourceDate] = useState("");
  const [csv, setCsv] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const loadParameters = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const search = new URLSearchParams({ pageSize: "100" });
      if (province) search.set("provinceCode", province);
      if (city) search.set("cityCode", city);
      if (year) search.set("year", year);
      if (type) search.set("parameterType", type);
      if (status) search.set("status", status);
      const response = await api<{ items: RegionalParameter[] }>(
        `/api/admin/policy/regional-parameters?${search.toString()}`,
        { auth: true }
      );
      setItems(response.items);
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : "参数加载失败"
      );
    } finally {
      setLoading(false);
    }
  }, [city, province, status, type, year]);

  useEffect(() => {
    void api<{ items: AdminRegion[] }>("/api/policy/regions")
      .then((response) => setRegions(response.items))
      .catch(() => setError("行政区划加载失败"));
  }, []);

  useEffect(() => {
    void loadParameters();
  }, [loadParameters, refreshKey]);

  const startEdit = (item: RegionalParameter) => {
    setEditing(item);
    setAmountYuan(String(item.amountFen / 100));
    setEditStatus(item.status);
    setSourceName(item.sourceName);
    setSourceUrl(item.sourceUrl);
    setSourceDate(item.sourcePublishedAt);
    setMessage("");
    setError("");
  };

  const saveParameter = async () => {
    if (!editing) return;
    setError("");
    setMessage("");
    try {
      const updated = await api<RegionalParameter>(
        "/api/admin/policy/regional-parameters",
        {
          method: "PUT",
          auth: true,
          body: {
            regionCode: editing.regionCode,
            year: editing.year,
            parameterType: editing.parameterType,
            amountFen: Math.round(Number(amountYuan) * 100),
            sourceName,
            sourceUrl,
            sourcePublishedAt: sourceDate,
            status: editStatus
          }
        }
      );
      setItems((current) =>
        current.map((item) =>
          item.id === updated.id
            ? { ...item, ...updated, provinceCode: item.provinceCode, provinceName: item.provinceName }
            : item
        )
      );
      setEditing({ ...editing, ...updated });
      setMessage("参数已保存");
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : "参数保存失败"
      );
    }
  };

  const importCsv = async () => {
    setError("");
    setMessage("");
    try {
      const result = await api<{ imported: number }>(
        "/api/admin/policy/regional-parameters/import",
        { method: "POST", auth: true, body: { csv } }
      );
      setMessage(`已导入 ${result.imported} 条参数`);
      await loadParameters();
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : "CSV 导入失败"
      );
    }
  };

  const provinces = regions.filter((region) => region.level === "province");
  const cities = regions.filter(
    (region) => region.level === "prefecture" && (!province || region.parentCode === province)
  );
  const canEditStatus = editStatus === "draft" ? canWrite : canPublish;

  return (
    <div className="admin-policy-stack">
      {message && <p className="admin-success" role="status">{message}</p>}
      {error && <p className="admin-error" role="alert">{error}</p>}

      <section className="admin-card admin-filter-bar" aria-label="区域参数筛选">
        <div className="admin-section-title">
          <div><span>区域数据仓</span><h2>参数筛选</h2></div>
          <small>{items.length} 条当前结果</small>
        </div>
        <label><span>省份</span>
          <select
            aria-label="省份"
            value={province}
            onChange={(event) => {
              setProvince(event.target.value);
              setCity("");
            }}
          >
            <option value="">全部省份</option>
            {provinces.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
          </select>
        </label>
        <label><span>城市</span>
          <select aria-label="城市" value={city} onChange={(event) => setCity(event.target.value)}>
            <option value="">全部城市</option>
            {cities.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
          </select>
        </label>
        <label><span>年份</span><input aria-label="年份" type="number" min="2000" max="2100" value={year} onChange={(event) => setYear(event.target.value)} /></label>
        <label><span>参数类型</span>
          <select aria-label="参数类型" value={type} onChange={(event) => setType(event.target.value)}>
            <option value="">全部类型</option>
            <option value="minimum_monthly_wage">最低月工资</option>
            <option value="employee_average_monthly_wage">职工月平均工资</option>
          </select>
        </label>
        <label><span>审核状态</span>
          <select aria-label="审核状态" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">全部状态</option>
            <option value="draft">草稿</option>
            <option value="verified">已核验</option>
            <option value="stale">已过期</option>
          </select>
        </label>
        <button type="button" disabled={loading} onClick={() => void loadParameters()}>应用筛选</button>
      </section>

      <section className="admin-card">
        <div className="admin-section-title">
          <div><span>严格字段 · 原子写入</span><h2>CSV 批量导入</h2></div>
          <a href="/database/seeds/regional-parameters.csv">查看字段模板</a>
        </div>
        <div className="admin-csv-row">
          <label>
            <span>区域参数 CSV 文件</span>
            <input
              aria-label="区域参数 CSV 文件"
              type="file"
              accept=".csv,text/csv"
              disabled={!canPublish}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void file.text().then(setCsv);
              }}
            />
          </label>
          <button type="button" disabled={!canPublish || !csv} onClick={() => void importCsv()}>
            导入 CSV
          </button>
        </div>
      </section>

      {editing && (
        <section className="admin-card admin-editor admin-parameter-editor" aria-label="编辑区域参数">
          <div className="admin-section-title">
            <div><span>{editing.regionCode}</span><h2>编辑区域参数 · {editing.regionName}</h2></div>
            <button type="button" onClick={() => setEditing(null)}>关闭</button>
          </div>
          <label><span>参数金额（元）</span><input aria-label="参数金额（元）" type="number" min="0.01" step="0.01" value={amountYuan} onChange={(event) => setAmountYuan(event.target.value)} /></label>
          <label><span>参数状态</span>
            <select aria-label="参数状态" value={editStatus} onChange={(event) => setEditStatus(event.target.value as RegionalParameter["status"])}>
              <option value="draft">草稿</option>
              <option value="verified">已核验</option>
              <option value="stale">已过期</option>
            </select>
          </label>
          <label><span>来源名称</span><input aria-label="来源名称" value={sourceName} onChange={(event) => setSourceName(event.target.value)} /></label>
          <label><span>来源地址</span><input aria-label="来源地址" type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} /></label>
          <label><span>来源发布日期</span><input aria-label="来源发布日期" type="date" value={sourceDate} onChange={(event) => setSourceDate(event.target.value)} /></label>
          <button className="admin-primary-action" type="button" disabled={!canEditStatus} onClick={() => void saveParameter()}>保存参数</button>
        </section>
      )}

      <section className="admin-card">
        <h2>区域参数清单</h2>
        <DataTable
          rows={items as unknown as UnknownRow[]}
          columns={[
            { key: "regionName", label: "地区", render: (row) => <><b>{value(row.regionName)}</b><br /><small>{value(row.regionCode)}</small></> },
            { key: "year", label: "年份" },
            { key: "parameterType", label: "参数类型", render: (row) => parameterLabel(row.parameterType as RegionalParameter["parameterType"]) },
            { key: "amountFen", label: "金额", render: (row) => `¥${(Number(row.amountFen) / 100).toLocaleString("zh-CN")}` },
            { key: "status", label: "状态", render: (row) => <span className={`admin-status ${value(row.status)}`}>{parameterStatus(row.status as RegionalParameter["status"])}</span> },
            { key: "sourceName", label: "官方来源", render: (row) => <a href={value(row.sourceUrl)} target="_blank" rel="noreferrer">{value(row.sourceName)}</a> },
            { key: "actions", label: "操作", render: (row) => {
              const item = row as unknown as RegionalParameter;
              return <button type="button" disabled={!canWrite && !canPublish} aria-label={`编辑 ${item.regionName} ${item.year} ${parameterLabel(item.parameterType)}`} onClick={() => startEdit(item)}>编辑</button>;
            } }
          ]}
        />
      </section>
    </div>
  );
}

type Announcement = {
  id: string;
  title: string;
  body: string;
  placement: "main" | "ai" | "all";
  status: "draft" | "published" | "archived";
  startsAt: string | null;
  endsAt: string | null;
  updatedAt: string;
};
const announcementStatus = (status: Announcement["status"]) =>
  ({ draft: "草稿", published: "已发布", archived: "已归档" })[status];

function AnnouncementsPanel({
  canWrite,
  canPublish,
  refreshKey
}: {
  canWrite: boolean;
  canPublish: boolean;
  refreshKey: number;
}) {
  const empty = {
    title: "",
    body: "",
    placement: "main" as Announcement["placement"],
    status: "draft" as Announcement["status"],
    startsAt: "",
    endsAt: ""
  };
  const [items, setItems] = useState<Announcement[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(empty);
  const [editorOpen, setEditorOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const loadAnnouncements = useCallback(async () => {
    try {
      const result = await api<{ items: Announcement[] }>(
        "/api/admin/policy/announcements",
        { auth: true }
      );
      setItems(result.items);
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : "公告加载失败"
      );
    }
  }, []);

  useEffect(() => {
    void loadAnnouncements();
  }, [loadAnnouncements, refreshKey]);

  const startNew = () => {
    setEditingId(null);
    setForm(empty);
    setEditorOpen(true);
    setError("");
    setMessage("");
  };
  const startEdit = (item: Announcement) => {
    setEditingId(item.id);
    setForm({
      title: item.title,
      body: item.body,
      placement: item.placement,
      status: item.status,
      startsAt: item.startsAt ? item.startsAt.slice(0, 16) : "",
      endsAt: item.endsAt ? item.endsAt.slice(0, 16) : ""
    });
    setEditorOpen(true);
    setError("");
    setMessage("");
  };
  const saveAnnouncement = async () => {
    if (!form.title.trim() || !form.body.trim()) {
      setError("请填写公告标题和正文");
      return;
    }
    setError("");
    setMessage("");
    try {
      const body = {
        title: form.title,
        body: form.body,
        placement: form.placement,
        status: form.status,
        startsAt: form.startsAt ? new Date(form.startsAt).toISOString() : null,
        endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null
      };
      if (editingId) {
        await api(`/api/admin/policy/announcements/${editingId}`, {
          method: "PATCH",
          auth: true,
          body
        });
        setMessage("公告已更新");
      } else {
        const created = await api<Announcement>(
          "/api/admin/policy/announcements",
          { method: "POST", auth: true, body }
        );
        setEditingId(created.id);
        setMessage("公告已创建");
      }
      await loadAnnouncements();
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : "公告保存失败"
      );
    }
  };
  const deleteDraft = async (item: Announcement) => {
    if (!window.confirm(`确认删除公告草稿“${item.title}”？`)) return;
    try {
      await api(`/api/admin/policy/announcements/${item.id}`, {
        method: "DELETE",
        auth: true
      });
      setMessage("公告草稿已删除");
      setEditorOpen(false);
      await loadAnnouncements();
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : "公告删除失败"
      );
    }
  };
  const canSave = form.status === "draft" ? canWrite : canPublish;

  return (
    <div className="admin-policy-stack">
      <section className="admin-card admin-policy-hero">
        <div>
          <span className="admin-eyebrow">站内触达</span>
          <h2>公告编排</h2>
          <p>按主站、AI 站或全站配置展示周期与发布状态。</p>
        </div>
        <button type="button" disabled={!canWrite} onClick={startNew}>新建公告</button>
      </section>
      {message && <p className="admin-success" role="status">{message}</p>}
      {error && <p className="admin-error" role="alert">{error}</p>}

      {editorOpen && (
        <section className="admin-card admin-editor announcement-editor" aria-label="公告编辑器">
          <div className="admin-section-title">
            <div><span>内容工作区</span><h2>{editingId ? "编辑公告" : "新建公告"}</h2></div>
            <button type="button" onClick={() => setEditorOpen(false)}>关闭</button>
          </div>
          <label><span>公告标题</span><input aria-label="公告标题" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
          <label className="wide"><span>公告正文</span><textarea aria-label="公告正文" value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} /></label>
          <label><span>投放位置</span>
            <select aria-label="投放位置" value={form.placement} onChange={(event) => setForm({ ...form, placement: event.target.value as Announcement["placement"] })}>
              <option value="main">政策主站</option><option value="ai">AI 分析站</option><option value="all">全站</option>
            </select>
          </label>
          <label><span>公告状态</span>
            <select aria-label="公告状态" value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as Announcement["status"] })}>
              <option value="draft">草稿</option><option value="published">已发布</option><option value="archived">已归档</option>
            </select>
          </label>
          <label><span>开始时间</span><input aria-label="开始时间" type="datetime-local" value={form.startsAt} onChange={(event) => setForm({ ...form, startsAt: event.target.value })} /></label>
          <label><span>结束时间</span><input aria-label="结束时间" type="datetime-local" value={form.endsAt} onChange={(event) => setForm({ ...form, endsAt: event.target.value })} /></label>
          <button className="admin-primary-action" type="button" disabled={!canSave} onClick={() => void saveAnnouncement()}>保存公告</button>
        </section>
      )}

      <section className="admin-announcement-grid" aria-label="公告清单">
        {items.map((item) => (
          <article key={item.id} aria-label={`公告 ${item.title}`} className="admin-announcement-card">
            <header>
              <span className={`admin-status ${item.status}`}>{announcementStatus(item.status)}</span>
              <small>{item.placement === "main" ? "政策主站" : item.placement === "ai" ? "AI 分析站" : "全站"}</small>
            </header>
            <h2>{item.title}</h2>
            <p>{item.body}</p>
            <time>更新于 {dateTime(item.updatedAt)}</time>
            <footer>
              <button type="button" disabled={!canWrite && !canPublish} onClick={() => startEdit(item)}>编辑公告</button>
              {item.status === "draft" && (
                <button type="button" disabled={!canWrite} onClick={() => void deleteDraft(item)}>删除草稿</button>
              )}
            </footer>
          </article>
        ))}
      </section>
    </div>
  );
}

export default function AdminDashboard() {
  const { user, capabilities, ready, logout } = useAuth();
  const [tab, setTab] = useState<Tab>("overview");
  const [data, setData] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [authOpen, setAuthOpen] = useState(false);
  const [inviteDescription, setInviteDescription] = useState("");
  const [inviteUses, setInviteUses] = useState("1");
  const [policyRefreshKey, setPolicyRefreshKey] = useState(0);

  const isAdmin = Boolean(user && ["admin", "analyst"].includes(user.role));
  const endpoint = useMemo(
    () =>
      ({
        overview: "/api/admin/overview?days=30",
        policyRules: "",
        regionalData: "",
        announcements: "",
        users: "/api/admin/users?pageSize=100",
        assessments: "/api/admin/assessments?pageSize=100",
        uploads: "/api/admin/uploads?pageSize=100",
        invites: "/api/admin/invites",
        events: "/api/admin/events?days=30",
        audit: "/api/admin/audit-logs?pageSize=100",
        system: "/api/admin/system"
      })[tab],
    [tab]
  );

  const load = useCallback(async () => {
    if (!isAdmin || !endpoint) return;
    setLoading(true);
    setError("");
    try {
      setData(await api<Record<string, unknown>>(endpoint, { auth: true }));
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [endpoint, isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!ready) {
    return <main className="admin-login-state">正在确认管理会话…</main>;
  }

  if (!isAdmin) {
    return (
      <main className="admin-login-state">
        <div className="account-mark">赔</div>
        <h1>赔了么管理后台</h1>
        <p>{user ? "当前账号没有管理权限。" : "请使用管理员账号登录。"}</p>
        {!user && <button className="primary-button" type="button" onClick={() => setAuthOpen(true)}>管理员登录</button>}
        <a href="/">返回用户端</a>
        <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} />
      </main>
    );
  }

  const adminUser = user!;
  const canWritePolicy = capabilities.includes("policy.write");
  const canPublishPolicy = capabilities.includes("policy.publish");
  const rows = ((data.items || data.recentAssessments || []) as UnknownRow[]);
  const overview = (data.summary || {}) as UnknownRow;
  const createInvite = async () => {
    setLoading(true);
    setError("");
    try {
      await api("/api/admin/invites", {
        method: "POST",
        auth: true,
        body: {
          description: inviteDescription || undefined,
          maxUses: Number(inviteUses) || 1,
          grants: ["caseLawPack", "evidencePack"]
        }
      });
      setInviteDescription("");
      setInviteUses("1");
      await load();
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : "创建失败");
    } finally {
      setLoading(false);
    }
  };

  const updateUser = async (id: unknown, patch: Record<string, unknown>) => {
    await api(`/api/admin/users/${id}`, { method: "PATCH", auth: true, body: patch });
    await load();
  };

  const toggleInvite = async (row: UnknownRow) => {
    await api(`/api/admin/invites/${row.id}`, {
      method: "PATCH",
      auth: true,
      body: { enabled: !row.enabled }
    });
    await load();
  };

  return (
    <main className="admin-shell">
      <aside className="admin-sidebar">
        <a className="admin-brand" href="/">
          <span>赔</span>
          <div><strong>赔了么</strong><small>运营管理台</small></div>
        </a>
        <nav>
          {navItems.map((item) => (
            <button
              key={item.id}
              className={tab === item.id ? "active" : ""}
              type="button"
              onClick={() => setTab(item.id)}
            >
              <i>{item.icon}</i>{item.label}
            </button>
          ))}
        </nav>
        <div className="admin-profile">
          <strong>{adminUser.displayName || adminUser.email || adminUser.phone}</strong>
          <span>{adminUser.role === "admin" ? "超级管理员" : "数据分析员"}</span>
          <button type="button" onClick={() => void logout().then(() => window.location.assign("/"))}>退出</button>
        </div>
      </aside>

      <section className="admin-content">
        <header className="admin-header">
          <div>
            <span>生产环境 · 数据实时更新</span>
            <h1>{navItems.find((item) => item.id === tab)?.label}</h1>
          </div>
          <button
            type="button"
            disabled={loading}
            onClick={() => {
              if (["policyRules", "regionalData", "announcements"].includes(tab)) {
                setPolicyRefreshKey((key) => key + 1);
                return;
              }
              void load();
            }}
          >
            {loading ? "刷新中…" : "刷新数据"}
          </button>
        </header>

        {error && <div className="admin-error">{error}</div>}

        {tab === "policyRules" && (
          <PolicyRulesPanel
            canWrite={canWritePolicy}
            canPublish={canPublishPolicy}
            refreshKey={policyRefreshKey}
          />
        )}

        {tab === "regionalData" && (
          <RegionalDataPanel
            canWrite={canWritePolicy}
            canPublish={canPublishPolicy}
            refreshKey={policyRefreshKey}
          />
        )}

        {tab === "announcements" && (
          <AnnouncementsPanel
            canWrite={canWritePolicy}
            canPublish={canPublishPolicy}
            refreshKey={policyRefreshKey}
          />
        )}

        {tab === "overview" && (
          <>
            <div className="admin-metrics">
              {([
                ["独立访客", overview.visitors, "近 30 天"],
                ["访问会话", overview.sessions, "近 30 天"],
                ["完成测算", overview.completed_assessments, "结果已入库"],
                ["新增用户", overview.registered_users, "账号已验证"],
                ["上传材料", overview.uploaded_files, "私有存储"]
              ] as Array<[string, unknown, string]>).map(([label, metric, note]) => (
                <article key={String(label)}>
                  <span>{label}</span><strong>{value(metric)}</strong><small>{note}</small>
                </article>
              ))}
            </div>
            <section className="admin-card">
              <h2>转化漏斗</h2>
              <DataTable
                rows={(data.funnel || []) as UnknownRow[]}
                columns={[
                  { key: "event_name", label: "关键事件" },
                  { key: "count", label: "触发次数" },
                  { key: "users", label: "独立用户" }
                ]}
              />
            </section>
            <section className="admin-card">
              <h2>最近测算</h2>
              <DataTable
                rows={(data.recentAssessments || []) as UnknownRow[]}
                columns={[
                  { key: "status", label: "状态" },
                  { key: "city", label: "城市" },
                  { key: "termination_reason", label: "离职原因" },
                  { key: "created_at", label: "开始时间", render: (row) => dateTime(row.created_at) },
                  { key: "completed_at", label: "完成时间", render: (row) => dateTime(row.completed_at) }
                ]}
              />
            </section>
          </>
        )}

        {tab === "users" && (
          <section className="admin-card">
            <h2>用户清单 <small>共 {value((data.pagination as UnknownRow | undefined)?.total)} 人</small></h2>
            <DataTable
              rows={rows}
              columns={[
                { key: "display_name", label: "用户", render: (row) => <><b>{value(row.display_name)}</b><br /><small>{value(row.email || row.phone)}</small></> },
                { key: "role", label: "角色" },
                { key: "status", label: "状态" },
                { key: "assessment_count", label: "测算数" },
                { key: "created_at", label: "注册时间", render: (row) => dateTime(row.created_at) },
                {
                  key: "actions",
                  label: "操作",
                  render: (row) => (
                    <div className="admin-row-actions">
                      <button type="button" onClick={() => void updateUser(row.id, { status: row.status === "active" ? "disabled" : "active" })}>
                        {row.status === "active" ? "停用" : "启用"}
                      </button>
                      {adminUser.role === "admin" && row.role !== "admin" && (
                        <button type="button" onClick={() => void updateUser(row.id, { role: row.role === "analyst" ? "user" : "analyst" })}>
                          {row.role === "analyst" ? "降为用户" : "设为分析员"}
                        </button>
                      )}
                    </div>
                  )
                }
              ]}
            />
          </section>
        )}

        {tab === "assessments" && (
          <section className="admin-card">
            <h2>测算记录 <small>共 {value((data.pagination as UnknownRow | undefined)?.total)} 条</small></h2>
            <DataTable
              rows={rows}
              columns={[
                { key: "status", label: "状态" },
                { key: "identity", label: "用户", render: (row) => value(row.display_name || row.email || row.phone || row.visitor_id) },
                { key: "city", label: "城市", render: (row) => value((row.answers as UnknownRow | undefined)?.city) },
                { key: "reason", label: "离职原因", render: (row) => value((row.answers as UnknownRow | undefined)?.terminationReason) },
                { key: "current_step", label: "停留步骤" },
                { key: "created_at", label: "时间", render: (row) => dateTime(row.created_at) }
              ]}
            />
          </section>
        )}

        {tab === "uploads" && (
          <section className="admin-card">
            <h2>用户材料 <small>共 {value((data.pagination as UnknownRow | undefined)?.total)} 份</small></h2>
            <DataTable
              rows={rows}
              columns={[
                { key: "original_name", label: "文件名" },
                { key: "identity", label: "用户", render: (row) => value(row.display_name || row.email || row.phone) },
                { key: "city", label: "测算城市" },
                { key: "mime_type", label: "类型" },
                {
                  key: "size_bytes",
                  label: "大小",
                  render: (row) => `${Math.max(1, Math.round(Number(row.size_bytes || 0) / 1024))} KB`
                },
                { key: "status", label: "处理状态" },
                { key: "created_at", label: "上传时间", render: (row) => dateTime(row.created_at) },
                {
                  key: "actions",
                  label: "操作",
                  render: (row) =>
                    adminUser.role === "admin" ? (
                      <button
                        type="button"
                        onClick={() =>
                          void downloadFromApi(
                            `/api/admin/uploads/${row.id}/download`,
                            value(row.original_name)
                          ).catch((requestError) =>
                            setError(requestError instanceof ApiError ? requestError.message : "下载失败")
                          )
                        }
                      >
                        下载
                      </button>
                    ) : "只读"
                }
              ]}
            />
          </section>
        )}

        {tab === "invites" && (
          <>
            {adminUser.role === "admin" && (
              <section className="admin-card admin-invite-form">
                <h2>生成邀请码</h2>
                <input value={inviteDescription} placeholder="用途备注，例如：首批内测用户" onChange={(event) => setInviteDescription(event.target.value)} />
                <input value={inviteUses} type="number" min="1" max="100000" placeholder="可用次数" onChange={(event) => setInviteUses(event.target.value)} />
                <button type="button" disabled={loading} onClick={() => void createInvite()}>生成全功能邀请码</button>
              </section>
            )}
            <section className="admin-card">
              <h2>邀请码清单</h2>
              <DataTable
                rows={rows}
                columns={[
                  { key: "code", label: "邀请码", render: (row) => <code>{value(row.code)}</code> },
                  { key: "description", label: "用途" },
                  { key: "usage", label: "使用情况", render: (row) => `${value(row.used_count)} / ${value(row.max_uses)}` },
                  { key: "enabled", label: "状态", render: (row) => row.enabled ? "有效" : "停用" },
                  { key: "expires_at", label: "过期时间", render: (row) => row.expires_at ? dateTime(row.expires_at) : "长期" },
                  { key: "created_at", label: "创建时间", render: (row) => dateTime(row.created_at) },
                  { key: "actions", label: "操作", render: (row) => adminUser.role === "admin" ? <button type="button" onClick={() => void toggleInvite(row)}>{row.enabled ? "停用" : "启用"}</button> : "只读" }
                ]}
              />
            </section>
          </>
        )}

        {tab === "events" && (
          <section className="admin-card">
            <h2>近 30 天埋点</h2>
            <DataTable
              rows={rows}
              columns={[
                { key: "event_name", label: "事件名" },
                { key: "event_count", label: "事件次数" },
                { key: "visitor_count", label: "独立访客" },
                { key: "session_count", label: "会话数" },
                { key: "last_seen_at", label: "最近触发", render: (row) => dateTime(row.last_seen_at) }
              ]}
            />
          </section>
        )}

        {tab === "audit" && (
          <section className="admin-card">
            <h2>管理操作审计</h2>
            <DataTable
              rows={rows}
              columns={[
                { key: "action", label: "操作" },
                { key: "admin", label: "管理员", render: (row) => value(row.admin_name || row.admin_email) },
                { key: "target_type", label: "对象类型" },
                { key: "target_id", label: "对象 ID" },
                { key: "ip", label: "来源 IP" },
                { key: "created_at", label: "操作时间", render: (row) => dateTime(row.created_at) }
              ]}
            />
          </section>
        )}

        {tab === "system" && (
          <div className="admin-system-grid">
            <section className="admin-card">
              <h2>运行状态</h2>
              <dl>
                <div><dt>API</dt><dd>{value(data.status)}</dd></div>
                <div><dt>环境</dt><dd>{value((data.runtime as UnknownRow | undefined)?.environment)}</dd></div>
                <div><dt>Node.js</dt><dd>{value((data.runtime as UnknownRow | undefined)?.node)}</dd></div>
                <div><dt>数据库大小</dt><dd>{value(data.databaseSize)}</dd></div>
              </dl>
            </section>
            <section className="admin-card">
              <h2>数据表统计</h2>
              <DataTable
                rows={(data.tableCounts || []) as UnknownRow[]}
                columns={[{ key: "name", label: "数据表" }, { key: "count", label: "记录数" }]}
              />
            </section>
            <section className="admin-card">
              <h2>验证码渠道</h2>
              <dl>
                {Object.entries((data.channels || {}) as Record<string, UnknownRow | boolean>).map(([key, channel]) => (
                  <div key={key}><dt>{key}</dt><dd>{typeof channel === "boolean" ? value(channel) : channel.configured ? "已配置" : "待配置"}</dd></div>
                ))}
              </dl>
            </section>
          </div>
        )}
      </section>
    </main>
  );
}
