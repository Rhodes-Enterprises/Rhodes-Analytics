/**
 * Leasing dashboard number regression audit.
 *
 * Compares the API's GET /api/dashboards/leasing response (kpis, goal
 * matrix, community summary, monthly series) against independent Snowflake
 * baseline queries with identical filters. Baselines are written directly
 * against DM_DEALS ('Rhodes Living Pipeline') and DM_GOALS (RL_* goal
 * types) using their own SQL — not the API's data layer — so a query or
 * aggregation change in the API that shifts the numbers fails the audit.
 *
 * Follows the same approach as audit-dashboard.ts (Overview with Targets):
 * - Besides the default (no query params) view, representative FILTERED
 *   requests are exercised — a community, a channel, and an explicit date
 *   range — with filter values picked dynamically from Snowflake (busiest
 *   in the default range). Missing values FAIL the audit rather than
 *   silently skipping a scenario.
 * - Every scenario independently computes the range the API must apply
 *   (requested dates, or the server's default calendar year) and asserts
 *   the response's appliedRange matches exactly, so an endpoint that
 *   ignores date parameters fails instead of being compared against its
 *   own wrong range. Baselines bind to the expected range, never to the
 *   response's echo of it.
 * - A PRIOR fiscal year scenario (the full previous calendar year)
 *   exercises the RL goal-type fallback: FY2025 only has RL_Leases, while
 *   FY2026+ uses RL_Leases_Ratified. The scenario resolves the goal type
 *   actually present for that year from Snowflake and FAILS LOUDLY when
 *   the prior year has no RL goal data at all — otherwise every goal
 *   check would compare 0 == 0 and pass while covering nothing.
 * - Chart-vs-table consistency (funnel trend): the Monthly Trends chart's
 *   per-stage series (web traffic, leads, first tours, move-ins) and the
 *   funnel totals table in the SAME response are fed by different queries,
 *   so every scenario also asserts, per stage, Σ monthly actuals ==
 *   funnel.<stage>.actual and Σ monthly goals == funnel.<stage>.fullSpanGoal
 *   (float tolerance only — both sides aggregate the same data, so the
 *   audit-wide percentage tolerance would mask real drift). Consistency-only
 *   channel variants guarantee BOTH Online and Onsite are exercised even
 *   though the baseline scenarios only visit the busiest channel.
 * - Channel label-drift guard (default view): the online/onsite lease
 *   baselines here hardcode the SAME 'Online'/'Onsite' literals the API
 *   keys its channel split on (DM_DEALS.DEAL_ONSITE_ONLINE_SOURCE_CHANNEL).
 *   If upstream data relabels the channel values (e.g. dbt renames 'Online'
 *   to 'Digital'), both sides compute 0, every per-cell check passes 0=0,
 *   and the dashboard ships zeroed online/onsite lease columns with no
 *   alarm. A materially non-zero ratified-lease baseline whose Online AND
 *   Onsite baselines are BOTH zero therefore FAILS, naming the channel
 *   column, the expected labels, and the labels actually present. Quiet
 *   windows (total below AUDIT_CHANNEL_GUARD_MIN_TOTAL) are exempt so day
 *   one of a year cannot false-positive. Mirrors the chLabels guard in
 *   audit-dashboard.ts.
 *
 * Run from artifacts/api-server (API server must be running):
 *   pnpm run audit:leasing
 *
 * Env:
 *   AUDIT_API_BASE       base URL of the API (default http://localhost:$PORT/api,
 *                        falling back to port 8080)
 *   AUDIT_TOLERANCE_PCT  allowed relative divergence in percent (default 0.5)
 *   AUDIT_CHANNEL_GUARD_MIN_TOTAL
 *                        minimum ratified-lease baseline count for the
 *                        channel label-drift guard to judge a window
 *                        (default 10, same knob as audit-dashboard.ts)
 *
 * Exits 0 when all values match within tolerance, 1 otherwise.
 */

import { querySnowflake as rawQuerySnowflake } from "../src/lib/snowflake";

/**
 * The Snowflake proxy rate-limits per repl (~10 RPS). The audit fires
 * bursts of parallel baseline queries, so serialize them through a small
 * queue with retry-on-429 backoff instead of failing the whole run.
 */
let queue: Promise<unknown> = Promise.resolve();
function querySnowflake<T>(sql: string, binds?: (string | number)[]): Promise<T[]> {
  const run = async (): Promise<T[]> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await rawQuerySnowflake<T>(sql, binds);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < 5 && (msg.includes("429") || msg.includes("Rate limit"))) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

const API_BASE =
  process.env.AUDIT_API_BASE ?? `http://localhost:${process.env.PORT ?? "8080"}/api`;
const TOLERANCE_PCT = Number(process.env.AUDIT_TOLERANCE_PCT ?? "0.5");

const CHANNEL_GUARD_MIN_TOTAL = Number(
  process.env.AUDIT_CHANNEL_GUARD_MIN_TOTAL ?? "10",
);

const RL_PIPELINE = "Rhodes Living Pipeline";

// ---------- Response shape (only the fields the audit checks) ----------

interface MatrixCell {
  fullSpanGoal: number;
  toDateGoal: number;
  actual: number;
  ptgPercent: number | null;
}

