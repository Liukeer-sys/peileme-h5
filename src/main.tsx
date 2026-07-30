import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";
import "./styles.css";
import "./admin/admin.css";

const AdminDashboard = lazy(() => import("./admin/AdminDashboard"));

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element #root was not found.");
}

createRoot(rootElement).render(
  <StrictMode>
    <AuthProvider>
      {window.location.pathname.startsWith("/admin") ? (
        <Suspense fallback={<main className="admin-login-state">正在加载管理后台…</main>}>
          <AdminDashboard />
        </Suspense>
      ) : (
        <App />
      )}
    </AuthProvider>
  </StrictMode>
);
