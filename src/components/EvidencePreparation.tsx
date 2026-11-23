import type { EvidenceItem } from "../data/evidenceChecklist";

export default function EvidencePreparation({ item }: { item: EvidenceItem }) {
  return <div className="evidence-preparation">
    <div>
      <ul role="list">{item.preparationItems.map((text, index) => {
        const separator = text.indexOf("：");
        return <li key={index}>{separator < 0 ? text : <>
          <strong className="evidence-material-name">{text.slice(0, separator)}</strong>
          <p>{text.slice(separator + 1)}</p>
        </>}</li>;
      })}</ul>
    </div>
    <div className="evidence-collection-guide">
      <p>{item.acquisition}</p>
    </div>
  </div>;
}