interface FunnelCell {
  fullSpanGoal: number;
  toDateGoal: number;
  actual: number;
}

interface CommunityRow {
  community: string;
  fullSpanGoal: number;
  toDateGoal: number;
  ratified: number;
  onlineRatified: number;
  onsiteRatified: number;
  cancelled: number;
  net: number;
}

interface MonthlyPoint {
  month: number;
  ratified: number;
  cancelled: number;
  net: number;
  goal: number;
  webTraffic: number;
  webTrafficGoal: number;
  leads: number;
  leadsGoal: number;
  firstTours: number;
  firstToursGoal: number;
  moveIns: number;
  moveInsGoal: number;
}

interface LeasingResponse {
  appliedRange: { startDate: string; endDate: string; toDate: string };
  fiscalYear: number;
  kpis: {
    leaseGoal: number;
    leaseTdGoal: number;
    leasesRatified: number;
    leasesCancelled: number;
    netLeases: number;
    ptgVariance: number;
  };
  funnel: {
    webTraffic: FunnelCell;
    leads: FunnelCell;
    firstTours: FunnelCell;
    moveIns: FunnelCell;
  };
  matrix: {
    total: MatrixCell;
    online: MatrixCell;
    onsite: MatrixCell;
    net: MatrixCell;
  };
  communities: CommunityRow[];
  monthly: MonthlyPoint[];
}

async function fetchLeasing(params: Record<string, string>): Promise<LeasingResponse> {
  const qs = new URLSearchParams(params).toString();
  const url = `${API_BASE}/dashboards/leasing${qs ? `?${qs}` : ""}`;
  // On a cold cache the API fires its own burst of Snowflake queries, which
  // can trip the per-repl rate limit and surface as a 502. Retry a few
  // times with backoff before failing the audit.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return (await res.json()) as LeasingResponse;
    const body = await res.text();
    if (attempt < 4 && res.status >= 500) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    throw new Error(`GET ${url} failed with HTTP ${res.status}: ${body}`);
  }
}

// ---------- Expected range computation (independent of the API) ----------

function todayChicago(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(
    new Date(),
  );
}

/** Default range the API applies with no date params: current calendar year. */
function defaultYearRange(): { startDate: string; endDate: string } {
  const year = todayChicago().slice(0, 4);
  return { startDate: `${year}-01-01`, endDate: `${year}-12-31` };
}

/** Elapsed cutoff: today clamped into [startDate, endDate]. */
function expectedToDate(startDate: string, endDate: string): string {
  const today = todayChicago();
  return today < startDate ? startDate : today > endDate ? endDate : today;
}

// ---------- Scenarios ----------

interface ScenarioFilters {
  community?: string;
  channel?: string;
  startDate?: string;
  endDate?: string;
}

interface Scenario {
  name: string;
  filters: ScenarioFilters;
  /**
   * Fail the scenario when its fiscal year resolves no RL total goal type
   * or the goals within the range sum to zero. Set on the prior-year
   * scenario, which exists to pin the goal-type fallback: without goal
   * data every goal check compares 0 == 0 and would pass while testing
   * nothing.
   */
  requireGoalData?: boolean;
  /**
   * Run ONLY the funnel trend-vs-totals consistency checks (no Snowflake
   * baselines). Used to cover the channel not visited by the baseline
   * scenarios without doubling the whole audit's query load.
   */
  consistencyOnly?: boolean;
  /**
   * Fail the funnel trend consistency check when every stage sums to zero
   * on both the actuals side and the goals side. Set on scenarios whose
   * data is known non-empty (default view, prior year): all-zero there
   * means the check verified nothing — e.g. the funnel and monthly queries
   * broke in unison or stage goal types silently resolved to none.
   */
  requireFunnelData?: boolean;
  /**
   * Run the channel label-drift guard: fail when the ratified-lease
   * baseline is materially non-zero but the Online AND Onsite baselines
   * are BOTH zero (see auditChannelLabels). Set on the default view.
   */
  withChannelLabelGuard?: boolean;
}

function toQueryParams(f: ScenarioFilters): Record<string, string> {
  const params: Record<string, string> = {};
  if (f.community) params.community = f.community;
  if (f.channel) params.channel = f.channel;
  if (f.startDate) params.startDate = f.startDate;
  if (f.endDate) params.endDate = f.endDate;
  return params;
}

// ---------- Independent baselines ----------

async function countScalar(sql: string, binds: (string | number)[]): Promise<number> {
  const rows = await querySnowflake<{ N: number }>(sql, binds);
  return Number(rows[0]?.N) || 0;
}

/** Deal-count baseline over a date column, honoring community/channel filters. */
async function baselineDealCount(
  dateCol: "LEASE_RATIFIED_DATE" | "CANCELLATION_DATE",
  startDate: string,
  toDate: string,
  f: ScenarioFilters,
  channelOverride?: string,
): Promise<number> {
  const binds: (string | number)[] = [startDate, toDate];
  const parts: string[] = [];
  if (f.community) {
    parts.push("TRIM(RL_COMMUNITY_OF_INTEREST_HUBSPOT_DEAL) = ?");
    binds.push(f.community);
  }
  const channel = channelOverride ?? f.channel;
  if (channel) {
    parts.push("DEAL_ONSITE_ONLINE_SOURCE_CHANNEL = ?");
    binds.push(channel);
  }
  const extra = parts.length ? ` AND ${parts.join(" AND ")}` : "";
  return countScalar(
    `SELECT COUNT(*) AS N FROM DM_DEALS
     WHERE PIPELINE_NAME = '${RL_PIPELINE}' AND ${dateCol} BETWEEN ? AND ?${extra}`,
    binds,
  );
}

