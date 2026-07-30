# AI Analysis and Document Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver `ai.peileme.art` with real document extraction, fact confirmation, free risk preview, paid severance analysis, pre-sign document review, reliable Tuzi/DataEyes fallback, verified case citations, reports, follow-up questions, and recoverable asynchronous jobs.

**Architecture:** Store every AI analysis as a persistent state machine. Document and AI work runs in Redis-backed workers, while the API owns authorization and state transitions. An OpenAI-compatible router selects a task-specific provider/model chain and applies retry, first-token timeout, circuit breaker, pre-token failover and metadata-only telemetry.

**Tech Stack:** Express 5, PostgreSQL 16, Redis 7, BullMQ 5.81, ioredis 5.11, OpenAI SDK 7.1, S3/MinIO, AWS SDK 3.1098, file-type 22, pdf-parse 2.4, mammoth 1.12, PDFKit 0.17, ClamAV, React 19, Vitest, Playwright

**Prerequisites:** Complete `2026-07-30-dual-web-policy-foundation.md` and `2026-07-30-commerce-payments.md`.

---

## File map

### Create

- `database/migrations/004_ai_pipeline.sql` — AI cases, jobs, state events, files, extracted facts, calls, reports and follow-ups.
- `server/redis.ts` — shared Redis configuration with test reset.
- `server/object-store/types.ts` — object-store interface.
- `server/object-store/local.ts` — local/test implementation.
- `server/object-store/s3.ts` — S3/MinIO implementation.
- `server/modules/llm/types.ts` — task, route, result and telemetry contracts.
- `server/modules/llm/router.ts` — retry, breaker, timeout, pre-token fallback and structured output.
- `server/modules/llm/config.ts` — environment plus admin route resolution.
- `server/modules/llm/telemetry.ts` — body-free call persistence.
- `server/modules/llm/schemas.ts` — Zod schemas for facts, preview, analysis and review.
- `server/modules/documents/validation.ts` — content type, signature, size and ownership.
- `server/modules/documents/scanner.ts` — ClamAV INSTREAM client.
- `server/modules/documents/extract.ts` — PDF, DOCX, image and OCR extraction.
- `server/modules/documents/redact.ts` — minimal PII redaction for model input.
- `server/modules/cases/repository.ts` — verified case search and citation validation.
- `server/modules/ai/state.ts` — guarded persistent job state machine.
- `server/modules/ai/pipeline.ts` — preview, analysis, review, report and follow-up orchestration.
- `server/modules/ai/routes.ts` — owned jobs/files/reports/follow-up API.
- `server/modules/ai/admin-routes.ts` — provider, route, prompt, case and job administration.
- `server/workers/ai-worker.ts` — BullMQ AI job consumer.
- `server/workers/document-worker.ts` — scan/extract consumer.
- `server/workers/index.ts` — worker lifecycle and graceful shutdown.
- `server/tests/llm-router.test.ts` — retry, breaker, fallback, hedge-off and streaming semantics.
- `server/tests/document-pipeline.test.ts` — file validation, scanner, parser and permissions.
- `server/tests/ai-pipeline.test.ts` — state, payment, case validation, report and follow-up.
- `scripts/import-verified-cases.ts` — idempotent case ingestion with source validation.
- `src/ai/AiApp.tsx` — complete AI product shell.
- `src/ai/AnalysisChooser.tsx` — severance versus document review.
- `src/ai/UploadPanel.tsx` — resumable multi-file upload and statuses.
- `src/ai/FactConfirmation.tsx` — confirmed, missing and conflicting facts.
- `src/ai/RiskPreview.tsx` — free preview and paid unlock.
- `src/ai/AnalysisProgress.tsx` — real state event progress.
- `src/ai/AnalysisReport.tsx` — amount, evidence, risk, cases and actions.
- `src/ai/FollowupPanel.tsx` — three task-scoped questions.
- `src/ai/AiHistory.tsx` — jobs, files and reports.
- `src/admin/AiAdmin.tsx` — routes, jobs, calls, cost and cases.
- `e2e/ai-analysis.spec.ts` — real provider happy path and controlled unhappy paths.
- `Dockerfile.worker` — AI/document worker image with document tools.

### Modify

- `package.json` / `package-lock.json` — worker, model, parsing, object and report packages.
- `server/config.ts` — Redis, object store, provider routes, timeouts and worker settings.
- `server/app.ts` — AI and admin routers.
- `server/index.ts` — graceful API startup only.
- `server/modules/commerce/orders.ts` — AI entitlements and task fulfillment link.
- `server/modules/commerce/entitlements.ts` — reserve/release for AI jobs.
- `server/modules/policy/routes.ts` — reusable rule calculation inside AI pipeline.
- `src/ai-entry.tsx` — render `AiApp`.
- `src/admin/AdminDashboard.tsx` — AI navigation.
- `src/styles.css` / `src/admin/admin.css` — AI and admin states.
- `docker-compose.yml` — Redis, MinIO, ClamAV and worker services.
- `.env.example` — routes, provider keys and object store.
- `deploy/nginx-ai.conf` — streaming and upload timeouts.

