import type { CSSProperties } from "react";
import type { XiaoPeiAvatarState } from "../constants/xiaopeiAvatarStates";

type XiaoPeiAvatarProps = {
  state: XiaoPeiAvatarState;
  showName?: boolean;
  size?: number;
};

const stateLabel: Record<XiaoPeiAvatarState, string> = {
  idle: "待机",
  smirk: "坏笑",
  eye_roll: "无语",
  shocked: "震惊",
  angry: "生气",
  calculating: "计算中",
  warning: "警惕",
  result: "得出结果"
};

function Eyes({ state }: { state: XiaoPeiAvatarState }) {
  if (state === "eye_roll") {
    return (
      <g className="xp-eyes xp-eyes-roll">
        <ellipse cx="43" cy="51" rx="10" ry="12" />
        <ellipse cx="71" cy="51" rx="10" ry="12" />
        <circle cx="43" cy="45" r="3.5" />
        <circle cx="71" cy="45" r="3.5" />
      </g>
    );
  }

  if (state === "shocked") {
    return (
      <g className="xp-eyes xp-eyes-wide">
        <circle cx="43" cy="52" r="11" />
        <circle cx="71" cy="52" r="11" />
        <circle cx="43" cy="52" r="4" />
        <circle cx="71" cy="52" r="4" />
      </g>
    );
  }

  if (state === "angry" || state === "warning") {
    return (
      <g className="xp-eyes xp-eyes-focused">
        <path d="M34 48c7 4 14 5 21 2" />
        <path d="M62 50c7 3 14 2 21-2" />
      </g>
    );
  }

  if (state === "calculating") {
    return (
      <g className="xp-eyes xp-eyes-calc">
        <rect x="34" y="45" width="19" height="13" rx="6" />
        <rect x="62" y="45" width="19" height="13" rx="6" />
        <path d="M53 51h9" />
      </g>
    );
  }

  if (state === "result") {
    return (
      <g className="xp-eyes xp-eyes-result">
        <path d="M34 50c6-5 14-5 20 0" />
        <path d="M63 50c6-5 14-5 20 0" />
      </g>
    );
  }

  return (
    <g className={state === "smirk" ? "xp-eyes xp-eyes-smirk" : "xp-eyes xp-eyes-idle"}>
      <ellipse cx="43" cy="51" rx="7" ry="9" />
      <ellipse cx="71" cy="51" rx="7" ry="9" />
    </g>
  );
}

function Brows({ state }: { state: XiaoPeiAvatarState }) {
  if (state === "smirk") {
    return (
      <g className="xp-brows">
        <path d="M33 39c7-4 14-4 20 0" />
        <path d="M63 37c8-5 16-4 22 2" />
      </g>
    );
  }

  if (state === "angry" || state === "warning") {
    return (
      <g className="xp-brows xp-brows-sharp">
        <path d="M32 39l21 8" />
        <path d="M84 39l-21 8" />
      </g>
    );
  }

  if (state === "shocked") {
    return (
      <g className="xp-brows">
        <path d="M33 35c7-5 15-5 22 0" />
        <path d="M61 35c7-5 15-5 22 0" />
      </g>
    );
  }

  return null;
}

function Mouth({ state }: { state: XiaoPeiAvatarState }) {
  if (state === "smirk") return <path className="xp-mouth" d="M43 70c9 8 23 8 31-3" />;
  if (state === "eye_roll") return <path className="xp-mouth" d="M45 73h25" />;
  if (state === "shocked") return <ellipse className="xp-mouth-fill" cx="57" cy="73" rx="8" ry="11" />;
  if (state === "angry") return <path className="xp-mouth" d="M43 76c9-7 21-7 30 0" />;
  if (state === "calculating") return <path className="xp-mouth" d="M47 73c7 3 14 3 21 0" />;
  if (state === "warning") return <path className="xp-mouth" d="M45 73h24" />;
  if (state === "result") return <path className="xp-mouth" d="M42 68c9 12 24 12 33 0" />;
  return <path className="xp-mouth" d="M45 70c7 7 18 7 25 0" />;
}

function StateMark({ state }: { state: XiaoPeiAvatarState }) {
  if (state === "calculating") {
    return (
      <g className="xp-mark xp-mark-calc">
        <circle cx="92" cy="34" r="3" />
        <circle cx="100" cy="34" r="3" />
        <circle cx="108" cy="34" r="3" />
      </g>
    );
  }

  if (state === "warning") {
    return (
      <g className="xp-mark xp-mark-warning">
        <path d="M98 23l12 22H86z" />
        <path d="M98 30v8" />
        <circle cx="98" cy="41" r="1.4" />
      </g>
    );
  }

  if (state === "angry") {
    return (
      <g className="xp-mark xp-mark-angry">
        <path d="M88 24l8 6-6 3 7 7" />
      </g>
    );
  }

  if (state === "result") {
    return (
      <g className="xp-mark xp-mark-result">
        <path d="M89 31l6 6 13-14" />
      </g>
    );
  }

  return null;
}

export default function XiaoPeiAvatar({ state, showName = false, size = 34 }: XiaoPeiAvatarProps) {
  return (
    <div
      className={`xiaopei-avatar xiaopei-${state}`}
      style={{ width: size, "--xp-size": `${size}px` } as CSSProperties}
      aria-label={`小赔头像，${stateLabel[state]}表情`}
      role="img"
    >
      {showName && <span className="xiaopei-name">小赔</span>}
      <svg className="xiaopei-face" viewBox="0 0 116 116" aria-hidden="true">
        <defs>
          <radialGradient id={`xp-glow-${state}`} cx="35%" cy="25%" r="75%">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset=".45" stopColor="#f4efff" />
            <stop offset="1" stopColor="#d8f1dd" />
          </radialGradient>
          <linearGradient id={`xp-rim-${state}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#bca8f0" />
            <stop offset="1" stopColor="#8ccf99" />
          </linearGradient>
        </defs>
        <ellipse className="xp-shadow" cx="58" cy="101" rx="33" ry="8" />
        <circle className="xp-body" cx="58" cy="58" r="45" fill={`url(#xp-glow-${state})`} />
        <circle className="xp-rim" cx="58" cy="58" r="45" stroke={`url(#xp-rim-${state})`} />
        <path className="xp-highlight" d="M31 35c8-13 22-20 38-19" />
        <Brows state={state} />
        <Eyes state={state} />
        <Mouth state={state} />
        <StateMark state={state} />
      </svg>
    </div>
  );
}

