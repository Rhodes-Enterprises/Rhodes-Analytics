/**
 * New Year's rollover audit — clock-injected unit checks. NO Snowflake, no
 * server, runs in milliseconds. (audit:all discovers it automatically.)
 *
 * Why this exists: the dashboards roll their YTD windows and day-scoped
 * cache keys at America/Chicago midnight, not UTC. A regression back to UTC
 * is only OBSERVABLE between 6-7pm and midnight Chicago, when UTC is already
 * tomorrow — the Snowflake-backed audits run at arbitrary hours and would
 * almost never land in that window, so a silent regression would ship and
 * the Community List would ring in the new year ~6 hours early on Dec 31.
 * These checks inject a fixed clock into the REAL production derivations, so
 * the regression fails the pre-ship gate on any day, at any hour:
 *
 *   1. Window derivation (todayChicago / communityListWindow) against fixed
 *      instants: New Year's Eve 11pm Chicago (UTC already Jan 1) must stay
 *      on the OLD year; just after Chicago midnight must roll over; an
 *      ordinary 8pm summer evening; both DST transitions. Each case declares
 *      which wrong implementations (pure UTC, frozen -6, frozen -5) it
 *      catches, and the audit verifies those declarations against simulated
 *      wrong implementations — proving every case can actually fail.
 *   2. Binding: the REAL getCommunityList (not a reimplementation) is called
 *      with the same fixed clocks against a pre-seeded cache. It must return
 *      the seeded sentinel as a pure cache hit on exactly the key
 *      communityListWindow predicts — the old year's key at 11pm Dec 31, the
 *      new year's key just after midnight. Snowflake env is cleared up top,
 *      so if the key drifts, the loader fails fast on missing session config
 *      (SnowflakeConfigError) instead of touching the network.
 *   3. Single definition: no other src/ file may build its own date
 *      formatter or UTC-day string; business days must keep flowing through
 *      lib/chicago-date.ts, or these unit checks would silently stop
 *      covering the code that actually serves requests.
 *   4. Route defaults: the REAL buildFilters / buildLeasingFilters — the
 *      functions every dashboard route derives its window through — with
 *      the same fixed clocks. The default window must stay on the OLD
 *      quarter / Leasing year at 11pm Dec 31 Chicago (UTC already Jan 1),
 *      flip both just after Chicago midnight, flip the quarter but not the
 *      year across Mar 31 -> Apr 1, and keep toDate on the Chicago "today"
 *      clamped into explicit windows at the boundary — each with its own
 *      catch table verified against simulated wrong derivations, so a
 *      regression (e.g. quarter math computed from the raw Date) fails
 *      here on any day, at any hour.
 *
 * Unlike the sibling audits this one deliberately IGNORES AUDIT_API_BASE:
 * clock injection is only possible in-process against current source.
 *
 * Run from artifacts/api-server:  pnpm run audit:rollover
 * Exits 0 when every check passes, 1 otherwise.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { CacheAccess } from "../src/lib/cache-observer";

// Must happen BEFORE the app modules load below: this audit must never reach
// Snowflake, even in its failure mode. With the session env absent,
// querySnowflake throws SnowflakeConfigError before any network I/O.
delete process.env.SNOWFLAKE_DATABASE;
delete process.env.SNOWFLAKE_SCHEMA;
process.env.LOG_LEVEL ??= "warn"; // keep pino module-init quiet

const { todayChicago } = await import("../src/lib/chicago-date");
const { communityListWindow, getCommunityList } = await import(
  "../src/lib/marketing-dashboards"
);
const { cached } = await import("../src/lib/overview-targets");
const { setCacheObserver } = await import("../src/lib/cache-observer");
// The REAL route-default builders: every dashboard route (Overview,
// marketing, Leasing) derives its window through these two functions.
const { buildFilters, buildLeasingFilters } = await import("../src/routes/dashboards");

let passes = 0;
let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passes++;
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Part 1: clock-injected Chicago day / YTD window derivation
// ---------------------------------------------------------------------------

/** Wrong implementations a case is declared to catch (verified in Part 1b). */
type WrongImpl = "utc" | "frozen-cst" | "frozen-cdt";

interface WindowCase {
  name: string;
  /** The fixed instant fed to the clock (UTC ISO). */
  instant: string;
  /** The same instant on the Chicago wall clock (documentation). */
  chicago: string;
  expectToday: string;
  expectYearStart: string;
  /** Wrong implementations that yield a DIFFERENT (wrong) date here. */
  catches: WrongImpl[];
}

