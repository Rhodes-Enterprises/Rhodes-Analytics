/**
 * GA data guards — shared by audit-dashboard.ts and audit-yoy.ts.
 *
 * Two upstream failure classes on FCT_GOOGLE_ANALYTICS_EVENT_LEVEL can zero
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
