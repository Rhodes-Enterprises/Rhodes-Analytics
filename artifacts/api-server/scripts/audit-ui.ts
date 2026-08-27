/**
 * UI binding audit (`pnpm run audit:ui`) — the LAST MILE of the audit family.
 *
 * The other audits (audit:dashboard, audit:yoy, audit:leasing) verify that the
 * API payload matches independent Snowflake baselines. None of them catch a
 * UI mix-up: Goal and Actual columns swapped in the ratios table, a traffic-
 * matrix cell bound to the wrong metric, a percent formatted from the wrong
 * field. Every API audit stays green while users read wrong numbers.
 *
 * This audit closes that gap:
 *
 *   1. Builds the rhodes-analytics web app FROM CURRENT SOURCE (same
 *      philosophy as audit:all building the api-server — never audit a stale
 *      bundle), serves the static build on AUDIT_UI_PORT with `/api/*`
 *      proxied to AUDIT_API_BASE.
 *   2. Opens the Overview with Targets page in headless Chromium
 *      (playwright-core driving the Nix-provided `chromium` binary).
 *   3. Captures the response body of the page's OWN
 *      GET /api/dashboards/overview-with-targets request — so rendered values
 *      are compared against the exact payload the page bound, not a second
 *      fetch that could disagree.
 *   4. Reads rendered values from the DOM — KPI row, every traffic-matrix
 *      cell, the full ratios table (Goal / Actual / PTG %), every division and
 *      development row, and both table footers — locating each value by its
 *      COLUMN HEADER, so the check verifies "the number under this header is
 *      the API field this header promises". Each table's rendered header set
 *      must equal the audited binding map exactly: a renamed, removed, or
 *      ADDED column fails until it is registered here.
 *   5. Normalizes formatting before comparing: thousands separators and
 *      leading `+` are stripped, `%` suffixes are asserted (percent cells must
 *      have one, count cells must not), fraction-valued API fields (ratio
 *      goal/actual) are scaled x100, the `–` placeholder must correspond to a
 *      null API value, and a rounding tolerance of half a unit in the last
 *      rendered decimal place is allowed. Only real mis-bindings fail; a
 *      cosmetic change in decimal places does not.
 *   6. PHASE 2 — filter-request WIRING. Drives every filter control on the
 *      page (Division, Development, Cohort Quarter, Lead Source, Contact
 *      Channel, Deal Channel, start/end date, target selector) one at a
 *      time and, after each change, asserts that the page's NEXT
 *      overview-with-targets request carries exactly the chosen value in
 *      the RIGHT query parameter and nothing else (a stray, missing,
 *      duplicated, renamed, or wrong-valued parameter fails with the
 *      offending control and the actual query string), and that the
 *      headline (applied-range subtitle + all five KPI cells) re-renders
 *      from that request's own response payload. Each such request is
 *      briefly withheld at the route layer and the headline must enter its
 *      loading state during the hold — proving the view is bound to the
 *      request's lifecycle even when old and new headline values coincide
 *      (contact-scoped filters legitimately leave sales KPIs unchanged, so
 *      value equality alone would pass vacuously against a stale mount).
 *      This is the only audit
 *      that can catch a dropdown wired to the wrong query param (Division
 *      sent as ?development, Contact/Deal Channel swapped, a broken "All"
 *      sentinel leaking `__all__`): the page would show correct-looking
 *      numbers for the wrong question while every payload-vs-Snowflake
 *      audit stays green.
 *
 * Structural drift fails LOUDLY instead of passing vacuously: a missing
 * data-testid, a renamed/added column header, a row-count mismatch with the
 * payload, a dropdown that offers no option to pick, or the page rendering
 * its error state are all audit failures.
 *
 * Run from artifacts/api-server (the API server must be reachable):
 *   AUDIT_API_BASE=http://localhost:8099/api pnpm run audit:ui
 * or as part of the umbrella (which boots a private API server):
 *   pnpm run audit:all
 *
 * Env:
 *   AUDIT_API_BASE   API base the UI is pointed at
 *                    (default http://localhost:${PORT:-8080}/api)
 *   AUDIT_UI_PORT    port for the private static UI server (default 8098)
 *   AUDIT_UI_BASE    audit an ALREADY-RUNNING UI origin instead of building
 *                    and serving one (e.g. http://localhost:80 for the dev
 *                    preview proxy; the page must reach its API itself)
 *   AUDIT_CHROMIUM   path to a Chromium binary (default: `which chromium`)
 *
 * Exits 0 when every rendered value matches its API field and every filter
 * control is wired to the right query parameter, 1 otherwise.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type Page, type Request } from "playwright-core";

const API_BASE =
  process.env.AUDIT_API_BASE ?? `http://localhost:${process.env.PORT ?? "8080"}/api`;
const UI_PORT = Number(process.env.AUDIT_UI_PORT ?? "8098");
const EXTERNAL_UI_BASE = process.env.AUDIT_UI_BASE?.replace(/\/+$/, "");
const PAGE_PATH = "/workspaces/marketing/overview-with-targets";
const OVERVIEW_API_PATH = "/api/dashboards/overview-with-targets";
const DATA_TIMEOUT_MS = 240_000; // first hit may run cold Snowflake queries

const WIRING_REQUEST_TIMEOUT_MS = 10_000;
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const uiDir = resolve(pkgDir, "..", "rhodes-analytics");
const uiDist = join(uiDir, "dist", "public");

// ---------- payload shape (the audited API contract this page binds) ----------

interface MatrixCell {
  fullSpanGoal: number;
  toDateGoal: number;
  actual: number;
  ptgPercent: number | null;
}
interface BreakdownRow {
  division: string;
  development?: string;
  totalWebsiteUsers: number;
  newWebsiteUsers: number;
  leads: number;
  tours: number;
  sales: number;
  leadsPctOfTotal: number;
  toursPctOfTotal: number;
  salesPctOfTotal: number;
  salesPtg: number | null;
  toursPtg: number | null;
  leadsPtg: number | null;
  onlineTrafficPtg: number | null;
  onlineLeadsPtg: number | null;
  onlineToursPtg: number | null;
  onlineSalesPtg: number | null;
  onsiteLeadsPtg: number | null;
  onsiteToursPtg: number | null;
  onsiteSalesPtg: number | null;
}
interface OverviewPayload {
  appliedRange: { startDate: string; endDate: string; toDate: string; target: string };

  kpis: {
    salesGoal: number;
    salesTdGoal: number;
    grossSales: number;
    ptgVariance: number;
    ptgPercent: number | null;
  };

  trafficMatrix: {
    online: { websiteUsers: MatrixCell; leads: MatrixCell; tours: MatrixCell; sales: MatrixCell };
    onsite: { leads: MatrixCell; tours: MatrixCell; sales: MatrixCell };
    /** Rows with neither 'Online' nor 'Onsite' label — actuals only, no goals exist for the bucket. */
    unknown: { leads: number; tours: number; sales: number };
    total: { leads: MatrixCell; tours: MatrixCell };
    unknown: { leads: number; tours: number; sales: number };
    newWebsiteUsers: number;
  };

  divisions: BreakdownRow[];

  developments: BreakdownRow[];

  ratios: { name: string; group: string; goal: number | null; actual: number; ptgPercent: number | null }[];
}

// ---------- check bookkeeping ----------

let checks = 0;
let failures = 0;

function ok(label: string, detail: string): void {
  checks++;
  console.log(`OK    ${label}  ${detail}`);
}
function fail(label: string, detail: string): void {
  checks++;
  failures++;
  console.log(`FAIL  ${label}  ${detail}`);
}

