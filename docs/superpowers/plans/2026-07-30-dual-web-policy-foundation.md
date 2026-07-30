# Dual Web and Policy Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a production-ready, server-calculated policy site at `peileme.art`, with versioned admin-configurable rules, shared cross-subdomain identity, persistent history, and a separate AI-site build boundary.

**Architecture:** Keep the existing React/Express/PostgreSQL stack and split it incrementally. Add a deterministic policy domain module behind `/api/policy`, version every decision table and regional parameter, and make the main React app render only server-issued results. Build `web-main` and `web-ai` from separate Vite entry points so the main artifact has no AI imports.

**Tech Stack:** React 19, TypeScript 5.8, Vite 7, Express 5, PostgreSQL 16, Zod 4, Decimal.js 10.6, Vitest 3, Supertest, Playwright 1.62, Docker Compose, Nginx/OpenResty

**Design reference:** `docs/superpowers/specs/2026-07-30-dual-site-policy-ai-design.md`

---

## File map

### Create

- `docker-compose.test.yml` — supervised PostgreSQL test database on loopback port `55432`.
- `scripts/run-api-tests.mjs` — failure-safe API test lifecycle, atomic cross-worktree ownership, and signal cleanup.
- `server/tests/run-api-tests.test.ts` — lifecycle, exit-code, signal, stale-lock, and concurrent-owner regression tests.
- `server/tests/test-setup.test.ts` — unique upload-directory ownership and cleanup tests.
- `database/migrations/002_policy_foundation.sql` — product channel, policy rules, regional parameters, snapshots, capabilities, and announcements.
- `server/audit.ts` — reusable immutable admin audit writer.
- `server/modules/policy/types.ts` — normalized policy input/output contracts.
- `server/modules/policy/engine.ts` — pure deterministic compensation engine.
- `server/modules/policy/repository.ts` — versioned rule and regional parameter reads/writes.
- `server/modules/policy/routes.ts` — public calculate/history endpoints and admin rule endpoints.
- `server/modules/policy/seed.ts` — idempotent baseline national rules and product defaults.
- `scripts/import-administrative-regions.ts` — current official province/prefecture selector import.
- `scripts/import-regional-parameters.ts` — sourced annual minimum/average wage import.
- `database/seeds/administrative-regions.csv` — checked official province/prefecture snapshot.
- `database/seeds/regional-parameters.csv` — sourced wage parameter snapshot with accuracy status.
- `server/tests/policy.engine.test.ts` — boundary and formula unit tests.
- `server/tests/policy.api.test.ts` — API, persistence, versioning, authorization, and rollback tests.
- `src/product-channel.ts` — compile-time `main | ai` channel contract.
- `src/main/MainApp.tsx` — main-site questionnaire and server result orchestration.
- `src/main/PolicyResult.tsx` — explainable policy result UI without AI modules.
- `src/main/PolicyHistory.tsx` — complete history detail and version display.
- `src/ai/AiShell.tsx` — independent AI-domain shell used until Plan 3 fills the analysis flow.
- `src/main-entry.tsx` — main-site root.
- `src/ai-entry.tsx` — AI-site root.
- `vite.main.config.ts` — main artifact config.
- `vite.ai.config.ts` — AI artifact config.
- `Dockerfile.web-main` — main-site image.
- `Dockerfile.web-ai` — AI-site image.
- `deploy/nginx-main.conf` — main container proxy config.
- `deploy/nginx-ai.conf` — AI container proxy config.
- `e2e/main-policy.spec.ts` — real main-site happy and unhappy paths.

### Modify

- `package.json` / `package-lock.json` — scripts and Decimal.js.
- `server/config.ts` — cookie domain, allowed origins, CSRF and product defaults.
- `server/services.ts` — shared-domain refresh cookie and device session operations.
- `server/security.ts` — capability-based admin middleware.
- `server/app.ts` — mount extracted audit and policy routers; remove trusted client result writes.
- `server/tests/api.test.ts` — dual-origin CORS behavior, new truncation order, and compatibility assertions.
- `server/tests/setup.ts` — dual-origin, cookie-domain, and unique run-owned upload-directory configuration.
- `src/auth/AuthContext.tsx` — device sessions and channel-safe shared auth.
- `src/lib/api.ts` — CSRF header and typed policy calls.
- `src/types.ts` — normalized salary and termination fields.
- `src/App.tsx` — reduced to a compatibility export during migration.
- `src/components/AccountPanel.tsx` — full result history and device sessions.
- `index.html` — main entry.
- `docker-compose.yml` — `web-main` and `web-ai` services.
- `.env.example` — dual-domain and rule configuration.
- `playwright.config.ts` — local/preview base URL support.

## Task 1: Make the test database reproducible

**Files:**
- Create: `docker-compose.test.yml`
- Create: `scripts/run-api-tests.mjs`
- Create: `server/tests/run-api-tests.test.ts`
- Create: `server/tests/test-setup.test.ts`
- Modify: `package.json`
- Modify: `server/tests/api.test.ts`
- Modify: `server/tests/setup.ts`

- [ ] **Step 1: Add a supervised test PostgreSQL service**

```yaml
services:
  test-db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: peileme_test
      POSTGRES_USER: peileme_test
      POSTGRES_PASSWORD: peileme_test
    ports:
      - "127.0.0.1:55432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U peileme_test -d peileme_test"]
      interval: 2s
      timeout: 2s
      retries: 30
    tmpfs:
      - /var/lib/postgresql/data
```

- [ ] **Step 2: Write the failing lifecycle and lock tests**

Add focused tests to `server/tests/run-api-tests.test.ts` for:

- successful `up -> test -> down`;
- test exit `23` and partial-up exit `19`, with down always executed and the original code preserved;
- SIGTERM cleanup and exit `143`, including a child that ignores the first signal until the grace timer sends `SIGKILL`;
- a second SIGINT/SIGTERM immediately escalating the active child to `SIGKILL` while preserving the first signal's exit `130`/`143`;
- real detached process trees where the leader exits on the first signal while an in-group descendant ignores it, covering both grace-timer and second-signal escalation before down/release;
- a real detached process tree whose leader receives SIGTERM directly, requiring the wrapper to record the child-originated signal, terminate the remaining group, and wait before down/release;
- a dead owner sidecar replaced by a new owner;
- an idle mutex replacing a stale sidecar whose PID has been reused by a live, unrelated process;
- mutex release completing promptly when a client attempts to keep its connection open;
- two contenders released from the same barrier against one stale sidecar, with exactly one winner and one fast active-lock failure;
- active ownership returning nonzero without issuing any Compose command, with separate diagnostics for a known sidecar owner and an occupied mutex with no sidecar;
- cleanup and lock-release failures preserving an earlier up/test failure, while a release failure after success returns `1`;
- marker-creation failure preserving its original error, safely removing the unchanged directory, releasing the mutex before Compose, and preserving a same-path replacement with a separate cleanup diagnostic;
- wrapper upload cleanup refusing same-path replacements with a missing/wrong ownership marker and refusing symlink replacements, while preserving an earlier test/signal exit;
- explicit `--lifecycle-test-exit-code`, `--lifecycle-test-hold-ms`, and `--lifecycle-test-stubborn-ms` acceptance controls; the stubborn control is signal-acceptance-only and exits `97` when its timeout is reached without the expected signal.

