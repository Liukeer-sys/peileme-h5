import { useId, useState } from "react";
import type { EvidenceChecklist, EvidenceItem } from "../data/evidenceChecklist";
import EvidencePreparation from "./EvidencePreparation";

function EvidenceCard({ item, number, initiallyOpen, selected, savedLabel, onToggle }: {
  item: EvidenceItem;
  number: number;
  initiallyOpen: boolean;
  selected?: boolean;
  savedLabel: string;
  onToggle?: (id: string) => void;
}) {
  const panelId = useId();
  const [open, setOpen] = useState(initiallyOpen);
  return <article className="evidence-collection-card">
    <div className="evidence-collection-header">
      <button className="evidence-collection-toggle" type="button" aria-expanded={open}
        aria-controls={panelId} onClick={() => setOpen(current => !current)}>
        <span className="evidence-collection-number">{String(number).padStart(2, "0")}</span>
        <span className="evidence-collection-title">{item.name}</span>
        {onToggle && item.priority === "optional" && <span className="evidence-collection-priority is-optional">有则保留</span>}
        <span className="evidence-collection-chevron">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d={open ? "M4 10 8 6 12 10" : "M4 6 8 10 12 6"} />
          </svg>
        </span>
      </button>
      {onToggle && <label className="evidence-collection-check">
        <input type="checkbox" checked={Boolean(selected)} onChange={() => onToggle(item.id)}
          aria-label={item.name + "：" + savedLabel} />
      </label>}
    </div>
    <div className="evidence-collection-body" id={panelId} hidden={!open}>
      <EvidencePreparation item={item} />
    </div>
  </article>;
}

export default function EvidenceChecklistView({ checklist, selected, onToggle }: {
  checklist: EvidenceChecklist;
  selected: Record<string, boolean>;
  onToggle: (id: string) => void;
}) {
  const items = checklist.sections.flatMap(section => section.items);
  const itemNumbers = new Map(items.map((item, index) => [item.id, index + 1]));
  const ready = items.filter(item => selected[item.id]).length;
  const title = checklist.title ?? "证据准备清单";
  const savedLabel = checklist.savedLabel ?? "已准备";
  return <section className="legal-pack-section evidence-checklist evidence-concise" aria-label={title}>
    <div className="legal-pack-section-heading">
      <h3>{title}</h3>
      <span aria-live="polite">{savedLabel} {ready} / {items.length} 项</span>
    </div>
    {checklist.sections.map(section => <section className="evidence-concise-group" key={section.id} aria-label={section.title}>
      <h4>{section.title}</h4>
      <div className="evidence-flat-list">
        {section.items.map(item => <EvidenceCard key={item.id} item={item} number={itemNumbers.get(item.id)!}
          initiallyOpen={item.id === items[0]?.id} savedLabel={savedLabel} selected={selected[item.id]} onToggle={onToggle} />)}
      </div>
    </section>)}
    {checklist.supplementaryEvidence?.map(section => <details className="evidence-supplementary" key={section.id}>
      <summary>{section.title}</summary>
      {section.description && <p>{section.description}</p>}
      <div className="evidence-flat-list">
        {section.items.map((item, index) => <EvidenceCard key={item.id} item={item} number={index + 1}
          initiallyOpen={false} savedLabel={savedLabel} />)}
      </div>
    </details>)}
    {checklist.reminder && <p className="evidence-concise-reminder">{checklist.reminder}</p>}
  </section>;
}