// ---------- rendered-number normalization ----------

const EN_DASH = "\u2013"; // the page's null placeholder "–"

interface Parsed {
  empty?: boolean;
  invalid?: boolean;
  value?: number;
  decimals?: number;
  isPercent?: boolean;
}

function parseRendered(raw: string): Parsed {
  const s = raw.trim();
  if (s === EN_DASH) return { empty: true };
  const isPercent = s.endsWith("%");
  let t = isPercent ? s.slice(0, -1).trim() : s;
  t = t.replace(/,/g, "").replace(/^\+/, "");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return { invalid: true };
  const decimals = t.includes(".") ? t.split(".")[1].length : 0;
  return { value: Number(t), decimals, isPercent };
}

interface CellVerdict {
  pass: boolean;
  detail: string;
}
function checkCell(
  label: string,
  raw: string | null | undefined,
  api: number | null | undefined,
  opts: { times100?: boolean; percent: boolean },
): void {
  const v = evaluateCell(raw, api, opts);
  if (v.pass) ok(label, v.detail);
  else fail(label, v.detail);
}

function checkText(label: string, rendered: string | null | undefined, expected: string): void {
  if (rendered == null) {
    fail(label, `rendered text not found on page (expected "${expected}")`);
  } else if (rendered.trim() === expected) {
    ok(label, `"${expected}"`);
  } else {
    fail(label, `rendered "${rendered.trim()}" but api says "${expected}"`);
  }
}

/** Same display transform the page applies to division/development names. */
function displayName(apiName: string): string {
  return apiName.replace("Esperanza Homes ", "").replace(", LLC", "");
}

// ---------- private UI server (static build + /api proxy) ----------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain",
};

function buildUi(): void {
  console.log(`audit:ui — building rhodes-analytics UI from current source (${uiDir})...`);
  const build = spawnSync("pnpm", ["run", "build"], {
    cwd: uiDir,
    stdio: "inherit",
    env: {
      ...process.env,
      BASE_PATH: "/",
      PORT: String(UI_PORT),
      NODE_ENV: "production",
    },
  });
  if (build.status !== 0) {
    throw new Error("audit:ui: UI build failed — cannot audit a page that does not build.");
  }
  if (!existsSync(join(uiDist, "index.html"))) {
    throw new Error(`audit:ui: UI build produced no ${join(uiDist, "index.html")}`);
  }
}

function startUiServer(): Promise<Server> {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://localhost:${UI_PORT}`);

      // Proxy /api/* to the audited API server (page and audit hit the SAME API).
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        const target = `${API_BASE}${url.pathname.slice("/api".length)}${url.search}`;
        try {
          const upstream = await fetch(target, {
            method: req.method,
            headers: { accept: req.headers["accept"] ?? "application/json" },
          });
          const body = Buffer.from(await upstream.arrayBuffer());
          res.writeHead(upstream.status, {
            "content-type": upstream.headers.get("content-type") ?? "application/json",
          });
          res.end(body);
        } catch (err) {
          res.writeHead(502, { "content-type": "text/plain" });
          res.end(`audit:ui proxy error for ${target}: ${String(err)}`);
        }
        return;
      }

      // Static files from the built UI, SPA-fallback to index.html.
      let filePath = normalize(join(uiDist, decodeURIComponent(url.pathname)));
      if (!filePath.startsWith(uiDist)) {
        res.writeHead(403).end();
        return;
      }
      if (!existsSync(filePath) || extname(filePath) === "") {
        filePath = join(uiDist, "index.html");
      }
      try {
        const data = readFileSync(filePath);
        res.writeHead(200, {
          "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
        });
        res.end(data);
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(String(err));
      }
    })().catch((err) => {
      try {
        res.writeHead(500).end(String(err));
      } catch {
        /* headers already sent */
      }
    });
  });
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(UI_PORT, "127.0.0.1", () => {
      console.log(`audit:ui — serving built UI on http://localhost:${UI_PORT} (api → ${API_BASE})`);
      resolvePromise(server);
    });
  });
}

// ---------- browser ----------

