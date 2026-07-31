# Task 4：微信 H5 与支付宝 WAP 真实支付设计

状态：Task 4 RED SSOT；核心迁移、配置与 provider 协议测试已确认按预期失败，生产实现待后续 GREEN 阶段。通知 service、退款 worker 与 UI 的细化 RED 按本文矩阵在后续子任务补齐。

## 1. 目标与边界

本任务为 `peileme.art` 与 `ai.peileme.art` 提供同一套按次付费能力：

- 微信支付 APIv3 H5 与支付宝手机网站支付（WAP）；
- 创建支付、查单、关单、退款、支付/退款通知；
- 迁移后创建的每次支付尝试使用独立且不可复用的 provider payment identity；迁移前同一订单同一渠道的多个 attempt 可共享真实历史商户支付单号；
- 支付通知验签、微信 `AEAD_AES_256_GCM` 解密、原始事件幂等落库；
- 订单、支付尝试、交易、退款和权益在数据库事务内一致更新；
- 主站和 AI 站共享账户与订单数据，返回地址由请求的可信 Host 决定；
- 本地及自动化测试通过真实协议适配器配合内存 transport/SDK port 完成，不访问支付机构网络，不使用真实密钥；
- `test`、预发布和生产配置均不注册 fake 支付渠道，删除面向 HTTP 的测试支付完成入口。

业务查询串、支付返回页参数和浏览器跳转只用于用户体验。到账与退款状态只能由已验签通知或支付机构查单结果驱动。

## 2. 官方协议依据

### 微信支付

