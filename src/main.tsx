import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { StandaloneDocumentReview } from "./components/DocumentReview";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element #root was not found.");
}

createRoot(rootElement).render(
  <StrictMode>
    {new URLSearchParams(window.location.search).get("document-review") === "1"
      ? <main className="review-standalone"><article className="paid-card"><h1>签前文件检查</h1><StandaloneDocumentReview /></article></main>
      : <App />}
  </StrictMode>
);
