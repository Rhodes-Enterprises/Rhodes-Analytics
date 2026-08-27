/**
 * Filter-dropdown audit for the Overview dashboard.
 *
 * The dashboard's filter dropdowns come from
 * GET /api/dashboards/overview-with-targets/filters (getFilterOptions in
 * src/lib/overview-targets.ts): companies, developments, cohort quarters,
 * lead sources, channels. The number audits never touch that endpoint —
 * they pick their filter values straight from Snowflake — so one of its
 * five queries breaking or starting to return an empty list (renamed
 * column, over-restrictive WHERE) would silently strip users of filtering
 * while every number check keeps passing. This audit closes that gap.
 *
 * Checks, in order:
 *  1. The endpoint answers 200 with a well-formed payload: all five lists
 *     present as arrays, every entry a non-blank string (developments:
 *     objects with non-blank company + development). Transport hiccups and
 *     transient 5xx are retried by the shared fetch helper; a persistent
 *     error or malformed body fails the audit.
 *  2. NO list is empty — an empty list renders a dead dropdown.
 *  3. Internal consistency: every development row's company appears in the
 *     companies list. Both lists are computed together from the same table
 *     and WHERE and cached as one payload, so a mismatch means one of the
 *     two queries drifted from the other.
 *  4. Data-agreement spot-checks: the busiest company, (company,
 *     development) pair, channel, lead source, and contact cohort quarter
 *     are picked from Snowflake over a recent activity window — the same
 *     busiest-value convention the number audits use for their filtered
 *     scenarios — and each MUST appear in its dropdown list. This proves
 *     the endpoint and the data the audits validate agree: a dropdown
 *     query whose WHERE quietly over-restricts (dropping a value that has
 *     live traffic) fails here even though its list is non-empty. A pick
 *     query returning no value FAILS the audit rather than skipping the
 *     check — a silently skipped spot-check is not coverage.
 *
 * Every spot-check pick is a strict subset of the corresponding dropdown
 * query by construction — the picks reuse the dropdown's own predicates
 * (shared isLeadSql / DEV_DIM modules, so the definitions cannot drift)
 * over a bounded date window: leads ⊂ all contacts, DEV_DIM rows ⊂ the raw
 * esperanza-filtered dimension rows. A fresh endpoint response therefore
 * can never legitimately miss a picked value.
 *
 * The pick window deliberately ends STALENESS_GUARD_DAYS before today: the
 * endpoint may serve its response from the shared SWR cache (stale kept up
 * to 24h), so a value whose FIRST activity is more recent than the cached
 * compute could be legitimately absent when AUDIT_API_BASE points at a
 * long-running server. Ending the window before any possible cache-write
 * time removes that false-positive class; audit:all boots a fresh private
 * server anyway, where the response is never stale. If a spot-check fails
 * against a long-running server, restart it (or re-run via audit:all)
 * before treating the failure as real.
 *
 * Run from artifacts/api-server (API server must be running):
 *   pnpm run audit:filters
 *
 * Env:
 *   AUDIT_API_BASE  base URL of the API (default http://localhost:$PORT/api,
 *                   falling back to port 8080)
 *
 * Exits 0 when every check passes, 1 otherwise.
 */

import { querySnowflake as rawQuerySnowflake } from "../src/lib/snowflake";
import { DEV_DIM } from "../src/lib/dev-dim";
import { isLeadSql } from "../src/lib/business-defs";
import { fetchJsonWithRetry } from "./lib/fetch-retry";

const API_BASE =
  process.env.AUDIT_API_BASE ?? `http://localhost:${process.env.PORT ?? "8080"}/api`;

/**
 * The endpoint's SWR cache serves entries stale for up to 24h (keepMs in
 * src/lib/query-cache.ts). Two whole days clears any possible cache-write
 * time plus timezone edges, so a picked value was ALWAYS present in the
 * source data before the cached response could have been computed.
 */
const STALENESS_GUARD_DAYS = 2;

/**
 * Trailing window the busiest values are picked from. Long enough to always
 * contain lead activity (a quarter-bound window would be empty on day one
 * of a quarter), short enough that picks reflect the current business.
 */
const PICK_WINDOW_DAYS = 90;