// DST anchors: US DST in 2026 starts Sunday Mar 8 (2am CST -> 3am CDT) and
// ends Sunday Nov 1 (2am CDT -> 1am CST). Chicago is UTC-6 (CST) in winter,
// UTC-5 (CDT) in summer, so Chicago midnight is 06:00Z in winter, 05:00Z in
// summer.
const CASES: WindowCase[] = [
  {
    name: "New Year's Eve 11pm Chicago — YTD stays on the OLD year",
    instant: "2027-01-01T05:00:00Z",
    chicago: "2026-12-31 23:00 CST",
    expectToday: "2026-12-31",
    expectYearStart: "2026-01-01",
    catches: ["utc", "frozen-cdt"],
  },
  {
    name: "last second before Chicago midnight on New Year's",
    instant: "2027-01-01T05:59:59Z",
    chicago: "2026-12-31 23:59:59 CST",
    expectToday: "2026-12-31",
    expectYearStart: "2026-01-01",
    catches: ["utc", "frozen-cdt"],
  },
  {
    name: "just after Chicago midnight — rolls to the new year",
    instant: "2027-01-01T06:00:05Z",
    chicago: "2027-01-01 00:00:05 CST",
    expectToday: "2027-01-01",
    expectYearStart: "2027-01-01",
    catches: [],
  },
  {
    name: "ordinary summer evening, 8pm Chicago (UTC already tomorrow)",
    instant: "2026-08-28T01:00:00Z",
    chicago: "2026-08-27 20:00 CDT",
    expectToday: "2026-08-27",
    expectYearStart: "2026-01-01",
    catches: ["utc"],
  },
  {
    name: "DST spring-forward night (Mar 8 2026), 11:30pm CDT",
    instant: "2026-03-09T04:30:00Z",
    chicago: "2026-03-08 23:30 CDT",
    expectToday: "2026-03-08",
    expectYearStart: "2026-01-01",
    catches: ["utc"],
  },
  {
    name: "half past Chicago midnight after spring-forward (frozen -6 lags a day)",
    instant: "2026-03-09T05:30:00Z",
    chicago: "2026-03-09 00:30 CDT",
    expectToday: "2026-03-09",
    expectYearStart: "2026-01-01",
    catches: ["frozen-cst"],
  },
  {
    name: "DST fall-back morning (Nov 1 2026), 00:30 CDT",
    instant: "2026-11-01T05:30:00Z",
    chicago: "2026-11-01 00:30 CDT",
    expectToday: "2026-11-01",
    expectYearStart: "2026-01-01",
    catches: ["frozen-cst"],
  },
  {
    name: "evening of fall-back day, 11:30pm CST (UTC already Nov 2)",
    instant: "2026-11-02T05:30:00Z",
    chicago: "2026-11-01 23:30 CST",
    expectToday: "2026-11-01",
    expectYearStart: "2026-01-01",
    catches: ["utc", "frozen-cdt"],
  },
];

console.log("Part 1: clock-injected Chicago day / YTD window derivation");
for (const c of CASES) {
  const now = new Date(c.instant);
  const got = todayChicago(now);
  const w = communityListWindow(now);
  const wantKey = `communities:v2:${c.expectToday}`;
  const ok =
    got === c.expectToday &&
    w.today === c.expectToday &&
    w.yearStart === c.expectYearStart &&
    w.cacheKey === wantKey;
  check(
    `${c.name} [${c.instant} = ${c.chicago}]`,
    ok,
    `todayChicago=${got}, window=${JSON.stringify(w)}; expected today=${c.expectToday}, yearStart=${c.expectYearStart}, cacheKey=${wantKey}`,
  );
}

