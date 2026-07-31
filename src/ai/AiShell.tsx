import { useState } from "react";
import { useAuth } from "../auth/AuthContext";
import AuthModal from "../components/AuthModal";
import AiAccountPanel from "./AiAccountPanel";

export default function AiShell() {
  const { user, ready } = useAuth();
  const [authOpen, setAuthOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  const openWorkspace = () => {
    if (user) {
      setAccountOpen(true);
      return;
    }
    setAuthOpen(true);
  };

  return (
    <>
      <main className="app-shell">
        <section className="phone-frame">
        <header className="topbar">
          <div>
            <span className="brand-dot" />
            <strong>赔了么 AI</strong>
          </div>
          <div className="ai-top-actions">
            <a className="mini-button" href="https://peileme.art">
              政策测算
            </a>
            <button
              className="mini-button"
              type="button"
              disabled={!ready}
              onClick={openWorkspace}
            >
              {user ? user.displayName || "个人中心" : "登录"}
            </button>
          </div>
        </header>
        <section className="ai-intro">
          <span className="status-pill">AI 深度分析版</span>
          <h1>把材料、金额和风险一次讲清楚</h1>
          <p>先安全保存劳动文件。完整 AI 审查正在接入，当前版本不会生成未经分析的结论。</p>
          <button className="primary-button ai-workspace-button" type="button" onClick={openWorkspace}>
            {user ? "打开材料中心" : "登录并上传材料"}
          </button>
        </section>
        </section>
      </main>
      <AuthModal
        open={authOpen}
        description="登录后可安全管理你上传的材料，并在 AI 能力上线后查看分析任务。"
        privacyNote="验证码仅用于身份验证。材料默认私有保存，可随时在个人中心查看。"
        onClose={() => setAuthOpen(false)}
      />
      <AiAccountPanel
        key={user?.id ?? "signed-out"}
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
      />
    </>
  );
}