Run:

```bash
npx vitest run server/tests/run-api-tests.test.ts
```

Expected before the wrapper exists: FAIL because the lifecycle and atomic ownership exports are absent.

- [ ] **Step 3: Add the failure-safe wrapper and lifecycle scripts**

`scripts/run-api-tests.mjs` must acquire ownership before every Compose command. The exclusive kernel mutex on `127.0.0.1:55431` is the sole active-ownership fact. It immediately destroys accepted client connections so mutex release stays bounded. After binding it successfully, atomically replace any existing `/tmp/peileme-h5-test-db-55432.lock` sidecar with the new `pid`, `cwd`, `token`, and `createdAt`; sidecar PID liveness never blocks the mutex owner because PIDs can be reused. A failed bind reads the sidecar only for diagnostics, reports an unknown owner when the sidecar is absent, returns exit `73`, and returns before the lifecycle `finally`, so the contender never downs the owner's database.

After ownership, execute Compose up and Vitest. A `finally` block must run:

```bash
docker compose -f docker-compose.test.yml down --volumes --remove-orphans
```

Preserve the up or test exit code through cleanup and lock-release failures. On the first SIGINT/SIGTERM, forward that signal to the active child process group where supported, save the detached process-group ID independently from the direct child, start a two-second grace timer, and escalate the saved group to `SIGKILL` when any member remains alive. A second signal escalates immediately, including after the group leader has exited. When the direct child exits from a signal before the wrapper receives one, record that signal before updating process-group state, terminate the remaining group through the same escalation path, and use the signal's `128 + signal number` exit status. Confirm the saved group no longer exists before entering down; clear its timer and ID only after that check. Platforms or permissions without process-group control fall back to signalling the direct child. Then run cleanup, release ownership, and terminate with the original signal status.

Merge these scripts into `package.json`:

```json
{
  "scripts": {
    "test:db:up": "docker compose -f docker-compose.test.yml up -d --wait",
    "test:db:down": "docker compose -f docker-compose.test.yml down --volumes",
    "test:api": "node scripts/run-api-tests.mjs"
  }
}
```

Keep every existing script and merge these keys into the existing `scripts` object.

- [ ] **Step 4: Add isolated uploads and dual-origin CORS acceptance**

Add these assignments to `server/tests/setup.ts`:

```ts
process.env.APP_ORIGIN = "http://localhost:5173,http://ai.localhost:5174";
process.env.COOKIE_DOMAIN = "";
process.env.CSRF_SECRET = "test-csrf-secret-that-is-longer-than-thirty-two-characters";
```

For direct `npm test`, create each run's upload directory with `mkdtempSync(path.join(tmpdir(), "peileme-test-uploads-"))`, register it in the setup module, and remove it in `afterAll`. For `test:api`, the wrapper creates one lifecycle directory while holding the database mutex, writes a random-token ownership marker, and passes the directory and token explicitly to Vitest. Every worker validates that marker and uses the shared directory without taking deletion ownership; the wrapper performs the single idempotent removal in its outer `finally`, including child-SIGKILL and down/release failure paths. If marker creation or realpath capture fails after `mkdtemp`, keep the created path and initial `lstat` device/inode identity outside the guarded creation block. Failure cleanup must validate the safe temp prefix, a non-symlink directory, matching device/inode, and the captured realpath when available, then repeat validation immediately before removal. A replaced path remains untouched and emits a separate cleanup diagnostic while the original creation error remains primary; release the mutex before returning without running Compose. Before normal removal, compare `lstat`, directory and marker `realpath`, regular-file type, exact marker contents, and token against the in-memory ownership record, then repeat validation immediately before recursive removal. Missing/mismatched markers and directory symlinks remain untouched and make an otherwise successful lifecycle exit `1`; an earlier failure or signal code remains primary. Node exposes no directory-handle-anchored recursive removal, so the final revalidation narrows the local same-user replacement race but cannot provide a kernel-level guarantee against a malicious replacement between that check and `rm`. `server/tests/test-setup.test.ts` must prove that cleanup removes its owned directory and preserves an unknown directory and sentinel, including an unknown directory with the expected filename prefix.

Add behavior-level assertions to `server/tests/api.test.ts`:

- `http://localhost:5173` receives its matching `Access-Control-Allow-Origin`;
- `http://ai.localhost:5174` receives its matching `Access-Control-Allow-Origin`;
- an unknown Origin receives no `Access-Control-Allow-Origin`.

- [ ] **Step 5: Run component and real lifecycle acceptance**

Run:

```bash
npx vitest run server/tests/run-api-tests.test.ts
npm run test:api
```

Expected: 27 wrapper/lock tests pass; the complete server suite reports 43/43; the wrapper-owned upload directory, lock sidecar, mutex listener, Compose container/network, and port `55432` are removed.

Exercise a real nonzero child:

```bash
set +e
npm run test:api -- --lifecycle-test-exit-code=37
status=$?
set -e
test "$status" -eq 37
```

Start one owner with `--lifecycle-test-hold-ms=30000`, then start a second `npm run test:api`. Expected: the contender returns `73` in under three seconds, the owner token and Compose container ID stay unchanged, and the owner's PostgreSQL remains healthy. After the owner exits, all resources are removed.

Send SIGINT and SIGTERM to a held wrapper process. Repeat with `--lifecycle-test-stubborn-ms=60000`, allowing the grace timer to escalate once and sending the same signal twice for the immediate escalation path. Expected: exit `130` and `143`, respectively, after child exit and cleanup.

After every lifecycle path, run:

```bash
test ! -e /tmp/peileme-h5-test-db-55432.lock
test -z "$(ss -H -ltn 'sport = :55431')"
test -z "$(ss -H -ltn 'sport = :55432')"
test -z "$(docker compose -f docker-compose.test.yml ps --all --quiet)"
```

- [ ] **Step 6: Run full regression and commit**

```bash
npm run test:db:up
npm test
npm run test:db:down
npm run build
git add docker-compose.test.yml package.json scripts/run-api-tests.mjs \
  server/tests/run-api-tests.test.ts server/tests/test-setup.test.ts \
  server/tests/setup.ts server/tests/api.test.ts \
  docs/superpowers/plans/2026-07-30-dual-web-policy-foundation.md
git commit -m "test: supervise PostgreSQL integration database"
```

## Task 2: Add policy persistence and baseline data

**Files:**
- Create: `database/migrations/002_policy_foundation.sql`
- Create: `server/modules/policy/seed.ts`
- Modify: `server/seed.ts`
- Modify: `server/tests/api.test.ts`