/**
 * Resolve RL lease goal types independently of the API, per the documented
 * data model: FY2026+ uses RL_Leases_Ratified (+ Online/Onsite splits);
 * FY2025 only had RL_Leases as the total.
 */
async function resolveGoalTypes(fiscalYear: number): Promise<{
  total?: string;
  online?: string;
  onsite?: string;
}> {
  const rows = await querySnowflake<{ GOAL_TYPE: string }>(
    "SELECT DISTINCT GOAL_TYPE FROM DM_GOALS WHERE FISCAL_YEAR = ? AND GOAL_TYPE ILIKE 'RL\\_%'",
    [fiscalYear],
  );
  const set = new Set(rows.map((r) => r.GOAL_TYPE));
  const first = (...cands: string[]) => cands.find((c) => set.has(c));
  return {
    total: first("RL_Leases_Ratified", "RL_Leases"),
    online: first("RL_Online_Leases_Ratified"),
    onsite: first("RL_Onsite_Leases_Ratified"),
  };
}

/** Goal sums (full span + to-date) for one goal type, honoring community filter. */
async function baselineGoal(
  goalType: string | undefined,
  fiscalYear: number,
  startDate: string,
  endDate: string,
  toDate: string,
  community?: string,
): Promise<{ fullSpan: number; toDate: number }> {
  if (!goalType) return { fullSpan: 0, toDate: 0 };
  const binds: (string | number)[] = [toDate, fiscalYear, goalType, startDate, endDate];
  let extra = "";
  if (community) {
    extra = " AND DEVELOPMENT_NAME = ?";
    binds.push(community);
  }
  const rows = await querySnowflake<{ FULL_SPAN: number; TO_DATE: number }>(
    `SELECT SUM(GOAL) AS FULL_SPAN, SUM(IFF(BUDGET_DATE <= ?, GOAL, 0)) AS TO_DATE
     FROM DM_GOALS
     WHERE FISCAL_YEAR = ? AND GOAL_TYPE = ? AND BUDGET_DATE BETWEEN ? AND ?${extra}`,
    binds,
  );
  return {
    fullSpan: Number(rows[0]?.FULL_SPAN) || 0,
    toDate: Number(rows[0]?.TO_DATE) || 0,
  };
}

// ---------- Comparison helpers ----------

let failures = 0;

function close(a: number, b: number): boolean {
  if (a === b) return true;
  const denom = Math.max(Math.abs(a), Math.abs(b));
  if (denom === 0) return true;
  return (Math.abs(a - b) / denom) * 100 <= TOLERANCE_PCT;
}

function check(label: string, apiValue: number, baseline: number): void {
  if (close(apiValue, baseline)) {
    console.log(`  OK   ${label}: api=${apiValue} baseline=${baseline}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}: api=${apiValue} baseline=${baseline}`);
  }
}

/**
 * Float-precision comparison for consistency checks BETWEEN two fields of
 * the same API response. Unlike close(), no percentage tolerance applies:
 * both sides aggregate identical underlying data, so anything beyond
 * accumulated floating-point rounding (goals are daily-distributed
 * fractions summed in different groupings) is real drift. NaN — e.g. a
 * renamed or missing response field — never passes.
 */
function closeFloat(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= 1e-6 + Math.max(Math.abs(a), Math.abs(b)) * 1e-9;
}

function checkFloat(label: string, chartValue: number, tableValue: number): void {
  if (closeFloat(chartValue, tableValue)) {
    console.log(`  OK   ${label}: chart=${chartValue} table=${tableValue}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}: chart=${chartValue} table=${tableValue}`);
  }
}

// ---------- Scenario execution ----------