- [H5 下单](https://pay.wechatpay.cn/doc/v3/merchant/4012791834)：`POST /v3/pay/transactions/h5`，`out_trade_no` 在同一商户号下唯一且最多 32 字符，金额单位为分，返回 `h5_url`。`h5_url` 只有 5 分钟有效期，支付返回地址只能按官方规则追加 `redirect_url`。
- [商户订单号查单（H5）](https://pay.wechatpay.cn/doc/v3/merchant/4012791838)：`GET /v3/pay/transactions/out-trade-no/{out_trade_no}`，以 `trade_state` 区分 `SUCCESS`、`REFUND`、`NOTPAY`、`CLOSED` 等状态。
- [关闭订单](https://pay.wechatpay.cn/doc/v3/merchant/4012791839)：`POST /v3/pay/transactions/out-trade-no/{out_trade_no}/close`；超时或取消时需主动关单，成功返回 204。
- [支付成功通知（H5）](https://pay.wechatpay.cn/doc/v3/merchant/4012791836)：通知有唯一 `id`；必须基于原始请求体和 `Wechatpay-*` 请求头验签；签名通过返回 200/204；加密资源算法为 `AEAD_AES_256_GCM`。
- [回调解密](https://pay.wechatpay.cn/doc/v3/merchant/4012071382)：APIv3 key 必须为 32 字节，GCM tag 为 128 bit，`associated_data` 参与认证。
- [签名认证](https://pay.wechatpay.cn/doc/v3/merchant/4012365342) 与 [微信支付公钥](https://pay.wechatpay.cn/doc/v3/merchant/4012153196)：请求用商户私钥签名，响应和通知按 `Wechatpay-Serial` 选择微信支付公钥或平台证书验签。签名探测流量必须拒绝。
- [退款申请](https://pay.wechatpay.cn/doc/v3/merchant/4012810597)：`POST /v3/refund/domestic/refunds`；退款受理成功不代表退款完成；失败重试必须复用原商户退款单号。
- [按商户退款单号查询退款](https://pay.wechatpay.cn/doc/v3/merchant/4012810601)：用于退款通知缺失和恢复任务。

### 支付宝

- 采用支付宝维护的 [Alipay SDK for Node.js](https://github.com/alipay/alipay-sdk-nodejs-all)。WAP 收银台通过 `pageExecute('alipay.trade.wap.pay', ...)` 生成跳转地址；服务端查单、关单、退款使用官方 SDK；异步通知用 `checkNotifySignV2` 验签。
- WAP 请求固定 `product_code=QUICK_WAP_WAY`。分转元使用字符串十进制定点转换，禁止经过 JavaScript 浮点数。
- 支付通知仅接受配置的 `app_id`、`seller_id`、商户支付单号与金额。`TRADE_SUCCESS` 和 `TRADE_FINISHED` 进入到账处理，其余状态只记录。

## 3. 模块边界

### 3.1 Provider 接口

`server/modules/payments/provider.ts` 扩展为以下职责：

```ts
type ProviderPaymentState =
  | { state: "SUCCEEDED"; payment: VerifiedPayment }
  | { state: "REFUND"; payment: VerifiedPayment }
  | { state: "PENDING" }
  | { state: "CLOSED" }
  | { state: "NOT_FOUND" }
  | { state: "CREATE_UNKNOWN" }
  | { state: "UNKNOWN"; providerCode?: string }
  | { state: "FAILED"; providerCode?: string };

interface PaymentProvider {
  channel: "wechat_h5" | "alipay_wap";
  createPayment(input: CreatePaymentInput & {
    providerOrderNo: string;
    expiresAt: string;
  }): Promise<CreatedPayment>;
  queryPayment(input: {
    providerOrderNo: string;
    signal: AbortSignal;
  }): Promise<ProviderPaymentState>;
  closePayment(input: {
    providerOrderNo: string;
    signal: AbortSignal;
  }): Promise<{ closed: boolean; raw: Record<string, unknown> }>;
  refund(input: RefundPaymentInput): Promise<ProviderRefundState>;
  queryRefund(input: QueryRefundInput): Promise<ProviderRefundState>;
  verifyNotification(input: RawProviderNotification):
    Promise<VerifiedProviderNotification>;
}
```

`VerifiedPayment` 保存 `providerOrderNo`，不再把本地 `orders.order_no` 当作支付机构订单号。微信查单返回 `REFUND` 时使用独立 `state=REFUND`，同时仍携带原成功支付的 transaction id、金额、币种和支付时间；恢复任务据此补齐本地成功交易及退款状态，禁止把它降格成未付款。只有原始非 2xx 响应通过微信签名验证，且 404 body 明确表示订单不存在时才映射为 `NOT_FOUND`；unsigned/tampered 404 必须映射 `UNKNOWN` 或抛出未知结果错误并保持锁。创建请求发出后遇到超时、断链或无法验证的响应映射为 `CREATE_UNKNOWN`；其余无法判定状态映射为 `UNKNOWN`。Provider 不读数据库；订单与尝试的对应关系由 commerce service 完成。

`created.response -> response_snapshot` 与 `verified.raw -> verified_payload` 共用同一持久化 sanitizer：递归删除 authorization/signature/token/secret/private key/api key/payer/openid/buyer id/phone/email 类 key，安全处理循环引用与 BigInt，并限制深度、数组长度、对象键数、字符串字节数、节点数和最终 JSON 字节数。任一形状或总量超限只保存 `_truncated=true`、稳定 SHA-256 与原因；金额、币种、provider transaction id 等结算字段继续写入独立结构化列。

### 3.2 Transport 和 SDK port

- 微信 provider 只依赖注入的 `PaymentHttpTransport`。生产 transport 使用 HTTPS；测试 transport 返回脚本化的原始状态码、响应头和响应体。
- 支付宝 provider 只依赖注入的官方 SDK port。生产 port 包装 `alipay-sdk`；测试 port 记录方法与参数并返回协议响应。
- provider 单元测试生成一次性 RSA key pair 和 AES key，覆盖真实签名/验签/解密算法，全程无网络。
- 微信对所有 2xx provider response 先按原始响应字节和 `Wechatpay-*` 响应头验签，再解析 JSON 或接受 204；验签失败一律进入 `UNKNOWN`，禁止使用未验证字段推进状态。

### 3.3 Provider registry

`createPaymentProviderRegistry(config, dependencies)` 是唯一装配入口：

- `PAYMENT_MODE=disabled|live`；
- `PAYMENT_PROVIDERS=wechat_h5,alipay_wap`，只公布配置成功的渠道；
- `PAYMENT_MODE=live` 且列表为空直接启动失败；
- 任一启用 provider 缺少凭证、密钥文件不可读、HTTPS 通知源不合法、微信 APIv3 key 长度错误时直接启动失败；
- `PAYMENT_MODE=fake` 在 test、预发布和生产均启动失败；
- 测试通过 `createApp({ paymentRegistry })` 注入协议 provider，配置层不出现 fake 渠道。
- `PAYMENT_MAX_AMOUNT_FEN` 默认 `10000000000`（人民币 100,000,000.00 元），provider 使用整数字符串或 `BigInt` 校验 `1..PAYMENT_MAX_AMOUNT_FEN` 并完成分/元精确转换，禁止转换为 JavaScript 浮点数、零值、负值、小数文本及超限金额。

必要配置：

```text
PAYMENT_MODE=live
PAYMENT_PROVIDERS=wechat_h5,alipay_wap
PAYMENT_NOTIFY_ORIGIN=https://peileme.art

WECHAT_PAY_APP_ID=
WECHAT_PAY_MCH_ID=
WECHAT_PAY_MERCHANT_SERIAL_NO=
WECHAT_PAY_PRIVATE_KEY_FILE=/run/secrets/wechat_private_key.pem
WECHAT_PAY_API_V3_KEY_FILE=/run/secrets/wechat_api_v3_key
WECHAT_PAY_PUBLIC_KEYS_FILE=/run/secrets/wechat_public_keys.json

ALIPAY_APP_ID=
ALIPAY_SELLER_ID=
ALIPAY_PRIVATE_KEY_FILE=/run/secrets/alipay_private_key.pem
ALIPAY_PUBLIC_KEY_FILE=/run/secrets/alipay_public_key.pem
```

密钥只从只读 secret 文件加载，日志、审计快照和 provider `raw` 均执行字段级脱敏。

## 4. 数据模型与迁移 011

### `provider_payment_orders`

支付机构商户单号拥有独立身份表：

- `id UUID PRIMARY KEY`、`order_id`、`channel`、`provider_order_no`、`origin`（`legacy_order_no|attempt_v1`）、`allocated_at`、`canonical_attempt_id`、`manual_review_required`；
- `UNIQUE(channel, provider_order_no)` 与 `UNIQUE(canonical_attempt_id)`；`channel/provider_order_no/origin/allocated_at` 在创建后由数据库 trigger 禁止修改；
- `canonical_attempt_id` 是唯一允许自动查单、关单、恢复的 owner，并与 identity 其他业务字段一样创建后不可修改。owner 关系使用可延迟外键，保证 identity 与 owner attempt 在同一事务提交；
- `origin=attempt_v1` 的新 identity 必须与一个新 attempt 一对一，channel 只允许 `wechat_h5|alipay_wap`，禁止 `fake` 和 `audit_alias`；商户支付单号由渠道前缀、时间和随机数组成，最长 32 字符；
- `origin=legacy_order_no` 可由同一 `order_id + channel` 的多个历史 attempt 共享；attempt 使用 `(provider_payment_order_id, order_id, channel)` 可延迟复合外键引用 identity，canonical owner 使用 `(canonical_attempt_id, order_id, channel)` 反向可延迟复合外键，数据库保证同 identity 全部 attempts 同 order/channel。`payment_attempts.provider_identity_role` 仅允许 `canonical_owner|audit_alias`，部分唯一索引保证每个 identity 只有一个 canonical owner；alias 只供审计。
- `provider_operation_eligible` 由数据库约束为“真实渠道的 canonical owner 才是 `true`”；`audit_alias` 与全部历史 `fake` 固定为 `false`，永不进入 query/close/refund worker。

011 对历史真实上游单号执行证据回填：若同一 `request_snapshot` 同时存在 `providerOrderNo` 与 `orderNo`，两者必须完全相同，否则冲突；存在可信 snapshot 值时优先使用该值，允许它与本地 `orders.order_no` 不同；只有 snapshot 两个字段均为空时才 fallback 到 `orders.order_no`。迁移只保存证据中实际存在的值，绝不生成或拼接一个未发送给支付机构的单号。同组 attempts、同一 snapshot 或跨订单证据互相冲突时，迁移以 `PROVIDER_PAYMENT_ORDER_MIGRATION_CONFLICT` fail-fast，并输出需要人工隔离处理的内部记录 id；011 整个事务回滚，schema、数据和 migration version 均保持 011 前状态。

同一历史 `order_id + channel` 的 owner 选择顺序固定为：唯一关联 `SUCCESS` transaction 的 attempt；否则 active/reconciliation 候选中 `created_at, id` 最新者；否则全组最新者。多个 `SUCCESS`、同一 `(channel, provider_order_no)` 跨订单共享、来源不一致或交易证据冲突全部 fail-fast。历史 `allocated_at` 使用 owner attempt 的 `created_at` 并标记为 approximate；保留原时间值，不伪造支付机构分配时间。

真实渠道 legacy `FAILED` 默认属于 uncertain：旧 `startPayment` 在 provider timeout、断链及 create 异常后均写 `FAILED`，且 `orders.order_no` 可能已经发送到上游。`PAYMENT_PROVIDER_TIMEOUT`、`PAYMENT_PROVIDER_FAILED`、`PAYMENT_ATTEMPT_STALE` 及没有可验证 pre-dispatch 证据的失败统一迁移为可查询的 `CREATE_UNKNOWN` canonical owner，并继续占用全渠道锁。只有数据库中同时存在“请求尚未 dispatch”的可信事实和专用本地校验 error code 才能安全终态；011 前没有这类事实的记录不得推定未付款。

创建全渠道 active 唯一索引前，011 必须对每个订单统计跨渠道 uncertain owners：`REDIRECT_READY|PENDING|CREATE_UNKNOWN`、仍为 active 的创建记录、`REQUIRED|RETRY_SCHEDULED` reconciliation，以及上述 uncertain legacy `FAILED`。同一订单出现两个或更多渠道时以 `MULTI_ACTIVE_PAYMENT_MIGRATION_CONFLICT` fail-fast，诊断精确列出相关 order 与 attempt 内部 id，整个 011 回滚。该 preflight 发生在 identity 分配前，因此不生成、不伪造 identity id。迁移不选主、不改状态，也不调用 provider 查单/关单；人工在维护窗口外完成证据核查后再重试迁移。

历史 `fake` 仅允许 `origin=legacy_order_no`，精确保留旧 `orderNo` 用于审计。已成功 fake attempt、`SUCCESS` transaction 与已发权益原样保留；未完成 fake attempt 迁移为 `CLOSED + TERMINAL + LEGACY_FAKE_REQUIRES_MANUAL_REVIEW` 并置 `manual_review_required=true`。历史 fake `PENDING|PROCESSING` refund 统一终态化为 `FAILED + LEGACY_FAKE_REQUIRES_MANUAL_REVIEW`，`provider_operation_eligible=false`；已成功 fake refund 的金额、状态与付款事实原样保留。fake identity 不允许新增、不允许查单、关单或退款 worker claim，后续处置只走人工审计。

### `payment_attempts`

新增：

- `provider_payment_order_id UUID NOT NULL`：引用独立 identity；
- `provider_identity_role TEXT NOT NULL`：`canonical_owner|audit_alias`；
- `provider_operation_eligible BOOLEAN NOT NULL`：仅真实渠道 canonical owner 为 `true`；
- `launch_expires_at TIMESTAMPTZ`：记录 H5/WAP 启动链接的本地可复用截止时间，微信不得超过官方 5 分钟；
- 状态增加 `CREATE_UNKNOWN`、`RECONCILING`、`CLOSE_UNKNOWN`。创建响应不确定、查单/关单进行中和关单结果不确定均持续占用全渠道锁；
- 部分唯一索引 `UNIQUE(order_id) WHERE status IN ('CREATED','REDIRECT_READY','PENDING','CREATE_UNKNOWN','RECONCILING','CLOSE_UNKNOWN')`，数据库层保证每个业务订单全渠道最多一个 active attempt；
- owner guard trigger 保证 identity 的 `canonical_attempt_id`、渠道和 attempt role 一致，且 `attempt_v1` identity 无 alias；非关系字段 UPDATE 在比较 `id/order/channel/identity/role` 后直接返回，关系创建或变更仍执行完整校验。
- legacy alias 统一终态化为 `status=CLOSED`、`reconciliation_state=TERMINAL`、`reconciliation_last_result=LEGACY_PROVIDER_IDENTITY_ALIAS`，清空 `reconciliation_next_at/deadline_at`；它不再占 active 索引、schedule 或 worker claim。若原 schedule/claim 仍有必要，只保留或原子转移到 canonical owner。

创建接口超时后只允许 canonical owner 沿 `provider_payment_order_id` 取得原商户支付单号查单，禁止生成新单号盲目重试。

### 011 expand-contract 发布顺序

011 与新代码采用维护窗口内的原子切换：先关闭付款入口并停止/排空旧 API 与支付 worker，确认旧版本没有 writer；再在同一迁移事务内执行 schema expand，先完成 provider 单号、多 active、SUCCESS transaction 与 refund 付款事实的全部冲突 preflight，然后才分配 identity、执行 backfill、owner/alias 回填和全部 contract 约束；迁移成功后立即切换所有 API/worker 到 identity-aware 新代码，再开放流量。任一 preflight/backfill/constraint 失败均回滚 011 并保持付款关闭，人工处理 quarantine 清单后重试。011 一旦登记，旧 API 进程不得恢复或继续创建 payment attempt；发布门禁必须验证集群中不存在旧版本 writer。

冲突诊断只在 stderr 输出一条稳定机器可读行：`PAYMENT_MIGRATION_DIAGNOSTIC {json}`，marker 与 JSON 之间为一个 ASCII 空格。preflight JSON 的键集合固定且仅为 `{code, orderIds, attemptIds, transactionIds, refundIds}`；四个 ID 数组按 UUID 文本升序排列并去重，精确包含该冲突实际相关记录。多一个 UUID、少一个 UUID、错分类、重复、乱序、额外键或虚构 UUID 都违反诊断契约。上述 preflight 在 identity 分配前终止，因此 JSON 中明确不存在 `identityIds` 键；只有后续阶段已真实插入 identity 后发生的冲突才能使用另一个版本化诊断 schema 输出真实 `identityIds`。任一冲突回滚验证对 `payment_attempts`、`payment_transactions`、`refunds` 使用稳定排序的整行 `to_jsonb(row)` 快照，证明全部旧字段不变。

迁移后的 payment attempt 写入由 transaction-local contract 熔断：identity-aware 事务通过统一 helper 写入 `identity_v1:<txid_current()>` 的 transaction-local token，且 `request_snapshot.providerOrderNo` 必须等于所引 identity 的 `provider_order_no`；静态 session token、跨事务复用的过期 token 和没有 token 的旧写入均由 trigger 返回 `23514/23502`，迁移事务只使用局部 migration contract。数据库 kill-switch 只能阻断写入；旧 worker 可能发出的上游查单/关单由维护窗口停进程、撤销旧实例支付凭证和发布门禁共同隔离。

`provider_payment_orders.order_id` 与 `orders` 使用 `ON DELETE CASCADE`，双向 identity/attempt 外键为可延迟 `NO ACTION`，保证同一事务删除测试订单时 attempts 与 identities 一起清理且不遗留环形引用。生产财务订单、identity、transaction 和 refund 一律不物理删除；业务撤销使用状态、审计和依法配置的保留策略。

### `payment_notification_events`

独立 inbox 表至少包含：

- `channel`、`provider_event_id`、`dedupe_key`；
- 原始请求体 `raw_body BYTEA`、`body_hash`、白名单请求头 `headers`；`raw_body` 数据库约束最大 256 KiB；
- `event_type`、`provider_payment_order_id`、`provider_order_no`、`provider_transaction_id`；
- `verification_status`（`VERIFIED|REJECTED`）；
- `processing_status`（`RECEIVED|PROCESSING|PROCESSED|FAILED`）、重试次数和错误；
- `payment_attempt_id`、`refund_id` 可空外键；
- `UNIQUE(channel, provider_event_id)` 与 `UNIQUE(channel, dedupe_key)`。
- `retention_until` 支持有界保留和定时清理；默认保留 180 天，财务对账证据按脱敏摘要长期保存。

同一 `(channel, provider_event_id)` 再次出现时必须比较 `body_hash`。hash 相同按幂等成功处理；hash 不同则 durable 写入 `payment_notification_conflicts`，记录两个 hash、受限原始证据和告警状态，禁止覆盖原事件或再次结算。

原始通知先按限长请求体计算 SHA-256。重复通知返回渠道成功应答且不会重复履约。无效签名记录为 `REJECTED`，不进入业务处理。

### `refunds`

新增：

- `payment_attempt_id`、`payment_transaction_id`、`provider_refund_no` 最终均为 `NOT NULL`；
- `(payment_transaction_id, order_id, payment_attempt_id, channel)` 复合外键直连同一付款事实，refund INSERT/UPDATE guard 以 `SELECT ... FOR UPDATE` 锁定付款事实并要求 transaction `status=SUCCESS`；`CLOSED|REFUND` transaction 均不可绑定，并发 refund INSERT 与 transaction 状态 UPDATE 必须串行复核；
- 一旦被 refund 引用，原 `SUCCESS` payment transaction 是 append-only 财务事实，transaction UPDATE 反向 guard 以 `23514` 和稳定 constraint 名 `payment_transactions_refund_fact_immutable` 拒绝修改 `status/order_id/payment_attempt_id/channel/amount_fen/currency/channel_transaction_id`。退款结果只写 refund 事实，不把原 `SUCCESS` transaction 改成 `REFUND`；
- `UNIQUE(channel, provider_refund_no)` 精确限定商户退款单号：同渠道重复返回 `23505`，不同渠道可使用同一文本单号；
- `request_snapshot`、`failure_code`、`failure_message`、`succeeded_at`；
- `provider_operation_eligible` 严格派生：真实渠道且状态为 `PENDING|SUBMITTING|UNKNOWN|PROCESSING` 时必须为 `true`；`fake|SUCCEEDED|FAILED` 必须为 `false`。worker 仍同时按渠道、状态和 eligibility 过滤；
- 同一退款请求重试复用 `provider_refund_no`。

011 对每条历史退款把 `refund_no` 精确保留到 `provider_refund_no`，并只在同 `order_id + channel` 恰好存在一条 `SUCCESS` transaction、该 transaction 的 `payment_attempt_id` 非空且 attempt/order/channel 全一致时回填付款事实。0 条、多条、空 attempt 或不一致均以 `LEGACY_REFUND_MIGRATION_CONFLICT` fail-fast，诊断按类型包含每个实际相关 refund/order/attempt/transaction 内部 id 并进入人工 quarantine；schema、attempt、transaction、refund 数据及 migration version 全事务回滚。历史 fake 成功退款可绑定 fake `SUCCESS` transaction 供审计，成功事实原样保留；历史 fake `PENDING|PROCESSING` 退款迁移为 `FAILED`，`failure_code=LEGACY_FAKE_REQUIRES_MANUAL_REVIEW`，eligibility 永久为 `false`，不进入任何退款 worker。

退款状态扩展为 `PENDING|SUBMITTING|UNKNOWN|PROCESSING|SUCCEEDED|FAILED`。退款金额在事务中以成功交易金额减去 `PENDING + SUBMITTING + UNKNOWN + PROCESSING + SUCCEEDED` 退款金额校验，防止并发超退。明确失败退款释放占用额度，状态不明的退款继续计入。

## 5. 支付状态机

### 创建与复用

1. 锁订单，验证用户、Host product channel、金额和有效期。
2. 若同订单存在任意渠道 active attempt：
   - 同渠道且跳转仍可用，返回原 attempt；
   - 同渠道创建中，返回 `PAYMENT_INITIALIZING`；
   - 请求切换渠道，原 attempt 直接原子标记 `RECONCILING` 并获得 generation claim，不增加额外瞬时状态。
3. 切换渠道时原 attempt 先进入 `RECONCILING`，再由其 canonical identity owner 按 `provider_order_no` 查单；`audit_alias` 永不进入自动查询队列。已支付或 `REFUND` 则恢复成功交易事实；未支付/支付中则调用远端关单并再次查单。只有最终状态为 `CLOSED` 或 `NOT_FOUND` 时，才把旧 attempt 置 `CLOSED` 并创建新渠道 attempt。
4. 查单结果 `UNKNOWN` 保持 `RECONCILING`；关单响应不确定进入 `CLOSE_UNKNOWN`。二者均保持渠道锁并返回 `PAYMENT_CHANNEL_LOCKED`，禁止本地关单后创建第二个可支付入口。
5. 新 attempt 与 `origin=attempt_v1` identity 在同一事务一对一创建，identity 保存唯一商户支付单号并把 attempt 设为 canonical owner，然后调用 provider。创建请求发出后的任何超时、断链、未验签响应均把 attempt 标记为 `CREATE_UNKNOWN` 并持续占用全渠道锁；恢复任务只能经 identity 使用原商户单号查单。

### 到账

查单和通知统一调用一个事务函数：

1. 按 `(channel, provider_order_no)` 锁 `provider_payment_orders`，只接受其 canonical owner，再锁 attempt 和 order；
2. 验证 channel、商户号/app、金额、币种、支付时间和 transaction id；
3. 幂等插入 `payment_transactions`；
4. attempt -> `SUCCEEDED`，order -> `PAID` -> `FULFILLING` -> `COMPLETED`；
5. 发放一次 entitlement；
6. 关闭本订单其他本地 attempt，并创建远端关单任务；
7. notification event -> `PROCESSED`。

所有数据库写入在同一事务提交。权益唯一索引继续作为最终幂等防线。

支付时间晚于本地 `orders.expires_at` 时禁止发放权益：事务内记录 `PAYMENT_AFTER_EXPIRY` anomaly、保存真实成功 transaction、关闭订单并创建绑定该 transaction 的自动全额退款。退款完成后订单保持可审计的过期付款退款状态。

### 双边支付与迟到付款

数据库部分唯一索引阻止双 active attempt。切换渠道的远端关单与最终查单降低竞态窗口。若旧渠道在关单竞态中仍支付成功：

- 第一笔有效到账完成订单并只发一次权益；
- 后到的第二笔记录 `DUPLICATE_PAYMENT` anomaly；
- 事务内幂等创建自动退款记录，worker 使用固定商户退款单号发起全额退款；
- 订单保持 `COMPLETED`，后台和用户交易历史显示“重复付款退款处理中”。

### 退款

退款请求先在事务内锁定订单、原 `SUCCESS` transaction 与已有退款，将 `PENDING + SUBMITTING + UNKNOWN + PROCESSING + SUCCEEDED` 全部计入已占用退款金额，再创建 `PENDING` 记录。调用前进入 `SUBMITTING`；请求结果不确定进入 `UNKNOWN`。微信受理后进入 `PROCESSING` 并由退款通知或查退款接口确认。支付宝以官方 SDK 同步 `alipay.trade.refund` 响应推进状态，只有响应明确 `fund_change=Y` 才能置 `SUCCEEDED`；`fund_change=N` 或字段缺失均进入 `UNKNOWN`，再通过 `alipay.trade.fastpay.refund.query` 恢复，禁止假设支付宝存在退款 webhook。失败进入单笔 `FAILED`。

订单退款汇总只按累计事实计算：已有部分退款成功、另一笔退款失败时，订单保持 `PARTIALLY_REFUNDED`，失败记录和错误单独展示，禁止用 `REFUND_FAILED` 覆盖已退款金额；累计成功金额等于支付金额时才进入 `REFUNDED`。

每个按次权益采用以下退款规则：

- 重复付款自动退款绑定重复的 payment transaction，该交易从未发放权益，因此不改变合法订单权益；
- 全额退款成功且订单权益尚未消费时，事务内撤销该 entitlement；
- 已消费权益对应的结果与历史永久保留，默认退款接口返回 `REFUND_REQUIRES_MANUAL_REVIEW`；super-admin 显式覆盖时写审计，退款完成后保留已产生结果，不恢复使用次数；
- 部分退款不回滚已消费结果，权益例外全部进入人工审查。

## 6. 通知接入

中间件固定顺序为：可信 Host gate -> 支付通知 raw parser -> 通用 JSON/urlencoded parser -> 其余业务路由。通知 route 对原始请求体限长：

- `POST /api/payments/wechat_h5/notify`
- `POST /api/payments/alipay_wap/notify`

微信处理顺序：保留原始字节 -> 校验四个 `Wechatpay-*` 头 -> 按 serial 选公钥 -> 校验时间窗口与 RSA-SHA256 签名 -> JSON 解析 -> AES-256-GCM 解密 -> inbox 幂等写入 -> 业务校验事件/商户/app/金额。

支付宝处理顺序：保留原始 form body -> 严格解析重复字段 -> `checkNotifySignV2` -> inbox 幂等写入 -> 业务校验 `app_id`/`seller_id`/状态/金额。

通过密码学验签的事件必须先 durable capture 为 `VERIFIED`。商户、金额、订单映射或状态等业务校验失败时，同一事务把事件置 `FAILED` 并创建 anomaly，然后仍向微信返回 204、向支付宝返回纯文本 `success`，避免渠道重试风暴；这些异常绝不能丢在 inbox 外。数据库不可写时不 ACK，让渠道重试。签名不通过时记录 `REJECTED`（数据库可用时）并返回失败。worker 用 `FOR UPDATE SKIP LOCKED` 处理 inbox。返回页从不调用到账函数。

## 7. HTTP API 与用户体验

### API

- `GET /api/commerce/payment-providers`：返回当前已配置渠道、展示名和可用状态；不泄露配置。
- `POST /api/commerce/orders/:id/pay`：`{ "channel": "wechat_h5" | "alipay_wap" }`；返回 attempt、`launchUrl` 和轮询地址。
- `GET /api/commerce/orders/:id/payment-status`：用户鉴权且按 Host product channel 隔离，返回订单/attempt/退款的安全状态。
- `GET /api/commerce/transactions`：用户交易历史，含订单、支付渠道、退款状态，不返回 provider 原始载荷。
- `POST /api/admin/commerce/orders/:id/refunds`：super-admin 发起全额或部分退款，需要幂等键与原因，并写审计日志。

主站请求的 return URL 固定基于 `MAIN_APP_ORIGIN`，AI 站固定基于 `AI_APP_ORIGIN`。客户端 body/query 中的 channel 无权改变 return URL。notify URL 固定基于 `PAYMENT_NOTIFY_ORIGIN`。

### 最小 UI

主站和 AI 站均提供：

- 结算弹窗/页：只显示 registry 返回的可用微信和支付宝入口；
- 创建支付后跳转 provider `launchUrl`；
- 返回页轮询 `payment-status`，显示处理中、成功、失败、渠道锁定与重试；
- 账户页交易历史和退款状态；
- 微信内置浏览器选择微信 H5 时显示“请在外部浏览器打开”指引，保留复制链接/打开浏览器操作；
- provider 全部不可用时禁用付款并显示可恢复提示。

## 8. 恢复、监控与安全

- 支付恢复 worker 扫描创建超时、支付中、`RECONCILING`、`CLOSE_UNKNOWN` 和已过期 attempt；逐 provider 受限并发查单/关单。
- 通知 inbox、支付恢复、退款恢复均有最大退避、deadline 和人工审查状态。
- 指标：provider 请求成功率/耗时、验签失败、通知积压、查单恢复、关单失败、重复付款、退款失败、订单与交易金额差异。
- 日志只记录内部 order/attempt/event id、provider code 和 trace id；签名、私钥、APIv3 key、完整通知体、买家身份字段均禁止进入普通日志。
- provider launch URL 仅接受官方 HTTPS host；后端不跟随 provider 重定向。
- 通知 route 限长、限方法、严格 Content-Type；按原始字节验签后再解析。

## 9. TDD 验收矩阵

### Provider 单元测试

- 微信请求签名串、Authorization、响应验签、未知 serial、篡改响应；
- 微信 signed 404 才能形成 `NOT_FOUND`；unsigned/tampered 404 保持 `UNKNOWN`，不得释放全渠道锁；
- 微信 H5 create/query/close/refund 路径和字段；
- 微信通知原始体验签、AES-GCM 解密、错误 tag、签名探测；
- 支付宝 WAP 参数、分转元、query/close/refund SDK 调用；
- 支付宝金额字符串定点转换只覆盖业务限额内边界，零值、负值、小数文本和超限值拒绝；退款仅 `fund_change=Y` 成功，`N`/缺失进入 `UNKNOWN` 并查退款恢复；
- 支付宝通知验签、重复字段、app/seller/金额/状态校验；
- 所有 provider 测试 transport 禁止网络。

### 数据库与 service/API

- 011 精确保留历史真实上游单号；同订单同渠道 legacy attempts 共享 identity，唯一 canonical owner 可查询，alias 只供审计；
- 历史来源优先级、SUCCESS owner 优先级、active/reconciliation 最新 owner 和 approximate allocated time 均有真实 PostgreSQL fixture；来源冲突、多个 SUCCESS、跨订单共享与证据冲突使迁移 fail-fast；
- 同 snapshot 双字段相同正常迁移；双字段不同冲突。真实 legacy FAILED uncertain 迁移为 `CREATE_UNKNOWN`，与另一渠道 active/reconciliation 共存时触发 `MULTI_ACTIVE_PAYMENT_MIGRATION_CONFLICT` 且不改状态、不调用 provider；
- legacy fake 只形成不可操作的审计 identity；已成功 transaction/entitlement/refund 保留，未完成 attempt 与 `PENDING|PROCESSING` refund 终态化并进入人工复核；attempt_v1 fake、fake/alias/refund worker eligibility 均由数据库拒绝；
- alias 强制 `CLOSED + TERMINAL + LEGACY_PROVIDER_IDENTITY_ALIAS` 且无 schedule/deadline；同 identity 全部 attempts 必须与 owner 同 order，必要 reconciliation 工作只归 owner；
- 011 后每个新 attempt 一对一创建 `attempt_v1` identity，商户支付单号与 `orders.order_no` 分离且不可变；
- owner 指针、identity 关联、channel、role、eligibility 和 identity 全字段具有数据库负例；旧版缺 identity 的 INSERT 在 011 后失败；冲突迁移断言 schema/data/version 全事务回滚；
- 50,010 条 identity/attempt 的索引与状态更新门禁在一次性隔离数据库运行，两个 owner guard 全程保持 `tgenabled='O'`，结束后 terminate/drop 并验证无数据库或会话残留；
- transaction-local `identity_v1:<txid_current()>` GUC kill-switch 同时拒绝静态 session token、跨事务过期 token、旧 preparePayment 与旧 reconciliation UPDATE；providerOrderNo 不匹配也拒绝；
- legacy real/fake refund 精确保留 refund_no 并绑定唯一一致 `SUCCESS` transaction；0/多 SUCCESS、空 attempt、不一致付款事实 fail-fast，冲突诊断逐一列出实际相关 order/attempt/transaction/refund id，三张旧表的整行 JSON 快照与 schema/version 一起回滚；
- `UNIQUE(channel, provider_refund_no)` 拒绝同渠道重号并允许跨渠道同号；refund INSERT/UPDATE 均拒绝 `CLOSED|REFUND` transaction，已被 refund 引用的 `SUCCESS` transaction 关键财务字段不可修改；真实进行中 eligibility 必须为 true，fake/终态必须为 false；
- 删除测试订单可在一个事务内清理 attempts/identities 且无环形 FK orphan；生产财务数据禁止物理删除；
- 并发微信/支付宝 start 只能产生一个 active attempt；
- provider identity 的 `provider_order_no` 数据库不可更新；launch URL 超过 `launch_expires_at` 不再复用；
- 跨渠道切换在远端查单、关单、最终查单前不会创建新 attempt；
- 通知重复投递只产生一笔 transaction 和一份 entitlement；
- 无效签名、错误金额、错误商户、错误 Host 不改变订单；
- provider create 超时进入 `CREATE_UNKNOWN`、持续持有全渠道锁并用原商户单号查单恢复；
- reconcile/close 期间进入 `RECONCILING`，关单响应不确定进入 `CLOSE_UNKNOWN`，两者都持续持锁；provider 明确 `NOT_FOUND` 后才允许释放锁；微信 `REFUND` 保留原支付成功 transaction 并恢复退款事实；
- 旧渠道迟到付款形成 anomaly 与幂等自动退款，权益仍为一份；
- 支付、退款通知和 worker 重启后可恢复；
- main/ai 返回 URL 与订单查询保持 Host 边界；
- 过期后付款不发权益，创建 anomaly 和绑定真实 transaction 的自动全额退款；
- 退款防超退累计覆盖 `PENDING + SUBMITTING + UNKNOWN + PROCESSING + SUCCEEDED`，每笔退款直连 `SUCCESS` payment transaction；
- 支付宝退款恢复调用 `alipay.trade.fastpay.refund.query`；部分退款成功后另一笔失败仍保留 `PARTIALLY_REFUNDED` 和累计金额；
- 已消费权益默认进入退款人工审查，未消费权益在全额退款完成时撤销；
- 已验签但商户/金额/订单不匹配的通知 durable capture 为 `VERIFIED + FAILED` 并记录 anomaly 后 ACK；数据库不可写时不 ACK；
- 相同 provider event id + 相同 body hash 幂等 ACK；相同 id + 不同 body hash durable 记录冲突并告警；raw body 以有界 BYTEA 保留并执行清理策略；
- test/预发布/生产无法注册 fake provider。

### Playwright 真实用户链路（实现后执行）

Happy Path：

1. 主站登录 -> 完成测算 -> 创建订单 -> 选择微信 -> 模拟协议通知 -> 返回轮询成功 -> 历史可见。
2. AI 站登录 -> AI 分析或文件审查订单 -> 选择支付宝 -> 模拟协议通知 -> 权益到账 -> 历史可见。
3. 管理员发起退款 -> provider 受理 -> 退款通知 -> 用户历史显示退款完成。

Unhappy Path：

1. provider 未配置、创建超时、查单超时、支付取消、订单过期。
2. 并发点击两渠道、切换渠道关单失败、旧渠道迟到付款。
3. 微信内置浏览器外部浏览器提示。
4. 篡改 return 参数、错误 Host、越权订单、重复通知、无效签名、金额不一致。
5. 刷新/重启后继续轮询，订单、通知 inbox 与退款状态保持一致。

数据库/崩溃恢复额外覆盖：provider 调用前后进程退出、通知 durable capture 后 worker 退出、支付事务提交前后退出、退款 `SUBMITTING/UNKNOWN` 恢复、双 worker `SKIP LOCKED`、真实 PostgreSQL 唯一索引竞争和 trigger 不可变约束。API 覆盖 main/ai Host、未知 Host、跨 Host 订单、普通用户/管理员/super-admin 权限以及通知 route 在 general parser 前保留原始字节。

每个页面、渠道按钮、弹窗、轮询状态、历史 Tab 和退款状态均需覆盖桌面与移动视口；同时检查浏览器 console、失败请求和后端异常。覆盖矩阵存在未勾选项时，Task 4 保持未完成。

### 真实商户发布门禁

协议级 fake transport、API 测试和 Playwright 只构成本地验收。正式放量前必须在支付机构真实商户环境完成并保存脱敏证据：

1. 主站和 AI 站各至少一笔允许的最低金额真实支付；
2. 已验签回调落 inbox、到账 transaction、订单完成和权益发放一致；
3. 主动查单与回调结果一致；
4. 使用原交易发起真实退款，并由退款通知/查退款确认到账；
5. 次日下载/获取交易账单，完成订单、支付、退款和渠道账单金额对账；
6. 真实流程同时验证 provider trace id、监控指标、告警和审计记录。

任一真实渠道未完成“低额支付 -> 回调 -> 查单 -> 退款 -> 次日对账”，该渠道保持后台关闭，整个真实支付发布门禁保持未通过。
