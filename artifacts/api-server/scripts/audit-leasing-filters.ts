/**
 * Filter-dropdown audit for the Leasing dashboard.
 *
 * The Leasing page's filter dropdowns come from
 * GET /api/dashboards/leasing/filters (getLeasingFilterOptions in
 * src/lib/leasing.ts, cached as "rlFilterOptions"): communities — a UNION of
 * communities with RL deals (DM_DEALS) and communities with RL goals
 * (DM_GOALS) — and channels. The number audits never touch that endpoint —
 * audit-leasing.ts picks its filter values straight from Snowflake — so one
 * of its three queries breaking or starting to return an empty list (renamed
 * column, over-restrictive WHERE) would silently strip Leasing users of
 * filtering while every number check keeps passing. This audit closes that
 * gap, mirroring audit-filters.ts (Overview).
 *
 * Checks, in order:
 *  1. The endpoint answers 200 with a well-formed payload: both lists
 *     present as arrays, every entry a non-blank string. Transport hiccups
 *     and transient 5xx are retried by the shared fetch helper; a persistent
 *     error or malformed body fails the audit.
 *  2. NO list is empty — an empty list renders a dead dropdown.
 *  3. Data-agreement spot-checks, each picked from Snowflake and required to
 *     appear in its dropdown list:
 *       - the busiest deal community and busiest channel by ratified RL
 *         leases over a recent window — the same busiest-value convention
 *         audit-leasing.ts uses to pick its filtered scenarios;
 *       - the goal-heaviest DM_GOALS development, PREFERRING one with no RL
 *         deals at all. This pins the DM_GOALS leg of the communities union:
 *         losing that leg harms users exactly when a goals-but-no-deals
 *         development exists (otherwise the union degenerates to the deal
 *         communities anyway), so preferring such a development makes the
 *         check fail precisely when the shipped list is wrong.
 *     A pick query returning no value FAILS the audit rather than skipping
 *     the check — a silently skipped spot-check is not coverage.
 *
 * Every pick RESTATES the endpoint's own predicates verbatim (RL pipeline
 * name, TRIM + ''/'(No Value)' community junk filters, RL\_% goal-type
 * pattern, NOT-NULL filters) over a bounded window, so each pick is a strict
 * subset of the corresponding dropdown query by construction — a fresh
 * endpoint response can never legitimately miss a picked value. The
 * predicates are deliberately restated rather than imported from the API's
 * data layer: an accidental change to the endpoint's WHERE (the exact bug
 * class this audit hunts) must diverge loudly from the picks instead of
 * silently moving them along with it. Update both together when the
 * endpoint's contract intentionally changes.
 *
 * The pick windows deliberately end STALENESS_GUARD_DAYS before today: the
 * endpoint may serve its response from the shared SWR cache (stale kept up
 * to 24h), so a value whose FIRST activity is more recent than the cached
 * compute could be legitimately absent when AUDIT_API_BASE points at a
 * long-running server. Deal picks bound LEASE_RATIFIED_DATE to the shifted
 * window; the goal pick bounds BUDGET_DATE the same way (DM_GOALS is a
 * bulk-loaded budget table with no insert timestamp, so a development whose
 * only goal rows are future-dated is the most plausible fresh arrival — the
 * bound excludes exactly those). audit:all boots a fresh private server
 * anyway, where the response is never stale. If a spot-check fails against
 * a long-running server, restart it (or re-run via audit:all) before
 * treating the failure as real.
 *
 * Run from artifacts/api-server (API server must be running):
 *   pnpm run audit:leasing-filters
 *
 * Env:
 *   AUDIT_API_BASE  base URL of the API (default http://localhost:$PORT/api,
 *                   falling back to port 8080)
 *
 * Exits 0 when every check passes, 1 otherwise.
 */

import { querySnowflake as rawQuerySnowflake } from "../src/lib/snowflake";
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
 * Trailing window the busiest deal community/channel are picked from. Long
 * enough to always contain ratified-lease activity, short enough that picks
 * reflect the current business (same convention as audit-filters.ts).
 */
const PICK_WINDOW_DAYS = 90;

/** Same RL pipeline literal the endpoint hardcodes (src/lib/leasing.ts). */
const RL_PIPELINE = "Rhodes Living Pipeline";