function chromiumPath(): string {
  if (process.env.AUDIT_CHROMIUM) return process.env.AUDIT_CHROMIUM;
  try {
    return execSync("which chromium", { encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      "audit:ui: no chromium binary found. Install the `chromium` system dependency or set AUDIT_CHROMIUM.",
    );
  }
}

/**
 * One overview-with-targets request the PAGE ITSELF issued. Recorded at
 * REQUEST time (so phase 2 can assert "this control fired a request with
 * these exact params" even before the — possibly slow — response lands),
 * then enriched with status/body when the response arrives.
 */
interface OverviewHit {
  url: URL;
  status: number | null;
  failure: string | null;
  body: Promise<unknown> | null;
}
/** Everything the audit reads off the rendered page, extracted in one pass. */
interface DomSnapshot {
  errorAlert: string | null;
  kpis: Record<string, string | null>;
  matrix: {
    headers: string[];
    rows: { label: string; sub: string | null; cells: string[] }[];
  } | null;
  ratios: { headers: string[]; rows: string[][] } | null;
  divisions: SummaryTableSnapshot | null;
  developments: SummaryTableSnapshot | null;
}
interface SummaryTableSnapshot {
  headers: string[];
  rows: string[][];
  footer: string[];
}

async function extractDom(page: Page): Promise<DomSnapshot> {
  return page.evaluate(() => {
    const text = (el: Element | null | undefined): string | null =>
      el ? (el as HTMLElement).innerText.trim() : null;

    const alertEl = Array.from(document.querySelectorAll('[role="alert"], h5')).find((el) =>
      (el.textContent ?? "").includes("Failed to load dashboard data"),
    );
    const errorAlert = alertEl ? text(alertEl.closest('[role="alert"]') ?? alertEl) : null;

    const kpis: Record<string, string | null> = {};
    for (const id of [
      "kpi-sales-goal",
      "kpi-sales-td-goal",
      "kpi-gross-sales",
      "kpi-ptg-variance",
      "kpi-ptg-percent",
    ]) {
      kpis[id] = text(document.querySelector(`[data-testid="${id}"]`));
    }

    const headersOf = (table: Element): string[] =>
      Array.from(table.querySelectorAll("thead th")).map((th) => text(th) ?? "");

    const matrixTable = document.querySelector('[data-testid="table-traffic-matrix"]');
    let matrix: DomSnapshot["matrix"] = null;
    if (matrixTable) {
      const rows: { label: string; sub: string | null; cells: string[] }[] = [];
      for (const tr of Array.from(matrixTable.querySelectorAll("tbody tr"))) {
        const tds = Array.from(tr.querySelectorAll("td"));
        if (tds.length < 2 || tds[0].hasAttribute("colspan")) continue; // section header row
        const labelLines = (text(tds[0]) ?? "").split("\n").map((s) => s.trim());
        rows.push({
          label: labelLines[0] ?? "",
          sub: labelLines[1] ?? null,
          cells: tds.map((td) => text(td) ?? ""),
        });
      }
      matrix = { headers: headersOf(matrixTable), rows };
    }

    const ratioTable = document.querySelector('[data-testid="table-ratios"]');
    let ratios: DomSnapshot["ratios"] = null;
    if (ratioTable) {
      ratios = {
        headers: headersOf(ratioTable),
        rows: Array.from(ratioTable.querySelectorAll("tbody tr")).map((tr) =>
          Array.from(tr.querySelectorAll("td")).map((td) => text(td) ?? ""),
        ),
      };
    }

    const summary = (testid: string): { headers: string[]; rows: string[][]; footer: string[] } | null => {
      const table = document.querySelector(`[data-testid="${testid}"]`);
      if (!table) return null;
      return {
        headers: headersOf(table),
        rows: Array.from(table.querySelectorAll("tbody tr")).map((tr) =>
          Array.from(tr.querySelectorAll("td")).map((td) => text(td) ?? ""),
        ),
        footer: Array.from(table.querySelectorAll("tfoot tr td")).map((td) => text(td) ?? ""),
      };
    };

    return {
      errorAlert,
      kpis,
      matrix,
      ratios,
      divisions: summary("table-divisions"),
      developments: summary("table-developments"),
    };
  });
}

// ---------- header-anchored column lookup ----------

/**
 * The rendered headers must equal the audited binding map EXACTLY as a
 * multiset: an added, renamed, removed, or DUPLICATED column is an unaudited
 * binding, not a cosmetic change. On mismatch the table's cell checks are
 * skipped (returns false) — with an unknown column layout, "the number under
 * this header" is no longer well-defined, so we fail before reading cells.
 */
function checkHeaderSet(tableLabel: string, rendered: string[], expected: string[]): boolean {
  const tally = (xs: string[]) => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const have = tally(rendered);
  const want = tally(expected);
  const problems: string[] = [];
  for (const [h, n] of have) {
    const w = want.get(h) ?? 0;
    if (n > w) problems.push(w === 0 ? `unexpected "${h}"` : `"${h}" appears ×${n}, expected ×${w}`);
  }
  for (const [h, n] of want) {
    const r = have.get(h) ?? 0;
    if (r < n) problems.push(r === 0 ? `missing "${h}"` : `"${h}" appears ×${r}, expected ×${n}`);
  }
  if (problems.length > 0) {
    fail(
      `${tableLabel} · columns`,
      `rendered headers [${rendered.join(" | ")}] do not exactly match the audited binding map ` +
        `[${expected.join(" | ")}]: ${problems.join("; ")} — cell checks for this table skipped ` +
        `until the audit's binding map covers every rendered column`,
    );
    return false;
  }
  ok(
    `${tableLabel} · columns`,
    `rendered headers exactly match the audited binding contract (${expected.length} columns)`,
  );
  return true;
}

function columnIndex(
  tableLabel: string,
  headers: string[],
  header: string,
  missing: Set<string>,
): number {
  const idx = headers.indexOf(header);
  if (idx === -1 && !missing.has(`${tableLabel}|${header}`)) {
    missing.add(`${tableLabel}|${header}`);
    fail(
      `${tableLabel} · header "${header}"`,
      `column not found — page headers are [${headers.join(" | ")}]. ` +
        `A renamed/removed column breaks the audited binding contract.`,
    );
  }
  return idx;
}

/** The five headline KPI bindings — shared by phase 1 and the phase-2 re-render check. */
function kpiSpecs(p: OverviewPayload): { id: string; api: number | null; percent: boolean }[] {
  return [
    { id: "kpi-sales-goal", api: p.kpis.salesGoal, percent: false },
    { id: "kpi-sales-td-goal", api: p.kpis.salesTdGoal, percent: false },
    { id: "kpi-gross-sales", api: p.kpis.grossSales, percent: false },
    { id: "kpi-ptg-variance", api: p.kpis.ptgVariance, percent: false },
    { id: "kpi-ptg-percent", api: p.kpis.ptgPercent, percent: true },
  ];
}
function checkKpis(dom: DomSnapshot, p: OverviewPayload): void {
  for (const s of kpiSpecs(p)) {
    checkCell(`KPI ${s.id}`, dom.kpis[s.id], s.api, { percent: s.percent });
  }
}

// hint: Logic changed on both sides. Requires understanding intent of each change.
function checkMatrix(dom: DomSnapshot, p: OverviewPayload): void {
  if (!dom.matrix) {
    fail("traffic matrix", 'table [data-testid="table-traffic-matrix"] not found on page');
    return;
  }
  if (
    !checkHeaderSet("traffic matrix", dom.matrix.headers, [
      "Measure",
      "Full Span Goal",
      "To Date Goal",
      "Actual",
      "PTG %",
    ])
  ) {
    return;
  }
  const m = p.trafficMatrix;
  const bindings: Record<string, MatrixCell> = {
    "Website Users": m.online.websiteUsers,
    "Online Leads": m.online.leads,
    "Online Tours": m.online.tours,
    "Online Sales": m.online.sales,
    "Onsite Leads": m.onsite.leads,
    "Onsite Tours": m.onsite.tours,
    "Onsite Sales": m.onsite.sales,
    "Total Leads": m.total.leads,
    "Total Tours": m.total.tours,
  };
  // Unknown-channel rows are actuals-only (no goals exist for the bucket):
  // the page renders "–" in every goal/PTG column, the actual from
  // trafficMatrix.unknown, and a "<n>% of <total>" share subtitle. The whole
  // section is hidden when the bucket is all zero.
  const unknownBindings: Record<string, { actual: number; total: number; totalName: string }> = {
    "Unknown Leads": { actual: m.unknown.leads, total: m.total.leads.actual, totalName: "total leads" },
    "Unknown Tours": { actual: m.unknown.tours, total: m.total.tours.actual, totalName: "total tours" },
    "Unknown Sales": { actual: m.unknown.sales, total: p.kpis.grossSales, totalName: "gross sales" },
  };
  const hasUnknown = m.unknown.leads > 0 || m.unknown.tours > 0 || m.unknown.sales > 0;

  const missing = new Set<string>();
  const col = (h: string) => columnIndex("traffic matrix", dom.matrix!.headers, h, missing);
  const cFull = col("Full Span Goal");
  const cToDate = col("To Date Goal");
  const cActual = col("Actual");
  const cPtg = col("PTG %");

  const seen = new Set<string>();
  const seenUnknown = new Set<string>();
  for (const row of dom.matrix.rows) {
    const unk = unknownBindings[row.label];
    if (unk) {
      seenUnknown.add(row.label);
      if (!hasUnknown) {
        fail(
          `traffic matrix · "${row.label}"`,
          "row rendered although the api unknown-channel bucket is all zero (section should be hidden)",
        );
        continue;
      }
      if (cFull >= 0)
        checkCell(`matrix "${row.label}" · Full Span Goal`, row.cells[cFull], null, { percent: false });
      if (cToDate >= 0)
        checkCell(`matrix "${row.label}" · To Date Goal`, row.cells[cToDate], null, { percent: false });
      if (cActual >= 0)
        checkCell(`matrix "${row.label}" · Actual`, row.cells[cActual], unk.actual, { percent: false });
      if (cPtg >= 0)
        checkCell(`matrix "${row.label}" · PTG %`, row.cells[cPtg], null, { percent: true });
      // Share subtitle mirrors the page arithmetic: actual/total ×100,
      // "<1" below 1%, else rounded to a whole percent; absent when the
      // actual or the total is zero.
      const pct = unk.total > 0 && unk.actual > 0 ? (unk.actual / unk.total) * 100 : null;
      const expectedSub =
        pct == null ? null : `${pct < 1 ? "<1" : String(Math.round(pct))}% of ${unk.totalName}`;
      const sub = row.sub;
      if (expectedSub == null) {
        if (sub != null && sub.trim() !== "") {
          fail(
            `matrix "${row.label}" · share subtitle`,
            `expected no subtitle (actual or total is 0) but page rendered "${sub.trim()}"`,
          );
        } else {
          ok(`matrix "${row.label}" · share subtitle`, "no subtitle (actual or total is 0)");
        }
      } else {
        checkText(`matrix "${row.label}" · share subtitle`, sub, expectedSub);
      }
      continue;
    }
    const cell = bindings[row.label];
    if (!cell) {
      fail(`traffic matrix · "${row.label}"`, "row label does not match any audited API metric");
      continue;
    }
    seen.add(row.label);
    if (cFull >= 0)
      checkCell(`matrix "${row.label}" · Full Span Goal`, row.cells[cFull], cell.fullSpanGoal, { percent: false });
    if (cToDate >= 0)
      checkCell(`matrix "${row.label}" · To Date Goal`, row.cells[cToDate], cell.toDateGoal, { percent: false });
    if (cActual >= 0)
      checkCell(`matrix "${row.label}" · Actual`, row.cells[cActual], cell.actual, { percent: false });
    if (cPtg >= 0)
      checkCell(`matrix "${row.label}" · PTG %`, row.cells[cPtg], cell.ptgPercent, { percent: true });

    if (row.label === "Website Users") {
      const sub = row.sub ?? "";
      const match = /^New users:\s*(.+)$/.exec(sub);
      if (!match) {
        fail(`matrix "Website Users" · new-users subtitle`, `expected "New users: <n>" but saw "${sub}"`);
      } else {
        checkCell(`matrix "Website Users" · New users subtitle`, match[1], m.newWebsiteUsers, { percent: false });
      }
    }
  }
  for (const label of Object.keys(bindings)) {
    if (!seen.has(label)) {
      fail(`traffic matrix · "${label}"`, "expected row is missing from the rendered table");
    }
  }
  if (hasUnknown) {
    for (const label of Object.keys(unknownBindings)) {
      if (!seenUnknown.has(label)) {
        fail(
          `traffic matrix · "${label}"`,
          "expected row is missing (api unknown-channel bucket is nonzero)",
        );
      }
    }
  }
}

function checkRatios(dom: DomSnapshot, p: OverviewPayload): void {
  if (!dom.ratios) {
    fail("ratios", 'table [data-testid="table-ratios"] not found on page');
    return;
  }
  if (!checkHeaderSet("ratios", dom.ratios.headers, ["Conversion Ratio", "Goal", "Actual", "PTG %"])) {
    return;
  }
  const missing = new Set<string>();
  const col = (h: string) => columnIndex("ratios", dom.ratios!.headers, h, missing);
  const cName = col("Conversion Ratio");
  const cGoal = col("Goal");
  const cActual = col("Actual");
  const cPtg = col("PTG %");

  if (dom.ratios.rows.length !== p.ratios.length) {
    fail(
      "ratios · row count",
      `page renders ${dom.ratios.rows.length} rows but api payload has ${p.ratios.length}`,
    );
  } else {
    ok("ratios · row count", `${p.ratios.length} rows`);
  }

  const n = Math.min(dom.ratios.rows.length, p.ratios.length);
  for (let i = 0; i < n; i++) {
    const rendered = dom.ratios.rows[i];
    const api = p.ratios[i];
    if (cName >= 0) checkText(`ratio[${i}] · name`, rendered[cName], api.name);
    // goal/actual are FRACTIONS in the API, rendered ×100 with a % sign.
    if (cGoal >= 0)
      checkCell(`ratio[${i}] "${api.name}" · Goal`, rendered[cGoal], api.goal, { percent: true, times100: true });
    if (cActual >= 0)
      checkCell(`ratio[${i}] "${api.name}" · Actual`, rendered[cActual], api.actual, { percent: true, times100: true });
    // ptgPercent is ALREADY percent units in the API.
    if (cPtg >= 0)
      checkCell(`ratio[${i}] "${api.name}" · PTG %`, rendered[cPtg], api.ptgPercent, { percent: true });
  }
}

/** "1,234 (56%)" → { main: "1,234", pct: "56%" } */
function splitCountWithShare(raw: string): { main: string; pct: string | null } {
  const m = /^(.*?)\s*\((.*?)\)\s*$/.exec(raw.trim());
  if (!m) return { main: raw.trim(), pct: null };
  return { main: m[1], pct: m[2] };
}

function checkSummaryTable(
  tableLabel: string,
  snap: SummaryTableSnapshot | null,
  labelHeader: string,
  apiRows: BreakdownRow[],
  rowName: (r: BreakdownRow) => string,
  p: OverviewPayload,
): void {
  if (!snap) {
    fail(tableLabel, `table not found on page`);
    return;
  }
  const missing = new Set<string>();
  const col = (h: string) => columnIndex(tableLabel, snap.headers, h, missing);
  const cLabel = col(labelHeader);
  const cNew = col("New Users");
  const cTotal = col("Total Users");
  const cLeads = col("Leads");
  const cTours = col("Tours");
  const cSales = col("Sales");
  const ptgCols: { header: string; field: keyof BreakdownRow }[] = [
    { header: "Sales PTG", field: "salesPtg" },
    { header: "Tours PTG", field: "toursPtg" },
    { header: "Leads PTG", field: "leadsPtg" },
    { header: "Traffic PTG", field: "onlineTrafficPtg" },
    { header: "Onl. Leads PTG", field: "onlineLeadsPtg" },
    { header: "Onl. Tours PTG", field: "onlineToursPtg" },
    { header: "Onl. Sales PTG", field: "onlineSalesPtg" },
    { header: "Ons. Leads PTG", field: "onsiteLeadsPtg" },
    { header: "Ons. Tours PTG", field: "onsiteToursPtg" },
    { header: "Ons. Sales PTG", field: "onsiteSalesPtg" },
  ];
  if (
    !checkHeaderSet(tableLabel, snap.headers, [
      labelHeader,
      "New Users",
      "Total Users",
      "Leads",
      "Tours",
      "Sales",
      ...ptgCols.map((c) => c.header),
    ])
  ) {
    return;
  }

  if (snap.rows.length !== apiRows.length) {
    fail(
      `${tableLabel} · row count`,
      `page renders ${snap.rows.length} rows but api payload has ${apiRows.length}`,
    );
  } else {
    ok(`${tableLabel} · row count`, `${apiRows.length} rows`);
  }

  // EVERY row: name (catches row-order / mapping drift) + every numeric cell.
  const n = Math.min(snap.rows.length, apiRows.length);
  for (let i = 0; i < n; i++) {
    if (cLabel >= 0)
      checkText(`${tableLabel}[${i}] · name`, snap.rows[i][cLabel], displayName(rowName(apiRows[i])));
    const rendered = snap.rows[i];
    const api = apiRows[i];
    const name = displayName(rowName(api));
    if (cNew >= 0)
      checkCell(`${tableLabel} "${name}" · New Users`, rendered[cNew], api.newWebsiteUsers, { percent: false });
    if (cTotal >= 0)
      checkCell(`${tableLabel} "${name}" · Total Users`, rendered[cTotal], api.totalWebsiteUsers, { percent: false });
    const countCols: { idx: number; header: string; count: number; share: number }[] = [
      { idx: cLeads, header: "Leads", count: api.leads, share: api.leadsPctOfTotal },
      { idx: cTours, header: "Tours", count: api.tours, share: api.toursPctOfTotal },
      { idx: cSales, header: "Sales", count: api.sales, share: api.salesPctOfTotal },
    ];
    for (const c of countCols) {
      if (c.idx < 0) continue;
      const { main, pct } = splitCountWithShare(rendered[c.idx] ?? "");
      checkCell(`${tableLabel} "${name}" · ${c.header}`, main, c.count, { percent: false });
      if (pct == null) {
        fail(`${tableLabel} "${name}" · ${c.header} share`, `no "(..%)" share found in "${rendered[c.idx]}"`);
      } else {
        checkCell(`${tableLabel} "${name}" · ${c.header} share`, pct, c.share, { percent: true });
      }
    }
    for (const pc of ptgCols) {
      const idx = col(pc.header);
      if (idx < 0) continue;
      checkCell(
        `${tableLabel} "${name}" · ${pc.header}`,
        rendered[idx],
        api[pc.field] as number | null,
        { percent: true },
      );
    }
  }

  // Footer totals: distinct user counts come from the headline payload, the
  // rest are sums of the API rows (exactly what the page promises to render).
  if (snap.footer.length === 0) {
    fail(`${tableLabel} · footer`, "no footer totals row found");
    return;
  }
  const sum = (pick: (r: BreakdownRow) => number) => apiRows.reduce((t, r) => t + pick(r), 0);
  const footerSpecs: { idx: number; header: string; api: number }[] = [
    { idx: cNew, header: "New Users", api: p.trafficMatrix.newWebsiteUsers },
    { idx: cTotal, header: "Total Users", api: p.trafficMatrix.online.websiteUsers.actual },
    { idx: cLeads, header: "Leads", api: sum((r) => r.leads) },
    { idx: cTours, header: "Tours", api: sum((r) => r.tours) },
    { idx: cSales, header: "Sales", api: sum((r) => r.sales) },
  ];
  for (const f of footerSpecs) {
    if (f.idx < 0 || f.idx >= snap.footer.length) continue;
    checkCell(`${tableLabel} · footer ${f.header}`, snap.footer[f.idx], f.api, { percent: false });
  }
}

function fmtParams(expected: Record<string, string>): string {
  return (
    Object.entries(expected)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" & ") || "(no parameters)"
  );
}
async function main(): Promise<void> {
  console.log(`audit:ui — auditing rendered Overview with Targets against ${API_BASE}`);

  let server: Server | null = null;
  let browser: Browser | null = null;
  try {
    let uiBase: string;
    if (EXTERNAL_UI_BASE) {
      uiBase = EXTERNAL_UI_BASE;
      console.log(`audit:ui — using already-running UI at ${uiBase} (AUDIT_UI_BASE)`);
    } else {
      buildUi();
      server = await startUiServer();
      uiBase = `http://localhost:${UI_PORT}`;
    }

    const executablePath = chromiumPath();
    console.log(`audit:ui — launching headless chromium (${executablePath})`);
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const page = await browser.newPage({ viewport: { width: 1720, height: 1200 } });

    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

    const hits = trackOverviewRequests(page);

    const pageUrl = `${uiBase}${PAGE_PATH}`;
    console.log(`audit:ui — loading ${pageUrl}`);
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // Wait until the dashboard either rendered data or its error state.
    const kpi = page.locator('[data-testid="kpi-sales-goal"]');
    const errorAlert = page.getByText("Failed to load dashboard data");
    await kpi.or(errorAlert).first().waitFor({ state: "visible", timeout: DATA_TIMEOUT_MS });
    if (await errorAlert.isVisible().catch(() => false)) {
      const details = await errorAlert
        .locator("xpath=ancestor::*[@role='alert']")
        .first()
        .innerText()
        .catch(() => "Failed to load dashboard data");
      throw new Error(
        `page rendered its ERROR state instead of data:\n${details}\n` +
          (consoleErrors.length ? `console errors:\n${consoleErrors.join("\n")}` : ""),
      );
    }
    // Let the remaining sections (ratios render with the same payload) settle.
    await page.waitForTimeout(1000);

    if (hits.length === 0) {
      throw new Error(
        `page never issued GET ${OVERVIEW_API_PATH} — cannot audit bindings` +
          (consoleErrors.length ? `\nconsole errors:\n${consoleErrors.join("\n")}` : ""),
      );
    }
    const last = hits[hits.length - 1];
    await waitUntil(() => last.status != null || last.failure != null, DATA_TIMEOUT_MS, 250);
    if (last.failure != null) {
      throw new Error(`the page's overview request failed in-browser: ${last.failure}`);
    }
    console.log(
      `audit:ui — captured the page's own request: ${last.url} → HTTP ${last.status}` +
        (hits.length > 1 ? ` (${hits.length} requests, comparing against the latest)` : ""),
    );
    if (last.status !== 200) {
      throw new Error(`the page's overview request returned HTTP ${last.status}`);
    }
    // The initial request is itself a wiring check: the default view must ask
    // the default question — ?target=goal and nothing else.
    {
      const problems = paramProblems(last.url.searchParams, { target: "goal" });
      if (problems.length > 0) {
        fail(
          "wiring · initial load",
          `the page's first request was "${last.url.pathname}${last.url.search}" — ${problems.join("; ")} ` +
            `(expected exactly target="goal")`,
        );
      } else {
        ok("wiring · initial load", 'initial request carried exactly target="goal"');
      }
    }
    const payload = (await last.body) as OverviewPayload & { __parseError?: string };
    if (payload.__parseError) {
      throw new Error(`could not parse the page's overview response: ${payload.__parseError}`);
    }
    if (!payload?.kpis || !payload?.trafficMatrix || !Array.isArray(payload?.ratios)) {
      throw new Error(
        `captured payload is missing expected sections (kpis/trafficMatrix/ratios): ${JSON.stringify(payload).slice(0, 400)}`,
      );
    }
    console.log(
      `audit:ui — payload range ${payload.appliedRange.startDate} → ${payload.appliedRange.endDate}` +
        ` (through ${payload.appliedRange.toDate}, target=${payload.appliedRange.target}); ` +
        `${payload.divisions.length} division row(s), ${payload.developments.length} development row(s), ` +
        `${payload.ratios.length} ratio row(s)\n`,
    );

    const dom = await extractDom(page);
    if (dom.errorAlert) {
      throw new Error(`page shows an error alert: ${dom.errorAlert}`);
    }

    checkKpis(dom, payload);
    checkMatrix(dom, payload);
    checkRatios(dom, payload);

    checkSummaryTable(
      "divisions",
      dom.divisions,
      "Division",
      payload.divisions,
      (r) => r.division,
      payload,
    );
    checkSummaryTable(
      "developments",
      dom.developments,
      "Development",
      payload.developments,
      (r) => r.development ?? r.division,
      payload,
    );

    await auditFilterWiring(page, hits);

    if (consoleErrors.length > 0) {
      console.log(`\naudit:ui — note: ${consoleErrors.length} browser console error(s):`);
      for (const e of consoleErrors.slice(0, 10)) console.log(`  ${e}`);
    }

    console.log("");
    if (failures > 0) {
      console.error(
        `AUDIT FAILED: ${failures} of ${checks} check(s) failed — rendered values or filter→request wiring ` +
          `do not match the page's own API contract. The dashboard is showing users numbers the audited ` +
          `API did not produce, or asking the API a different question than the filters claim.`,
      );
      process.exitCode = 1;
    } else {
      console.log(
        `Audit passed: all ${checks} rendered values AND filter-wiring checks on Overview with Targets ` +
          `match the page's own API requests and payloads.`,
      );
    }
  } finally {
    await browser?.close().catch(() => {});
    server?.close();
  }
}

