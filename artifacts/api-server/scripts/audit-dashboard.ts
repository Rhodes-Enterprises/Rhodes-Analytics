/**
 * Dashboard number regression audit.
 *
 * Compares the API's GET /api/dashboards/overview-with-targets response
 * against independent Snowflake baseline queries with identical filters.
 * The baselines deliberately avoid the DM_COMPANY_DEVELOPMENT attribution
 * join used by the API's data layer — a fan-out in that join once inflated
 * actuals ~1.5x, which is exactly the regression class this audit exists to
 * catch. Where a company filter needs the dimension, the baseline uses a
 * semi-join (IN subquery) that cannot fan out by construction.
 *
 * Besides the default (no query params) view, the audit exercises
 * representative FILTERED requests — a company, a development, a channel,
 * a lead source, a contact cohort quarter, and an explicit date range —
 * because filter-only regressions (a filter bound to the wrong column, a
 * fan-out that triggers only for specific developments) would otherwise
 * slip through. Filter values are picked dynamically from Snowflake
 * (busiest in the current default range) so they don't go stale; failure
 * to find a non-empty value FAILS the audit rather than silently skipping
 * the scenario.
 *
 * Two scenarios bind COMBINED filters (company + lead source; development +
 * channel + explicit dates) because users stack filters in the UI, and a
 * bug that only appears when fragments compose — the company semi-join
 * interacting with a lead-source predicate, binds appended in the wrong
 * order — would pass every single-filter scenario and still ship wrong
 * numbers. Combination values are picked NESTED (the busiest lead source
 * inside the picked company, the busiest channel inside the picked
 * development), so the combined slice has leads by construction:
 * independently busy picks could intersect to zero rows everywhere, and an
 * all-0-vs-0 scenario would be vacuous coverage, not a safety net.
 *
 * Baseline filter semantics deliberately mirror the API's asymmetry:
 * leadSource filters both contacts (LEAD_SOURCE_OVERVIEW) and deals
 * (DEAL_LEAD_SOURCE_OVERVIEW), while cohortQuarter filters contacts only —
 * so under a cohortQuarter filter the sales baseline stays unfiltered, and
 * neither filter ever touches the GA (website users) baselines. A baseline
 * bound differently from the API's own filter semantics would report fake
 * divergence, so the fragments below must track overview-targets.ts.
 *
 * The divisions/developments breakdown tables are audited (auditBreakdowns)
 * in the default view AND under the company, lead-source, and cohort-quarter
 * filters and the explicit date range, with baselines bound to the same
 * filters — so a filter-specific attribution bug (e.g. a company filter
 * that leaks other divisions' rows into the breakdown) fails the audit
 * instead of slipping through.
 *
 * Every scenario independently computes the range it expects the API to
 * apply (requested dates, or the server's default quarter) and asserts the
 * response's appliedRange matches it exactly — so an endpoint that ignores
 * date parameters fails the audit instead of being compared against its own
 * wrong range. Baselines are bound to that expected range, never to the
 * response's echo of it.
 *
 * Headline totals are checked in every scenario: leads, tours, gross sales,
 * total website users, and NEW website users (trafficMatrix.newWebsiteUsers).
 * The two user counts come from the API's overall () grouping-set row —
 * picked via G_COMPANY=1 — which can regress independently of the per-row
 * values, so both get their own GA baseline aggregates (one scan computes
 * both).
 *
 * The nine channel-split cells (trafficMatrix.online/onsite/unknown ×
 * leads, tours, sales) are audited in every scenario too, each against a
 * baseline that re-counts the same source rows restricted on the channel
 * column the dashboard keys on (ONSITE_ONLINE_SOURCE_CHANNEL for contacts,
 * DEAL_ONSITE_ONLINE_SOURCE_CHANNEL for deals): the literal 'Online' /
 * 'Onsite' labels for those cells, and rows carrying NEITHER label
 * ('Unknown', NULL, or any other value) for the dashboard's unknown bucket.
 * A regression that keys the split off the wrong column or swaps the labels
 * leaves every audited total unchanged, so only these per-cell checks can
 * catch it. The unknown cells are recounted from source rows exactly like
 * the labeled ones — the API deliberately never derives them as
 * total − online − onsite — so there is still NO sum-to-total assumption
 * anywhere: per-cell baselines only.
 *
 * Because those baselines key on the SAME shared channel-label constants
 * the API uses (CHANNEL_ONLINE / CHANNEL_ONSITE in src/lib/business-defs.ts,
 * so the two sides cannot drift apart in code), they share its blind spot:
 * if the upstream data relabels the channel values (e.g. dbt renames 'Online' to 'Digital'), both sides
 * compute 0 and every per-cell check passes 0=0 while the dashboard ships a
 * zeroed online/onsite section. The default view therefore runs a channel
 * label-drift guard: a materially non-zero headline baseline whose Online
 * AND Onsite baselines are BOTH zero fails the audit, naming the channel
 * column, the expected labels, and the labels actually present in the data.
 * Quiet windows (total below AUDIT_CHANNEL_GUARD_MIN_TOTAL, e.g. day one of
 * a quarter) are exempt so they cannot false-positive.
 *
 * Two scenarios additionally pin the API's TARGET resolution (the goal-type
 * walk-back that picks the latest goal_<metric>_q<N> re-issue <= the range's
 * elapsed cutoff, excluding old_* renames and RL_* rental variants):
 * - A PRIOR fiscal year scenario (the full previous calendar year). Years
 *   before FY2026 carry no goal_* regime in DM_GOALS (only legacy display
 *   names like 'Gross Sales'), so as long as the prior year predates the
 *   regime the scenario pins strict fiscal isolation — every target cell
 *   (KPI + all traffic-matrix goal columns, online/onsite included) must
 *   be EXACTLY zero, anything else means goals leaked in from another
 *   fiscal year or goal type. From January 2027 (FY2026 becomes the prior
 *   year) it automatically upgrades to pinning real target values.
 * - The latest fully-elapsed quarter of the current year (skipped with a
 *   note during Q1), whose cutoff sits in a PAST quarter — the walk-back
 *   must resolve THAT quarter's re-issue, not the newest one, so a change
 *   that ignores the as-of date or stops excluding old_* re-issues fails.
 * When a pinned scenario's year DOES carry the goal_* regime, empty goal
 * sums FAIL loudly (mirroring audit-leasing's requireGoalData check) instead
 * of letting every target check pass on meaningless 0-vs-0 comparisons.
 *
 * The website-user metrics share the same blind-spot class through the GA
 * property: the API's GA queries and this audit's GA baselines both
 * filter on the shared GA_PROPERTY_NAME constant in src/lib/business-defs.ts
 * (the Leasing pages hardcode 'Rhodes Living'), so an upstream property
 * rename zeroes both sides and
 * every user-count check passes 0=0 while the dashboard ships zeroed
 * traffic numbers. The default view therefore also runs the shared GA
 * property label-drift guard (ga-property-guard.ts, also run by
 * audit-yoy.ts): GA rows existing in the range with ZERO matching an
 * expected PROPERTY value fail the audit, naming the column, the missing
 * value, and the property values actually present. Quiet windows (total
 * GA users across all properties below AUDIT_GA_PROPERTY_GUARD_MIN_TOTAL)
 * are exempt so they cannot false-positive.
 *
 * One layer deeper, the NEW-users columns key on IS_NEW_USER = 'Yes' on
 * both sides (and the Leasing pages key their web traffic on
 * IS_SESSION_START = 'Yes' the same way), so an upstream relabel of the
 * Yes/No values ('Yes' -> 'TRUE'/'true'/1) would zero those columns while
 * the total-users columns stayed correct — every check passing 0=0 with
 * nothing visibly wrong on screen. The default view therefore also runs
 * the shared GA Yes/No flag label-drift guard (same module, also run by
 * audit-leasing.ts): a property's GA rows existing in the range with ZERO
 * carrying an expected flag value fail the audit, naming the flag column
 * and the values actually present. Properties below
 * AUDIT_GA_FLAG_GUARD_MIN_TOTAL distinct users in the range are exempt the
 * same way.
 *
 * That exemption leaves one hole: if the GA export DIES outright (zero rows
 * loaded for days or weeks), the traffic numbers shrink toward zero and
 * every check still passes — 0=0 comparisons, or the quiet-window
 * exemptions themselves. GA data normally lags about a week behind today,
 * so "rows exist today" can never be the test; the default view therefore
 * also runs the shared GA freshness guard (auditGaFreshness in
 * ga-property-guard.ts, once per audit pass): it fails when the newest
 * GOOGLE_ANALYTICS_DATE loaded — overall, or for any expected property —
 * falls more than AUDIT_GA_MAX_LAG_DAYS days behind today (default 14,
 * comfortably above the normal ~7-8 day load lag), reporting the max date
 * found per property.
 *
 * Goal-derived numbers are checked in every scenario too (auditGoals): the
 * KPI row's salesGoal / salesTdGoal, each traffic-matrix cell's
 * fullSpanGoal / toDateGoal, and the PTG figures derived from them. The
 * baseline re-resolves the expected GOAL_TYPE per metric from live DISTINCT
 * GOAL_TYPE values (expectedGoalType — a deliberate re-implementation of
 * the API's resolveGoalType, since importing it would mask its regressions)
 * and recomputes both sums as two plain BUDGET_DATE windows (start..end and
 * start..toDate) instead of the API's SUM(IFF(BUDGET_DATE <= toDate, ...)).
 * Goals respond to company/development filters (DM_GOALS columns), must
 * IGNORE channel filters, and rebind their window and quarter resolution to
 * explicit date ranges — so each scenario exercises a distinct goal
 * regression class.
 *
 * The breakdown tables (divisions / developments) are audited per row: leads,
 * tours, and sales — and each row's unlabeled-channel counts (unknownLeads/
 * unknownTours/unknownSales, rows with no Online/Onsite label) — against
 * CRM-side baselines, and the website-user columns
 * against GA-side baselines recomputed with plain GROUP BYs over
 * MATCHED_COMPANY_NAME / MATCHED_DEVELOPMENT_NAME — catching regressions in
 * the API's single GROUPING SETS query that the headline checks would miss.
 * Distinct-user counts are not additive across rows, so website users get
 * per-row comparisons only, never a sum-to-headline cross-check.
 *
 * The funnel ratios table is audited on the default view: every ratio's
 * actual is recomputed from independent baseline counts (the same no-fan-out
 * query shapes as the headline checks, split by channel where a ratio calls
 * for it), and every ratio's goal is looked up directly in
 * DM_MARKETING_DASHBOARD_INPUT_GOAL_RATIOS by MARKETING_GOAL_NAME_RATIOS.
 * A swapped numerator/denominator, a ratio wired to the wrong actual, a
 * goal name that no longer resolves in the input table, or an input-table
 * goal row the dashboard silently drops all fail the audit.
 *
 * The Community List (GET /api/dashboards/communities) is audited against the
 * raw DM_COMPANY_DEVELOPMENT rows plus plain YTD GROUP BYs: total/selling/
 * hasGoals/isRental counts, per-community flag comparison (the intended
 * per-development semantics are recomputed in JS, not by reusing the API's
 * QUALIFY dedup), the isSelling invariant over the API's own YTD numbers, and
 * a label-domain guard on the flag columns — 'Has Goals'/'Rental' are text
 * labels, not booleans, so a silent upstream relabel would zero every badge
 * on both sides and still "match" without that guard. Each row's displayed
 * leadsYtd/toursYtd/salesYtd values are also compared against those
 * independent no-join baselines, inside a window that tolerates the
 * endpoint's per-Chicago-day cache lagging today's activity — so a broken join
 * in the endpoint's L/T/S CTEs fails the audit even when zero-vs-nonzero
 * selling status survives.
 *
 * Run from artifacts/api-server (API server must be running):
 *   pnpm run audit:dashboard
 *
 * Env:
 *   AUDIT_API_BASE       base URL of the API (default http://localhost:$PORT/api,
 *                        falling back to port 8080)
 *   AUDIT_TOLERANCE_PCT  allowed relative divergence in percent (default 0.5)
 *   AUDIT_CHANNEL_GUARD_MIN_TOTAL
 *                        minimum headline baseline count for the channel
 *                        label-drift guard to judge a metric (default 10)
 *   AUDIT_GA_PROPERTY_GUARD_MIN_TOTAL
 *                        minimum total GA users (across all properties) for
 *                        the GA property label-drift guard to judge the
 *                        window (default 10)
 *   AUDIT_GA_FLAG_GUARD_MIN_TOTAL
 *                        minimum GA users on a flag's own property for the
 *                        GA Yes/No flag guard to judge the window
 *                        (default 10)
 *   AUDIT_GA_MAX_LAG_DAYS
 *                        maximum days MAX(GOOGLE_ANALYTICS_DATE) may trail
 *                        today before the GA freshness guard fails the
 *                        audit (default 14; normal load lag is ~7-8 days)
 *   AUDIT_SF_CONCURRENCY max in-flight baseline Snowflake queries (default 1:
 *                        serialized, respecting the proxy's ~10 RPS limit)
 *   AUDIT_SF_MAX_ATTEMPTS
 *                        attempts per baseline query on transient Snowflake
 *                        errors (429/5xx/dropped connections), exponential
 *                        backoff between tries (default 5)
 *
 * Exits 0 when all totals match within tolerance, 1 otherwise.
 */

import { querySnowflake as querySnowflakeRaw } from "../src/lib/snowflake";
import { DEV_DIM } from "../src/lib/dev-dim";
import { auditGaFlagLabels, auditGaFreshness, auditGaPropertyLabels } from "./ga-property-guard";
import { fetchJsonWithRetry } from "./lib/fetch-retry";
import {
  CHANNEL_LABELS,
  CHANNEL_ONLINE,
  CHANNEL_ONSITE,
  isGaTrafficSql,
  isLeadSql,
  isSaleSql,
} from "../src/lib/business-defs";

// Default to the API server's own local port (same PORT contract the server
// uses; the artifact's configured port is 8080). Override with AUDIT_API_BASE.const API_BASE =
  process.env.AUDIT_API_BASE ?? `http://localhost:${process.env.PORT ?? "8080"}/api`;
const TOLERANCE_PCT = Number(process.env.AUDIT_TOLERANCE_PCT ?? "0.5");

// The Snowflake proxy enforces ~10 requests/second per REPL — a budget
// shared with the API server's own parallel query fan-out and anything
// else running in the workspace. Baselines are batched into grouped /
// conditional-aggregation queries (one scan per source instead of a
// scalar COUNT per cell) so round trips stay few, but bursts from this
// script's Promise.all batches have died mid-run with transient fetch
// failures / 502s, and even fully
// serialized queries can catch a 429 when the rest of the repl is busy —
// leaving later scenarios unexecuted, which is a false "safety net ran"
// signal. Two defenses, both scoped to this script's baseline queries:
//   1. a queue — call sites keep their Promise.all shape, but queries
//      execute serially by default (AUDIT_SF_CONCURRENCY raises the
//      in-flight cap when experimenting locally); audit correctness never
//      depends on ordering, only on binds;
//   2. bounded exponential backoff on TRANSIENT errors only (rate limits,
//      5xx, dropped connections). Real errors — SQL compilation, missing
//      grants — rethrow immediately: retrying those would only delay the
//      failure the audit exists to surface. The slot is held during
//      backoff so retries never widen the script's footprint.
const SF_CONCURRENCY = Math.max(1, Number(process.env.AUDIT_SF_CONCURRENCY ?? "1"));

const SF_MAX_ATTEMPTS = Math.max(1, Number(process.env.AUDIT_SF_MAX_ATTEMPTS ?? "5"));
const CHANNEL_GUARD_MIN_TOTAL = Number(
  process.env.AUDIT_CHANNEL_GUARD_MIN_TOTAL ?? "10",
);
interface DivisionRow {
  division: string;
  totalWebsiteUsers: number;
  newWebsiteUsers: number;
  leads: number;
  tours: number;
  sales: number;
  /** Per-row counts with no Online/Onsite channel label */
  unknownLeads: number;
  unknownTours: number;
  unknownSales: number;
}

interface DevelopmentRow {
  development: string;
  division: string;
  totalWebsiteUsers: number;
  newWebsiteUsers: number;
  leads: number;
  tours: number;
  sales: number;
  /** Per-row counts with no Online/Onsite channel label */
  unknownLeads: number;
  unknownTours: number;
  unknownSales: number;
}

/** One traffic-matrix cell: goals for the full span / elapsed cutoff + PTG. */
interface GoalCell {
  fullSpanGoal: number;
  toDateGoal: number;
  actual: number;
  ptgPercent: number | null;
}

/** Traffic-matrix cell: actual plus the resolved target values. */
interface TargetCell {
  fullSpanGoal: number;
  toDateGoal: number;
  actual: number;
  ptgPercent: number | null;
}
interface RatioRow {
  name: string;
  group: string;
  goal: number | null;
  actual: number;
  ptgPercent: number | null;
}
interface OverviewResponse {
  appliedRange: { startDate: string; endDate: string; toDate: string; target: string };

  kpis: {
    grossSales: number;
    salesGoal: number;
    salesTdGoal: number;
    ptgVariance: number;
    ptgPercent: number | null;
  };

