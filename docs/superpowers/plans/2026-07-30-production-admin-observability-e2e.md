# Production Admin, Observability and Full E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the operations/admin surface, trustworthy analytics, announcements, support and data-rights flows, deploy both domains through 1Panel with monitoring and off-host backup, and pass a real-user Playwright acceptance suite across happy and unhappy paths.

**Architecture:** Finish the shared backend as capability-scoped modules and make critical business events server-authored. Run application and observability services as supervised Compose projects behind 1Panel OpenResty. Release through backup, migration, blue/green loopback verification, DNS/TLS switch, deliberate recovery tests and external Playwright acceptance.

**Tech Stack:** React 19, Express 5, PostgreSQL 16, Redis 7, Prometheus, Grafana, Loki, Alertmanager, Node/Pino/OpenTelemetry-compatible request IDs, Docker Compose, 1Panel OpenResty, Aliyun DNS/OSS, GitHub Actions, Playwright 1.62

**Prerequisites:** Complete the policy, commerce and AI implementation plans in order.

---

## File map

### Create

- `database/migrations/005_operations.sql` — event catalog, content pages, support tickets, export/delete jobs, admin capabilities and operational settings.
- `server/modules/analytics/catalog.ts` — allowlisted client events and server event writer.
- `server/modules/analytics/routes.ts` — bounded client ingestion and admin funnels.
- `server/modules/content/routes.ts` — public announcements, pages and admin CRUD.
- `server/modules/support/routes.ts` — user tickets and admin handling.
- `server/modules/privacy/routes.ts` — export, delete and account closure jobs.
- `server/modules/admin/routes.ts` — shared dashboard, users, sessions and capability summary.
- `server/modules/metrics.ts` — Prometheus-format application and business metrics.
- `server/modules/alerts.ts` — authenticated Alertmanager-to-Feishu relay.
- `server/telemetry.ts` — OpenTelemetry SDK and OTLP exporter initialization.
- `server/scheduled-jobs.ts` — order, AI retry, cleanup, reconciliation and operational schedules.
- `server/tests/operations.test.ts` — analytics, content, support, privacy and capability tests.
- `src/admin/AdminLayout.tsx` — navigation, capability visibility and shared table/forms.
- `src/admin/OverviewAdmin.tsx` — business and system overview.
- `src/admin/UserAdmin.tsx` — account, sessions, grants, jobs and deletion requests.
- `src/admin/ContentAdmin.tsx` — announcements, banners, FAQ and agreements.
- `src/admin/AnalyticsAdmin.tsx` — trusted funnel, conversion, revenue and provider views.
- `src/admin/LogsAdmin.tsx` — audit, error, payment and AI metadata filters.
- `src/admin/SystemAdmin.tsx` — dependency, queue, storage and backup status.
- `src/components/AnnouncementBanner.tsx` — placement/date-aware public announcement.
- `src/components/SupportPanel.tsx` — user support and data requests.
- `.github/workflows/ci.yml` — database-backed tests, builds, fixture E2E and audit.
- `deploy/observability/docker-compose.observability.yml` — Prometheus/Grafana/Loki/Alertmanager.
- `deploy/observability/prometheus.yml` — scrape configuration.
- `deploy/observability/alert-rules.yml` — application, payment, AI, queue, host and backup alerts.
- `deploy/observability/alertmanager.yml` — Feishu webhook relay configuration.
- `deploy/observability/loki.yml` — bounded retention.
- `deploy/observability/tempo.yml` — bounded OTLP trace storage.
- `deploy/observability/grafana/provisioning/datasources/datasources.yml` — data sources.
- `deploy/observability/grafana/provisioning/dashboards/dashboards.yml` — dashboard provider.
- `deploy/observability/grafana/dashboards/peileme-overview.json` — production dashboard.
- `deploy/backup/base-backup.sh` — database/files/config backup and encrypted OSS copy.
- `deploy/backup/archive-wal.sh` — PostgreSQL WAL archive.
- `deploy/backup/restore-drill.sh` — isolated restore verification.
- `deploy/backup/verify-backup.sh` — manifest and archive checks.
- `e2e/pages/AuthPage.ts` — role/label-based auth actions.
- `e2e/pages/MainPolicyPage.ts` — real policy questionnaire actions.
- `e2e/pages/AiAnalysisPage.ts` — upload/facts/preview/report actions.
- `e2e/pages/AdminPage.ts` — admin navigation and state checks.
- `e2e/fixtures/e2e-payroll.png` — synthetic payroll image.
- `e2e/auth-unhappy.spec.ts` — OTP, password, session and rate limits.
- `e2e/admin-full.spec.ts` — all admin modules and role mismatches.
- `e2e/cross-domain.spec.ts` — shared login/history and channel separation.
- `e2e/resilience.spec.ts` — weak network, duplicate click, refresh and recovery.
- `e2e/security.spec.ts` — ownership, capability and upload access.
- `e2e/production-acceptance.spec.ts` — external production orchestration.
- `docs/release-acceptance-2026-07.md` — durable final evidence and known external blockers.

