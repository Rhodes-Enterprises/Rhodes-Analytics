/**
 * Single source of truth for the business predicates that define WHAT GETS
 * COUNTED on the dashboards:
 *
 *   - a SALE  is a deal in the 'Esperanza Homes Sales Pipeline'
 *   - a LEAD  is a contact with EHI_LEAD = 1
 *   - TRAFFIC is GA rows for the 'Esperanza Homes' property
 *
 * These used to be hand-copied SQL text across the API data layers
 * (src/lib/overview-targets.ts, src/lib/marketing-dashboards.ts) and the
 * audit scripts (scripts/audit-dashboard.ts, scripts/audit-yoy.ts). If one
 * side ever changed a definition and the other didn't, the audits would
 * either flag false regressions or silently stop catching real ones — the
 * same drift class DEV_DIM (src/lib/dev-dim.ts) had before it was
 * single-sourced.
 *
 * Sharing these predicates does NOT weaken the audits: their independence
 * lives in recomputing the aggregations differently (plain GROUP BYs,
 * IN (...) semi-joins that cannot fan out), not in re-typing the business
 * definitions.
 *
 * Keep this module dependency-free: the audit bundles import it directly and
 * must not pull in the API's cache or Snowflake client transitively.
 */

/** Deals pipeline whose deals count as sales. */
export const SALES_PIPELINE_NAME = "Esperanza Homes Sales Pipeline";

/** Google Analytics property whose traffic counts as website users. */
export const GA_PROPERTY_NAME = "Esperanza Homes";

const prefix = (alias?: string): string => (alias ? `${alias}.` : "");

/** SQL predicate: this deal row counts as a sale. */
export function isSaleSql(alias?: string): string {
  return `${prefix(alias)}PIPELINE_NAME = '${SALES_PIPELINE_NAME}'`;
}

/** SQL predicate: this contact row counts as a lead. */
export function isLeadSql(alias?: string): string {
  return `${prefix(alias)}EHI_LEAD = 1`;
}

/** SQL predicate: this GA row belongs to the brand's web property. */
export function isGaTrafficSql(alias?: string): string {
  return `${prefix(alias)}PROPERTY = '${GA_PROPERTY_NAME}'`;
}
