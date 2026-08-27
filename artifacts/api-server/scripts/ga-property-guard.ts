/**
 * GA data guards — shared by audit-dashboard.ts, audit-yoy.ts, and audit-leasing.ts.
 *
 * Three upstream failure classes on FCT_GOOGLE_ANALYTICS_EVENT_LEVEL can zero
 * the dashboards' website-traffic numbers while every value check keeps
 * passing, so each gets its own alarm here:
 *
 * 1. A RENAMED analytics property (auditGaPropertyLabels).
 *    The Overview dashboard's website-user metrics (fetchWebsiteUsers /
 *    getYearOverYear in src/lib/overview-targets.ts) and the audits' own GA
 *    baselines all filter PROPERTY via the shared GA_PROPERTY_NAME constant
 *    (src/lib/business-defs.ts); the Leasing pages hardcode
 *    PROPERTY = 'Rhodes Living' the same way (fetchTrafficCount /
 *    fetchMonthlyTraffic in src/lib/leasing.ts). If a property is renamed
 *    upstream, the API and the baselines BOTH compute 0, every user-count
 *    check passes 0=0, and the dashboards ship zeroed traffic numbers with
 *    no alarm — the same blind-spot class the channel label-drift guard
 *    covers for the online/onsite cells. The guard fails when GA rows exist
 *    for the audited date range but ZERO of them match an expected PROPERTY
 *    value, naming the column, the missing value, and the property values
 *    actually present. Ranges whose total GA activity (distinct users
 *    across ALL properties) is below AUDIT_GA_PROPERTY_GUARD_MIN_TOTAL are
 *    too quiet to judge (e.g. day one of a quarter, GA load lag) and are
 *    exempt, so legitimately quiet windows cannot false-positive.
 *
 * 2. A DEAD export (auditGaFreshness).
 *    The label-drift guard deliberately exempts quiet windows, and every
 *    user-count check compares two reads of the same table — so if the
 *    GA → Snowflake load stops outright (zero rows loaded for days), the
 *    traffic numbers shrink toward zero and every check still passes (0=0
 *    or quiet-window exemption). GA data normally lags about a week behind
 *    today (the export loads GOOGLE_ANALYTICS_DATE up to ~7-8 days back),
 *    so "rows exist today" can never be the test; instead the guard fails
 *    when the newest loaded row — overall, or for any expected property —
 *    falls more than AUDIT_GA_MAX_LAG_DAYS days behind today (default 14,
 *    comfortably above the normal lag), reporting the max date found per
 *    property.
 *
 * 3. Yes/No flag guard (auditGaFlagLabels), one layer deeper. Within a
 *    property's rows, the Overview NEW-users numbers key on IS_NEW_USER =
 *    'Yes' and the Leasing web-traffic counts key on IS_SESSION_START =
 *    'Yes' — on both the API and audit sides. If upstream relabels those
 *    values ('Yes' -> 'TRUE'/'true'/1), the affected columns zero out while
 *    their neighbors (total users) stay correct, which makes the drift easy
 *    to miss on screen. When a property's GA rows exist for the range but
 *    ZERO carry the expected flag value, the audit fails, naming the flag
 *    column and the values actually present. Properties whose activity is
 *    below AUDIT_GA_FLAG_GUARD_MIN_TOTAL distinct users are exempt the same
 *    way — which also keeps a missing property from double-failing here on
 *    top of the property guard's own finding. The guard's decision logic
 *    (including that dedup-vs-sum distinction) is pinned by the mocked
 *    self-test in audit-flag-guard.ts, run as part of audit:all.
 */

import { querySnowflake } from "../src/lib/snowflake";
import { GA_PROPERTY_NAME } from "../src/lib/business-defs";
export const GA_PROPERTY_GUARD_MIN_TOTAL = Number(
  process.env.AUDIT_GA_PROPERTY_GUARD_MIN_TOTAL ?? "10",
);

