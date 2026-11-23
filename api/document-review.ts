import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_REQUEST_BYTES } from "../shared/documentReview.js";
import { analyzeDocument, ReviewError, validateInput } from "../server/documentReview.js";

export const config = { maxDuration: 60 };
// Local fallback only. Production uses Vercel Firewall across instances.
const localHits = new Map<string, { count: number; until: number }>();
export function localRateLimit(key: string, now = Date.now()): boolean {
  for (const [ip, hit] of localHits) if (hit.until <= now) localHits.delete(ip);
  const hit = localHits.get(key) ?? { count: 0, until: now + 60_000 };
  if (localHits.size >= 10_000 && !localHits.has(key)) return false;
  hit.count++;
  localHits.set(key, hit);
  return hit.count <= 3;
}

export default async function handler(req: IncomingMessage & { body?: unknown }, res: ServerResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const send = (status: number, data: unknown) => { res.statusCode = status; res.end(JSON.stringify(data)); };
  try {
    if (req.method !== "POST") { res.setHeader("Allow", "POST"); throw new ReviewError(405, "METHOD", "仅支持 POST 请求。"); }
    if (!req.headers["content-type"]?.startsWith("application/json")) throw new ReviewError(415, "CONTENT_TYPE", "请使用 JSON 提交文件。");
    if (Number(req.headers["content-length"]) > MAX_REQUEST_BYTES) throw new ReviewError(413, "TOO_LARGE", "请求过大，请减少图片体积。");
    // Fail closed until the deployer confirms the platform rule exists.
    if (process.env.VERCEL === "1") {
      if (process.env.DOCUMENT_REVIEW_RATE_LIMIT_READY !== "true") throw new ReviewError(503, "RATE_LIMIT_NOT_CONFIGURED", "分析服务尚未完成上线配置。");
    } else if (!localRateLimit(req.socket.remoteAddress ?? "local")) {
      res.setHeader("Retry-After", "60");
      throw new ReviewError(429, "RATE_LIMIT", "操作频繁，请一分钟后重试。");
    }
    let body: unknown = req.body;
    if (body === undefined) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_REQUEST_BYTES) throw new ReviewError(413, "TOO_LARGE", "请求过大，请减少图片体积。");
        chunks.push(bytes);
      }
      body = Buffer.concat(chunks).toString("utf8");
    }
    if (Buffer.isBuffer(body)) body = body.toString("utf8");
    if (typeof body === "string") {
      if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new ReviewError(413, "TOO_LARGE", "请求过大。");
      try { body = JSON.parse(body); } catch { throw new ReviewError(400, "INVALID_JSON", "请求格式错误，请重新提交。"); }
    }
    const input = await validateInput(body);
    send(200, await analyzeDocument(input));
  } catch (error) {
    const known = error instanceof ReviewError ? error : new ReviewError(500, "INTERNAL", "分析失败，请稍后重试。");
    // Never log uploaded images, provider bodies, or report content.
    send(known.status, { error: { code: known.code, message: known.message } });
  }
}