  trafficMatrix: {
    online: {
      websiteUsers: TargetCell;
      leads: TargetCell;
      tours: TargetCell;
      sales: TargetCell;
    };
    onsite: {
      leads: TargetCell;
      tours: TargetCell;
      sales: TargetCell;
    };
    /** Rows with neither 'Online' nor 'Onsite' label — shown so the split adds up */
    unknown: { leads: number; tours: number; sales: number };
    total: { leads: TargetCell; tours: TargetCell };
    /** Headline NEW-users count from the overall () grouping-set row */
    newWebsiteUsers: number;
  };

  divisions: DivisionRow[];

  developments: DevelopmentRow[];

  ratios: RatioRow[];
  /**
   * Record-level lists behind the unknown buckets, embedded in the same
   * response as the counts they explain (one Snowflake statement feeds
   * both, so total vs trafficMatrix.unknown is a race-free predicate net).
   */
  unknownRecords: Record<
    "leads" | "tours" | "sales",
    {
      total: number;
      truncated: boolean;
      records: {
        name: string | null;
        email: string | null;
        development: string | null;
        division: string | null;
        date: string;
        rawChannel: string | null;
        crmUrl: string | null;
      }[];
    }
  >;
}

async function fetchOverview(params: Record<string, string>): Promise<OverviewResponse> {
  const qs = new URLSearchParams(params).toString();
  const url = `${API_BASE}/dashboards/overview-with-targets${qs ? `?${qs}` : ""}`;
  // Transport hiccups (dropped connection, transient 5xx while the server's
  // own Snowflake burst warms up) are retried; real 4xx failures are not.
  return fetchJsonWithRetry<OverviewResponse>(url);
}
/** Same business-day convention the API uses. */
function todayChicago(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(
    new Date(),
  );
}

/** Default range the API applies with no date params: the current quarter. */
function defaultQuarterRange(): { startDate: string; endDate: string } {
  const today = todayChicago();
  const t = new Date(today + "T00:00:00");
  const q = Math.floor(t.getMonth() / 3);
  const startDate = `${t.getFullYear()}-${String(q * 3 + 1).padStart(2, "0")}-01`;
  const qEnd = new Date(t.getFullYear(), q * 3 + 3, 0);
  const endDate = `${qEnd.getFullYear()}-${String(qEnd.getMonth() + 1).padStart(2, "0")}-${String(qEnd.getDate()).padStart(2, "0")}`;
  return { startDate, endDate };
}

/** Elapsed cutoff: today clamped into [startDate, endDate]. */
function expectedToDate(startDate: string, endDate: string): string {
  const today = todayChicago();
  return today < startDate ? startDate : today > endDate ? endDate : today;
}
/**
 * Filters a scenario applies, expressed once and translated into both the
 * API query string and equivalent baseline WHERE fragments per source.
 */
interface ScenarioFilters {
  company?: string;
  development?: string;
  /** Applied as contactChannel AND dealChannel, like the dashboard UI does */
  channel?: string;
  /**
   * Filters contacts (LEAD_SOURCE_OVERVIEW) AND deals
   * (DEAL_LEAD_SOURCE_OVERVIEW); GA has no lead-source dimension.
   */
  leadSource?: string;
  /**
   * Filters contacts only (EHI_COHORT_QUARTER) — the API's dealFilters and
   * gaFilters have no cohort dimension, so sales and website-user baselines
   * must stay unfiltered under it.
   */
  cohortQuarter?: string;
  startDate?: string;
  endDate?: string;
}

interface Scenario {
  name: string;

  filters: ScenarioFilters;
  /**
   * Also audit the divisions/developments breakdown tables under this
   * scenario's filters (baselines bound to the same filters).
   */

  withBreakdowns?: boolean;
  /**
   * Also audit the website-user columns of the breakdown tables (GA-side
   * baselines). Default view only: those baselines bind no filters.
   */

  withGaBreakdowns?: boolean;
  /**
   * Also audit the funnel ratios table (actuals recomputed from baseline
   * counts, goals against the ratio-goal input table). Default view only:
   * those baselines bind no filters.
   */

  withRatios?: boolean;
  /**
   * Run the channel label-drift guard: fail when a headline baseline is
   * materially non-zero but its 'Online' AND 'Onsite' baselines are both
   * zero — the all-zero signature of relabeled channel values upstream.
   * Default view only: a channel-filtered scenario legitimately zeroes the
   * opposite channel's cells.
   */

  withChannelLabelGuard?: boolean;
  /**
   * Run the shared GA property label-drift guard: fail when GA rows exist
   * for the range but zero match an expected PROPERTY value — the all-zero
   * signature of a renamed analytics property upstream. Default view only:
   * one guard pass per audit run is coverage enough, and the default range
   * is the one the dashboard ships.
   */

  withGaPropertyGuard?: boolean;
  /**
   * Also audit every TARGET value (KPI sales goal + ALL traffic-matrix
   * goal columns, online/onsite cells included) against an independent
   * resolution of the goal-type regime actually present in DM_GOALS for
   * the scenario's fiscal year:
   * - Year carries the goal_* regime: compare real target values, and FAIL
   *   loudly when the resolved goal data sums to zero (requireGoalData
   *   semantics from audit-leasing.ts) — 0-vs-0 target checks test nothing.
   * - Year predates the regime (no goal_* types at all, e.g. FY2025): pin
   *   strict fiscal isolation — every target must be EXACTLY zero, so goals
   *   leaking in from another fiscal year or goal type fail immediately.
   */

  pinTargets?: boolean;

  /**
   * Run the shared GA freshness guard: fail when the newest loaded
   * GOOGLE_ANALYTICS_DATE (overall or per expected property) trails today
   * by more than AUDIT_GA_MAX_LAG_DAYS — the signature of a dead GA export,
   * which the quiet-window exemptions above would otherwise wave through.
   * Range-independent, so default view only: once per audit pass.
   */
  withGaFreshnessGuard?: boolean;

  /**
   * Run the shared GA Yes/No flag label-drift guard: fail when a property's
   * GA rows exist for the range but zero carry an expected flag value
   * (IS_NEW_USER / IS_SESSION_START = 'Yes') — the all-zero signature of
   * relabeled Yes/No values upstream, which zeroes the dependent columns
   * while total users stay correct. Default view only, like the property
   * guard.
   */
  withGaFlagGuard?: boolean;
}

interface Frag {
  sql: string;
  binds: (string | number)[];
}

/**
 * Baseline fragments for DM_CONTACTS (alias C).
 *
 * Each filter appends its SQL part and its bind TOGETHER, in one fixed
 * field order — the same order the API's contactFilters
 * (src/lib/overview-targets.ts) uses — so for any COMBINATION of filters
 * the bind sequence matches the fragment's ? order on both sides. The
 * combined-filter scenarios exercise exactly this pairing; a bind pushed
 * out of step with its part shows up there as divergence.
 */
function contactFrag(f: ScenarioFilters): Frag {
  const parts: string[] = [];
  const binds: (string | number)[] = [];
  if (f.company) {
    parts.push(
      `C.CONTACT_EHI_COMMUNITY_OF_INTEREST IN (SELECT DEVELOPMENT_NAME FROM ${DEV_DIM} WHERE COMPANY_NAME = ?)`,
    );
    binds.push(f.company);
  }
  if (f.development) {
    parts.push("C.CONTACT_EHI_COMMUNITY_OF_INTEREST = ?");
    binds.push(f.development);
  }
  if (f.cohortQuarter) {
    parts.push("C.EHI_COHORT_QUARTER = ?");
    binds.push(f.cohortQuarter);
  }
  if (f.leadSource) {
    parts.push("C.LEAD_SOURCE_OVERVIEW = ?");
    binds.push(f.leadSource);
  }
  if (f.channel) {
    parts.push("C.ONSITE_ONLINE_SOURCE_CHANNEL = ?");
    binds.push(f.channel);
  }
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", binds };
}

/**
 * Baseline fragments for DM_DEALS (alias X). Same part/bind pairing
 * invariant as contactFrag, mirroring the API's dealFilters field order.
 */
function dealFrag(f: ScenarioFilters): Frag {
  const parts: string[] = [];
  const binds: (string | number)[] = [];
  if (f.company) {
    parts.push(
      `X.DEAL_EHI_COMMUNITY_OF_INTEREST IN (SELECT DEVELOPMENT_NAME FROM ${DEV_DIM} WHERE COMPANY_NAME = ?)`,
    );
    binds.push(f.company);
  }
  if (f.development) {
    parts.push("X.DEAL_EHI_COMMUNITY_OF_INTEREST = ?");
    binds.push(f.development);
  }
  if (f.leadSource) {
    parts.push("X.DEAL_LEAD_SOURCE_OVERVIEW = ?");
    binds.push(f.leadSource);
  }
  // cohortQuarter deliberately NOT applied: the API's dealFilters has no
  // cohort dimension, so the deal baselines must stay unfiltered under it.
  if (f.channel) {
    parts.push("X.DEAL_ONSITE_ONLINE_SOURCE_CHANNEL = ?");
    binds.push(f.channel);
  }
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", binds };
}

/** Baseline fragments for FCT_GOOGLE_ANALYTICS_EVENT_LEVEL. */
function gaFrag(f: ScenarioFilters): Frag {
  const parts: string[] = [];
  const binds: (string | number)[] = [];
  if (f.company) {
    parts.push("MATCHED_COMPANY_NAME = ?");
    binds.push(f.company);
  }
  if (f.development) {
    parts.push("MATCHED_DEVELOPMENT_NAME = ?");
    binds.push(f.development);
  }
  // GA has no channel, lead-source, or cohort dimension in the dashboard;
  // those filters do not apply (mirrors the API's gaFilters).
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", binds };
}

/** Baseline fragments for DM_GOALS (goals have no channel dimension). */
function goalFrag(f: ScenarioFilters): Frag {
  const parts: string[] = [];
  const binds: (string | number)[] = [];
  if (f.company) {
    parts.push("COMPANY_NAME = ?");
    binds.push(f.company);
  }
  if (f.development) {
    parts.push("DEVELOPMENT_NAME = ?");
    binds.push(f.development);
  }
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", binds };
}
function toQueryParams(f: ScenarioFilters): Record<string, string> {
  const params: Record<string, string> = {};
  if (f.company) params.company = f.company;
  if (f.development) params.development = f.development;
  if (f.channel) {
    params.contactChannel = f.channel;
    params.dealChannel = f.channel;
  }
  if (f.leadSource) params.leadSource = f.leadSource;
  if (f.cohortQuarter) params.cohortQuarter = f.cohortQuarter;
  if (f.startDate) params.startDate = f.startDate;
  if (f.endDate) params.endDate = f.endDate;
  return params;
}

/**
 * The headline baseline counts a scenario computed, reused by the ratios
 * audit so it doesn't re-run identical queries: the ratios table's actuals
 * are defined over exactly the default view's headline populations
 * (unfiltered leads/tours/sales/users and their channel splits).
 */
interface HeadlineBaselines {
  users: number;
  leads: number;
  onlineLeads: number;
  onsiteLeads: number;
  tours: number;
  onlineTours: number;
  onsiteTours: number;
  sales: number;
  onlineSales: number;
  onsiteSales: number;
}