async function auditScenario(scenario: Scenario): Promise<void> {
  const f = scenario.filters;
  console.log(`\n=== Scenario: ${scenario.name} ===`);
  const params = toQueryParams(f);
  console.log(
    `Params: ${Object.keys(params).length ? JSON.stringify(params) : "(none — default view)"}`,
  );

  const defaults = defaultYearRange();
  const expStart = f.startDate ?? defaults.startDate;
  const expEnd = f.endDate ?? defaults.endDate;
  const expTo = expectedToDate(expStart, expEnd);

  const resp = await fetchLeasing(params);
  const ar = resp.appliedRange;
  console.log(`Applied range: ${ar.startDate}..${ar.endDate}, toDate=${ar.toDate}`);
  if (ar.startDate !== expStart || ar.endDate !== expEnd || ar.toDate !== expTo) {
    failures++;
    console.error(
      `  FAIL appliedRange mismatch: expected ${expStart}..${expEnd} (toDate=${expTo}), ` +
        `got ${ar.startDate}..${ar.endDate} (toDate=${ar.toDate}) — the API did not honor the requested/default dates`,
    );
    return; // baselines against a wrong range would be meaningless
  }

  if (scenario.consistencyOnly) {
    console.log("-- funnel trend vs totals (consistency-only variant)");
    auditFunnelTrend(resp, scenario);
    return;
  }

  const fiscalYear = Number(expStart.slice(0, 4));
  if (resp.fiscalYear !== fiscalYear) {
    failures++;
    console.error(`  FAIL fiscalYear: api=${resp.fiscalYear} expected=${fiscalYear}`);
  }

  const gt = await resolveGoalTypes(fiscalYear);
  console.log(
    `Resolved goal types (FY${fiscalYear}): total=${gt.total ?? "(none)"}, ` +
      `online=${gt.online ?? "(none)"}, onsite=${gt.onsite ?? "(none)"}`,
  );

  // Channel-scoped goal semantics (documented dashboard behavior): when a
  // channel filter is applied, "total"/"net" compare against that channel's
  // goal and the opposite channel has no target.
  const effGoalType = (metric: "total" | "online" | "onsite"): string | undefined => {
    if (f.channel === "Online") return metric === "onsite" ? undefined : gt.online;
    if (f.channel === "Onsite") return metric === "online" ? undefined : gt.onsite;
    return gt[metric];
  };

  // ---- Actual counts (bound to the expected range) ----
  const [ratified, cancelled, onlineRatified, onsiteRatified] = await Promise.all([
    baselineDealCount("LEASE_RATIFIED_DATE", expStart, expTo, f),
    baselineDealCount("CANCELLATION_DATE", expStart, expTo, f),
    f.channel && f.channel !== "Online"
      ? Promise.resolve(0)
      : baselineDealCount("LEASE_RATIFIED_DATE", expStart, expTo, f, "Online"),
    f.channel && f.channel !== "Onsite"
      ? Promise.resolve(0)
      : baselineDealCount("LEASE_RATIFIED_DATE", expStart, expTo, f, "Onsite"),
  ]);

  // ---- Goals ----
  const [gTotal, gOnline, gOnsite] = await Promise.all([
    baselineGoal(effGoalType("total"), fiscalYear, expStart, expEnd, expTo, f.community),
    baselineGoal(effGoalType("online"), fiscalYear, expStart, expEnd, expTo, f.community),
    baselineGoal(effGoalType("onsite"), fiscalYear, expStart, expEnd, expTo, f.community),
  ]);

  // Scenarios that exist to pin goal behavior (the prior-year fallback)
  // must not "pass" by comparing zeros against zeros.
  if (scenario.requireGoalData && (!gt.total || gTotal.fullSpan === 0)) {
    failures++;
    console.error(
      `  FAIL no RL goal data for FY${fiscalYear}: total goal type=` +
        `${gt.total ?? "(none)"}, full-span goal sum=${gTotal.fullSpan} — ` +
        "this scenario pins the prior-year goal fallback, so empty goal data " +
        "means the fallback is NOT being tested (goals missing from DM_GOALS, " +
        "or the audit's prior-year selection needs updating)",
    );
  }

  // ---- KPIs ----
  console.log("-- kpis");
  check("kpis.leaseGoal", resp.kpis.leaseGoal, gTotal.fullSpan);
  check("kpis.leaseTdGoal", resp.kpis.leaseTdGoal, gTotal.toDate);
  check("kpis.leasesRatified", resp.kpis.leasesRatified, ratified);
  check("kpis.leasesCancelled", resp.kpis.leasesCancelled, cancelled);
  check("kpis.netLeases", resp.kpis.netLeases, ratified - cancelled);
  check("kpis.ptgVariance", resp.kpis.ptgVariance, ratified - gTotal.toDate);

  // ---- Goal matrix ----
  console.log("-- matrix");
  const checkCell = (
    name: string,
    cell: MatrixCell,
    goal: { fullSpan: number; toDate: number },
    actual: number,
  ) => {
    check(`matrix.${name}.fullSpanGoal`, cell.fullSpanGoal, goal.fullSpan);
    check(`matrix.${name}.toDateGoal`, cell.toDateGoal, goal.toDate);
    check(`matrix.${name}.actual`, cell.actual, actual);
  };
  checkCell("total", resp.matrix.total, gTotal, ratified);
  checkCell("online", resp.matrix.online, gOnline, onlineRatified);
  checkCell("onsite", resp.matrix.onsite, gOnsite, onsiteRatified);
  checkCell("net", resp.matrix.net, gTotal, ratified - cancelled);

  // ---- Channel label-drift guard ----
  if (scenario.withChannelLabelGuard) {
    console.log("-- channel label-drift guard");
    await auditChannelLabels(ratified, onlineRatified, onsiteRatified, expStart, expTo, f);
  }

  // ---- Community summary ----
  console.log("-- communities");
  await auditCommunities(resp, f, fiscalYear, expStart, expEnd, expTo, effGoalType("total"));

  // ---- Monthly series ----
  console.log("-- monthly");
  await auditMonthly(resp, f, fiscalYear, expStart, expEnd, expTo, effGoalType("total"));

  // ---- Funnel trend vs totals (chart-vs-table consistency) ----
  console.log("-- funnel trend vs totals");
  auditFunnelTrend(resp, scenario);
}

