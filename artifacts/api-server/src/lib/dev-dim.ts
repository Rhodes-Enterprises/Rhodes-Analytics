/**
 * Single source of truth for the deduplicated company→development dimension
 * (DEV_DIM) used in attribution joins.
 *
 * DM_COMPANY_DEVELOPMENT holds one row per (company, development) across ALL
 * brands, and the same development name can exist under many companies (e.g.
 * "VDL Lots" under 7 divisions, "Las Brisas" under 3 brands). Joining the raw
 * table on DEVELOPMENT_NAME fans out actual counts (~1.5x inflation observed).
 * Restrict to Esperanza companies and force one row per development name,
 * preferring the goal-carrying row: the flag holds the labels 'Has Goals' /
 * 'No Goals', so a plain string DESC would invert the preference ('N' > 'H').
 *
 * The audit scripts (scripts/audit-dashboard.ts, scripts/audit-yoy.ts) import
 * DEV_DIM from here instead of carrying hand-copied text mirrors, so the API
 * and its safety-net checks cannot silently drift apart on the mapping. The
 * audits' independence lives in HOW they use the dimension — only inside
 * IN (...) semi-joins that cannot fan out by construction — not in a separate
 * copy of the dedup text.
 *
 * Keep this module dependency-free: the audit bundles import it directly and
 * must not pull in the API's cache or Snowflake client transitively.
 */

/**
 * Build the deduplicated dimension subquery, optionally selecting extra
 * DM_COMPANY_DEVELOPMENT columns beyond COMPANY_NAME/DEVELOPMENT_NAME
 * (e.g. the Community List needs CITY/STATE/flags). The WHERE + QUALIFY
 * dedup core is defined once, here.
 */
export function devDimSql(extraColumns: string[] = []): string {
  const cols = ["COMPANY_NAME", "DEVELOPMENT_NAME", ...extraColumns].join(", ");
  return `(
  SELECT ${cols}
  FROM DM_COMPANY_DEVELOPMENT
  WHERE COMPANY_NAME ILIKE '%esperanza%'
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY DEVELOPMENT_NAME
    ORDER BY IFF(DEVELOPMENT_HAS_GOALS_FLAG = 'Has Goals', 0, 1), COMPANY_NAME
  ) = 1
)`;
}

/** The standard two-column fragment embedded in attribution joins. */
export const DEV_DIM = devDimSql();