interface ScenarioResult {
  ok: boolean;
  /** false when the API did not honor the requested/default dates */
  rangeOk: boolean;
  overview: OverviewResponse;
  expStart: string;
  expEnd: string;
  expTo: string;
  /** set on every range-honoring scenario result */
  headline?: HeadlineBaselines;
}
// hint: Logic changed on both sides. Requires understanding intent of each change.
// hint: Logic changed on both sides. Requires understanding intent of each change.
async function auditScenario(scenario: Scenario): Promise<ScenarioResult> {
  const f = scenario.filters;
  console.log(`\n=== Scenario: ${scenario.name} ===`);
  const params = toQueryParams(f);
  console.log(
    `Params: ${Object.keys(params).length ? JSON.stringify(params) : "(none — default view)"}`,
  );

  // Compute the range the API MUST apply — requested dates, or the default
  // quarter — before looking at the response, then assert the response
  // honored it. This catches an endpoint that silently ignores date params.
  const defaults = defaultQuarterRange();
  const expStart = f.startDate ?? defaults.startDate;
  const expEnd = f.endDate ?? defaults.endDate;
  const expTo = expectedToDate(expStart, expEnd);

  const overview = await fetchOverview(params);
  const ar = overview.appliedRange;
  console.log(
    `Applied range: ${ar.startDate}..${ar.endDate}, toDate=${ar.toDate}, target=${ar.target}`,
  );

  if (ar.startDate !== expStart || ar.endDate !== expEnd || ar.toDate !== expTo) {
    console.error(
      `FAIL appliedRange mismatch: expected ${expStart}..${expEnd} (toDate=${expTo}), ` +
        `got ${ar.startDate}..${ar.endDate} (toDate=${ar.toDate}) — the API did not honor the requested/default dates`,
    );
    return { ok: false, rangeOk: false, overview, expStart, expEnd, expTo };
  }

  const cf = contactFrag(f);
  const df = dealFrag(f);
  const gf = gaFrag(f);

  // Independent baselines — bound to the EXPECTED dates (start..elapsed
  // cutoff), same window the API applies to actuals, no attribution join
  // that could fan out counts.
  //
  // BATCHED on purpose: the Snowflake proxy rate-limits at ~10 RPS
  // repl-wide, so round trips — not warehouse work — dominate audit wall
  // time. ONE conditional-aggregation scan per source (contacts / deals /
  // GA) computes all 14 headline baselines; each COUNT_IF counts exactly
  // the rows the old one-scalar-COUNT-per-cell queries matched:
  //  - the window flags are the old BETWEEN predicates; a row in neither
  //    window is dropped by the outer WHERE and contributed to no count
  //    anyway (BETWEEN over a NULL date is NULL, and TRUE OR NULL is TRUE,
  //    so no in-window row is lost);
  //  - channel cells restrict on the shared CHANNEL_ONLINE/CHANNEL_ONSITE
  //    labels (src/lib/business-defs.ts) on the channel column the dashboard
  //    keys on; the unlabeled bucket
  //    (behind trafficMatrix.unknown) recounts rows carrying NEITHER
  //    literal ('Unknown', NULL, or any other value) — still a direct
  //    recount of source rows, never total − online − onsite, so the audit
  //    keeps per-cell baselines with no sum-to-total assumption;
  //  - composing with a scenario channel filter (already in cf/df) is
  //    correct by construction: a matching label is redundant, a
  //    contradicting one makes that COUNT_IF structurally zero — exactly
  //    what the API's cell must show under that filter.
  const UNLABELED = `(CH IS NULL OR CH NOT IN (${CHANNEL_LABELS.map((l) => `'${l}'`).join(",")}))`;
  // Bind order follows text order: subquery SELECT-list window binds come
  // before the WHERE fragment binds.
  const [contactRows, dealRows, gaRows] = await Promise.all([
    sfQuery<Record<string, number>>(
      `SELECT COUNT_IF(IN_LEAD_WINDOW) AS LEADS,
              COUNT_IF(IN_LEAD_WINDOW AND CH = '${CHANNEL_ONLINE}') AS ONLINE_LEADS,
              COUNT_IF(IN_LEAD_WINDOW AND CH = '${CHANNEL_ONSITE}') AS ONSITE_LEADS,
              COUNT_IF(IN_LEAD_WINDOW AND ${UNLABELED}) AS UNLABELED_LEADS,
              COUNT_IF(IN_TOUR_WINDOW) AS TOURS,
              COUNT_IF(IN_TOUR_WINDOW AND CH = '${CHANNEL_ONLINE}') AS ONLINE_TOURS,
              COUNT_IF(IN_TOUR_WINDOW AND CH = '${CHANNEL_ONSITE}') AS ONSITE_TOURS,
              COUNT_IF(IN_TOUR_WINDOW AND ${UNLABELED}) AS UNLABELED_TOURS
       FROM (
         SELECT C.CONTACT_CREATE_DATE BETWEEN ? AND ? AS IN_LEAD_WINDOW,
                C.EHI_MIN_FIRST_TOUR_DATE BETWEEN ? AND ? AS IN_TOUR_WINDOW,
                C.ONSITE_ONLINE_SOURCE_CHANNEL AS CH
         FROM DM_CONTACTS C
         WHERE ${isLeadSql("C")}${cf.sql}
       )
       WHERE IN_LEAD_WINDOW OR IN_TOUR_WINDOW`,
      [expStart, expTo, expStart, expTo, ...cf.binds],
    ),
    sfQuery<Record<string, number>>(
      `SELECT COUNT(*) AS SALES,
              COUNT_IF(X.DEAL_ONSITE_ONLINE_SOURCE_CHANNEL = '${CHANNEL_ONLINE}') AS ONLINE_SALES,
              COUNT_IF(X.DEAL_ONSITE_ONLINE_SOURCE_CHANNEL = '${CHANNEL_ONSITE}') AS ONSITE_SALES,
              COUNT_IF(X.DEAL_ONSITE_ONLINE_SOURCE_CHANNEL IS NULL
                       OR X.DEAL_ONSITE_ONLINE_SOURCE_CHANNEL NOT IN (${CHANNEL_LABELS.map((l) => `'${l}'`).join(",")})) AS UNLABELED_SALES
       FROM DM_DEALS X
       WHERE ${isSaleSql("X")}
         AND X.CONTRACT_RATIFIED_DATE BETWEEN ? AND ?${df.sql}`,
      [expStart, expTo, ...df.binds],
    ),
    // Users + NEW users from the same scan: the API takes both from the
    // overall () grouping-set row (picked via G_COMPANY=1), which can
    // regress independently of the per-row values, so each total gets its
    // own independent GA baseline aggregate here.
    sfQuery<Record<string, number>>(
      `SELECT COUNT(DISTINCT USER_PSEUDO_ID) AS USERS,
              COUNT(DISTINCT IFF(IS_NEW_USER = 'Yes', USER_PSEUDO_ID, NULL)) AS NEW_USERS
       FROM FCT_GOOGLE_ANALYTICS_EVENT_LEVEL
       WHERE ${isGaTrafficSql()} AND GOOGLE_ANALYTICS_DATE BETWEEN ? AND ?${gf.sql}`,
      [expStart, expTo, ...gf.binds],
    ),
  ]);

  const val = (rows: Record<string, number>[], col: string) => Number(rows[0]?.[col]) || 0;
  const leads = val(contactRows, "LEADS");
  const tours = val(contactRows, "TOURS");
  const sales = val(dealRows, "SALES");
  const users = val(gaRows, "USERS");
  const newUsers = val(gaRows, "NEW_USERS");
  const onlineLeads = val(contactRows, "ONLINE_LEADS");
  const onsiteLeads = val(contactRows, "ONSITE_LEADS");
  const onlineTours = val(contactRows, "ONLINE_TOURS");
  const onsiteTours = val(contactRows, "ONSITE_TOURS");
  const onlineSales = val(dealRows, "ONLINE_SALES");
  const onsiteSales = val(dealRows, "ONSITE_SALES");
  const unlabeledLeads = val(contactRows, "UNLABELED_LEADS");
  const unlabeledTours = val(contactRows, "UNLABELED_TOURS");
  const unlabeledSales = val(dealRows, "UNLABELED_SALES");

  const tm = overview.trafficMatrix;
  const checks: { name: string; api: number; baseline: number }[] = [
    { name: "leads", api: tm.total.leads.actual, baseline: leads },
    { name: "tours", api: tm.total.tours.actual, baseline: tours },
    { name: "sales", api: overview.kpis.grossSales, baseline: sales },
    { name: "users", api: tm.online.websiteUsers.actual, baseline: users },
    { name: "newUsers", api: tm.newWebsiteUsers, baseline: newUsers },
    // Channel-split cells: a mis-keyed channel column or swapped Online/
    // Onsite labels leaves every total above unchanged — only these
    // per-cell comparisons catch that regression class.
    { name: "onlineLeads", api: tm.online.leads.actual, baseline: onlineLeads },
    { name: "onsiteLeads", api: tm.onsite.leads.actual, baseline: onsiteLeads },
    { name: "onlineTours", api: tm.online.tours.actual, baseline: onlineTours },
    { name: "onsiteTours", api: tm.onsite.tours.actual, baseline: onsiteTours },
    { name: "onlineSales", api: tm.online.sales.actual, baseline: onlineSales },
    { name: "onsiteSales", api: tm.onsite.sales.actual, baseline: onsiteSales },
    // The unknown bucket (no Online/Onsite label) the dashboard now shows so
    // the split visibly adds up — same per-cell treatment as the six cells
    // above, each against its own independent recount.
    { name: "unknownLeads", api: tm.unknown.leads, baseline: unlabeledLeads },
    { name: "unknownTours", api: tm.unknown.tours, baseline: unlabeledTours },
    { name: "unknownSales", api: tm.unknown.sales, baseline: unlabeledSales },
  ];

  let failed = false;
  for (const c of checks) {
    const divergencePct =
      c.baseline === 0
        ? c.api === 0
          ? 0
          : Infinity
        : (Math.abs(c.api - c.baseline) / c.baseline) * 100;
    const ok = divergencePct <= TOLERANCE_PCT;
    const status = ok ? "OK  " : "FAIL";
    console.log(
      `${status} ${c.name.padEnd(12)} api=${c.api} baseline=${c.baseline} divergence=${divergencePct.toFixed(3)}%`,
    );
    if (!ok) failed = true;
  }

  // ---- Channel label-drift guard ----
  // The per-cell channel checks above and the API's channel split key on the
  // same shared channel labels (CHANNEL_ONLINE/CHANNEL_ONSITE in
  // src/lib/business-defs.ts, matched by chan() in src/lib/overview-targets.ts),
  // so the two sides cannot drift apart in code.
  // If upstream data relabels the channel values (e.g. dbt renames 'Online'
  // to 'Digital' in DM_CONTACTS.ONSITE_ONLINE_SOURCE_CHANNEL or
  // DM_DEALS.DEAL_ONSITE_ONLINE_SOURCE_CHANNEL), BOTH sides compute 0, every
  // per-cell check passes 0=0, and the dashboard ships a zeroed online/onsite
  // section with no alarm. A materially non-zero headline baseline whose two
  // channel baselines are BOTH zero is that signature: unlabeled rows
  // legitimately make online + onsite < total, but at volume they never take
  // both to exactly zero. Totals below CHANNEL_GUARD_MIN_TOTAL are treated as
  // too quiet to judge (e.g. day one of a quarter) and cannot false-positive.
  if (scenario.withChannelLabelGuard) {
    const guards = [
      {
        metric: "leads",
        total: leads,
        online: onlineLeads,
        onsite: onsiteLeads,
        column: "DM_CONTACTS.ONSITE_ONLINE_SOURCE_CHANNEL",
        labelsSql: `SELECT COALESCE(C.ONSITE_ONLINE_SOURCE_CHANNEL, '(null)') AS LABEL, COUNT(*) AS N
           FROM DM_CONTACTS C
           WHERE ${isLeadSql("C")} AND C.CONTACT_CREATE_DATE BETWEEN ? AND ?${cf.sql}
           GROUP BY 1 ORDER BY N DESC`,
        binds: [expStart, expTo, ...cf.binds] as (string | number)[],
      },
      {
        metric: "tours",
        total: tours,
        online: onlineTours,
        onsite: onsiteTours,
        column: "DM_CONTACTS.ONSITE_ONLINE_SOURCE_CHANNEL",
        labelsSql: `SELECT COALESCE(C.ONSITE_ONLINE_SOURCE_CHANNEL, '(null)') AS LABEL, COUNT(*) AS N
           FROM DM_CONTACTS C
           WHERE ${isLeadSql("C")} AND C.EHI_MIN_FIRST_TOUR_DATE BETWEEN ? AND ?${cf.sql}
           GROUP BY 1 ORDER BY N DESC`,
        binds: [expStart, expTo, ...cf.binds] as (string | number)[],
      },
      {
        metric: "sales",
        total: sales,
        online: onlineSales,
        onsite: onsiteSales,
        column: "DM_DEALS.DEAL_ONSITE_ONLINE_SOURCE_CHANNEL",
        labelsSql: `SELECT COALESCE(X.DEAL_ONSITE_ONLINE_SOURCE_CHANNEL, '(null)') AS LABEL, COUNT(*) AS N
           FROM DM_DEALS X
           WHERE ${isSaleSql("X")}
             AND X.CONTRACT_RATIFIED_DATE BETWEEN ? AND ?${df.sql}
           GROUP BY 1 ORDER BY N DESC`,
        binds: [expStart, expTo, ...df.binds] as (string | number)[],
      },
    ];
    for (const g of guards) {
      const name = `chLabels:${g.metric}`.padEnd(12);
      if (g.total < CHANNEL_GUARD_MIN_TOTAL) {
        console.log(
          `OK   ${name} total=${g.total} < ${CHANNEL_GUARD_MIN_TOTAL} — window too quiet to judge label drift`,
        );
        continue;
      }
      if (g.online > 0 || g.onsite > 0) {
        console.log(
          `OK   ${name} '${CHANNEL_ONLINE}'/'${CHANNEL_ONSITE}' labels present (online=${g.online} onsite=${g.onsite} of ${g.total})`,
        );
        continue;
      }
      // Fetch the labels actually present so the failure names the fix.
      const labelRows = await sfQuery<{ LABEL: string; N: number }>(
        g.labelsSql,
        g.binds,
      );
      const present =
        labelRows.map((r) => `'${r.LABEL}' (${Number(r.N) || 0})`).join(", ") ||
        "(no rows)";
      console.error(
        `FAIL ${name} ${g.total} ${g.metric} in ${expStart}..${expTo} but ZERO match '${CHANNEL_ONLINE}' and ZERO match '${CHANNEL_ONSITE}' ` +
          `on ${g.column} — the expected channel labels are missing from the data; labels present: ${present}. ` +
          `The dashboard's channel split AND this audit's baselines both key on the ` +
          `shared CHANNEL_ONLINE/CHANNEL_ONSITE constants (src/lib/business-defs.ts — chan() in ` +
          `src/lib/overview-targets.ts; the channel COUNT_IFs here), so every online/onsite ` +
          `cell reads 0 and the per-cell checks pass 0=0. If upstream renamed the channel values, update ` +
          `those constants to the new labels.`,
      );
      failed = true;
    }
  }

  // ---- GA property label-drift guard ----
  // Same blind-spot class as the channel guard, for website traffic: the
  // API's GA queries and this audit's GA baselines hardcode the same
  // PROPERTY literal, so an upstream rename zeroes both sides and every
  // user-count check passes 0=0. The shared guard (ga-property-guard.ts)
  // fails when GA rows exist for the range but zero match an expected
  // property, naming the property values actually present.
  if (scenario.withGaPropertyGuard) {
    if (!(await auditGaPropertyLabels(expStart, expTo))) failed = true;
  }

  // ---- GA Yes/No flag label-drift guard ----
  // One layer deeper than the property guard: the NEW-users headline and
  // breakdown columns key on IS_NEW_USER = 'Yes' on BOTH sides (the API's
  // fetchWebsiteUsers and this audit's GA baselines), and the Leasing web
  // traffic keys on IS_SESSION_START = 'Yes' the same way. A relabel of the
  // Yes/No values zeroes those columns on both sides while the total-users
  // columns stay correct, so every check passes 0=0 and nothing looks wrong
  // on screen. The shared guard (ga-property-guard.ts) fails when a
  // property's GA rows exist for the range but zero carry the expected flag
  // value, naming the values actually present.
  if (scenario.withGaFlagGuard) {
    if (!(await auditGaFlagLabels(expStart, expTo))) failed = true;
  }

  if (scenario.pinTargets) {
    const targetsOk = await auditTargets(overview, expStart, expEnd, expTo);
    if (!targetsOk) failed = true;
  }

  // ---- GA freshness guard ----
  // The property guard above (and every user-count check) is blind to the
  // export simply stopping: zero rows loaded means 0=0 comparisons and
  // quiet-window exemptions all keep passing while the dashboards' traffic
  // numbers drain toward zero. The shared freshness guard fails instead
  // when the newest loaded GA row falls further behind today than the
  // normal ~7-8 day load lag allows (AUDIT_GA_MAX_LAG_DAYS, default 14).
  if (scenario.withGaFreshnessGuard) {
    if (!(await auditGaFreshness())) failed = true;
  }

  return {
    ok: !failed,
    rangeOk: true,
    overview,
    expStart,
    expEnd,
    expTo,
    headline: {
      users,
      leads,
      onlineLeads,
      onsiteLeads,
      tours,
      onlineTours,
      onsiteTours,
      sales,
      onlineSales,
      onsiteSales,
    },
  };
}

/**
 * Every target-bearing cell of the overview response: the sales KPI plus all
 * traffic-matrix goal columns, online/onsite channel cells included. Names
 * match the <metric> segment of the goal_<metric>_q<N> GOAL_TYPE convention.
 */
const TARGET_METRICS = [
  "gross_sales",
  "leads",
  "first_tours",
  "web_traffic",
  "online_leads",
  "onsite_leads",
  "online_first_tours",
  "onsite_first_tours",
  "online_gross_sales",
  "onsite_gross_sales",
] as const;

// ---------- Breakdown table audit (divisions / developments) ----------

function divergedPct(api: number, baseline: number): number {
  return baseline === 0
    ? api === 0
      ? 0
      : Infinity
    : (Math.abs(api - baseline) / baseline) * 100;
}

/**
 * Audits the divisions and developments breakdown tables of one scenario's
 * response against independent Snowflake baselines grouped the same way the
 * API groups them (via the deduplicated Esperanza dimension, which cannot
 * fan out). The scenario's filters are bound into every baseline query, so
 * the audit also covers filtered views.
 *
 * Checks, per metric (leads / tours / sales, and their unlabeled-channel
 * counterparts unknownLeads / unknownTours / unknownSales — each row's
 * count of rows carrying no Online/Onsite label, recounted independently
 * via its own COUNT_IF over the channel column, NEVER derived as
 * row total − online − onsite):
 *  1. Every API division row matches a per-company baseline, and every
 *     non-zero baseline company appears in the API rows. Under a company
 *     filter this doubles as leak detection: another division's non-zero
 *     row fails against its zero baseline.
 *  2. The same for development rows: every non-zero baseline
 *     (company, development) pair must be present and match.
 *  3. Cross-check: breakdown rows + unattributed remainder must sum to the
 *     headline total (rows not mapped by the dimension have no division row,
 *     so the audit accounts for them explicitly instead of fudging
 *     tolerance). Under a company filter the remainder is structurally zero
 *     — the filter itself excludes unattributable rows — and the query
 *     verifies that rather than assuming it. For the unknown* metrics the
 *     headline is the matrix's unknown bucket (itself audited per cell
 *     against its own independent recount), not a derived difference.
 */
