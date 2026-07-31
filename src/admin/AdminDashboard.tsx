import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { useAuth, type User } from "../auth/AuthContext";
import AuthModal from "../components/AuthModal";
import { api, ApiError } from "../lib/api";
import {
  DataTable,
  dateTime,
  type UnknownRow,
  value
} from "./adminShared";
import AnnouncementsPanel from "./policy/AnnouncementsPanel";
import PolicyRulesPanel from "./policy/PolicyRulesPanel";
import RegionalDataPanel from "./policy/RegionalDataPanel";
import { isCurrentAdminEndpoint } from "./AdminEndpointBoundary";

type BaseTab =
  | "overview"
  | "policyRules"
  | "regionalData"
  | "announcements"
  | "users"
  | "assessments"
  | "invites"
  | "events"
  | "audit"
  | "operations"
  | "system";

type AdminExtensionContext = {
  data: Record<string, unknown>;
  rows: UnknownRow[];
  adminUser: User;
  setError: (message: string) => void;
};

export type AdminDashboardExtension = {
  id: string;
  label: string;
  icon: string;
  after?: BaseTab;
  endpoint: string;
  overviewMetric?: {
    label: string;
    dataKey: string;
    note: string;
  };
  render: (context: AdminExtensionContext) => ReactNode;
};

type AdminDashboardProps = {
  extensions?: AdminDashboardExtension[];
  entitlementOptions?: Array<{ sku: string; label: string }>;
};

type FirstUseSetting = {
  sku: string;
  name: string;
  grantCount: number;
  enabled: boolean;
};

const mainEntitlementOptions = [
  { sku: "POLICY_CALC", label: "政策测算" }
];

const navItems: Array<{ id: BaseTab; label: string; icon: string }> = [
  { id: "overview", label: "经营概览", icon: "⌁" },
  { id: "policyRules", label: "政策规则", icon: "规" },
  { id: "regionalData", label: "区域参数", icon: "域" },
  { id: "announcements", label: "公告设置", icon: "告" },
  { id: "users", label: "用户管理", icon: "人" },
  { id: "assessments", label: "测算记录", icon: "算" },
  { id: "invites", label: "邀请码", icon: "码" },
  { id: "events", label: "埋点统计", icon: "数" },
  { id: "audit", label: "审计日志", icon: "审" },
  { id: "operations", label: "运行日志", icon: "志" },
  { id: "system", label: "系统状态", icon: "稳" }
];

const noExtensions: AdminDashboardExtension[] = [];

const roleLabel: Record<User["role"], string> = {
  admin: "超级管理员",
  policy_editor: "政策编辑",
  policy_reviewer: "政策审核",
  operations: "运营人员",
  finance: "财务人员",
  support: "客服人员",
  ai_operator: "AI 运营",
  auditor: "审计人员",
  analyst: "数据分析员",
  user: "普通用户"
};

const tabCapability: Partial<Record<BaseTab, string>> = {
  overview: "analytics.read",
  policyRules: "policy.read",
  regionalData: "policy.read",
  announcements: "content.read",
  users: "users.read",
  assessments: "assessments.read",
  invites: "invites.read",
  events: "analytics.read",
  audit: "audit.read",
  operations: "operations.read",
  system: "system.read"
};