export const GA_FRESHNESS_MAX_LAG_DAYS = Number(
  process.env.AUDIT_GA_MAX_LAG_DAYS ?? "14",
);

interface ExpectedGaProperty {
  /** PROPERTY value the dashboard queries and baselines filter on. */
  value: string;
  /** Where the literal lives, so a failure names the exact fix. */
  usedBy: string;
}

/**
 * Every PROPERTY literal a dashboard depends on. A rename of ANY of these
 * silently zeroes that dashboard's traffic numbers, so the guard checks
 * them all wherever it runs.
 */
export const EXPECTED_GA_PROPERTIES: ExpectedGaProperty[] = [
  {
    value: GA_PROPERTY_NAME,
    usedBy:
      "The Overview dashboard's website-user metrics (fetchWebsiteUsers/getYearOverYear in " +
      "src/lib/overview-targets.ts) AND the GA baselines in audit-dashboard.ts/audit-yoy.ts " +
      "(all via GA_PROPERTY_NAME / isGaTrafficSql() in src/lib/business-defs.ts)",
  },
  {
    value: "Rhodes Living",
    usedBy:
      "The Leasing dashboard's web-traffic queries (fetchTrafficCount/fetchMonthlyTraffic in " +
      "src/lib/leasing.ts)",
  },
];

interface PropertyRow {
  LABEL: string;
  USERS: number;
}

/**
 * Runs the guard over one inclusive GOOGLE_ANALYTICS_DATE range (a single
 * aggregate query). Returns false when any expected property is entirely
 * absent from a materially non-quiet window.
 */
export async function auditGaPropertyLabels(
  expStart: string,
  expTo: string,
): Promise<boolean> {
  const rows = await querySnowflake<PropertyRow>(
    `SELECT COALESCE(PROPERTY, '(null)') AS LABEL,
            COUNT(DISTINCT USER_PSEUDO_ID) AS USERS
     FROM FCT_GOOGLE_ANALYTICS_EVENT_LEVEL
     WHERE GOOGLE_ANALYTICS_DATE BETWEEN ? AND ?
     GROUP BY 1 ORDER BY USERS DESC`,
    [expStart, expTo],
  );

  const usersFor = new Map(rows.map((r) => [r.LABEL, Number(r.USERS) || 0]));
  const total = rows.reduce((s, r) => s + (Number(r.USERS) || 0), 0);

  if (total < GA_PROPERTY_GUARD_MIN_TOTAL) {
    console.log(
      `OK   gaProperty   total GA users=${total} < ${GA_PROPERTY_GUARD_MIN_TOTAL} in ` +
        `${expStart}..${expTo} — window too quiet to judge property drift`,
    );
    return true;
  }

  const present =
    rows.map((r) => `'${r.LABEL}' (${Number(r.USERS) || 0} users)`).join(", ") ||
    "(no rows)";

  let failed = false;
  for (const exp of EXPECTED_GA_PROPERTIES) {
    const name = `gaProperty:'${exp.value}'`;
    const users = usersFor.get(exp.value) ?? 0;
    if (users > 0) {
      console.log(
        `OK   ${name} present (${users} of ${total} GA users in ${expStart}..${expTo})`,
      );
      continue;
    }
    console.error(
      `FAIL ${name} GA rows exist in ${expStart}..${expTo} (${total} distinct users) but ZERO ` +
        `match PROPERTY = '${exp.value}' on FCT_GOOGLE_ANALYTICS_EVENT_LEVEL.PROPERTY — the ` +
        `expected analytics property is missing from the data; properties present: ${present}. ` +
        `${exp.usedBy} depend on this value, so every affected website-traffic number ` +
        `computes 0 and its checks pass 0=0. If the property was renamed upstream, update ` +
        `that definition to the new name.`,
    );
    failed = true;
  }
  return !failed;
}

export const GA_FLAG_GUARD_MIN_TOTAL = Number(
  process.env.AUDIT_GA_FLAG_GUARD_MIN_TOTAL ?? "10",
);

