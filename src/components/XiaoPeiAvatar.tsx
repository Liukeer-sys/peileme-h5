import type { CSSProperties } from "react";
import type { XiaoPeiAvatarState } from "../constants/xiaopeiAvatarStates";

type XiaoPeiAvatarProps = {
  state: XiaoPeiAvatarState;
  showName?: boolean;
  size?: number;
};

const stateLabel: Record<XiaoPeiAvatarState, string> = {
  idle: "发问",
  smirk: "得意",
  eye_roll: "吐槽",
  shocked: "震惊",
  angry: "吐槽",
  calculating: "正常",
  warning: "吐槽",
  result: "得意"
};

const avatarImageByState: Record<XiaoPeiAvatarState, string> = {
  idle: "发问1.png",
  smirk: "得意1.png",
  eye_roll: "吐槽1.png",
  shocked: "震惊1.png",
  angry: "吐槽1.png",
  calculating: "正常1.png",
  warning: "吐槽1.png",
  result: "得意1.png"
};

export default function XiaoPeiAvatar({ state, showName = false, size = 34 }: XiaoPeiAvatarProps) {
  const imageSrc = `/head/${encodeURIComponent(avatarImageByState[state])}`;

  return (
    <div
      className={`xiaopei-avatar xiaopei-${state}`}
      style={{ width: size, "--xp-size": `${size}px` } as CSSProperties}
      aria-label={`小赔头像，${stateLabel[state]}形态`}
      role="img"
    >
      {showName && <span className="xiaopei-name">小赔</span>}
      <img className="xiaopei-face" src={imageSrc} alt="" aria-hidden="true" />
    </div>
  );
}