### Modify

- `package.json` / `package-lock.json` — metrics and CI scripts.
- `server/app.ts` — final module mounting, request ID and internal metrics authorization.
- `server/config.ts` — monitoring, support and retention.
- `server/security.ts` — complete capability matrix and session revocation.
- `server/tests/api.test.ts` — migration truncation and compatibility.
- `src/admin/AdminDashboard.tsx` — compatibility export for modular admin.
- `src/auth/AuthContext.tsx` — capabilities and session events.
- `src/main/MainApp.tsx` / `src/ai/AiApp.tsx` — announcements and support.
- `src/lib/api.ts` — typed allowlisted events and request ID capture.
- `playwright.config.ts` — main/AI/admin/mobile/desktop projects.
- `docker-compose.yml` — production resource limits, metrics and backup mounts.
- `deploy/openresty-site.conf.template` — both domains, security headers and blue/green upstreams.
- `deploy/backup.sh` — delegate to new backup scripts.
- `docs/production-runbook.md` — final deploy, monitoring, rollback and recovery.
- `.env.example` — monitoring, alerting, retention and backup.

## Task 1: Make analytics trustworthy and complete the operations schema

**Files:**
- Create: `database/migrations/005_operations.sql`
- Create: `server/modules/analytics/catalog.ts`
- Create: `server/modules/analytics/routes.ts`
- Create: `server/tests/operations.test.ts`
- Modify: `server/app.ts`
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Write failing allowlist and server-event tests**

```ts
it("rejects an unregistered client event and unknown fields", async () => {
  await request(createApp())
    .post("/api/events/batch")
    .set(visitorHeaders)
    .send({ events: [{ name: "invented_revenue", properties: { amountFen: 999999 } }] })
    .expect(400);
});

it("uses server-authored payment events for revenue", async () => {
  await writeServerEvent({
    name: "payment_succeeded",
    userId,
    orderId,
    properties: { sku: "POLICY_CALC", amountFen: 990, channel: "alipay_wap" }
  });
  const funnel = await loadTrustedFunnel({ days: 30 });
  expect(funnel.revenueFen).toBe(990);
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
npm run test:db:up
npm test -- --run server/tests/operations.test.ts
```

Expected: FAIL because arbitrary event names are currently accepted.

- [ ] **Step 3: Create the operations migration**

```sql
CREATE TABLE analytics_event_catalog (
  event_name TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('client', 'server')),
  schema_version INTEGER NOT NULL DEFAULT 1,
  allowed_properties JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (
  role IN (
    'user', 'admin', 'policy_editor', 'policy_reviewer', 'operations',
    'finance', 'support', 'ai_operator', 'auditor', 'analyst'
  )
);

ALTER TABLE analytics_events
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'client'
    CHECK (source IN ('client', 'server')),
  ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ai_job_id UUID REFERENCES ai_jobs(id) ON DELETE SET NULL;

CREATE TABLE content_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  version INTEGER NOT NULL,
  published_at TIMESTAMPTZ,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_no TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (
    category IN ('account', 'calculation', 'analysis', 'payment', 'refund', 'privacy', 'other')
  ),
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  resolution TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_data_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_type TEXT NOT NULL CHECK (request_type IN ('export', 'delete', 'close_account')),
  status TEXT NOT NULL CHECK (status IN ('submitted', 'processing', 'completed', 'rejected')),
  object_key TEXT,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE service_heartbeats (
  service_name TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  status TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  seen_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX analytics_events_server_facts_idx
  ON analytics_events(event_name, occurred_at DESC)
  WHERE source = 'server';
CREATE INDEX support_tickets_status_idx ON support_tickets(status, created_at DESC);
CREATE INDEX user_data_requests_status_idx ON user_data_requests(status, created_at);
```

- [ ] **Step 4: Define the event catalog**

