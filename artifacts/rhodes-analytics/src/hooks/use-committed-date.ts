import { useEffect, useState } from "react";

import {
  chicagoToday,
  loneDateConflict as detectLoneDateConflict,
  serverDefaultRange,
  type ServerDefaultRange,
} from "@/lib/date-defaults";

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
  /**
   * "start" while the start date is the only one set and it falls after the
   * page's default end (the API fills a missing end from the page's default
   * range — e.g. the current quarter's Sep 30 — so the resolved pair would be
   * inverted and rejected with a 400 before the user ever picks the end
   * date); "end" for the mirrored case (lone end before the default start).
   * Null while there is no such conflict.
   */
  loneDateConflict: "start" | "end" | null;
}

export interface CommittedDateRangeOptions {
  /**
   * Which range the page's API endpoint substitutes for missing dates — must
   * match the server (see {@link ServerDefaultRange}), or lone dates will be
   * held back needlessly / allowed through to a 400.
   */
  defaultRange: ServerDefaultRange;
  clearDelayMs?: number;
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
 *   range;
 * - a *lone* date the server's default would invert: the API fills a missing
 *   start/end from the page's default range (`options.defaultRange`), so a
 *   start after that default's end (e.g. Nov 15 while the quarter default
 *   ends Sep 30) or an end before its start is guaranteed a 400 before the
 *   user has even picked the second date.
 *
 * While the pair is invalid, the previous valid pair stays applied (the same
 * latching behavior as half-typed dates) and the matching flag
 * (`invertedRange` / `crossYearRange` / `loneDateConflict`) is set so the
 * page can show an inline hint. Fixing either date applies immediately.
 */
export function useCommittedDateRange(
  rawStart: string,
  rawEnd: string,
  { defaultRange, clearDelayMs = 600 }: CommittedDateRangeOptions,
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
  // "Today" is the server's America/Chicago calendar date (same tz-database
  // rule as the API's todayChicago), NOT the viewer's local clock — so a
  // viewer in another timezone can never disagree with the server about the
  // current year or quarter around a boundary. Only a request in flight
  // across the instant of Chicago midnight remains approximate.
  const todayChicagoDate = chicagoToday();
  const loneDate =
    (committedStart === "") !== (committedEnd === "")
      ? committedStart || committedEnd
      : "";
  const loneDateOutsideCurrentYear =
    loneDate !== "" && loneDate.slice(0, 4) !== todayChicagoDate.slice(0, 4);
  const crossYearRange =
    !invertedRange && (bothSetCrossYear || loneDateOutsideCurrentYear);

  // A *same-year* lone date can still resolve inverted: the server fills the
  // missing side from the page's default range (current quarter or current
  // year — see serverDefaultRange), so a lone start after that default's end
  // (e.g. Nov 15 while the quarter default ends Sep 30) or a lone end before
  // its start would 400 before the user picks the second date. Held back with
  // a hint instead, mirroring the cross-year lone-date guard above. (When the
  // lone date is outside the current year, crossYearRange already holds it.)
  const loneDateConflict =
    !invertedRange && !crossYearRange
      ? detectLoneDateConflict(
          committedStart,
          committedEnd,
          serverDefaultRange(defaultRange, todayChicagoDate),
        )
      : null;

  const holdPrevious =
    invertedRange || crossYearRange || loneDateConflict !== null;

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

  return { ...applied, invertedRange, crossYearRange, loneDateConflict };
}