/**
 * Open a (Radix) select by its trigger testid and click one option, picked
 * from the RENDERED option texts by `wanted`. Returns the chosen option's
 * raw textContent — the page's SelectItem uses the option string as BOTH its
 * value and its visible text, so the clicked text is the exact string the
 * next request must carry. (If those ever diverge, this audit fails loudly
 * and must be updated together with the page.)
 */
async function pickOption(
  page: Page,
  control: string,
  testId: string,
  wanted: (texts: string[]) => number,
  description: string,
): Promise<string | null> {
  const trigger = page.locator(`[data-testid="${testId}"]`);
  if ((await trigger.count()) === 0) {
    fail(`wiring · ${control}`, `select trigger [data-testid="${testId}"] not found on the page`);
    return null;
  }
  // The option list is fed by the filters endpoint; retry briefly in case it
  // is still resolving when phase 2 starts ("All" alone means not loaded yet
  // — or a genuinely empty dropdown, which fails after the retries).
  for (let attempt = 0; attempt < 5; attempt++) {
    await trigger.click();
    const options = page.locator('[role="option"]');
    const appeared = await options
      .first()
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(
        () => true,
        () => false,
      );
    const texts = appeared ? await options.allTextContents() : [];
    const idx = appeared ? wanted(texts) : -1;
    if (idx >= 0 && idx < texts.length) {
      await options.nth(idx).click();
      return texts[idx];
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1_000);
  }
  fail(
    `wiring · ${control}`,
    `dropdown [data-testid="${testId}"] never offered ${description} — cannot drive this control`,
  );
  return null;
}

