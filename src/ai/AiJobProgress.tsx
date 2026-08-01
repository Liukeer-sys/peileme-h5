export type AiProgressJob = {
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED_FINAL";
  progress?: number;
  events?: Array<{
    progress: number;
    detail?: { stage?: string };
  }>;
};

const stageLabels: Record<string, string> = {
  claimed: "Worker 已接单",
  loading_materials: "正在读取材料与案情",
  materials_ready: "材料已整理，准备选择模型",
  provider_started: "模型正在生成分析",
  provider_fallback: "主通道异常，正在切换备用模型",
  provider_succeeded: "模型结果已返回，正在校验",
  persisting_report: "正在保存报告与历史记录"
};

const fallbackStage = (job: AiProgressJob) => {
  if (job.status === "QUEUED") return "等待 AI Worker";
  const progress = job.progress ?? 10;
  if (progress < 20) return stageLabels.claimed;
  if (progress < 35) return stageLabels.loading_materials;
  if (progress < 45) return stageLabels.materials_ready;
  if (progress < 85) return stageLabels.provider_started;
  if (progress < 95) return stageLabels.provider_succeeded;
  return stageLabels.persisting_report;
};

export const getAiProgressLabel = (job: AiProgressJob) => {
  const stage = [...(job.events ?? [])]
    .reverse()
    .find((event) => event.detail?.stage)?.detail?.stage;
  return stage ? stageLabels[stage] ?? fallbackStage(job) : fallbackStage(job);
};

type AiJobProgressProps = {
  job: AiProgressJob;
  eyebrow?: string;
  compact?: boolean;
};

export default function AiJobProgress({
  job,
  eyebrow = "实时处理阶段",
  compact = false
}: AiJobProgressProps) {
  if (job.status === "COMPLETED" || job.status === "FAILED_FINAL") return null;
  const progress = Math.max(0, Math.min(99, job.progress ?? 0));
  const label = getAiProgressLabel(job);

  return (
    <section className={`ai-job-progress${compact ? " is-compact" : ""}`} aria-live="polite">
      <div className="ai-job-progress-copy">
        <span>{eyebrow}</span>
        <strong>{label}</strong>
        <small>阶段内进度约 {progress}%</small>
      </div>
      <div
        className="ai-progress-track"
        role="progressbar"
        aria-label="AI 分析进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
        aria-valuetext={label}
      >
        <span style={{ width: `${Math.max(4, progress)}%` }} />
      </div>
    </section>
  );
}
