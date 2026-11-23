import { createServer } from "node:http";
import { createServer as createViteServer, loadEnv } from "vite";
import handler from "../api/document-review.js";

Object.assign(process.env, loadEnv("development", process.cwd(), ""));
const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
const server = createServer((req, res) => {
  if (req.url?.split("?")[0] === "/api/document-review") void handler(req, res);
  else vite.middlewares(req, res);
});
server.requestTimeout = 75_000;
server.listen(5173, "127.0.0.1", () => console.log("本地完整测试：http://localhost:5173/?document-review=1"));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void vite.close(); server.close(); });