`catalog.ts` exports a constant map. Client events include page, auth UI, policy steps, AI steps, checkout launch, history and UX failure. Server events include registration, free entitlement, order creation, payment success, refund, policy completion, AI completion, invite attribution and report download.

Example:

```ts
export const clientEventSchemas = {
  page_view: z.object({ channel: z.enum(["main", "ai", "admin"]) }),
  policy_step_completed: z.object({
    step: z.enum(["region", "employment", "salary", "termination", "review"])
  }),
  checkout_launched: z.object({
    sku: z.enum(productSkus),
    channel: z.enum(["wechat_h5", "alipay_wap"])
  }),
  ux_error_shown: z.object({
    surface: z.string().max(40),
    code: z.string().max(80)
  })
} as const;
```

- [ ] **Step 5: Replace arbitrary ingestion**

`/api/events/batch` looks up the exact client schema, strips unlisted fields through Zod, caps timestamps to ±24 hours, caps strings and stores `source = client`. `writeServerEvent` is callable only from backend modules and accepts typed domain IDs.

- [ ] **Step 6: Build trusted funnel queries**

Revenue, paid conversion, refunds, fulfilled calculations and completed AI jobs come only from server events or source tables. Client events supply interaction drop-off only.

- [ ] **Step 7: Run operations tests**

Run:

```bash
npm test -- --run server/tests/operations.test.ts server/tests/api.test.ts
```

Expected: unknown events fail and trusted revenue succeeds.

- [ ] **Step 8: Commit**

```bash
git add database/migrations/005_operations.sql server/modules/analytics server/app.ts server/tests src/lib/api.ts
git commit -m "feat: enforce trusted analytics events"
```

## Task 2: Complete content, support, privacy and user administration

**Files:**
- Create: `server/modules/content/routes.ts`
- Create: `server/modules/support/routes.ts`
- Create: `server/modules/privacy/routes.ts`
- Create: `server/modules/admin/routes.ts`
- Create: `src/components/AnnouncementBanner.tsx`
- Create: `src/components/SupportPanel.tsx`
- Create: `src/admin/UserAdmin.tsx`
- Create: `src/admin/ContentAdmin.tsx`
- Modify: `server/security.ts`
- Modify: `server/app.ts`
- Modify: `src/main/MainApp.tsx`
- Modify: `src/ai/AiApp.tsx`
- Modify: `src/components/AccountPanel.tsx`
- Test: `server/tests/operations.test.ts`

- [ ] **Step 1: Add failing capability and ownership tests**

Test that operations can publish announcements but cannot refund, finance can refund but cannot publish policy rules, support can read assigned tickets but cannot download arbitrary documents, users can request their own export/delete, and every admin write creates an audit row.

- [ ] **Step 2: Seed the full capability matrix**

Roles:

```text
admin
policy_editor
policy_reviewer
operations
finance
support
ai_operator
auditor
analyst
user
```

Add the roles to the users constraint through migration-safe constraint replacement. Seed explicit capabilities for policy, content, users, commerce, refunds, reconciliation, AI, cases, logs, privacy and support. `/api/auth/me` returns a capability string array.

- [ ] **Step 3: Implement content routes**

Public:

```text
GET /api/public/announcements?placement=main|ai
GET /api/public/pages/:slug
```

Admin:

```text
GET/POST/PATCH /api/admin/announcements
GET/POST/PATCH /api/admin/content-pages
```

Only `published` content inside its active interval is public. Store every publication edit in audit logs.

- [ ] **Step 4: Implement support and privacy routes**

Users can create/list tickets, request export/delete/closure and see status. Admin can assign, resolve and reject with a reason. Export worker assembles profile, sessions, assessments, AI jobs, orders and tickets into a private JSON/ZIP object with a short signed URL. Delete/closure revokes sessions, deletes files, pseudonymizes required transaction references and disables the account.

- [ ] **Step 5: Build user admin**

Show identity, status, roles/capabilities, sessions, free/paid entitlements, policy history, AI jobs, orders, refunds, invites, tickets and data requests. High-risk actions require a typed reason and reflect server capabilities.

- [ ] **Step 6: Build content and support UX**

Both sites render placement-aware announcements. Account panel exposes support and data requests. Admin supports announcement scheduling, FAQ/agreement publication, ticket assignment and request processing.

- [ ] **Step 7: Run module tests**

Run:

```bash
npm test -- --run server/tests/operations.test.ts
```

Expected: capability, ownership, content and privacy tests pass.

- [ ] **Step 8: Commit**