- [ ] **Step 1: Write the failing migration assertions**

Add a test to `server/tests/api.test.ts`:

```ts
it("installs versioned policy and channel tables", async () => {
  const result = await query<{ names: string[] }>(
    `SELECT array_agg(table_name ORDER BY table_name) AS names
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1)`,
    [[
      "policy_rule_sets",
      "policy_rule_versions",
      "regional_parameters",
      "policy_calculation_snapshots",
      "role_capabilities",
      "announcements"
    ]]
  );
  expect(result.rows[0].names).toEqual([
    "announcements",
    "policy_calculation_snapshots",
    "policy_rule_sets",
    "policy_rule_versions",
    "regional_parameters",
    "role_capabilities"
  ]);
});
```

- [ ] **Step 2: Run the assertion and verify failure**

Run:

```bash
npm run test:db:up
npm test -- --run server/tests/api.test.ts
```

Expected: FAIL because `002_policy_foundation.sql` has not created the tables.

- [ ] **Step 3: Create the migration**

Create `database/migrations/002_policy_foundation.sql` with:

```sql
ALTER TABLE assessments
  ADD COLUMN IF NOT EXISTS product_channel TEXT NOT NULL DEFAULT 'main'
    CHECK (product_channel IN ('main', 'ai', 'admin')),
  ADD COLUMN IF NOT EXISTS accuracy_level TEXT
    CHECK (accuracy_level IN ('verified', 'estimated', 'stale', 'unsupported')),
  ADD COLUMN IF NOT EXISTS rule_version_id UUID,
  ADD COLUMN IF NOT EXISTS input_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS result_snapshot JSONB;

CREATE TABLE policy_rule_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  product_channel TEXT NOT NULL CHECK (product_channel IN ('main', 'ai')),
  active_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE policy_rule_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id UUID NOT NULL REFERENCES policy_rule_sets(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  definition JSONB NOT NULL,
  source_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  effective_from DATE NOT NULL,
  effective_to DATE,
  published_by UUID REFERENCES users(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rule_set_id, version)
);

ALTER TABLE policy_rule_sets
  ADD CONSTRAINT policy_rule_sets_active_version_fk
  FOREIGN KEY (active_version_id) REFERENCES policy_rule_versions(id) ON DELETE SET NULL;

ALTER TABLE assessments
  ADD CONSTRAINT assessments_rule_version_fk
  FOREIGN KEY (rule_version_id) REFERENCES policy_rule_versions(id) ON DELETE SET NULL;

CREATE TABLE regional_parameters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region_code TEXT NOT NULL,
  region_name TEXT NOT NULL,
  year INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  parameter_type TEXT NOT NULL CHECK (
    parameter_type IN ('minimum_monthly_wage', 'employee_average_monthly_wage')
  ),
  amount_fen BIGINT NOT NULL CHECK (amount_fen > 0),
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_published_at DATE,
  status TEXT NOT NULL CHECK (status IN ('draft', 'verified', 'stale')),
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (region_code, year, parameter_type)
);

CREATE TABLE administrative_regions (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('province', 'prefecture')),
  parent_code TEXT REFERENCES administrative_regions(code),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_snapshot_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX administrative_regions_parent_idx
  ON administrative_regions(parent_code, status, name);

CREATE TABLE policy_calculation_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id UUID NOT NULL UNIQUE REFERENCES assessments(id) ON DELETE CASCADE,
  rule_version_id UUID NOT NULL REFERENCES policy_rule_versions(id),
  regional_parameter_ids UUID[] NOT NULL DEFAULT '{}',
  input JSONB NOT NULL,
  output JSONB NOT NULL,
  input_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE role_capabilities (
  role TEXT NOT NULL,
  capability TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (role, capability)
);

CREATE TABLE announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  placement TEXT NOT NULL CHECK (placement IN ('main', 'ai', 'all')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX assessments_channel_time_idx
  ON assessments(product_channel, created_at DESC);
CREATE INDEX regional_parameters_lookup_idx
  ON regional_parameters(region_code, parameter_type, year DESC);
CREATE INDEX policy_rule_versions_status_idx
  ON policy_rule_versions(rule_set_id, status, effective_from DESC);
```

- [ ] **Step 4: Seed the national baseline idempotently**

Create `server/modules/policy/seed.ts`:

```ts
import { query } from "../../db.js";

const baselineDefinition = {
  schemaVersion: 1,
  terminationModes: {
    mutual_agreement: "N",
    employer_notice: "N_PLUS_ONE",
    unlawful_termination: "TWO_N",
    employee_resignation: "ZERO",
    unclear: "REVIEW"
  },
  serviceFraction: {
    lessThanSixMonths: 0.5,
    atLeastSixMonths: 1
  },
  highSalaryCapMultiplier: 3,
  highSalaryServiceYearCap: 12
};

export const seedPolicyFoundation = async () => {
  const inserted = await query<{ id: string }>(
    `INSERT INTO policy_rule_sets(code, name, product_channel)
     VALUES ('cn-severance', '中国大陆离职经济补偿规则', 'main')
     ON CONFLICT (code) DO UPDATE SET updated_at = now()
     RETURNING id`
  );
  const ruleSetId = inserted.rows[0].id;
  const version = await query<{ id: string }>(
    `INSERT INTO policy_rule_versions
       (rule_set_id, version, status, definition, source_snapshot, effective_from, published_at)
     VALUES (
       $1, 1, 'published', $2,
       '[{"name":"中华人民共和国劳动合同法","article":"第四十七条"}]'::jsonb,
       DATE '2013-07-01', now()
     )
     ON CONFLICT (rule_set_id, version) DO UPDATE SET definition = EXCLUDED.definition
     RETURNING id`,
    [ruleSetId, baselineDefinition]
  );
  await query(
    `UPDATE policy_rule_sets SET active_version_id = $2, updated_at = now() WHERE id = $1`,
    [ruleSetId, version.rows[0].id]
  );
  await query(
    `INSERT INTO role_capabilities(role, capability) VALUES
       ('admin', 'policy.read'),
       ('admin', 'policy.write'),
       ('admin', 'policy.publish'),
       ('analyst', 'policy.read')
     ON CONFLICT DO NOTHING`
  );
};
```

Call `seedPolicyFoundation()` from `server/seed.ts` after the existing admin and invite seed logic.

- [ ] **Step 5: Import current regions and sourced parameters**

Create `scripts/import-administrative-regions.ts` to read:

```text
code,name,level,parent_code,status,source_name,source_url,source_snapshot_date
```

It validates six-digit unique codes, requires every prefecture parent, requires an HTTPS government source and upserts in one transaction. Build `database/seeds/administrative-regions.csv` from the latest available Ministry of Civil Affairs administrative-division snapshot and include all mainland province-level and prefecture-level entries.

Create `scripts/import-regional-parameters.ts` to read:

```text
region_code,region_name,year,parameter_type,amount_fen,source_name,source_url,source_published_at,status
```

