// Explicit paid live regression for the actual production adapter. Synthetic files only.
import { readFile } from "node:fs/promises";
import { loadEnv } from "vite";
import { validateInput, analyzeDocument } from "../server/documentReview.js";

if (!process.argv.includes("--call")) throw new Error("请显式添加 --call；此脚本会产生 API 用量。");
const env = loadEnv("development", process.cwd(), "");
if (new URL(env.AI_BASE_URL).hostname !== "api.tu-zi.com") throw new Error("仅允许已选择的 Tuzi 服务。");
for (const kind of ["pdf", "docx"] as const) {
  const bytes = await readFile(`work/file-input-smoke/synthetic.${kind}`);
  const input = await validateInput({ file: { name: `synthetic.${kind}`, kind, data: bytes.toString("base64") }, confirmed: true });
  const start = Date.now();
  try {
    const result = await analyzeDocument(input, { env });
    console.log(JSON.stringify({ kind, ok: true, seconds: Math.round((Date.now() - start) / 1000), issues: result.issues.map(issue => ({ title: issue.title, pages: issue.pages, quote: issue.quote })), limitations: result.limitations }));
  } catch (error) {
    const known = error as { status?: number; code?: string };
    console.log(JSON.stringify({ kind, ok: false, status: known.status, code: known.code }));
    process.exitCode = 1;
  }
}