/** Same business-day convention the audit scripts use for "today". */
function todayChicago(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(
    new Date(),
  );
}

/** Whole days an ISO date lies behind a later ISO date (UTC-midnight diff). */
function daysBehind(date: string, today: string): number {
  return Math.round((Date.parse(today) - Date.parse(date)) / 86_400_000);
}

/**
 * Fails when the GA export has stopped flowing: the newest
 * GOOGLE_ANALYTICS_DATE loaded into FCT_GOOGLE_ANALYTICS_EVENT_LEVEL —
 * overall, or for any expected property — is more than
 * GA_FRESHNESS_MAX_LAG_DAYS days behind today. The per-property checks
 * catch a single property's export dying while the other keeps loading
 * (the overall max would stay fresh). Range-independent, so one run per
 * audit pass is coverage enough.
 */
export async function auditGaFreshness(): Promise<boolean> {
  const maxLag = GA_FRESHNESS_MAX_LAG_DAYS;
  // A non-numeric AUDIT_GA_MAX_LAG_DAYS would make every `lag > maxLag`
  // comparison false — a freshness guard that can never fire. Refuse to
  // pretend that counts as passing.
  if (!Number.isFinite(maxLag) || maxLag < 0) {
    console.error(
      `FAIL gaFreshness  AUDIT_GA_MAX_LAG_DAYS is misconfigured ` +
        `(${JSON.stringify(process.env.AUDIT_GA_MAX_LAG_DAYS)} parsed as ${maxLag}) — a ` +
        `non-numeric or negative threshold would silently disable this guard. Set a ` +
        `non-negative number of days (default 14; normal GA load lag is ~7-8 days).`,
    );
    return false;
  }

  const rows = await querySnowflake<PropertyMaxRow>(
    `SELECT COALESCE(PROPERTY, '(null)') AS LABEL,
            MAX(GOOGLE_ANALYTICS_DATE) AS MAX_DATE
     FROM FCT_GOOGLE_ANALYTICS_EVENT_LEVEL
     GROUP BY 1 ORDER BY MAX_DATE DESC NULLS LAST`,
  );
  const today = todayChicago();

  const describe = (r: PropertyMaxRow) =>
    r.MAX_DATE == null
      ? `'${r.LABEL}' max=(no dates)`
      : `'${r.LABEL}' max=${r.MAX_DATE} (${daysBehind(r.MAX_DATE, today)}d behind)`;
  const perProperty = rows.map(describe).join(", ") || "(no rows)";

  const overallMax = rows.reduce<string | null>(
    (best, r) => (r.MAX_DATE != null && (best == null || r.MAX_DATE > best) ? r.MAX_DATE : best),
    null,
  );

  let failed = false;

  // Whole-export staleness: the criterion is MAX(GOOGLE_ANALYTICS_DATE)
  // across the entire table falling more than the threshold behind today.
  if (overallMax == null) {
    console.error(
      `FAIL gaFreshness  FCT_GOOGLE_ANALYTICS_EVENT_LEVEL has no rows with a ` +
        `GOOGLE_ANALYTICS_DATE at all — the GA export has never loaded or was wiped, so every ` +
        `website-traffic number on the dashboards reads 0 while its checks pass 0=0.`,
    );
    failed = true;
  } else if (daysBehind(overallMax, today) > maxLag) {
    console.error(
      `FAIL gaFreshness  newest GA row is ${daysBehind(overallMax, today)} days old: ` +
        `MAX(GOOGLE_ANALYTICS_DATE) = ${overallMax} on FCT_GOOGLE_ANALYTICS_EVENT_LEVEL, today ` +
        `${today}, threshold ${maxLag}d — the GA export appears to have stopped loading. ` +
        `Per property: ${perProperty}. While it is down, the dashboards' website-traffic ` +
        `numbers shrink toward zero and every user-count check keeps passing (0=0, or the ` +
        `quiet-window exemptions), so fix the upstream GA → Snowflake load. If the normal ` +
        `load lag has legitimately grown past ${maxLag} days, raise AUDIT_GA_MAX_LAG_DAYS.`,
    );
    failed = true;
  }

  // Per expected property: one property's export can stall while the other
  // keeps the overall max fresh — the affected dashboard still zeroes out.
  const maxByLabel = new Map(rows.map((r) => [r.LABEL, r.MAX_DATE]));
  for (const exp of EXPECTED_GA_PROPERTIES) {
    const name = `gaFreshness:'${exp.value}'`;
    const max = maxByLabel.get(exp.value) ?? null;
    if (max == null) {
      console.error(
        `FAIL ${name} no rows with PROPERTY = '${exp.value}' exist anywhere in ` +
          `FCT_GOOGLE_ANALYTICS_EVENT_LEVEL (properties present: ${perProperty}) — ` +
          `${exp.usedBy} read 0 users for every range. If the property was renamed ` +
          `upstream, update those literals (see the gaProperty guard).`,
      );
      failed = true;
      continue;
    }
    const lag = daysBehind(max, today);
    if (lag > maxLag) {
      console.error(
        `FAIL ${name} newest row for this property is ${lag} days old (max ` +
          `GOOGLE_ANALYTICS_DATE ${max}, today ${today}, threshold ${maxLag}d) — its GA ` +
          `export stopped flowing, so the website-traffic numbers read by ${exp.usedBy} ` +
          `shrink toward zero for recent ranges while their checks keep passing. If the ` +
          `normal load lag has legitimately grown, raise AUDIT_GA_MAX_LAG_DAYS.`,
      );
      failed = true;
    }
  }

  if (!failed) {
    console.log(
      `OK   gaFreshness  newest GA row is ${daysBehind(overallMax!, today)}d old ` +
        `(threshold ${maxLag}d; today ${today}); per property: ${perProperty}`,
    );
  }
  return !failed;
}

