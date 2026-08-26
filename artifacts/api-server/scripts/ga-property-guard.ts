/**
 * GA property label-drift guard — shared by audit-dashboard.ts and
 * audit-yoy.ts.
 *
 * The Overview dashboard's website-user metrics (fetchWebsiteUsers /
 * getYearOverYear in src/lib/overview-targets.ts) and the audits' own GA
 * baselines all filter PROPERTY via the shared GA_PROPERTY_NAME constant
 * (src/lib/business-defs.ts) against
 * FCT_GOOGLE_ANALYTICS_EVENT_LEVEL; the Leasing pages hardcode
 * PROPERTY = 'Rhodes Living' the same way (fetchTrafficCount /
 * fetchMonthlyTraffic in src/lib/leasing.ts). If an analytics property is
 * renamed upstream, the API and the baselines BOTH compute 0, every
 * user-count check passes 0=0, and the dashboards ship zeroed traffic
 * numbers with no alarm — the same blind-spot class the channel
 * label-drift guard covers for the online/onsite cells.
 *
 * This guard is the alarm: when GA rows exist for the audited date range
 * but ZERO of them match an expected PROPERTY value, the audit fails,
 * naming the column, the missing value, and the property values actually
 * present. Ranges whose total GA activity (distinct users across ALL
 * properties) is below AUDIT_GA_PROPERTY_GUARD_MIN_TOTAL are too quiet to
 * judge (e.g. day one of a quarter, GA load lag) and are exempt, so
 * legitimately quiet windows cannot false-positive.
 */

import { querySnowflake } from "../src/lib/snowflake";
import { GA_PROPERTY_NAME } from "../src/lib/business-defs";

export const GA_PROPERTY_GUARD_MIN_TOTAL = Number(
  process.env.AUDIT_GA_PROPERTY_GUARD_MIN_TOTAL ?? "10",
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
