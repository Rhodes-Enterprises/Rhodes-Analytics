/**
 * Boundary tests for the client-side mirror of the API's default date
 * ranges (buildFilters / buildLeasingFilters) and the lone-date guard built
 * on it.
 *
 * Plain `node --test` — Node runs the TypeScript directly, no framework:
 *   pnpm --filter @workspace/rhodes-analytics run test
 *
 * The helpers take today's date as an explicit YYYY-MM-DD string, so the
 * client/server timezone-mismatch scenarios reduce to injecting the
 * *Chicago* date the server would use — the functions never consult the
 * machine's local timezone at all.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  chicagoToday,
  loneDateConflict,
  serverDefaultRange,
} from "./date-defaults.ts";

test("quarter defaults: fixed bounds across all four quarters", () => {
  const cases: [today: string, start: string, end: string][] = [
    ["2026-01-01", "2026-01-01", "2026-03-31"],
    ["2026-02-15", "2026-01-01", "2026-03-31"],
    ["2026-03-31", "2026-01-01", "2026-03-31"], // last day of Q1 is still Q1
    ["2026-04-01", "2026-04-01", "2026-06-30"], // first day of Q2
    ["2026-06-30", "2026-04-01", "2026-06-30"],
    ["2026-07-01", "2026-07-01", "2026-09-30"],
    ["2026-09-30", "2026-07-01", "2026-09-30"],
    ["2026-10-01", "2026-10-01", "2026-12-31"],
    ["2026-12-31", "2026-10-01", "2026-12-31"], // year's last day: Q4, same year
    ["2027-01-01", "2027-01-01", "2027-03-31"], // new year rolls to Q1
  ];
  for (const [today, start, end] of cases) {
    assert.deepEqual(
      serverDefaultRange("quarter", today),
      { start, end },
      `today=${today}`,
    );
  }
});

test("year defaults: Jan 1 – Dec 31 of today's Chicago year", () => {
  assert.deepEqual(serverDefaultRange("year", "2026-08-26"), {
    start: "2026-01-01",
    end: "2026-12-31",
  });
  assert.deepEqual(serverDefaultRange("year", "2026-12-31"), {
    start: "2026-01-01",
    end: "2026-12-31",
  });
  assert.deepEqual(serverDefaultRange("year", "2027-01-01"), {
    start: "2027-01-01",
    end: "2027-12-31",
  });
});

test("lone start after the default end is held (the Nov 15 case)", () => {
  const q3 = serverDefaultRange("quarter", "2026-08-26"); // Q3 ends 2026-09-30
  assert.equal(loneDateConflict("2026-11-15", "", q3), "start");
  assert.equal(loneDateConflict("2026-09-30", "", q3), null); // on the boundary: fine
  assert.equal(loneDateConflict("2026-10-01", "", q3), "start"); // one day past: held
});

test("lone end before the default start is held (mirrored case)", () => {
  const q3 = serverDefaultRange("quarter", "2026-08-26"); // Q3 starts 2026-07-01
  assert.equal(loneDateConflict("", "2026-05-31", q3), "end");
  assert.equal(loneDateConflict("", "2026-07-01", q3), null); // on the boundary: fine
  assert.equal(loneDateConflict("", "2026-06-30", q3), "end"); // one day before: held
});

test("quarter transition: guard follows the injected Chicago date, not the viewer's clock", () => {
  // A viewer's local calendar can already read July 1 (e.g. UTC+14) while
  // Chicago is still June 30 — the server fills a missing end with ITS
  // quarter (Q2, ending June 30), so a lone July 1 start must be held. The
  // guard sees only the Chicago date, so it agrees with the server no matter
  // what the viewer's clock says.
  const chicagoStillQ2 = serverDefaultRange("quarter", "2026-06-30");
  assert.deepEqual(chicagoStillQ2, { start: "2026-04-01", end: "2026-06-30" });
  assert.equal(loneDateConflict("2026-07-01", "", chicagoStillQ2), "start");

  // One Chicago day later both sides agree it's Q3 and the same pick applies.
  const chicagoQ3 = serverDefaultRange("quarter", "2026-07-01");
  assert.equal(loneDateConflict("2026-07-01", "", chicagoQ3), null);
});

test("year-kind defaults can never flag a same-year lone date (Leasing stays unguarded)", () => {
  const y = serverDefaultRange("year", "2026-06-30");
  assert.equal(loneDateConflict("2026-12-31", "", y), null);
  assert.equal(loneDateConflict("", "2026-01-01", y), null);
});

test("complete pairs and the empty state never flag", () => {
  const q = serverDefaultRange("quarter", "2026-08-26");
  // A full pair belongs to the inverted/cross-year guards, not this one.
  assert.equal(loneDateConflict("2026-11-15", "2026-12-01", q), null);
  assert.equal(loneDateConflict("", "", q), null);
});

test("chicagoToday returns a real YYYY-MM-DD calendar date", () => {
  const today = chicagoToday();
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(
    new Date(`${today}T00:00:00Z`).toISOString().slice(0, 10),
    today,
  );
});