async function auditBreakdowns(
  scenario: Scenario,
  overview: OverviewResponse,
  expStart: string,
  expTo: string,
): Promise<boolean> {
  console.log(`\n=== Breakdown tables (${scenario.name}) ===`);

  // Same filter fragments the headline baselines use (alias C for contacts,
  // X for deals); appended inside each WHERE below, before GROUP BY.
  const cf = contactFrag(scenario.filters);
  const df = dealFrag(scenario.filters);

  // "No Online/Onsite label" predicates for the unknown* metrics, applied to
  // the channel column each grouped scan already exposes. Independent
  // recounts: the audit never derives unlabeled as total − online − onsite.
  const UNLAB_CONTACT = `(C.CH IS NULL OR C.CH NOT IN (${CHANNEL_LABELS.map((l) => `'${l}'`).join(", ")}))`;
  const UNLAB_DEAL =
    "(X.DEAL_ONSITE_ONLINE_SOURCE_CHANNEL IS NULL " +
    `OR X.DEAL_ONSITE_ONLINE_SOURCE_CHANNEL NOT IN (${CHANNEL_LABELS.map((l) => `'${l}'`).join(", ")}))`;

  // BATCHED baselines (the Snowflake proxy rate-limits at ~10 RPS, so round
  // trips dominate audit wall time):
  //  - leads and tours group the same contact rows through the same
  //    dimension join, differing only in date column, so ONE grouped
  //    conditional-aggregation scan yields both metrics' per-(company,
  //    development) baselines. Each COUNT_IF counts exactly the rows the
  //    old per-metric COUNT(*) matched; a row in neither window is dropped
  //    by the outer WHERE and contributed to no group anyway (BETWEEN over
  //    a NULL date is NULL, TRUE OR NULL is TRUE — no in-window row lost).
  //    Ditto for the two unattributed remainders.
  //  - the unknown* baselines are extra COUNT_IF columns on the SAME scans
  //    (window predicate AND unlabeled-channel predicate), so per-row
  //    unlabeled counts cost no additional queries.
  //  - per-company baselines are exact JS rollups of the per-development
  //    groups: every joined row matches EXACTLY ONE dimension row (the
  //    dedup DEV_DIM subquery is one row per DEVELOPMENT_NAME), so summing
  //    a company's development groups reproduces the old GROUP BY
  //    COMPANY_NAME counts integer-for-integer. A group whose COUNT_IF is
  //    0 behaves like the absent group the old per-metric query produced —
  //    the comparison loops skip 0==0 rows.
  interface ContactDevRow {
    COMPANY_NAME: string;
    DEVELOPMENT_NAME: string;
    N_LEADS: number;
    N_TOURS: number;
    N_UNK_LEADS: number;
    N_UNK_TOURS: number;
  }
  interface DealDevRow {
    COMPANY_NAME: string;
    DEVELOPMENT_NAME: string;
    N: number;
    N_UNK: number;
  }
  // Bind order follows text order: subquery SELECT-list window binds come
  // before the WHERE fragment binds.
  const [contactByDev, dealByDev, contactUnattrRows, dealUnattrRows] = await Promise.all([
    sfQuery<ContactDevRow>(
      `SELECT D.COMPANY_NAME, D.DEVELOPMENT_NAME,
              COUNT_IF(C.IN_LEAD_WINDOW) AS N_LEADS,
              COUNT_IF(C.IN_TOUR_WINDOW) AS N_TOURS,
              COUNT_IF(C.IN_LEAD_WINDOW AND ${UNLAB_CONTACT}) AS N_UNK_LEADS,
              COUNT_IF(C.IN_TOUR_WINDOW AND ${UNLAB_CONTACT}) AS N_UNK_TOURS
       FROM (
         SELECT C.CONTACT_EHI_COMMUNITY_OF_INTEREST AS COI,
                C.ONSITE_ONLINE_SOURCE_CHANNEL AS CH,
                C.CONTACT_CREATE_DATE BETWEEN ? AND ? AS IN_LEAD_WINDOW,
                C.EHI_MIN_FIRST_TOUR_DATE BETWEEN ? AND ? AS IN_TOUR_WINDOW
         FROM DM_CONTACTS C
         WHERE ${isLeadSql("C")}${cf.sql}
       ) C
       JOIN ${DEV_DIM} D ON C.COI = D.DEVELOPMENT_NAME
       WHERE C.IN_LEAD_WINDOW OR C.IN_TOUR_WINDOW
       GROUP BY 1, 2`,
      [expStart, expTo, expStart, expTo, ...cf.binds],
    ),
    sfQuery<DealDevRow>(
      `SELECT D.COMPANY_NAME, D.DEVELOPMENT_NAME, COUNT(*) AS N,
              COUNT_IF(${UNLAB_DEAL}) AS N_UNK
       FROM DM_DEALS X
       JOIN ${DEV_DIM} D ON X.DEAL_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
       WHERE ${isSaleSql("X")}
         AND X.CONTRACT_RATIFIED_DATE BETWEEN ? AND ?${df.sql}
       GROUP BY 1, 2`,
      [expStart, expTo, ...df.binds],
    ),
    sfQuery<{ N_LEADS: number; N_TOURS: number; N_UNK_LEADS: number; N_UNK_TOURS: number }>(
      `SELECT COUNT_IF(C.CONTACT_CREATE_DATE BETWEEN ? AND ?) AS N_LEADS,
              COUNT_IF(C.EHI_MIN_FIRST_TOUR_DATE BETWEEN ? AND ?) AS N_TOURS,
              COUNT_IF(C.CONTACT_CREATE_DATE BETWEEN ? AND ?
                       AND (C.ONSITE_ONLINE_SOURCE_CHANNEL IS NULL
                            OR C.ONSITE_ONLINE_SOURCE_CHANNEL NOT IN (${CHANNEL_LABELS.map((l) => `'${l}'`).join(", ")}))) AS N_UNK_LEADS,
              COUNT_IF(C.EHI_MIN_FIRST_TOUR_DATE BETWEEN ? AND ?
                       AND (C.ONSITE_ONLINE_SOURCE_CHANNEL IS NULL
                            OR C.ONSITE_ONLINE_SOURCE_CHANNEL NOT IN (${CHANNEL_LABELS.map((l) => `'${l}'`).join(", ")}))) AS N_UNK_TOURS
       FROM DM_CONTACTS C
       WHERE ${isLeadSql("C")}
         AND (C.CONTACT_EHI_COMMUNITY_OF_INTEREST IS NULL
              OR C.CONTACT_EHI_COMMUNITY_OF_INTEREST NOT IN
                 (SELECT DEVELOPMENT_NAME FROM ${DEV_DIM}))${cf.sql}`,
      [expStart, expTo, expStart, expTo, expStart, expTo, expStart, expTo, ...cf.binds],
    ),
    sfQuery<{ N: number; N_UNK: number }>(
      `SELECT COUNT(*) AS N, COUNT_IF(${UNLAB_DEAL}) AS N_UNK
       FROM DM_DEALS X
       WHERE ${isSaleSql("X")}
         AND X.CONTRACT_RATIFIED_DATE BETWEEN ? AND ?
         AND (X.DEAL_EHI_COMMUNITY_OF_INTEREST IS NULL
              OR X.DEAL_EHI_COMMUNITY_OF_INTEREST NOT IN
                 (SELECT DEVELOPMENT_NAME FROM ${DEV_DIM}))${df.sql}`,
      [expStart, expTo, ...df.binds],
    ),
  ]);

  const bdDevKey = (c: string, dv: string) => `${c}\u0000${dv}`;
  const toDevMap = <T extends { COMPANY_NAME: string; DEVELOPMENT_NAME: string }>(
    rows: T[],
    pick: (r: T) => number,
  ) => new Map(rows.map((r) => [bdDevKey(r.COMPANY_NAME, r.DEVELOPMENT_NAME), pick(r)]));
  const rollupCompany = <T extends { COMPANY_NAME: string }>(
    rows: T[],
    pick: (r: T) => number,
  ) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.COMPANY_NAME, (m.get(r.COMPANY_NAME) ?? 0) + pick(r));
    return m;
  };

  const metrics = [
    {
      name: "leads",
      headline: overview.trafficMatrix.total.leads.actual,
      baseByCompany: rollupCompany(contactByDev, (r) => Number(r.N_LEADS) || 0),
      baseByDev: toDevMap(contactByDev, (r) => Number(r.N_LEADS) || 0),
      unattributed: Number(contactUnattrRows[0]?.N_LEADS) || 0,
      pick: (r: DivisionRow | DevelopmentRow) => Number(r.leads) || 0,
    },
    {
      name: "tours",
      headline: overview.trafficMatrix.total.tours.actual,
      baseByCompany: rollupCompany(contactByDev, (r) => Number(r.N_TOURS) || 0),
      baseByDev: toDevMap(contactByDev, (r) => Number(r.N_TOURS) || 0),
      unattributed: Number(contactUnattrRows[0]?.N_TOURS) || 0,
      pick: (r: DivisionRow | DevelopmentRow) => Number(r.tours) || 0,
    },
    {
      name: "sales",
      headline: overview.kpis.grossSales,
      baseByCompany: rollupCompany(dealByDev, (r) => Number(r.N) || 0),
      baseByDev: toDevMap(dealByDev, (r) => Number(r.N) || 0),
      unattributed: Number(dealUnattrRows[0]?.N) || 0,
      pick: (r: DivisionRow | DevelopmentRow) => Number(r.sales) || 0,
    },
    // Per-row unlabeled-channel counts (task: each breakdown row shows how
    // many of its leads/tours/sales carry no Online/Onsite label). Same
    // per-cell comparison discipline as the base metrics; baselines come
    // from the extra COUNT_IF columns of the same grouped scans.
    {
      name: "unknownLeads",
      headline: overview.trafficMatrix.unknown.leads,
      baseByCompany: rollupCompany(contactByDev, (r) => Number(r.N_UNK_LEADS) || 0),
      baseByDev: toDevMap(contactByDev, (r) => Number(r.N_UNK_LEADS) || 0),
      unattributed: Number(contactUnattrRows[0]?.N_UNK_LEADS) || 0,
      pick: (r: DivisionRow | DevelopmentRow) => Number(r.unknownLeads) || 0,
    },
    {
      name: "unknownTours",
      headline: overview.trafficMatrix.unknown.tours,
      baseByCompany: rollupCompany(contactByDev, (r) => Number(r.N_UNK_TOURS) || 0),
      baseByDev: toDevMap(contactByDev, (r) => Number(r.N_UNK_TOURS) || 0),
      unattributed: Number(contactUnattrRows[0]?.N_UNK_TOURS) || 0,
      pick: (r: DivisionRow | DevelopmentRow) => Number(r.unknownTours) || 0,
    },
    {
      name: "unknownSales",
      headline: overview.trafficMatrix.unknown.sales,
      baseByCompany: rollupCompany(dealByDev, (r) => Number(r.N_UNK) || 0),
      baseByDev: toDevMap(dealByDev, (r) => Number(r.N_UNK) || 0),
      unattributed: Number(dealUnattrRows[0]?.N_UNK) || 0,
      pick: (r: DivisionRow | DevelopmentRow) => Number(r.unknownSales) || 0,
    },
  ];

  let failed = false;

  for (const m of metrics) {
    const { baseByCompany, baseByDev, unattributed } = m;

    // --- 1. Division rows vs per-company baseline (both directions) ---
    const apiByCompany = new Map(overview.divisions.map((r) => [r.division, m.pick(r)]));
    const companyNames = new Set([...baseByCompany.keys(), ...apiByCompany.keys()]);
    for (const company of [...companyNames].sort()) {
      const api = apiByCompany.get(company) ?? 0;
      const baseline = baseByCompany.get(company) ?? 0;
      if (api === 0 && baseline === 0) continue;
      const d = divergedPct(api, baseline);
      const ok = d <= TOLERANCE_PCT;
      console.log(
        `${ok ? "OK  " : "FAIL"} division ${m.name.padEnd(12)} ${company.padEnd(30)} api=${api} baseline=${baseline} divergence=${d.toFixed(3)}%`,
      );
      if (!ok) failed = true;
    }

    // --- 2. Development rows vs per-(company, development) baseline ---
    const apiByDev = new Map(
      overview.developments.map((r) => [bdDevKey(r.division, r.development), m.pick(r)]),
    );
    const devKeys = new Set([...baseByDev.keys(), ...apiByDev.keys()]);
    for (const key of [...devKeys].sort()) {
      const api = apiByDev.get(key) ?? 0;
      const baseline = baseByDev.get(key) ?? 0;
      if (api === 0 && baseline === 0) continue;
      const [company, development] = key.split("\u0000");
      const d = divergedPct(api, baseline);
      const ok = d <= TOLERANCE_PCT;
      console.log(
        `${ok ? "OK  " : "FAIL"} devrow   ${m.name.padEnd(12)} ${`${development} (${company})`.padEnd(45)} api=${api} baseline=${baseline} divergence=${d.toFixed(3)}%`,
      );
      if (!ok) failed = true;
    }

    // --- 3. Cross-check: breakdown sums + unattributed == headline total ---
    const divSum = sumRows(overview.divisions, m.pick);
    const devSum = sumRows(overview.developments, m.pick);
    for (const [label, sum] of [
      ["divisions", divSum],
      ["developments", devSum],
    ] as const) {
      const reconstructed = sum + unattributed;
      const d = divergedPct(reconstructed, m.headline);
      const ok = d <= TOLERANCE_PCT;
      console.log(
        `${ok ? "OK  " : "FAIL"} sum      ${m.name.padEnd(12)} ${label.padEnd(30)} rows=${sum} +unattributed=${unattributed} => ${reconstructed} headline=${m.headline} divergence=${d.toFixed(3)}%`,
      );
      if (!ok) failed = true;
    }
  }

  return !failed;
}

function sumRows<T>(rows: T[], pick: (r: T) => number): number {
  let total = 0;
  for (const r of rows) total += pick(r);
  return total;
}

// ---------- Website-user breakdown audit (GA source) ----------

interface GaBaselineRow {
  COMPANY_NAME: string | null;
  DEVELOPMENT_NAME?: string | null;
  TOTAL_USERS: number;
  NEW_USERS: number;
}

/**
 * Mirrors the API's brand test for seeding breakdown rows from GA data
 * (COMPANY_NAME.includes("Esperanza")). GA groups outside the brand are
 * excluded from the dashboard by design, so a baseline-only group failing
 * this test is not a missing row.
 */
function isEsperanzaCompany(name: string): boolean {
  return name.includes("Esperanza");
}

/**
 * Audits the website-user columns (totalWebsiteUsers / newWebsiteUsers) of
 * the divisions and developments tables in the DEFAULT view. These columns
 * come from a different source than leads/tours/sales — one GROUPING SETS
 * query over FCT_GOOGLE_ANALYTICS_EVENT_LEVEL — so a GA-side grouping
 * regression (wrong grouping level picked, aggregation keyed to the wrong
 * column, dropped groups) would slip past the CRM-side checks. Baselines
 * recompute each level independently with a plain GROUP BY over
 * MATCHED_COMPANY_NAME / MATCHED_DEVELOPMENT_NAME and compare per row in
 * both directions: every API row must match its baseline, and every
 * non-zero Esperanza-brand baseline group must appear in the API rows.
 *
 * Deliberately NO sum-to-headline cross-check here: COUNT(DISTINCT
 * USER_PSEUDO_ID) is not additive across companies or developments (the
 * same user can visit several), so row sums legitimately differ from the
 * headline and only per-row comparisons are meaningful.
 */
async function auditWebsiteUserBreakdowns(
  overview: OverviewResponse,
  expStart: string,
  expTo: string,
): Promise<boolean> {
  console.log(`\n=== Breakdown tables: website users (default view) ===`);
  console.log(
    "note: distinct-user counts are not additive across rows — per-row checks only, no sum check",
  );

  const binds = [expStart, expTo];
  const [byCompany, byDev] = await Promise.all([
    sfQuery<GaBaselineRow>(
      `SELECT MATCHED_COMPANY_NAME AS COMPANY_NAME,
              COUNT(DISTINCT USER_PSEUDO_ID) AS TOTAL_USERS,
              COUNT(DISTINCT IFF(IS_NEW_USER = 'Yes', USER_PSEUDO_ID, NULL)) AS NEW_USERS
       FROM FCT_GOOGLE_ANALYTICS_EVENT_LEVEL
       WHERE ${isGaTrafficSql()} AND GOOGLE_ANALYTICS_DATE BETWEEN ? AND ?
       GROUP BY 1`,
      binds,
    ),
    sfQuery<GaBaselineRow>(
      `SELECT MATCHED_COMPANY_NAME AS COMPANY_NAME,
              MATCHED_DEVELOPMENT_NAME AS DEVELOPMENT_NAME,
              COUNT(DISTINCT USER_PSEUDO_ID) AS TOTAL_USERS,
              COUNT(DISTINCT IFF(IS_NEW_USER = 'Yes', USER_PSEUDO_ID, NULL)) AS NEW_USERS
       FROM FCT_GOOGLE_ANALYTICS_EVENT_LEVEL
       WHERE ${isGaTrafficSql()} AND GOOGLE_ANALYTICS_DATE BETWEEN ? AND ?
       GROUP BY 1, 2`,
      binds,
    ),
  ]);

  const devKey = (c: string, dv: string) => `${c}\u0000${dv}`;

  const measures = [
    {
      name: "totalUsers",
      fromBaseline: (r: GaBaselineRow) => Number(r.TOTAL_USERS) || 0,
      fromApi: (r: DivisionRow | DevelopmentRow) => Number(r.totalWebsiteUsers) || 0,
    },
    {
      name: "newUsers",
      fromBaseline: (r: GaBaselineRow) => Number(r.NEW_USERS) || 0,
      fromApi: (r: DivisionRow | DevelopmentRow) => Number(r.newWebsiteUsers) || 0,
    },
  ];

  let failed = false;

  for (const m of measures) {
    // --- 1. Division rows vs per-company baseline (both directions) ---
    const baseByCompany = new Map<string, number>();
    for (const r of byCompany) {
      if (r.COMPANY_NAME) baseByCompany.set(r.COMPANY_NAME, m.fromBaseline(r));
    }
    const apiByCompany = new Map(
      overview.divisions.map((r) => [r.division, m.fromApi(r)]),
    );
    // Every API division is checked against its baseline (0 when GA has no
    // group for it); baseline-only companies count as missing rows only when
    // the dashboard would seed them (Esperanza brands).
    const companyNames = new Set([
      ...apiByCompany.keys(),
      ...[...baseByCompany.keys()].filter(isEsperanzaCompany),
    ]);
    for (const company of [...companyNames].sort()) {
      const api = apiByCompany.get(company) ?? 0;
      const baseline = baseByCompany.get(company) ?? 0;
      if (api === 0 && baseline === 0) continue;
      const d = divergedPct(api, baseline);
      const ok = d <= TOLERANCE_PCT;
      console.log(
        `${ok ? "OK  " : "FAIL"} division ${m.name.padEnd(10)} ${company.padEnd(30)} api=${api} baseline=${baseline} divergence=${d.toFixed(3)}%`,
      );
      if (!ok) failed = true;
    }

    // --- 2. Development rows vs per-(company, development) baseline ---
    const baseByDev = new Map<string, number>();
    for (const r of byDev) {
      if (r.COMPANY_NAME && r.DEVELOPMENT_NAME) {
        baseByDev.set(devKey(r.COMPANY_NAME, r.DEVELOPMENT_NAME), m.fromBaseline(r));
      }
    }
    const apiByDev = new Map(
      overview.developments.map((r) => [devKey(r.division, r.development), m.fromApi(r)]),
    );
    const devKeys = new Set([
      ...apiByDev.keys(),
      ...[...baseByDev.keys()].filter((k) => isEsperanzaCompany(k.split("\u0000")[0])),
    ]);
    for (const key of [...devKeys].sort()) {
      const api = apiByDev.get(key) ?? 0;
      const baseline = baseByDev.get(key) ?? 0;
      if (api === 0 && baseline === 0) continue;
      const [company, development] = key.split("\u0000");
      const d = divergedPct(api, baseline);
      const ok = d <= TOLERANCE_PCT;
      console.log(
        `${ok ? "OK  " : "FAIL"} devrow   ${m.name.padEnd(10)} ${`${development} (${company})`.padEnd(45)} api=${api} baseline=${baseline} divergence=${d.toFixed(3)}%`,
      );
      if (!ok) failed = true;
    }
  }

  return !failed;
}

/**
 * Metrics the dashboard resolves goals for. gross_sales surfaces in the KPI
 * row (salesGoal / salesTdGoal); every other metric in a traffic-matrix
 * cell. Deliberately NOT imported from the API's data layer — the audit
 * must fail when the API's metric list or naming drifts from the data.
 */