It rejects unknown regions, duplicate region/year/type rows, non-positive amounts and non-government source hosts. Populate all published province-level minimum wages and every verified prefecture employee-average-wage parameter that can be sourced. Regions without a published prefecture value remain selectable and use the explicit estimated/manual path.

- [ ] **Step 6: Test region integrity and coverage**

Add:

```ts
it("loads every active prefecture with a valid province parent", async () => {
  const broken = await query(
    `SELECT c.code
       FROM administrative_regions c
       LEFT JOIN administrative_regions p ON p.code = c.parent_code
      WHERE c.level = 'prefecture' AND c.status = 'active' AND p.code IS NULL`
  );
  expect(broken.rowCount).toBe(0);
  const counts = await query<{ level: string; count: string }>(
    `SELECT level, count(*)::text AS count
       FROM administrative_regions
      WHERE status = 'active'
      GROUP BY level`
  );
  expect(Number(counts.rows.find((row) => row.level === "province")?.count)).toBeGreaterThanOrEqual(31);
  expect(Number(counts.rows.find((row) => row.level === "prefecture")?.count)).toBeGreaterThanOrEqual(330);
});
```

- [ ] **Step 7: Run migrations and tests**

Run:

```bash
npm test -- --run server/tests/api.test.ts
npm run test:db:down
```

Expected: PASS, including the new table assertion.

- [ ] **Step 8: Commit**

```bash
git add database/migrations/002_policy_foundation.sql database/seeds scripts/import-administrative-regions.ts scripts/import-regional-parameters.ts server/modules/policy/seed.ts server/seed.ts server/tests/api.test.ts
git commit -m "feat: add versioned policy persistence"
```

## Task 3: Implement the deterministic compensation engine

**Files:**
- Create: `server/modules/policy/types.ts`
- Create: `server/modules/policy/engine.ts`
- Create: `server/tests/policy.engine.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install Decimal.js**

Run:

```bash
npm install decimal.js@10.6.0
```

Expected: `decimal.js` appears in production dependencies.

- [ ] **Step 2: Write failing boundary tests**

Create `server/tests/policy.engine.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { calculatePolicy } from "../modules/policy/engine.js";

const base = {
  regionCode: "310100",
  regionName: "上海市",
  startDate: "2020-01-01",
  endDate: "2026-07-01",
  terminationMode: "N" as const,
  monthlyEarnedWagesFen: Array(12).fill(1_500_000),
  minimumMonthlyWageFen: 269_000,
  employeeAverageMonthlyWageFen: 1_250_000
};

describe("calculatePolicy", () => {
  it("rounds six years and six months to seven compensation months", () => {
    const result = calculatePolicy(base);
    expect(result.serviceMonths).toBe(78);
    expect(result.compensationMonths).toBe(7);
    expect(result.payableFen).toBe(10_500_000);
  });

  it("rounds a remainder under six months to half a month", () => {
    const result = calculatePolicy({
      ...base,
      startDate: "2026-03-01",
      endDate: "2026-07-01"
    });
    expect(result.compensationMonths).toBe(0.5);
    expect(result.payableFen).toBe(750_000);
  });

  it("applies the three-times wage and twelve-year cap together", () => {
    const result = calculatePolicy({
      ...base,
      startDate: "2008-01-01",
      monthlyEarnedWagesFen: Array(12).fill(5_000_000)
    });
    expect(result.salaryCapped).toBe(true);
    expect(result.compensationMonths).toBe(12);
    expect(result.salaryBasisFen).toBe(3_750_000);
    expect(result.payableFen).toBe(45_000_000);
  });

  it("adds one salary month for N plus one", () => {
    const result = calculatePolicy({ ...base, terminationMode: "N_PLUS_ONE" });
    expect(result.noticePayFen).toBe(1_500_000);
    expect(result.payableFen).toBe(12_000_000);
  });

  it("returns a review range for unclear termination", () => {
    const result = calculatePolicy({ ...base, terminationMode: "REVIEW" });
    expect(result.rangeFen).toEqual({ low: 0, high: 21_000_000 });
    expect(result.reviewRequired).toBe(true);
  });
});
```

- [ ] **Step 3: Run the unit test and verify failure**

Run:

```bash
npm test -- --run server/tests/policy.engine.test.ts
```

Expected: FAIL because the policy module does not exist.

- [ ] **Step 4: Define normalized contracts**

Create `server/modules/policy/types.ts`:

```ts
export type TerminationMode =
  | "ZERO"
  | "N"
  | "N_PLUS_ONE"
  | "TWO_N"
  | "ZERO_OR_TWO_N"
  | "REVIEW";

export type PolicyInput = {
  regionCode: string;
  regionName: string;
  startDate: string;
  endDate: string;
  terminationMode: TerminationMode;
  monthlyEarnedWagesFen: number[];
  minimumMonthlyWageFen: number;
  employeeAverageMonthlyWageFen: number;
  alreadyPaidFen?: number;
};

export type PolicyOutput = {
  serviceMonths: number;
  compensationMonths: number;
  rawAverageWageFen: number;
  salaryBasisFen: number;
  salaryCapped: boolean;
  baseCompensationFen: number;
  noticePayFen: number;
  payableFen: number;
  alreadyPaidFen: number;
  differenceFen: number;
  rangeFen: { low: number; high: number };
  reviewRequired: boolean;
  formulaSteps: Array<{ key: string; label: string; value: string }>;
};
```

- [ ] **Step 5: Implement the pure engine**

Create `server/modules/policy/engine.ts`:

```ts
import Decimal from "decimal.js";
import type { PolicyInput, PolicyOutput } from "./types.js";

const monthsBetween = (start: string, end: string) => {
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime())) {
    throw new Error("INVALID_EMPLOYMENT_DATE");
  }
  if (endDate <= startDate) throw new Error("END_DATE_MUST_FOLLOW_START_DATE");
  let months =
    (endDate.getUTCFullYear() - startDate.getUTCFullYear()) * 12 +
    endDate.getUTCMonth() -
    startDate.getUTCMonth();
  if (endDate.getUTCDate() < startDate.getUTCDate()) months -= 1;
  return Math.max(0, months);
};

const averageFen = (values: number[]) => {
  if (values.length < 1 || values.length > 12) throw new Error("WAGE_MONTHS_OUT_OF_RANGE");
  if (values.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error("INVALID_WAGE_VALUE");
  }
  return new Decimal(values.reduce((sum, value) => sum + value, 0))
    .div(values.length)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
};

const compensationYears = (serviceMonths: number) => {
  const fullYears = Math.floor(serviceMonths / 12);
  const remainder = serviceMonths % 12;
  return fullYears + (remainder >= 6 ? 1 : remainder > 0 ? 0.5 : 0);
};

