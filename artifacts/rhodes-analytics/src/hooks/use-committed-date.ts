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
  /** Last valid (non-inverted) committed pair — safe to use in query params. */
  startDate: string;
  endDate: string;
  /** True while both inputs hold complete dates but the end is before the start. */
  invertedRange: boolean;
}

/**
 * Range-level companion to {@link useCommittedDate}: commits each date the
 * same way, but additionally refuses to apply a pair whose end date is before
 * its start date. Querying an inverted range "succeeds" with all-zero metrics,
 * which reads as "no activity in this period" instead of "impossible range".
 *
 * While the pair is inverted, the previous valid pair stays applied (the same
 * latching behavior as half-typed dates) and `invertedRange` is true so the
 * page can show an inline hint. Fixing either date applies immediately.
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

  const [applied, setApplied] = useState(() => ({
    startDate: invertedRange ? "" : committedStart,
    endDate: invertedRange ? "" : committedEnd,
  }));

  useEffect(() => {
    if (invertedRange) return; // keep the previous valid pair applied
    setApplied((prev) =>
      prev.startDate === committedStart && prev.endDate === committedEnd
        ? prev
        : { startDate: committedStart, endDate: committedEnd },
    );
  }, [committedStart, committedEnd, invertedRange]);

  return { ...applied, invertedRange };
}