/**
 * Channel label-drift guard (mirrors the chLabels guard in
 * audit-dashboard.ts).
 *
 * The online/onsite baselines and the API's channel split hardcode the
 * same 'Online'/'Onsite' literals (r.CHANNEL === "Online"/"Onsite" in
 * src/lib/leasing.ts; the baselineDealCount / dealByCommunity channel
 * overrides here). If upstream data relabels the channel values in
 * DM_DEALS.DEAL_ONSITE_ONLINE_SOURCE_CHANNEL (e.g. dbt renames 'Online' to
 * 'Digital'), BOTH sides compute 0, every per-cell check passes 0=0, and
 * the leasing dashboard ships zeroed online/onsite lease columns with no
 * alarm. A materially non-zero ratified-lease baseline whose two channel
 * baselines are BOTH zero is that signature: unlabeled rows legitimately
 * make online + onsite < total, but at volume they never take both to
 * exactly zero. Totals below CHANNEL_GUARD_MIN_TOTAL are treated as too
 * quiet to judge (e.g. day one of a year) and cannot false-positive.
 */
async function auditChannelLabels(
  total: number,
  online: number,
  onsite: number,
  startDate: string,
  toDate: string,
  f: ScenarioFilters,
): Promise<void> {
  const name = "chLabels:ratified";
  if (total < CHANNEL_GUARD_MIN_TOTAL) {
    console.log(
      `  OK   ${name}: total=${total} < ${CHANNEL_GUARD_MIN_TOTAL} — window too quiet to judge label drift`,
    );
    return;
  }
  if (online > 0 || onsite > 0) {
    console.log(
      `  OK   ${name}: 'Online'/'Onsite' labels present (online=${online} onsite=${onsite} of ${total})`,
    );
    return;
  }
  // Fetch the labels actually present so the failure names the fix.
  const binds: (string | number)[] = [startDate, toDate];
  let extra = "";
  if (f.community) {
    extra = " AND TRIM(RL_COMMUNITY_OF_INTEREST_HUBSPOT_DEAL) = ?";
    binds.push(f.community);
  }
  const labelRows = await querySnowflake<{ LABEL: string; N: number }>(
    `SELECT COALESCE(DEAL_ONSITE_ONLINE_SOURCE_CHANNEL, '(null)') AS LABEL, COUNT(*) AS N
     FROM DM_DEALS
     WHERE PIPELINE_NAME = '${RL_PIPELINE}' AND LEASE_RATIFIED_DATE BETWEEN ? AND ?${extra}
     GROUP BY 1 ORDER BY N DESC`,
    binds,
  );
  const present =
    labelRows.map((r) => `'${r.LABEL}' (${Number(r.N) || 0})`).join(", ") || "(no rows)";
  failures++;
  console.error(
    `  FAIL ${name}: ${total} ratified leases in ${startDate}..${toDate} but ZERO match ` +
      `'Online' and ZERO match 'Onsite' on DM_DEALS.DEAL_ONSITE_ONLINE_SOURCE_CHANNEL — ` +
      `the expected channel labels are missing from the data; labels present: ${present}. ` +
      `The leasing dashboard's channel split AND this audit's baselines both hardcode ` +
      `'Online'/'Onsite' (r.CHANNEL === ... in src/lib/leasing.ts; baselineDealCount/` +
      `dealByCommunity here), so every online/onsite lease cell reads 0 and the per-cell ` +
      `checks pass 0=0. If upstream renamed the channel values, update those literals to ` +
      `the new labels.`,
  );
}

/**
 * Community summary baseline: one grouped query per source, then row-by-row
 * comparison against the response. The union of communities (goals ∪
 * ratified ∪ cancelled, excluding "(No Value)") must match exactly — a
 * missing or extra community row is a failure, not just a value mismatch.
 */
