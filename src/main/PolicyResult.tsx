import { useState } from "react";
import {
  ApiError,
  createPolicyShare,
  revokePolicyShare
} from "../lib/api";
import type { PolicyApiResult } from "../types";

type PolicyResultProps = {
  result: PolicyApiResult;
  onOpenHistory: () => void;
  onRecalculate: () => void;
  sharedReadOnly?: boolean;
};

const formatCny = (fen: number) =>
  new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    maximumFractionDigits: 2
  }).format(fen / 100);

const accuracyCopy: Record<
  PolicyApiResult["accuracyLevel"],
  { label: string; detail: string }
> = {
  verified: {
    label: "已核验",
    detail: "本次计算使用当前地区已审核的官方政策参数。"
  },
  estimated: {
    label: "估算",
    detail: "本次使用了省级回退或你补充的当地参数，请结合官方最新口径核对。"
  },
  stale: {
    label: "待更新",
    detail: "部分官方参数已经超过当前维护周期，金额适合作为核对线索。"
  },
  unsupported: {
    label: "需人工核对",
    detail: "当前条件无法形成确定金额，请结合证据和当地口径进一步判断。"
  }
};

export default function PolicyResult({
  result,
  onOpenHistory,
  onRecalculate,
  sharedReadOnly = false
}: PolicyResultProps) {
  const [shareMessage, setShareMessage] = useState("");
  const [activeShareId, setActiveShareId] = useState("");
  const [shareBusy, setShareBusy] = useState(false);
  const accuracy = accuracyCopy[result.accuracyLevel];
  const sources = Object.values(result.parameters).filter(
    (item, index, all) =>
      item.sourceUrl &&
      all.findIndex((candidate) => candidate.sourceUrl === item.sourceUrl) ===
        index
  );

  const share = async () => {
    if (shareBusy) return;
    setShareBusy(true);
    setShareMessage("");
    try {
      const created = await createPolicyShare(result.assessmentId);
      setActiveShareId(created.shareId);
      const url = new URL(window.location.href);
      url.search = "";
      url.searchParams.set("share", created.token);
      try {
        await navigator.clipboard.writeText(url.toString());
        setShareMessage(
          `分享链接已复制，有效期至 ${new Date(
            created.expiresAt
          ).toLocaleString("zh-CN")}`
        );
      } catch {
        setShareMessage(`分享链接：${url.toString()}`);
      }
    } catch (error) {
      setShareMessage(
        error instanceof ApiError ? error.message : "分享链接创建失败，请重试"
      );
    } finally {
      setShareBusy(false);
    }
  };

  const revokeShare = async () => {
    if (!activeShareId || shareBusy) return;
    setShareBusy(true);
    try {
      await revokePolicyShare(activeShareId);
      setActiveShareId("");
      setShareMessage("分享已撤销，原链接已立即失效");
    } catch (error) {
      setShareMessage(
        error instanceof ApiError ? error.message : "撤销分享失败，请重试"
      );
    } finally {
      setShareBusy(false);
    }
  };

  return (
    <section className="policy-result-card" aria-labelledby="policy-result-title">
      <div className="policy-result-kicker">服务器签发 · 可追溯</div>
      <h1 id="policy-result-title">政策测算结果</h1>
      <p className="policy-result-summary">
        {result.result.payableDetermined
          ? "按你提供的情况，本次测算金额为"
          : "当前事实仍需核对，参考区间为"}
      </p>
      <strong className="policy-result-amount">
        {result.result.payableDetermined
          ? formatCny(result.result.payableFen)
          : `${formatCny(result.result.rangeFen.low)} – ${formatCny(
              result.result.rangeFen.high
            )}`}
      </strong>

      <div className="policy-result-meta">
        <span>规则版本 v{result.ruleVersion}</span>
        <span className={`accuracy-badge accuracy-${result.accuracyLevel}`}>
          {accuracy.label}
        </span>
      </div>
      <p className="accuracy-explanation">{accuracy.detail}</p>

      <section className="policy-formula" aria-labelledby="formula-title">
        <h2 id="formula-title">完整计算公式</h2>
        <ol>
          {result.result.formulaSteps.map((step) => (
            <li key={step.key}>
              <span>{step.label}</span>
              <b>{step.value}</b>
            </li>
          ))}
        </ol>
      </section>

      <section className="policy-source-list" aria-labelledby="source-title">
        <h2 id="source-title">政策参数来源</h2>
        {sources.length ? (
          sources.map((source) => (
            <article key={`${source.parameterType}-${source.sourceUrl}`}>
              <div>
                <b>{source.sourceName}</b>
                <span>
                  {source.regionName}
                  {source.year ? ` · ${source.year} 年` : ""}
                  {source.fallback ? " · 省级参数回退" : ""}
                </span>
              </div>
              <a href={source.sourceUrl!} target="_blank" rel="noreferrer">
                查看官方来源
              </a>
            </article>
          ))
        ) : (
          <p>本次使用了你手工补充的当地参数。</p>
        )}
      </section>

      {!sharedReadOnly && (
        <div className="policy-result-actions">
          <button type="button" className="primary-button" onClick={onOpenHistory}>
            查看历史
          </button>
          {activeShareId ? (
            <button
              type="button"
              className="secondary-button"
              disabled={shareBusy}
              onClick={() => void revokeShare()}
            >
              撤销分享
            </button>
          ) : (
            <button
              type="button"
              className="secondary-button"
              disabled={shareBusy}
              onClick={() => void share()}
            >
              {shareBusy ? "正在创建…" : "分享结果"}
            </button>
          )}
          <button type="button" className="ghost-button" onClick={onRecalculate}>
            重新测算
          </button>
        </div>
      )}
      {shareMessage && <p role="status" className="policy-share-status">{shareMessage}</p>}
      <small className="policy-disclaimer">
        测算用于梳理协商线索，最终权利义务以事实证据、有效规则与专业意见为准。
      </small>
    </section>
  );
}