interface PropertyMaxRow {
  LABEL: string;
  /** DATE column, converted to 'YYYY-MM-DD'; null if the group has no dates. */
  MAX_DATE: string | null;
}

export interface FlagRow {
  LABEL: string;
  /** 1 on the () grouping-set row — the whole-property aggregate — else 0. */
  G: number;
  N: number;
  USERS: number;
}

/**
 * Query runner used by auditGaFlagLabels, injectable so the mocked
 * self-test (audit-flag-guard.ts) can drive the real decision logic with
 * fabricated rows and no Snowflake. Production call sites always use the
 * default (querySnowflake).
 */
export type FlagGuardQuery = (
  sql: string,
  binds: string[],
) => Promise<FlagRow[]>;
/**
 * Runs the Yes/No flag guard over one inclusive GOOGLE_ANALYTICS_DATE range
 * (one aggregate query per expected flag, scoped to the property whose
 * dashboard depends on it, run sequentially to stay under the proxy rate
 * limit). Returns false when any expected flag value is entirely absent
 * from a materially non-quiet property window.
 *
 * The quiet-window threshold comes from the query's () grouping-set row,
 * which counts DISTINCT users across ALL of the property's rows. Summing
 * the per-label distinct counts instead would tally a user once per flag
 * value they appear under (e.g. IS_NEW_USER = 'Yes' on their first visit,
 * 'No' afterwards) and overstate activity, so a genuinely quiet window
 * could fail the guard instead of being exempt.
 */
