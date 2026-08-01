# 2026-08-01 双站上线验收矩阵

本矩阵是本次发布的完成标准。每一行需要同时保留本地 Compose 与生产浏览器结果；出现未勾选项时，发布状态保持“未完成”。测试全程监听浏览器异常、控制台错误和 HTTP 5xx。

| 范围 | 入口与控件 | Happy Path | Unhappy Path | 自动化证据 |
| --- | --- | --- | --- | --- |
| 主站测算 | 欢迎页、地区/时间/工资/合同/离职问题、上一步、结果页 | 完整问答生成政策测算并刷新后保留历史 | 缺少答案、非法金额、缺失地区参数、越权访问受控拦截 | `e2e/main-policy.spec.ts`、`e2e/production.spec.ts` |
| 双站边界 | 根域、AI 子域、SPA 刷新、共享会话 | 主站只含政策能力，AI 站含分析与文件审查 | 跨 Host API、材料和商品访问返回受控错误 | `e2e/dual-web-compose.spec.ts`、`e2e/web-artifacts.spec.ts` |
| 账号与邮箱 | 登录/注册弹窗、获取验证码、密码、刷新、退出 | 外部邮箱真实收件，正确验证码注册，跨站会话可用 | 错误验证码失败；生产响应无调试验证码 | `e2e/real-email-otp.spec.ts`、`e2e/registration.spec.ts` |
| AI 首次权益 | 离职分析、文件审查、开始分析、历史 | 每个 AI SKU 首次各可用一次，报告与历史持久化 | 第二次无余额返回 402；无效文件/越权材料拒绝 | `e2e/ai-core.spec.ts`、`e2e/real-email-otp.spec.ts` |
| AI 异步 Worker | 创建任务、状态轮询、报告、系统状态卡 | API 返回 202，Worker 完成，报告和 Provider 尝试入库 | Provider 1 不可达后 Provider 2 接管；过期租约恢复 | `e2e/ai-worker-fallback.spec.ts`、`server/tests/ai-recovery.test.ts` |
| 材料与用户历史 | 上传、下载、材料列表、AI 历史 | PDF 上传、本人下载、管理员回查，任务完成后历史刷新 | 伪造文件、跨用户材料和主站材料接口拒绝 | `e2e/persistence-admin.spec.ts`、`e2e/ai-core.spec.ts` |
| 城市参数 | 省市选择、区域参数后台、政策计算 | 364 个行政区域均可由城市精确值或省级回退完成计算 | 无任何可用参数的测试区域显示人工复核提示 | `e2e/main-policy.spec.ts`、`server/tests/policy.api.test.ts` |
| 主站后台矩阵 | 11 个导航、刷新、退出、首次政策权益 | 每个页面可进入、刷新并展示对应标题 | AI 权益与材料能力保持隐藏 | `e2e/admin-button-matrix.spec.ts` |
| AI 后台矩阵 | 12 个导航、首次权益、发放次数、账号、角色、邀请码、退出 | 配置修改并还原、补发、停启用户、角色切换、邀请码停启 | 0 次配置、过期发放、超量邀请码均被拒绝 | `e2e/admin-button-matrix.spec.ts` |
| 运行与恢复 | Compose 健康、重启、数据库标记、域名 | 五个容器健康，重启后登录与持久化数据仍可读 | Worker 心跳过期显示不可用，租约恢复受控 | `scripts/run-dual-web-compose-e2e.mjs`、生产回环/公网检查 |

## 参数口径

- 最低工资：31 个省级值，来自人力资源社会保障部截至 2026-01-01 的公开表。
- 平均工资：武汉使用市级精确值；31 个省级回退值按国家统计局 2025 年东部、中部、西部、东北地区城镇非私营单位年平均工资折算为月值。
- 省级回退数据在后台标记为 `stale` 和“省级回退估算”，结果页同步显示来源与覆盖方式，便于后续按城市替换。

## 发布后记录

### `51025ad` / `c55e966` / `5506953` AI 政策、进度、邮件与模型路由发布