const GOAL_METRICS = [
  "web_traffic",
  "leads",
  "online_leads",
  "onsite_leads",
  "first_tours",
  "online_first_tours",
  "onsite_first_tours",
  "gross_sales",
  "online_gross_sales",
  "onsite_gross_sales",
] as const;
interface CommunityRow {
  development: string;
  division: string;
  isRental: boolean;
  hasGoals: boolean;
  isSelling: boolean;
  leadsYtd: number;
  toursYtd: number;
  salesYtd: number;
}

/**
 * Pick representative filter values dynamically: the Esperanza company,
 * development, channel, lead source, and contact cohort quarter with the
 * most leads in the given range, so the filtered scenarios always exercise
 * non-trivial data. Among lead sources, prefer the busiest one that also
 * has ratified deals in range — the deal-side DEAL_LEAD_SOURCE_OVERVIEW
 * binding checked only against zero rows would prove nothing. Missing
 * values make the audit FAIL — a silently skipped scenario is not coverage.
 *
 * For the COMBINED-filter scenarios it also picks values nested inside the
 * base picks (second query round, since they depend on the first):
 *  - companyLeadSource: busiest lead source WITHIN the picked company,
 *    preferring one that also has the company's ratified deals in range so
 *    the composed deal-side binding (company semi-join AND
 *    DEAL_LEAD_SOURCE_OVERVIEW) sees non-zero data whenever possible;
 *  - developmentChannel: busiest channel WITHIN the picked development.
 * Nesting guarantees each combination has leads in range by construction.
 * Independently busy values could intersect to zero rows everywhere, and a
 * combination that passes 0-vs-0 on every check would be vacuous coverage
 * — so a missing nested value fails the audit exactly like a missing base
 * value does.
 */
async function pickRepresentativeFilters(
  startDate: string,
  toDate: string,
): Promise<{
  company: string;
  development: string;
  channel: string;
  leadSource: string;
  cohortQuarter: string;
  /** Busiest lead source inside `company` — combined-filter scenario */
  companyLeadSource: string;
  /** Busiest channel inside `development` — combined-filter scenario */
  developmentChannel: string;
}> {
  const [companyRows, devRows, channelRows, leadSourceRows, dealSourceRows, cohortRows] =
    await Promise.all([
    sfQuery<{ COMPANY_NAME: string }>(
      `SELECT D.COMPANY_NAME, COUNT(*) AS N
       FROM DM_CONTACTS C
       JOIN ${DEV_DIM} D ON C.CONTACT_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
       WHERE ${isLeadSql("C")} AND C.CONTACT_CREATE_DATE BETWEEN ? AND ?
       GROUP BY 1 ORDER BY N DESC LIMIT 1`,
      [startDate, toDate],
    ),
    sfQuery<{ DEVELOPMENT_NAME: string }>(
      `SELECT D.DEVELOPMENT_NAME, COUNT(*) AS N
       FROM DM_CONTACTS C
       JOIN ${DEV_DIM} D ON C.CONTACT_EHI_COMMUNITY_OF_INTEREST = D.DEVELOPMENT_NAME
       WHERE ${isLeadSql("C")} AND C.CONTACT_CREATE_DATE BETWEEN ? AND ?
       GROUP BY 1 ORDER BY N DESC LIMIT 1`,
      [startDate, toDate],
    ),
    sfQuery<{ CH: string }>(
      `SELECT C.ONSITE_ONLINE_SOURCE_CHANNEL AS CH, COUNT(*) AS N
       FROM DM_CONTACTS C
       WHERE ${isLeadSql("C")} AND C.CONTACT_CREATE_DATE BETWEEN ? AND ?
         AND C.ONSITE_ONLINE_SOURCE_CHANNEL IS NOT NULL
       GROUP BY 1 ORDER BY N DESC LIMIT 1`,
      [startDate, toDate],
    ),
    // All lead sources by contact-lead volume (not LIMIT 1): the pick below
    // prefers one that also has deals, falling back to the overall busiest.
    sfQuery<{ LS: string }>(
      `SELECT C.LEAD_SOURCE_OVERVIEW AS LS, COUNT(*) AS N
       FROM DM_CONTACTS C
       WHERE C.EHI_LEAD = 1 AND C.CONTACT_CREATE_DATE BETWEEN ? AND ?
         AND C.LEAD_SOURCE_OVERVIEW IS NOT NULL
       GROUP BY 1 ORDER BY N DESC`,
      [startDate, toDate],
    ),
    sfQuery<{ LS: string }>(
      `SELECT DISTINCT X.DEAL_LEAD_SOURCE_OVERVIEW AS LS
       FROM DM_DEALS X
       WHERE X.PIPELINE_NAME = 'Esperanza Homes Sales Pipeline'
         AND X.CONTRACT_RATIFIED_DATE BETWEEN ? AND ?
         AND X.DEAL_LEAD_SOURCE_OVERVIEW IS NOT NULL`,
      [startDate, toDate],
    ),
    sfQuery<{ CQ: string }>(
      `SELECT C.EHI_COHORT_QUARTER AS CQ, COUNT(*) AS N
       FROM DM_CONTACTS C
       WHERE C.EHI_LEAD = 1 AND C.CONTACT_CREATE_DATE BETWEEN ? AND ?
         AND C.EHI_COHORT_QUARTER IS NOT NULL
       GROUP BY 1 ORDER BY N DESC LIMIT 1`,
      [startDate, toDate],
    ),
  ]);
  const company = companyRows[0]?.COMPANY_NAME;
  const development = devRows[0]?.DEVELOPMENT_NAME;
  const channel = channelRows[0]?.CH;
  // Busiest lead source that also has ratified deals in range, so the
  // deal-side binding is exercised with non-zero data whenever possible;
  // otherwise the busiest by leads alone (deal checks then compare 0 vs 0).
  const dealSources = new Set(dealSourceRows.map((r) => r.LS));
  const leadSource =
    leadSourceRows.find((r) => dealSources.has(r.LS))?.LS ?? leadSourceRows[0]?.LS;
  const cohortQuarter = cohortRows[0]?.CQ;
  const missing = [
    !company && "company",
    !development && "development",
    !channel && "channel",
    !leadSource && "lead source",
    !cohortQuarter && "cohort quarter",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `No representative ${missing.join(", ")} found in ${startDate}..${toDate} — ` +
        "cannot exercise the required filtered scenarios (empty source data or broken dimension)",
    );
  }

  // Second round: combination values nested inside the base picks (they
  // depend on `company` / `development`, so they cannot join the batch
  // above). The company clause is the same DEV_DIM semi-join shape the
  // baselines bind, so "busy for the pick" and "busy for the baseline"
  // cannot drift apart.
  const [companyLeadSourceRows, companyDealSourceRows, developmentChannelRows] =
    await Promise.all([
      sfQuery<{ LS: string }>(
        `SELECT C.LEAD_SOURCE_OVERVIEW AS LS, COUNT(*) AS N
         FROM DM_CONTACTS C
         WHERE ${isLeadSql("C")} AND C.CONTACT_CREATE_DATE BETWEEN ? AND ?
           AND C.CONTACT_EHI_COMMUNITY_OF_INTEREST IN
               (SELECT DEVELOPMENT_NAME FROM ${DEV_DIM} WHERE COMPANY_NAME = ?)
           AND C.LEAD_SOURCE_OVERVIEW IS NOT NULL
         GROUP BY 1 ORDER BY N DESC`,
        [startDate, toDate, company!],
      ),
      sfQuery<{ LS: string }>(
        `SELECT DISTINCT X.DEAL_LEAD_SOURCE_OVERVIEW AS LS
         FROM DM_DEALS X
         WHERE ${isSaleSql("X")} AND X.CONTRACT_RATIFIED_DATE BETWEEN ? AND ?
           AND X.DEAL_EHI_COMMUNITY_OF_INTEREST IN
               (SELECT DEVELOPMENT_NAME FROM ${DEV_DIM} WHERE COMPANY_NAME = ?)
           AND X.DEAL_LEAD_SOURCE_OVERVIEW IS NOT NULL`,
        [startDate, toDate, company!],
      ),
      sfQuery<{ CH: string }>(
        `SELECT C.ONSITE_ONLINE_SOURCE_CHANNEL AS CH, COUNT(*) AS N
         FROM DM_CONTACTS C
         WHERE ${isLeadSql("C")} AND C.CONTACT_CREATE_DATE BETWEEN ? AND ?
           AND C.CONTACT_EHI_COMMUNITY_OF_INTEREST = ?
           AND C.ONSITE_ONLINE_SOURCE_CHANNEL IS NOT NULL
         GROUP BY 1 ORDER BY N DESC LIMIT 1`,
        [startDate, toDate, development!],
      ),
    ]);
  const companyDealSources = new Set(companyDealSourceRows.map((r) => r.LS));
  const companyLeadSource =
    companyLeadSourceRows.find((r) => companyDealSources.has(r.LS))?.LS ??
    companyLeadSourceRows[0]?.LS;
  const developmentChannel = developmentChannelRows[0]?.CH;
  const missingCombo = [
    !companyLeadSource && `lead source inside company "${company}"`,
    !developmentChannel && `channel inside development "${development}"`,
  ].filter(Boolean);
  if (missingCombo.length) {
    throw new Error(
      `No representative ${missingCombo.join(", ")} found in ${startDate}..${toDate} — ` +
        "cannot exercise the required combined-filter scenarios with non-empty data " +
        "(a combination passing 0-vs-0 everywhere would be vacuous coverage, not a safety net)",
    );
  }

  return {
    company: company!,
    development: development!,
    channel: channel!,
    leadSource: leadSource!,
    cohortQuarter: cohortQuarter!,
    companyLeadSource: companyLeadSource!,
    developmentChannel: developmentChannel!,
  };
}

/**
 * Explicit date-range scenario: January of the current default year when it
 * has fully elapsed (stable results), otherwise a deterministic single-day
 * range on the default quarter's start date. Both differ from the default
 * quarter bounds, so an endpoint that ignores date params fails the
 * appliedRange assertion. Never skipped.
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
/**
 * The most recent fully-elapsed quarter of the current year, or null during
 * Q1. Its elapsed cutoff sits in a PAST quarter, so the API's goal-type
 * walk-back must resolve THAT quarter's re-issue (e.g. goal_*_q2 with a
 * June 30 cutoff), not the newest one available — pinning the walk-back
 * against real goal data today, while the prior-year scenario carries the
 * pin for whole past years.
 */
function latestElapsedQuarterRange(): { startDate: string; endDate: string } | null {
  const t = new Date(todayChicago() + "T00:00:00");
  const q = Math.floor(t.getMonth() / 3); // 0-based current quarter
  if (q === 0) return null;
  const year = t.getFullYear();
  const startMonth = (q - 1) * 3 + 1;
  const end = new Date(year, q * 3, 0); // last day of the elapsed quarter
  return {
    startDate: `${year}-${String(startMonth).padStart(2, "0")}-01`,
    endDate: `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`,
  };
}
async function main() {
  console.log(
    `Auditing ${API_BASE}/dashboards/overview-with-targets (tolerance ${TOLERANCE_PCT}%)`,
  );

  const { startDate, endDate } = defaultQuarterRange();
  const toDate = expectedToDate(startDate, endDate);
  console.log(`Default range: ${startDate}..${endDate}, toDate=${toDate}`);

  const {
    company,
    development,
    channel,
    leadSource,
    cohortQuarter,
    companyLeadSource,
    developmentChannel,
  } = await pickRepresentativeFilters(startDate, toDate);

  const priorYear = Number(startDate.slice(0, 4)) - 1;
  const scenarios: Scenario[] = [
    {
      name: "default view",
      filters: {},
      withBreakdowns: true,
      withGaBreakdowns: true,
      withRatios: true,
      withChannelLabelGuard: true,
      withGaPropertyGuard: true,
      withGaFreshnessGuard: true,
      withGaFlagGuard: true,
    },
    { name: `company filter (${company})`, filters: { company }, withBreakdowns: true },
    { name: `development filter (${development})`, filters: { development } },
    { name: `channel filter (${channel})`, filters: { channel } },
    // leadSource must hit DM_CONTACTS.LEAD_SOURCE_OVERVIEW AND
    // DM_DEALS.DEAL_LEAD_SOURCE_OVERVIEW; cohortQuarter must hit contacts
    // ONLY (sales stay unfiltered). Breakdown audits are on for both so a
    // wrong-column binding also can't hide inside the per-division rows.
    {
      name: `lead-source filter (${leadSource})`,
      filters: { leadSource },
      withBreakdowns: true,
    },
    {
      name: `cohort-quarter filter (${cohortQuarter})`,
      filters: { cohortQuarter },
      withBreakdowns: true,
    },
    { ...explicitRangeScenario(startDate), withBreakdowns: true },
    // COMBINED filters — users stack these in the UI, and a bug that only
    // appears when fragments compose (the company semi-join interacting
    // with a lead-source predicate, binds appended in the wrong order)
    // passes every single-filter scenario above. Values are nested picks
    // (busiest lead source inside the picked company, busiest channel
    // inside the picked development), so each combination has leads in
    // range by construction — never an all-0-vs-0 vacuous pass. The second
    // combo also binds explicit dates (the elapsed default quarter — the
    // exact window the picks are busy in), so the two date binds precede a
    // multi-filter fragment's binds just as the API's own queries order
    // them; its appliedRange assertion still bites because the explicit
    // endDate (today) differs from the default quarter end.
    {
      name: `combined company + lead source (${company} × ${companyLeadSource})`,
      filters: { company, leadSource: companyLeadSource },
    },
    {
      name:
        `combined development + channel + explicit dates ` +
        `(${development} × ${developmentChannel}, ${startDate}..${toDate})`,
      filters: {
        development,
        channel: developmentChannel,
        startDate,
        endDate: toDate,
      },
    },
    {
      name: `prior fiscal year (${priorYear}) — past-year target resolution`,
      filters: {
        startDate: `${priorYear}-01-01`,
        endDate: `${priorYear}-12-31`,
      },
      pinTargets: true,
    },
  ];
  const elapsedQuarter = latestElapsedQuarterRange();
  if (elapsedQuarter) {
    scenarios.push({
      name: `elapsed quarter (${elapsedQuarter.startDate}..${elapsedQuarter.endDate}) — goal walk-back pin`,
      filters: elapsedQuarter,
      pinTargets: true,
    });
  } else {
    console.log(
      "note: no fully-elapsed quarter in the current year yet (Q1) — the goal-type " +
        "walk-back value pin runs through the prior-year scenario instead",
    );
  }
  console.log(
    `Scenarios: ${scenarios
      .map((s) => `${s.name}${s.withBreakdowns ? " [+breakdowns]" : ""}`)
      .join("; ")}`,
  );

  let anyFailed = false;
  for (const scenario of scenarios) {
    const result = await auditScenario(scenario);
    if (!result.ok) anyFailed = true;
    if (!result.rangeOk) {
      // Baselines would be bound to a range the API never applied; the
      // appliedRange failure above already fails the run.
      console.error(
        `Skipping goal/breakdown/ratio/drill-down audits for "${scenario.name}" — appliedRange mismatch`,
      );
      continue;
    }
    // The unknown-bucket record lists ride inside the overview response and
    // must reconcile with its matrix in EVERY scenario (free: pure checks
    // on the already-fetched payload, no extra requests).
    {
      const drilldownOk = auditUnknownRecordsDrilldown(
        scenario,
        result.overview,
        result.expStart,
        result.expTo,
      );
      if (!drilldownOk) anyFailed = true;
    }
    // Goal-derived numbers are audited in EVERY scenario: goals respond to
    // company/development filters, must ignore channel filters, and rebind
    // their BUDGET_DATE window + quarter resolution to explicit date ranges.
    // pinTargets scenarios are the exception: they value-pin every target
    // cell themselves, and pre-regime years resolve no goal_* types by
    // design — auditGoals' unresolved-metric gate would false-fail there.
    if (!scenario.pinTargets) {
      const goalsOk = await auditGoals(
        scenario,
        result.overview,
        result.expStart,
        result.expEnd,
        result.expTo,
      );
      if (!goalsOk) anyFailed = true;
    }
    if (!scenario.withBreakdowns && !scenario.withGaBreakdowns && !scenario.withRatios) {
      continue;
    }
    if (scenario.withBreakdowns) {
      const breakdownsOk = await auditBreakdowns(
        scenario,
        result.overview,
        result.expStart,
        result.expTo,
      );
      if (!breakdownsOk) anyFailed = true;
    }
    // Website-user columns of the same tables — separate GA-side baselines.
    if (scenario.withGaBreakdowns) {
      const gaBreakdownsOk = await auditWebsiteUserBreakdowns(
        result.overview,
        result.expStart,
        result.expTo,
      );
      if (!gaBreakdownsOk) anyFailed = true;
    }
    // Funnel ratios table — actuals recomputed from the scenario's already-
    // validated headline baseline counts (no extra Snowflake round trips),
    // goals cross-checked against the ratio-goal input table. headline is
    // always set when rangeOk is true (checked above).
    if (scenario.withRatios) {
      const ratiosOk = await auditRatios(result.overview, result.expStart, result.headline!);
      if (!ratiosOk) anyFailed = true;
    }
  }

  // Community List — rows, flags, and selling status vs the raw dimension.
  const communitiesOk = await auditCommunities();
  if (!communitiesOk) anyFailed = true;

  if (anyFailed) {
    console.error(
      "\nAUDIT FAILED: dashboard totals diverge from independent Snowflake baselines " +
        "in at least one scenario. Likely causes: join fan-out in the attribution " +
        "dimension, a filter bound to the wrong column, a GA grouping regression, " +
        "an online/onsite split keyed to the wrong channel column or with swapped " +
        "labels, upstream renaming of the 'Online'/'Onsite' channel values (see any " +
        "chLabels guard failure above), upstream renaming of the GA PROPERTY values " +
        "(see any gaProperty guard failure above), upstream relabeling of the GA Yes/No " +
        "flag values like IS_NEW_USER (see any gaFlag guard failure above), a mis-wired funnel ratio, a stale ratio-goal " +
        "name, a goal-type walk-back/target-resolution regression, a wrong " +
        "GOAL_TYPE resolution or broken goal to-date cutoff, ignored date " +
        "parameters, changed filters, stale cached data, " +
        "mislabeled/hidden communities or per-community YTD numbers drifting " +
        "from Snowflake in the Community List, or the unknown-channel " +
        "drill-down list disagreeing with its matrix bucket.",
    );
    process.exit(1);
  }
  console.log("\nAudit passed: all totals within tolerance across all scenarios.");
  process.exit(0);
}
/**
 * Audits every goal-derived number in one scenario's response: the KPI
 * row's salesGoal / salesTdGoal, each traffic-matrix cell's fullSpanGoal /
 * toDateGoal, and the PTG figures arithmetically derived from them
 * (ptgPercent per cell; ptgVariance / ptgPercent on the KPI row).
 *
 * Baselines re-resolve the expected GOAL_TYPE per metric via
 * expectedGoalType and recompute both sums WITHOUT the API's conditional
 * aggregation: full-span is SUM(GOAL) over BUDGET_DATE BETWEEN start AND
 * end, to-date is SUM(GOAL) over BUDGET_DATE BETWEEN start AND toDate —
 * two plain windows instead of one SUM(IFF(...)). Regression classes per
 * scenario:
 *  - default view: wrong GOAL_TYPE resolution (e.g. stale quarter picked),
 *    broken to-date cutoff, broken daily-distributed sums
 *  - company / development filters: goal filters bound to the wrong
 *    DM_GOALS column (COMPANY_NAME vs DEVELOPMENT_NAME)
 *  - channel filter: filters leaking into the goal query — goals have no
 *    channel dimension, so its goals must equal the default view's
 *  - explicit date range: BUDGET_DATE window and quarter resolution bound
 *    to the requested range (its toDate), not to today
 *
 * PTG checks recompute from the API's OWN actual + toDateGoal, isolating
 * derivation bugs from goal-sum divergence (already caught above).
 */
