import { useState, type CSSProperties } from "react";
import type { XiaoPeiAvatarState } from "../constants/xiaopeiAvatarStates";
import questionAvatar from "../assets/xiaopei/question.png";
import smirkAvatar from "../assets/xiaopei/smirk.png";
import roastAvatar from "../assets/xiaopei/roast.png";
import shockedAvatar from "../assets/xiaopei/shocked.png";
import normalAvatar from "../assets/xiaopei/normal.png";

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
  idle: questionAvatar,
  smirk: smirkAvatar,
  eye_roll: roastAvatar,
  shocked: shockedAvatar,
  angry: roastAvatar,
  calculating: normalAvatar,
  warning: roastAvatar,
  result: smirkAvatar
};

function AvatarImage({ src, size }: { src: string; size: number }) {
  const [failureCount, setFailureCount] = useState(0);
  const currentSrc = failureCount === 0 ? src : normalAvatar;

  // 备用图片也失败时使用不依赖网络的占位，避免无限重试和整块留白。
  if (failureCount >= 2 || (failureCount === 1 && src === normalAvatar)) {
    return <span className="xiaopei-face xiaopei-face-fallback" aria-hidden="true">赔</span>;
  }
  return (
    <img
      className="xiaopei-face"
      src={currentSrc}
      width={size}
      height={size}
      loading="eager"
      decoding="async"
      alt=""
      aria-hidden="true"
      onError={() => setFailureCount((count) => count + 1)}
    />
  );
}

export default function XiaoPeiAvatar({ state, showName = false, size = 34 }: XiaoPeiAvatarProps) {
  const imageSrc = avatarImageByState[state] || questionAvatar;

  return (
    <div
      className={`xiaopei-avatar xiaopei-${state}`}
      style={{ width: size, "--xp-size": `${size}px` } as CSSProperties}
      aria-label={`小赔头像，${stateLabel[state]}形态`}
      role="img"
    >
      {showName && <span className="xiaopei-name">小赔</span>}
      <AvatarImage key={imageSrc} src={imageSrc} size={size} />
    </div>
  );
}