## Task 1: Add AI persistence and queue infrastructure

**Files:**
- Create: `database/migrations/004_ai_pipeline.sql`
- Create: `server/redis.ts`
- Create: `server/modules/ai/state.ts`
- Test: `server/tests/ai-pipeline.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install queue and Redis dependencies**

Run:

```bash
npm install bullmq@5.81.3 ioredis@5.11.1
```

- [ ] **Step 2: Write the failing state-machine test**

```ts
it("persists valid job transitions and rejects skipped states", async () => {
  const job = await createAiJob({
    userId,
    kind: "severance_analysis",
    productChannel: "ai"
  });
  await transitionAiJob(job.id, "UPLOADING", { progress: 5 });
  await transitionAiJob(job.id, "VALIDATING", { progress: 10 });
  await expect(
    transitionAiJob(job.id, "COMPLETED", { progress: 100 })
  ).rejects.toMatchObject({ code: "INVALID_AI_JOB_TRANSITION" });
  const events = await query(
    "SELECT to_status FROM ai_job_events WHERE job_id = $1 ORDER BY created_at",
    [job.id]
  );
  expect(events.rows.map((row) => row.to_status)).toEqual([
    "DRAFT",
    "UPLOADING",
    "VALIDATING"
  ]);
});
```

- [ ] **Step 3: Run and verify failure**

Run:

```bash
npm run test:db:up
npm test -- --run server/tests/ai-pipeline.test.ts
```

Expected: FAIL because AI tables and functions do not exist.

- [ ] **Step 4: Create the migration**

Create `database/migrations/004_ai_pipeline.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE ai_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assessment_id UUID REFERENCES assessments(id) ON DELETE SET NULL,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  entitlement_usage_id UUID REFERENCES entitlement_usages(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('severance_analysis', 'document_review')),
  product_channel TEXT NOT NULL DEFAULT 'ai' CHECK (product_channel = 'ai'),
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  current_stage TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  failure_code TEXT,
  failure_message TEXT,
  input_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  preview JSONB,
  result JSONB,
  route_version TEXT,
  prompt_versions JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE ai_job_events (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES ai_jobs(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  progress INTEGER NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE document_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id UUID NOT NULL REFERENCES ai_jobs(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  detected_mime_type TEXT,
  size_bytes BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  scan_status TEXT NOT NULL CHECK (
    scan_status IN ('pending', 'clean', 'infected', 'failed')
  ),
  extraction_status TEXT NOT NULL CHECK (
    extraction_status IN ('pending', 'processing', 'ready', 'failed')
  ),
  page_count INTEGER,
  extracted_text_object_key TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE ai_extracted_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES ai_jobs(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL,
  facts JSONB NOT NULL,
  conflicts JSONB NOT NULL DEFAULT '[]'::jsonb,
  missing_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  user_confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id)
);

CREATE TABLE llm_route_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'retired')),
  config JSONB NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ,
  UNIQUE (purpose, version)
);
CREATE UNIQUE INDEX llm_route_one_active_idx
  ON llm_route_configs(purpose) WHERE status = 'active';

