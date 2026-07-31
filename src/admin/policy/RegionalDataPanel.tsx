import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { DataTable, type UnknownRow, value } from "../adminShared";

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

export default function RegionalDataPanel({
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
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const [total, setTotal] = useState(0);
  const requestSequence = useRef(0);

  const loadParameters = useCallback(async () => {
    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;
    setLoading(true);
    setError("");
    try {
      const search = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize)
      });
      if (province) search.set("provinceCode", province);
      if (city) search.set("cityCode", city);
      if (year) search.set("year", year);
      if (type) search.set("parameterType", type);
      if (status) search.set("status", status);
      const response = await api<{
        items: RegionalParameter[];
        pagination: { total: number };
      }>(
        `/api/admin/policy/regional-parameters?${search.toString()}`,
        { auth: true }
      );
      if (sequence === requestSequence.current) {
        setItems(response.items);
        setTotal(response.pagination.total);
      }
    } catch (requestError) {
      if (sequence === requestSequence.current) {
        setError(
          requestError instanceof ApiError
            ? requestError.message
            : "参数加载失败"
        );
      }
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false);
      }
    }
  }, [city, page, province, status, type, year]);

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
              setPage(1);
            }}
          >
            <option value="">全部省份</option>
            {provinces.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
          </select>
        </label>
        <label><span>城市</span>
          <select aria-label="城市" value={city} onChange={(event) => {
            setCity(event.target.value);
            setPage(1);
          }}>
            <option value="">全部城市</option>
            {cities.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
          </select>
        </label>
        <label><span>年份</span><input aria-label="年份" type="number" min="2000" max="2100" value={year} onChange={(event) => {
          setYear(event.target.value);
          setPage(1);
        }} /></label>
        <label><span>参数类型</span>
          <select aria-label="参数类型" value={type} onChange={(event) => {
            setType(event.target.value);
            setPage(1);
          }}>
            <option value="">全部类型</option>
            <option value="minimum_monthly_wage">最低月工资</option>
            <option value="employee_average_monthly_wage">职工月平均工资</option>
          </select>
        </label>
        <label><span>审核状态</span>
          <select aria-label="审核状态" value={status} onChange={(event) => {
            setStatus(event.target.value);
            setPage(1);
          }}>
            <option value="">全部状态</option>
            <option value="draft">草稿</option>
            <option value="verified">已核验</option>
            <option value="stale">已过期</option>
          </select>
        </label>
        <button type="button" disabled={loading} onClick={() => {
          if (page === 1) {
            void loadParameters();
          } else {
            setPage(1);
          }
        }}>应用筛选</button>
      </section>

      <section className="admin-card">
        <div className="admin-section-title">
          <div><span>严格字段 · 原子写入</span><h2>CSV 批量导入</h2></div>
          <a
            href="/regional-parameters-template.csv"
            download="regional-parameters-template.csv"
          >
            查看字段模板
          </a>
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
        <div className="admin-pagination">
          <button
            type="button"
            name="上一页"
            disabled={loading || page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            上一页
          </button>
          <span role="status" aria-label="区域参数分页">
            第 {page} / {Math.max(1, Math.ceil(total / pageSize))} 页 ·
            共 {total} 条
          </span>
          <button
            type="button"
            name="下一页"
            disabled={
              loading || page >= Math.max(1, Math.ceil(total / pageSize))
            }
            onClick={() => setPage((current) => current + 1)}
          >
            下一页
          </button>
        </div>
      </section>
    </div>
  );
}