export default function AdminDashboard({
  extensions = noExtensions,
  entitlementOptions = mainEntitlementOptions
}: AdminDashboardProps) {
  const { user, capabilities, ready, logout } = useAuth();
  const [tab, setTab] = useState<string>("overview");
  const [data, setData] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [authOpen, setAuthOpen] = useState(false);
  const [inviteDescription, setInviteDescription] = useState("");
  const [inviteUses, setInviteUses] = useState("1");
  const [firstUseSettings, setFirstUseSettings] = useState<FirstUseSetting[]>([]);
  const [grantingUser, setGrantingUser] = useState<UnknownRow | null>(null);
  const [grantSku, setGrantSku] = useState(entitlementOptions[0]?.sku ?? "POLICY_CALC");
  const [grantUses, setGrantUses] = useState("1");
  const [grantReason, setGrantReason] = useState("");
  const [grantExpiresAt, setGrantExpiresAt] = useState("");
  const [userMessage, setUserMessage] = useState("");
  const [policyRefreshKey, setPolicyRefreshKey] = useState(0);
  const requestGenerationRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);

  const isAdmin = Boolean(user && capabilities.includes("admin.access"));
  const allNavItems = useMemo(
    () => {
      const positioned = navItems.flatMap((item) => [
        item,
        ...extensions
          .filter((extension) => extension.after === item.id)
          .map(({ id, label, icon }) => ({ id, label, icon }))
      ]);
      return [
        ...positioned,
        ...extensions
          .filter((extension) => !extension.after)
          .map(({ id, label, icon }) => ({ id, label, icon }))
      ].filter((item) => {
        const required = tabCapability[item.id as BaseTab];
        return !required || capabilities.includes(required);
      });
    },
    [capabilities, extensions]
  );

  useEffect(() => {
    if (!ready || !isAdmin) return;
    if (!allNavItems.length || allNavItems.some((item) => item.id === tab)) return;
    setTab(allNavItems[0].id);
  }, [allNavItems, isAdmin, ready, tab]);
  const activeExtension = useMemo(
    () => extensions.find((extension) => extension.id === tab),
    [extensions, tab]
  );
  const entitlementLabel = useMemo(
    () => Object.fromEntries(entitlementOptions.map((item) => [item.sku, item.label])),
    [entitlementOptions]
  );
  const endpoint = useMemo(
    () => {
      const baseEndpoint = ({
        overview: "/api/admin/overview?days=30",
        policyRules: "",
        regionalData: "",
        announcements: "",
        users: "/api/admin/users?pageSize=100",
        assessments: "/api/admin/assessments?pageSize=100",
        invites: "/api/admin/invites",
        events: "/api/admin/events?days=30",
        audit: "/api/admin/audit-logs?pageSize=100",
        operations: "/api/admin/operations",
        system: "/api/admin/system"
      } as Record<string, string>)[tab];
      return baseEndpoint ?? activeExtension?.endpoint ?? "";
    },
    [activeExtension, tab]
  );
  const activeEndpointRef = useRef(endpoint);
  activeEndpointRef.current = endpoint;

  const load = useCallback(async (capturedEndpoint = endpoint) => {
    if (
      !isAdmin ||
      !isCurrentAdminEndpoint(activeEndpointRef.current, capturedEndpoint)
    ) {
      return;
    }
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    setLoading(true);
    setError("");
    setData({});
    try {
      const responseData = await api<Record<string, unknown>>(capturedEndpoint, {
        auth: true,
        signal: controller.signal
      });
      if (
        isCurrentAdminEndpoint(
          activeEndpointRef.current,
          capturedEndpoint
        ) &&
        requestGenerationRef.current === generation &&
        !controller.signal.aborted
      ) {
        setData(responseData);
      }
    } catch (requestError) {
      if (
        isCurrentAdminEndpoint(
          activeEndpointRef.current,
          capturedEndpoint
        ) &&
        requestGenerationRef.current === generation &&
        !controller.signal.aborted
      ) {
        setError(
          requestError instanceof ApiError ? requestError.message : "加载失败"
        );
      }
    } finally {
      if (
        isCurrentAdminEndpoint(
          activeEndpointRef.current,
          capturedEndpoint
        ) &&
        requestGenerationRef.current === generation
      ) {
        if (requestControllerRef.current === controller) {
          requestControllerRef.current = null;
        }
        setLoading(false);
      }
    }
  }, [endpoint, isAdmin]);

  useEffect(() => {
    requestGenerationRef.current += 1;
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    setData({});
    setError("");
    setLoading(false);
    if (endpoint && isAdmin) void load(endpoint);
    return () => {
      requestGenerationRef.current += 1;
      requestControllerRef.current?.abort();
      requestControllerRef.current = null;
    };
  }, [endpoint, isAdmin, load]);

  useEffect(() => {
    if (tab !== "users" || !isAdmin) return;
    void api<{ items: FirstUseSetting[] }>(
      "/api/admin/entitlements/first-use",
      { auth: true }
    )
      .then((response) => setFirstUseSettings(
        response.items.filter((item) => entitlementOptions.some((option) => option.sku === item.sku))
      ))
      .catch((requestError) =>
        setError(
          requestError instanceof ApiError
            ? requestError.message
            : "首次权益配置加载失败"
        )
      );
  }, [entitlementOptions, isAdmin, tab]);

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
  const canWriteContent = capabilities.includes("content.write");
  const canPublishContent = capabilities.includes("content.publish");
  const canWriteUsers = capabilities.includes("users.write");
  const canWriteInvites = capabilities.includes("invites.write");
  const rows = ((data.items || data.recentAssessments || []) as UnknownRow[]);
  const overview = (data.summary || {}) as UnknownRow;
  const createInvite = async () => {
    const capturedEndpoint = endpoint;
    const capturedGeneration = requestGenerationRef.current;
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
      if (
        isCurrentAdminEndpoint(activeEndpointRef.current, capturedEndpoint) &&
        requestGenerationRef.current === capturedGeneration
      ) {
        setInviteDescription("");
        setInviteUses("1");
      }
      await load(capturedEndpoint);
    } catch (requestError) {
      if (
        isCurrentAdminEndpoint(activeEndpointRef.current, capturedEndpoint) &&
        requestGenerationRef.current === capturedGeneration
      ) {
        setError(
          requestError instanceof ApiError ? requestError.message : "创建失败"
        );
      }
    } finally {
      if (
        isCurrentAdminEndpoint(activeEndpointRef.current, capturedEndpoint) &&
        requestGenerationRef.current === capturedGeneration
      ) {
        setLoading(false);
      }
    }
  };

  const updateUser = async (row: UnknownRow, patch: Record<string, unknown>) => {
    const capturedEndpoint = endpoint;
    setError("");
    try {
      await api(`/api/admin/users/${row.id}`, {
        method: "PATCH",
        auth: true,
        body: { ...patch, expectedUpdatedAt: row.updated_at }
      });
      await load(capturedEndpoint);
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : "用户更新失败");
    }
  };

  const toggleInvite = async (row: UnknownRow) => {
    const capturedEndpoint = endpoint;
    setError("");
    try {
      await api(`/api/admin/invites/${row.id}`, {
        method: "PATCH",
        auth: true,
        body: { enabled: !row.enabled }
      });
      await load(capturedEndpoint);
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : "邀请码更新失败");
    }
  };

  const updateFirstUseSetting = async (setting: FirstUseSetting) => {
    setError("");
    setUserMessage("");
    try {
      const updated = await api<FirstUseSetting>(
        "/api/admin/entitlements/first-use",
        {
          method: "PATCH",
          auth: true,
          body: {
            sku: setting.sku,
            grantCount: setting.grantCount,
            enabled: setting.enabled
          }
        }
      );
      setFirstUseSettings((current) =>
        current.map((item) => item.sku === updated.sku ? { ...item, ...updated } : item)
      );
      setUserMessage(`${entitlementLabel[setting.sku] || setting.name}首次权益已保存`);
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : "首次权益保存失败");
    }
  };

  const grantEntitlement = async () => {
    if (!grantingUser) return;
    setError("");
    setUserMessage("");
    try {
      await api(`/api/admin/users/${grantingUser.id}/entitlements`, {
        method: "POST",
        auth: true,
        body: {
          sku: grantSku,
          uses: Number(grantUses),
          reason: grantReason,
          expiresAt: grantExpiresAt
            ? new Date(grantExpiresAt).toISOString()
            : null,
          idempotencyKey: crypto.randomUUID()
        }
      });
      setUserMessage(
        `已向 ${value(grantingUser.display_name || grantingUser.email || grantingUser.phone)} 发放 ${grantUses} 次${entitlementLabel[grantSku] || grantSku}`
      );
      setGrantingUser(null);
      setGrantUses("1");
      setGrantReason("");
      setGrantExpiresAt("");
      await load(endpoint);
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : "次数发放失败");
    }
  };

  return (
    <main className="admin-shell">
      <aside className="admin-sidebar">
        <a className="admin-brand" href="/">
          <span>赔</span>
          <div><strong>赔了么</strong><small>运营管理台</small></div>
        </a>
        <nav>
          {allNavItems.map((item) => (
            <button
              key={item.id}
              className={tab === item.id ? "active" : ""}
              type="button"
              onClick={() => {
                setData({});
                setError("");
                setTab(item.id);
              }}
            >
              <i>{item.icon}</i>{item.label}
            </button>
          ))}
        </nav>
        <div className="admin-profile">
          <strong>{adminUser.displayName || adminUser.email || adminUser.phone}</strong>
          <span>{roleLabel[adminUser.role]}</span>
          <button type="button" onClick={() => void logout().then(() => window.location.assign("/"))}>退出</button>
        </div>
      </aside>

      <section className="admin-content">
        <header className="admin-header">
          <div>
            <span>生产环境 · 数据实时更新</span>
            <h1>{allNavItems.find((item) => item.id === tab)?.label}</h1>
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
            canWrite={canWriteContent}
            canPublish={canPublishContent}
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
                ...extensions
                  .filter((extension) => extension.overviewMetric)
                  .map((extension) => {
                    const metric = extension.overviewMetric!;
                    return [
                      metric.label,
                      overview[metric.dataKey],
                      metric.note
                    ] as [string, unknown, string];
                  })
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
          <div className="admin-policy-stack">
            {userMessage && <p className="admin-success" role="status">{userMessage}</p>}
            <section className="admin-card" aria-label="首次权益配置">
              <h2>首次权益配置</h2>
              <div className="admin-entitlement-settings">
                {firstUseSettings.map((setting) => (
                  <div key={setting.sku} className="admin-entitlement-setting">
                    <strong>{entitlementLabel[setting.sku] || setting.name}</strong>
                    <label>
                      <span>首次次数</span>
                      <input
                        aria-label={`${entitlementLabel[setting.sku] || setting.name}首次次数`}
                        type="number"
                        min="1"
                        max="100"
                        disabled={!canWriteUsers}
                        value={setting.grantCount}
                        onChange={(event) => setFirstUseSettings((current) =>
                          current.map((item) => item.sku === setting.sku
                            ? { ...item, grantCount: Number(event.target.value) }
                            : item)
                        )}
                      />
                    </label>
                    <label className="admin-inline-check">
                      <input
                        aria-label={`${entitlementLabel[setting.sku] || setting.name}首次权益启用`}
                        type="checkbox"
                        disabled={!canWriteUsers}
                        checked={setting.enabled}
                        onChange={(event) => setFirstUseSettings((current) =>
                          current.map((item) => item.sku === setting.sku
                            ? { ...item, enabled: event.target.checked }
                            : item)
                        )}
                      />
                      启用
                    </label>
                    <button
                      type="button"
                      disabled={!canWriteUsers || setting.grantCount < 1 || setting.grantCount > 100}
                      onClick={() => void updateFirstUseSetting(setting)}
                    >保存</button>
                  </div>
                ))}
              </div>
            </section>

            {grantingUser && (
              <section className="admin-card admin-entitlement-grant" aria-label="发放使用次数">
                <div className="admin-section-title">
                  <div>
                    <span>人工补发 · 全程审计</span>
                    <h2>向 {value(grantingUser.display_name || grantingUser.email || grantingUser.phone)} 发放次数</h2>
                  </div>
                  <button type="button" onClick={() => setGrantingUser(null)}>关闭</button>
                </div>
                <label><span>权益类型</span>
                  <select aria-label="发放权益类型" value={grantSku} onChange={(event) => setGrantSku(event.target.value)}>
                    {entitlementOptions.map(({ sku, label }) => <option key={sku} value={sku}>{label}</option>)}
                  </select>
                </label>
                <label><span>发放次数</span><input aria-label="发放次数" type="number" min="1" max="1000" value={grantUses} onChange={(event) => setGrantUses(event.target.value)} /></label>
                <label><span>到期时间（可选）</span><input aria-label="权益到期时间" type="datetime-local" value={grantExpiresAt} onChange={(event) => setGrantExpiresAt(event.target.value)} /></label>
                <label><span>发放原因</span><input aria-label="发放原因" maxLength={240} value={grantReason} onChange={(event) => setGrantReason(event.target.value)} /></label>
                <button
                  className="admin-primary-action"
                  type="button"
                  disabled={!grantReason.trim() || Number(grantUses) < 1 || Number(grantUses) > 1000}
                  onClick={() => void grantEntitlement()}
                >确认发放</button>
              </section>
            )}

            <section className="admin-card">
              <h2>用户清单 <small>共 {value((data.pagination as UnknownRow | undefined)?.total)} 人</small></h2>
              <DataTable
                rows={rows}
                columns={[
                { key: "display_name", label: "用户", render: (row) => <><b>{value(row.display_name)}</b><br /><small>{value(row.email || row.phone)}</small></> },
                { key: "role", label: "角色", render: (row) => roleLabel[row.role as User["role"]] || value(row.role) },
                { key: "status", label: "状态" },
                { key: "assessment_count", label: "测算数" },
                { key: "entitlement_balances", label: "可用次数", render: (row) => {
                  const balances = (row.entitlement_balances || {}) as Record<string, unknown>;
                  return entitlementOptions
                    .map(({ sku, label }) => `${label} ${value(balances[sku])}`)
                    .join(" · ");
                } },
                { key: "created_at", label: "注册时间", render: (row) => dateTime(row.created_at) },
                {
                  key: "actions",
                  label: "操作",
                  render: (row) => canWriteUsers ? (
                    <div className="admin-row-actions">
                      <button type="button" onClick={() => {
                        setGrantingUser(row);
                        setGrantReason("");
                        setUserMessage("");
                      }}>发放次数</button>
                      <button type="button" onClick={() => void updateUser(row, { status: row.status === "active" ? "disabled" : "active" })}>
                        {row.status === "active" ? "停用" : "启用"}
                      </button>
                      {adminUser.role === "admin" && row.role !== "admin" && (
                        <button type="button" onClick={() => void updateUser(row, { role: row.role === "analyst" ? "user" : "analyst" })}>
                          {row.role === "analyst" ? "降为用户" : "设为分析员"}
                        </button>
                      )}
                    </div>
                  ) : "只读"
                }
                ]}
              />
            </section>
          </div>
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

        {tab === "invites" && (
          <>
            {canWriteInvites && (
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
                  { key: "actions", label: "操作", render: (row) => canWriteInvites ? <button type="button" onClick={() => void toggleInvite(row)}>{row.enabled ? "停用" : "启用"}</button> : "只读" }
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

        {tab === "operations" && (
          <div className="admin-system-grid">
            <section className="admin-card">
              <h2>应用错误日志</h2>
              <DataTable
                rows={(data.errors || []) as UnknownRow[]}
                columns={[
                  { key: "created_at", label: "时间", render: (row) => dateTime(row.created_at) },
                  { key: "request_id", label: "请求 ID" },
                  { key: "method", label: "方法" },
                  { key: "path", label: "路径" },
                  { key: "status_code", label: "状态码" },
                  { key: "code", label: "错误码" }
                ]}
              />
            </section>
            <section className="admin-card">
              <h2>后台任务日志</h2>
              <DataTable
                rows={(data.jobs || []) as UnknownRow[]}
                columns={[
                  { key: "job_name", label: "任务" },
                  { key: "status", label: "状态" },
                  { key: "started_at", label: "开始时间", render: (row) => dateTime(row.started_at) },
                  { key: "finished_at", label: "结束时间", render: (row) => dateTime(row.finished_at) },
                  { key: "detail", label: "详情", render: (row) => JSON.stringify(row.detail || {}) }
                ]}
              />
            </section>
          </div>
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
            <section className="admin-card">
              <h2>AI 模型通道</h2>
              <DataTable
                rows={(data.aiProviders || []) as UnknownRow[]}
                columns={[
                  { key: "key", label: "Provider" },
                  { key: "model", label: "模型" },
                  { key: "enabled", label: "状态", render: (row) => row.enabled ? "已启用" : "待配置" },
                  { key: "primary", label: "顺序", render: (row) => row.primary ? "主通道" : "降级通道" }
                ]}
              />
            </section>
            <section className="admin-card">
              <h2>AI 异步 Worker</h2>
              <dl>
                <div><dt>状态</dt><dd>{value((data.aiWorker as UnknownRow | undefined)?.status)}</dd></div>
                <div><dt>排队任务</dt><dd>{value((data.aiWorker as UnknownRow | undefined)?.queued)}</dd></div>
                <div><dt>运行任务</dt><dd>{value((data.aiWorker as UnknownRow | undefined)?.running)}</dd></div>
                <div><dt>24 小时失败</dt><dd>{value((data.aiWorker as UnknownRow | undefined)?.failed24Hours)}</dd></div>
                <div><dt>最近心跳</dt><dd>{dateTime((data.aiWorker as UnknownRow | undefined)?.seenAt)}</dd></div>
              </dl>
            </section>
            <section className="admin-card">
              <h2>异常与待处理任务</h2>
              <dl>
                <div><dt>24 小时应用错误</dt><dd>{value(((data.operational as UnknownRow | undefined)?.errors as UnknownRow | undefined)?.last24Hours)}</dd></div>
                <div><dt>待对账</dt><dd>{value(((data.operational as UnknownRow | undefined)?.tasks as UnknownRow | undefined)?.reconciliationDue)}</dd></div>
                <div><dt>失败通知</dt><dd>{value(((data.operational as UnknownRow | undefined)?.tasks as UnknownRow | undefined)?.failedNotifications)}</dd></div>
                <div><dt>失败上传</dt><dd>{value(((data.operational as UnknownRow | undefined)?.tasks as UnknownRow | undefined)?.failedUploads)}</dd></div>
                <div><dt>失败验证码</dt><dd>{value(((data.operational as UnknownRow | undefined)?.tasks as UnknownRow | undefined)?.failedOtpDeliveries)}</dd></div>
              </dl>
            </section>
          </div>
        )}

        {activeExtension?.render({
          data,
          rows,
          adminUser,
          setError
        })}
      </section>
    </main>
  );
}
