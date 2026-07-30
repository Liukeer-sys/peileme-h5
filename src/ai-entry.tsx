import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import AiShell from "./ai/AiShell";
import { AuthProvider } from "./auth/AuthContext";
import { productChannel } from "./product-channel";
import "./styles.css";
import "./admin/admin.css";
import "./ai/ai.css";

const AdminDashboard = lazy(() => import("./admin/AdminDashboard"));

if (productChannel !== "ai") {
  throw new Error("The AI entry requires the AI product channel");
}

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element #root was not found.");
}

createRoot(rootElement).render(
  <StrictMode>
    <AuthProvider>
      {window.location.pathname.startsWith("/admin") ? (
        <Suspense
          fallback={<main className="admin-login-state">正在加载管理后台…</main>}
        >
          <AdminDashboard />
        </Suspense>
      ) : (
        <AiShell />
      )}
    </AuthProvider>
  </StrictMode>
);