/**
 * Compare one rendered cell against the API field it must bind.
 *  - `times100`: API value is a fraction rendered as a percent (ratio goal/actual)
 *  - `percent`:  whether the rendered text must (true) / must not (false) carry a % suffix
 * Tolerance is half a unit of the LAST RENDERED decimal place — exactly the
 * information lost to display rounding, nothing more.
 * Pure verdict (no logging) so the phase-2 re-render poller can evaluate
 * quietly; `checkCell` wraps it with ok/fail bookkeeping.
 */
function evaluateCell(
  raw: string | null | undefined,
  api: number | null | undefined,
  opts: { times100?: boolean; percent: boolean },
): CellVerdict {
  if (raw == null) {
    return { pass: false, detail: `rendered cell not found on page (api=${api})` };
  }
  const p = parseRendered(raw);
  const apiIsNull = api == null || Number.isNaN(api);
  if (apiIsNull) {
    if (p.empty) return { pass: true, detail: `"${raw.trim()}" ↔ api null` };
    return {
      pass: false,
      detail: `api value is null but page rendered "${raw.trim()}" instead of "${EN_DASH}"`,
    };
  }
  if (p.empty) {
    return { pass: false, detail: `page rendered placeholder "${EN_DASH}" but api value is ${api}` };
  }
  if (p.invalid) {
    return { pass: false, detail: `unparseable rendered value "${raw.trim()}" (api=${api})` };
  }
  if (opts.percent && !p.isPercent) {
    return { pass: false, detail: `expected a percent but page rendered "${raw.trim()}" without % (api=${api})` };
  }
  if (!opts.percent && p.isPercent) {
    return { pass: false, detail: `expected a plain number but page rendered "${raw.trim()}" with % (api=${api})` };
  }
  const expected = opts.times100 ? api * 100 : api;
  const tol = 0.5 * Math.pow(10, -(p.decimals ?? 0)) + 1e-9;
  const diff = Math.abs((p.value as number) - expected);
  if (diff <= tol) {
    return {
      pass: true,
      detail: `rendered "${raw.trim()}" ↔ api ${expected}${opts.times100 ? ` (${api} ×100)` : ""}`,
    };
  }
  return {
    pass: false,
    detail:
      `rendered "${raw.trim()}" (=${p.value}) does not match api ${expected}` +
      `${opts.times100 ? ` (${api} ×100)` : ""} — diff ${diff} exceeds display-rounding tolerance ${tol}`,
  };
}