// The Snowflake proxy rate-limits per repl (~10 RPS), shared with the API
// server this audit queries. The five pick queries run through a small
// serializing queue so they never burst; transient failures (429s, dropped
// connections) are retried with backoff inside the shared Snowflake helper.
let queue: Promise<unknown> = Promise.resolve();
function querySnowflake<T>(sql: string, binds?: (string | number)[]): Promise<T[]> {
  const run = (): Promise<T[]> => rawQuerySnowflake<T>(sql, binds);
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

// ---------- Response shape ----------

interface FilterOptionsResponse {
  companies: string[];
  developments: { company: string; development: string }[];
  cohortQuarters: string[];
  leadSources: string[];
  channels: string[];
}

// ---------- Date helpers (same business-day convention as the API) ----------

function todayChicago(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(
    new Date(),
  );
}

/** Whole-day arithmetic on a YYYY-MM-DD string (UTC-anchored, no TZ drift). */
function shiftDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------- Reporting ----------

const failures: string[] = [];
function fail(msg: string): void {
  failures.push(msg);
  console.error(`  FAIL: ${msg}`);
}
function ok(msg: string): void {
  console.log(`  ok: ${msg}`);
}

function isNonBlankString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/** First few entries, for failure messages that need to show what IS there. */
function preview(values: string[], max = 5): string {
  const shown = values.slice(0, max).map((v) => JSON.stringify(v));
  const rest = values.length - shown.length;
  return `[${shown.join(", ")}${rest > 0 ? `, … +${rest} more` : ""}]`;
}

/**
 * Validate one string-valued dropdown list: present, an array, non-empty,
 * every entry a non-blank string. Returns the list when it is usable for
 * the later membership checks, null when it already failed.
 */
function checkStringList(response: Record<string, unknown>, key: string): string[] | null {
  const value = response[key];
  if (!Array.isArray(value)) {
    fail(`"${key}" is ${value === undefined ? "missing from the response" : "not an array"} — the dashboard would crash or render a dead dropdown`);
    return null;
  }
  const bad = value.findIndex((v) => !isNonBlankString(v));
  if (bad !== -1) {
    fail(
      `"${key}"[${bad}] is not a non-blank string (got ${JSON.stringify(value[bad])}) — malformed entries render as blank dropdown options`,
    );
    return null;
  }
  if (value.length === 0) {
    fail(
      `"${key}" is EMPTY — users silently lose that filter. Likely a renamed column or over-restrictive WHERE in getFilterOptions (src/lib/overview-targets.ts)`,
    );
    return null;
  }
  ok(`"${key}" has ${value.length} non-blank entries`);
  return value as string[];
}

// ---------- Spot-check picks ----------

interface Pick {
  value: string;
  n: number;
}

async function pickBusiest(sql: string, binds: (string | number)[]): Promise<Pick | null> {
  const rows = await querySnowflake<{ V: string; N: number }>(sql, binds);
  const value = rows[0]?.V;
  if (!isNonBlankString(value)) return null;
  return { value, n: Number(rows[0]!.N) || 0 };
}

/**
 * Assert a picked value appears in its dropdown list. `list` is null when
 * the list already failed validation — the missing membership evidence is
 * already covered by that failure, so don't stack a second one.
 */
function checkMembership(
  what: string,
  listName: string,
  list: string[] | null,
  pick: Pick | null,
  window: { start: string; end: string },
): void {
  if (pick === null) {
    fail(
      `no ${what} found in Snowflake ${window.start}..${window.end} — cannot prove the "${listName}" dropdown agrees with the data (empty source data or broken pick query)`,
    );
    return;
  }
  if (list === null) return;
  if (!list.includes(pick.value)) {
    fail(
      `busiest ${what} ${JSON.stringify(pick.value)} (${pick.n} leads in ${window.start}..${window.end}) is MISSING from the "${listName}" dropdown (${list.length} entries: ${preview(list)}) — the dropdown query dropped a value with live traffic (over-restrictive WHERE, wrong column, or upstream relabel); if auditing a long-running server, a >24h-stale cache can also cause this`,
    );
    return;
  }
  ok(`busiest ${what} ${JSON.stringify(pick.value)} (${pick.n} leads) appears in "${listName}"`);
}

// ---------- Main ----------

async function main() {
  const url = `${API_BASE}/dashboards/overview-with-targets/filters`;
  console.log(`Auditing filter dropdowns: GET ${url}`);

  // Endpoint reachable + parseable. Transient transport errors and 5xx are
  // retried inside fetchJsonWithRetry; whatever still throws here is a real
  // endpoint failure and must fail the audit (handled by main().catch).
  const response = (await fetchJsonWithRetry<unknown>(url)) as Record<string, unknown>;
  if (response === null || typeof response !== "object" || Array.isArray(response)) {
    throw new Error(`filters endpoint returned a non-object payload: ${JSON.stringify(response).slice(0, 200)}`);
  }

  console.log("\nShape and non-emptiness:");
  const companies = checkStringList(response, "companies");
  const cohortQuarters = checkStringList(response, "cohortQuarters");
  const leadSources = checkStringList(response, "leadSources");
  const channels = checkStringList(response, "channels");

  // developments carries {company, development} objects, validated apart.
  let developments: FilterOptionsResponse["developments"] | null = null;
  {
    const value = response["developments"];
    if (!Array.isArray(value)) {
      fail(`"developments" is ${value === undefined ? "missing from the response" : "not an array"} — the dashboard would crash or render a dead dropdown`);
    } else {
      const bad = value.findIndex(
        (v) =>
          v === null ||
          typeof v !== "object" ||
          !isNonBlankString((v as Record<string, unknown>).company) ||
          !isNonBlankString((v as Record<string, unknown>).development),
      );
      if (bad !== -1) {
        fail(
          `"developments"[${bad}] is not a {company, development} pair of non-blank strings (got ${JSON.stringify(value[bad]).slice(0, 120)})`,
        );
      } else if (value.length === 0) {
        fail(
          `"developments" is EMPTY — users silently lose that filter. Likely a renamed column or over-restrictive WHERE in getFilterOptions (src/lib/overview-targets.ts)`,
        );
      } else {
        ok(`"developments" has ${value.length} non-blank {company, development} pairs`);
        developments = value as FilterOptionsResponse["developments"];
      }
    }
  }

  // Internal consistency: the companies and developments lists come from the
  // same table + WHERE in one cached payload, so every development's company
  // must appear in the companies dropdown — a mismatch means one of the two
  // queries drifted from the other.
  if (companies !== null && developments !== null) {
    const companySet = new Set(companies);
    const orphaned = [...new Set(developments.map((d) => d.company))].filter(
      (c) => !companySet.has(c),
    );
    if (orphaned.length > 0) {
      fail(
        `"developments" references ${orphaned.length} company value(s) absent from "companies": ${preview(orphaned)} — the two queries share one WHERE and must agree`,
      );
    } else {
      ok(`every "developments" company appears in "companies"`);
    }
  }

  // Data-agreement spot-checks: busiest values over the staleness-proof
  // trailing window must each appear in their dropdown list.
  const end = shiftDays(todayChicago(), -STALENESS_GUARD_DAYS);
  const start = shiftDays(end, -PICK_WINDOW_DAYS);
  const window = { start, end };
  const binds = [start, end];
  console.log(
    `\nData-agreement spot-checks (busiest values in ${start}..${end}, picked from Snowflake):`,
  );

  const [companyPick, devPairPick, channelPick, leadSourcePick, cohortPick] =
    await Promise.all([
      pickBusiest(
        `SELECT D.COMPANY_NAME AS V, COUNT(*) AS N
         FROM DM_CONTACTS C
         JOIN ${DEV_DIM} D ON C.CONTACT_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
         WHERE ${isLeadSql("C")} AND C.CONTACT_CREATE_DATE BETWEEN ? AND ?
         GROUP BY 1 ORDER BY N DESC LIMIT 1`,
        binds,
      ),
      // Pair pick: DEV_DIM rows are raw DM_COMPANY_DEVELOPMENT rows (deduped,
      // esperanza-filtered), so the busiest (company, development) pair must
      // appear verbatim among the dropdown's pairs.
      querySnowflake<{ C_NAME: string; D_NAME: string; N: number }>(
        `SELECT D.COMPANY_NAME AS C_NAME, D.DEVELOPMENT_NAME AS D_NAME, COUNT(*) AS N
         FROM DM_CONTACTS C
         JOIN ${DEV_DIM} D ON C.CONTACT_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
         WHERE ${isLeadSql("C")} AND C.CONTACT_CREATE_DATE BETWEEN ? AND ?
         GROUP BY 1, 2 ORDER BY N DESC LIMIT 1`,
        binds,
      ),
      pickBusiest(
        `SELECT C.ONSITE_ONLINE_SOURCE_CHANNEL AS V, COUNT(*) AS N
         FROM DM_CONTACTS C
         WHERE ${isLeadSql("C")} AND C.CONTACT_CREATE_DATE BETWEEN ? AND ?
           AND C.ONSITE_ONLINE_SOURCE_CHANNEL IS NOT NULL
         GROUP BY 1 ORDER BY N DESC LIMIT 1`,
        binds,
      ),
      pickBusiest(
        `SELECT C.LEAD_SOURCE_OVERVIEW AS V, COUNT(*) AS N
         FROM DM_CONTACTS C
         WHERE ${isLeadSql("C")} AND C.CONTACT_CREATE_DATE BETWEEN ? AND ?
           AND C.LEAD_SOURCE_OVERVIEW IS NOT NULL
         GROUP BY 1 ORDER BY N DESC LIMIT 1`,
        binds,
      ),
      pickBusiest(
        `SELECT C.EHI_COHORT_QUARTER AS V, COUNT(*) AS N
         FROM DM_CONTACTS C
         WHERE ${isLeadSql("C")} AND C.CONTACT_CREATE_DATE BETWEEN ? AND ?
           AND C.EHI_COHORT_QUARTER IS NOT NULL
         GROUP BY 1 ORDER BY N DESC LIMIT 1`,
        binds,
      ),
    ]);

  checkMembership("company", "companies", companies, companyPick, window);
  checkMembership("channel", "channels", channels, channelPick, window);
  checkMembership("lead source", "leadSources", leadSources, leadSourcePick, window);
  checkMembership("cohort quarter", "cohortQuarters", cohortQuarters, cohortPick, window);

  // (company, development) pair membership — checked against the pair list,
  // not just the development names, so a development attributed to the wrong
  // company in the dropdown fails too.
  {
    const row = devPairPick[0];
    if (!row || !isNonBlankString(row.C_NAME) || !isNonBlankString(row.D_NAME)) {
      fail(
        `no (company, development) lead activity found in Snowflake ${start}..${end} — cannot prove the "developments" dropdown agrees with the data (empty source data or broken pick query)`,
      );
    } else if (developments !== null) {
      const n = Number(row.N) || 0;
      const hit = developments.some(
        (d) => d.company === row.C_NAME && d.development === row.D_NAME,
      );
      if (!hit) {
        fail(
          `busiest development pair ${JSON.stringify(row.C_NAME)} / ${JSON.stringify(row.D_NAME)} (${n} leads in ${start}..${end}) is MISSING from the "developments" dropdown (${developments.length} pairs) — the dropdown query dropped a value with live traffic (over-restrictive WHERE, wrong column, or upstream relabel); if auditing a long-running server, a >24h-stale cache can also cause this`,
        );
      } else {
        ok(
          `busiest development pair ${JSON.stringify(row.C_NAME)} / ${JSON.stringify(row.D_NAME)} (${n} leads) appears in "developments"`,
        );
      }
    }
  }

  if (failures.length > 0) {
    console.error(
      `\nAUDIT FAILED: ${failures.length} filter-dropdown check(s) failed. ` +
        "The Overview filter dropdowns (GET /dashboards/overview-with-targets/filters) are " +
        "broken, empty, or disagree with the data the number audits validate against — " +
        "users would silently lose filtering. Check the five queries in getFilterOptions " +
        "(src/lib/overview-targets.ts) for renamed columns or over-restrictive WHEREs.",
    );
    process.exit(1);
  }
  console.log(
    "\nAudit passed: filters endpoint healthy — all five dropdown lists non-empty and " +
      "well-formed, developments consistent with companies, and every busiest-value " +
      "spot-check present in its dropdown.",
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("AUDIT ERRORED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
