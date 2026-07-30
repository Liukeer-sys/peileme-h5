import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import AuthModal from "../components/AuthModal";
import { api, ApiError, downloadFromApi } from "../lib/api";

type Tab =
  | "overview"
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

export default function AdminDashboard() {
  const { user, ready, logout } = useAuth();
  const [tab, setTab] = useState<Tab>("overview");
  const [data, setData] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [authOpen, setAuthOpen] = useState(false);
  const [inviteDescription, setInviteDescription] = useState("");
  const [inviteUses, setInviteUses] = useState("1");

  const isAdmin = Boolean(user && ["admin", "analyst"].includes(user.role));
  const endpoint = useMemo(
    () =>
      ({
        overview: "/api/admin/overview?days=30",
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
    if (!isAdmin) return;
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
          grants: ["caseLawPack", "evidencePack", "documentReview"]
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
          <button type="button" disabled={loading} onClick={() => void load()}>
            {loading ? "刷新中…" : "刷新数据"}
          </button>
        </header>

        {error && <div className="admin-error">{error}</div>}

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
