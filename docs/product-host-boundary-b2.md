# B2：产品 Host 与 API 边界

状态：已实现。本文件与
`server/tests/product-host-boundary.red.test.ts` 固化服务端产品边界和回归证据。

## 目标契约

- `peileme.art` 只提供政策测算产品能力。用户上传、用户材料下载和管理端材料接口统一返回 `404`。
- `ai.peileme.art` 提供材料上传、材料历史、私有下载和管理端材料接口；未登录请求按现有鉴权规则返回 `401`。
- 商品渠道由可信 Host 决定。主站请求即使携带 `channel=ai` 或 AI SKU，也返回
  `PRODUCT_CHANNEL_HOST_MISMATCH`，不能把请求参数当作产品渠道的事实来源。
- commerce 的目录、下单、订单列表与订单历史都必须先从可信 Host 派生 channel，
  再执行查询或写入。主站只能接收 main 订单数据，AI 站只能接收 ai 订单数据；
  禁止先把跨 channel 全量订单返回客户端再由页面过滤。
- 公共账号、会话、政策接口和非材料管理能力继续支持两个站点。
- 未识别 Host 在生产环境 fail closed；本地和测试环境使用显式允许列表，不能靠首段域名猜测。

## 已实现清单

1. `MAIN_PRODUCT_HOSTS`、`AI_PRODUCT_HOSTS` 使用规范化允许列表；生产环境要求显式配置，
   并在启动时校验空值、重复、协议误配和跨列表重叠。
2. 原始 HTTP `Host` 是产品渠道的唯一来源。服务端忽略
   `X-Forwarded-Host` 和 `Forwarded`，记录未知或畸形 Host 的拒绝事件。
3. Host gate 位于 JSON、表单、Cookie、鉴权、数据库和 Multer 之前。除
   `/api/health` 外，未知 Host 的业务 API 统一 fail closed。
4. 解析结果写入只读的 `request.productChannel`；上传、私有材料下载和管理材料路由
   统一经过 AI channel gate。
5. commerce catalog/order 使用 `request.productChannel`。请求中的 channel 仅执行
   严格一致性校验；SKU、list、total、detail、payment recovery、payment prepare 和
   invoice transaction 均执行服务端 channel scope。
6. `MAIN_APP_ORIGIN`、`AI_APP_ORIGIN` 显式映射支付回跳地址；两者必须是对应 Host
   允许列表内的 canonical origin，并同时包含在 `APP_ORIGIN` CORS 列表中。
7. assessment 创建、更新、认领和用户历史按产品 Host 分区。AI 上传关联的 assessment
   必须属于 AI 产品通道。
8. 主站管理概览、事件、审计和系统信息隐藏材料统计、材料事件、材料操作和 uploads
   表计数；AI 管理端保留完整材料信息。
9. 集成测试覆盖 main、AI、未知/畸形 Host、伪造 forwarded host、跨渠道 SKU/订单、
   支付与发票零副作用、Multer 零写入、AI 正向材料能力和同用户双通道真实数据库隔离。

测试中的 catalog 与 order 仓库使用固定 stub，并只对 commerce order 路径注入测试用户，
确保 RED 来自缺失的 Host gate/channel-scoped repository contract，不会被本地数据库、
鉴权或客户端过滤掩盖。

## 回归执行

该契约已纳入默认测试集，可直接执行：

```bash
npx vitest run server/tests/product-host-boundary.red.test.ts
```

完整验收还包括全量服务端测试、生产构建、双站构建产物隔离校验和
`orders(user_id, product_channel, created_at DESC, id DESC)` 数据库索引。