```bash
git add server/modules server/security.ts server/app.ts src/components src/admin src/main src/ai server/tests
git commit -m "feat: complete content support and account operations"
```

## Task 3: Modularize and complete the management console

**Files:**
- Create: `src/admin/AdminLayout.tsx`
- Create: `src/admin/OverviewAdmin.tsx`
- Create: `src/admin/AnalyticsAdmin.tsx`
- Create: `src/admin/LogsAdmin.tsx`
- Create: `src/admin/SystemAdmin.tsx`
- Modify: `src/admin/AdminDashboard.tsx`
- Modify: `src/admin/admin.css`
- Modify: `server/modules/admin/routes.ts`
- Test: `e2e/admin-full.spec.ts`

- [ ] **Step 1: Write the failing full-admin test**

The test logs in as admin and visits:

```ts
const sections = [
  "经营概览", "用户与账号", "政策规则", "地域参数", "商品价格",
  "订单支付", "退款对账", "AI 路由", "AI 任务", "案例库",
  "公告与页面", "邀请码", "数据统计", "日志审计", "系统监控"
];
for (const section of sections) {
  await page.getByRole("button", { name: new RegExp(section) }).click();
  await expect(page.getByRole("heading", { name: section })).toBeVisible();
}
```

- [ ] **Step 2: Split the 427-line dashboard**

`AdminDashboard.tsx` becomes a compatibility export that renders `AdminLayout`. `AdminLayout` owns navigation, route state, capability filtering, common load/error state and profile. Each module owns its API contracts and UI.

- [ ] **Step 3: Complete overview and analytics**

Overview contains verified visitors, registrations, first-free use, paid conversion, revenue, refunds, AI success/fallback, regional coverage, queue and host health. Analytics supports date, channel, SKU, region, acquisition and invite filters.

- [ ] **Step 4: Complete logs and system views**

Logs show access request IDs, app errors, immutable audits, payment state transitions and body-free LLM calls. System shows API/DB/Redis/queue/object store/scanner/provider/worker/backup/SSL states and recent alerts.

- [ ] **Step 5: Align UI and API capabilities**

The navigation and buttons use the exact capability array from `/api/auth/me`. Every write endpoint uses the same capability name. Add a matrix E2E that visits each role and verifies visible controls plus direct API denial.

- [ ] **Step 6: Run admin browser tests**

Run:

```bash
npx playwright test e2e/admin-full.spec.ts
```

Expected: every module loads and role mismatches are blocked at UI and API levels.

- [ ] **Step 7: Commit**

```bash
git add src/admin server/modules/admin e2e/admin-full.spec.ts
git commit -m "feat: complete capability-scoped management console"
```

## Task 4: Add application metrics, dashboards, logs and alerts

**Files:**
- Create: `server/modules/metrics.ts`
- Create: `server/modules/alerts.ts`
- Create: `server/telemetry.ts`
- Create: `deploy/observability/docker-compose.observability.yml`
- Create: `deploy/observability/prometheus.yml`
- Create: `deploy/observability/alert-rules.yml`
- Create: `deploy/observability/alertmanager.yml`
- Create: `deploy/observability/loki.yml`
- Create: `deploy/observability/tempo.yml`
- Create: `deploy/observability/grafana/provisioning/datasources/datasources.yml`
- Create: `deploy/observability/grafana/provisioning/dashboards/dashboards.yml`
- Create: `deploy/observability/grafana/dashboards/peileme-overview.json`
- Modify: `server/app.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.env.example`

- [ ] **Step 1: Install metrics and tracing packages**

Run:

```bash
npm install prom-client@15.1.3
npm install @opentelemetry/sdk-node@0.221.0 @opentelemetry/auto-instrumentations-node@0.79.0 @opentelemetry/exporter-trace-otlp-http@0.221.0
```

- [ ] **Step 2: Write metric tests**

Request health, policy calculate, checkout and a controlled failed AI job, then assert `/internal/metrics` contains:

```text
peileme_http_requests_total
peileme_http_request_duration_seconds
peileme_policy_calculations_total
peileme_payment_transactions_total
peileme_ai_jobs_total
peileme_llm_fallback_total
peileme_queue_wait_seconds
```

Assert public requests without `METRICS_TOKEN` receive 404.

- [ ] **Step 3: Implement bounded metrics**

Use labels only for method, route template, status class, channel, SKU, job kind, provider and outcome. Exclude user, order, task, city and raw error labels to avoid cardinality growth.

- [ ] **Step 4: Initialize OpenTelemetry before application imports**

