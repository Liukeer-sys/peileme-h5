import { useEffect, useState } from "react";
import {
  ApiError,
  getPolicyHistory,
  listPolicyHistory
} from "../lib/api";
import type {
  PolicyHistoryDetail,
  PolicyHistoryItem
} from "../types";

type PolicyHistoryProps = {
  refreshKey?: string;
  onRecalculate: (detail: PolicyHistoryDetail) => Promise<void>;
};

const formatCny = (fen: number) =>
  new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY"
  }).format(fen / 100);

const scenarioName: Record<PolicyHistoryItem["scenario"], string> = {
  MUTUAL_AGREEMENT: "协商解除",
  ARTICLE_40: "无过失性解除",
  ARTICLE_38_EMPLOYEE_TERMINATION: "因单位过错解除",
  STATUTORY_COMPENSATION: "法定经济补偿",
  ARTICLE_39_NO_COMPENSATION: "过失性解除",
  VOLUNTARY_RESIGNATION: "主动辞职",
  UNLAWFUL_TERMINATION: "违法解除",
  UNCLEAR: "待核对情形"
};

export default function PolicyHistory({
  refreshKey,
  onRecalculate
}: PolicyHistoryProps) {
  const [items, setItems] = useState<PolicyHistoryItem[]>([]);
  const [detail, setDetail] = useState<PolicyHistoryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    void listPolicyHistory()
      .then((response) => {
        if (active) setItems(response.items);
      })
      .catch((error) => {
        if (active) {
          setMessage(
            error instanceof ApiError ? error.message : "历史记录加载失败"
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refreshKey]);

  const openDetail = async (item: PolicyHistoryItem) => {
    setBusy(true);
    setMessage("");
    try {
      setDetail(await getPolicyHistory(item.id));
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : "记录详情加载失败");
    } finally {
      setBusy(false);
    }
  };

  if (detail) {
    return (
      <section className="policy-history" aria-labelledby="history-title">
        <div className="policy-history-title-row">
          <h3 id="history-title">政策测算历史</h3>
          <button type="button" onClick={() => setDetail(null)}>返回列表</button>
        </div>
        <div className="history-detail-summary">
          <b>{detail.input.regionName}</b>
          <span>{detail.input.startDate} 至 {detail.input.endDate}</span>
          <span>解除情形：{scenarioName[detail.input.terminationScenario.kind]}</span>
          <span>规则版本 v{detail.ruleVersion} · {detail.accuracy}</span>
          <span>{new Date(detail.createdAt).toLocaleString("zh-CN")}</span>
        </div>
        <strong className="history-detail-amount">
          {detail.output.payableDetermined
            ? formatCny(detail.output.payableFen)
            : `${formatCny(detail.output.rangeFen.low)} – ${formatCny(
                detail.output.rangeFen.high
              )}`}
        </strong>
        <h4>完整计算公式</h4>
        <ol className="history-formula">
          {detail.output.formulaSteps.map((step) => (
            <li key={step.key}>
              <span>{step.label}</span>
              <b>{step.value}</b>
            </li>
          ))}
        </ol>
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => void onRecalculate(detail)}
        >
          按此记录重新测算
        </button>
      </section>
    );
  }

  return (
    <section className="policy-history" aria-labelledby="history-title">
      <h3 id="history-title">政策测算历史</h3>
      {loading ? (
        <p role="status">正在加载历史记录…</p>
      ) : items.length ? (
        <div className="history-list">
          {items.map((item) => (
            <article key={item.id}>
              <div>
                <b>{item.regionName} · {formatCny(item.payableFen)}</b>
                <span>
                  {scenarioName[item.scenario]} · 规则 v{item.ruleVersion} ·{" "}
                  {new Date(item.createdAt).toLocaleString("zh-CN")}
                </span>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void openDetail(item)}
                aria-label={`查看 ${item.regionName} 测算详情`}
              >
                查看
              </button>
            </article>
          ))}
        </div>
      ) : (
        <p>完成一次政策测算后，记录会出现在这里。</p>
      )}
      {message && <p role="alert" className="account-message">{message}</p>}
    </section>
  );
}
