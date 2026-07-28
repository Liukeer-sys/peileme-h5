import type { ReactNode } from "react";
import type { XiaoPeiAvatarState } from "../constants/xiaopeiAvatarStates";
import { defaultXiaoPeiAvatarState } from "../constants/xiaopeiAvatarStates";
import XiaoPeiAvatar from "./XiaoPeiAvatar";

type ChatBubbleProps = {
  from: "system" | "user";
  children: ReactNode;
  muted?: boolean;
  avatarState?: XiaoPeiAvatarState;
};

export default function ChatBubble({ from, children, muted, avatarState }: ChatBubbleProps) {
  return (
    <div className={`bubble-row ${from}`}>
      {from === "system" && (
        <XiaoPeiAvatar state={avatarState || defaultXiaoPeiAvatarState} showName size={34} />
      )}
      <div className={`chat-bubble ${from} ${muted ? "muted" : ""}`}>{children}</div>
    </div>
  );
}