`server/telemetry.ts` configures `NodeSDK`, HTTP/Express/PostgreSQL/Redis instrumentation and OTLP HTTP export. It excludes health, metrics and static routes, preserves W3C `traceparent`, and adds trace/span IDs to Pino logs. `server/index.ts` starts telemetry before dynamically importing the app and shuts it down with the HTTP server.

- [ ] **Step 5: Provision the observability stack**

The Compose file runs pinned Prometheus, Grafana, Loki, Tempo, Promtail/Alloy, Alertmanager, node exporter, postgres exporter and Redis exporter. Bind Grafana only to `127.0.0.1:${GRAFANA_PORT:-18090}` for 1Panel proxy and keep the remaining services internal. Grafana provisions Prometheus, Loki and Tempo data sources so request IDs link metrics, logs and traces.

- [ ] **Step 6: Add alert rules**

Alerts:

- API 5xx > 2% for 5 minutes.
- P95 API latency > 2 seconds.
- Payment callback failures > 0 for 5 minutes.
- Reconciliation differences > 0.
- AI all-provider failure > 1% for 10 minutes.
- Queue oldest age > 5 minutes.
- DB down, Redis down, worker heartbeat stale.
- Disk > 80%, memory > 85%, repeated container restart.
- Backup age > 26 hours.
- TLS certificate < 14 days.

- [ ] **Step 7: Configure Feishu delivery**

`server/modules/alerts.ts` exposes an internal token-authenticated webhook. It validates the Alertmanager payload, formats service, severity, start time, summary, dashboard link and runbook link, then sends the Feishu message using the secret webhook. Alertmanager targets this internal endpoint. The Feishu webhook and relay token stay in environment secrets.

- [ ] **Step 8: Run metrics and configuration checks**

Run:

```bash
npm test -- --run server/tests/operations.test.ts
docker compose -f deploy/observability/docker-compose.observability.yml config
```

Expected: metric tests pass and Compose configuration validates.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json server/modules/metrics.ts server/modules/alerts.ts server/telemetry.ts server/app.ts server/index.ts deploy/observability .env.example server/tests
git commit -m "ops: add metrics dashboards logs and alerts"
```

## Task 5: Add off-host backup and restore drills

**Files:**
- Create: `deploy/backup/base-backup.sh`
- Create: `deploy/backup/archive-wal.sh`
- Create: `deploy/backup/restore-drill.sh`
- Create: `deploy/backup/verify-backup.sh`
- Modify: `deploy/backup.sh`
- Modify: `docker-compose.yml`
- Modify: `docs/production-runbook.md`

- [ ] **Step 1: Write shell safety checks**

Every script starts with:

```bash
#!/usr/bin/env bash
set -euo pipefail
umask 077
```

Scripts reject empty backup roots, require the target below `/opt/1panel/backup/peileme`, and never delete unresolved paths.

- [ ] **Step 2: Implement base backup**

`base-backup.sh` creates a timestamped directory, runs `pg_basebackup` with WAL included, archives object files, copies a redacted configuration manifest, generates SHA-256 checksums, encrypts the archive with the configured backup key, uploads it to Aliyun OSS, verifies remote size/checksum, and updates a `latest-success.json` status file.

- [ ] **Step 3: Implement WAL archive**

PostgreSQL `archive_mode=on` calls `archive-wal.sh %p %f`. The script copies each WAL segment atomically to the protected archive directory and schedules encrypted OSS sync. Existing files with matching checksum return success.

- [ ] **Step 4: Implement isolated restore drill**

`restore-drill.sh` selects the newest complete backup, creates a `mktemp -d` working directory, starts a temporary loopback-only PostgreSQL container with a unique name, restores base plus WAL, and checks migrations, row counts, one policy snapshot, one order and one AI job. It destroys only the exact temporary container and directory it created.

- [ ] **Step 5: Exercise backup and restore**

Run:

```bash
sudo /opt/1panel/docker/compose/peileme/deploy/backup/base-backup.sh
sudo /opt/1panel/docker/compose/peileme/deploy/backup/verify-backup.sh
sudo /opt/1panel/docker/compose/peileme/deploy/backup/restore-drill.sh
```

Expected: local and OSS verification succeeds; restore drill reports valid migrations and sample rows.

- [ ] **Step 6: Commit**

```bash
git add deploy/backup deploy/backup.sh docker-compose.yml docs/production-runbook.md
git commit -m "ops: add encrypted off-host backup and restore drills"
```

## Task 6: Build CI and the full Playwright matrix

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `e2e/pages/AuthPage.ts`
- Create: `e2e/pages/MainPolicyPage.ts`
- Create: `e2e/pages/AiAnalysisPage.ts`
- Create: `e2e/pages/AdminPage.ts`
- Create: `e2e/auth-unhappy.spec.ts`
- Create: `e2e/admin-full.spec.ts`
- Create: `e2e/cross-domain.spec.ts`
- Create: `e2e/resilience.spec.ts`
- Create: `e2e/security.spec.ts`
- Modify: `e2e/main-policy.spec.ts`
- Modify: `e2e/commerce.spec.ts`
- Modify: `e2e/ai-analysis.spec.ts`
- Modify: `playwright.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Define Playwright projects**

