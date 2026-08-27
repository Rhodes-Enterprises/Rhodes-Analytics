/**
 * audit:flag-guard — mocked self-test for the GA Yes/No flag label-drift
 * guard (auditGaFlagLabels in ga-property-guard.ts), the guard that keeps
 * an upstream relabel of IS_NEW_USER / IS_SESSION_START values from
 * silently zeroing the Overview NEW-users columns and the Leasing
 * web-traffic numbers.
 *
 * The guard's real decision logic runs against FABRICATED query rows via
 * its injectable query runner — no Snowflake, no API server — so this
 * audit is fast and cannot flake on live data. Live coverage of the real
 * SQL comes from the guard running inside audit:dashboard's and
 * audit:leasing's default-view scenarios in the same audit:all pass; this
 * script pins the decision paths those live runs cannot reach on demand:
 *
 *  1. Relabel drift: an active window whose rows carry 'TRUE'/'No' but no
 *     'Yes' must FAIL — the exact upstream-relabel signature the guard
 *     exists to catch. Live data always carries 'Yes', so only a mocked
 *     run keeps proving the FAIL path stays wired. (The FAIL diagnostics
 *     printed during that case are the guard's own output, expected here.)
 *  2. Multi-label quiet window: the SAME users appear under two non-'Yes'
 *     labels, so per-label distinct counts sum past the threshold while
 *     the deduplicated () grouping-set row stays below it. Must be exempt
 *     — summing per-label counts was a real false-positive path.
 *  3. Healthy active window ('Yes' present) must pass.
 *  4. Empty window (no GA rows) must be exempt as too quiet.
 *
 * Run from artifacts/api-server:
 *   pnpm run audit:flag-guard
 *
 * Env: AUDIT_GA_FLAG_GUARD_MIN_TOTAL — threshold under test; the cases
 *      scale off the live value rather than assuming the default.
 *
 * Exits 0 when every case behaves, 1 otherwise.
 */

import {
  auditGaFlagLabels,
  EXPECTED_GA_FLAGS,
  GA_FLAG_GUARD_MIN_TOTAL,
  type FlagRow,
} from "./ga-property-guard";

const T = GA_FLAG_GUARD_MIN_TOTAL;

/** Feed the same fabricated rows to the guard's query for every flag. */
const fake = (rows: FlagRow[]) => async () => rows;

let failures = 0;
async function expectCase(label: string, rows: FlagRow[], want: boolean) {
  console.log(`\n-- case: ${label} (expect ${want ? "pass" : "fail"})`);
  const got = await auditGaFlagLabels("2026-01-01", "2026-01-31", fake(rows));
  if (got === want) {
    console.log(`PASS case "${label}"`);
  } else {
    console.error(`FAIL case "${label}" — guard returned ${got}, expected ${want}`);
    failures++;
  }
}

console.log(
  `audit:flag-guard — mocked decision-logic self-test ` +
    `(threshold=${T}, ${EXPECTED_GA_FLAGS.length} expected flags)`,
);

await expectCase(
  "relabeled active window ('TRUE'/'No', no 'Yes') FAILS",
  [
    { LABEL: "TRUE", G: 0, N: 5_000, USERS: T * 90 },
    { LABEL: "No", G: 0, N: 9_000, USERS: T * 95 },
    { LABEL: "(null)", G: 1, N: 14_000, USERS: T * 100 },
  ],
  false,
);

await expectCase(
  "multi-label quiet window is exempt (dedup total beats per-label sum)",
  [
    { LABEL: "TRUE", G: 0, N: 40, USERS: T - 1 },
    { LABEL: "FALSE", G: 0, N: 30, USERS: T - 1 },
    { LABEL: "(null)", G: 1, N: 70, USERS: T - 1 },
  ],
  true,
);

await expectCase(
  "healthy active window ('Yes' present) passes",
  [
    { LABEL: "Yes", G: 0, N: 5_000, USERS: T * 90 },
    { LABEL: "No", G: 0, N: 9_000, USERS: T * 95 },
    { LABEL: "(null)", G: 1, N: 14_000, USERS: T * 100 },
  ],
  true,
);

await expectCase("empty window (no GA rows) is exempt", [], true);

if (failures > 0) {
  console.error(
    `\naudit:flag-guard: ${failures} case(s) FAILED — the flag guard's decision logic regressed.`,
  );
  process.exit(1);
}
console.log(`\naudit:flag-guard: all cases passed.`);