async function auditCommunities(
  resp: LeasingResponse,
  f: ScenarioFilters,
  fiscalYear: number,
  startDate: string,
  endDate: string,
  toDate: string,
  totalGoalType: string | undefined,
): Promise<void> {
  const dealBinds = (extraChannel?: string) => {
    const binds: (string | number)[] = [startDate, toDate];
    const parts: string[] = [];
    if (f.community) {
      parts.push("TRIM(RL_COMMUNITY_OF_INTEREST_HUBSPOT_DEAL) = ?");
      binds.push(f.community);
    }
    const channel = extraChannel ?? f.channel;
    if (channel) {
      parts.push("DEAL_ONSITE_ONLINE_SOURCE_CHANNEL = ?");
      binds.push(channel);
    }
    return { extra: parts.length ? ` AND ${parts.join(" AND ")}` : "", binds };
  };

  const dealByCommunity = async (
    dateCol: string,
    channel?: string,
  ): Promise<Map<string, number>> => {
    if (channel && f.channel && f.channel !== channel) return new Map();
    const { extra, binds } = dealBinds(channel);
    const rows = await querySnowflake<{ C: string | null; N: number }>(
      `SELECT TRIM(RL_COMMUNITY_OF_INTEREST_HUBSPOT_DEAL) AS C, COUNT(*) AS N
       FROM DM_DEALS
       WHERE PIPELINE_NAME = '${RL_PIPELINE}' AND ${dateCol} BETWEEN ? AND ?${extra}
       GROUP BY 1`,
      binds,
    );
    return new Map(rows.filter((r) => r.C).map((r) => [r.C as string, Number(r.N) || 0]));
  };

  const goalByCommunity = async (): Promise<
    Map<string, { fullSpan: number; toDate: number }>
  > => {
    if (!totalGoalType) return new Map();
    const binds: (string | number)[] = [toDate, fiscalYear, totalGoalType, startDate, endDate];
    let extra = "";
    if (f.community) {
      extra = " AND DEVELOPMENT_NAME = ?";
      binds.push(f.community);
    }
    const rows = await querySnowflake<{
      C: string | null;
      FULL_SPAN: number;
      TO_DATE: number;
    }>(
      `SELECT DEVELOPMENT_NAME AS C, SUM(GOAL) AS FULL_SPAN,
              SUM(IFF(BUDGET_DATE <= ?, GOAL, 0)) AS TO_DATE
       FROM DM_GOALS
       WHERE FISCAL_YEAR = ? AND GOAL_TYPE = ? AND BUDGET_DATE BETWEEN ? AND ?${extra}
       GROUP BY 1`,
      binds,
    );
    return new Map(
      rows
        .filter((r) => r.C)
        .map((r) => [
          r.C as string,
          { fullSpan: Number(r.FULL_SPAN) || 0, toDate: Number(r.TO_DATE) || 0 },
        ]),
    );
  };

  const [bRat, bCan, bOnline, bOnsite, bGoals] = await Promise.all([
    dealByCommunity("LEASE_RATIFIED_DATE"),
    dealByCommunity("CANCELLATION_DATE"),
    dealByCommunity("LEASE_RATIFIED_DATE", "Online"),
    dealByCommunity("LEASE_RATIFIED_DATE", "Onsite"),
    goalByCommunity(),
  ]);

  const expected = new Set<string>([...bRat.keys(), ...bCan.keys(), ...bGoals.keys()]);
  expected.delete("(No Value)");

  const apiByName = new Map(resp.communities.map((c) => [c.community, c]));
  const expectedNames = [...expected].sort();
  const apiNames = resp.communities.map((c) => c.community).sort();
  if (JSON.stringify(expectedNames) !== JSON.stringify(apiNames)) {
    failures++;
    const missing = expectedNames.filter((n) => !apiByName.has(n));
    const extra = apiNames.filter((n) => !expected.has(n));
    console.error(
      `  FAIL community set mismatch — missing from API: [${missing.join(", ")}], unexpected in API: [${extra.join(", ")}]`,
    );
  } else {
    console.log(`  OK   community set (${expectedNames.length} communities)`);
  }

  for (const name of expectedNames) {
    const row = apiByName.get(name);
    if (!row) continue; // already reported by the set check
    const rat = bRat.get(name) ?? 0;
    const can = bCan.get(name) ?? 0;
    const goal = bGoals.get(name) ?? { fullSpan: 0, toDate: 0 };
    check(`community[${name}].ratified`, row.ratified, rat);
    check(`community[${name}].onlineRatified`, row.onlineRatified, bOnline.get(name) ?? 0);
    check(`community[${name}].onsiteRatified`, row.onsiteRatified, bOnsite.get(name) ?? 0);
    check(`community[${name}].cancelled`, row.cancelled, can);
    check(`community[${name}].net`, row.net, rat - can);
    check(`community[${name}].fullSpanGoal`, row.fullSpanGoal, goal.fullSpan);
    check(`community[${name}].toDateGoal`, row.toDateGoal, goal.toDate);
  }
}

/** Monthly series baseline: actuals over start..toDate, goals over start..end. */
async function auditMonthly(
  resp: LeasingResponse,
  f: ScenarioFilters,
  fiscalYear: number,
  startDate: string,
  endDate: string,
  toDate: string,
  trendGoalType: string | undefined,
): Promise<void> {
  const monthly = async (dateCol: string): Promise<Map<number, number>> => {
    const binds: (string | number)[] = [startDate, toDate];
    const parts: string[] = [];
    if (f.community) {
      parts.push("TRIM(RL_COMMUNITY_OF_INTEREST_HUBSPOT_DEAL) = ?");
      binds.push(f.community);
    }
    if (f.channel) {
      parts.push("DEAL_ONSITE_ONLINE_SOURCE_CHANNEL = ?");
      binds.push(f.channel);
    }
    const extra = parts.length ? ` AND ${parts.join(" AND ")}` : "";
    const rows = await querySnowflake<{ M: number; N: number }>(
      `SELECT MONTH(${dateCol}) AS M, COUNT(*) AS N
       FROM DM_DEALS
       WHERE PIPELINE_NAME = '${RL_PIPELINE}' AND ${dateCol} BETWEEN ? AND ?${extra}
       GROUP BY 1`,
      binds,
    );
    return new Map(rows.map((r) => [Number(r.M), Number(r.N) || 0]));
  };

  const monthlyGoal = async (): Promise<Map<number, number>> => {
    if (!trendGoalType) return new Map();
    const binds: (string | number)[] = [fiscalYear, trendGoalType, startDate, endDate];
    let extra = "";
    if (f.community) {
      extra = " AND DEVELOPMENT_NAME = ?";
      binds.push(f.community);
    }
    const rows = await querySnowflake<{ M: number; N: number }>(
      `SELECT MONTH(BUDGET_DATE) AS M, SUM(GOAL) AS N
       FROM DM_GOALS
       WHERE FISCAL_YEAR = ? AND GOAL_TYPE = ? AND BUDGET_DATE BETWEEN ? AND ?${extra}
       GROUP BY 1`,
      binds,
    );
    return new Map(rows.map((r) => [Number(r.M), Number(r.N) || 0]));
  };

  const [mRat, mCan, mGoal] = await Promise.all([
    monthly("LEASE_RATIFIED_DATE"),
    monthly("CANCELLATION_DATE"),
    monthlyGoal(),
  ]);

  if (resp.monthly.length !== 12) {
    failures++;
    console.error(`  FAIL monthly series length: api=${resp.monthly.length} expected=12`);
    return;
  }
  for (const point of resp.monthly) {
    const m = point.month;
    const rat = mRat.get(m) ?? 0;
    const can = mCan.get(m) ?? 0;
    check(`monthly[${m}].ratified`, point.ratified, rat);
    check(`monthly[${m}].cancelled`, point.cancelled, can);
    check(`monthly[${m}].net`, point.net, rat - can);
    check(`monthly[${m}].goal`, point.goal, mGoal.get(m) ?? 0);
  }
}

