import { useCallback, useEffect, useState } from "react";
import { api, ApiError, track } from "../lib/api";

type AiFinding = {
  title: string;
  severity: "low" | "medium" | "high";
  explanation: string;
};

type AiReport = {
  schemaVersion: "1.0";
  summary: string;
  riskLevel: "low" | "medium" | "high";
  findings: AiFinding[];
  actions: string[];
};

type AiJob = {
  id: string;
  kind: "severance_analysis" | "document_review";
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED_FINAL";
  failureCode: string | null;
  report: AiReport | null;
  createdAt: string;
};

type AiJobList = {
  items: AiJob[];
  total: number;
};

const riskLabel: Record<AiReport["riskLevel"], string> = {
  low: "低风险",
  medium: "中等风险",
  high: "高风险"
};

const jobKindLabel: Record<AiJob["kind"], string> = {
  severance_analysis: "离职补偿分析",
  document_review: "文件签署审查"
};

type AiAnalysisWorkspaceProps = {
  refreshKey?: number;
};

export default function AiAnalysisWorkspace({
  refreshKey = 0
}: AiAnalysisWorkspaceProps) {
  const [situation, setSituation] = useState("");
  const [jobs, setJobs] = useState<AiJob[]>([]);
  const [activeJob, setActiveJob] = useState<AiJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const loadHistory = useCallback(async (signal?: AbortSignal) => {
    try {
      const history = await api<AiJobList>("/api/ai/jobs", {
        auth: true,
        signal
      });
      if (!signal?.aborted) setJobs(history.items);
    } catch (error) {
      if (!signal?.aborted) {
        setMessage(error instanceof ApiError ? error.message : "分析记录加载失败");
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadHistory(controller.signal);
    return () => controller.abort();
  }, [loadHistory, refreshKey]);

  const analyze = async () => {
    const normalized = situation.trim();
    if (normalized.length < 10) {
      setMessage("请至少填写 10 个字，说明解除原因、工龄、工资和现有材料");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const job = await api<AiJob>("/api/ai/jobs", {
        method: "POST",
        auth: true,
        body: {
          kind: "severance_analysis",
          idempotencyKey: `web-${crypto.randomUUID()}`,
          input: { situation: normalized }
        }
      });
      setActiveJob(job);
      await loadHistory();
      track("ai_analysis_completed", {
        kind: job.kind,
        status: job.status,
        failureCode: job.failureCode
      });
      if (job.status === "FAILED_FINAL") {
        setMessage(
          job.failureCode === "AI_PROVIDER_NOT_CONFIGURED"
            ? "分析服务尚未配置模型通道，请联系管理员"
            : "模型通道暂时不可用，本次分析次数已退回"
        );
      }
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : "分析提交失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const report = activeJob?.report;

  return (
    <section className="ai-analysis-workspace" aria-labelledby="ai-workspace-title">
      <div className="ai-workspace-card">
        <div className="ai-workspace-heading">
          <div>
            <span className="status-pill">按次使用</span>
            <h2 id="ai-workspace-title">离职补偿深度分析</h2>
          </div>
          <small>结果仅供决策参考</small>
        </div>
        <label htmlFor="ai-situation">把你的情况说具体一些</label>
        <textarea
          id="ai-situation"
          value={situation}
          maxLength={12_000}
          placeholder="例如：公司提出协商解除，我工作 5 年，月工资 12000 元，有劳动合同、工资流水和解除通知……"
          onChange={(event) => setSituation(event.target.value)}
        />
        <button
          className="primary-button"
          type="button"
          disabled={busy || situation.trim().length < 10}
          onClick={() => void analyze()}
        >
          {busy ? "分析中…" : "开始 AI 分析"}
        </button>
        {message && <p className="ai-workspace-message" role="status">{message}</p>}
      </div>

      {report && (
        <article className="ai-report-card">
          <div className="ai-report-title">
            <h2>分析报告</h2>
            <span data-risk={report.riskLevel}>{riskLabel[report.riskLevel]}</span>
          </div>
          <p>{report.summary}</p>
          <div className="ai-findings">
            {report.findings.map((finding, index) => (
              <section key={`${finding.title}-${index}`}>
                <strong>{finding.title}</strong>
                <span>{finding.explanation}</span>
              </section>
            ))}
          </div>
          {report.actions.length > 0 && (
            <div className="ai-actions">
              <strong>下一步建议</strong>
              <ol>
                {report.actions.map((action, index) => <li key={`${action}-${index}`}>{action}</li>)}
              </ol>
            </div>
          )}
        </article>
      )}

      <section className="ai-history-card">
        <h2>最近分析</h2>
        {jobs.length ? (
          <div className="ai-job-list">
            {jobs.slice(0, 8).map((job) => (
              <button key={job.id} type="button" onClick={() => setActiveJob(job)}>
                <span>
                  <strong>{jobKindLabel[job.kind]}</strong>
                  <small>{new Date(job.createdAt).toLocaleString("zh-CN")}</small>
                </span>
                <b>{job.status === "COMPLETED" ? "查看" : job.status === "FAILED_FINAL" ? "已退回次数" : "处理中"}</b>
              </button>
            ))}
          </div>
        ) : (
          <p>还没有分析记录。</p>
        )}
      </section>
    </section>
  );
}