Add:

```ts
projects: [
  {
    name: "main-mobile",
    use: { baseURL: mainBaseUrl, viewport: { width: 390, height: 844 } }
  },
  {
    name: "ai-mobile",
    use: { baseURL: aiBaseUrl, viewport: { width: 390, height: 844 } }
  },
  {
    name: "admin-desktop",
    use: { baseURL: mainBaseUrl, viewport: { width: 1440, height: 1000 } }
  },
  {
    name: "desktop-cross-domain",
    use: { baseURL: mainBaseUrl, viewport: { width: 1280, height: 900 } }
  }
]
```

Use `E2E_MAIN_BASE_URL` and `E2E_AI_BASE_URL`; retain trace, screenshot and video on failure. Production acceptance uses one worker and zero retries.

- [ ] **Step 2: Create role-based page objects**

Page objects use labels, roles and visible names. They contain no arbitrary sleeps. Waits target API responses, progress states or persisted UI. `AuthPage` supports user/admin/analyst/finance/support accounts without logging credentials.

- [ ] **Step 3: Cover complete happy paths**

- Register with a real delivered email code.
- Log in on main and remain logged in on AI.
- Complete first-free policy calculation.
- Complete paid policy calculation.
- Complete AI preview, payment, real analysis, supplement, three follow-ups and report download.
- Complete document review.
- Redeem invite and verify attribution/reward.
- Reopen complete history on both domains.
- Admin edits price/rule/announcement, inspects user/order/job/log/monitor, then restores the original configuration.

- [ ] **Step 4: Cover complete unhappy paths**

- Wrong/expired/rate-limited OTP.
- Duplicate account, bad password, disabled user and revoked session.
- Invalid date, negative wage, missing/stale region parameters and boundary service periods.
- Payment cancel, timeout, duplicate launch/callback, mismatched amount, failed refund and recovery.
- Unsupported/spoofed/encrypted/infected file.
- Primary Provider timeout, fallback, all-provider outage, midstream interruption and retry.
- Refresh/close/reopen during upload, payment and analysis.
- Duplicate clicks and slow 3G.
- Cross-user assessment/file/order/job/report access.
- Every admin role attempting an unauthorized direct API write.
- Announcement expiration and hidden inactive price.

- [ ] **Step 5: Add persisted evidence assertions**

Tests query protected acceptance endpoints or admin UI to prove database rows, order transaction, entitlement usage, job events, LLM route, report object, audit log and server event exist. Assertions use generated run IDs to avoid mixing old data.

- [ ] **Step 6: Add CI**

GitHub Actions:

1. Checkout.
2. Setup Node 22 and cache npm.
3. `npm ci`.
4. Start PostgreSQL, Redis, MinIO and fake scanner/model services.
5. `npm test`.
6. `npm run build`.
7. Install Chromium.
8. Run fixture-provider Playwright matrix.
9. `npm audit --omit=dev`.
10. Upload Playwright report, traces and test results.

CI never receives production Provider or payment credentials.

- [ ] **Step 7: Run the local full matrix**

Run:

```bash
npm run test:db:up
npm test
npm run build
npx playwright test
npm audit --omit=dev
npm run test:db:down
```

Expected: all unit/API/build/E2E/audit checks pass.

- [ ] **Step 8: Commit**

```bash
git add .github e2e playwright.config.ts package.json package-lock.json
git commit -m "test: cover complete user admin and failure journeys"
```

## Task 7: Prepare and execute the 1Panel blue/green release

**Files:**
- Modify: `docker-compose.yml`
- Modify: `deploy/openresty-site.conf.template`
- Modify: `docs/production-runbook.md`
- Create: `docs/release-acceptance-2026-07.md`