CREATE TABLE llm_calls (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID REFERENCES ai_jobs(id) ON DELETE SET NULL,
  purpose TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  stage TEXT NOT NULL,
  outcome TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  fallback_used BOOLEAN NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  estimated_cost_micros BIGINT,
  error_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE legal_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_number TEXT NOT NULL UNIQUE,
  court TEXT NOT NULL,
  decided_at DATE NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  holding TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  region_codes TEXT[] NOT NULL DEFAULT '{}',
  source_url TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_checked_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('verified', 'retired')),
  searchable TEXT GENERATED ALWAYS AS (
    coalesce(case_number, '') || ' ' || coalesce(title, '') || ' ' ||
    coalesce(summary, '') || ' ' || coalesce(holding, '')
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX legal_cases_search_trgm_idx
  ON legal_cases USING gin(searchable gin_trgm_ops);
CREATE INDEX legal_cases_tags_idx ON legal_cases USING gin(tags);

CREATE TABLE ai_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL UNIQUE REFERENCES ai_jobs(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  ai_label TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ai_followups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES ai_jobs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer JSONB,
  status TEXT NOT NULL CHECK (status IN ('queued', 'completed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX ai_jobs_user_time_idx ON ai_jobs(user_id, created_at DESC);
CREATE INDEX ai_jobs_status_retry_idx ON ai_jobs(status, next_retry_at);
CREATE INDEX ai_job_events_job_idx ON ai_job_events(job_id, created_at);
CREATE INDEX llm_calls_job_idx ON llm_calls(job_id, created_at);
```

- [ ] **Step 5: Implement the guarded state machine**

Create `server/modules/ai/state.ts` with a constant transition map:

```ts
const transitions: Record<string, string[]> = {
  DRAFT: ["UPLOADING", "CANCELLED"],
  UPLOADING: ["VALIDATING", "FAILED_RECOVERABLE", "CANCELLED"],
  VALIDATING: ["QUEUED", "FAILED_FINAL", "CANCELLED"],
  QUEUED: ["PARSING", "FAILED_RECOVERABLE", "CANCELLED"],
  PARSING: ["WAITING_FACT_CONFIRMATION", "FAILED_RECOVERABLE", "FAILED_FINAL"],
  WAITING_FACT_CONFIRMATION: ["PREVIEW_READY", "CANCELLED"],
  PREVIEW_READY: ["AWAITING_PAYMENT", "ANALYZING", "CANCELLED"],
  AWAITING_PAYMENT: ["ANALYZING", "CANCELLED"],
  ANALYZING: ["GENERATING_REPORT", "FAILED_RECOVERABLE", "FAILED_FINAL"],
  GENERATING_REPORT: ["COMPLETED", "FAILED_RECOVERABLE", "FAILED_FINAL"],
  RETRY_WAIT: ["QUEUED", "PARSING", "ANALYZING", "GENERATING_REPORT", "FAILED_FINAL"],
  FAILED_RECOVERABLE: ["RETRY_WAIT", "CANCELLED"],
  FAILED_FINAL: [],
  COMPLETED: [],
  CANCELLED: []
};
```

`transitionAiJob` locks the row, validates the transition, updates the job, and inserts the event in one transaction.

- [ ] **Step 6: Add Redis lifecycle**

`server/redis.ts` creates one lazy `IORedis` instance with `maxRetriesPerRequest: null`, a connection name, TLS URL support, `pingRedis()` and `closeRedis()`.

- [ ] **Step 7: Run the state test**

Run:

```bash
npm test -- --run server/tests/ai-pipeline.test.ts
```

Expected: state-machine test passes.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json database/migrations/004_ai_pipeline.sql server/redis.ts server/modules/ai/state.ts server/tests/ai-pipeline.test.ts
git commit -m "feat: persist recoverable AI job states"
```

## Task 2: Implement the Tuzi/DataEyes fallback router

**Files:**
- Create: `server/modules/llm/types.ts`
- Create: `server/modules/llm/config.ts`
- Create: `server/modules/llm/router.ts`
- Create: `server/modules/llm/telemetry.ts`
- Create: `server/modules/llm/schemas.ts`
- Create: `server/tests/llm-router.test.ts`
- Modify: `server/config.ts`
- Modify: `.env.example`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install the OpenAI-compatible client**

Run:

```bash
npm install openai@7.1.0
```

- [ ] **Step 2: Write the router tests first**

Use injectable `ProviderClient` fakes to cover:

```ts
it("uses Tuzi first and returns without fallback on success", async () => {
  const result = await router.chatJson("legal_analysis", messages, schema);
  expect(result.provider).toBe("tuzi");
  expect(calls).toEqual(["tuzi:gpt-5.5"]);
});

it("retries transient Tuzi errors then falls back to DataEyes", async () => {
  tuzi.failWith([429, 503, 503]);
  const result = await router.chatJson("legal_analysis", messages, schema);
  expect(result.provider).toBe("dataeyes");
  expect(result.fallbackUsed).toBe(true);
});

it("opens the breaker after five provider failures", async () => {
  await causeFiveTuziFailures();
  await router.chatJson("risk_preview", messages, schema);
  expect(tuzi.callCount).toBe(5);
  expect(dataeyes.callCount).toBeGreaterThan(0);
});

it("falls back only before the first streamed token", async () => {
  tuzi.streamFailureBeforeFirstToken();
  const output = await collect(router.chatStream("report_followup", messages));
  expect(output).toBe("dataeyes answer");
});

it("throws a recoverable error after a midstream failure", async () => {
  tuzi.streamTokensThenFailure(["partial"]);
  await expect(
    collect(router.chatStream("report_followup", messages))
  ).rejects.toMatchObject({ code: "LLM_STREAM_INTERRUPTED", partial: "partial" });
  expect(dataeyes.callCount).toBe(0);
});
```

- [ ] **Step 3: Define routes and schemas**

`types.ts` defines:

```ts
export type LlmPurpose =
  | "risk_preview"
  | "document_extract"
  | "legal_fact_extract"
  | "legal_analysis"
  | "document_review"
  | "report_generation"
  | "report_followup";

export type ProviderRoute = {
  provider: "tuzi" | "dataeyes";
  model: string;
  maxRetries: number;
  requestTimeoutMs: number;
  firstTokenTimeoutMs: number;
};
```

`schemas.ts` exports strict Zod schemas for extracted facts, preview, severance analysis, document review and follow-up. Every schema has explicit maximum array lengths and string lengths.

- [ ] **Step 4: Add environment configuration**

Add:

```dotenv
LLM_TUZI_BASE_URL=https://api.tu-zi.com/v1
LLM_TUZI_API_KEY=
LLM_DATAEYES_BASE_URL=https://cloud.dataeyes.ai/v1
LLM_DATAEYES_API_KEY=
LLM_ROUTE_RISK_PREVIEW=tuzi:gpt-5.4-mini,dataeyes:gemini-3.1-flash-lite-preview
LLM_ROUTE_DOCUMENT_EXTRACT=tuzi:gpt-5.4-mini,dataeyes:gemini-3.1-flash-lite-preview
LLM_ROUTE_LEGAL_ANALYSIS=tuzi:gpt-5.5,dataeyes:gpt-5.6-sol,dataeyes:gpt-5.5
LLM_ROUTE_DOCUMENT_REVIEW=tuzi:gpt-5.5,dataeyes:gpt-5.6-sol
LLM_ROUTE_REPORT_GENERATION=tuzi:gpt-5.5,dataeyes:gpt-5.6-sol
LLM_ROUTE_REPORT_FOLLOWUP=tuzi:gpt-5.4-mini,dataeyes:gemini-3.1-flash-lite-preview
LLM_MAX_RETRIES=3
LLM_RETRY_BACKOFF_MS=800
LLM_HTTP_TIMEOUT_MS=120000
LLM_FIRST_TOKEN_TIMEOUT_MS=20000
LLM_BREAKER_THRESHOLD=5
LLM_BREAKER_COOLDOWN_MS=60000
LLM_HEDGE_DELAY_MS=0
```

Parse route strings into `ProviderRoute[]`; filter entries whose provider key is absent. Production startup requires at least one configured route for every enabled AI purpose.

- [ ] **Step 5: Implement router reliability semantics**

`router.ts` must:

- Create one OpenAI client per configured provider.
- Retry 408, 429, 5xx, network, timeout, empty body and schema failure.
- Switch immediately on permanent provider 4xx.
- Use exponential full jitter capped at 8 seconds.
- Keep process-local breaker state by provider.
- Support manual provider disable from active DB route config.
- Apply first-token timeout to streaming.
- Permit provider switch only before emitting the first body token.
- Abort and close losing streams when optional hedge is enabled.
- Validate JSON through the caller-provided Zod schema.
- Return provider, model, attempts, fallback flag and token usage.

- [ ] **Step 6: Persist body-free telemetry**

`telemetry.ts` writes `llm_calls` with purpose, provider, model, stage, outcome, latency, attempt, fallback, token counts, cost estimate and error type. The function signature accepts no prompt or response body.

- [ ] **Step 7: Run router tests**

Run:

```bash
npm test -- --run server/tests/llm-router.test.ts
```

Expected: success, retry, breaker, pre-token fallback and midstream failure tests pass.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json server/config.ts server/modules/llm server/tests/llm-router.test.ts .env.example
git commit -m "feat: route AI calls across Tuzi and DataEyes"
```

## Task 3: Store, scan and extract real documents

**Files:**
- Create: `server/object-store/types.ts`
- Create: `server/object-store/local.ts`
- Create: `server/object-store/s3.ts`
- Create: `server/modules/documents/validation.ts`
- Create: `server/modules/documents/scanner.ts`
- Create: `server/modules/documents/extract.ts`
- Create: `server/modules/documents/redact.ts`
- Create: `server/tests/document-pipeline.test.ts`
- Modify: `server/config.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install object, detection and parsing packages**

Run:

```bash
npm install @aws-sdk/client-s3@3.1098.0 file-type@22.0.1 pdf-parse@2.4.5 mammoth@1.12.0
```

- [ ] **Step 2: Write failing document tests**

Cover valid PDF text, DOCX text, PNG signature, MIME spoofing, encrypted PDF, oversized page count, scanner infection, object ownership, extraction failure and redaction:

```ts
it("rejects a PDF extension with non-PDF bytes", async () => {
  await expect(
    validateDocument(Buffer.from("plain"), "contract.pdf", "application/pdf")
  ).rejects.toMatchObject({ code: "FILE_CONTENT_MISMATCH" });
});

it("redacts direct identifiers but preserves money and dates", () => {
  expect(redactForModel(
    "张三 13800138000 2026-07-01 工资15000元",
    { names: ["张三"], phones: ["13800138000"] }
  ))
    .toBe("[姓名] [手机号] 2026-07-01 工资15000元");
});
```

- [ ] **Step 3: Implement object-store interfaces**

`ObjectStore` has `put`, `get`, `head`, `delete`, `createSignedGetUrl`. Local implementation confines resolved paths below `OBJECT_STORE_LOCAL_DIR`. S3 implementation uses path-style MinIO compatibility and server-side encryption configuration.

- [ ] **Step 4: Implement content validation**

Use `fileTypeFromBuffer`, PDF `%PDF`, ZIP/DOCX container inspection and image signatures. Return detected MIME and SHA-256. Accept PDF, DOCX, JPEG, PNG and WebP. Reject executables, archives, MIME mismatch and zero-byte files.

- [ ] **Step 5: Implement ClamAV INSTREAM**

`scanner.ts` opens the configured clamd TCP socket, writes `zINSTREAM\0`, streams length-prefixed chunks, writes a zero-length terminator, and parses `OK`, `FOUND` or error. Timeout closes the socket and returns `SCAN_UNAVAILABLE`; production upload stays quarantined until a clean result.

- [ ] **Step 6: Implement text extraction**

- PDF: `pdf-parse`, page count, encrypted/error classification.
- DOCX: `mammoth.extractRawText`.
- Image and scanned PDF: render at most the configured page count with `pdftoppm`, then send bounded images to the `document_extract` multimodal route.
- Normalize Unicode and whitespace.
- Enforce extracted text maximum length and preserve page/section markers.
- Store extracted text in a separate object key.

- [ ] **Step 7: Run document tests**

Run:

```bash
npm test -- --run server/tests/document-pipeline.test.ts
```

Expected: validation, scan, extraction, redaction and ownership tests pass.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json server/object-store server/modules/documents server/tests/document-pipeline.test.ts
git commit -m "feat: scan and extract uploaded employment documents"
```

## Task 4: Add verified legal case retrieval

**Files:**
- Create: `server/modules/cases/repository.ts`
- Create: `scripts/import-verified-cases.ts`
- Modify: `server/modules/ai/admin-routes.ts`
- Test: `server/tests/ai-pipeline.test.ts`

- [ ] **Step 1: Write failing citation tests**

```ts
it("returns only verified stored cases with complete citations", async () => {
  const cases = await searchVerifiedCases({
    query: "违法解除 经济补偿",
    regionCode: "310100",
    tags: ["unlawful_termination"],
    limit: 5
  });
  expect(cases.every((item) =>
    item.caseNumber && item.court && item.decidedAt && item.sourceUrl
  )).toBe(true);
});

it("rejects a model citation absent from the retrieved case set", () => {
  expect(() =>
    validateCaseCitations(["(2026)沪01民终99999号"], retrievedCases)
  ).toThrow("UNVERIFIED_CASE_CITATION");
});
```

- [ ] **Step 2: Implement repository search**

Use `status = 'verified'`, trigram similarity, tag overlap and regional boost. Return at most 10 cases and always include complete citation fields. `validateCaseCitations` compares exact normalized case numbers against the retrieved set.

- [ ] **Step 3: Implement idempotent ingestion**

`scripts/import-verified-cases.ts` accepts a JSON file containing:

```ts
type CaseImport = {
  caseNumber: string;
  court: string;
  decidedAt: string;
  title: string;
  summary: string;
  holding: string;
  tags: string[];
  regionCodes: string[];
  sourceUrl: string;
  sourceName: string;
};
```

It requires HTTPS sources, performs a HEAD/GET availability check, rejects duplicate case numbers, validates dates and non-empty holdings, then upserts with `source_checked_at = now()`.

- [ ] **Step 4: Build the launch case set**

Collect at least 30 official-source cases covering mutual termination, contract expiry, employer notice, unlawful termination, wage-base disputes, medical period, pregnancy protections and evidence disputes. Import them through the script and export an admin coverage report by tag and region.

- [ ] **Step 5: Run retrieval tests**

Run:

```bash
npm test -- --run server/tests/ai-pipeline.test.ts
```

Expected: only verified cases are returned and invented citations are rejected.

- [ ] **Step 6: Commit**

```bash
git add server/modules/cases server/modules/ai/admin-routes.ts scripts/import-verified-cases.ts server/tests/ai-pipeline.test.ts
git commit -m "feat: retrieve verified labor case citations"
```

## Task 5: Implement the asynchronous AI pipeline

**Files:**
- Create: `server/modules/ai/pipeline.ts`
- Create: `server/modules/ai/routes.ts`
- Create: `server/workers/ai-worker.ts`
- Create: `server/workers/document-worker.ts`
- Create: `server/workers/index.ts`
- Create: `Dockerfile.worker`
- Modify: `server/app.ts`
- Modify: `server/modules/commerce/entitlements.ts`
- Modify: `server/modules/commerce/orders.ts`
- Modify: `server/tests/ai-pipeline.test.ts`

- [ ] **Step 1: Install report generation**

Run:

```bash
npm install pdfkit@0.19.1
npm install -D @types/pdfkit@0.17.6
```

- [ ] **Step 2: Write failing happy and recovery tests**

Test:

```ts
it("moves a severance job from upload through paid report", async () => {
  const job = await createJobWithCleanExtractedFiles(userId);
  await runFactExtraction(job.id);
  await confirmFacts(job.id, confirmedFacts);
  await runRiskPreview(job.id);
  expect((await getJob(job.id)).status).toBe("AWAITING_PAYMENT");
  await attachPaidEntitlement(job.id, analysisEntitlementUsageId);
  await runFullAnalysis(job.id);
  expect((await getJob(job.id)).status).toBe("COMPLETED");
});

it("resumes after a recoverable provider outage without double consuming", async () => {
  providerRouter.failAllOnce();
  await expect(runFullAnalysis(jobId)).rejects.toMatchObject({
    code: "LLM_ALL_PROVIDERS_FAILED"
  });
  await retryAiJob(jobId);
  expect(await countEntitlementUsages(jobId)).toBe(1);
  expect((await getJob(jobId)).status).toBe("COMPLETED");
});
```

- [ ] **Step 3: Create BullMQ queues and workers**

Use queues `peileme-document` and `peileme-ai`. Job IDs equal persistent AI job IDs plus stage, for example `aiJobId:parse`. Workers use configured concurrency, lock duration and stalled-job limits. Every processor reloads job state before work and exits idempotently when the stage is already complete.

- [ ] **Step 4: Implement fact extraction and confirmation**

Combine questionnaire plus extracted text, redact direct identifiers, call `legal_fact_extract`, validate the strict schema, store facts/conflicts/missing fields, and transition to `WAITING_FACT_CONFIRMATION`. User confirmation writes a new normalized fact snapshot; model output never silently overrides user-confirmed values.

- [ ] **Step 5: Implement free preview**

Run the deterministic policy engine on confirmed facts, then call `risk_preview` for a bounded summary containing risk level, top three issues and missing evidence. Store preview and transition to `AWAITING_PAYMENT` unless a valid AI entitlement is already reserved.

- [ ] **Step 6: Implement paid analysis and review**

Reserve the relevant entitlement, retrieve verified law/cases, call `legal_analysis` or `document_review`, validate case numbers against retrieved records, generate action steps, persist structured result, then consume entitlement only after the result and report both succeed. Recoverable failures release no entitlement and enter `FAILED_RECOVERABLE`.

- [ ] **Step 7: Implement report and follow-up**

Generate a PDF with visible `AI 生成内容，仅供参考` label, task ID, generation time, policy formula, evidence, risks, verified cases and actions. Follow-ups include the immutable report context plus the user question, enforce three completed questions, and never broaden beyond the paid task.

- [ ] **Step 8: Add owned API routes**

Mount:

```text
POST   /api/ai/jobs
POST   /api/ai/jobs/:id/files
GET    /api/ai/jobs/:id
GET    /api/ai/jobs/:id/events
POST   /api/ai/jobs/:id/confirm-facts
POST   /api/ai/jobs/:id/unlock
POST   /api/ai/jobs/:id/retry
POST   /api/ai/jobs/:id/followups
GET    /api/ai/jobs/:id/report
GET    /api/ai/history
DELETE /api/ai/jobs/:id
```

Every query includes `user_id = request.authUser!.id`.

- [ ] **Step 9: Run pipeline tests**

Run:

```bash
npm test -- --run server/tests/ai-pipeline.test.ts server/tests/llm-router.test.ts server/tests/document-pipeline.test.ts
```

Expected: paid pipeline, recovery, idempotency, report and follow-up tests pass.

- [ ] **Step 10: Commit**

```bash
git add server/modules/ai server/workers server/app.ts server/modules/commerce Dockerfile.worker server/tests
git commit -m "feat: run recoverable paid AI analysis jobs"
```

## Task 6: Build the AI-site user journey

**Files:**
- Create: `src/ai/AiApp.tsx`
- Create: `src/ai/AnalysisChooser.tsx`
- Create: `src/ai/UploadPanel.tsx`
- Create: `src/ai/FactConfirmation.tsx`
- Create: `src/ai/RiskPreview.tsx`
- Create: `src/ai/AnalysisProgress.tsx`
- Create: `src/ai/AnalysisReport.tsx`
- Create: `src/ai/FollowupPanel.tsx`
- Create: `src/ai/AiHistory.tsx`
- Modify: `src/ai-entry.tsx`
- Modify: `src/styles.css`
- Test: `e2e/ai-analysis.spec.ts`

- [ ] **Step 1: Write the failing mobile happy path**

```ts
test("real user completes AI severance analysis", async ({ page }) => {
  await loginAsAiUser(page);
  await page.goto("/");
  await page.getByRole("button", { name: "离职补偿完整分析" }).click();
  await fillAiBackground(page);
  await page.getByLabel("上传材料").setInputFiles([
    "e2e/fixtures/e2e-agreement.pdf",
    "e2e/fixtures/e2e-payroll.png"
  ]);
  await expect(page.getByText("材料解析完成")).toBeVisible({ timeout: 120_000 });
  await confirmExtractedFacts(page);
  await expect(page.getByRole("heading", { name: "免费风险预览" })).toBeVisible();
  await unlockWithPaidTestEntitlement(page);
  await expect(page.getByText("完整分析已生成")).toBeVisible({ timeout: 240_000 });
  await expect(page.getByText(/案号/)).toBeVisible();
  await page.getByRole("button", { name: "下载报告" }).click();
  await askThreeFollowups(page);
  await expect(page.getByText("本次报告的 3 次追问已使用完")).toBeVisible();
});
```

- [ ] **Step 2: Implement a URL-addressable state machine**

`AiApp` routes by `history.pushState` among chooser, job upload, fact confirmation, preview, progress and report. Refresh reads the job ID from the URL and reloads persisted server state.

- [ ] **Step 3: Implement uploads and progress**

Show each file’s upload, scan and extraction states. Poll job events with backoff; use an `EventSource` endpoint if implemented. Display genuine stages and retry time. Cancel/retry buttons call server actions.

- [ ] **Step 4: Implement fact confirmation**

Render editable normalized facts, highlighted conflicts and missing required fields. User changes are sent as one confirmation payload and shown in the report audit summary.

- [ ] **Step 5: Implement preview, checkout and report**

Preview shows risk level and top issues. Checkout reuses Plan 2 `CheckoutSheet`. Report provides sticky mobile anchors for amount, facts, evidence, risks, cases and actions, plus visible AI label, download, supplement and follow-up.

- [ ] **Step 6: Implement document review flow**

Chooser accepts contract/Offer/separation agreement, collects document type and user concerns, then follows upload → facts → preview → pay → report. Report displays original clause, issue, risk, suggestion and suggested wording.

- [ ] **Step 7: Run the browser happy path with a deterministic test router**

Run:

```bash
npm run build:web:ai
E2E_LLM_MODE=fixture npx playwright test e2e/ai-analysis.spec.ts --grep "completes AI"
```

Expected: the complete mobile flow passes with persisted states.

- [ ] **Step 8: Commit**

```bash
git add src/ai src/ai-entry.tsx src/styles.css e2e/ai-analysis.spec.ts
git commit -m "feat: deliver the AI analysis user journey"
```

## Task 7: Add AI administration and controlled unhappy paths

**Files:**
- Create: `src/admin/AiAdmin.tsx`
- Modify: `src/admin/AdminDashboard.tsx`
- Modify: `src/admin/admin.css`
- Modify: `server/modules/ai/admin-routes.ts`
- Modify: `e2e/ai-analysis.spec.ts`

- [ ] **Step 1: Add admin API tests**

Cover route draft/activation, masked provider status, connection test, job retry, call telemetry without bodies, case import validation, cost aggregation, and analyst read-only enforcement.

- [ ] **Step 2: Build admin screens**

Add:

- Provider health with masked key fingerprint.
- Purpose route versions, priorities, model, timeout, retry and breaker settings.
- Prompt/Schema versions.
- Job queue with stage, retry, failure and owner.
- Call telemetry with provider/model/outcome/latency/tokens/cost.
- Verified case coverage and source-check status.
- Manual retry/cancel with audit reason.

- [ ] **Step 3: Add unhappy browser paths**

Cover unsupported file, spoofed MIME, encrypted PDF, infected scan fixture, parser failure, provider pre-token fallback, all-provider outage, midstream interruption, retry recovery, invented citation rejection, refresh during analysis, duplicate unlock, fourth follow-up and cross-user access.

- [ ] **Step 4: Run Plan 3 automated checks**

Run:

```bash
npm run test:db:up
npm test
npm run build
E2E_LLM_MODE=fixture npx playwright test e2e/ai-analysis.spec.ts
npm audit --omit=dev
npm run test:db:down
```

Expected: unit, API, build and controlled browser paths pass.

- [ ] **Step 5: Commit**

```bash
git add src/admin server/modules/ai server/modules/llm server/tests e2e/ai-analysis.spec.ts
git commit -m "feat: administer AI routes jobs and verified cases"
```

## Task 8: Integrate Redis, MinIO, ClamAV and workers

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `Dockerfile.worker`
- Modify: `deploy/nginx-ai.conf`
- Modify: `docs/production-runbook.md`

- [ ] **Step 1: Add internal services**

Add Redis 7 Alpine with AOF, MinIO with a persistent volume, ClamAV with healthcheck, and two worker services using `Dockerfile.worker`. Bind no Redis, MinIO or ClamAV port publicly.

- [ ] **Step 2: Set resource and concurrency limits**

Use separate limits:

- API: 512 MB, 1 CPU.
- AI worker: 1 GB, 1 CPU, concurrency 2.
- Document worker: 1.5 GB, 1 CPU, concurrency 1.
- Redis: 256 MB.
- MinIO: 512 MB.
- ClamAV: 1 GB.

Adjust after measuring the production host; keep combined hard limits below available memory with 20% host reserve.

- [ ] **Step 3: Install deterministic document tools in the worker image**

Install `poppler-utils` for `pdftoppm`, `font-noto-cjk` for Chinese PDF reports, and `tini` for signal-safe worker shutdown. Run both workers as the non-root `node` user and limit writable paths to the object-store staging directory.

- [ ] **Step 4: Add healthchecks**

API health reports database, Redis, object store and queue status. Workers expose a small internal health process or write heartbeats to Redis. Compose waits for Redis, MinIO and ClamAV readiness.

- [ ] **Step 5: Exercise failure recovery**

Run:

```bash
docker compose up -d --build --wait
docker compose stop ai-worker
docker compose start ai-worker
docker compose restart redis document-worker
docker compose ps
```

Submit a task before each interruption and verify it resumes or reaches a clear retry state without duplicate entitlement consumption.

- [ ] **Step 6: Update the runbook**

Document queue inspection, worker restart, breaker state, provider disable, file quarantine, MinIO recovery, ClamAV update, and safe task retry commands.

- [ ] **Step 7: Commit**

```bash
git add docker-compose.yml .env.example Dockerfile.worker deploy/nginx-ai.conf docs/production-runbook.md
git commit -m "ops: supervise AI document and model workers"
```

## Task 9: Verify real providers on an isolated acceptance account

**Files:**
- Create: `docs/ai-provider-acceptance.md`
- Modify: `docs/production-runbook.md`

- [ ] **Step 1: Load provider credentials securely**

Read Tuzi/DataEyes credentials from the existing OranMemory/nms-flow server environment into the Peileme production secret file without printing them. Preserve file mode `0600`. Record only key fingerprints.

- [ ] **Step 2: Run task-specific connection tests**

Call each configured purpose with minimal non-personal fixture content. Confirm provider, model, latency, schema validity and fallback result. Trigger a temporary primary disable and verify DataEyes succeeds.

- [ ] **Step 3: Run one real document analysis**

Use the dedicated acceptance account and synthetic employment files. Complete preview, paid-test entitlement, full analysis, verified case citations, report download and follow-up. Query database state and `llm_calls` after the browser path.

- [ ] **Step 4: Save body-free evidence**

`docs/ai-provider-acceptance.md` records timestamp, purpose, route version, provider/model, outcome, fallback, latency range, schema result and report hash. It contains no API keys, prompts, document text or complete model response.

- [ ] **Step 5: Commit**

```bash
git add docs/ai-provider-acceptance.md docs/production-runbook.md
git commit -m "docs: record real AI provider acceptance"
```

## Plan 3 completion gate

- AI jobs survive browser, worker and Redis interruptions with persisted state.
- Files are signature-checked, scanned, privately stored and genuinely extracted.
- Tuzi/DataEyes routes pass retry, breaker, timeout and fallback tests.
- Streaming fallback occurs only before first output.
- LLM telemetry contains no prompt, file body or answer body.
- Complete analysis uses the server policy result and verified case records.
- Paid entitlement is consumed once after a complete report.
- AI and document-review mobile flows pass happy and unhappy Playwright tests.
- Real provider acceptance passes with body-free evidence.
