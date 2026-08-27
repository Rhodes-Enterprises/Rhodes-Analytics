/**
 * Client-side mirror of the API's default date ranges (buildFilters fills
 * missing dates from the current quarter, buildLeasingFilters from the
 * current calendar year), used by useCommittedDateRange to hold back lone
 * dates the server's defaults would resolve into a guaranteed-400 range.
 *
 * Anchored to the same America/Chicago calendar date the server's
 * todayChicago() uses — NOT the viewer's local clock — so a client in any
 * timezone computes the same quarter/year the server will. All math is
 * plain string arithmetic on YYYY-MM-DD values (calendar-quarter bounds are
 * fixed dates), keeping it timezone-proof and directly testable with an
 * injected date (see date-defaults.test.ts).
 *
 * If the server's default-filling rules in buildFilters/buildLeasingFilters
 * ever change, this module and the pages' `defaultRange` arguments must
 * change in lockstep.
 */

/**
 * Which range the API substitutes when a date param is missing: the current
 * quarter on the buildFilters pages (Overview, Website Traffic, funnel
 * metrics) or the current calendar year on Leasing (buildLeasingFilters).
 */
export type ServerDefaultRange = "quarter" | "year";

/** Today's calendar date in America/Chicago, as YYYY-MM-DD. */
export function chicagoToday(): string {
  // en-CA formats as YYYY-MM-DD; byte-for-byte the same derivation as the
  // API's todayChicago(). The only remaining approximation is a request in
  // flight across the instant of Chicago midnight — the viewer's timezone
  // no longer changes the result.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
  }).format(new Date());
}

// Calendar quarters have fixed bounds — no Date math (and no timezone) needed.
const QUARTER_BOUNDS = [
  { start: "01-01", end: "03-31" },
  { start: "04-01", end: "06-30" },
  { start: "07-01", end: "09-30" },
  { start: "10-01", end: "12-31" },
] as const;

/**
 * The page's server-side default date range as YYYY-MM-DD bounds — the same
 * quarter math as the API's buildFilters (and the Leasing page's "Current
 * Quarter" button). `today` is injectable for boundary tests and defaults to
 * the America/Chicago calendar date so it matches the server.
 */
export function serverDefaultRange(
  kind: ServerDefaultRange,
  today: string = chicagoToday(),
): { start: string; end: string } {
  const year = today.slice(0, 4);
  if (kind === "year") {
    return { start: `${year}-01-01`, end: `${year}-12-31` };
  }
  const quarter =
    QUARTER_BOUNDS[Math.floor((Number(today.slice(5, 7)) - 1) / 3)];
  return { start: `${year}-${quarter.start}`, end: `${year}-${quarter.end}` };
}

/**
 * Which side of a lone (single-set) date conflicts with the page's server
 * defaults: "start" while the start is the only date set and falls after the
 * default end (the API fills the missing end from the default range, so the
 * resolved pair would be inverted and rejected with a 400), "end" for the
 * mirrored lone end before the default start, null when there is no such
 * conflict (including when both or neither date is set — other guards own
 * those states). Pure so boundary behavior is testable with injected dates.
 */
export function loneDateConflict(
  committedStart: string,
  committedEnd: string,
  defaults: { start: string; end: string },
): "start" | "end" | null {
  const loneStart = committedStart !== "" && committedEnd === "";
  const loneEnd = committedEnd !== "" && committedStart === "";
  if (loneStart && committedStart > defaults.end) return "start";
  if (loneEnd && committedEnd < defaults.start) return "end";
  return null;
}