// The Snowflake proxy rate-limits per repl (~10 RPS), shared with the API
// server this audit queries. The pick queries run through a small
// serializing queue so they never burst; transient failures (429s, dropped
// connections) are retried with backoff inside the shared Snowflake helper.
let queue: Promise<unknown> = Promise.resolve();
function querySnowflake<T>(sql: string, binds?: (string | number)[]): Promise<T[]> {
  const run = (): Promise<T[]> => rawQuerySnowflake<T>(sql, binds);
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
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
    fail(
      `"${key}" is ${value === undefined ? "missing from the response" : "not an array"} — the Leasing page would crash or render a dead dropdown`,
    );
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
      `"${key}" is EMPTY — Leasing users silently lose that filter. Likely a renamed column or over-restrictive WHERE in getLeasingFilterOptions (src/lib/leasing.ts)`,
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
  evidence: (p: Pick) => string,
  pickEmptyMsg: string,
  missingCause: string,
): void {
  if (pick === null) {
    fail(pickEmptyMsg);
    return;
  }
  if (list === null) return;
  if (!list.includes(pick.value)) {
    fail(
      `${what} ${JSON.stringify(pick.value)} (${evidence(pick)}) is MISSING from the "${listName}" dropdown (${list.length} entries: ${preview(list)}) — ${missingCause}; if auditing a long-running server, a >24h-stale cache can also cause this`,
    );
    return;
  }
  ok(`${what} ${JSON.stringify(pick.value)} (${evidence(pick)}) appears in "${listName}"`);
}

// ---------- Main ----------

