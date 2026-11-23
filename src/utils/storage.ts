import type { Answers } from "../types";

import type { EvidenceChecklist } from "../data/evidenceChecklist";

const KEY = "peileme-demo-answers";
const EVIDENCE_PROGRESS_KEY = "peileme-demo-evidence-progress-v1";

export type EvidenceProgress = {
  version: 1;
  terminationReasonId: string;
  checklistKey?: string;
  selectedEvidence: Record<string, boolean>;
  evidencePackUnlocked: boolean;
  updatedAt: string;
};

export const saveAnswers = (answers: Answers) => {
  window.localStorage.setItem(KEY, JSON.stringify(answers));
};

export const loadAnswers = (): Answers | null => {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<Answers>;
    if (!parsed || typeof parsed !== "object") return null;

    return {
      ...parsed,
      followUps: parsed.followUps && typeof parsed.followUps === "object" ? parsed.followUps : {}
    } as Answers;
  } catch {
    return null;
  }
};

export const clearAnswers = () => {
  window.localStorage.removeItem(KEY);
};

export const saveEvidenceProgress = (progress: EvidenceProgress) => {
  window.localStorage.setItem(EVIDENCE_PROGRESS_KEY, JSON.stringify(progress));
};

export const loadEvidenceProgress = (terminationReasonId: string): EvidenceProgress | null => {
  try {
    const raw = window.localStorage.getItem(EVIDENCE_PROGRESS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<EvidenceProgress>;
    if (parsed.version !== 1 || parsed.terminationReasonId !== terminationReasonId || !parsed.selectedEvidence) return null;
    return parsed as EvidenceProgress;
  } catch {
    return null;
  }
};

export const restoreEvidenceSelections = (progress: EvidenceProgress | null, checklist: EvidenceChecklist) => {
  if (!progress || (progress.checklistKey ?? progress.terminationReasonId) !== checklist.key) return {};
  const items = checklist.sections.flatMap(section => section.items);
  return Object.fromEntries(
    items.filter(item => progress.selectedEvidence[item.id] === true).map(item => [item.id, true])
  );
};

export const clearEvidenceProgress = () => {
  window.localStorage.removeItem(EVIDENCE_PROGRESS_KEY);
};
