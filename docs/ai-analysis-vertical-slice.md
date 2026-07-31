# AI 分析纵向闭环（同步版）

## 当前可运行能力

- `ai` 产品 Host 独占 `/api/ai/*`，主站返回 404。
- 登录用户可以创建离职补偿分析或文件签署审查任务。
- 任务、状态事件、Provider 尝试、结构化报告和用户历史均持久化到 PostgreSQL。
- Provider 注册表按 `priority` 排序并逐个降级；禁用项会被跳过，响应必须通过固定报告 Schema。
- 本地测试通过依赖注入使用受控 Provider。服务未注入 Provider 时会 fail closed，并退回已预留次数。
- 同一用户的幂等键可安全重试；变更输入会返回冲突。
- 文件审查只接受当前用户拥有的上传记录。
- AI 任务成功后消费一次权益；全 Provider 失败、注册表异常和启动落库失败均释放预留权益。
- 没有可用次数时返回 `402 AI_ENTITLEMENT_REQUIRED` 和对应 SKU；补充权益后可用相同请求重新发起。

## 当前运行模型

API 内使用同步 Runner 完成一条任务，适合本地验收和第一阶段产品闭环。Provider 错误正文不会写入任务、事件或尝试记录；持久化内容只保留受控错误码和元数据。

## 下一阶段增强

1. 增加 Redis/BullMQ Worker，将长任务从 API 进程迁出，并实现租约、重试、死信和崩溃恢复。
2. 增加 PDF/DOCX/图片正文提取、OCR、病毒扫描、对象存储和模型输入脱敏。
3. 增加真实 OpenAI-compatible HTTP Provider Adapter、加密密钥引用、首 Token 超时、熔断和可配置路由版本；生产环境继续保持无配置 fail closed。
4. 将 AI 任务草稿接入下单业务草稿校验，完成按次购买后的原任务续跑。
5. 增加报告 PDF、追问、案例引用校验、后台 Provider/任务/成本监控和完整 Playwright 链路。