- [ ] **Step 1: Capture the read-only production baseline**

Record:

```bash
ssh root@94.74.110.223 'uptime; free -h; df -h; docker ps --format "{{.Names}} {{.Status}}"; docker stats --no-stream'
ssh root@94.74.110.223 'cd /opt/1panel/docker/compose/peileme && docker compose ps && docker compose logs --tail=200 api'
curl -fsS https://peileme.art/api/health
```

Capture OOM, kernel and container restart evidence with `journalctl -k`, `dmesg` access where available and Docker inspect state. Make no service changes during baseline capture.

- [ ] **Step 2: Verify external dependencies**

Confirm:

- Aliyun DNS authority for root, `www` and `ai`.
- TLS issuance path for all three names.
- WeChat H5 domain and callbacks.
- Alipay app and callback.
- Tuzi/DataEyes connection tests.
- Mail, optional SMS, OSS and Feishu alerting.
- Production secret file mode `0600`.

- [ ] **Step 3: Back up before migration**

Run base backup, upload verification and restore drill. Save backup ID and restore result in the acceptance document.

- [ ] **Step 4: Build green services**

Build immutable images tagged with the exact Git commit. Start green API/workers/web services on new loopback ports, run migrations once, and verify internal health, policy, catalog, AI queue, admin and both web artifacts.

- [ ] **Step 5: Add DNS and TLS for AI**

Create/verify `ai.peileme.art` A record to `94.74.110.223`, wait for authoritative and public resolution, issue a certificate covering `peileme.art`, `www.peileme.art` and `ai.peileme.art`, and test it before proxy cutover.

- [ ] **Step 6: Switch OpenResty upstreams**

Route main and AI hosts to their green loopback ports. Run `openresty -t` through 1Panel’s binary/container path, reload, and immediately verify root, AI, admin and API from outside the server.

- [ ] **Step 7: Prove supervisor recovery**

Deliberately restart API, both web services, both workers and Redis one at a time. Reboot the production host during an agreed window. Verify every Compose service returns healthy, queued tasks resume, data persists and both public domains recover without manual shell-attached processes.

- [ ] **Step 8: Keep rollback ready**

Retain prior images, previous OpenResty upstream config and the pre-migration backup. Define rollback triggers for 5xx, payment mismatch, AI error, queue backlog and data migration failure.

- [ ] **Step 9: Commit deployment records**

```bash
git add docker-compose.yml deploy/openresty-site.conf.template docs/production-runbook.md docs/release-acceptance-2026-07.md
git commit -m "ops: release dual peileme production sites"
```

## Task 8: Run real production Playwright acceptance

**Files:**
- Create: `e2e/production-acceptance.spec.ts`
- Modify: `docs/release-acceptance-2026-07.md`
- Generated: `playwright-report/`
- Generated: `test-results/`

- [ ] **Step 1: Create isolated acceptance accounts and run ID**

Create fresh user, admin, analyst/readonly, finance and support accounts through supported admin/bootstrap flows. Store credentials in a protected untracked CSV with mode `0600`. Generate `E2E_RUN_ID` and attach it to created drafts, orders and tickets.

- [ ] **Step 2: Deliver the refreshed account CSV through the requesting Feishu conversation**

Include role, login identifier, password, intended scenario and expiry/cleanup note. Send the CSV through the exact Bridge conversation that requested the project, read the resulting message back, and record the verified message ID in the release acceptance document. Keep passwords out of Git, logs and the acceptance document.

- [ ] **Step 3: Run real registration and shared-session flow**

Use Playwright to type a real email, click send code, retrieve the delivered code through the authorized test mailbox mechanism, finish registration, reload, open `ai.peileme.art` and verify the same account without re-login.

- [ ] **Step 4: Run real main-site happy and unhappy flows**

Complete a verified-region first-free calculation, a paid calculation, history reload, custom-region manual parameter path, invalid form, session revocation and ownership denial.

- [ ] **Step 5: Run real AI happy and unhappy flows**

Upload synthetic PDF/DOCX/image files through real browser inputs, confirm extracted facts, create preview, purchase/unlock, wait for real Tuzi/DataEyes output, verify cases and report, supplement material, ask three questions, trigger primary disable/fallback, trigger a controlled all-provider failure, recover, and verify admin logs.

- [ ] **Step 6: Run real payment acceptance**

Playwright creates orders and clicks WeChat/Alipay launch actions. A human completes required external wallet authentication for the low-value acceptance order. Playwright resumes the return page, verifies server-paid state, entitlement, result, refund and reconciliation. Keep acceptance amount and refund within the configured test SKU.