// ---- Part 1b: prove every case can fail (simulated wrong implementations).
// A case that "catches" nothing it claims — or catches something it doesn't
// claim — means the table and reality drifted apart; both directions fail.
console.log("\nPart 1b: catch-table verification (checks must be able to fail)");
const WRONG_IMPLS: Record<WrongImpl, (d: Date) => string> = {
  utc: (d) => d.toISOString().slice(0, 10),
  "frozen-cst": (d) => new Date(d.getTime() - 6 * 3_600_000).toISOString().slice(0, 10),
  "frozen-cdt": (d) => new Date(d.getTime() - 5 * 3_600_000).toISOString().slice(0, 10),
};
const ALL_WRONG: WrongImpl[] = ["utc", "frozen-cst", "frozen-cdt"];
for (const c of CASES) {
  for (const impl of ALL_WRONG) {
    const wrong = WRONG_IMPLS[impl](new Date(c.instant));
    const differs = wrong !== c.expectToday;
    const declared = c.catches.includes(impl);
    check(
      `catch table: "${c.name}" vs ${impl}`,
      differs === declared,
      declared
        ? `declared to catch ${impl}, but that wrong impl also yields ${wrong} — the case lost its teeth`
        : `not declared to catch ${impl}, yet that impl yields ${wrong} != ${c.expectToday} — update the case's catches`,
    );
  }
}
for (const impl of ALL_WRONG) {
  check(
    `suite catches a ${impl} regression somewhere`,
    CASES.some((c) => c.catches.includes(impl)),
    "add a case whose Chicago date differs under this wrong implementation",
  );
}

// ---------------------------------------------------------------------------
// Part 2: the REAL getCommunityList derives its window/key from the helper
// ---------------------------------------------------------------------------

console.log("\nPart 2: getCommunityList binding (pre-seeded cache, observer, no Snowflake)");

const OLD_YEAR = new Date("2027-01-01T05:00:00Z"); // Dec 31, 11pm Chicago
const NEW_YEAR = new Date("2027-01-01T06:00:05Z"); // just after Chicago midnight
const oldW = communityListWindow(OLD_YEAR);
const newW = communityListWindow(NEW_YEAR);
check(
  "cache key rolls over across Chicago midnight",
  oldW.cacheKey !== newW.cacheKey &&
    oldW.cacheKey.endsWith("2026-12-31") &&
    newW.cacheKey.endsWith("2027-01-01"),
  `old=${oldW.cacheKey} new=${newW.cacheKey}`,
);

// Seed the exact predicted keys BEFORE installing the observer (seeding
// itself emits a miss). If getCommunityList derives the same keys, each call
// below is a pure fresh hit: sentinel comes back, the Snowflake loader never
// runs. If its key derivation drifts (e.g. back to UTC), the call misses,
// the loader throws SnowflakeConfigError, and the check fails with both keys
// in the message.
const sentinelOld = { communities: [], sentinel: "old-year" };
const sentinelNew = { communities: [], sentinel: "new-year" };
await cached(oldW.cacheKey, async () => sentinelOld);
await cached(newW.cacheKey, async () => sentinelNew);

async function bindingCase(
  label: string,
  now: Date,
  expectedKey: string,
  sentinel: unknown,
): Promise<void> {
  const events: CacheAccess[] = [];
  setCacheObserver((e) => events.push(e));
  let out: unknown;
  let error: unknown;
  try {
    out = await Promise.race([
      getCommunityList(now).catch((err) => {
        error = err;
        return undefined;
      }),
      // Budget so a future loader that no longer fails fast cannot hang the
      // audit; unref'd so the timer never holds the process open.
      new Promise((resolve) => {
        setTimeout(() => resolve("__timeout__"), 10_000).unref();
      }),
    ]);
  } finally {
    setCacheObserver(null);
  }
  const observed = events.map((e) => `${e.outcome}:${e.key}`).join(", ") || "(none)";
  if (out === "__timeout__") {
    check(
      label,
      false,
      `timed out after 10s — cache key drifted AND the loader no longer fails fast without Snowflake config; observed [${observed}]`,
    );
    return;
  }
  if (error !== undefined) {
    check(
      label,
      false,
      `the Snowflake loader ran, so the key drifted off ${expectedKey} (${String(error)}); observed [${observed}]`,
    );
    return;
  }
  check(
    label,
    out === sentinel &&
      events.length === 1 &&
      events[0].outcome === "hit" &&
      events[0].key === expectedKey,
    `expected exactly one pure hit on ${expectedKey}; observed [${observed}]; seeded sentinel returned: ${out === sentinel}`,
  );
}

await bindingCase(
  "getCommunityList at Dec 31 11pm Chicago reads the OLD year's key",
  OLD_YEAR,
  oldW.cacheKey,
  sentinelOld,
);
await bindingCase(
  "getCommunityList just after Chicago midnight reads the NEW year's key",
  NEW_YEAR,
  newW.cacheKey,
  sentinelNew,
);

// ---------------------------------------------------------------------------
// Part 3: single-definition guard — the helper stays the only day source
// ---------------------------------------------------------------------------