export const calculatePolicy = (input: PolicyInput): PolicyOutput => {
  const serviceMonths = monthsBetween(input.startDate, input.endDate);
  const rawAverageWageFen = averageFen(input.monthlyEarnedWagesFen);
  const minimumAdjusted = Math.max(rawAverageWageFen, input.minimumMonthlyWageFen);
  const highSalaryCapFen = input.employeeAverageMonthlyWageFen * 3;
  const salaryCapped = minimumAdjusted > highSalaryCapFen;
  const salaryBasisFen = salaryCapped ? highSalaryCapFen : minimumAdjusted;
  const uncappedYears = compensationYears(serviceMonths);
  const compensationMonths = salaryCapped ? Math.min(12, uncappedYears) : uncappedYears;
  const nFen = new Decimal(salaryBasisFen)
    .mul(compensationMonths)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
  const noticePayFen = input.terminationMode === "N_PLUS_ONE" ? salaryBasisFen : 0;
  const twoNFen = nFen * 2;
  const payableFen =
    input.terminationMode === "N" ? nFen :
    input.terminationMode === "N_PLUS_ONE" ? nFen + noticePayFen :
    input.terminationMode === "TWO_N" ? twoNFen :
    0;
  const rangeFen =
    input.terminationMode === "ZERO_OR_TWO_N" || input.terminationMode === "REVIEW"
      ? { low: 0, high: twoNFen }
      : { low: payableFen, high: payableFen };
  const alreadyPaidFen = input.alreadyPaidFen || 0;
  return {
    serviceMonths,
    compensationMonths,
    rawAverageWageFen,
    salaryBasisFen,
    salaryCapped,
    baseCompensationFen: nFen,
    noticePayFen,
    payableFen,
    alreadyPaidFen,
    differenceFen: Math.max(0, payableFen - alreadyPaidFen),
    rangeFen,
    reviewRequired: ["ZERO_OR_TWO_N", "REVIEW"].includes(input.terminationMode),
    formulaSteps: [
      { key: "service", label: "补偿工龄", value: `${compensationMonths} 个月工资` },
      { key: "salary", label: "月工资基数", value: `${salaryBasisFen} 分` },
      { key: "mode", label: "适用模式", value: input.terminationMode },
      { key: "result", label: "测算金额", value: `${payableFen} 分` }
    ]
  };
};
```

- [ ] **Step 6: Run the unit test**

Run:

```bash
npm test -- --run server/tests/policy.engine.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json server/modules/policy server/tests/policy.engine.test.ts
git commit -m "feat: calculate severance with deterministic rules"
```

## Task 4: Add versioned policy API and admin publishing

**Files:**
- Create: `server/audit.ts`
- Create: `server/modules/policy/repository.ts`
- Create: `server/modules/policy/routes.ts`
- Create: `server/tests/policy.api.test.ts`
- Modify: `server/app.ts`
- Modify: `server/security.ts`

- [ ] **Step 1: Write failing API tests**

Create `server/tests/policy.api.test.ts` with tests that:

```ts
it("rejects a client-supplied result and saves the server snapshot", async () => {
  const response = await request(createApp())
    .post("/api/policy/calculate")
    .set("authorization", `Bearer ${userToken}`)
    .send({
      regionCode: "310100",
      regionName: "上海市",
      startDate: "2020-01-01",
      endDate: "2026-07-01",
      terminationMode: "N",
      monthlyEarnedWagesFen: Array(12).fill(1_500_000),
      alreadyPaidFen: 0,
      clientResult: { payableFen: 1 }
    })
    .expect(201);
  expect(response.body.result.payableFen).toBeGreaterThan(1);
  const saved = await query<{ output: { payableFen: number } }>(
    "SELECT output FROM policy_calculation_snapshots WHERE assessment_id = $1",
    [response.body.assessmentId]
  );
  expect(saved.rows[0].output.payableFen).toBe(response.body.result.payableFen);
});

it("publishes a passing draft and keeps the prior version available", async () => {
  const draft = await request(createApp())
    .post("/api/admin/policy/rule-sets/cn-severance/versions")
    .set("authorization", `Bearer ${adminToken}`)
    .send({ effectiveFrom: "2026-08-01", definition: validDefinition })
    .expect(201);
  await request(createApp())
    .post(`/api/admin/policy/versions/${draft.body.id}/publish`)
    .set("authorization", `Bearer ${adminToken}`)
    .send({})
    .expect(200);
  const versions = await request(createApp())
    .get("/api/admin/policy/rule-sets/cn-severance/versions")
    .set("authorization", `Bearer ${adminToken}`)
    .expect(200);
  expect(versions.body.items).toHaveLength(2);
});
```

In the test file, create its own admin/user fixtures in `beforeAll`, and define `validDefinition` with the exact baseline definition from `server/modules/policy/seed.ts`.

- [ ] **Step 2: Run the API test and verify failure**

Run:

```bash
npm test -- --run server/tests/policy.api.test.ts
```

Expected: FAIL with 404 for the new routes.

- [ ] **Step 3: Extract the audit writer**

Create `server/audit.ts`:

```ts
import type { Request } from "express";
import { query } from "./db.js";

