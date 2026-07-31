import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { createProductBoundaryPlugin } from "./vite.product-boundary";

export default defineConfig({
  plugins: [react(), createProductBoundaryPlugin("main")],
  define: {
    "import.meta.env.VITE_PRODUCT_CHANNEL": JSON.stringify("main")
  },
  build: {
    outDir: "dist-main",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-dom/client"],
          motion: ["motion"]
        }
      }
    }
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: process.env.VITE_API_PROXY_TARGET
      ? {
          "/api": {
            target: process.env.VITE_API_PROXY_TARGET,
            changeOrigin: true
          }
        }
      : undefined
  }
});
