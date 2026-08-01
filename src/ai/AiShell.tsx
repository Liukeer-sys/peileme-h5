import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import AuthModal from "../components/AuthModal";
import AnnouncementBanner from "../components/AnnouncementBanner";
import MainApp from "../main/MainApp";
import AiAccountPanel from "./AiAccountPanel";
import AiAnalysisWorkspace from "./AiAnalysisWorkspace";

export default function AiShell() {
  const { user, ready } = useAuth();
  const [authOpen, setAuthOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [policyAccountRequestKey, setPolicyAccountRequestKey] = useState(0);
  const [activeView, setActiveView] = useState<"ai" | "policy">(
    window.location.pathname.startsWith("/policy") ? "policy" : "ai"
  );

  useEffect(() => {
    const syncView = () => setActiveView(
      window.location.pathname.startsWith("/policy") ? "policy" : "ai"
    );
    window.addEventListener("popstate", syncView);
    return () => window.removeEventListener("popstate", syncView);
  }, []);

  const navigate = (view: "ai" | "policy") => {
    const path = view === "policy" ? "/policy" : "/";
    if (window.location.pathname !== path) {
      window.history.pushState({}, "", path);
    }
    setActiveView(view);
  };

  const openWorkspace = () => {
    if (activeView === "policy") {
      setPolicyAccountRequestKey((requestKey) => requestKey + 1);
      return;
    }
    if (user) {
      setAccountOpen(true);
      return;
    }
    setAuthOpen(true);
  };

  return (
    <>
      <main className="app-shell">
        <section className={`phone-frame${user || activeView === "policy" ? " ai-phone-workspace" : ""}`}>
        <header className="topbar">
          <div>
            <span className="brand-dot" />
            <strong>赔了么 AI</strong>
          </div>
          <div className="ai-top-actions">
            <nav aria-label="赔了么 AI 功能">
              <a
                className="mini-button"
                href="/"
                aria-pressed={activeView === "ai"}
                onClick={(event) => {
                  event.preventDefault();
                  navigate("ai");
                }}
              >
                AI 深度分析
              </a>
              <a
                className="mini-button"
                href="/policy"
                aria-pressed={activeView === "policy"}
                onClick={(event) => {
                  event.preventDefault();
                  navigate("policy");
                }}
              >
                政策测算
              </a>
            </nav>
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
        <AnnouncementBanner />
        {activeView === "policy" ? (
          <MainApp
            embedded
            accountRequestKey={policyAccountRequestKey}
          />
        ) : user ? (
          <AiAnalysisWorkspace key={user.id} refreshKey={workspaceRevision} />
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
        description="登录后可进行离职补偿分析、文件签署审查和政策测算，并查看完整历史。"
        privacyNote="验证码仅用于身份验证。材料默认私有保存，可随时在个人中心查看。"
        onClose={() => setAuthOpen(false)}
      />
      <AiAccountPanel
        key={user?.id ?? "signed-out"}
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
        onJobCreated={() => setWorkspaceRevision((revision) => revision + 1)}
      />
    </>
  );
}
