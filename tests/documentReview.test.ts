import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { zipSync, strToU8 } from "fflate";
import handler, { localRateLimit } from "../api/document-review.js";
import { analyzeDocument, REVIEW_PROMPT, validateInput } from "../server/documentReview.js";
import { parseReviewResult } from "../shared/documentReview.js";

const issue = { title: "支付时间待明确", priority: "high", pages: [1], quote: "交接后支付", explanation: "请确认具体时间", question_to_hr: "能否写明到账日期？" };
const env = { AI_API_KEY: "test-secret", AI_MODEL: "test-vision", AI_BASE_URL: "https://example.com/v1" };
const validInput = { images: ["data:image/jpeg;base64,dGVzdA=="], confirmed: true as const };
const completion = (content: unknown, finish_reason = "stop") => new Response(JSON.stringify({ choices: [{ finish_reason, message: { content: JSON.stringify(content) } }] }));

test("允许空问题列表和无法可靠引用时的 null", () => {
  assert.deepEqual(parseReviewResult({ issues: [], limitations: [] }, 1), { issues: [], limitations: [] });
  assert.equal(parseReviewResult({ issues: [{ ...issue, quote: null }], limitations: ["第1张下半部分模糊"] }, 1).issues[0].quote, null);
});
test("越界页码、缺字段和无效优先级不能转换成无问题结果", () => {
  for (const invalid of [{ ...issue, pages: [2] }, { ...issue, pages: [] }, { ...issue, quote: "" }, { ...issue, priority: "safe" }, { ...issue, explanation: undefined }]) {
    assert.throws(() => parseReviewResult({ issues: [invalid], limitations: [] }, 1));
  }
  assert.throws(() => parseReviewResult({}, 1));
});
test("上传校验实际解码图片并拒绝伪装、缺少确认、超量和网址", async () => {
  const bytes = await sharp({ create: { width: 20, height: 30, channels: 3, background: "white" } }).png().toBuffer();
  const image = `data:image/png;base64,${bytes.toString("base64")}`;
  assert.equal((await validateInput({ images: [image], confirmed: true })).images?.length, 1);
  for (const value of [validInput, { images: [image], confirmed: false }, { images: Array(7).fill(image), confirmed: true }, { images: ["https://example.com/image.png"], confirmed: true }, { images: [image.replace("image/png", "image/jpeg")], confirmed: true }]) {
    await assert.rejects(validateInput(value));
  }
});