async function auditGoals(
  scenario: Scenario,
  overview: OverviewResponse,
  expStart: string,
  expEnd: string,
  expTo: string,
): Promise<boolean> {
  console.log(`\n=== Goals & targets (${scenario.name}) ===`);

  // The audit sends no target param, so the API must apply its documented
  // default. Resolving types for whatever the response echoes back would
  // let a silently changed default validate itself.
  const expTarget = "goal";
  if (overview.appliedRange.target !== expTarget) {
    console.error(
      `FAIL target mismatch: expected default '${expTarget}', got '${overview.appliedRange.target}' — ` +
        "goal baselines would be resolved against the wrong target",
    );
    return false;
  }

  const fiscalYear = Number(expStart.slice(0, 4));
  const available = await availableGoalTypes(fiscalYear);
  const typeByMetric = new Map<GoalMetric, string>();
  const unresolved: GoalMetric[] = [];
  for (const metric of GOAL_METRICS) {
    const gt = expectedGoalType(available, expTarget, metric, expTo);
    if (gt) typeByMetric.set(metric, gt);
    else unresolved.push(metric);
  }
  const types = [...new Set(typeByMetric.values())];

  // GOAL_TYPE resolution is global — it reads the fiscal year's DISTINCT
  // type names, which no company/development/channel row filter changes —
  // so EVERY dashboard metric must resolve in EVERY scenario. A single
  // unresolved metric (one renamed or dropped GOAL_TYPE) is the silent
  // zero-target regression this audit exists to catch: the API and a
  // proceed-as-zero baseline would both compute 0 for that cell and
  // "agree". Fail by name instead of comparing 0 == 0.
  if (unresolved.length > 0) {
    console.error(
      `FAIL unresolved GOAL_TYPE for ${unresolved.length}/${GOAL_METRICS.length} metric(s) ` +
        `(target '${expTarget}', FY${fiscalYear}, toDate ${expTo}): ${unresolved.join(", ")} — ` +
        `no '${expTarget}_<metric>_qN' name (N <= toDate's quarter) exists among the fiscal ` +
        `year's GOAL_TYPEs for them. Goal naming drifted or goals were not loaded; the ` +
        `dashboard would silently show zero targets for these cells.`,
    );
    return false;
  }

  let failed = false;
  const unfiltered = !scenario.filters.company && !scenario.filters.development;

  const gfr = goalFrag(scenario.filters);
  const placeholders = types.map(() => "?").join(",");
  const goalSums = (from: string, to: string) =>
    sfQuery<GoalBaselineRow>(
      `SELECT GOAL_TYPE, SUM(GOAL) AS N
       FROM DM_GOALS
       WHERE FISCAL_YEAR = ?
         AND GOAL_TYPE IN (${placeholders})
         AND BUDGET_DATE BETWEEN ? AND ?${gfr.sql}
       GROUP BY 1`,
      [fiscalYear, ...types, from, to, ...gfr.binds],
    );
  const [fullRows, toDateRows] = await Promise.all([
    goalSums(expStart, expEnd),
    goalSums(expStart, expTo),
  ]);
  const fullByType = new Map(fullRows.map((r) => [r.GOAL_TYPE, Number(r.N) || 0]));
  const tdByType = new Map(toDateRows.map((r) => [r.GOAL_TYPE, Number(r.N) || 0]));

  const totalFullSpan = [...fullByType.values()].reduce((a, b) => a + b, 0);
  if (unfiltered && totalFullSpan === 0) {
    // Types resolved but the window has no goal rows: the dashboard would
    // show all-zero targets. Only a filtered subset may legitimately do so.
    console.error(
      `FAIL all resolved goal baselines sum to zero in ${expStart}..${expEnd} ` +
        `(types: ${types.join(", ")}) — goal rows missing for the window; ` +
        "dashboard targets would all be zero",
    );
    failed = true;
  } else if (!unfiltered && totalFullSpan === 0) {
    // Distinct from unresolved types (a hard failure above): this subset
    // simply has no goal rows, which is legitimate — the API's cells must
    // then equal 0, and the per-cell comparisons below enforce exactly that.
    console.log(
      `note: resolved goal types carry zero rows under this filter — ` +
        `legitimate for a company/development without goals; API goal cells must be 0`,
    );
  }

  const tm = overview.trafficMatrix;
  const cells: { label: string; metric: GoalMetric; cell: GoalCell }[] = [
    { label: "online.websiteUsers", metric: "web_traffic", cell: tm.online.websiteUsers },
    { label: "online.leads", metric: "online_leads", cell: tm.online.leads },
    { label: "online.tours", metric: "online_first_tours", cell: tm.online.tours },
    { label: "online.sales", metric: "online_gross_sales", cell: tm.online.sales },
    { label: "onsite.leads", metric: "onsite_leads", cell: tm.onsite.leads },
    { label: "onsite.tours", metric: "onsite_first_tours", cell: tm.onsite.tours },
    { label: "onsite.sales", metric: "onsite_gross_sales", cell: tm.onsite.sales },
    { label: "total.leads", metric: "leads", cell: tm.total.leads },
    { label: "total.tours", metric: "first_tours", cell: tm.total.tours },
    {
      label: "kpi.grossSales",
      metric: "gross_sales",
      cell: {
        fullSpanGoal: overview.kpis.salesGoal,
        toDateGoal: overview.kpis.salesTdGoal,
        actual: overview.kpis.grossSales,
        ptgPercent: overview.kpis.ptgPercent,
      },
    },
  ];

  for (const { label, metric, cell } of cells) {
    const gt = typeByMetric.get(metric);
    const expFull = gt ? (fullByType.get(gt) ?? 0) : 0;
    const expTd = gt ? (tdByType.get(gt) ?? 0) : 0;
    const gtNote = gt ?? "(no goal type)";
    for (const [kind, api, baseline] of [
      ["fullSpan", cell.fullSpanGoal, expFull],
      ["toDate  ", cell.toDateGoal, expTd],
    ] as const) {
      const d = divergedPct(api, baseline);
      const ok = d <= TOLERANCE_PCT;
      console.log(
        `${ok ? "OK  " : "FAIL"} goal ${kind} ${label.padEnd(19)} ${gtNote.padEnd(28)} api=${api} baseline=${baseline} divergence=${d.toFixed(3)}%`,
      );
      if (!ok) failed = true;
    }
    // PTG must be derived from the cell's own actual & to-date goal.
    const expPtg = derivedPtg(cell.actual, cell.toDateGoal);
    const ptgOk = closeEnough(cell.ptgPercent, expPtg);
    console.log(
      `${ptgOk ? "OK  " : "FAIL"} goal ptg      ${label.padEnd(19)} api=${fmtNullable(cell.ptgPercent)} derived=${fmtNullable(expPtg)}`,
    );
    if (!ptgOk) failed = true;
  }

  // KPI variance is the remaining derived figure: actual - to-date goal.
  const expVariance = overview.kpis.grossSales - overview.kpis.salesTdGoal;
  const varOk = closeEnough(overview.kpis.ptgVariance, expVariance);
  console.log(
    `${varOk ? "OK  " : "FAIL"} goal variance kpi.grossSales      api=${overview.kpis.ptgVariance} derived=${expVariance}`,
  );
  if (!varOk) failed = true;

  return !failed;
}
const GOALS_FLAG_VALUES = new Set(["Has Goals", "No Goals"]);

main().catch((err) => {
  console.error("AUDIT ERRORED:", err instanceof Error ? err.message : err);
  process.exit(1);
});

interface RatioGoalBaselineRow {
  NAME: string;
  VAL: number | null;
}

/**
 * Audits the funnel ratios table of the DEFAULT view.
 *
 * Actuals: every ratio is recomputed from the independent baseline counts
 * the default view's headline checks already computed and validated (one
 * conditional-aggregation scan per source; the channel variants come from
 * COUNT_IFs on ONSITE_ONLINE_SOURCE_CHANNEL / the deal channel column, not
 * from the API's own channel splits — and the default view binds no filter
 * fragments, so those counts cover exactly the rows the old per-ratio
 * group-bys counted). Reusing them checks the same values while saving four
 * Snowflake round trips per run. The expected numerator/denominator wiring
 * below is the dashboard's contract (validated against Qlik during
 * migration); a swapped pair or a ratio fed by the wrong actual diverges by
 * orders of magnitude, far beyond any drift tolerance. Division-by-zero
 * mirrors the API's convention (ratio = 0), so both sides agree when a
 * denominator is legitimately empty.
 *
 * Goals: each ratio's goal must resolve by MARKETING_GOAL_NAME_RATIOS in
 * DM_MARKETING_DASHBOARD_INPUT_GOAL_RATIOS for the audited fiscal year
 * (year of the range start, the API's own convention) and match the API's
 * ratios[].goal. The check is bidirectional: a dashboard ratio whose name
 * no longer resolves (dbt rename), an API goal that is null despite a
 * resolvable table row, an input-table goal row no dashboard ratio consumes
 * (orphan left behind by a rename), and conflicting duplicate table rows
 * all fail. Coverage is also bidirectional — an API ratio this audit does
 * not know, a missing expected ratio, or a duplicate API ratio name fails
 * rather than being skipped.
 */
async function auditRatios(
  overview: OverviewResponse,
  expStart: string,
  base: HeadlineBaselines,
): Promise<boolean> {
  console.log(`\n=== Funnel ratios table (default view) ===`);

  // Fiscal year the API sources ratio goals from: year of the range start.
  const goalYear = Number(expStart.slice(0, 4));

  const goalRows = await sfQuery<RatioGoalBaselineRow>(
    `SELECT MARKETING_GOAL_NAME_RATIOS AS NAME, MARKETING_GOAL_RATIOS AS VAL
     FROM DM_MARKETING_DASHBOARD_INPUT_GOAL_RATIOS
     WHERE MARKETING_GOAL_YEAR = ?`,
    [goalYear],
  );

  // Totals include rows with a NULL/other channel, same as the API's chan()
  // (the headline COUNT_IFs put every in-window row in the total and only
  // channel-labeled rows in the online/onsite variants).
  const counts = {
    users: base.users,
    leads: base.leads,
    onlineLeads: base.onlineLeads,
    onsiteLeads: base.onsiteLeads,
    tours: base.tours,
    onlineTours: base.onlineTours,
    onsiteTours: base.onsiteTours,
    sales: base.sales,
    onlineSales: base.onlineSales,
    onsiteSales: base.onsiteSales,
  };
  console.log(`Baseline counts: ${JSON.stringify(counts)}`);

  // Expected wiring of every ratio the dashboard shows (numerator/denominator
  // over the baseline counts). Names must match the API's ratios[].name AND
  // the input table's MARKETING_GOAL_NAME_RATIOS values.
  const spec: { name: string; num: number; den: number }[] = [
    { name: "Total Traffic to Total Lead", num: counts.leads, den: counts.users },
    { name: "Total Lead to Total Tour", num: counts.tours, den: counts.leads },
    { name: "Total Tour to Contract", num: counts.sales, den: counts.tours },
    { name: "Total Lead to Total Sale", num: counts.sales, den: counts.leads },
    { name: "Online Traffic to Online Lead", num: counts.onlineLeads, den: counts.users },
    { name: "Online Lead to Online Tour", num: counts.onlineTours, den: counts.onlineLeads },
    { name: "Online Tour to Online Sale", num: counts.onlineSales, den: counts.onlineTours },
    { name: "Online Sales Contribution", num: counts.onlineSales, den: counts.sales },
    { name: "Onsite Lead to Onsite Tour", num: counts.onsiteTours, den: counts.onsiteLeads },
    { name: "Onsite Tour to Onsite Sale", num: counts.onsiteSales, den: counts.onsiteTours },
  ];
  const specNames = new Set(spec.map((s) => s.name));

  // A ratio's numerator and denominator may each legitimately drift by up to
  // TOLERANCE_PCT between the API's (possibly cached) read and the fresh
  // baselines, so their quotient may drift by up to (1+t)/(1-t)-1 — use the
  // exact compounded bound instead of flagging worst-case drift as mis-wiring.
  // Real wiring bugs diverge by orders of magnitude more than this.
  const t = TOLERANCE_PCT / 100;
  const ratioTolerancePct = ((1 + t) / (1 - t) - 1) * 100;

  let failed = false;

  // --- 0. Structure: no duplicate ratio names in the API response ---
  const apiByName = new Map<string, RatioRow>();
  for (const r of overview.ratios) {
    if (apiByName.has(r.name)) {
      console.error(`FAIL ratio     duplicate name in API response: "${r.name}"`);
      failed = true;
    }
    apiByName.set(r.name, r);
  }

  // --- 1. Coverage in both directions ---
  for (const r of overview.ratios) {
    if (!specNames.has(r.name)) {
      console.error(
        `FAIL ratio     unknown ratio "${r.name}" in API response — audit spec does not cover it; update the audit`,
      );
      failed = true;
    }
  }
  for (const s of spec) {
    if (!apiByName.has(s.name)) {
      console.error(`FAIL ratio     missing from API response: "${s.name}"`);
      failed = true;
    }
  }

  // --- 2. Actuals: recomputed ratio vs ratios[].actual ---
  for (const s of spec) {
    const api = apiByName.get(s.name);
    if (!api) continue; // already failed coverage above
    const expected = s.den ? s.num / s.den : 0;
    const apiActual = Number(api.actual) || 0;
    const d = divergedPct(apiActual, expected);
    const ok = d <= ratioTolerancePct;
    console.log(
      `${ok ? "OK  " : "FAIL"} ratio     ${s.name.padEnd(30)} api=${apiActual.toFixed(6)} baseline=${expected.toFixed(6)} (${s.num}/${s.den}) divergence=${d.toFixed(3)}%`,
    );
    if (!ok) failed = true;
  }

  // --- 3. Goals: forward — every dashboard ratio must resolve and match ---
  const goalTable = new Map<string, number>();
  for (const r of goalRows) {
    if (r.VAL == null) continue; // valueless rows are invisible to the API too
    const existing = goalTable.get(r.NAME);
    if (existing !== undefined && existing !== Number(r.VAL)) {
      console.error(
        `FAIL ratiogoal conflicting duplicate rows for "${r.NAME}" (year ${goalYear}): ${existing} vs ${r.VAL} — goal lookup is ambiguous`,
      );
      failed = true;
    }
    goalTable.set(r.NAME, Number(r.VAL));
  }
  for (const s of spec) {
    const tableGoal = goalTable.get(s.name);
    if (tableGoal === undefined) {
      console.error(
        `FAIL ratiogoal "${s.name}" no longer resolves in DM_MARKETING_DASHBOARD_INPUT_GOAL_RATIOS for year ${goalYear} (renamed or removed upstream?)`,
      );
      failed = true;
      continue;
    }
    const api = apiByName.get(s.name);
    if (!api) continue; // already failed coverage above
    if (api.goal == null) {
      console.error(
        `FAIL ratiogoal ${s.name.padEnd(30)} api=null table=${tableGoal} — API dropped a goal the input table defines`,
      );
      failed = true;
      continue;
    }
    const d = divergedPct(Number(api.goal), tableGoal);
    const ok = d <= TOLERANCE_PCT;
    console.log(
      `${ok ? "OK  " : "FAIL"} ratiogoal ${s.name.padEnd(30)} api=${Number(api.goal)} table=${tableGoal} divergence=${d.toFixed(3)}%`,
    );
    if (!ok) failed = true;
  }

  // --- 4. Goals: reverse — no orphaned input-table rows for the year ---
  for (const name of [...goalTable.keys()].sort()) {
    if (!specNames.has(name)) {
      console.error(
        `FAIL ratiogoal orphaned input-table row "${name}" (year ${goalYear}) — no dashboard ratio consumes it (renamed upstream, or the dashboard is missing a ratio)`,
      );
      failed = true;
    }
  }

  return !failed;
}

