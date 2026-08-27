/**
 * Round-trip tests for the shared Excel (XLSX) download builder
 * (`pnpm run test:xlsx`).
 *
 * buildDownloadWorkbook is the exact code path behind every download
 * button's "Excel (.xlsx)" menu item. Each case builds a workbook, writes a
 * real .xlsx buffer, re-reads that buffer with exceljs, and asserts on what
 * Excel would actually see:
 *   1. The header row is bold and frozen (pane split below row 1).
 *   2. "%"-headed columns hold true percent cells: 0–100-scale inputs are
 *      stored as fractions with a percent number format ("0.0%").
 *   3. Numeric columns carry thousands-separator formats with decimals
 *      matched to the data (capped at 2); full precision stays in the cell.
 *   4. null/undefined/NaN/"" become genuinely empty cells.
 *   5. Strings survive verbatim — including a leading "=" (stored as text,
 *      never a formula; XLSX needs no apostrophe guard).
 *   6. Column widths are auto-sized from content within [9, 44] clamps.
 *   7. Explicit per-column overrides beat header inference.
 *   8. With `info`, a second "Info" sheet records provenance (dashboard,
 *      filters, America/Chicago timestamps) with bold labels; "Data" stays
 *      first and active. Without `info` the workbook has one sheet, and
 *      without `dataAsOf` the Info sheet has no "Data as of" row.
 *
 * Bundled with esbuild and run with node (same pattern as test-csv): exits 0
 * when every assertion passes, non-zero otherwise.
 */
import assert from "node:assert/strict";
import { Workbook } from "exceljs";
import {
  buildDownloadWorkbook,
  formatChicagoTimestamp,
  resolveColumnFormats,
  type XlsxColumnFormat,
} from "../src/lib/xlsx";
import type { CsvValue, DownloadInfo } from "../src/lib/utils";