export const writeAdminAudit = async (
  request: Request,
  action: string,
  targetType?: string,
  targetId?: string,
  detail: Record<string, unknown> = {}
) => {
  await query(
    `INSERT INTO admin_audit_logs
       (admin_user_id, action, target_type, target_id, detail, ip)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      request.authUser?.id || null,
      action,
      targetType || null,
      targetId || null,
      detail,
      request.ip || null
    ]
  );
};
```

Replace the local `audit` function in `server/app.ts` with this import and rename its calls to `writeAdminAudit`.

- [ ] **Step 4: Add capability middleware**

Add to `server/security.ts`:

```ts
export const requireCapability = (capability: string) =>
  async (request: Request, response: Response, next: NextFunction) => {
    if (!request.authUser) {
      response.status(401).json({ error: "AUTH_REQUIRED", message: "请先登录" });
      return;
    }
    const allowed = await query(
      "SELECT 1 FROM role_capabilities WHERE role = $1 AND capability = $2",
      [request.authUser.role, capability]
    );
    if (!allowed.rowCount) {
      response.status(403).json({ error: "CAPABILITY_REQUIRED", message: "当前角色没有此权限" });
      return;
    }
    next();
  };
```

- [ ] **Step 5: Implement repository operations**

Create `server/modules/policy/repository.ts` with exported functions:

```ts
export const loadActivePolicy = async (code: string, regionCode: string, at: string) => {
  const rule = await query<{
    id: string;
    definition: Record<string, unknown>;
    version: number;
  }>(
    `SELECT v.id, v.definition, v.version
       FROM policy_rule_sets s
       JOIN policy_rule_versions v ON v.id = s.active_version_id
      WHERE s.code = $1
        AND v.status = 'published'
        AND v.effective_from <= $2::date
        AND (v.effective_to IS NULL OR v.effective_to >= $2::date)`,
    [code, at]
  );
  if (!rule.rows[0]) throw new ApiError(503, "POLICY_UNAVAILABLE", "当前日期没有可用规则");
  const parameters = await query<{
    id: string;
    parameter_type: string;
    amount_fen: string;
    year: number;
    status: "verified" | "stale";
  }>(
    `SELECT DISTINCT ON (parameter_type)
            id, parameter_type, amount_fen, year, status
       FROM regional_parameters
      WHERE region_code = $1
        AND year <= extract(year FROM $2::date) - 1
        AND status IN ('verified', 'stale')
      ORDER BY parameter_type, year DESC`,
    [regionCode, at]
  );
  return { rule: rule.rows[0], parameters: parameters.rows };
};
```

Also implement `createDraftVersion`, `listVersions`, `publishVersion`, `rollbackToVersion`, `upsertRegionalParameter`, and `listRegionalCoverage`. Each write must run in a transaction and lock the rule set row with `FOR UPDATE`.

- [ ] **Step 6: Mount public and admin routers**

Create `server/modules/policy/routes.ts` with:

```ts
export const createPolicyRouter = () => {
  const router = Router();
  router.get("/regions", listActiveRegions);
  router.post("/calculate", requireAuth, async (request, response) => {
    const body = calculateRequestSchema.parse(request.body);
    const loaded = await loadActivePolicy("cn-severance", body.regionCode, body.endDate);
    const parameterMap = new Map(
      loaded.parameters.map((item) => [item.parameter_type, Number(item.amount_fen)])
    );
    const minimumMonthlyWageFen =
      parameterMap.get("minimum_monthly_wage") ?? body.manualMinimumMonthlyWageFen;
    const employeeAverageMonthlyWageFen =
      parameterMap.get("employee_average_monthly_wage") ??
      body.manualEmployeeAverageMonthlyWageFen;
    if (!minimumMonthlyWageFen || !employeeAverageMonthlyWageFen) {
      throw new ApiError(422, "REGIONAL_PARAMETERS_REQUIRED", "请补充当地工资参数");
    }
    const result = calculatePolicy({
      ...body,
      minimumMonthlyWageFen,
      employeeAverageMonthlyWageFen
    });
    const accuracyLevel = loaded.parameters.some((item) => item.status === "stale")
      ? "stale"
      : loaded.parameters.length >= 2
        ? "verified"
        : "estimated";
    const saved = await savePolicyCalculation({
      userId: request.authUser!.id,
      visitorId: getRequestIdentity(request).visitorId,
      sessionId: getRequestIdentity(request).sessionId,
      ruleVersionId: loaded.rule.id,
      parameterIds: loaded.parameters.map((item) => item.id),
      input: body,
      output: result,
      accuracyLevel
    });
    response.status(201).json({
      assessmentId: saved.assessmentId,
      ruleVersion: loaded.rule.version,
      accuracyLevel,
      result
    });
  });
  router.get("/history", requireAuth, listPolicyHistory);
  router.get("/history/:id", requireAuth, getOwnedPolicyHistory);
  return router;
};
```

Create `createPolicyAdminRouter()` in the same file for version, regional parameter, coverage, publish and rollback routes, each protected by `requireCapability`.

Mount in `server/app.ts`:

```ts
app.use("/api/policy", createPolicyRouter());
app.use("/api/admin/policy", createPolicyAdminRouter());
```

- [ ] **Step 7: Run API tests**

Run:

```bash
npm test -- --run server/tests/policy.engine.test.ts server/tests/policy.api.test.ts server/tests/api.test.ts
```

Expected: all policy and compatibility tests pass.

- [ ] **Step 8: Commit**

```bash
git add server/audit.ts server/app.ts server/security.ts server/modules/policy server/tests
git commit -m "feat: expose versioned policy calculation API"
```

## Task 5: Share secure sessions across both domains

**Files:**
- Modify: `server/config.ts`
- Modify: `server/services.ts`
- Modify: `server/app.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/auth/AuthContext.tsx`
- Modify: `.env.example`
- Test: `server/tests/policy.api.test.ts`

- [ ] **Step 1: Write failing cookie and Origin tests**

Add tests:

```ts
it("sets a shared secure refresh cookie in production configuration", async () => {
  process.env.NODE_ENV = "production";
  process.env.COOKIE_DOMAIN = ".peileme.art";
  resetConfigForTests();
  const response = await loginThroughFixture();
  expect(response.headers["set-cookie"][0]).toContain("Domain=.peileme.art");
  expect(response.headers["set-cookie"][0]).toContain("HttpOnly");
  expect(response.headers["set-cookie"][0]).toContain("Secure");
  process.env.NODE_ENV = "test";
  process.env.COOKIE_DOMAIN = "";
  resetConfigForTests();
});

it("rejects a refresh request from an unknown Origin", async () => {
  await request(createApp())
    .post("/api/auth/refresh")
    .set("origin", "https://attacker.example")
    .expect(403);
});
```

- [ ] **Step 2: Add configuration fields**

Add to `server/config.ts`:

```ts
COOKIE_DOMAIN: z.string().optional(),
CSRF_SECRET: z.string().min(32).default("development-only-csrf-secret-change-me")
```

Add production validation for `CSRF_SECRET`, matching the JWT and OTP checks.

- [ ] **Step 3: Set and clear the shared cookie**

Change the cookie options in `server/services.ts` to:

```ts
const refreshCookieOptions = () => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: getConfig().NODE_ENV === "production",
  domain: getConfig().COOKIE_DOMAIN || undefined,
  path: "/api/auth",
  maxAge: getConfig().REFRESH_TOKEN_TTL_DAYS * 86_400_000
});
```

Use the same options in `setRefreshCookie` and `clearRefreshCookie`.

- [ ] **Step 4: Enforce Origin on cookie-auth mutations**

Add before auth routes in `server/app.ts`:

```ts
const allowedOrigins = new Set(
  config.APP_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean)
);
const requireAllowedOrigin = (request: Request, response: Response, next: NextFunction) => {
  const origin = request.header("origin");
  if (origin && !allowedOrigins.has(origin)) {
    response.status(403).json({ error: "ORIGIN_FORBIDDEN", message: "请求来源未获授权" });
    return;
  }
  next();
};
app.use("/api/auth", requireAllowedOrigin);
```

- [ ] **Step 5: Add device session endpoints**

Add:

```ts
app.get("/api/auth/sessions", requireAuth, listOwnedSessions);
app.delete("/api/auth/sessions/:id", requireAuth, revokeOwnedSession);
app.post("/api/auth/sessions/revoke-others", requireAuth, revokeOtherSessions);
```

The SQL must always include `WHERE user_id = request.authUser!.id`; deleting the current refresh session also clears the cookie.

- [ ] **Step 6: Add environment documentation**

Add to `.env.example`:

```dotenv
APP_ORIGIN=https://peileme.art,https://www.peileme.art,https://ai.peileme.art
COOKIE_DOMAIN=.peileme.art
CSRF_SECRET=generate-at-least-32-random-characters
```

- [ ] **Step 7: Run auth and policy tests**

Run:

```bash
npm test -- --run server/tests/api.test.ts server/tests/policy.api.test.ts
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add server/config.ts server/services.ts server/app.ts src/lib/api.ts src/auth/AuthContext.tsx .env.example server/tests
git commit -m "feat: share revocable sessions across peileme domains"
```

## Task 6: Build separate main and AI artifacts

**Files:**
- Create: `src/product-channel.ts`
- Create: `src/main-entry.tsx`
- Create: `src/ai-entry.tsx`
- Create: `src/ai/AiShell.tsx`
- Create: `vite.main.config.ts`
- Create: `vite.ai.config.ts`
- Create: `Dockerfile.web-main`
- Create: `Dockerfile.web-ai`
- Create: `deploy/nginx-main.conf`
- Create: `deploy/nginx-ai.conf`
- Modify: `package.json`
- Modify: `index.html`

- [ ] **Step 1: Create compile-time product boundaries**

Create `src/product-channel.ts`:

```ts
export type ProductChannel = "main" | "ai";

const configured = import.meta.env.VITE_PRODUCT_CHANNEL;
if (configured !== "main" && configured !== "ai") {
  throw new Error("VITE_PRODUCT_CHANNEL must be main or ai");
}
export const productChannel: ProductChannel = configured;
```

- [ ] **Step 2: Create independent roots**

Create `src/main-entry.tsx` and `src/ai-entry.tsx` with separate static imports. `main-entry.tsx` imports only `MainApp`, shared auth, shared styles and lazy admin. `ai-entry.tsx` imports only `AiShell`, shared auth, shared styles and lazy admin.

The `AiShell` must be a working landing page:

```tsx
export default function AiShell() {
  return (
    <main className="app-shell">
      <section className="phone-frame">
        <header className="topbar">
          <div><span className="brand-dot" /><strong>赔了么 AI</strong></div>
          <a className="mini-button" href="https://peileme.art">政策测算</a>
        </header>
        <section className="ai-intro">
          <span className="status-pill">AI 深度分析版</span>
          <h1>把材料、金额和风险一次讲清楚</h1>
          <p>离职补偿分析与劳动文件审查将在当前账号下保存。</p>
        </section>
      </section>
    </main>
  );
}
```

- [ ] **Step 3: Create separate Vite configs**

Both configs use `defineConfig`, React plugin, the existing manual chunks, and:

```ts
define: {
  "import.meta.env.VITE_PRODUCT_CHANNEL": JSON.stringify("main")
},
build: {
  outDir: "dist-main",
  emptyOutDir: true
}
```

Use `"ai"` and `dist-ai` in `vite.ai.config.ts`.

- [ ] **Step 4: Add scripts**

Merge into `package.json`:

```json
{
  "scripts": {
    "build:web:main": "tsc && vite build --config vite.main.config.ts",
    "build:web:ai": "tsc && vite build --config vite.ai.config.ts",
    "build:web": "npm run build:web:main && npm run build:web:ai"
  }
}
```

- [ ] **Step 5: Create dedicated images**

`Dockerfile.web-main` copies `dist-main`; `Dockerfile.web-ai` copies `dist-ai`. Both reuse the existing multi-stage Node/Nginx pattern and their dedicated Nginx config. Main listens on container port 80 and proxies `/api` to `api:3001`; AI does the same.

- [ ] **Step 6: Prove the main bundle excludes AI imports**

Run:

```bash
npm run build:web
rg -n "AI 深度分析|documentReview|Provider" dist-main && exit 1 || true
rg -n "AI 深度分析版" dist-ai
```

Expected: the first `rg` finds nothing and the second finds the AI landing copy.

- [ ] **Step 7: Commit**

```bash
git add src package.json package-lock.json index.html vite.*.config.ts Dockerfile.web-* deploy/nginx-*.conf
git commit -m "feat: split main and AI web artifacts"
```

## Task 7: Replace client-trusted calculation with the server result

**Files:**
- Create: `src/main/MainApp.tsx`
- Create: `src/main/PolicyResult.tsx`
- Create: `src/main/PolicyHistory.tsx`
- Modify: `src/App.tsx`
- Modify: `src/types.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/components/AccountPanel.tsx`
- Test: `e2e/main-policy.spec.ts`

- [ ] **Step 1: Write the failing Playwright happy path**

Create `e2e/main-policy.spec.ts` with a local or preview target and a verified test account. The happy path must:

```ts
test("main policy result comes from the server and survives reload", async ({ page }) => {
  await loginAsPolicyUser(page);
  await page.goto("/");
  await page.getByRole("button", { name: "上海", exact: true }).click();
  await completePolicyQuestionnaire(page, {
    startMonth: "2020-01",
    endMonth: "2026-07",
    salary: "15000",
    termination: "公司提前一个月书面通知解除"
  });
  const calculation = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/policy/calculate") &&
      response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "生成政策测算" }).click();
  expect((await calculation).status()).toBe(201);
  await expect(page.getByRole("heading", { name: "政策测算结果" })).toBeVisible();
  await expect(page.getByText("规则版本")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "政策测算结果" })).toBeVisible();
});
```

The helper implementations stay in this file and use only role/label selectors.

- [ ] **Step 2: Run and verify failure**

Run:

```bash
E2E_BASE_URL=http://127.0.0.1:4173 npx playwright test e2e/main-policy.spec.ts
```

Expected: FAIL because the main app still computes locally.

- [ ] **Step 3: Add normalized frontend types and API call**

Add:

```ts
export type PolicyApiResult = {
  assessmentId: string;
  ruleVersion: number;
  accuracyLevel: "verified" | "estimated" | "stale" | "unsupported";
  result: {
    serviceMonths: number;
    compensationMonths: number;
    salaryBasisFen: number;
    payableFen: number;
    rangeFen: { low: number; high: number };
    formulaSteps: Array<{ key: string; label: string; value: string }>;
  };
};

export const calculatePolicy = (body: Record<string, unknown>) =>
  api<PolicyApiResult>("/api/policy/calculate", {
    method: "POST",
    auth: true,
    body
  });
```

- [ ] **Step 4: Move the questionnaire into `MainApp`**

Copy the current conversational questionnaire behavior, remove imports of `PaidUpsellCard` and `calculateCompensation`, and replace the calculation click with:

```ts
const submitPolicyCalculation = async () => {
  setMode("loading");
  setRequestError("");
  try {
    const response = await calculatePolicy(toPolicyRequest(answers));
    setServerResult(response);
    window.sessionStorage.setItem(
      "peileme-latest-policy-result",
      JSON.stringify(response)
    );
    track("policy_calculation_completed", {
      assessmentId: response.assessmentId,
      accuracyLevel: response.accuracyLevel
    });
    setMode("result");
  } catch (error) {
    setMode("chat");
    setRequestError(error instanceof ApiError ? error.message : "测算失败，请稍后重试");
  }
};
```

`toPolicyRequest` converts yuan to integer fen, maps the selected termination leaf to a normalized `TerminationMode`, and sends all 1–12 earned wage months available from the form.

- [ ] **Step 5: Load the complete region selector**

Replace the nine hard-coded city buttons with province/prefecture data from `/api/policy/regions`. Keep fast suggestions for major cities and provide searchable province/city selection. When the selected city lacks a verified parameter, collect manual local values and show the accuracy explanation before submission.

- [ ] **Step 6: Render an explainable server result**

`PolicyResult` receives `PolicyApiResult`, formats integer fen as CNY, lists `formulaSteps`, accuracy level, rule version, source links, and offers history/share/recalculate actions. It receives no AI-related props.

- [ ] **Step 7: Show complete owned history**

`PolicyHistory` calls `/api/policy/history` and `/api/policy/history/:id`. Update `AccountPanel` to render input summary, full formula, rule version, accuracy, created time and result. Remove automatic creation of an `in_progress` assessment on page load; create records only after the user begins entering the questionnaire.

- [ ] **Step 8: Run frontend build and Playwright**

Run:

```bash
npm run build:web:main
npx vite preview --config vite.main.config.ts --host 127.0.0.1 --port 4173
E2E_BASE_URL=http://127.0.0.1:4173 npx playwright test e2e/main-policy.spec.ts
```

Expected: build passes and the happy path passes with a persisted server result.

- [ ] **Step 9: Commit**

```bash
git add src e2e/main-policy.spec.ts
git commit -m "feat: render server-issued policy results"
```

## Task 8: Add policy administration and unhappy-path coverage

**Files:**
- Modify: `src/admin/AdminDashboard.tsx`
- Modify: `src/admin/admin.css`
- Modify: `server/modules/policy/routes.ts`
- Modify: `e2e/main-policy.spec.ts`
- Test: `server/tests/policy.api.test.ts`

- [ ] **Step 1: Add API tests for invalid drafts and stale parameters**

Test exact errors:

```ts
await request(createApp())
  .post("/api/admin/policy/rule-sets/cn-severance/versions")
  .set("authorization", `Bearer ${adminToken}`)
  .send({ effectiveFrom: "2026-08-01", definition: { schemaVersion: 99 } })
  .expect(400);

const stale = await calculateWithOnlyStaleParameters();
expect(stale.body.accuracyLevel).toBe("stale");
```

- [ ] **Step 2: Add admin tabs and capability-aware actions**

Add tabs `policyRules`, `regionalData`, and `announcements`. The policy screen must show active version, drafts, regression status, diff summary, publish and rollback. The regional screen must filter by province/city/year/type/status and support CSV import plus row editing. Analyst users receive read-only controls, derived from capabilities returned by `/api/auth/me`.

- [ ] **Step 3: Add Playwright unhappy paths**

Cover:

```ts
test("main blocks invalid wages and explains missing regional data", async ({ page }) => {
  await loginAsPolicyUser(page);
  await page.goto("/");
  await startCustomCityQuestionnaire(page, "测试无参数市");
  await page.getByLabel("最近一年月平均应发工资").fill("-1");
  await page.getByRole("button", { name: "继续" }).click();
  await expect(page.getByText("工资金额应大于或等于 0")).toBeVisible();
  await page.getByLabel("最近一年月平均应发工资").fill("12000");
  await finishQuestionnaire(page);
  await page.getByRole("button", { name: "生成政策测算" }).click();
  await expect(page.getByText("请补充当地工资参数")).toBeVisible();
});

test("analyst can inspect policy but cannot publish", async ({ page }) => {
  await loginAsAnalyst(page);
  await page.goto("/admin");
  await page.getByRole("button", { name: /政策规则/ }).click();
  await expect(page.getByRole("button", { name: "发布版本" })).toBeDisabled();
});
```

- [ ] **Step 4: Run all Plan 1 checks**

Run:

```bash
npm run test:db:up
npm test
npm run build
E2E_BASE_URL=http://127.0.0.1:4173 npx playwright test e2e/main-policy.spec.ts
npm audit --omit=dev
npm run test:db:down
```

Expected: all tests and builds pass; production dependency audit reports zero high or critical vulnerabilities.

- [ ] **Step 5: Verify no AI code in the main artifact**

Run:

```bash
rg -n "AI 深度分析|documentReview|ai-worker|LLM_|Provider" dist-main
```

Expected: no matches.

- [ ] **Step 6: Commit**

```bash
git add src/admin server/modules/policy server/tests e2e/main-policy.spec.ts
git commit -m "feat: manage policy rules and regional coverage"
```

## Task 9: Integrate dual web services locally

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `deploy/openresty-site.conf.template`
- Modify: `docs/production-runbook.md`

- [ ] **Step 1: Replace the single `web` service**

Create `web-main` and `web-ai` services from `Dockerfile.web-main` and `Dockerfile.web-ai`. Bind:

```yaml
web-main:
  ports:
    - "127.0.0.1:${WEB_MAIN_PORT:-18083}:80"

web-ai:
  ports:
    - "127.0.0.1:${WEB_AI_PORT:-18084}:80"
```

Both depend on the same healthy API. Keep the existing CPU, memory, healthcheck, logging and internal network policy.

- [ ] **Step 2: Add local dual-domain configuration**

Add:

```dotenv
WEB_MAIN_PORT=18083
WEB_AI_PORT=18084
VITE_MAIN_URL=https://peileme.art/
VITE_AI_URL=https://ai.peileme.art/
```

- [ ] **Step 3: Add both OpenResty virtual hosts**

The template must route `peileme.art` and `www.peileme.art` to `127.0.0.1:18083`, and `ai.peileme.art` to `127.0.0.1:18084`, with separate access/error logs and certificate paths.

- [ ] **Step 4: Build and exercise Compose**

Run:

```bash
docker compose up -d --build --wait
curl -fsS http://127.0.0.1:18083/api/health
curl -fsS http://127.0.0.1:18084/api/health
curl -fsS http://127.0.0.1:18083/ | rg "赔了么"
curl -fsS http://127.0.0.1:18084/ | rg "赔了么"
docker compose restart api web-main web-ai
docker compose ps
```

Expected: both loopback sites and the API are healthy before and after deliberate restart.

- [ ] **Step 5: Update the runbook**

Document service names, ports, health commands, build commands, rollback image tags, and the rule migration backup requirement.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml .env.example deploy docs/production-runbook.md
git commit -m "ops: run separate policy and AI web services"
```

## Plan 1 completion gate

- `npm test` passes with the supervised PostgreSQL service.
- Both frontend builds pass.
- Main artifact contains no AI feature code or copy.
- Policy results are created only by the server.
- Every result persists input, output, rule version and regional parameter IDs.
- Admin can draft, test, publish and roll back rules.
- Analyst has read-only policy access at UI and API layers.
- Main-site Playwright happy and unhappy paths pass.
- Both loopback web services survive deliberate restart.
