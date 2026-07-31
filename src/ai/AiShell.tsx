import { useState } from "react";
import { useAuth } from "../auth/AuthContext";
import AuthModal from "../components/AuthModal";
import AiAccountPanel from "./AiAccountPanel";
import AiAnalysisWorkspace from "./AiAnalysisWorkspace";

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
        <section className={`phone-frame${user ? " ai-phone-workspace" : ""}`}>
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
        {user ? (
          <AiAnalysisWorkspace key={user.id} />
        ) : (
          <section className="ai-intro">
            <span className="status-pill">AI 深度分析版</span>
            <h1>把材料、金额和风险一次讲清楚</h1>
            <p>登录后可以做离职补偿深度分析，也可以上传劳动合同、解除协议等材料做签署前审查。</p>
            <button className="primary-button ai-workspace-button" type="button" onClick={openWorkspace}>
              登录并开始分析
            </button>
          </section>
        )}
        </section>
      </main>
      <AuthModal
        open={authOpen}
        description="登录后可进行离职补偿分析、文件签署审查，并查看完整历史。"
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