- 核心发布提交：`51025ad`；邮件主题补丁与最终生产版本：`c55e966`；最终一致性备份：`/opt/1panel/backup/peileme/20260801T011312Z`；回滚镜像标签：`rollback-20260801T010307Z`。
- AI 产品体验：`https://ai.peileme.art/policy` 在 AI 站内复用完整政策问答、账号和历史，浏览器前进/后退及刷新保持同一产品；未确认工资流水时按钮保持禁用。
- AI 路由：API 与 Worker 均以 `tuzi / gpt-5.6-sol` 为主路由，以 `dataeyes / gpt-5.6-sol` 为降级路由；真实离职分析和文件审查均使用 `gpt-5.6-sol`。
- DataEyes 模型切换：运行提交 `5506953`；发布前备份 `/opt/1panel/backup/peileme/20260801T023012Z`；回滚镜像标签 `rollback-dataeyes-gpt-20260801T023012Z`。生产后台模型矩阵 `1/1` 通过；受控真实降级 `1/1` 通过，任务记录 Tuzi `gpt-5.6-sol / PROVIDER_ERROR` 后由 DataEyes `gpt-5.6-sol` 成功完成。API 重建瞬间两个 Web 容器的内部 `/api/health` 探针各记录一次 502；稳定后外部七入口均为 200，API 无 5xx，后续 Web 无新增 5xx。
- 任务进度：生产任务持久化 `0 → 10 claimed → 20 loading_materials → 35 materials_ready → 45 provider_started → 85 provider_succeeded → 95 persisting_report → 100`，页面按后端事件展示阶段与阶段内估算进度。
- 邮件：登录验证码使用带品牌头、验证码卡片、有效期和安全提示的响应式 HTML，同时保留纯文本兜底；SMTP 与阿里云 DirectMail 共用模板。生产发送返回 201、无调试码，投递记录为 `sent` 且存在 provider message ID。
- 最终本地证据：核心服务端测试 `824/824`；主站政策 `26/26`；AI、双站、后台、材料与安全头 `15/15`；注册 `1/1`；受控降级 `1/1`；Compose 重启前后 `4/4`，共 `47` 条 Playwright 通过。暂缓支付渠道仍保留 Alipay WAP 与 WeChat V3 的 `29` 条 RED 契约。
- 最终生产证据：常规真实用户矩阵 `14` 条通过、`2` 条调试验证码专属用例按 `OTP_DEBUG=false` 跳过；真实外部邮箱、真实 DataEyes 降级与重启后双站共 `4/4` 通过，合计 `18` 条生产 Playwright 通过。邮箱投递状态为 `sent`、provider message ID 存在，API/Worker 无 fatal，Web 无 5xx，`app_errors` 为空。
- 运行恢复：五个容器均为 `unless-stopped` 且 healthy；四个应用服务重启后最新 DataEyes 降级任务仍为 `COMPLETED`，回环和外部 HTTPS 检查恢复。`https://peileme.art`、`https://ai.peileme.art`、两个管理后台、两个健康接口与 `https://ai.peileme.art/policy` 均返回 200，健康版本为 `5506953`。

- 运行提交：`c9a0679`；生产备份：`/opt/1panel/backup/peileme/20260731T221906Z`；回滚镜像标签：`rollback-20260731T221908Z`。
- 数据状态：迁移 `016_ai_worker_attempts.sql`，364 个行政区域，63 条参数；三项首次权益均为启用、每项 1 次。
- 本地证据：服务端非支付测试 671/671；政策站 Playwright 26/26；AI、双站、后台、材料、账号和构建产物 Playwright 16/16；受控真实 Provider 降级 1/1；Compose 重启前后浏览器 4/4 且数据库哨兵保留。
- 生产证据：真实外部邮箱验证码 1/1；生产安全矩阵 13/13，调试验证码专属 2 条由真实邮箱链路替代；受控 Provider 降级 1/1；重启后双站 2/2。
- 降级任务：`fb5b63ee-eda8-4deb-9ad3-1f1dafb0a352`，`tuzi / PROVIDER_ERROR` 后由 `dataeyes` 成功完成。
- 运行恢复：`db`、`api`、`ai-worker`、`web-main`、`web-ai` 全部 healthy；四应用服务重启后数据库哨兵保留，Worker 实例 ID 更新且心跳新鲜。
- 公网结果：`https://peileme.art`、`https://ai.peileme.art`、两个 `/admin` 与两个 `/api/health` 均从发布机外通过 HTTPS 返回 200；健康版本为 `c9a0679`，生产 `OTP_DEBUG=false`。
