# T4.2 支付配置与 Provider 契约验收证据

验收日期：2026-08-01

## 范围

- `PAYMENT_MODE=live` 启动门禁与真实渠道清单；
- 微信、支付宝凭证完整性及 HTTPS 通知源校验；
- 只读文件与 `env:VARIABLE_NAME` secret 引用加载；
- 真实支付渠道类型、registry 可见渠道与 legacy `fake` 数据读取兼容；
- 配置和 registry 构造阶段零支付机构网络请求。

微信 APIv3、支付宝 WAP 协议适配器、通知、退款和订单路由不属于本子任务。

## TDD 证据

首次恢复 lockfile 依赖后运行既有 RED：

```text
npx vitest run server/tests/real-payment-config.red.test.ts
5 tests: 4 failed, 1 passed
```

失败分类：test 环境 fake 未禁用 1 项；`live` 尚未进入凭证与 HTTPS 校验 2 项；registry 缺失 1 项。production 禁用 fake 已通过。

补齐门槛后的 RED：配置契约 13 项中 12 项失败、1 项通过；secret loader 模块缺失导致其测试文件按预期收集失败。最小实现后的定向结果：

```text
Test Files  2 passed (2)
Tests       18 passed (18)
```

## 回归证据

配置、Host、dotenv、证据脱敏相关回归：

```text
Test Files  6 passed (6)
Tests       91 passed (91)
```

在 `peileme-b2-root-pg` 的 T4.2 专属临时数据库执行支付分组：

```text
Test Files  6 passed (6)
Tests       201 passed (201)
commerce    92 passed
migration   58 passed
identity    7 passed
```

临时库 `peileme_t42_contract_20260731` 已删除；数据库记录数与活动连接数均为 0。未访问 55432、55433。

API TypeScript 构建：

```text
npm run build:api
exit 0
```

项目级单进程全量在并行 T4.1 新 RED 写入共享工作树后停止：新增最大稀疏数组用例触发约 4 GB 堆 OOM，且 commerce 的新增敏感别名 RED 尚待 T4.1 修复。该运行不用于判定 T4.2；T4.1 稳定后应以独占分片重跑项目全量。

T4.1 稳定后，纳入配置测试并仅排除两个尚未实现的渠道适配器 RED，
项目级单进程回归为 30 files / 722 tests 全部通过。

独立安全复审新增 8 条 RED：FIFO 阻塞、非法 UTF-8、NUL、非 ASCII
APIv3 key、可变配置缓存、商户 ID 空白、registry 工厂非原子调用和残缺
provider runtime contract。修复后的配置与 Host 聚焦回归为 6 files / 136
tests 全部通过，其中配置/secret/registry 为 26/26。

## 自审结论

- `fake` 配置在 test 与 production 均 fail-fast；
- `live` 空渠道、缺失凭证、缺失/不可读/可写 secret 文件、非 HTTPS 通知源、非 32 字节微信 APIv3 key 均 fail-fast；
- secret 文件以 `O_NOFOLLOW | O_NONBLOCK` 打开并校验为只读普通文件，
  FIFO/设备/软链接均快速拒绝；原始字节执行有界读取、严格 UTF-8 与 NUL
  校验，错误不包含 secret 值；
- `env:` 引用只把环境变量名保留在配置对象中，secret 值不进入配置序列化；
- 微信 APIv3 key 必须为 32 字节可打印 ASCII，商户标识不得包含首尾空白；
- 规范化配置和渠道数组递归冻结，验证后不能注入未校验渠道；
- registry 在调用任何工厂前预检全部依赖，并校验 provider 的 channel 与
  create/query/refund runtime contract；仅在全部成功后发布冻结的渠道元数据；
- registry/config 构造测试将全局 `fetch` 设为失败哨兵，网络调用计数为 0；
- `RealPaymentChannel` 明确限定微信 H5 与支付宝 WAP，现有 `PaymentChannel`/`FakePaymentProvider` 继续支持历史数据与旧测试读取。