- [ ] **Step 7: Run full admin acceptance**

Inspect and modify rules, regional parameters, prices, announcements, users, roles, orders, refunds, AI routes, jobs, cases, analytics, logs and monitoring. Restore every mutated production setting before the test ends. Verify readonly roles cannot write through both UI and direct API requests.

- [ ] **Step 8: Run resilience and recovery paths**

Use slow 3G, offline/online, reload, duplicate click and service restart coordination. Confirm drafts, orders and AI jobs resume without double charging or double entitlement use.

- [ ] **Step 9: Execute the full matrix**

Run:

```bash
E2E_MAIN_BASE_URL=https://peileme.art \
E2E_AI_BASE_URL=https://ai.peileme.art \
E2E_RUN_ID=release-2026-07-30 \
npx playwright test --workers=1
```

Expected: all production happy and unhappy projects pass with zero unexpected browser errors and zero 5xx responses.

- [ ] **Step 10: Verify persistence outside Playwright**

Query PostgreSQL/admin APIs by `E2E_RUN_ID`, inspect order/transaction/entitlement/job/event/call/report/audit rows, verify report object and download authorization, inspect Grafana and confirm test alerts delivered to Feishu.

- [ ] **Step 11: Finalize the durable acceptance report**

Record:

- Commit and image tags.
- Domains, certificate and external reachability.
- Test counts and passed/failed/skipped.
- Happy and unhappy path matrix.
- Real payment/refund outcome.
- Real Provider/fallback outcome.
- Database/object/log/monitor evidence.
- Restart and reboot recovery.
- Backup and restore drill.
- Remaining external blockers with owner and required credential.

- [ ] **Step 12: Commit the acceptance summary**

Exclude generated videos containing sensitive input. Commit the redacted durable report:

```bash
git add docs/release-acceptance-2026-07.md
git commit -m "test: record full production user acceptance"
```

## Task 9: Final release audit

**Files:**
- Modify: `README.md`
- Modify: `docs/production-runbook.md`
- Modify: `docs/release-acceptance-2026-07.md`

- [ ] **Step 1: Run repository checks**

```bash
git status --short
git diff --check HEAD~1
npm test
npm run build
npm audit --omit=dev
```

Expected: tests/build pass and no high/critical production dependency finding. Only the intended final documentation edits may remain.

- [ ] **Step 2: Run live health and TLS checks**

```bash
curl -fsS https://peileme.art/api/health
curl -fsS https://ai.peileme.art/api/health
curl -I https://peileme.art/
curl -I https://ai.peileme.art/
curl -I https://peileme.art/admin
```

Expected: healthy JSON and HTTPS 200/redirect responses with correct host certificates.

- [ ] **Step 3: Confirm clean production state**

No fixture payment mode, OTP debug, fake model route, public database/Redis/MinIO port, unmasked admin secret, or acceptance-only price remains enabled.

- [ ] **Step 4: Update README and runbook**

Document product split, local development, test DB lifecycle, dual builds, worker startup, environment variables, deployment, monitoring, backup, rollback and production E2E.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/production-runbook.md docs/release-acceptance-2026-07.md
git commit -m "docs: hand off dual-site production operations"
```

- [ ] **Step 6: Verify GitHub identity and publish the accepted commit**

Run `gh auth status`, `gh api user --jq .login`, `git remote -v` and a read-only repository permission query. Confirm the authenticated identity has write access to `Liukeer-sys/peileme-h5`. Push the exact accepted commit only after the identity and origin match; keep access tokens out of command output and Git configuration files.

## Plan 4 completion gate

- All admin capabilities match at UI and API layers.
- Rules, regional data, products, announcements, users, orders, refunds, AI, cases, logs and monitoring are manageable.
- Client events are allowlisted and financial/fulfillment metrics are server-authored.
- Prometheus, Grafana, Loki and Feishu alerts operate under supervision.
- Encrypted off-host backup and isolated restore drill pass.
- CI passes with fixture providers and payment adapters.
- `peileme.art` serves the rule-only build and `ai.peileme.art` serves the AI build.
- Both domains, workers and data survive deliberate restart and host reboot.
- Full real production Playwright happy and unhappy matrix passes.
- Real payment/refund and real Provider/fallback evidence is recorded.
- Final report lists every skipped path or external blocker explicitly; completion is claimed only when required paths have evidence.
