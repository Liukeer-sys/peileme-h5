# 赔了么

移动端优先的离职赔偿预评估产品。原有 H5 视觉和对话式测算保持不变，现已接入生产可用的账号、数据、邀请码、材料与管理能力。

## 已实现能力

- H5 对话测算、结果页、法条案例包、证据包和材料签署提示
- 邮箱/手机号验证码、密码注册登录、会话刷新、退出与找回密码
- 游客测算自动保存，登录后认领历史记录
- 邀请码多权益授权、次数与有效期控制
- PDF/JPG/PNG/WebP 私有上传、文件签名校验、本人下载
- 全链路埋点、访客会话、转化统计
- 管理后台：经营概览、用户、测算、材料、邀请码、埋点、审计、系统状态
- `admin` / `analyst` 分级权限，关键操作审计
- PostgreSQL 迁移、初始化管理员、容器健康检查与持久化卷
- SMTP、阿里云邮件推送、阿里云短信适配器

## 本地开发

```bash
npm ci
cp .env.example .env
npm run db:migrate
npm run dev:api
npm run dev
```

默认地址为 `http://localhost:5173`。也可直接使用 Docker Compose 启动完整栈：

```bash
cp .env.example .env
docker compose up -d --build
```

Compose 仅把 Web 绑定到 `127.0.0.1:${WEB_PORT}`；数据库和 API 保持在内部网络。

## 质量检查

```bash
npm run build
npm test
npm run test:e2e:production
npm audit --omit=dev
docker compose config
```

生产端到端验收需要独立验收账号，并显式提供用户、管理员和邀请码凭据；凭据不会写入报告或仓库：

```bash
E2E_USER_EMAIL='独立验收账号' \
E2E_USER_PASSWORD='验收账号密码' \
E2E_USER_BUTTON_NAME='账号称呼前四字' \
E2E_ADMIN_EMAIL=admin@peileme.art \
E2E_ADMIN_PASSWORD='从生产 .env 安全读取' \
E2E_INVITE_CODE='从生产 .env 安全读取' \
npm run test:e2e:production
```

默认执行移动端测算与持久化管理回查两条真实链路：完成测算、校验邀请码权益、下载私有材料，并在管理后台核对权限、埋点、材料和审计记录。

集成测试使用独立 PostgreSQL，默认连接：

```text
postgresql://peileme_test:peileme_test@127.0.0.1:55432/peileme_test
```

## 生产部署

生产编排文件为 `docker-compose.yml`：

1. 从 `.env.example` 创建 `.env`，生成独立的数据库、JWT、OTP、管理员和邀请码密钥。
2. 配置 `APP_ORIGIN`、邮件或短信渠道，保持 `OTP_DEBUG=false`。
3. 运行 `docker compose up -d --build`。
4. 由 1Panel OpenResty 将域名反代到 `127.0.0.1:${WEB_PORT}`。
5. 配置 HTTPS 后，从公网检查 `/api/health`，并验证容器重启恢复。

部署时禁止提交 `.env`、上传材料和数据库卷。验证码、Cookie 与鉴权头会从日志中脱敏。

## 主要目录

```text
database/migrations/   PostgreSQL 迁移
deploy/                Nginx / OpenResty 模板
server/                Express API、认证、通知与测试
src/admin/             管理后台
src/auth/              前端会话与账号状态
src/components/        H5 与账号组件
src/lib/api.ts         API、下载和埋点客户端
```

页面测算结果属于预评估信息，不构成正式法律意见；最终金额和风险需结合劳动合同、工资流水及沟通记录判断。