async function documentInput(kind: "pdf" | "docx") {
  let bytes: Uint8Array;
  if (kind === "pdf") { const pdf = await PDFDocument.create(); pdf.addPage(); bytes = await pdf.save(); }
  else bytes = zipSync({ "[Content_Types].xml": strToU8('<Types/>'), "word/document.xml": strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Test</w:t></w:r></w:p></w:body></w:document>') });
  return { file: { name: `test.${kind}`, kind, data: Buffer.from(bytes).toString("base64") }, confirmed: true as const };
}
test("PDF/DOCX 真实结构通过校验，伪装文件和混传被拒绝", async () => {
  for (const kind of ["pdf", "docx"] as const) {
    const input = await documentInput(kind);
    assert.equal((await validateInput(input)).file?.kind, kind);
    await assert.rejects(validateInput({ ...input, images: validInput.images }));
    await assert.rejects(validateInput({ ...input, file: { ...input.file, data: Buffer.from("not a document").toString("base64") } }));
  }
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 21; i++) pdf.addPage();
  await assert.rejects(validateInput({ confirmed: true, file: { name: "long.pdf", kind: "pdf", data: Buffer.from(await pdf.save()).toString("base64") } }));
});
test("PDF 一次走 Chat 文件输入，DOCX 一次走 Responses；Word 不接收猜测页码", async () => {
  for (const kind of ["pdf", "docx"] as const) {
    const input = await documentInput(kind);
    let calls = 0;
    const result = await analyzeDocument(input, { env, fetcher: async (url, options) => {
      calls++;
      const body = JSON.parse(String(options?.body));
      if (kind === "pdf") {
        assert.ok(String(url).endsWith("/chat/completions"));
        assert.equal(body.messages[1].content[0].type, "file");
        return completion({ issues: [issue], limitations: [] });
      }
      assert.ok(String(url).endsWith("/responses"));
      assert.equal(body.store, false);
      assert.equal(body.input[0].content[1].type, "input_file");
      assert.ok(body.instructions.includes("pages 必须是空数组"));
      return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ issues: [{ ...issue, pages: [] }], limitations: [] }) }] }] }));
    } });
    assert.equal(calls, 1);
    assert.equal(result.issues.length, 1);
  }
  assert.throws(() => parseReviewResult({ issues: [issue], limitations: [] }, null));
  assert.doesNotThrow(() => parseReviewResult({ issues: [{ ...issue, pages: [] }], limitations: [] }, null));
});
test("Responses 截断或拒绝不能当成无问题", async () => {
  const input = await documentInput("docx");
  for (const data of [{ status: "incomplete", output: [] }, { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }]) {
    await assert.rejects(analyzeDocument(input, { env, fetcher: async () => new Response(JSON.stringify(data)) }), { status: 502 });
  }
});
test("一次模型调用包含所有图片、系统防注入规则，且不包含问卷背景", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(String(url), "https://example.com/v1/chat/completions");
    const body = JSON.parse(String(options?.body));
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages[0].content, REVIEW_PROMPT);
    assert.equal(body.messages[1].content.filter((part: { type: string }) => part.type === "image_url").length, 2);
    assert.equal(body.answers, undefined);
    return completion({ issues: [issue], limitations: [] });
  };
  await analyzeDocument({ ...validInput, images: [...validInput.images, ...validInput.images] }, { env, fetcher });
  assert.equal(calls, 1);
});
test("缺少配置、模型截断、错误JSON、上游限流和超时均明确失败", async () => {
  await assert.rejects(analyzeDocument(validInput, { env: {} }), { status: 503 });
  await assert.rejects(analyzeDocument(validInput, { env, fetcher: async () => completion({ issues: [], limitations: [] }, "length") }), { status: 502 });
  await assert.rejects(analyzeDocument(validInput, { env, fetcher: async () => completion({}) }), { status: 502 });
  await assert.rejects(analyzeDocument(validInput, { env, fetcher: async () => new Response("private provider detail", { status: 429 }) }), { status: 429 });
  await assert.rejects(analyzeDocument(validInput, { env, fetcher: async () => { throw new DOMException("timeout", "TimeoutError"); } }), { status: 504 });
});
test("本地限流达到阈值返回拒绝，窗口结束后恢复", () => {
  assert.equal(localRateLimit("test-ip", 1000), true);
  assert.equal(localRateLimit("test-ip", 1001), true);
  assert.equal(localRateLimit("test-ip", 1002), true);
  assert.equal(localRateLimit("test-ip", 1003), false);
  assert.equal(localRateLimit("test-ip", 61_001), true);
});
test("真实 HTTP 路由处理方法、格式错误及线上未配置限流", async () => {
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/document-review`;
  const oldVercel = process.env.VERCEL;
  const oldReady = process.env.DOCUMENT_REVIEW_RATE_LIMIT_READY;
  try {
    const response = await fetch(url);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(url, { method: "POST", body: "x" })).status, 415);
    process.env.VERCEL = "1";
    process.env.DOCUMENT_REVIEW_RATE_LIMIT_READY = "false";
    assert.equal((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 503);
    process.env.DOCUMENT_REVIEW_RATE_LIMIT_READY = "true";
    const invalid = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, "INVALID_JSON");
  } finally {
    if (oldVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = oldVercel;
    if (oldReady === undefined) delete process.env.DOCUMENT_REVIEW_RATE_LIMIT_READY; else process.env.DOCUMENT_REVIEW_RATE_LIMIT_READY = oldReady;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