// ---------- Funnel trend vs totals (chart-vs-table consistency) ----------

const TREND_STAGES = [
  { stage: "webTraffic", actualField: "webTraffic", goalField: "webTrafficGoal" },
  { stage: "leads", actualField: "leads", goalField: "leadsGoal" },
  { stage: "firstTours", actualField: "firstTours", goalField: "firstToursGoal" },
  { stage: "moveIns", actualField: "moveIns", goalField: "moveInsGoal" },
] as const;

/**
 * The Monthly Trends chart's per-stage series and the funnel totals table
 * shown on the same page are fed by DIFFERENT queries (fetchMonthlyTraffic /
 * fetchMonthlyContactStage / fetchMonthlyGoals vs fetchTrafficCount /
 * fetchContactStageCounts / fetchGoals). Nothing upstream forces them to
 * agree, so assert within the SAME response, per stage:
 *   Σ monthly actuals == funnel.<stage>.actual       (both cover start..toDate)
 *   Σ monthly goals   == funnel.<stage>.fullSpanGoal (both cover start..endDate)
 * A missing monthly field or funnel cell fails loudly: Number(undefined) is
 * NaN, and NaN never passes checkFloat.
 */
function auditFunnelTrend(resp: LeasingResponse, scenario: Scenario): void {
  if (!resp.funnel || !Array.isArray(resp.monthly)) {
    failures++;
    console.error(
      "  FAIL response is missing the funnel totals or the monthly series — " +
        "the chart-vs-table consistency check cannot run",
    );
    return;
  }
  const sumField = (field: keyof MonthlyPoint): number =>
    resp.monthly.reduce((t, p) => t + Number(p[field]), 0);

  let maxActual = 0;
  let maxGoal = 0;
  for (const { stage, actualField, goalField } of TREND_STAGES) {
    const cell = resp.funnel[stage];
    if (!cell) {
      failures++;
      console.error(`  FAIL funnel.${stage} missing from the response`);
      continue;
    }
    const actualSum = sumField(actualField);
    const goalSum = sumField(goalField);
    const tableActual = Number(cell.actual);
    const tableGoal = Number(cell.fullSpanGoal);
    checkFloat(
      `trend[${stage}] Σ monthly.${actualField} vs funnel.${stage}.actual`,
      actualSum,
      tableActual,
    );
    checkFloat(
      `trend[${stage}] Σ monthly.${goalField} vs funnel.${stage}.fullSpanGoal`,
      goalSum,
      tableGoal,
    );
    maxActual = Math.max(maxActual, Math.abs(actualSum), Math.abs(tableActual) || 0);
    maxGoal = Math.max(maxGoal, Math.abs(goalSum), Math.abs(tableGoal) || 0);
  }

  // All-zero on both sides of every stage would "pass" while proving
  // nothing. On scenarios whose data is known non-empty (default view and
  // the prior year: FY2025 has web sessions, leads, and RL_Leads/RL_Tours
  // goals), that outcome means the funnel and monthly queries broke in
  // unison or the stage goal types silently resolved to none — fail loudly.
  if (scenario.requireFunnelData) {
    if (maxActual === 0) {
      failures++;
      console.error(
        "  FAIL every funnel stage has zero actuals on both the chart and " +
          "table sides — this scenario's data is known non-empty, so the " +
          "consistency check verified nothing (funnel/monthly actual " +
          "queries both empty or both broken)",
      );
    }
    if (maxGoal === 0) {
      failures++;
      console.error(
        "  FAIL every funnel stage has zero goals on both the chart and " +
          "table sides — this fiscal year has RL stage goals in DM_GOALS " +
          "(FY2025: RL_Leads/RL_Tours; FY2026+: all stages), so the stage " +
          "goal-type resolution is silently matching nothing",
      );
    }
  }
}

// ---------- Representative filter selection ----------