function trackOverviewRequests(page: Page): OverviewHit[] {
  const hits: OverviewHit[] = [];
  const byRequest = new Map<Request, OverviewHit>();
  page.on("request", (req) => {
    try {
      const u = new URL(req.url());
      if (u.pathname === OVERVIEW_API_PATH) {
        const hit: OverviewHit = { url: u, status: null, failure: null, body: null };
        hits.push(hit);
        byRequest.set(req, hit);
      }
    } catch {
      /* ignore non-URL requests */
    }
  });
  page.on("response", (res) => {
    const hit = byRequest.get(res.request());
    if (hit) {
      hit.status = res.status();
      hit.body = res.json().catch((e) => ({ __parseError: String(e) }));
    }
  });
  page.on("requestfailed", (req) => {
    const hit = byRequest.get(req);
    if (hit && hit.status == null) hit.failure = req.failure()?.errorText ?? "request failed";
  });
  return hits;
}

/**
 * Install a route that can hold ONE armed overview request before it is
 * forwarded to the server. While held, its response cannot possibly have
 * arrived — so the page showing its loading state during the hold PROVES the
 * headline is keyed to this request's lifecycle. Value-equality alone cannot
 * prove that: for contact-scoped filters (Cohort Quarter, Contact Channel)
 * the new payload's headline legitimately equals the old one, so a view that
 * kept stale data mounted would pass the equality check vacuously.
 * Un-armed requests (page retries, reset steps) pass straight through.
 */
async function installOverviewHold(page: Page): Promise<() => OverviewHold> {
  let pending: { onHeld: (v: boolean) => void; released: Promise<void> } | null = null;
  await page.route(
    (url) => url.pathname === OVERVIEW_API_PATH,
    async (route) => {
      const p = pending;
      pending = null;
      if (p) {
        p.onHeld(true);
        await p.released;
      }
      try {
        await route.continue();
      } catch {
        // page tearing down mid-flight — nothing left to audit on this route
      }
    },
  );
  return () => {
    let onHeld!: (v: boolean) => void;
    let onRelease!: () => void;
    const held = new Promise<boolean>((r) => (onHeld = r));
    const released = new Promise<void>((r) => (onRelease = r));
    const timer = setTimeout(() => onHeld(false), WIRING_REQUEST_TIMEOUT_MS + 2_000);
    pending = { onHeld, released };
    return {
      held,
      release: () => {
        clearTimeout(timer);
        pending = null; // disarm if the request never came
        onRelease();
        onHeld(false); // no-op when already resolved true
      },
    };
  };
}

/**
 * After a filter change the headline must re-render FROM THE NEW PAYLOAD:
 * the applied-range subtitle must echo the new response's appliedRange and
 * every KPI cell its kpis. (The render-lifecycle check in wiringStep proved
 * the headline unmounted while this request was in flight, so a match here
 * proves repopulation from the new response — not a leftover of the old
 * payload, even when old and new values coincide.)
 */
async function checkHeadlineRerender(page: Page, control: string, p: OverviewPayload): Promise<void> {
  const deadline = Date.now() + RERENDER_TIMEOUT_MS;
  let snap = await readHeadline(page);
  while (!headlineMatches(snap, p) && Date.now() < deadline) {
    await page.waitForTimeout(250);
    snap = await readHeadline(page);
  }
  if (headlineMatches(snap, p)) {
    ok(
      `wiring · ${control} · re-render`,
      "headline (applied-range subtitle + 5 KPI cells) re-rendered from the new payload",
    );
    return;
  }
  // Timed out — emit per-cell diagnostics so the offending binding is named.
  checkText(
    `wiring · ${control} · re-render applied-range`,
    snap.appliedRange?.replace(/\s+/g, " "),
    expectedAppliedRangeText(p),
  );
  for (const s of kpiSpecs(p)) {
    checkCell(`wiring · ${control} · re-render ${s.id}`, snap.kpis[s.id], s.api, {
      percent: s.percent,
    });
  }
}

