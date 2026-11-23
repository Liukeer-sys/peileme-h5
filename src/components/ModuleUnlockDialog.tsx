import XiaoPeiAvatar from "./XiaoPeiAvatar";

type Props = { onClose: () => void; onConfirm: () => void };

export default function ModuleUnlockDialog({ onClose, onConfirm }: Props) {
  return <div className="paywall-overlay" role="dialog" aria-modal="true" aria-label="解锁后查看完整分析"
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={event => { if (event.key === "Escape") onClose(); }}>
    <div className="paywall-modal paid-card unlock-modal">
      <div className="unlock-intro">
        <XiaoPeiAvatar state="smirk" size={48} />
        <h2>解锁后查看完整分析</h2>
      </div>
      <button className="unlock-confirm-button raised-layer raised-layer-primary" type="button" autoFocus
        onClick={onConfirm}>我要给博主一键三连解锁</button>
    </div>
  </div>;
}
