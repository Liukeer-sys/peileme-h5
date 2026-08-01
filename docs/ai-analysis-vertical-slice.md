# AI 分析纵向闭环（异步 Worker + 直接流式回复）

## 当前可运行能力

- `ai` 产品 Host 独占 `/api/ai/*`，主站返回 404。
- 登录用户可以创建离职补偿分析或文件签署审查任务。
- 任务、状态事件、Provider 尝试、结构化报告和用户历史均持久化到 PostgreSQL。
- 离职分析与文件审查均通过鉴权 SSE 直接回复；流片段在 Worker 中批量持久化，断线后可按事件游标续传。
- Provider 注册表按 `priority` 排序并逐个降级；禁用项会被跳过，响应必须通过固定报告 Schema。
- 本地测试通过依赖注入使用受控 Provider。服务未注入 Provider 时会 fail closed，并退回已预留次数。
- 同一用户的幂等键可安全重试；变更输入会返回冲突。
- 文件审查只接受当前用户拥有的上传记录。
- AI 任务成功后消费一次权益；全 Provider 失败、注册表异常和启动落库失败均释放预留权益。
- 没有可用次数时返回 `402 AI_ENTITLEMENT_REQUIRED` 和对应 SKU；补充权益后可用相同请求重新发起。
- 每位已验证用户首次使用 AI 离职分析、AI 文件审查时可各领取一次权益；首次次数和启停状态由 AI 管理后台配置。
- 管理员可按 SKU、次数、到期时间和发放原因给指定用户补发权益；写入权益、幂等键和审计日志在同一事务完成。

## 当前运行模型

API 校验请求并预留权益后写入 `QUEUED` 任务，立即返回 `202`。独立 `ai-worker` 容器通过 PostgreSQL `FOR UPDATE SKIP LOCKED` 领取任务，持有 180 秒租约并定期续租。任务事件、每个 Provider 尝试、最终报告和权益状态都在 PostgreSQL 中持久化。

Worker 按后台 Provider 优先级逐个调用 OpenAI-compatible 流式接口。首个正文 Token 产生前失败会继续下一项；正文已经输出后发生中断时任务以 `AI_PROVIDER_STREAM_INTERRUPTED` 终止并退回权益，避免把两个模型的内容拼成一份报告。最终成功记录 `selected_provider`，全部 Provider 在首 Token 前失败则按可重试性重新排队，达到上限后终止并释放权益。Provider 错误正文不会落库，持久化内容只保留受控错误码、耗时、模型和有限元数据。

浏览器使用 `GET /api/ai/jobs/:id/stream` 接收持久化片段和最终 `done` 事件。接口先校验任务归属，再发送 `text/event-stream`；Nginx 关闭代理缓冲并将读取超时提高到 300 秒。页面展示实时生成的摘要，最终由通过固定 Schema 校验的结构化报告替换，不再显示百分比进度条。

Worker 每 10 秒写入 `service_heartbeats`。AI 管理后台“系统状态”展示心跳新鲜度、实例、队列、运行中、失败及重试任务数。Worker 异常退出后，租约到期任务会被恢复：旧运行记录以 `AI_WORKER_LEASE_EXPIRED` 关闭，可重试任务重新入队，超限任务终止并退回权益。

## 生产故障演练

降级验收会临时停止常规 Worker，启动一次性受控 Worker，将首选 Provider 指向不可达地址，同时保留第二 Provider 的真实配置。浏览器创建任务并从 SSE 接收到完成事件后，数据库应出现一条首 Provider 失败尝试、一条备用 Provider 成功尝试，任务 `selected_provider` 指向备用 Provider。首 Token 后中断演练应得到终止状态、次数退回和零次备用 Provider 调用。演练结束立即恢复常规 Worker，并确认新鲜心跳与容器健康。

## 后续增强

1. 增加 DOCX/图片正文提取、OCR、病毒扫描、对象存储和模型输入脱敏。
2. 将 Provider 密钥迁移到独立密钥服务，补充熔断窗口、成本预算和路由版本发布。
3. 将 AI 任务草稿接入下单业务草稿校验，完成按次购买后的原任务续跑。
4. 增加报告 PDF、追问和案例引用校验。