interface HeadlineSnapshot {
  kpis: Record<string, string | null>;
  appliedRange: string | null;
}

const DRAIN_TIMEOUT_MS = 30_000;

function headlineMatches(snap: HeadlineSnapshot, p: OverviewPayload): boolean {
  if ((snap.appliedRange ?? "").replace(/\s+/g, " ") !== expectedAppliedRangeText(p)) return false;
  return kpiSpecs(p).every((s) => evaluateCell(snap.kpis[s.id], s.api, { percent: s.percent }).pass);
}

function headlinePresent(snap: HeadlineSnapshot): boolean {
  return snap.appliedRange != null || Object.values(snap.kpis).some((v) => v != null);
}
const RERENDER_TIMEOUT_MS = 15_000;

const DRAIN_GRACE_MS = 800;

function expectedAppliedRangeText(p: OverviewPayload): string {
  // Mirrors the page's subtitle: "<start> → <end> · progress through <toDate>".
  return `${p.appliedRange.startDate} \u2192 ${p.appliedRange.endDate} \u00b7 progress through ${p.appliedRange.toDate}`;
}

interface OverviewHold {
  /** Resolves true once the next overview request is held at the route layer (false: timed out unheld). */
  held: Promise<boolean>;
  release: () => void;
}

interface WiringStepOpts {
  control: string;
  /** Drive the control; return false when it could not be driven (failure already recorded). */
  action: () => Promise<boolean>;
  /** Exact query params the next request must carry (evaluated after the action ran). */
  expected: () => Record<string, string> | null;
  verifyRerender: boolean;
}

/**
 * Drive one control, then verify the page's next overview request(s):
 * fired at all, carrying exactly the expected params, completed HTTP 200
 * with a parseable payload — and (for filter changes) that the headline
 * re-rendered from that payload. Returns the payload, or null when the step
 * failed in a way that leaves the page usable for the next control.
 */
async function wiringStep(
  page: Page,
  hits: OverviewHit[],
  opts: WiringStepOpts,
): Promise<OverviewPayload | null> {
  // Let stragglers from the previous step (late page retries, cache-refresh
  // writes) land BEFORE this step's window opens so they are not
  // misattributed to this control — and the shared proxy gets breathing room.
  await waitUntil(() => hits.every((h) => h.status != null || h.failure != null), DRAIN_TIMEOUT_MS, 250);
  await page.waitForTimeout(DRAIN_GRACE_MS);

  // For re-render steps, hold the upcoming request at the route layer so we
  // can prove the headline enters its loading state WHILE the request is in
  // flight (response provably not yet available).
  const hold = opts.verifyRerender && armOverviewHold ? armOverviewHold() : null;
  let expected: Record<string, string> | null = null;
  let stepHits: OverviewHit[] = [];
  try {
    const before = hits.length;
    if (!(await opts.action())) return null;
    expected = opts.expected();
    if (expected == null) return null;

    if (!(await waitUntil(() => hits.length > before, WIRING_REQUEST_TIMEOUT_MS))) {
      fail(
        `wiring · ${opts.control}`,
        `changing this control fired NO ${OVERVIEW_API_PATH} request within ` +
          `${WIRING_REQUEST_TIMEOUT_MS / 1000}s — the control is not connected to the dashboard query ` +
          `(expected a request carrying exactly ${fmtParams(expected)})`,
      );
      return null;
    }
    await page.waitForTimeout(WIRING_SETTLE_MS);
    stepHits = hits.slice(before);
    let wired = true;
    for (const hit of stepHits) {
      const problems = paramProblems(hit.url.searchParams, expected);
      if (problems.length > 0) {
        wired = false;
        fail(
          `wiring · ${opts.control}`,
          `the page requested "${hit.url.pathname}${hit.url.search}" — WRONG WIRING: ${problems.join("; ")} ` +
            `(expected exactly ${fmtParams(expected)})`,
        );
      }
    }
    if (wired) {
      ok(
        `wiring · ${opts.control}`,
        `${stepHits.length === 1 ? "request" : `all ${stepHits.length} requests`} carried exactly ` +
          `${fmtParams(expected)} ("${stepHits[stepHits.length - 1].url.search}")`,
      );
    }

    if (hold) {
      if (!(await hold.held)) {
        fail(
          `wiring · ${opts.control} · render lifecycle`,
          `the new overview request was never intercepted for the in-flight render check — ` +
            `cannot prove the headline is bound to this request`,
        );
      } else {
        // The response is withheld right now: a headline still showing values
        // is provably NOT rendering this request's data.
        const deadline = Date.now() + INFLIGHT_ABSENT_TIMEOUT_MS;
        let snap = await readHeadline(page);
        while (headlinePresent(snap) && Date.now() < deadline) {
          await page.waitForTimeout(100);
          snap = await readHeadline(page);
        }
        if (headlinePresent(snap)) {
          fail(
            `wiring · ${opts.control} · render lifecycle`,
            `the headline kept showing values (applied-range="${snap.appliedRange}") while this request was ` +
              `withheld — the view is NOT bound to this request's lifecycle, so it would keep showing stale ` +
              `data even when the filters ask a different question`,
          );
        } else {
          ok(
            `wiring · ${opts.control} · render lifecycle`,
            `headline entered its loading state while the request was in flight`,
          );
        }
      }
    }
  } finally {
    hold?.release();
  }

  if (expected == null || stepHits.length === 0) return null; // early-return paths above

  // The page must settle on this response before the next control is driven.
  // A transient failure (proxy rate-limit 429→502) is recovered by the page's
  // own query retries: keep judging the newest attempt — whose params must
  // ALSO match — until success, retries stop, or the recovery budget is spent.
  let last = stepHits[stepHits.length - 1];
  let retries = 0;
  const recoveryDeadline = Date.now() + TRANSIENT_RECOVERY_MS;
  for (;;) {
    if (!(await waitUntil(() => last.status != null || last.failure != null, DATA_TIMEOUT_MS, 250))) {
      throw new Error(
        `wiring · ${opts.control}: the overview request never completed within ${DATA_TIMEOUT_MS / 1000}s — ` +
          `server unresponsive, aborting the wiring phase`,
      );
    }
    const transient = last.failure != null || last.status === 429 || (last.status ?? 0) >= 500;
    if (!transient || Date.now() >= recoveryDeadline) break;
    const seenCount = hits.length;
    if (!(await waitUntil(() => hits.length > seenCount, RETRY_WAIT_MS, 250))) break; // page gave up retrying
    for (const h of hits.slice(seenCount)) {
      const problems = paramProblems(h.url.searchParams, expected);
      if (problems.length > 0) {
        fail(
          `wiring · ${opts.control}`,
          `retry request "${h.url.pathname}${h.url.search}" — WRONG WIRING: ${problems.join("; ")} ` +
            `(expected exactly ${fmtParams(expected)})`,
        );
      }
    }
    retries += hits.length - seenCount;
    last = hits[hits.length - 1];
  }
  if (last.failure != null) {
    fail(`wiring · ${opts.control} · response`, `the request failed in-browser: ${last.failure}`);
    return null;
  }
  if (last.status !== 200) {
    fail(
      `wiring · ${opts.control} · response`,
      `HTTP ${last.status} for "${last.url.search}"` +
        `${retries > 0 ? ` (still failing after ${retries} page retr${retries === 1 ? "y" : "ies"})` : ""}`,
    );
    return null;
  }
  if (retries > 0) {
    ok(
      `wiring · ${opts.control} · response`,
      `recovered with HTTP 200 after ${retries} transient failure(s) — the page retried itself`,
    );
  }
  const payload = (await last.body) as (OverviewPayload & { __parseError?: string }) | null;
  if (payload == null || payload.__parseError || !payload.kpis || !payload.appliedRange) {
    fail(
      `wiring · ${opts.control} · response`,
      `unparseable/malformed payload for "${last.url.search}"` +
        `${payload?.__parseError ? `: ${payload.__parseError}` : ""}`,
    );
    return null;
  }
  if (opts.verifyRerender) {
    await checkHeadlineRerender(page, opts.control, payload);
  }
  return payload;
}

