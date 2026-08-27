# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run audit:all` — run EVERY dashboard audit in one command (auto-discovers all `audit:*` scripts in the api-server package, runs them sequentially to respect the Snowflake proxy's ~10 RPS limit, exits 1 if any fail). Builds the api-server and boots its own private copy on port 8099 so it always audits the current code; set `AUDIT_API_BASE` to point it at an already-running server instead. Registered as the `audit` validation step. Run this before shipping any data-layer change.
- `pnpm --filter @workspace/api-server run audit:dashboard` — audit dashboard totals against independent Snowflake baseline queries (API server must be running); fails on divergence > 0.5% (tune with `AUDIT_TOLERANCE_PCT`)
- `pnpm --filter @workspace/api-server run audit:ui` — last-mile UI binding audit: builds the rhodes-analytics app, loads Overview with Targets in headless Chromium (playwright-core + Nix `chromium`), and verifies every rendered KPI/matrix/ratio/breakdown cell against the page's own `overview-with-targets` response (formatting-normalized), including the unknown-channel rows (shown exactly when the payload's unknown bucket is non-zero). Phase 2 then drives every filter control (6 selects, both date inputs, target selector) one at a time and asserts each change puts exactly the chosen value in the RIGHT query param of the page's next request — no stray/duplicate/renamed params, `__all__` never leaks on reset — and that the headline re-renders from the new payload (each response is briefly withheld and the headline must enter its loading state, proving the view is bound to the request lifecycle even when values coincide). Catches swapped columns, wrong-field bindings, and miswired filters that all API audits miss. Transient Snowflake-proxy 5xx are absorbed by watching the page's own query retries. Needs `AUDIT_API_BASE` (audit:all provides it).
- `pnpm --filter @workspace/api-server run audit:ui-leasing` — same last-mile UI binding audit for the Leasing page: KPIs, funnel + lease-goal matrices, community summary (rows, footer sums), subtitle/chart-title bindings vs the page's own `leasing` response. Shared harness lives in `scripts/audit-ui-shared.ts` — new page audits should reuse it, not copy it.
- `pnpm --filter @workspace/api-server run audit:warmup` — verify the startup cache warm-up still pre-computes the exact cache keys real default (no-filter) requests read: runs the real warm-up in-process, replays every warmed endpoint's default request, and fails on any cache miss (always in-process against current source; ignores `AUDIT_API_BASE`). Warmed endpoints live in `WARMED_ENDPOINTS` (src/routes/dashboards.ts) — add new warm jobs there and this audit covers them automatically
- `pnpm --filter @workspace/rhodes-analytics run test:csv` / `run test:xlsx` — serializer tests for the shared download helpers (CSV quoting/injection guard; XLSX round-trip: percent/number formats, frozen bold header, widths, provenance "Info" sheet)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

- **Excel downloads carry provenance; CSV stays bare.** Every `.xlsx` download includes a second "Info" sheet stamping the dashboard name, each active filter (server-resolved applied range, not raw inputs), the export time, and the backend `dataAsOf` — timestamps in America/Chicago. The "Data" sheet stays first and active, so files open exactly as before. CSV deliberately gets no metadata lines: a comment header would shift the column row off line 1 and break `pandas.read_csv`, `csv.reader`, and Excel text imports, so CSV stays machine-first (provenance is the Excel format's job).

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
