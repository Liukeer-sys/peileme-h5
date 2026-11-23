import { useEffect, useRef, useState } from "react";
import { MAX_PAGES, MAX_DOCUMENT_BYTES, type ReviewResult, type ReviewFile } from "../../shared/documentReview";
import { prepareImage, prepareDocument, reviewInput } from "../utils/documentReview";
import ModuleUnlockDialog from "./ModuleUnlockDialog";

type Page = { id: string; name: string; original: string; image: string };
type Attachment = { file: ReviewFile; pageCount: number | null; text: string; original: string };
type Props = { unlocked?: boolean; onUnlock?: () => void };
const priorityLabel = { high: "优先核对", medium: "建议核对", low: "留意一下" };

export function StandaloneDocumentReview() {
  const [unlocked, setUnlocked] = useState(false);
  const [showUnlock, setShowUnlock] = useState(false);
  return <>
    <DocumentReview unlocked={unlocked} onUnlock={() => setShowUnlock(true)} />
    {showUnlock && <ModuleUnlockDialog onClose={() => setShowUnlock(false)} onConfirm={() => { setUnlocked(true); setShowUnlock(false); }} />}
  </>;
}

export default function DocumentReview({ unlocked = true, onUnlock }: Props) {
  const [pages, setPages] = useState<Page[]>([]);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<"preparing" | "analyzing" | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const urls = useRef(new Set<string>());
  const mounted = useRef(true);
  const operation = useRef(false);
  const closePreview = useRef<HTMLButtonElement>(null);
  const previewDialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!preview) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closePreview.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreview(null);
      if (event.key === "Tab") {
        const focusable = previewDialog.current?.querySelectorAll<HTMLElement>('button, a[href], iframe');
        if (!focusable?.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); document.body.style.overflow = overflow; previous?.focus(); };
  }, [preview]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      urls.current.forEach(url => URL.revokeObjectURL(url));
      urls.current.clear();
    };
  }, []);
  const invalidate = () => { setConfirmed(false); setResult(null); setError(""); };
  const addFiles = async (files: File[]) => {
    if (!files.length || operation.current) return;
    const documentFiles = files.filter(file => /\.(pdf|docx)$/i.test(file.name));
    if (files.some(file => /\.doc$/i.test(file.name))) { setError("暂不支持旧版 .doc，请另存为 DOCX 或 PDF。"); return; }
    if (documentFiles.length) {
      if (files.length !== 1 || pages.length || attachment) { setError("每次检查一份 PDF / DOCX，或同一份文件的多张照片。请先删除已选内容再切换。"); return; }
      if (files[0].size > MAX_DOCUMENT_BYTES || files[0].name.length > 200) { setError("文件最大约 2.9 MB，文件名不超过 200 个字符。"); return; }
      operation.current = true; setBusy("preparing"); setError("");
      try {
        const prepared = await prepareDocument(files[0]);
        if (!mounted.current) return;
        const original = URL.createObjectURL(files[0]); urls.current.add(original);
        invalidate(); setAttachment({ ...prepared, original });
      } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "文件读取失败。"); }
      finally { operation.current = false; if (mounted.current) setBusy(null); }
      return;
    }
    if (attachment) { setError("请先删除当前文件，再选择照片。"); return; }
    if (pages.length + files.length > MAX_PAGES) { setError(`最多上传 ${MAX_PAGES} 张照片。`); return; }
    operation.current = true;
    setBusy("preparing"); setError("");
    const added: Page[] = [];
    try {
      for (const file of files) {
        const image = await prepareImage(file);
        if (!mounted.current) return;
        const original = URL.createObjectURL(file);
        urls.current.add(original);
        added.push({ id: crypto.randomUUID(), name: file.name, image, original });
      }
      if (!mounted.current) return;
      invalidate(); setPages(current => [...current, ...added]);
    } catch (e) {
      added.forEach(p => { URL.revokeObjectURL(p.original); urls.current.delete(p.original); });
      if (mounted.current) setError(e instanceof Error ? e.message : "图片读取失败，请重新选择。");
    } finally { operation.current = false; if (mounted.current) setBusy(null); }
  };
  const remove = (page: Page) => {
    URL.revokeObjectURL(page.original); urls.current.delete(page.original);
    invalidate(); setPages(current => current.filter(p => p.id !== page.id));
  };
  const move = (index: number, offset: number) => {
    const next = [...pages];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    invalidate(); setPages(next);
  };
  const analyze = async () => {
    if (!confirmed || (!pages.length && !attachment) || operation.current || !unlocked) return;
    operation.current = true;
    setBusy("analyzing"); setError(""); setResult(null);
    const abort = new AbortController(); controller.current = abort;
    const timer = window.setTimeout(() => abort.abort(), 65_000);
    try {
      const input = attachment ? { file: attachment.file, confirmed: true as const } : { images: pages.map(p => p.image), confirmed: true as const };
      const output = await reviewInput(input, attachment ? attachment.pageCount : pages.length, abort.signal);
      if (mounted.current) setResult(output);
    } catch (e) {
      if (mounted.current) setError(abort.signal.aborted ? "分析超时，请重试。" : e instanceof Error ? e.message : "分析失败，请重试。");
    } finally {
      clearTimeout(timer); controller.current = null; operation.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  if (!unlocked) return <div className="document-review review-locked-intro">
    <p className="review-intro">上传 HR 让你签的文件，查看需核对的条款和向 HR 提问的建议。</p>
    <p className="review-hint">支持照片、PDF 和 Word，分析结果附条款原文，便于逐项核对。</p>
    <button type="button" className="paid-preview-cta document-review-unlock raised-layer raised-layer-primary" onClick={onUnlock}>解锁签前文件检查</button>
  </div>;

  return <div className="document-review" aria-busy={!!busy}>
    <p className="review-intro">上传 HR 让你签的文件，查看需核对的条款和向 HR 提问的建议。</p>
    <label className="upload-box compact-upload">
      <input aria-label="选择照片、PDF 或 Word 文件" type="file" multiple accept="image/jpeg,image/png,.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" disabled={!!busy || !!attachment || pages.length >= MAX_PAGES}
        onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void addFiles(files); }} />
      <span>{busy === "preparing" ? "正在处理文件…" : attachment ? "已选择文件" : pages.length ? `继续添加照片（${pages.length}/${MAX_PAGES}）` : "选择照片 / PDF / Word"}</span>
    </label>
    <p className="review-hint">可选一份 PDF / DOCX（约 2.9 MB 内，PDF 最多 20 页），或最多 {MAX_PAGES} 张照片。请包含全部页面及附件。</p>
    {attachment && <div className="review-attachment"><strong>{attachment.file.kind.toUpperCase()} 文件</strong><span className="review-filename">{attachment.file.name}</span><span className="review-hint">{attachment.pageCount === null ? "Word 以条款原文定位，不推测排版页码。" : `共 ${attachment.pageCount} 页`}</span><div className="review-page-actions"><button type="button" onClick={() => setPreview("document:1")}>预览文件</button><button type="button" disabled={!!busy} onClick={() => { URL.revokeObjectURL(attachment.original); urls.current.delete(attachment.original); setAttachment(null); invalidate(); }}>删除文件</button></div></div>}
    {pages.length > 0 && <ol className="review-pages">
      {pages.map((page, index) => <li key={page.id}>
        <button type="button" className="review-thumb" onClick={() => setPreview(page.original)} aria-label={`预览第 ${index + 1} 张图片`}>
          <img src={page.original} alt={`第 ${index + 1} 张：${page.name}`} />
        </button>
        <div><strong>第 {index + 1} 张</strong><span className="review-filename">{page.name}</span>
          <div className="review-page-actions">
            <button type="button" disabled={!!busy || index === 0} onClick={() => move(index, -1)} aria-label={`前移第 ${index + 1} 张`}>前移</button>
            <button type="button" disabled={!!busy || index === pages.length - 1} onClick={() => move(index, 1)} aria-label={`后移第 ${index + 1} 张`}>后移</button>
            <button type="button" disabled={!!busy} onClick={() => remove(page)} aria-label={`删除第 ${index + 1} 张`}>删除</button>
          </div>
        </div>
      </li>)}
    </ol>}
    {(pages.length > 0 || attachment) && <label className="review-confirm"><input type="checkbox" checked={confirmed} disabled={!!busy} onChange={e => setConfirmed(e.target.checked)} />我确认已上传同一版文件的全部页面及附件</label>}
    <details className="review-privacy"><summary>上传前的隐私提示</summary><p className="review-hint">可先遮盖身份证号、银行卡号、住址和签名。点击分析后，上传内容会交由 AI 服务商处理。本应用不长期保存文件或结果，刷新或离开页面后需重新上传。服务商的处理与留存方式以上线前公布的说明为准。</p></details>
    <button type="button" className="review-submit raised-layer raised-layer-primary" data-has-files={pages.length > 0 || !!attachment} disabled={(!pages.length && !attachment) || !confirmed || !!busy} onClick={() => void analyze()}>{busy === "analyzing" ? "正在分析，请稍候…" : error ? "重新分析" : "开始分析"}</button>
    {busy === "analyzing" && <p role="status" aria-live="polite">正在阅读文件并检查条款，通常需要一些时间。</p>}
    {error && <p className="review-error" role="alert">{error}</p>}
    {result && <section className="review-results" aria-label="文件检查结果" aria-live="polite">
      <h3>{result.issues.length ? `发现 ${result.issues.length} 项值得核对的内容` : result.limitations.length ? "本次阅读有以下限制" : "本次检查未发现明显问题"}</h3>
      {result.issues.map((issue, index) => <article className="review-issue" key={index}>
        <span className={`review-priority ${issue.priority}`}>{priorityLabel[issue.priority]}</span>
        <h4>{issue.title}</h4>
        <div className="review-page-actions">{attachment?.file.kind === "docx" ? <button type="button" onClick={() => setPreview("document:1")}>对照 Word 正文</button> : issue.pages.map(page => <button type="button" key={page} onClick={() => setPreview(attachment ? `document:${page}` : pages[page - 1].original)}>查看第 {page} {attachment ? "页" : "张"}</button>)}</div>
        {issue.quote !== null ? <blockquote>{issue.quote}</blockquote> : <p className="review-hint">未取得可靠的可引用原文，请对照原文件核对。</p>}
        <p>{issue.explanation}</p>
        <p className="review-question"><strong>可以这样问 HR</strong><br />{issue.question_to_hr}</p>
      </article>)}
      {result.limitations.length > 0 && <aside className="review-limitations"><h4>需要核对或补充</h4><ul>{result.limitations.map((item, i) => <li key={i}>{item}</li>)}</ul></aside>}
      <p className="review-hint">以上仅基于本次上传内容。AI 可能误读或遗漏，请对照原文件核对引用、金额和日期；本结果不认定条款违法，也不代表可以安全签署。</p>
    </section>}
    {preview && <div ref={previewDialog} className="review-preview" role="dialog" aria-modal="true" aria-label="文件预览" onClick={e => { if (e.target === e.currentTarget) setPreview(null); }} onKeyDown={e => { if (e.key === "Escape") setPreview(null); }}>
      <button type="button" ref={closePreview} onClick={() => setPreview(null)}>关闭预览</button>
      {preview.startsWith("document:") && attachment ? <div className="review-file-preview">
        {attachment.file.kind === "pdf" ? <><a href={attachment.original} target="_blank" rel="noreferrer">在新窗口打开 PDF</a><iframe title="PDF 原文件预览" src={`${attachment.original}#page=${Number(preview.split(":")[1])}`} /></> : <><p>Word 正文预览（不保留排版、批注和图片），请以原文件为准。</p><pre>{attachment.text || "未提取到可预览的正文，请在 Word 中查看原文件。"}</pre></>}
      </div> : <img src={preview} alt="文件原图，可放大查看" />}
    </div>}
  </div>;
}
