# 赔了么 H5 Demo

一个移动端优先的「牛马身价 / 离职赔偿预评估」对话式产品 demo。

## 本地启动

```bash
npm install
npm run dev
```

默认访问：

```bash
http://localhost:5173
```

## 构建检查

```bash
npm run build
```

## 目录结构

```text
src/
  App.tsx
  components/
    ChatBubble.tsx
    OptionButtons.tsx
    PaidUpsellCard.tsx
    ResultCard.tsx
    StickerCard.tsx
  data/
    questions.ts
    terminationTypes.ts
  utils/
    calculate.ts
    storage.ts
  styles.css
```

## Demo 边界

页面内已明确展示：

> 本结果仅为离职赔偿预评估，不构成正式法律意见。具体金额和风险需结合材料进一步判断。

原测算 Demo 使用前端 state 和 localStorage；签前文件检查已新增独立后端接口，见下文。当前解锁仍是演示交互，不含真实支付。

## 签前文件检查（本地开发版）

已增加独立的文件检查组件和 `POST /api/document-review`。原测算流程中的卡片沿用演示解锁；独立入口无需填写问卷。解锁仅为 UI 演示，不是后端身份或付费认证。

### 本地运行

1. 使用 Node.js 22.12 或更高版本，运行 `npm install`。
2. 将 `.env.example` 复制为 `.env.local`，填写 `AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`。不要提交真实密钥，不要使用 `VITE_` 前缀。
3. 运行 `npm run dev:full`，访问 `http://localhost:5173/?document-review=1`。
4. `npm run dev` 仍然只启动前端，不能进行真实 AI 分析。
5. 运行 `npm test` 和 `npm run build`，分别验证接口行为与前后端类型检查/构建。

Windows PowerShell 若禁止运行 npm.ps1，可使用 `npm.cmd`。

`AI_BASE_URL` 填写 HTTPS 的 API 基址（通常以 `/v1` 结尾）。图片和 PDF 走 `/chat/completions`，DOCX 走 `/responses`（`store: false`），均只调用一次并检查返回的 JSON。当前 Tuzi / gpt-6.1-sol 已进行文件直传验证；更换供应商或模型后需重新验证两种接口、文件类型及 JSON 参数的兼容性。不要在前端填写 API Key。

### 行为与边界

- 每次 1–6 张 JPG/PNG，每张原文件最多 20 MB。浏览器保留原图供核对，将长边缩至最多 2200 像素、质量 0.88 的 JPEG 副本用于分析。请求体（含 Base64）最多 4 MB，不无限压缩以免文字不可读。
- 也可选择一份 PDF 或 DOCX，原文件最多 2,900,000 字节，PDF 最多 20 页。首版不支持文档和照片混传、多份文档、老式 `.doc`、加密 PDF，或含宏/嵌入对象的 DOCX。附件请预先合并进同一份文档，或使用全部页面的照片。
- 图片页码是上传顺序；PDF 是实际页序，从 1 开始。DOCX 分页随排版变化，`issues.pages` 必须为 `[]`，通过原文核对。文件改变后旧结果和完整性确认会重置。
- PDF 通过浏览器内置阅读器预览，提供新窗口打开入口；DOCX 仅在本地提取正文预览，不保留原排版、批注和图片，不加载第三方在线 Office 预览服务。提交给 AI 的仍为原始文档，不是这个正文预览。
- 前后端检查 PDF 结构/页数、DOCX 容器与正文结构，限制 DOCX 解压体积。扫描 PDF 的读取效果依赖供应商，文字 PDF 的成功不能保证所有扫描件都能识别。
- 后端解码实际图片并限制像素数，拒绝网址、伪装文件及异常输入；一次调用 AI，校验 JSON 结构和页码。
- 引用要求忠实原文，无法可靠引用时允许 null。结构校验不能保证引用内容与图片完全一致，必须用人工核对样例评估，并让用户对照原图。
- 问题为空且有阅读限制时，页面展示限制，不提示“未发现明显问题”。超时、截断、格式异常和上游错误均作为失败，允许手动重试，不自动重复付费调用。
- 不发送问卷答案、测算或 HR 报价，不接知识库/OCR，不使用数据库、文件仓库或 localStorage 保存上传和结果。应用不记录正文或供应商错误原文，响应带 `Cache-Control: no-store`。
- 浏览器内存中的图片和结果在页面离开/刷新后释放。AI 供应商的处理地点、留存和训练政策由部署者核实并向真实用户说明；本地当前适合使用虚构或脱敏文件。

### Vercel 完整部署

1. 将源码分支推送到 GitHub。在 Vercel 导入该仓库，把待发布分支设为项目的 Production Branch。框架选 Vite，项目根目录保持仓库根目录，构建命令为 `npm run build`，输出 `dist`。完整部署从源码构建，以便同时发布 `api/document-review.ts` 函数。
2. 打开项目的 Settings → Environment Variables，在 Production 中配置下表的变量。需要在预览环境联调时，也为指定的 Preview 环境配置。密钥只填在 Vercel 环境变量中，`.env.local` 留在本机。
3. 打开项目的 Firewall → Configure → Add Rule，匹配请求路径等于 `/api/document-review`，方法为 `POST`。动作选 Rate Limit，算法选 Fixed Window，计数键选 IP，初始设置每 60 秒 3 次，超限返回 429。保存并发布规则。
4. 确认规则已发布，设置 `DOCUMENT_REVIEW_RATE_LIMIT_READY=true` 并重新部署，使新的函数继承该值。这个变量只记录配置状态，不会自动创建防火墙规则。
5. 用公开地址完成下面的验收，再把地址放到个人网站。后续推送到该生产分支时，Vercel 会自动部署更新。

| 环境变量 | 设置 |
| --- | --- |
| `AI_BASE_URL` | 例如 `https://api.tu-zi.com/v1` |
| `AI_MODEL` | 例如 `gpt-6.1-sol` |
| `AI_API_KEY` | 使用该模型的服务端密钥 |
| `DOCUMENT_REVIEW_RATE_LIMIT_READY` | 已发布该接口的限流规则后设为 `true` |
| `VITE_SHARE_URL` | 可选。填写最终要写入身份卡二维码的完整首页地址，留空时使用访问的站点地址 |

本地的单进程限流只用于开发。公开地址上线后，需要单独验收 Vercel 的跨实例限流。上传走默认请求大小限制，应用不需要数据库或文件存储。

### 交付前人工验收

用虚构或脱敏材料核对：明确付款日期的文件、付款条件模糊的文件、结清/放弃措辞、缺附件、模糊图片、与文件无关的图片、含“忽略规则”等指令的图片。逐项核对 quote、图片顺序和建议是否有依据，确认没有无依据的违法或安全签署结论。

在手机上走一遍选择多图、预览、删除、排序、确认、解锁、分析和重试；在部署环境确认超限得到 429。供应商密钥未配置时只能验证错误路径，不能据此宣称模型准确性已验证。

在公开地址走完一轮测算，保存身份卡并扫码确认落到正确的首页。解锁案例法条包后打开下载的 TXT 核对内容。勾选一项证据，保存证据清单为 PDF，核对纸张排版和勾选进度。用虚构材料分别检查照片、PDF 和 DOCX 的分析结果。

文件回归：`node scripts/smoke-file-input.mjs` 只生成虚构样例，不调用 API。显式运行 `node --import tsx scripts/smoke-document-files.ts --call` 才会用当前 Tuzi 配置通过正式分析适配器测试 PDF/DOCX，并产生用量。样例保存在 `work/file-input-smoke/`，不应放入真实用户文件。
