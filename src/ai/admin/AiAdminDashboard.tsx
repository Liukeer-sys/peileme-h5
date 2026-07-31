import AdminDashboard, {
  type AdminDashboardExtension
} from "../../admin/AdminDashboard";
import {
  DataTable,
  dateTime,
  type UnknownRow,
  value
} from "../../admin/adminShared";
import { ApiError, downloadFromApi } from "../../lib/api";

const aiAdminExtensions: AdminDashboardExtension[] = [
  {
    id: "uploads",
    label: "材料管理",
    icon: "件",
    after: "assessments",
    endpoint: "/api/admin/uploads?pageSize=100",
    overviewMetric: {
      label: "上传材料",
      dataKey: "uploaded_files",
      note: "私有存储"
    },
    render: ({ data, rows, adminUser, setError }) => (
      <section className="admin-card">
        <h2>
          用户材料{" "}
          <small>
            共 {value((data.pagination as UnknownRow | undefined)?.total)} 份
          </small>
        </h2>
        <DataTable
          rows={rows}
          columns={[
            { key: "original_name", label: "文件名" },
            {
              key: "identity",
              label: "用户",
              render: (row) =>
                value(row.display_name || row.email || row.phone)
            },
            { key: "city", label: "测算城市" },
            { key: "mime_type", label: "类型" },
            {
              key: "size_bytes",
              label: "大小",
              render: (row) =>
                `${Math.max(
                  1,
                  Math.round(Number(row.size_bytes || 0) / 1024)
                )} KB`
            },
            { key: "status", label: "处理状态" },
            {
              key: "created_at",
              label: "上传时间",
              render: (row) => dateTime(row.created_at)
            },
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
                        setError(
                          requestError instanceof ApiError
                            ? requestError.message
                            : "下载失败"
                        )
                      )
                    }
                  >
                    下载
                  </button>
                ) : (
                  "只读"
                )
            }
          ]}
        />
      </section>
    )
  }
];

const aiEntitlementOptions = [
  { sku: "AI_SEVERANCE_ANALYSIS", label: "AI 离职分析" },
  { sku: "AI_DOCUMENT_REVIEW", label: "AI 文件审查" }
];

export default function AiAdminDashboard() {
  return (
    <AdminDashboard
      extensions={aiAdminExtensions}
      entitlementOptions={aiEntitlementOptions}
    />
  );
}
