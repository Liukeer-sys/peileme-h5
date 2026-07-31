# 赔了么生产运维手册

## 生产基线

- 用户端：`https://peileme.art/`
- AI 端：`https://ai.peileme.art/`
- 管理后台：`https://peileme.art/admin`、`https://ai.peileme.art/admin`
- 服务器：`94.74.110.223`
- 1Panel 编排目录：`/opt/1panel/docker/compose/peileme`
- 规则站服务：`web-main`，回环端口 `127.0.0.1:18083`
- AI 站服务：`web-ai`，回环端口 `127.0.0.1:18084`
- OpenResty 配置：`/opt/1panel/www/conf.d/peileme.art.conf`
- 数据卷：`peileme_peileme_postgres`
- 材料卷：`peileme_peileme_uploads`
- 生产配置：编排目录下的 `.env`，权限必须保持 `0600`

数据库和 API 仅位于 Compose 内部网络，两个 Web 端口仅绑定服务器回环地址。公网流量统一经 1Panel OpenResty 和 HTTPS 进入。`web-main` 与 `web-ai` 共享同一个健康 API 和 PostgreSQL。

## 常用检查

```bash
cd /opt/1panel/docker/compose/peileme
docker compose ps
curl -fsS http://127.0.0.1:18083/api/health
curl -fsS http://127.0.0.1:18084/api/health
curl -fsS http://127.0.0.1:18083/ | rg "赔了么"
curl -fsS http://127.0.0.1:18084/ | rg "赔了么"
docker compose logs --tail=200 api
docker compose logs --tail=200 web-main
docker compose logs --tail=200 web-ai
```

公网检查：

```bash
curl -fsS https://peileme.art/api/health
curl -fsS https://ai.peileme.art/api/health
curl -I https://peileme.art/admin
curl -I https://ai.peileme.art/admin
```

真实浏览器验收：

```bash
E2E_BASE_URL=https://peileme.art \
E2E_MAIN_BASE_URL=https://peileme.art \
E2E_AI_BASE_URL=https://ai.peileme.art \
E2E_USER_EMAIL='独立验收账号' \
E2E_USER_PASSWORD='验收账号密码' \
E2E_USER_BUTTON_NAME='账号称呼前四字' \
E2E_ADMIN_EMAIL=admin@peileme.art \
E2E_ADMIN_PASSWORD='从生产 .env 安全读取' \
E2E_INVITE_CODE='从生产 .env 安全读取' \
npm run test:e2e:production -- \
  e2e/production.spec.ts \
  e2e/persistence-admin.spec.ts \
  e2e/dual-web-compose.spec.ts
```

上述生产安全套件执行移动端测算、持久化管理回查和双站管理员登录链路。验收账号需预先写入测算、邀请码兑换、埋点和小型 PDF 材料，测试会核对用户侧私有下载、普通用户越权拦截及管理后台持久化结果。依赖 `OTP_DEBUG=true` 并创建测试用户的双构建共享会话用例仅允许在隔离的本地 Compose 环境执行。

本地或预发 Compose 的故障恢复验收使用专属项目名。脚本会通过同一 Compose 项目的 `db` service 写入唯一持久化标记，先验收双站浏览器链路，重启 `api web-main web-ai` 并等待健康，再复核标记和双站链路，最后删除标记：

```bash
E2E_COMPOSE_PROJECT=peileme-acceptance \
E2E_MAIN_BASE_URL=http://127.0.0.1:18083 \
E2E_AI_BASE_URL=http://127.0.0.1:18084 \
E2E_ADMIN_EMAIL='隔离环境管理员账号' \
E2E_ADMIN_PASSWORD='隔离环境管理员密码' \
npm run test:e2e:dual-compose
```

## 发布

1. 将确认过的源码同步至编排目录，保留生产 `.env` 和数据卷。
2. 规则迁移前必须完成数据库备份，并验证数据库与材料归档。API 容器启动时会执行迁移，因此以下命令必须早于 API 构建切换：

   ```bash
   backup_output="$(/opt/1panel/docker/compose/peileme/deploy/backup.sh)" || exit 1
   printf '%s\n' "$backup_output"
   latest="$(printf '%s\n' "$backup_output" | sed -n 's/^Peileme backup completed: //p' | tail -1)"
   test -n "$latest"
   case "$latest" in
     /opt/1panel/backup/peileme/*) ;;
     *) echo "Unexpected backup directory: $latest" >&2; exit 1 ;;
   esac
   gzip -t "$latest/database.sql.gz"
   tar -tzf "$latest/uploads.tar.gz" >/dev/null
   ```

