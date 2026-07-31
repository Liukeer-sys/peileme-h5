import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { dateTime } from "../adminShared";

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
const announcementOperationsTimeZone = "Asia/Shanghai";
const announcementDateTimeFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: announcementOperationsTimeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});

const announcementUtcToLocal = (input: string | null) => {
  if (!input) return "";
  const parts = Object.fromEntries(
    announcementDateTimeFormatter
      .formatToParts(new Date(input))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};

const announcementLocalToUtc = (input: string) => {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(input);
  if (!match) throw new Error("INVALID_ANNOUNCEMENT_DATETIME");
  const [, year, month, day, hour, minute] = match;
  return new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour) - 8,
      Number(minute)
    )
  ).toISOString();
};

export default function AnnouncementsPanel({
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
  const editingItem =
    items.find((item) => item.id === editingId) || null;
  const editingStatus = editingItem?.status || null;
  const contentLocked =
    editingStatus === "published" || editingStatus === "archived";

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
      startsAt: announcementUtcToLocal(item.startsAt),
      endsAt: announcementUtcToLocal(item.endsAt)
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
      const editableBody = {
        title: form.title,
        body: form.body,
        placement: form.placement,
        status: form.status,
        startsAt: form.startsAt
          ? announcementLocalToUtc(form.startsAt)
          : null,
        endsAt: form.endsAt ? announcementLocalToUtc(form.endsAt) : null
      };
      if (editingId) {
        await api(`/api/admin/policy/announcements/${editingId}`, {
          method: "PATCH",
          auth: true,
          body:
            editingStatus === "published"
              ? { status: form.status }
              : editableBody
        });
        setMessage("公告已更新");
      } else {
        const created = await api<Announcement>(
          "/api/admin/policy/announcements",
          {
            method: "POST",
            auth: true,
            body: { ...editableBody, status: "draft" }
          }
        );
        setEditingId(created.id);
        setMessage("公告已创建");
      }
      await loadAnnouncements();
    } catch (requestError) {
      setError(
        requestError instanceof ApiError
          ? requestError.message
          : requestError instanceof Error &&
              requestError.message === "INVALID_ANNOUNCEMENT_DATETIME"
            ? "公告排期格式无效"
            : "公告保存失败"
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
  const canSave = editingStatus
    ? editingStatus === "draft"
      ? form.status === "draft"
        ? canWrite
        : form.status === "published" && canPublish
      : editingStatus === "published"
        ? form.status === "archived" && canPublish
        : false
    : canWrite;

  return (
    <div className="admin-policy-stack">
      <section className="admin-card admin-policy-hero">
        <div>
          <span className="admin-eyebrow">站内触达</span>
          <h2>公告编排</h2>
          <p>按主站、AI 站或全站配置展示周期与发布状态。</p>
          <small>运营时区：Asia/Shanghai（UTC+8）</small>
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
          <label><span>公告标题</span><input aria-label="公告标题" disabled={contentLocked} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
          <label className="wide"><span>公告正文</span><textarea aria-label="公告正文" disabled={contentLocked} value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} /></label>
          <label><span>投放位置</span>
            <select aria-label="投放位置" disabled={contentLocked} value={form.placement} onChange={(event) => setForm({ ...form, placement: event.target.value as Announcement["placement"] })}>
              <option value="main">政策主站</option><option value="ai">AI 分析站</option><option value="all">全站</option>
            </select>
          </label>
          <label><span>公告状态</span>
            <select
              aria-label="公告状态"
              disabled={
                editingStatus === "archived" ||
                (editingStatus !== null && !canPublish)
              }
              value={form.status}
              onChange={(event) => setForm({ ...form, status: event.target.value as Announcement["status"] })}
            >
              {!editingStatus && <option value="draft">草稿</option>}
              {editingStatus === "draft" && (
                <>
                  <option value="draft">草稿</option>
                  <option value="published" disabled={!canPublish}>已发布</option>
                </>
              )}
              {editingStatus === "published" && (
                <>
                  <option value="published">已发布</option>
                  <option value="archived" disabled={!canPublish}>已归档</option>
                </>
              )}
              {editingStatus === "archived" && <option value="archived">已归档</option>}
            </select>
          </label>
          <label><span>开始时间（UTC+8）</span><input aria-label="开始时间" type="datetime-local" disabled={contentLocked} value={form.startsAt} onChange={(event) => setForm({ ...form, startsAt: event.target.value })} /></label>
          <label><span>结束时间（UTC+8）</span><input aria-label="结束时间" type="datetime-local" disabled={contentLocked} value={form.endsAt} onChange={(event) => setForm({ ...form, endsAt: event.target.value })} /></label>
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
              <button
                type="button"
                disabled={
                  item.status === "archived" ||
                  (item.status === "draft"
                    ? !canWrite && !canPublish
                    : !canPublish)
                }
                onClick={() => startEdit(item)}
              >
                编辑公告
              </button>
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
