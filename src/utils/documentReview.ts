import { MAX_PAGES, MAX_REQUEST_BYTES, MAX_SOURCE_BYTES, parseReviewResult, type ReviewResult, type ReviewFile, type ReviewInput } from "../../shared/documentReview";

export async function prepareDocument(file: File) {
  const kind = file.name.toLowerCase().endsWith(".pdf") ? "pdf" : "docx";
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { inspectDocument } = await import("../../shared/documentFiles");
  const info = await inspectDocument(bytes, kind);
  let binary = "";
  for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  let text = "";
  if (kind === "docx") {
    const xml = new DOMParser().parseFromString(info.text, "application/xml");
    if (xml.querySelector("parsererror")) throw new Error("Word 正文无法解析，请另存为 PDF 后上传。");
    text = Array.from(xml.getElementsByTagNameNS("*", "p")).map(p => Array.from(p.getElementsByTagNameNS("*", "t")).map(t => t.textContent).join("")).join("\n");
  }
  return { file: { name: file.name, kind, data: btoa(binary) } as ReviewFile, pageCount: info.pageCount, text };
}

export async function prepareImage(file: File): Promise<string> {
  if (!["image/jpeg", "image/png"].includes(file.type) || file.size > MAX_SOURCE_BYTES) {
    throw new Error("请选择 20 MB 以内的 JPG、PNG 照片。PDF 请先逐页截图。");
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth * img.naturalHeight > 50_000_000) throw new Error("图片尺寸过大，请缩小后重试。");
    const scale = Math.min(1, 2200 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("当前浏览器无法处理图片。");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    // Keep text legible; do not repeatedly compress to force oversized uploads through.
    return canvas.toDataURL("image/jpeg", 0.88);
  } finally { URL.revokeObjectURL(url); }
}

export async function reviewImages(images: string[], signal: AbortSignal): Promise<ReviewResult> {
  if (!images.length || images.length > MAX_PAGES) throw new Error(`请上传 1–${MAX_PAGES} 张图片。`);
  return reviewInput({ images, confirmed: true }, images.length, signal);
}

export async function reviewInput(input: ReviewInput, pageCount: number | null, signal: AbortSignal): Promise<ReviewResult> {
  const body = JSON.stringify(input);
  if (new TextEncoder().encode(body).length > MAX_REQUEST_BYTES) throw new Error("处理后的图片总大小仍然过大，请缩小照片后重试，确保文字清晰。");
  const response = await fetch("/api/document-review", {
    method: "POST", headers: { "Content-Type": "application/json" }, body, signal
  });
  let data;
  try { data = await response.json(); }
  catch { throw new Error(response.status === 413 ? "图片总大小超出服务限制。" : "服务响应异常，请确认已启动完整测试服务，再重试。"); }
  if (!response.ok) throw new Error(data?.error?.message ?? "分析失败，请稍后重试。");
  return parseReviewResult(data, pageCount);
}