/**
 * Pick the community and channel with the most ratified RL leases in the
 * default range so the filtered scenarios always exercise non-trivial data.
 * Missing values make the audit FAIL — a silently skipped scenario is not
 * coverage.
 */
async function pickRepresentativeFilters(
  startDate: string,
  toDate: string,
): Promise<{ community: string; channel: string }> {
  const [communityRows, channelRows] = await Promise.all([
    querySnowflake<{ C: string }>(
      `SELECT TRIM(RL_COMMUNITY_OF_INTEREST_HUBSPOT_DEAL) AS C, COUNT(*) AS N
       FROM DM_DEALS
       WHERE PIPELINE_NAME = '${RL_PIPELINE}'
         AND LEASE_RATIFIED_DATE BETWEEN ? AND ?
         AND RL_COMMUNITY_OF_INTEREST_HUBSPOT_DEAL IS NOT NULL
         AND TRIM(RL_COMMUNITY_OF_INTEREST_HUBSPOT_DEAL) NOT IN ('', '(No Value)')
       GROUP BY 1 ORDER BY N DESC LIMIT 1`,
      [startDate, toDate],
    ),
    querySnowflake<{ CH: string }>(
      `SELECT DEAL_ONSITE_ONLINE_SOURCE_CHANNEL AS CH, COUNT(*) AS N
       FROM DM_DEALS
       WHERE PIPELINE_NAME = '${RL_PIPELINE}'
         AND LEASE_RATIFIED_DATE BETWEEN ? AND ?
         AND DEAL_ONSITE_ONLINE_SOURCE_CHANNEL IS NOT NULL
       GROUP BY 1 ORDER BY N DESC LIMIT 1`,
      [startDate, toDate],
    ),
  ]);
  const community = communityRows[0]?.C;
  const channel = channelRows[0]?.CH;
  const missing = [!community && "community", !channel && "channel"].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `No representative ${missing.join(", ")} found in ${startDate}..${toDate} — ` +
        "cannot exercise the required filtered scenarios (empty source data or broken filters)",
    );
  }
  return { community: community!, channel: channel! };
}

/**
 * Explicit date-range scenario: January of the default year when it has
 * fully elapsed (stable results), otherwise a deterministic single-day
 * range on January 1st. Both differ from the default full-year bounds, so
 * an endpoint that ignores date params fails the appliedRange assertion.
 */
function explicitRangeScenario(defaultStart: string): Scenario {
  const year = defaultStart.slice(0, 4);
  const jan31 = `${year}-01-31`;
  if (todayChicago() > jan31) {
    return {
      name: "explicit date range (January)",
      filters: { startDate: `${year}-01-01`, endDate: jan31 },
    };
  }
  return {
    name: `explicit date range (single day ${defaultStart})`,
    filters: { startDate: defaultStart, endDate: defaultStart },
  };
}

async function main() {
  console.log(`Auditing ${API_BASE}/dashboards/leasing (tolerance ${TOLERANCE_PCT}%)`);

  const { startDate, endDate } = defaultYearRange();
  const toDate = expectedToDate(startDate, endDate);
  console.log(`Default range: ${startDate}..${endDate}, toDate=${toDate}`);

  const { community, channel } = await pickRepresentativeFilters(startDate, toDate);

  const priorYear = Number(startDate.slice(0, 4)) - 1;
  const scenarios: Scenario[] = [
    {
      name: "default view",
      filters: {},
      requireFunnelData: true,
      withChannelLabelGuard: true,
    },
    { name: `community filter (${community})`, filters: { community } },
    { name: `channel filter (${channel})`, filters: { channel } },
    explicitRangeScenario(startDate),
    {
      name: `prior fiscal year (${priorYear}) — RL goal-type fallback`,
      filters: {
        startDate: `${priorYear}-01-01`,
        endDate: `${priorYear}-12-31`,
      },
      requireGoalData: true,
      requireFunnelData: true,
    },
  ];

  // The funnel trend-vs-totals net must cover BOTH channels: a channel
  // filter swaps in per-channel stage goal types (RL_Online_Leads, ...), so
  // a regression can hit one channel only. The baseline scenarios visit
  // just the busiest channel — add consistency-only variants for the rest.
  for (const ch of ["Online", "Onsite"]) {
    if (!scenarios.some((s) => s.filters.channel === ch)) {
      scenarios.push({
        name: `channel filter (${ch}) — funnel trend consistency only`,
        filters: { channel: ch },
        consistencyOnly: true,
      });
    }
  }
  console.log(`Scenarios: ${scenarios.map((s) => s.name).join("; ")}`);

  for (const scenario of scenarios) {
    await auditScenario(scenario);
  }

  if (failures > 0) {
    console.error(
      `\nAUDIT FAILED: ${failures} check(s) diverge from independent Snowflake ` +
        "baselines or internal consistency. Likely causes: a filter bound to " +
        "the wrong column, missing TRIM on community, wrong goal-type " +
        "resolution, ignored date parameters, stale cached data, relabeled " +
        "channel values (see any chLabels failure above), or the monthly " +
        "trend queries drifting from the funnel totals queries.",
    );
    process.exit(1);
  }
  console.log("\nAudit passed: all values match independent baselines across all scenarios.");
  process.exit(0);
}

main().catch((err) => {
  console.error("AUDIT ERRORED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
