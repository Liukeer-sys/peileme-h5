import { unzipSync, strFromU8 } from "fflate";
import { PDFDocument } from "pdf-lib";
import { MAX_DOCUMENT_BYTES, MAX_PDF_PAGES } from "./documentReview.js";

export async function inspectDocument(bytes: Uint8Array, kind: "pdf" | "docx"): Promise<{ pageCount: number | null; text: string }> {
  if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES) throw new Error("PDF / DOCX 文件最大约 2.9 MB，请压缩后重试。");
  if (kind === "pdf") {
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new Error("文件内容不是有效 PDF。");
    let pdf: PDFDocument;
    try { pdf = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true }); }
    catch { throw new Error("PDF 无法读取或已加密，请使用未加密的完整文件。"); }
    const pageCount = pdf.getPageCount();
    if (pageCount < 1 || pageCount > MAX_PDF_PAGES) throw new Error(`PDF 请控制在 1–${MAX_PDF_PAGES} 页。`);
    return { pageCount, text: "" };
  }
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error("文件内容不是有效 DOCX。");
  let total = 0;
  const entries = unzipSync(bytes, { filter: entry => {
    total += entry.originalSize;
    if (total > 20_000_000 || entry.originalSize > 8_000_000) throw new Error("Word 解压内容过大，请精简后重试。");
    if (/vbaProject|\.bin$/i.test(entry.name)) throw new Error("暂不支持含宏或嵌入对象的 Word 文件，请另存为 PDF。");
    return entry.name === "word/document.xml" || entry.name === "[Content_Types].xml";
  } });
  if (!entries["word/document.xml"] || !entries["[Content_Types].xml"]) throw new Error("DOCX 结构不完整，请另存为 DOCX 或 PDF。");
  const xml = strFromU8(entries["word/document.xml"]);
  if (!/<(?:\w+:)?document[\s>]/.test(xml)) throw new Error("Word 正文结构无效。");
  return { pageCount: null, text: xml };
}