3. 为当前运行镜像保留统一回滚标签：

   ```bash
   rollback_tag="rollback-$(date -u +%Y%m%dT%H%M%SZ)"
   docker image tag peileme-api:latest "peileme-api:$rollback_tag"
   docker image tag peileme-web-main:latest "peileme-web-main:$rollback_tag"
   docker image tag peileme-web-ai:latest "peileme-web-ai:$rollback_tag"
   ```

4. 运行构建与启动：

   ```bash
   docker compose up -d --build --wait
   ```

5. 确认 `db`、`api`、`web-main`、`web-ai` 全部为 `healthy`，再执行回环和公网检查。
6. 主动重启三个应用服务并等待自动恢复：

   ```bash
   docker compose restart api web-main web-ai
   docker compose up -d --wait
   docker compose ps
   ```

7. 检查根域、`www`、AI 子域、两个管理后台、API 安全头及持久化数据。

两个 Web Nginx 使用 Docker 内置 DNS 动态解析 API，API 容器重建后会重新解析共享 API 地址。

## 镜像回滚

回滚使用发布前记录的同一个 `rollback-<UTC时间>` 标签，先停止写入并确认数据库迁移兼容性。若迁移不兼容，按同批数据库备份恢复后再切换镜像。

```bash
rollback_tag="rollback-20260731T000000Z"
docker image tag "peileme-api:$rollback_tag" peileme-api:latest
docker image tag "peileme-web-main:$rollback_tag" peileme-web-main:latest
docker image tag "peileme-web-ai:$rollback_tag" peileme-web-ai:latest
docker compose up -d --no-build --wait api web-main web-ai
docker compose ps
```

回滚后重复两个回环端口、两个公网域名、`/api/health` 和管理后台检查，并核对规则版本、区域参数与用户历史。

## 备份

定时任务每天 03:20 执行：

```text
/opt/1panel/docker/compose/peileme/deploy/backup.sh
```

备份保存于 `/opt/1panel/backup/peileme/<UTC时间>/`，包含：

- `database.sql.gz`
- `uploads.tar.gz`
- `production.env`
- `manifest.txt`

目录和文件分别使用 `0700`、`0600` 权限，自动保留 14 天。手动验证：

```bash
latest="$(find /opt/1panel/backup/peileme -mindepth 1 -maxdepth 1 -type d | sort | tail -1)"
gzip -t "$latest/database.sql.gz"
tar -tzf "$latest/uploads.tar.gz" >/dev/null
```

恢复会覆盖生产数据，应先停止写入、另存当前卷并在维护窗口执行。

## 证书

证书由 acme.sh 管理，分别覆盖规则站和 AI 站。证书安装路径：

```text
/opt/1panel/www/sites/peileme.art/ssl/fullchain.pem
/opt/1panel/www/sites/peileme.art/ssl/privkey.pem
/opt/1panel/www/sites/ai.peileme.art/ssl/fullchain.pem
/opt/1panel/www/sites/ai.peileme.art/ssl/privkey.pem
```

root crontab 已配置 acme.sh 自动续期；续期后会重载 1Panel OpenResty。

## 验证码渠道

- 邮箱：阿里云邮件推送，生产已启用；当前凭据可正常调用 `dm:SingleSendMail`。
- 短信：代码与阿里云短信适配器已就绪；当前阿里云账号尚未开通云通信短信产品，因此生产保持关闭。
- `OTP_DEBUG=false` 必须长期保持，生产响应不会返回验证码。

开通短信后还需准备审核通过的短信签名和验证码模板，再为生产身份增加最小发送权限并填写四个 `ALIYUN_SMS_*` 配置项。

生产稳定后应把邮件推送凭据收敛到仅允许 `dm:SingleSendMail` 的独立 RAM 身份，并完成密钥轮换。