export async function auditGaFlagLabels(
  expStart: string,
  expTo: string,
  runQuery: FlagGuardQuery = (sql, binds) => querySnowflake<FlagRow>(sql, binds),
): Promise<boolean> {
  let failed = false;
  for (const exp of EXPECTED_GA_FLAGS) {
    const name = `gaFlag:${exp.column}`;
    const rows = await runQuery(
      `SELECT COALESCE(${exp.column}, '(null)') AS LABEL,
              GROUPING(${exp.column}) AS G,
              COUNT(*) AS N,
              COUNT(DISTINCT USER_PSEUDO_ID) AS USERS
       FROM FCT_GOOGLE_ANALYTICS_EVENT_LEVEL
       WHERE PROPERTY = ? AND GOOGLE_ANALYTICS_DATE BETWEEN ? AND ?
       GROUP BY GROUPING SETS ((${exp.column}), ())
       ORDER BY G, N DESC`,
      [exp.property, expStart, expTo],
    );

    const labelRows = rows.filter((r) => Number(r.G) !== 1);
    const totalRow = rows.find((r) => Number(r.G) === 1);
    const totalUsers = Number(totalRow?.USERS) || 0;
    if (totalUsers < GA_FLAG_GUARD_MIN_TOTAL) {
      console.log(
        `OK   ${name}   '${exp.property}' GA users=${totalUsers} < ${GA_FLAG_GUARD_MIN_TOTAL} in ` +
          `${expStart}..${expTo} — window too quiet to judge flag drift`,
      );
      continue;
    }

    const match = labelRows.find((r) => r.LABEL === exp.value);
    if (match) {
      console.log(
        `OK   ${name} = '${exp.value}' present on '${exp.property}' rows ` +
          `(${Number(match.N) || 0} rows, ${Number(match.USERS) || 0} users in ${expStart}..${expTo})`,
      );
      continue;
    }

    const present =
      labelRows
        .map((r) => `'${r.LABEL}' (${Number(r.N) || 0} rows, ${Number(r.USERS) || 0} users)`)
        .join(", ") || "(no rows)";
    console.error(
      `FAIL ${name} '${exp.property}' GA rows exist in ${expStart}..${expTo} (${totalUsers} users) ` +
        `but ZERO carry ${exp.column} = '${exp.value}' on FCT_GOOGLE_ANALYTICS_EVENT_LEVEL — the ` +
        `expected flag value is missing from the data; values present: ${present}. ${exp.usedBy} ` +
        `hardcode this literal, so every affected number computes 0 while neighboring totals stay ` +
        `correct, and its checks pass 0=0. If the flag values were relabeled upstream, update ` +
        `those literals to the new value.`,
    );
    failed = true;
  }
  return !failed;
}

/**
 * Every Yes/No-style flag literal a dashboard metric keys on. A relabel of
 * ANY of these silently zeroes that metric on both the API and audit sides
 * while neighboring columns stay correct, so the guard checks them all
 * wherever it runs.
 */
export const EXPECTED_GA_FLAGS: ExpectedGaFlag[] = [
  {
    column: "IS_NEW_USER",
    value: "Yes",
    property: GA_PROPERTY_NAME,
    usedBy:
      "The Overview dashboard's NEW-users columns (fetchWebsiteUsers in src/lib/overview-targets.ts), " +
      "the marketing website-traffic dashboard (src/lib/marketing-dashboards.ts), AND the GA " +
      "baselines in audit-dashboard.ts",
  },
  {
    column: "IS_SESSION_START",
    value: "Yes",
    property: "Rhodes Living",
    usedBy:
      "The Leasing dashboard's web-traffic counts (fetchTrafficCount/fetchMonthlyTraffic in " +
      "src/lib/leasing.ts — the funnel's webTraffic column and its monthly trend)",
  },
];

interface ExpectedGaFlag {
  /** Flag column on FCT_GOOGLE_ANALYTICS_EVENT_LEVEL the queries filter on. */
  column: string;
  /** Literal flag value the dashboard queries and baselines hardcode. */
  value: string;
  /**
   * PROPERTY the consuming queries scope to. The guard judges the flag
   * inside that property's rows only, so the failure points at the
   * dashboard actually affected — and a property that is missing entirely
   * stays the property guard's finding (this guard's quiet-window exemption
   * skips it instead of piling on a second failure).
   */
  property: string;
  /** Where the literal lives, so a failure names the exact fix. */
  usedBy: string;
}