const TRANSIENT_RECOVERY_MS = 45_000;

async function readHeadline(page: Page): Promise<HeadlineSnapshot> {
  return page.evaluate(() => {
    const text = (el: Element | null): string | null =>
      el ? (el as HTMLElement).innerText.trim() : null;
    const kpis: Record<string, string | null> = {};
    for (const id of [
      "kpi-sales-goal",
      "kpi-sales-td-goal",
      "kpi-gross-sales",
      "kpi-ptg-variance",
      "kpi-ptg-percent",
    ]) {
      kpis[id] = text(document.querySelector(`[data-testid="${id}"]`));
    }
    return {
      kpis,
      appliedRange: text(document.querySelector('[data-testid="text-applied-range"]')),
    };
  });
}

async function waitUntil(cond: () => boolean, timeoutMs: number, pollMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return true;
}

const WIRING_SETTLE_MS = 700; // window to catch duplicate/straggler requests from one change

const INFLIGHT_ABSENT_TIMEOUT_MS = 4_000; // headline must enter loading state while its request is withheld

async function auditFilterWiring(page: Page, hits: OverviewHit[]): Promise<void> {
  console.log("\naudit:ui — phase 2: driving each filter control and auditing its query-param wiring...");

  armOverviewHold = await installOverviewHold(page);

  const BASE: Record<string, string> = { target: "goal" };
  const firstReal = (texts: string[]) => texts.findIndex((t) => t.trim() !== "All" && t.trim() !== "");
  const allOption = (texts: string[]) => texts.findIndex((t) => t.trim() === "All");

  // Every dropdown on the filter bar and the query param it MUST drive.
  // Contact and Deal Channel share one option list, so only the param name
  // can tell them apart — exactly the swap this phase exists to catch.
  const selects = [
    { label: "Division", testId: "select-division", param: "company" },
    { label: "Development", testId: "select-development", param: "development" },
    { label: "Cohort Quarter", testId: "select-cohort", param: "cohortQuarter" },
    { label: "Lead Source", testId: "select-lead-source", param: "leadSource" },
    { label: "Contact Channel", testId: "select-contact-channel", param: "contactChannel" },
    { label: "Deal Channel", testId: "select-deal-channel", param: "dealChannel" },
  ] as const;

  for (const s of selects) {
    const control = `${s.label} select → ?${s.param}`;
    let chosen: string | null = null;
    await wiringStep(page, hits, {
      control,
      action: async () => {
        chosen = await pickOption(page, control, s.testId, firstReal, 'an option besides "All"');
        return chosen != null;
      },
      expected: () => (chosen == null ? null : { ...BASE, [s.param]: chosen }),
      verifyRerender: true,
    });
    if (chosen != null) {
      // Return the control to "All" so each control is audited in isolation —
      // and the reset wiring is itself verified: a broken "All" sentinel
      // would leak e.g. company="__all__" into this request.
      await wiringStep(page, hits, {
        control: `${s.label} select reset → All`,
        action: async () =>
          (await pickOption(page, `${s.label} select reset → All`, s.testId, allOption, 'an "All" option')) !=
          null,
        expected: () => BASE,
        verifyRerender: false,
      });
    }
  }

  // Date range — each input is its own check, so a startDate↔endDate swap
  // names the offending input directly. Values stay inside the current year
  // (valid under the one-calendar-year range rule whenever the audit runs).
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const startPick = `${now.getFullYear()}-01-01`;
  const endPick = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  const fillDate = async (control: string, testId: string, value: string): Promise<boolean> => {
    const input = page.locator(`[data-testid="${testId}"]`);
    if ((await input.count()) === 0) {
      fail(`wiring · ${control}`, `date input [data-testid="${testId}"] not found on the page`);
      return false;
    }
    await input.fill(value);
    return true;
  };

  await wiringStep(page, hits, {
    control: "Start date input → ?startDate",
    action: () => fillDate("Start date input → ?startDate", "input-start-date", startPick),
    expected: () => ({ ...BASE, startDate: startPick }),
    verifyRerender: true,
  });
  await wiringStep(page, hits, {
    control: "End date input → ?endDate",
    action: () => fillDate("End date input → ?endDate", "input-end-date", endPick),
    expected: () => ({ ...BASE, startDate: startPick, endDate: endPick }),
    verifyRerender: true,
  });

  // Target selector — keeps the date range applied; exact-param matching
  // proves the button changed ONLY ?target.
  await wiringStep(page, hits, {
    control: "Target selector → ?target=proforma",
    action: async () => {
      const btn = page.locator('[data-testid="button-target-proforma"]');
      if ((await btn.count()) === 0) {
        fail(
          "wiring · Target selector → ?target=proforma",
          'button [data-testid="button-target-proforma"] not found on the page',
        );
        return false;
      }
      await btn.click();
      return true;
    },
    expected: () => ({ target: "proforma", startDate: startPick, endDate: endPick }),
    verifyRerender: true,
  });
}

/**
 * The request must carry EXACTLY the expected parameters, compared as a
 * multiset: an extra, missing, duplicated, renamed, or wrong-valued
 * parameter is wrong wiring, not a cosmetic difference.
 */
function paramProblems(actual: URLSearchParams, expected: Record<string, string>): string[] {
  const seen = new Map<string, string[]>();
  for (const [k, v] of actual.entries()) {
    seen.set(k, [...(seen.get(k) ?? []), v]);
  }
  const problems: string[] = [];
  for (const [k, vs] of seen) {
    if (!(k in expected)) {
      problems.push(`unexpected parameter ${k}=${JSON.stringify(vs.join(","))} — no control set this`);
    } else if (vs.length > 1) {
      problems.push(`parameter ${k} sent ${vs.length} times (${vs.map((v) => JSON.stringify(v)).join(", ")})`);
    } else if (vs[0] !== expected[k]) {
      problems.push(
        `parameter ${k} carries ${JSON.stringify(vs[0])} but the control chose ${JSON.stringify(expected[k])}`,
      );
    }
  }
  for (const [k, v] of Object.entries(expected)) {
    if (!seen.has(k)) problems.push(`missing parameter ${k} (should carry ${JSON.stringify(v)})`);
  }
  return problems;
}

const RETRY_WAIT_MS = 8_000; // covers the page's exponential retry backoff gaps

/** Set once phase 2 installs its route; null during phase 1. */
let armOverviewHold: (() => OverviewHold) | null = null;
