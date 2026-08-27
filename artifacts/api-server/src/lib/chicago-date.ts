/**
 * Single source of truth for the America/Chicago business calendar.
 *
 * Every dashboard day window — default date ranges, YTD windows, and
 * day-scoped cache keys — must derive "today" from THIS module, never from
 * UTC: a UTC "today" flips to tomorrow at 6pm Chicago (winter) / 7pm (summer),
 * which would roll YTD windows and cache keys to the new year hours early on
 * New Year's Eve and mislabel every evening's numbers the rest of the year.
 *
 * scripts/audit-rollover.ts pins this behavior with clock-injected unit
 * checks (New Year's Eve at 11pm Chicago, the Chicago-midnight boundary, an
 * ordinary evening, both DST transitions) and also fails if any OTHER src/
 * file starts building its own date formatter — keep all business-day
 * derivations here so those checks keep covering the code that serves
 * requests.
 */

/**
 * Business "today" (YYYY-MM-DD) on the America/Chicago calendar.
 *
 * @param now Clock injection point for tests; production callers omit it and
 *            get the real clock.
 */
export function todayChicago(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD; Intl applies the correct CST/CDT offset for
  // the given instant, so DST transitions need no special-casing here.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
  }).format(now);
}
