import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import MainApp from "./main/MainApp";
import { AuthProvider } from "./auth/AuthContext";
import { productChannel } from "./product-channel";
import "./styles.css";
import "./admin/admin.css";

const AdminDashboard = lazy(() => import("./admin/AdminDashboard"));

if (productChannel !== "main") {
  throw new Error("The main entry requires the main product channel");
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
        <MainApp />
      )}
    </AuthProvider>
  </StrictMode>
);
