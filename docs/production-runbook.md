# 赔了么生产运维手册

## 生产基线

- 用户端：`https://peileme.art/`
- 管理后台：`https://peileme.art/admin`
- 服务器：`94.74.110.223`
- 1Panel 编排目录：`/opt/1panel/docker/compose/peileme`
- 回环端口：`127.0.0.1:18083`
- OpenResty 配置：`/opt/1panel/www/conf.d/peileme.art.conf`
- 数据卷：`peileme_peileme_postgres`
- 材料卷：`peileme_peileme_uploads`
- 生产配置：编排目录下的 `.env`，权限必须保持 `0600`

数据库和 API 仅位于 Compose 内部网络，Web 端口仅绑定服务器回环地址。公网流量统一经 1Panel OpenResty 和 HTTPS 进入。

## 常用检查

```bash
cd /opt/1panel/docker/compose/peileme
docker compose ps
curl -fsS http://127.0.0.1:18083/api/health
docker compose logs --tail=200 api
docker compose logs --tail=200 web
```

公网检查：

```bash
curl -fsS https://peileme.art/api/health
curl -I https://peileme.art/admin
```

## 发布

1. 将确认过的源码同步至编排目录，保留生产 `.env` 和数据卷。
2. 运行构建与启动：

   ```bash
   docker compose up -d --build
   ```

3. 等待 `db`、`api`、`web` 全部变为 `healthy`。
4. 检查回环地址、根域、`www` 和管理后台。
5. 主动重启 API/Web，确认自动恢复和持久化数据不变。

Web Nginx 使用 Docker 内置 DNS 动态解析 API，API 容器重建后无需同步重启 Web。

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

证书由 acme.sh 管理，覆盖 `peileme.art` 和 `www.peileme.art`。证书安装路径：

```text
/opt/1panel/www/sites/peileme.art/ssl/fullchain.pem
/opt/1panel/www/sites/peileme.art/ssl/privkey.pem
```

root crontab 已配置 acme.sh 自动续期；续期后会重载 1Panel OpenResty。

## 验证码渠道

- 邮箱：阿里云邮件推送，生产已启用；当前凭据可正常调用 `dm:SingleSendMail`。
- 短信：代码与阿里云短信适配器已就绪；当前阿里云账号尚未开通云通信短信产品，因此生产保持关闭。
- `OTP_DEBUG=false` 必须长期保持，生产响应不会返回验证码。

开通短信后还需准备审核通过的短信签名和验证码模板，再为生产身份增加最小发送权限并填写四个 `ALIYUN_SMS_*` 配置项。

生产稳定后应把邮件推送凭据收敛到仅允许 `dm:SingleSendMail` 的独立 RAM 身份，并完成密钥轮换。
