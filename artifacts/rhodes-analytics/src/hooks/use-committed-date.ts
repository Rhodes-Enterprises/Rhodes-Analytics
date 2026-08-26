import { useEffect, useState } from "react";

/**
 * Native `<input type="date">` fires a change event on every keystroke, so
 * while someone types a year the value passes through complete-looking but
 * implausible dates ("0202-05-01" on the way to "2024-05-01"). Firing API
 * queries for those flashes the error banner and burns Snowflake queries on
 * garbage input.
 *
 * Accepts only complete YYYY-MM-DD values with a plausible year and a real
 * calendar date.
 */
export function isPlausibleDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  if (year < 2000 || year > 2100) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

/**
 * Returns the last *committed* value of a date input, safe to use in query
 * params (keep feeding the raw value to the input itself):
 *
 * - a complete, plausible date commits immediately, so picking a date or
 *   finishing the year applies without delay;
 * - an empty value (input cleared, or a segment deleted mid-edit) commits
 *   after a short pause, so wiping the year to retype it doesn't refetch
 *   the default range in between;
 * - anything else (a half-typed date like "0202-05-01") never commits —
 *   the previous committed value stays applied.
 */
export function useCommittedDate(raw: string, clearDelayMs = 600): string {
  const [committed, setCommitted] = useState(() =>
    raw === "" || isPlausibleDateString(raw) ? raw : "",
  );

  useEffect(() => {
    if (isPlausibleDateString(raw)) {
      setCommitted(raw);
      return undefined;
    }
    if (raw === "") {
      const timer = setTimeout(() => setCommitted(""), clearDelayMs);
      return () => clearTimeout(timer);
    }
    // Half-typed date: keep the previous committed value.
    return undefined;
  }, [raw, clearDelayMs]);

  return committed;
}

export interface CommittedDateRange {
  /** Last valid committed pair (in order, same year) — safe to use in query params. */
  startDate: string;
  endDate: string;
  /** True while both inputs hold complete dates but the end is before the start. */
  invertedRange: boolean;
  /**
   * True while the committed dates would form a range spanning two calendar
   * years — either both dates are set (in order) in different years, or only
   * one date is set and it falls outside the current year (the API fills the
   * missing side from today's date, so the resolved range would still cross
   * years). The API rejects such ranges (goals are issued per fiscal year),
   * so they are never queried.
   */
  crossYearRange: boolean;
}

/**
 * Range-level companion to {@link useCommittedDate}: commits each date the
 * same way, but additionally refuses to apply a pair that the dashboards
 * cannot query:
 *
 * - an *inverted* pair (end before start) would "succeed" with all-zero
 *   metrics, which reads as "no activity in this period" instead of
 *   "impossible range";
 * - a *cross-year* pair (start and end in different calendar years) is
 *   rejected by the API with a 400 — goals are issued per fiscal year — which
 *   would flash the destructive "failed to load" banner at a sensible-looking
 *   range.
 *
 * While the pair is invalid, the previous valid pair stays applied (the same
 * latching behavior as half-typed dates) and the matching flag
 * (`invertedRange` / `crossYearRange`) is true so the page can show an inline
 * hint. Fixing either date applies immediately.
 */
export function useCommittedDateRange(
  rawStart: string,
  rawEnd: string,
  clearDelayMs = 600,
): CommittedDateRange {
  const committedStart = useCommittedDate(rawStart, clearDelayMs);
  const committedEnd = useCommittedDate(rawEnd, clearDelayMs);

  // Committed values are always complete YYYY-MM-DD strings (or ""), so
  // lexicographic comparison matches chronological order.
  const invertedRange =
    committedStart !== "" &&
    committedEnd !== "" &&
    committedEnd < committedStart;

  // Mirrors the API rule in buildFilters/buildLeasingFilters: a range spanning
  // two calendar years mixes goal regimes and is rejected server-side. Two
  // client-detectable ways to hit that:
  //  - both dates set, in order, in different calendar years;
  //  - only one date set, in a year other than the current one — the server
  //    defaults the missing side from today's date, so the resolved range
  //    would still cross years (picking a Dec 2025 start on the way to a
  //    Dec 2025 → Feb 2026 range must not flash the error banner).
  // Only flagged when the pair is not inverted so at most one hint shows.
  const bothSetCrossYear =
    committedStart !== "" &&
    committedEnd !== "" &&
    committedStart.slice(0, 4) !== committedEnd.slice(0, 4);
  const loneDate =
    (committedStart === "") !== (committedEnd === "")
      ? committedStart || committedEnd
      : "";
  const loneDateOutsideCurrentYear =
    loneDate !== "" &&
    loneDate.slice(0, 4) !== String(new Date().getFullYear());
  const crossYearRange =
    !invertedRange && (bothSetCrossYear || loneDateOutsideCurrentYear);

  const holdPrevious = invertedRange || crossYearRange;

  const [applied, setApplied] = useState(() => ({
    startDate: holdPrevious ? "" : committedStart,
    endDate: holdPrevious ? "" : committedEnd,
  }));

  useEffect(() => {
    if (holdPrevious) return; // keep the previous valid pair applied
    setApplied((prev) =>
      prev.startDate === committedStart && prev.endDate === committedEnd
        ? prev
        : { startDate: committedStart, endDate: committedEnd },
    );
  }, [committedStart, committedEnd, holdPrevious]);

  return { ...applied, invertedRange, crossYearRange };
}