async function main() {
  const url = `${API_BASE}/dashboards/leasing/filters`;
  console.log(`Auditing Leasing filter dropdowns: GET ${url}`);

  // Endpoint reachable + parseable. Transient transport errors and 5xx are
  // retried inside fetchJsonWithRetry; whatever still throws here is a real
  // endpoint failure and must fail the audit (handled by main().catch).
  const response = (await fetchJsonWithRetry<unknown>(url)) as Record<string, unknown>;
  if (response === null || typeof response !== "object" || Array.isArray(response)) {
    throw new Error(
      `filters endpoint returned a non-object payload: ${JSON.stringify(response).slice(0, 200)}`,
    );
  }

  console.log("\nShape and non-emptiness:");
  const communities = checkStringList(response, "communities");
  const channels = checkStringList(response, "channels");

  // Data-agreement spot-checks: values picked over the staleness-proof
  // bounded windows must each appear in their dropdown list.
  const end = shiftDays(todayChicago(), -STALENESS_GUARD_DAYS);
  const start = shiftDays(end, -PICK_WINDOW_DAYS);
  console.log(
    `\nData-agreement spot-checks (deal picks: busiest by ratified leases in ${start}..${end}; ` +
      `goal pick: heaviest RL goal development with BUDGET_DATE <= ${end}, preferring one with no deals):`,
  );

  // All predicates below deliberately restate getLeasingFilterOptions
  // (src/lib/leasing.ts) — see the header comment for why they are not
  // imported. Deal picks additionally bound LEASE_RATIFIED_DATE, the goal
  // pick BUDGET_DATE, making each a strict subset of its dropdown query.
  const [dealCommunityPick, channelPick, goalCommunityPick] = await Promise.all([
    pickBusiest(
      `SELECT TRIM(RL_COMMUNITY_OF_INTEREST_HUBSPOT_DEAL) AS V, COUNT(*) AS N
       FROM DM_DEALS
       WHERE PIPELINE_NAME = '${RL_PIPELINE}'
         AND LEASE_RATIFIED_DATE BETWEEN ? AND ?
         AND RL_COMMUNITY_OF_INTEREST_HUBSPOT_DEAL IS NOT NULL
         AND TRIM(RL_COMMUNITY_OF_INTEREST_HUBSPOT_DEAL) NOT IN ('', '(No Value)')
       GROUP BY 1 ORDER BY N DESC LIMIT 1`,
      [start, end],
    ),
    pickBusiest(
      `SELECT DEAL_ONSITE_ONLINE_SOURCE_CHANNEL AS V, COUNT(*) AS N
       FROM DM_DEALS
       WHERE PIPELINE_NAME = '${RL_PIPELINE}'
         AND LEASE_RATIFIED_DATE BETWEEN ? AND ?
         AND DEAL_ONSITE_ONLINE_SOURCE_CHANNEL IS NOT NULL
       GROUP BY 1 ORDER BY N DESC LIMIT 1`,
      [start, end],
    ),
    // Goals leg of the communities union. GOAL_ONLY ranks developments with
    // NO RL deals first (see header): when one exists, dropping the DM_GOALS
    // leg visibly breaks membership; when none exists, the fallback (overall
    // goal-heaviest) keeps the check non-vacuous. The DEAL_COMMUNITIES CTE
    // restates the endpoint's deal-communities predicates so "has no deals"
    // means exactly "would not be contributed by the deals leg".
    pickBusiest(
      `WITH DEAL_COMMUNITIES AS (
         SELECT DISTINCT TRIM(RL_COMMUNITY_OF_INTEREST_HUBSPOT_DEAL) AS C
         FROM DM_DEALS
         WHERE PIPELINE_NAME = '${RL_PIPELINE}'
           AND RL_COMMUNITY_OF_INTEREST_HUBSPOT_DEAL IS NOT NULL
           AND TRIM(RL_COMMUNITY_OF_INTEREST_HUBSPOT_DEAL) NOT IN ('', '(No Value)')
       )
       SELECT G.DEVELOPMENT_NAME AS V, ROUND(SUM(G.GOAL), 1) AS N,
              MAX(IFF(D.C IS NULL, 1, 0)) AS GOAL_ONLY
       FROM DM_GOALS G
       LEFT JOIN DEAL_COMMUNITIES D ON D.C = G.DEVELOPMENT_NAME
       WHERE G.GOAL_TYPE ILIKE 'RL\\_%' AND G.DEVELOPMENT_NAME IS NOT NULL
         AND G.BUDGET_DATE <= ?
       GROUP BY 1
       ORDER BY GOAL_ONLY DESC, N DESC
       LIMIT 1`,
      [end],
    ),
  ]);

  checkMembership(
    "busiest deal community",
    "communities",
    communities,
    dealCommunityPick,
    (p) => `${p.n} ratified leases in ${start}..${end}`,
    `no RL deal community found in Snowflake ${start}..${end} — cannot prove the "communities" dropdown agrees with the data (empty source data or broken pick query)`,
    `the deals leg of the communities union dropped a value with live leases (over-restrictive WHERE, wrong column, lost TRIM, or upstream relabel in getLeasingFilterOptions, src/lib/leasing.ts)`,
  );
  checkMembership(
    "busiest channel",
    "channels",
    channels,
    channelPick,
    (p) => `${p.n} ratified leases in ${start}..${end}`,
    `no RL deal channel found in Snowflake ${start}..${end} — cannot prove the "channels" dropdown agrees with the data (empty source data or broken pick query)`,
    `the channels query dropped a value with live leases (over-restrictive WHERE, wrong column, or upstream relabel in getLeasingFilterOptions, src/lib/leasing.ts)`,
  );
  checkMembership(
    "goals-leg community",
    "communities",
    communities,
    goalCommunityPick,
    (p) => `summed RL daily goal ${p.n} through ${end}`,
    `no RL goal development found in DM_GOALS with BUDGET_DATE <= ${end} — cannot prove the "communities" dropdown keeps its DM_GOALS union leg (empty source data or broken pick query; RL goals are known to exist)`,
    `the communities union lost its DM_GOALS leg or that leg's WHERE drifted (RL\\_% goal-type pattern, NULL filter, or the union itself in getLeasingFilterOptions, src/lib/leasing.ts) — developments with goals but no deals yet vanish from the filter exactly like this`,
  );

  if (failures.length > 0) {
    console.error(
      `\nAUDIT FAILED: ${failures.length} filter-dropdown check(s) failed. ` +
        "The Leasing filter dropdowns (GET /dashboards/leasing/filters) are " +
        "broken, empty, or disagree with the data the number audits validate against — " +
        "users would silently lose filtering. Check the three queries and the " +
        "communities union in getLeasingFilterOptions (src/lib/leasing.ts) for " +
        "renamed columns or over-restrictive WHEREs.",
    );
    process.exit(1);
  }
  console.log(
    "\nAudit passed: Leasing filters endpoint healthy — both dropdown lists non-empty " +
      "and well-formed, and every spot-check (busiest deal community, busiest channel, " +
      "goals-leg community) present in its dropdown.",
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("AUDIT ERRORED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