const RENTAL_FLAG_VALUES = new Set(["Rental", "For Sale"]);

/** Snowflake-style binary string compare (locale collation would diverge). */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Audits GET /dashboards/communities against independent baselines:
 *
 *  0. Label-domain guard: flag columns must only hold the documented labels
 *     ('Has Goals'/'No Goals', 'Rental'/'For Sale', NULL). Both the API and
 *     this audit compare exact labels, so an upstream relabel would silently
 *     turn every badge false on BOTH sides and still agree — this guard is
 *     what makes the flag baselines trustworthy.
 *  1. Row identity: exactly one API row per distinct Esperanza development in
 *     the raw dimension — a missing development is a community hidden
 *     entirely; a duplicate is join fan-out.
 *  2. Counts: total / selling / hasGoals / isRental, compared EXACTLY (the
 *     whole point is catching single-community mistakes, so no % tolerance).
 *  3. Per-community flags: hasGoals (any raw row carries 'Has Goals'),
 *     isRental (flag of the preferred row: goal-carrying rows first, then
 *     COMPANY_NAME — recomputed in JS from raw rows, independent of the
 *     API's QUALIFY dedup), and isSelling (hasGoals or any YTD activity from
 *     plain GROUP BYs with no dimension join).
 *  4. Self-consistency: isSelling === hasGoals || leads+tours+sales > 0 over
 *     the API's OWN row values — catches a hide-rule regression even when
 *     both sides of the cross-source comparison drift together.
 *  5. Displayed YTD numbers: each row's leadsYtd/toursYtd/salesYtd against
 *     the same plain-GROUP-BY baselines, within a cache-drift window (see
 *     the section comment) — a broken join in the endpoint's L/T/S CTEs
 *     that inflates or zeroes a community's numbers fails even when the
 *     zero-vs-nonzero selling status survives.
 *
 * The endpoint caches per Chicago day, so a community whose first-ever YTD
 * activity lands between the cache fill and this audit could transiently
 * flip isSelling; that is vanishingly rare and a rerun clears it. The
 * numeric YTD check tolerates that same cache lag deliberately (today-dated
 * activity plus a small slack), so it does not flake intraday.
 */