let assertions = 0;
function ok(cond: boolean, label: string): void {
  assert.ok(cond, label);
  assertions++;
}
function eq<T>(actual: T, expected: T, label: string): void {
  assert.deepEqual(actual, expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  assertions++;
}
function close(actual: unknown, expected: number, label: string): void {
  assert.ok(
    typeof actual === "number" && Math.abs(actual - expected) < 1e-9,
    `${label}: expected ≈${expected}, got ${JSON.stringify(actual)}`,
  );
  assertions++;
}

/** Build → write buffer → load in a fresh Workbook, i.e. what Excel opens. */
async function roundTrip(
  headers: string[],
  rows: CsvValue[][],
  overrides?: readonly (XlsxColumnFormat | undefined)[],
) {
  const built = buildDownloadWorkbook(headers, rows, overrides);
  const buffer = await built.xlsx.writeBuffer();
  const reloaded = new Workbook();
  await reloaded.xlsx.load(buffer);
  const sheet = reloaded.getWorksheet("Data");
  assert.ok(sheet, "worksheet 'Data' exists after reload");
  assertions++;
  return sheet;
}

async function main(): Promise<void> {
// ---------------------------------------------------------------------------
// Case 1: a realistic dashboard table (mirrors the community-summary shape).
// ---------------------------------------------------------------------------
const HEADERS = [
  "Community", // text
  "Ratified", // integers → #,##0
  "TD Goal", // decimals → #,##0.0
  "PTG %", // percent (0–100 scale, may be null)
  "Leads % of Total", // percent with % mid-header
  "Notes", // text incl. formula-looking + multi-line strings
];
const ROWS: CsvValue[][] = [
  ["Cypress Creek", 1234567, 39.5, -12.3456, 18.2, "steady"],
  ["=SUM(A1:A9)", 42, 1200, 4.5, 25, undefined],
  ["Total", 1234609, 1239.5, null, Number.NaN, "line1\nline2"],
];

const sheet = await roundTrip(HEADERS, ROWS);

// 1) Frozen + bold header row.
const view = sheet.views[0];
ok(view != null && view.state === "frozen", "view state is frozen");
eq((view as { ySplit?: number }).ySplit, 1, "frozen below the header row");
eq(sheet.getRow(1).getCell(1).value, "Community", "header text survives");
ok(sheet.getRow(1).getCell(1).font?.bold === true, "header cell 1 is bold");
ok(sheet.getRow(1).getCell(4).font?.bold === true, "header cell 4 is bold");

// 2) Percent columns: 0–100 inputs become real percent cells.
close(sheet.getRow(2).getCell(4).value, -0.123456, "PTG % stored as fraction");
eq(sheet.getRow(2).getCell(4).numFmt, "0.0%", "PTG % percent format");
close(sheet.getRow(2).getCell(5).value, 0.182, "'% of Total' stored as fraction");
eq(sheet.getRow(2).getCell(5).numFmt, "0.0%", "'% of Total' percent format");
close(sheet.getRow(3).getCell(4).value, 0.045, "second-row percent fraction");

// 3) Number columns: thousands separator, decimals matched to data.
eq(sheet.getRow(2).getCell(2).value, 1234567, "integer survives exactly");
eq(sheet.getRow(2).getCell(2).numFmt, "#,##0", "integer column format");
eq(sheet.getRow(2).getCell(3).value, 39.5, "decimal survives exactly");
eq(sheet.getRow(2).getCell(3).numFmt, "#,##0.0", "one-decimal column format");

// 4) Empty cells: null, NaN, undefined all round-trip as blank.
const isBlank = (v: unknown) => v == null;
ok(isBlank(sheet.getRow(4).getCell(4).value), "null PTG cell is empty");
ok(isBlank(sheet.getRow(4).getCell(5).value), "NaN percent cell is empty");
ok(isBlank(sheet.getRow(3).getCell(6).value), "undefined text cell is empty");

// 5) Strings stay literal text — never formulas, no apostrophe mangling.
const formulaish = sheet.getRow(3).getCell(1).value;
eq(formulaish, "=SUM(A1:A9)", "leading-= string survives verbatim");
ok(typeof formulaish === "string", "leading-= cell is a string, not a formula");
eq(sheet.getRow(4).getCell(6).value, "line1\nline2", "multi-line string survives");

// 6) Auto-sized widths within clamps.
const w = (i: number) => sheet.getColumn(i).width ?? 0;
ok(w(1) >= "Cypress Creek".length + 2 - 0.01, `community column fits content (got ${w(1)})`);
ok(w(1) <= 44, "community column within max clamp");
// "Notes": longest line is "steady" (6) + 2 = 8 → clamped up to the minimum
// (10 — exceljs silently drops style-less columns at its default width 9).
ok(w(6) >= 10 - 0.01 && w(6) <= 10.5, `narrow column clamped to minimum (got ${w(6)})`);
// "Leads % of Total" header (16) + 2 = 18 dominates its short values.
ok(w(5) >= 18 - 0.01, `percent column sized by header (got ${w(5)})`);

// ---------------------------------------------------------------------------
// Case 2: width max clamp + two-decimal format cap.
// ---------------------------------------------------------------------------
const longText = "x".repeat(100);
const sheet2 = await roundTrip(
  ["Long", "Precise"],
  [
    [longText, 118.333333],
    ["short", 2],
  ],
);
ok((sheet2.getColumn(1).width ?? 0) <= 44.01, "long text column clamped to max width");
eq(sheet2.getRow(2).getCell(2).numFmt, "#,##0.00", "decimals capped at 2 in format");
close(sheet2.getRow(2).getCell(2).value, 118.333333, "full precision preserved in cell");

// ---------------------------------------------------------------------------
// Case 3: explicit overrides beat inference.
// ---------------------------------------------------------------------------
const sheet3 = await roundTrip(
  ["A", "B %"],
  [[7, 3]],
  [
    "percent", // numeric header-less column forced to percent
    "text", // %-header forced back to plain (no numFmt)
  ],
);
close(sheet3.getRow(2).getCell(1).value, 0.07, "override → percent fraction");
eq(sheet3.getRow(2).getCell(1).numFmt, "0.0%", "override → percent format");
eq(sheet3.getRow(2).getCell(2).value, 3, "text override keeps raw number value");
ok(
  !sheet3.getRow(2).getCell(2).numFmt || sheet3.getRow(2).getCell(2).numFmt === "General",
  "text override applies no number format",
);

// ---------------------------------------------------------------------------
// Case 4: inference table (pure function, mirrors real dashboard headers).
// ---------------------------------------------------------------------------
eq(
  resolveColumnFormats(
    ["Month", "Users", "PTG %", "Attainment %", "Leads % of Total", "Flags"],
    [
      ["Jan", 10, -3.2, 98.7, 12.5, "Goals"],
      ["Feb", 20, null, 101.2, 14.1, ""],
    ],
  ),
  ["text", "number", "percent", "percent", "percent", "text"],
  "header/value inference matches the dashboards' conventions",
);

// ---------------------------------------------------------------------------
// Case 5: provenance "Info" sheet — full shape.
// ---------------------------------------------------------------------------
// Newer ICU inserts a narrow no-break space (U+202F) before AM/PM; \s matches
// it in the regex, and exact comparisons normalize all spaces first.
const normSpaces = (v: unknown) => String(v).replace(/\s+/g, " ");
const CHICAGO_TS_RE = /^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s(AM|PM) C[DS]T$/;

const INFO: DownloadInfo = {
  page: "Rhodes Living Leasing",
  filters: [
    { label: "Community", value: "All" },
    { label: "Search", value: "x".repeat(100) }, // exercises the max-width clamp
    { label: "Notes", value: "=SUM(A1:A9)" }, // formula-looking value stays text
  ],
  dataAsOf: "2026-08-27T13:02:00Z", // fixed instant → deterministic CDT rendering
};

const built5 = buildDownloadWorkbook(
  ["Community", "Net"],
  [["Cypress Creek", 12]],
  undefined,
  INFO,
);
eq(built5.views?.[0]?.activeTab, 0, "built workbook sets activeTab 0 explicitly");
const wb5 = new Workbook();
await wb5.xlsx.load(await built5.xlsx.writeBuffer());

eq(
  wb5.worksheets.map((s) => s.name),
  ["Data", "Info"],
  "sheet order: Data first, Info second",
);
// In OOXML an omitted activeTab attribute means 0, so "?? 0" is the spec
// default — the assertion fails iff the file would open on the Info tab.
eq(wb5.views?.[0]?.activeTab ?? 0, 0, "workbook opens on the Data tab");

// Data sheet is byte-for-byte the usual one: same cells, bold frozen header.
const data5 = wb5.getWorksheet("Data");
assert.ok(data5, "Data sheet exists alongside Info");
assertions++;
eq(data5.getRow(1).getCell(1).value, "Community", "Data header intact with info present");
ok(data5.getRow(1).getCell(1).font?.bold === true, "Data header still bold");
ok(data5.views[0]?.state === "frozen", "Data header still frozen");
eq(data5.getRow(2).getCell(1).value, "Cypress Creek", "Data text cell intact");
eq(data5.getRow(2).getCell(2).value, 12, "Data number cell intact");

const info5 = wb5.getWorksheet("Info");
assert.ok(info5, "Info sheet exists");
assertions++;
const infoLabel = (r: number) => info5.getRow(r).getCell(1).value;
const infoValue = (r: number) => info5.getRow(r).getCell(2).value;

eq(info5.rowCount, 6, "Info rows: Dashboard + 3 filters + Exported + Data as of");
eq(infoLabel(1), "Dashboard", "row 1 label");
eq(infoValue(1), "Rhodes Living Leasing", "row 1 page name");
eq(infoLabel(2), "Community", "filter rows keep call-site order");
eq(infoValue(2), "All", "sentinel filter renders as 'All'");
eq(infoLabel(3), "Search", "second filter label");
eq(infoValue(3), "x".repeat(100), "long filter value survives verbatim");
eq(infoLabel(4), "Notes", "third filter label");
const formulaishInfo = infoValue(4);
eq(formulaishInfo, "=SUM(A1:A9)", "formula-looking filter value survives verbatim");
ok(typeof formulaishInfo === "string", "formula-looking value is text, not a formula");

eq(infoLabel(5), "Exported", "Exported row after filters");
ok(
  CHICAGO_TS_RE.test(String(infoValue(5))),
  `Exported stamp is Chicago-formatted (got ${JSON.stringify(infoValue(5))})`,
);
eq(infoLabel(6), "Data as of", "Data as of row is last");
eq(
  normSpaces(infoValue(6)),
  "Aug 27, 2026, 8:02 AM CDT",
  "fixed instant rendered in America/Chicago",
);

ok(info5.getRow(1).getCell(1).font?.bold === true, "Info label cell is bold");
ok(info5.getRow(1).getCell(2).font?.bold !== true, "Info value cell is not bold");
const infoW = (i: number) => info5.getColumn(i).width ?? 0;
ok(infoW(1) >= 10 - 0.01, `Info label column at least min width (got ${infoW(1)})`);
ok(infoW(2) <= 44.01, `Info value column clamped to max width (got ${infoW(2)})`);

// ---------------------------------------------------------------------------
// Case 6: no info → exactly one sheet (the pre-provenance workbook shape).
// ---------------------------------------------------------------------------
const wb6 = new Workbook();
await wb6.xlsx.load(await buildDownloadWorkbook(["A"], [[1]]).xlsx.writeBuffer());
eq(wb6.worksheets.map((s) => s.name), ["Data"], "no Info sheet when info is omitted");

// ---------------------------------------------------------------------------
// Case 7: info without dataAsOf → no "Data as of" row; timestamp edge cases.
// ---------------------------------------------------------------------------
const wb7 = new Workbook();
await wb7.xlsx.load(
  await buildDownloadWorkbook(["A"], [[1]], undefined, {
    page: "Community List",
    filters: [{ label: "Sort", value: "Net leases (descending)" }],
  }).xlsx.writeBuffer(),
);
const info7 = wb7.getWorksheet("Info");
assert.ok(info7, "Info sheet exists without dataAsOf");
assertions++;
eq(info7.rowCount, 3, "rows: Dashboard + 1 filter + Exported only");
eq(info7.getRow(3).getCell(1).value, "Exported", "last row is Exported when dataAsOf absent");

// Pure-function edges: winter instant renders CST; unparseable input passes
// through verbatim (wrong-looking beats silently dropped).
eq(
  normSpaces(formatChicagoTimestamp("2026-01-15T18:30:00Z")),
  "Jan 15, 2026, 12:30 PM CST",
  "winter instant renders in CST",
);
eq(
  formatChicagoTimestamp("not-a-timestamp"),
  "not-a-timestamp",
  "unparseable dataAsOf passes through verbatim",
);

console.log(`test-xlsx: all ${assertions} assertions passed`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