console.log("\nPart 3: single-definition guard over src/");

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = join(pkgRoot, "src");
const ALLOWED = join("lib", "chicago-date.ts");
const BANNED: { re: RegExp; why: string }[] = [
  { re: /Intl\.DateTimeFormat/, why: "builds its own date formatter" },
  { re: /timeZone\s*:/, why: "sets an explicit timeZone" },
  { re: /new Date\(\)\s*\.\s*toISOString/, why: "derives a day from the UTC clock" },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

// The guard is only meaningful while the allowed module still owns the
// formatter — if chicago-date.ts is moved/renamed, fail loudly instead of
// passing vacuously.
let helperText = "";
try {
  helperText = readFileSync(join(srcRoot, ALLOWED), "utf8");
} catch {
  /* handled below */
}
check(
  "lib/chicago-date.ts exists and owns the Chicago formatter",
  /Intl\.DateTimeFormat/.test(helperText) && /America\/Chicago/.test(helperText),
  "the shared helper moved or lost its formatter — update this audit's ALLOWED path alongside it",
);

const violations: string[] = [];
for (const file of walk(srcRoot)) {
  const rel = relative(srcRoot, file);
  if (rel === ALLOWED) continue;
  const text = readFileSync(file, "utf8");
  for (const { re, why } of BANNED) {
    if (re.test(text)) violations.push(`src/${rel} ${why} (${re.source})`);
  }
}
check(
  "no src/ file besides lib/chicago-date.ts builds its own day/formatter",
  violations.length === 0,
  `${violations.join("; ")} — derive business days via todayChicago from lib/chicago-date.ts (or extend that module), then teach this audit about it`,
);

// ---------------------------------------------------------------------------
// Part 4: route default windows — the REAL buildFilters / buildLeasingFilters
// ---------------------------------------------------------------------------
//
// buildFilters({}) defaults Overview/marketing dashboards to the CURRENT
// quarter; buildLeasingFilters({}) defaults Leasing to the CURRENT year.
// "Current" must come from the Chicago today string: quarter/year math
// computed from the raw Date would flip the default window hours early on
// boundary evenings — exactly the 6pm-midnight window the Snowflake-backed
// audits almost never run in.

console.log("\nPart 4: route default windows (real buildFilters / buildLeasingFilters)");

interface Win {
  startDate: string;
  endDate: string;
  toDate: string;
}

function fmtWin(w: Win): string {
  return `${w.startDate}..${w.endDate} toDate=${w.toDate}`;
}

function winOf(f: { startDate: string; endDate: string; toDate: string }): Win {
  return { startDate: f.startDate, endDate: f.endDate, toDate: f.toDate };
}

/**
 * An instant whose Chicago calendar day is exactly `day` (18:00Z = noon CST
 * / 1pm CDT, same day in Chicago and UTC alike). Part 4b feeds a wrong
 * implementation's "today" through the REAL downstream quarter/year math by
 * evaluating the real builders at this instant — no reimplementation of the
 * quarter derivation that could drift from production code.
 */
function atChicagoNoon(day: string): Date {
  const instant = new Date(day + "T18:00:00Z");
  if (todayChicago(instant) !== day) {
    throw new Error(`atChicagoNoon premise broken for ${day} — got ${todayChicago(instant)}`);
  }
  return instant;
}

interface RouteDefaultsCase {
  name: string;
  /** The fixed instant fed to the clock (UTC ISO). */
  instant: string;
  /** The same instant on the Chicago wall clock (documentation). */
  chicago: string;
  /** Expected buildFilters({}) default window (current Chicago quarter). */
  quarter: Win;
  /** Expected buildLeasingFilters({}) default window (current Chicago year). */
  leasing: Win;
  /** Wrong today-derivations that change SOME default field (verified in 4b). */
  catches: WrongImpl[];
}

const ROUTE_CASES: RouteDefaultsCase[] = [
  {
    name: "New Year's Eve 11pm Chicago — defaults stay on OLD year's Q4 / Leasing 2026",
    instant: "2027-01-01T05:00:00Z",
    chicago: "2026-12-31 23:00 CST",
    quarter: { startDate: "2026-10-01", endDate: "2026-12-31", toDate: "2026-12-31" },
    leasing: { startDate: "2026-01-01", endDate: "2026-12-31", toDate: "2026-12-31" },
    catches: ["utc", "frozen-cdt"],
  },
  {
    name: "just after Chicago midnight — defaults flip to Q1 / Leasing 2027",
    instant: "2027-01-01T06:00:05Z",
    chicago: "2027-01-01 00:00:05 CST",
    quarter: { startDate: "2027-01-01", endDate: "2027-03-31", toDate: "2027-01-01" },
    leasing: { startDate: "2027-01-01", endDate: "2027-12-31", toDate: "2027-01-01" },
    catches: [],
  },
  {
    name: "Mar 31 8pm Chicago (UTC already Apr 1) — quarter boundary that is NOT a year boundary",
    instant: "2026-04-01T01:00:00Z",
    chicago: "2026-03-31 20:00 CDT",
    quarter: { startDate: "2026-01-01", endDate: "2026-03-31", toDate: "2026-03-31" },
    leasing: { startDate: "2026-01-01", endDate: "2026-12-31", toDate: "2026-03-31" },
    catches: ["utc"],
  },
  {
    name: "just after Chicago midnight Apr 1 — quarter flips, Leasing year does not",
    instant: "2026-04-01T05:00:05Z",
    chicago: "2026-04-01 00:00:05 CDT",
    quarter: { startDate: "2026-04-01", endDate: "2026-06-30", toDate: "2026-04-01" },
    leasing: { startDate: "2026-01-01", endDate: "2026-12-31", toDate: "2026-04-01" },
    catches: ["frozen-cst"],
  },
  {
    name: "ordinary summer evening — windows unchanged but toDate stays on Chicago today",
    instant: "2026-08-28T01:00:00Z",
    chicago: "2026-08-27 20:00 CDT",
    quarter: { startDate: "2026-07-01", endDate: "2026-09-30", toDate: "2026-08-27" },
    leasing: { startDate: "2026-01-01", endDate: "2026-12-31", toDate: "2026-08-27" },
    catches: ["utc"],
  },
];

for (const c of ROUTE_CASES) {
  const now = new Date(c.instant);
  const q = winOf(buildFilters({}, now));
  const l = winOf(buildLeasingFilters({}, now));
  check(
    `${c.name} [${c.instant} = ${c.chicago}]`,
    fmtWin(q) === fmtWin(c.quarter) && fmtWin(l) === fmtWin(c.leasing),
    `buildFilters {${fmtWin(q)}} expected {${fmtWin(c.quarter)}}; buildLeasingFilters {${fmtWin(l)}} expected {${fmtWin(c.leasing)}}`,
  );
}

// ---- Part 4b: catch-table verification (route defaults must be able to
// fail). The simulated wrong output is the real builders evaluated at
// Chicago-noon of the wrong impl's "today" — exactly what a regressed today
// derivation would produce, since Part 4 pins the defaults as a pure
// function of the Chicago day. Both directions must match the declarations.
console.log("\nPart 4b: route-default catch-table verification");
for (const c of ROUTE_CASES) {
  for (const impl of ALL_WRONG) {
    const wrongToday = WRONG_IMPLS[impl](new Date(c.instant));
    const sim = atChicagoNoon(wrongToday);
    const simQ = winOf(buildFilters({}, sim));
    const simL = winOf(buildLeasingFilters({}, sim));
    const differs = fmtWin(simQ) !== fmtWin(c.quarter) || fmtWin(simL) !== fmtWin(c.leasing);
    const declared = c.catches.includes(impl);
    check(
      `route catch table: "${c.name}" vs ${impl}`,
      differs === declared,
      declared
        ? `declared to catch ${impl}, but its today (${wrongToday}) yields the same defaults — the case lost its teeth`
        : `not declared to catch ${impl}, yet its today (${wrongToday}) yields {${fmtWin(simQ)}} / {${fmtWin(simL)}} — update the case's catches`,
    );
  }
}
for (const impl of ALL_WRONG) {
  check(
    `route defaults catch a ${impl} regression somewhere`,
    ROUTE_CASES.some((c) => c.catches.includes(impl)),
    "add a route-defaults case whose windows differ under this wrong implementation",
  );
}

// ---------------------------------------------------------------------------
// Part 5: explicit windows at the boundary — toDate clamps on Chicago time
// ---------------------------------------------------------------------------
//
// With an explicit startDate/endDate, toDate must be the Chicago "today"
// clamped INTO that window: at 11pm Dec 31 a request for the NEW year's Q1
// paces against Jan 1 (today is still outside, below the window), and just
// after midnight a request for the OLD Q4 paces against Dec 31 (today is
// now past the window). Both builders share the clamp, so both are checked;
// a dedicated wrong-impl table proves each case can fail.

console.log("\nPart 5: explicit-window toDate clamp at the boundary");

type WrongToDate = "unclamped" | "utc-today" | "always-end";

interface ClampCase {
  name: string;
  instant: string;
  chicago: string;
  window: { startDate: string; endDate: string };
  expectToDate: string;
  /** Wrong toDate derivations that yield a different date here (see 5b). */
  catches: WrongToDate[];
}

const CLAMP_CASES: ClampCase[] = [
  {
    name: "Dec 31 11pm Chicago + explicit NEW-year Q1 — toDate clamps UP to Jan 1",
    instant: "2027-01-01T05:00:00Z",
    chicago: "2026-12-31 23:00 CST",
    window: { startDate: "2027-01-01", endDate: "2027-03-31" },
    expectToDate: "2027-01-01",
    catches: ["unclamped", "always-end"],
  },
  {
    name: "just after Chicago midnight + explicit OLD Q4 — toDate clamps DOWN to Dec 31",
    instant: "2027-01-01T06:00:05Z",
    chicago: "2027-01-01 00:00:05 CST",
    window: { startDate: "2026-10-01", endDate: "2026-12-31" },
    expectToDate: "2026-12-31",
    catches: ["unclamped"],
  },
  {
    name: "summer evening + explicit window containing today — toDate stays Chicago today",
    instant: "2026-08-28T01:00:00Z",
    chicago: "2026-08-27 20:00 CDT",
    window: { startDate: "2026-07-01", endDate: "2026-09-30" },
    expectToDate: "2026-08-27",
    catches: ["utc-today", "always-end"],
  },
];

function clampDay(day: string, w: { startDate: string; endDate: string }): string {
  return day < w.startDate ? w.startDate : day > w.endDate ? w.endDate : day;
}

const WRONG_TODATE: Record<
  WrongToDate,
  (now: Date, w: { startDate: string; endDate: string }) => string
> = {
  // Right Chicago day, forgot the clamp entirely.
  unclamped: (now) => todayChicago(now),
  // Correct clamp, but fed the UTC day.
  "utc-today": (now, w) => clampDay(now.toISOString().slice(0, 10), w),
  // Naive "pace against the period end" regression.
  "always-end": (_now, w) => w.endDate,
};
const ALL_WRONG_TODATE: WrongToDate[] = ["unclamped", "utc-today", "always-end"];

for (const c of CLAMP_CASES) {
  const now = new Date(c.instant);
  const q = buildFilters({ ...c.window }, now);
  const l = buildLeasingFilters({ ...c.window }, now);
  check(
    `${c.name} [${c.instant} = ${c.chicago}]`,
    q.startDate === c.window.startDate &&
      q.endDate === c.window.endDate &&
      q.toDate === c.expectToDate &&
      l.startDate === c.window.startDate &&
      l.endDate === c.window.endDate &&
      l.toDate === c.expectToDate,
    `buildFilters toDate=${q.toDate}, buildLeasingFilters toDate=${l.toDate}; expected ${c.expectToDate} within ${c.window.startDate}..${c.window.endDate}`,
  );
}

console.log("\nPart 5b: clamp catch-table verification");
for (const c of CLAMP_CASES) {
  for (const impl of ALL_WRONG_TODATE) {
    const wrong = WRONG_TODATE[impl](new Date(c.instant), c.window);
    const differs = wrong !== c.expectToDate;
    const declared = c.catches.includes(impl);
    check(
      `clamp catch table: "${c.name}" vs ${impl}`,
      differs === declared,
      declared
        ? `declared to catch ${impl}, but that wrong impl also yields ${wrong} — the case lost its teeth`
        : `not declared to catch ${impl}, yet that impl yields ${wrong} != ${c.expectToDate} — update the case's catches`,
    );
  }
}
for (const impl of ALL_WRONG_TODATE) {
  check(
    `clamp checks catch a ${impl} regression somewhere`,
    CLAMP_CASES.some((c) => c.catches.includes(impl)),
    "add a clamp case that fails under this wrong toDate implementation",
  );
}

// ---------------------------------------------------------------------------

console.log("");
if (failures > 0) {
  console.error(`audit:rollover — ${failures}/${passes + failures} check(s) FAILED`);
  process.exit(1);
}
console.log(
  `audit:rollover — all ${passes} checks passed (New Year's rollover and default quarter/Leasing-year windows pinned to Chicago midnight).`,
);
