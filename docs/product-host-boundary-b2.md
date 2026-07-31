# B2：产品 Host 与 API 边界

状态：待实现。B1 只隔离浏览器构建产物；本文件和
`server/tests/product-host-boundary.red.test.ts` 固化下一步服务端契约。

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

## 建议实现点

1. 在配置中加入规范化后的主站/AI Host 允许列表，启动时校验重复、空值和协议误配。
2. 在代理信任边界内解析有效 Host；只接受部署层转发的 Host 信息，并记录拒绝事件。
3. 在路由挂载前写入只读的 `request.productChannel`。
4. 将上传路由与 AI 管理材料路由挂到 AI channel gate 后。
5. commerce catalog/order 从 `request.productChannel` 取渠道；请求体中的 `channel`
   最多用于一致性校验。订单 list/history 的仓储查询也必须带服务端派生的 channel
   条件，防止跨产品订单进入响应。
6. 增加 main、AI、未知 Host、伪造 forwarded host、catalog/order 跨渠道和管理员材料接口的集成用例。订单 list 仓储函数接收服务端 channel
   作为第 4 个参数，detail 仓储函数接收服务端 channel 作为第 3 个参数；正常
   main/AI list 与 detail 响应也要逐项断言只包含对应 channel。
7. 管理材料边界同时覆盖列表和 `/:id/download`，避免只隐藏导航或列表后仍可按 ID 下载。

主站订单入口登记为后续支付 UI 任务：完成上述服务端 channel-scoped list/history
契约后，再在 `MainAccountPanel` 接入真实主站订单。B1 保持现有非订单账号能力，
不引入客户端全量订单过滤。

测试中的 catalog 与 order 仓库使用固定 stub，并只对 commerce order 路径注入测试用户，
确保 RED 来自缺失的 Host gate/channel-scoped repository contract，不会被本地数据库、
鉴权或客户端过滤掩盖。

## RED 执行

当前测试默认跳过，避免 B1 提交让常规测试永久失败。B2 开始时执行：

```bash
RUN_B2_PRODUCT_HOST_RED=1 npx vitest run server/tests/product-host-boundary.red.test.ts
```

实现完成的验收条件是该命令转绿，并纳入默认测试集（删除环境开关）。
