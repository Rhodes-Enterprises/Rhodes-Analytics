/**
 * Regression tests for the date-input safeguards every dashboard relies on.
 *
 * All four date-filtered pages build their query params from
 * useCommittedDate / useCommittedDateRange, whose subtle rules (immediate
 * commit of plausible dates, delayed clear, half-typed latching, and
 * range-level latching with the invertedRange / crossYearRange /
 * loneDateConflict flags) keep garbage ranges from ever reaching the API. A
 * silent regression here would quietly bring back 400-error flashes and
 * wasted Snowflake queries while users type, so each behavior is pinned
 * down as its own test.
 *
 * Time is frozen at a fixed instant (mid-Q2 2026, far from every
 * quarter/year boundary) because the hook anchors "today" to the
 * America/Chicago calendar date: the cross-year lone-date guard compares
 * against the current Chicago year, and the lone-date-conflict guard
 * compares against the page's server default range (current quarter or
 * current calendar year — see src/lib/date-defaults.ts, which has its own
 * node --test boundary suite).
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isPlausibleDateString,
  useCommittedDate,
  useCommittedDateRange,
  type CommittedDateRangeOptions,
} from "@/hooks/use-committed-date";

// 2026-06-15T12:00:00Z is 07:00 in America/Chicago (CDT): chicagoToday()
// resolves to 2026-06-15, the quarter default range to
// 2026-04-01..2026-06-30, and the year default to 2026-01-01..2026-12-31.
const NOW = new Date("2026-06-15T12:00:00Z");
const Y = "2026";
const PREV = "2025";

const QUARTER: CommittedDateRangeOptions = { defaultRange: "quarter" };
const YEAR: CommittedDateRangeOptions = { defaultRange: "year" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isPlausibleDateString", () => {
  it("accepts complete, plausible calendar dates", () => {
    expect(isPlausibleDateString(`${Y}-05-01`)).toBe(true);
    expect(isPlausibleDateString("2024-02-29")).toBe(true); // leap day
    expect(isPlausibleDateString("2000-01-01")).toBe(true); // lower year bound
    expect(isPlausibleDateString("2100-12-31")).toBe(true); // upper year bound
  });

  it("rejects values that are not complete YYYY-MM-DD strings", () => {
    expect(isPlausibleDateString("")).toBe(false);
    expect(isPlausibleDateString(`${Y}-05`)).toBe(false);
    expect(isPlausibleDateString(`${Y}-5-01`)).toBe(false);
    expect(isPlausibleDateString("not-a-date")).toBe(false);
    expect(isPlausibleDateString(`${Y}-05-01T00:00:00`)).toBe(false);
  });

  it("rejects years outside the plausible 2000-2100 window", () => {
    expect(isPlausibleDateString("1999-12-31")).toBe(false);
    expect(isPlausibleDateString("2101-01-01")).toBe(false);
    // The exact shape a native date input emits mid-typing of "2024".
    expect(isPlausibleDateString("0202-05-01")).toBe(false);
  });

  it("rejects impossible calendar dates", () => {
    expect(isPlausibleDateString("2023-02-29")).toBe(false); // not a leap year
    expect(isPlausibleDateString("2024-13-01")).toBe(false);
    expect(isPlausibleDateString("2024-04-31")).toBe(false);
    expect(isPlausibleDateString("2024-00-10")).toBe(false);
  });
});

describe("useCommittedDate", () => {
  function renderDate(initial: string, clearDelayMs?: number) {
    return renderHook(({ raw }) => useCommittedDate(raw, clearDelayMs), {
      initialProps: { raw: initial },
    });
  }

  it("commits a plausible initial value immediately", () => {
    const { result } = renderDate(`${Y}-05-01`);
    expect(result.current).toBe(`${Y}-05-01`);
  });

  it("starts uncommitted when the initial value is half-typed", () => {
    const { result } = renderDate("0202-05-01");
    expect(result.current).toBe("");
  });

  it("starts empty when the initial value is empty", () => {
    const { result } = renderDate("");
    expect(result.current).toBe("");
  });

  it("commits a newly typed plausible date without any delay", () => {
    const { result, rerender } = renderDate("");
    rerender({ raw: `${Y}-05-01` });
    expect(result.current).toBe(`${Y}-05-01`);
  });

  it("latches the previous date while a half-typed date passes through", () => {
    const { result, rerender } = renderDate(`${Y}-05-01`);
    rerender({ raw: "0202-12-31" });
    expect(result.current).toBe(`${Y}-05-01`);
    rerender({ raw: "" });
    // Still latched: the clear is delayed, not immediate.
    expect(result.current).toBe(`${Y}-05-01`);
  });

  it("clears an emptied input only after the clear delay", () => {
    const { result, rerender } = renderDate(`${Y}-05-01`);
    rerender({ raw: "" });
    act(() => {
      vi.advanceTimersByTime(599);
    });
    expect(result.current).toBe(`${Y}-05-01`);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe("");
  });

  it("cancels a pending clear when a plausible date arrives in time", () => {
    const { result, rerender } = renderDate(`${Y}-05-01`);
    rerender({ raw: "" });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    rerender({ raw: `${Y}-06-01` });
    expect(result.current).toBe(`${Y}-06-01`);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    // The cancelled clear must never fire late.
    expect(result.current).toBe(`${Y}-06-01`);
  });

  it("clears after the delay even from a latched half-typed state", () => {
    const { result, rerender } = renderDate(`${Y}-05-01`);
    rerender({ raw: "0202-01-01" });
    expect(result.current).toBe(`${Y}-05-01`);
    rerender({ raw: "" });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(result.current).toBe("");
  });

  it("honors a custom clear delay", () => {
    const { result, rerender } = renderDate(`${Y}-05-01`, 100);
    rerender({ raw: "" });
    act(() => {
      vi.advanceTimersByTime(99);
    });
    expect(result.current).toBe(`${Y}-05-01`);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe("");
  });
});

describe("useCommittedDateRange", () => {
  function renderRange(
    initialStart: string,
    initialEnd: string,
    options: CommittedDateRangeOptions = QUARTER,
  ) {
    return renderHook(
      ({ start, end }) => useCommittedDateRange(start, end, options),
      { initialProps: { start: initialStart, end: initialEnd } },
    );
  }

  it("applies a valid initial pair with no flags set", () => {
    const { result } = renderRange(`${Y}-04-10`, `${Y}-05-20`);
    expect(result.current).toEqual({
      startDate: `${Y}-04-10`,
      endDate: `${Y}-05-20`,
      invertedRange: false,
      crossYearRange: false,
      loneDateConflict: null,
    });
  });

  it("keeps the last valid pair applied while the range is inverted", () => {
    const { result, rerender } = renderRange(`${Y}-04-10`, `${Y}-05-20`);
    rerender({ start: `${Y}-04-10`, end: `${Y}-04-01` });
    expect(result.current).toEqual({
      startDate: `${Y}-04-10`,
      endDate: `${Y}-05-20`,
      invertedRange: true,
      crossYearRange: false,
      loneDateConflict: null,
    });
  });

  it("applies immediately and clears the flag once the end date is fixed", () => {
    const { result, rerender } = renderRange(`${Y}-04-10`, `${Y}-05-20`);
    rerender({ start: `${Y}-04-10`, end: `${Y}-04-01` });
    rerender({ start: `${Y}-04-10`, end: `${Y}-06-20` });
    expect(result.current).toEqual({
      startDate: `${Y}-04-10`,
      endDate: `${Y}-06-20`,
      invertedRange: false,
      crossYearRange: false,
      loneDateConflict: null,
    });
  });

  it("applies immediately when the start date is fixed instead", () => {
    const { result, rerender } = renderRange(`${Y}-04-10`, `${Y}-05-20`);
    rerender({ start: `${Y}-04-10`, end: `${Y}-04-01` });
    rerender({ start: `${Y}-03-15`, end: `${Y}-04-01` });
    expect(result.current).toEqual({
      startDate: `${Y}-03-15`,
      endDate: `${Y}-04-01`,
      invertedRange: false,
      crossYearRange: false,
      loneDateConflict: null,
    });
  });

  it("starts unapplied when the very first pair is already inverted", () => {
    const { result } = renderRange(`${Y}-05-20`, `${Y}-04-10`);
    expect(result.current).toEqual({
      startDate: "",
      endDate: "",
      invertedRange: true,
      crossYearRange: false,
      loneDateConflict: null,
    });
  });

  it("treats equal start and end dates as a valid range", () => {
    const { result } = renderRange(`${Y}-05-10`, `${Y}-05-10`);
    expect(result.current).toEqual({
      startDate: `${Y}-05-10`,
      endDate: `${Y}-05-10`,
      invertedRange: false,
      crossYearRange: false,
      loneDateConflict: null,
    });
  });

  it("never lets half-typed dates reach the applied range or the flags", () => {
    const { result, rerender } = renderRange(`${Y}-04-10`, `${Y}-05-20`);
    rerender({ start: `${Y}-04-10`, end: "0202-12-31" });
    expect(result.current).toEqual({
      startDate: `${Y}-04-10`,
      endDate: `${Y}-05-20`,
      invertedRange: false,
      crossYearRange: false,
      loneDateConflict: null,
    });
    rerender({ start: "0202-01-01", end: "0202-12-31" });
    expect(result.current).toEqual({
      startDate: `${Y}-04-10`,
      endDate: `${Y}-05-20`,
      invertedRange: false,
      crossYearRange: false,
      loneDateConflict: null,
    });
  });

  it("applies a cleared field after the delay without raising any flag", () => {
    const { result, rerender } = renderRange(`${Y}-05-10`, `${Y}-05-20`);
    rerender({ start: `${Y}-05-10`, end: "" });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    // The remaining lone start (May 10) sits inside the quarter default
    // (Apr 1 - Jun 30), so nothing holds it back.
    expect(result.current).toEqual({
      startDate: `${Y}-05-10`,
      endDate: "",
      invertedRange: false,
      crossYearRange: false,
      loneDateConflict: null,
    });
  });

  it("latches a cross-year pair and flags it", () => {
    const { result, rerender } = renderRange(`${Y}-04-10`, `${Y}-05-20`);
    rerender({ start: `${PREV}-12-01`, end: `${Y}-05-20` });
    expect(result.current).toEqual({
      startDate: `${Y}-04-10`,
      endDate: `${Y}-05-20`,
      invertedRange: false,
      crossYearRange: true,
      loneDateConflict: null,
    });
  });

  it("applies immediately once the cross-year pair is brought into one year", () => {
    const { result, rerender } = renderRange(`${Y}-04-10`, `${Y}-05-20`);
    rerender({ start: `${PREV}-12-01`, end: `${Y}-05-20` });
    rerender({ start: `${Y}-01-05`, end: `${Y}-05-20` });
    expect(result.current).toEqual({
      startDate: `${Y}-01-05`,
      endDate: `${Y}-05-20`,
      invertedRange: false,
      crossYearRange: false,
      loneDateConflict: null,
    });
  });

  it("starts unapplied when the very first pair crosses years", () => {
    const { result } = renderRange(`${PREV}-12-01`, `${Y}-02-01`);
    expect(result.current).toEqual({
      startDate: "",
      endDate: "",
      invertedRange: false,
      crossYearRange: true,
      loneDateConflict: null,
    });
  });

  it("holds back a lone date outside the current year, then applies a valid prior-year pair", () => {
    // The API fills the missing end from its defaults, so a lone 2025 start
    // would resolve into a 2025 → 2026 range and 400 — held back instead.
    const { result, rerender } = renderRange(`${PREV}-12-01`, "");
    expect(result.current).toEqual({
      startDate: "",
      endDate: "",
      invertedRange: false,
      crossYearRange: true,
      loneDateConflict: null,
    });
    rerender({ start: `${PREV}-12-01`, end: `${PREV}-12-20` });
    expect(result.current).toEqual({
      startDate: `${PREV}-12-01`,
      endDate: `${PREV}-12-20`,
      invertedRange: false,
      crossYearRange: false,
      loneDateConflict: null,
    });
  });

  it("applies a lone current-year date inside the default range immediately", () => {
    const { result } = renderRange(`${Y}-05-01`, "");
    expect(result.current).toEqual({
      startDate: `${Y}-05-01`,
      endDate: "",
      invertedRange: false,
      crossYearRange: false,
      loneDateConflict: null,
    });
  });

  it("flags only invertedRange for an inverted cross-year pair", () => {
    const { result } = renderRange(`${Y}-03-01`, `${PREV}-06-01`);
    expect(result.current).toEqual({
      startDate: "",
      endDate: "",
      invertedRange: true,
      crossYearRange: false,
      loneDateConflict: null,
    });
  });

  it("holds back a lone start after the page's quarter default end", () => {
    // Quarter default is Apr 1 - Jun 30: the server would fill the missing
    // end with Jun 30, inverting a Jul 10 start into a guaranteed 400.
    const { result } = renderRange(`${Y}-07-10`, "");
    expect(result.current).toEqual({
      startDate: "",
      endDate: "",
      invertedRange: false,
      crossYearRange: false,
      loneDateConflict: "start",
    });
  });

  it("holds back a lone end before the page's quarter default start", () => {
    const { result } = renderRange("", `${Y}-03-15`);
    expect(result.current).toEqual({
      startDate: "",
      endDate: "",
      invertedRange: false,
      crossYearRange: false,
      loneDateConflict: "end",
    });
  });

  it("accepts under the year default the same lone start the quarter default rejects", () => {
    const { result } = renderRange(`${Y}-07-10`, "", YEAR);
    expect(result.current).toEqual({
      startDate: `${Y}-07-10`,
      endDate: "",
      invertedRange: false,
      crossYearRange: false,
      loneDateConflict: null,
    });
  });

  it("applies immediately once a conflicting lone date gets its second date", () => {
    const { result, rerender } = renderRange(`${Y}-07-10`, "");
    expect(result.current.loneDateConflict).toBe("start");
    rerender({ start: `${Y}-07-10`, end: `${Y}-08-01` });
    // A complete same-year pair never consults the default range.
    expect(result.current).toEqual({
      startDate: `${Y}-07-10`,
      endDate: `${Y}-08-01`,
      invertedRange: false,
      crossYearRange: false,
      loneDateConflict: null,
    });
  });

  it("keeps the previous applied pair while a lone-date conflict is held", () => {
    const { result, rerender } = renderRange(`${Y}-04-10`, `${Y}-05-20`);
    rerender({ start: `${Y}-04-10`, end: "" });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(result.current).toEqual({
      startDate: `${Y}-04-10`,
      endDate: "",
      invertedRange: false,
      crossYearRange: false,
      loneDateConflict: null,
    });
    rerender({ start: `${Y}-07-10`, end: "" });
    expect(result.current).toEqual({
      startDate: `${Y}-04-10`,
      endDate: "",
      invertedRange: false,
      crossYearRange: false,
      loneDateConflict: "start",
    });
  });
});