async function auditCommunities(): Promise<boolean> {
  console.log(`\n=== Community List (/dashboards/communities) ===`);

  // The endpoint defines YTD on the America/Chicago business calendar (Jan 1
  // of the current Chicago year through the current Chicago date), like every
  // other dashboard; the baseline mirrors that window exactly.
  const todayChi = todayChicago();
  const ytdStart = `${todayChi.slice(0, 4)}-01-01`;
  console.log(`YTD window: ${ytdStart}..${todayChi}`);

  const url = `${API_BASE}/dashboards/communities`;
  let body: { communities: CommunityRow[] };
  try {
    // Transport hiccups and transient 429/5xx are retried by the shared
    // helper; a persistent or non-transient failure is a real audit failure.
    body = await fetchJsonWithRetry<{ communities: CommunityRow[] }>(url);
  } catch (err) {
    console.error(`FAIL GET ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  if (!Array.isArray(body.communities)) {
    console.error("FAIL response has no communities array");
    return false;
  }
  const apiRows = body.communities;

  const [dimRows, leadRows, tourRows, saleRows] = await Promise.all([
    sfQuery<DimRawRow>(
      `SELECT DEVELOPMENT_NAME, COMPANY_NAME,
              DEVELOPMENT_HAS_GOALS_FLAG, RENTAL_COMMUNITY_FLAG
       FROM DM_COMPANY_DEVELOPMENT
       WHERE COMPANY_NAME ILIKE '%esperanza%'`,
    ),
    // Each YTD baseline also splits out how much of the count is stamped with
    // today's Chicago date (N_TODAY) — the only slice the endpoint's
    // per-Chicago-day cache can legitimately lag behind; it must use the SAME
    // "today" as the endpoint's window or the drift check breaks. Bind order:
    // COUNT_IF's ? precedes the WHERE BETWEEN binds in SQL text order.
    sfQuery<YtdBaselineRow>(
      `SELECT CONTACT_EHI_COMMUNITY_OF_INTEREST AS DEV, COUNT(*) AS N,
              COUNT_IF(CONTACT_CREATE_DATE = ?) AS N_TODAY
       FROM DM_CONTACTS
       WHERE ${isLeadSql()} AND CONTACT_CREATE_DATE BETWEEN ? AND ?
       GROUP BY 1`,
      [todayChi, ytdStart, todayChi],
    ),
    sfQuery<YtdBaselineRow>(
      `SELECT CONTACT_EHI_COMMUNITY_OF_INTEREST AS DEV, COUNT(*) AS N,
              COUNT_IF(EHI_MIN_FIRST_TOUR_DATE = ?) AS N_TODAY
       FROM DM_CONTACTS
       WHERE ${isLeadSql()} AND EHI_MIN_FIRST_TOUR_DATE BETWEEN ? AND ?
       GROUP BY 1`,
      [todayChi, ytdStart, todayChi],
    ),
    sfQuery<YtdBaselineRow>(
      `SELECT DEAL_EHI_COMMUNITY_OF_INTEREST AS DEV, COUNT(*) AS N,
              COUNT_IF(CONTRACT_RATIFIED_DATE = ?) AS N_TODAY
       FROM DM_DEALS
       WHERE ${isSaleSql()}
         AND CONTRACT_RATIFIED_DATE BETWEEN ? AND ?
       GROUP BY 1`,
      [todayChi, ytdStart, todayChi],
    ),
  ]);

  if (dimRows.length === 0) {
    console.error(
      "FAIL baseline dimension query returned no Esperanza rows — empty source data or broken dimension",
    );
    return false;
  }

  let failed = false;

  // --- 0. Label-domain guard ---
  const badGoals = new Set<string>();
  const badRental = new Set<string>();
  for (const r of dimRows) {
    const g = r.DEVELOPMENT_HAS_GOALS_FLAG;
    if (g != null && !GOALS_FLAG_VALUES.has(g)) badGoals.add(g);
    const rf = r.RENTAL_COMMUNITY_FLAG;
    if (rf != null && !RENTAL_FLAG_VALUES.has(rf)) badRental.add(rf);
  }
  if (badGoals.size || badRental.size) {
    if (badGoals.size) {
      console.error(
        `FAIL unexpected DEVELOPMENT_HAS_GOALS_FLAG label(s): ${[...badGoals].map((v) => JSON.stringify(v)).join(", ")} — flag comparisons can no longer be trusted`,
      );
    }
    if (badRental.size) {
      console.error(
        `FAIL unexpected RENTAL_COMMUNITY_FLAG label(s): ${[...badRental].map((v) => JSON.stringify(v)).join(", ")} — flag comparisons can no longer be trusted`,
      );
    }
    failed = true;
  } else {
    console.log("OK   flag labels within documented value sets");
  }

  // --- Baseline per development, recomputed in JS from raw rows ---
  const toCountMaps = (rows: YtdBaselineRow[]) => {
    const total = new Map<string, number>();
    const today = new Map<string, number>();
    for (const r of rows) {
      if (r.DEV) {
        total.set(r.DEV, Number(r.N) || 0);
        today.set(r.DEV, Number(r.N_TODAY) || 0);
      }
    }
    return { total, today };
  };
  const { total: leadsBy, today: leadsToday } = toCountMaps(leadRows);
  const { total: toursBy, today: toursToday } = toCountMaps(tourRows);
  const { total: salesBy, today: salesToday } = toCountMaps(saleRows);

  const rowsByDev = new Map<string, DimRawRow[]>();
  for (const r of dimRows) {
    const list = rowsByDev.get(r.DEVELOPMENT_NAME);
    if (list) list.push(r);
    else rowsByDev.set(r.DEVELOPMENT_NAME, [r]);
  }
  const baseline = new Map<
    string,
    { hasGoals: boolean; isRental: boolean; isSelling: boolean }
  >();
  for (const [dev, rows] of rowsByDev) {
    const hasGoals = rows.some((r) => r.DEVELOPMENT_HAS_GOALS_FLAG === "Has Goals");
    const preferred = [...rows].sort(
      (a, b) =>
        Number(a.DEVELOPMENT_HAS_GOALS_FLAG !== "Has Goals") -
          Number(b.DEVELOPMENT_HAS_GOALS_FLAG !== "Has Goals") ||
        cmp(a.COMPANY_NAME, b.COMPANY_NAME),
    )[0];
    const hasActivity =
      (leadsBy.get(dev) ?? 0) > 0 ||
      (toursBy.get(dev) ?? 0) > 0 ||
      (salesBy.get(dev) ?? 0) > 0;
    baseline.set(dev, {
      hasGoals,
      isRental: preferred.RENTAL_COMMUNITY_FLAG === "Rental",
      isSelling: hasGoals || hasActivity,
    });
  }

  // --- 1. Row identity (both directions + duplicates) ---
  const apiByDev = new Map<string, CommunityRow>();
  for (const r of apiRows) {
    if (apiByDev.has(r.development)) {
      console.error(
        `FAIL duplicate API row for development "${r.development}" — join fan-out?`,
      );
      failed = true;
    }
    apiByDev.set(r.development, r);
  }
  let identityIssues = 0;
  for (const dev of [...baseline.keys()].sort(cmp)) {
    if (!apiByDev.has(dev)) {
      console.error(
        `FAIL community missing from API response: "${dev}" — hidden from the list entirely`,
      );
      failed = true;
      identityIssues++;
    }
  }
  for (const dev of [...apiByDev.keys()].sort(cmp)) {
    if (!baseline.has(dev)) {
      console.error(`FAIL unexpected API row with no dimension baseline: "${dev}"`);
      failed = true;
      identityIssues++;
    }
  }
  if (!identityIssues) {
    console.log(
      `OK   row identity: API returns exactly the ${baseline.size} baseline developments`,
    );
  }

  // --- 2. Counts (exact — no tolerance) ---
  const countOf = <T>(rows: Iterable<T>, pred: (r: T) => boolean) => {
    let c = 0;
    for (const r of rows) if (pred(r)) c++;
    return c;
  };
  const countChecks = [
    { name: "total", api: apiRows.length, baseline: baseline.size },
    {
      name: "selling",
      api: countOf(apiRows, (r) => r.isSelling === true),
      baseline: countOf(baseline.values(), (b) => b.isSelling),
    },
    {
      name: "hasGoals",
      api: countOf(apiRows, (r) => r.hasGoals === true),
      baseline: countOf(baseline.values(), (b) => b.hasGoals),
    },
    {
      name: "isRental",
      api: countOf(apiRows, (r) => r.isRental === true),
      baseline: countOf(baseline.values(), (b) => b.isRental),
    },
  ];
  for (const c of countChecks) {
    const ok = c.api === c.baseline;
    console.log(
      `${ok ? "OK  " : "FAIL"} count ${c.name.padEnd(9)} api=${c.api} baseline=${c.baseline}`,
    );
    if (!ok) failed = true;
  }

  // --- 3. Per-community flag comparison ---
  let flagMismatches = 0;
  let sharedRows = 0;
  for (const [dev, base] of [...baseline].sort((a, b) => cmp(a[0], b[0]))) {
    const api = apiByDev.get(dev);
    if (!api) continue; // already reported as missing
    sharedRows++;
    for (const flag of ["hasGoals", "isRental", "isSelling"] as const) {
      if (api[flag] !== base[flag]) {
        const note =
          flag === "isSelling" && !api[flag]
            ? " — selling community would be hidden by default"
            : "";
        console.error(
          `FAIL flag ${flag} for "${dev}": api=${api[flag]} baseline=${base[flag]}${note}`,
        );
        flagMismatches++;
        failed = true;
      }
    }
  }
  if (!flagMismatches) {
    console.log(
      `OK   flags hasGoals/isRental/isSelling match baseline on all ${sharedRows} shared rows`,
    );
  }

  // --- 4. isSelling invariant over the API's own values ---
  let invariantViolations = 0;
  for (const r of apiRows) {
    const expected =
      r.hasGoals === true ||
      (Number(r.leadsYtd) || 0) > 0 ||
      (Number(r.toursYtd) || 0) > 0 ||
      (Number(r.salesYtd) || 0) > 0;
    if (r.isSelling !== expected) {
      console.error(
        `FAIL isSelling invariant for "${r.development}": isSelling=${r.isSelling} but ` +
          `hasGoals=${r.hasGoals} leadsYtd=${r.leadsYtd} toursYtd=${r.toursYtd} salesYtd=${r.salesYtd}`,
      );
      invariantViolations++;
      failed = true;
    }
  }
  if (!invariantViolations) {
    console.log(
      `OK   isSelling === hasGoals || leads+tours+sales > 0 holds for all ${apiRows.length} rows`,
    );
  }

  // --- 5. Displayed YTD numbers vs independent per-community baselines ---
  // The endpoint caches per Chicago day, so its L/T/S counts reflect Snowflake as
  // of some earlier moment TODAY, while the baselines above are fresh. In
  // between, new rows stamped with today's date can land (and, rarely,
  // past-dated rows get restated). Exact equality would flake on every busy
  // afternoon, so each value is checked against the cache-consistent window
  //
  //   baseline − todayCount − slack  ≤  api  ≤  baseline + slack
  //
  // where todayCount is that community's activity dated today (the only slice
  // the cache can legitimately lag behind) and slack = max(2, TOLERANCE_PCT%
  // of baseline) absorbs small restatements of past days. The bound stays
  // tight when a community had no activity today — the common case — yet
  // never flakes in January or on high-traffic days, and it holds no matter
  // how stale within the day the cache is allowed to get. A broken join in
  // the endpoint's L/T/S CTEs (zeroed, duplicated, or cross-wired counts)
  // diverges far beyond this window.
  const slackFor = (baseline: number) =>
    Math.max(2, Math.ceil((baseline * TOLERANCE_PCT) / 100));
  const ytdSpecs = [
    { col: "leadsYtd", totals: leadsBy, today: leadsToday },
    { col: "toursYtd", totals: toursBy, today: toursToday },
    { col: "salesYtd", totals: salesBy, today: salesToday },
  ] as const;
  let ytdMismatches = 0;
  let ytdChecks = 0;
  for (const dev of [...baseline.keys()].sort(cmp)) {
    const api = apiByDev.get(dev);
    if (!api) continue; // already reported as missing
    for (const s of ytdSpecs) {
      const apiVal = Number(api[s.col]) || 0;
      const base = s.totals.get(dev) ?? 0;
      const todayCount = s.today.get(dev) ?? 0;
      const slack = slackFor(base);
      const lo = base - todayCount - slack;
      const hi = base + slack;
      ytdChecks++;
      if (apiVal < lo || apiVal > hi) {
        console.error(
          `FAIL ytd ${s.col} for "${dev}": api=${apiVal} baseline=${base} ` +
            `(today=${todayCount}, allowed ${Math.max(0, lo)}..${hi}) — displayed YTD ` +
            `diverges from Snowflake beyond the cache-drift policy`,
        );
        ytdMismatches++;
        failed = true;
      }
    }
  }
  if (!ytdMismatches) {
    console.log(
      `OK   YTD numbers leadsYtd/toursYtd/salesYtd within the cache-drift window on all ${ytdChecks} checks`,
    );
  }

  return !failed;
}

interface DimRawRow {
  DEVELOPMENT_NAME: string;
  COMPANY_NAME: string;
  DEVELOPMENT_HAS_GOALS_FLAG: string | null;
  RENTAL_COMMUNITY_FLAG: string | null;
}

const MONTH_ABBR = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

type TargetMetric = (typeof TARGET_METRICS)[number];
/** Per-community YTD baseline: full-window count plus its today-dated slice. */
interface YtdBaselineRow {
  DEV: string | null;
  N: number;
  N_TODAY: number;
}

/**
 * The record lists embedded in the overview response must reconcile with
 * the matrix's unknown buckets IN THAT SAME RESPONSE: equal totals, every
 * returned record itself unlabeled (no Online/Onsite value) and dated
 * inside the audited window, and the truncation contract honored. Both
 * sides of the equality come from one Snowflake statement per bucket, so a
 * mismatch is real predicate drift (SQL list membership vs the JS bucket
 * count) — never a data race between separately timed queries or requests.
 */
function auditUnknownRecordsDrilldown(
  scenario: Scenario,
  overview: OverviewResponse,
  expStart: string,
  expTo: string,
): boolean {
  console.log(`--- Unknown-records lists vs matrix buckets: ${scenario.name} ---`);
  let failed = false;
  for (const bucket of ["leads", "tours", "sales"] as const) {
    const list = overview.unknownRecords[bucket];
    const matrixCount = overview.trafficMatrix.unknown[bucket];
    if (list.total !== matrixCount) {
      console.error(
        `FAIL unknownRecords.${bucket} total=${list.total} != matrix ` +
          `unknown.${bucket}=${matrixCount} in the same response — the list ` +
          `predicate (SQL) and the bucket predicate (JS) disagree on what "unlabeled" means`,
      );
      failed = true;
    } else {
      console.log(`OK unknownRecords.${bucket} total=${list.total} == matrix bucket`);
    }
    const expectedLen = Math.min(list.total, UNKNOWN_RECORDS_CAP);
    const truncOk = list.truncated === list.total > list.records.length;
    if (list.records.length !== expectedLen || !truncOk) {
      console.error(
        `FAIL unknownRecords.${bucket} returned ${list.records.length} rows ` +
          `(truncated=${list.truncated}) for total=${list.total}, cap=${UNKNOWN_RECORDS_CAP}`,
      );
      failed = true;
    }
    const mislabeled = list.records.filter(
      (r) => r.rawChannel === CHANNEL_ONLINE || r.rawChannel === CHANNEL_ONSITE,
    );
    if (mislabeled.length > 0) {
      console.error(
        `FAIL unknownRecords.${bucket}: ${mislabeled.length} records carry a real ` +
          `Online/Onsite label (e.g. ${JSON.stringify(mislabeled[0].name)}) — ` +
          `predicate drift`,
      );
      failed = true;
    }
    // Dates are YYYY-MM-DD strings; lexicographic compare is date compare.
    const outOfRange = list.records.filter((r) => r.date < expStart || r.date > expTo);
    if (outOfRange.length > 0) {
      console.error(
        `FAIL unknownRecords.${bucket}: ${outOfRange.length} records dated ` +
          `outside ${expStart}..${expTo} (e.g. ${outOfRange[0].date})`,
      );
      failed = true;
    }
  }
  if (!failed) {
    console.log("OK unknown-records lists reconcile with matrix buckets (same response)");
  }
  return !failed;
}

function fmtNullable(v: number | null): string {
  return v === null ? "null" : String(v);
}
let sfActive = 0;

const sfWaiters: (() => void)[] = [];

function isTransientSnowflakeError(message: string): boolean {
  return /HTTP 429|Rate limit exceeded|HTTP 50[234]|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up/i.test(
    message,
  );
}
async function sfQuery<T extends object>(
  sql: string,
  binds: (string | number)[] = [],
): Promise<T[]> {
  while (sfActive >= SF_CONCURRENCY) {
    await new Promise<void>((resolve) => sfWaiters.push(resolve));
  }
  sfActive++;
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        return await querySnowflakeRaw<T>(sql, binds);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt >= SF_MAX_ATTEMPTS || !isTransientSnowflakeError(msg)) throw err;
        const delayMs = Math.min(10_000, 1000 * 2 ** (attempt - 1));
        console.log(
          `  (transient Snowflake error; retry ${attempt}/${SF_MAX_ATTEMPTS - 1} in ${delayMs}ms: ${msg.slice(0, 140)})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  } finally {
    sfActive--;
    sfWaiters.shift()?.();
  }
}

/** Mirrors UNKNOWN_RECORDS_LIMIT in src/lib/overview-targets.ts. */
const UNKNOWN_RECORDS_CAP = 500;

interface GoalBaselineRow {
  GOAL_TYPE: string;
  N: number;
}

/** Full-span and elapsed (to-date) goal sums per goal type over the range. */
async function baselineGoalSums(
  fiscalYear: number,
  goalTypes: string[],
  startDate: string,
  endDate: string,
  toDate: string,
): Promise<Map<string, { fullSpan: number; toDate: number }>> {
  if (goalTypes.length === 0) return new Map();
  const placeholders = goalTypes.map(() => "?").join(",");
  const rows = await sfQuery<{
    GOAL_TYPE: string;
    FULL_SPAN: number;
    TD: number;
  }>(
    `SELECT GOAL_TYPE, SUM(GOAL) AS FULL_SPAN, SUM(IFF(BUDGET_DATE <= ?, GOAL, 0)) AS TD
     FROM DM_GOALS
     WHERE FISCAL_YEAR = ? AND GOAL_TYPE IN (${placeholders})
       AND BUDGET_DATE BETWEEN ? AND ?
     GROUP BY 1`,
    [toDate, fiscalYear, ...goalTypes, startDate, endDate],
  );
  return new Map(
    rows.map((r) => [
      r.GOAL_TYPE,
      { fullSpan: Number(r.FULL_SPAN) || 0, toDate: Number(r.TD) || 0 },
    ]),
  );
}

/**
 * Audits every target value of a pinned scenario (KPI sales goal and ALL
 * traffic-matrix goal columns — total, online, and onsite cells) against an
 * independent resolution of the goal-type regime present in DM_GOALS for
 * the scenario's fiscal year. In regime years, every audited metric must
 * resolve a goal type with a non-zero full-span sum — a metric silently
 * dropping out of DM_GOALS would otherwise pass 0-vs-0 forever.
 * See the Scenario.pinTargets doc for the two pinning modes.
 */
async function auditTargets(
  overview: OverviewResponse,
  expStart: string,
  expEnd: string,
  expTo: string,
): Promise<boolean> {
  const fiscalYear = Number(expStart.slice(0, 4));
  console.log(`-- targets (FY${fiscalYear}, elapsed cutoff ${expTo})`);

  // The baselines below resolve the DEFAULT target's ("goal") regime; if the
  // API applied some other target, every comparison would test the wrong
  // thing — fail fast instead.
  if (overview.appliedRange.target !== "goal") {
    console.error(
      `FAIL applied target is '${overview.appliedRange.target}', expected the default 'goal' — ` +
        "the target pin assumes the server default",
    );
    return false;
  }

  const regime = await resolveGoalRegime(fiscalYear, expTo);
  const cells: {
    metric: TargetMetric;
    path: string;
    fullSpan: number;
    toDate: number;
    ptg: number | null;
  }[] = [
    {
      metric: "gross_sales",
      path: "kpis.sales(Goal|TdGoal)",
      fullSpan: overview.kpis.salesGoal,
      toDate: overview.kpis.salesTdGoal,
      ptg: overview.kpis.ptgPercent,
    },
    {
      metric: "leads",
      path: "trafficMatrix.total.leads",
      fullSpan: overview.trafficMatrix.total.leads.fullSpanGoal,
      toDate: overview.trafficMatrix.total.leads.toDateGoal,
      ptg: overview.trafficMatrix.total.leads.ptgPercent,
    },
    {
      metric: "first_tours",
      path: "trafficMatrix.total.tours",
      fullSpan: overview.trafficMatrix.total.tours.fullSpanGoal,
      toDate: overview.trafficMatrix.total.tours.toDateGoal,
      ptg: overview.trafficMatrix.total.tours.ptgPercent,
    },
    {
      metric: "web_traffic",
      path: "trafficMatrix.online.websiteUsers",
      fullSpan: overview.trafficMatrix.online.websiteUsers.fullSpanGoal,
      toDate: overview.trafficMatrix.online.websiteUsers.toDateGoal,
      ptg: overview.trafficMatrix.online.websiteUsers.ptgPercent,
    },
    {
      metric: "online_leads",
      path: "trafficMatrix.online.leads",
      fullSpan: overview.trafficMatrix.online.leads.fullSpanGoal,
      toDate: overview.trafficMatrix.online.leads.toDateGoal,
      ptg: overview.trafficMatrix.online.leads.ptgPercent,
    },
    {
      metric: "onsite_leads",
      path: "trafficMatrix.onsite.leads",
      fullSpan: overview.trafficMatrix.onsite.leads.fullSpanGoal,
      toDate: overview.trafficMatrix.onsite.leads.toDateGoal,
      ptg: overview.trafficMatrix.onsite.leads.ptgPercent,
    },
    {
      metric: "online_first_tours",
      path: "trafficMatrix.online.tours",
      fullSpan: overview.trafficMatrix.online.tours.fullSpanGoal,
      toDate: overview.trafficMatrix.online.tours.toDateGoal,
      ptg: overview.trafficMatrix.online.tours.ptgPercent,
    },
    {
      metric: "onsite_first_tours",
      path: "trafficMatrix.onsite.tours",
      fullSpan: overview.trafficMatrix.onsite.tours.fullSpanGoal,
      toDate: overview.trafficMatrix.onsite.tours.toDateGoal,
      ptg: overview.trafficMatrix.onsite.tours.ptgPercent,
    },
    {
      metric: "online_gross_sales",
      path: "trafficMatrix.online.sales",
      fullSpan: overview.trafficMatrix.online.sales.fullSpanGoal,
      toDate: overview.trafficMatrix.online.sales.toDateGoal,
      ptg: overview.trafficMatrix.online.sales.ptgPercent,
    },
    {
      metric: "onsite_gross_sales",
      path: "trafficMatrix.onsite.sales",
      fullSpan: overview.trafficMatrix.onsite.sales.fullSpanGoal,
      toDate: overview.trafficMatrix.onsite.sales.toDateGoal,
      ptg: overview.trafficMatrix.onsite.sales.ptgPercent,
    },
  ];

  let failed = false;

  if (regime.size === 0) {
    // The fiscal year predates the goal_* regime (before FY2026, DM_GOALS
    // carries only legacy display names like 'Gross Sales' that no target
    // resolves). The walk-back must therefore resolve NOTHING — pin strict
    // fiscal isolation: every target exactly zero and ptg null. A non-zero
    // target means the API leaked goals from another fiscal year or goal
    // type into a past-year view. This pin upgrades to real value checks
    // automatically once the scenario's year carries the regime (FY2026
    // becomes the prior year in January 2027).
    console.log(
      `note: FY${fiscalYear} carries no goal_* types in DM_GOALS — pinning zero-target ` +
        "fiscal isolation (any non-zero target = goals leaked across fiscal years)",
    );
    for (const c of cells) {
      const ok = c.fullSpan === 0 && c.toDate === 0 && c.ptg === null;
      console.log(
        `${ok ? "OK  " : "FAIL"} target ${c.path.padEnd(37)} [no regime — must be exactly 0] ` +
          `fullSpan=${c.fullSpan} toDate=${c.toDate} ptg=${c.ptg}`,
      );
      if (!ok) failed = true;
    }
    return !failed;
  }

  // The year carries the goal_* regime, so real values are pinned. Mirror
  // audit-leasing's requireGoalData: a resolved regime whose goal rows sum
  // to zero means the walk-back is NOT actually being tested — fail loudly
  // instead of letting every target check pass on 0-vs-0.
  const sums = await baselineGoalSums(
    fiscalYear,
    [...new Set(regime.values())],
    expStart,
    expEnd,
    expTo,
  );
  for (const metric of TARGET_METRICS) {
    const type = regime.get(metric);
    const sum = type ? sums.get(type) : undefined;
    if (!type || !sum || sum.fullSpan === 0) {
      failed = true;
      console.error(
        `FAIL no usable goal data for FY${fiscalYear} metric '${metric}': resolved ` +
          `type=${type ?? "(none)"}, full-span sum=${sum?.fullSpan ?? 0} — this ` +
          "scenario pins the goal-type walk-back, so empty goal data means that " +
          "metric's walk-back is NOT being tested (goals missing from DM_GOALS, " +
          "or the audit's scenario selection needs updating)",
      );
    }
  }

  for (const c of cells) {
    const type = regime.get(c.metric);
    const base = (type && sums.get(type)) || { fullSpan: 0, toDate: 0 };
    for (const [kind, api, baseline] of [
      ["fullSpanGoal", c.fullSpan, base.fullSpan],
      ["toDateGoal", c.toDate, base.toDate],
    ] as const) {
      const d = divergedPct(api, baseline);
      const ok = d <= TOLERANCE_PCT;
      console.log(
        `${ok ? "OK  " : "FAIL"} target ${c.path.padEnd(37)} ${kind.padEnd(12)} ` +
          `[${type ?? "no type resolves"}] api=${api} baseline=${baseline} divergence=${d.toFixed(3)}%`,
      );
      if (!ok) failed = true;
    }
  }

  return !failed;
}

function quarterOf(date: string): number {
  return Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1;
}

/**
 * Independently resolve the "goal" target's GOAL_TYPE per metric for a
 * fiscal year, per the documented regime: goal_<metric>_q<N> quarterly
 * re-issues, walking back from the quarter of the elapsed cutoff to q1.
 * Exact-name matching excludes the old_* renames and RL_* rental variants
 * by construction — FY2026 carries old_goal_*_q3 rows whose sums differ
 * from goal_*_q3, so a walk-back that stopped excluding them diverges
 * immediately instead of silently.
 */
async function resolveGoalRegime(
  fiscalYear: number,
  asOf: string,
): Promise<Map<TargetMetric, string>> {
  const rows = await sfQuery<{ GOAL_TYPE: string }>(
    "SELECT DISTINCT GOAL_TYPE FROM DM_GOALS WHERE FISCAL_YEAR = ?",
    [fiscalYear],
  );
  const available = new Set(rows.map((r) => r.GOAL_TYPE));
  const resolved = new Map<TargetMetric, string>();
  for (const metric of TARGET_METRICS) {
    for (let quarter = quarterOf(asOf); quarter >= 1; quarter--) {
      const name = `goal_${metric}_q${quarter}`;
      if (available.has(name)) {
        resolved.set(metric, name);
        break;
      }
    }
  }
  return resolved;
}

/** The dashboard's PTG convention: percent to goal, null when no goal. */
function derivedPtg(actual: number, toDateGoal: number): number | null {
  if (!toDateGoal) return null;
  return (actual / toDateGoal - 1) * 100;
}

/** DISTINCT GOAL_TYPE per fiscal year, shared across scenarios (1 query). */
const goalTypesByYear = new Map<number, Promise<Set<string>>>();

/**
 * Equality for derived floats recomputed from values that round-tripped
 * through the same JSON document (JSON round-trips doubles exactly, so only
 * epsilon-level slack is needed).
 */
function closeEnough(api: number | null, expected: number | null): boolean {
  if (api === null || expected === null) return api === expected;
  return Math.abs(api - expected) <= Math.max(1e-6, Math.abs(expected) * 1e-9);
}

function availableGoalTypes(fiscalYear: number): Promise<Set<string>> {
  let entry = goalTypesByYear.get(fiscalYear);
  if (!entry) {
    entry = sfQuery<{ GOAL_TYPE: string }>(
      "SELECT DISTINCT GOAL_TYPE FROM DM_GOALS WHERE FISCAL_YEAR = ?",
      [fiscalYear],
    ).then((rows) => new Set(rows.map((r) => r.GOAL_TYPE)));
    goalTypesByYear.set(fiscalYear, entry);
  }
  return entry;
}

type GoalMetric = (typeof GOAL_METRICS)[number];

/**
 * Expected DM_GOALS GOAL_TYPE for a target + metric — a deliberate
 * re-implementation of the API's resolveGoalType (importing it would make
 * the audit inherit its bugs). Convention, validated against live data:
 *  - proforma / business_plan: annual plans `<target>_<metric>_year`
 *  - goal: quarterly recalcs `goal_<metric>_q<N>` — latest quarter <= the
 *    quarter of the elapsed cutoff (toDate), NOT of today
 *  - waterfall: monthly recalcs `waterfall_<metric>_<mon>` — latest month
 *    <= toDate's month
 * Names are constructed exactly, so the retired `old_*` and rental `RL_*`
 * variants present in DM_GOALS can never match.
 */
function expectedGoalType(
  available: Set<string>,
  target: string,
  metric: GoalMetric,
  toDate: string,
): string | null {
  if (target === "proforma" || target === "business_plan") {
    const name = `${target}_${metric}_year`;
    return available.has(name) ? name : null;
  }
  const month = Number(toDate.slice(5, 7)); // 1-12, straight off the string
  if (target === "goal") {
    for (let q = Math.ceil(month / 3); q >= 1; q--) {
      const name = `goal_${metric}_q${q}`;
      if (available.has(name)) return name;
    }
    return null;
  }
  if (target === "waterfall") {
    for (let m = month; m >= 1; m--) {
      const name = `waterfall_${metric}_${MONTH_ABBR[m - 1]}`;
      if (available.has(name)) return name;
    }
    return null;
  }
  return null;
}
