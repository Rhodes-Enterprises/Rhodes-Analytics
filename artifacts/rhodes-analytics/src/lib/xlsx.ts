/**
 * Excel (XLSX) workbook builder behind the download buttons' "Excel" option.
 *
 * Lives in its own module so `exceljs` (a large dependency) stays out of the
 * main bundle: `downloadXlsx` in utils.ts pulls this in with a dynamic
 * `import("./xlsx")` the first time a user picks the Excel format, and Vite
 * splits it into a lazily loaded chunk.
 *
 * Column typing (see resolveColumnFormats):
 * - A header containing "%" marks a percent column — the same convention the
 *   CSV headers already use ("PTG %", "Attainment %", "Leads % of Total").
 *   Values arrive on the 0–100 scale used across the app and are written as
 *   true Excel percents: 12.3 becomes cell value 0.123 with a `0.0%` format,
 *   so Excel shows "12.3%" and treats it as a number.
 * - A column holding at least one finite number is typed numeric with a
 *   thousands separator; displayed decimals match the widest value seen
 *   (capped at 2). The full-precision value is preserved in the cell.
 * - Everything else stays text. Strings are written verbatim: XLSX stores
 *   them as literal strings that Excel never evaluates, so the CSV
 *   formula-injection guard (apostrophe prefix) is unnecessary here.
 *
 * Call sites that need to correct the inference can pass explicit per-column
 * overrides through `downloadData`/`downloadXlsx`.
 *
 * The "%"-in-header convention is enforced statically: `pnpm run
 * test:xlsx-headers` (scripts/check-xlsx-percent-headers.ts, part of `pnpm
 * run test`) scans every download call site and fails when a header that
 * reads like a ratio/percent column (e.g. "Conversion Rate") carries neither
 * a "%" nor an explicit override — so a 0–100-scale column can't silently
 * export as a plain number.
 *
 * Provenance (optional `info` param): when a call site passes a
 * `DownloadInfo`, a second "Info" sheet lists the dashboard, each active
 * filter and its value, the export timestamp, and the backend's data-as-of
 * stamp — both timestamps in America/Chicago. The "Data" sheet is unchanged,
 * stays first, and remains the sheet the workbook opens on. CSV downloads
 * deliberately omit this metadata (see downloadCsv in utils.ts).
 */
import { Workbook, type CellValue } from "exceljs";
import type { CsvValue, DownloadInfo } from "./utils";

/** How a column is typed/formatted in the generated workbook. */
export type XlsxColumnFormat = "text" | "number" | "percent";

// Note: exceljs treats width 9 as "default" and then omits the column
// definition entirely when it carries no other style, losing the width on
// write — so the minimum must not be 9.
const MIN_COL_WIDTH = 10;
const MAX_COL_WIDTH = 44;
/** Displayed decimals cap for numeric columns (full value stays in the cell). */
const MAX_NUMBER_DECIMALS = 2;

function isFiniteNumber(v: CsvValue): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Resolve each column's format: explicit override first, else inference. */
export function resolveColumnFormats(
  headers: string[],
  rows: CsvValue[][],
  overrides?: readonly (XlsxColumnFormat | undefined)[],
): XlsxColumnFormat[] {
  return headers.map((header, i) => {
    const override = overrides?.[i];
    if (override) return override;
    if (header.includes("%")) return "percent";
    const hasNumber = rows.some((row) => isFiniteNumber(row[i]));
    return hasNumber ? "number" : "text";
  });
}

/** Decimal places (0–MAX_NUMBER_DECIMALS) needed to display a numeric column. */
function columnDecimals(rows: CsvValue[][], index: number): number {
  let decimals = 0;
  for (const row of rows) {
    const v = row[index];
    if (!isFiniteNumber(v) || Number.isInteger(v)) continue;
    const text = String(v);
    const dot = text.indexOf(".");
    if (dot === -1) continue; // exponent notation — treat as integer-ish
    decimals = Math.max(decimals, Math.min(text.length - dot - 1, MAX_NUMBER_DECIMALS));
    if (decimals >= MAX_NUMBER_DECIMALS) break;
  }
  return decimals;
}

function numFmtFor(format: XlsxColumnFormat, decimals: number): string | undefined {
  if (format === "percent") return "0.0%"; // matches the app's fmtPct display
  if (format === "number") return decimals > 0 ? `#,##0.${"0".repeat(decimals)}` : "#,##0";
  return undefined;
}

/** Empty cells: null/undefined/NaN and "" all render as blanks (CSV parity). */
function isEmpty(v: CsvValue): boolean {
  return v == null || v === "" || (typeof v === "number" && Number.isNaN(v));
}

function toCellValue(v: CsvValue, format: XlsxColumnFormat): CellValue {
  if (isEmpty(v)) return null;
  // 0–100 scale → Excel percent fraction; format `0.0%` shows it as n.n%.
  if (format === "percent" && isFiniteNumber(v)) return v / 100;
  return v as CellValue;
}

/** Approximate rendered character width of one cell, for auto-sizing. */
function displayWidth(v: CsvValue, format: XlsxColumnFormat, decimals: number): number {
  if (isEmpty(v)) return 0;
  if (isFiniteNumber(v)) {
    if (format === "percent") return v.toFixed(1).length + 1; // "12.3" + "%"
    return v.toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).length;
  }
  // Longest line of a (possibly multi-line) string.
  return String(v)
    .split(/\r?\n/)
    .reduce((max, line) => Math.max(max, line.length), 0);
}

/** Chicago-rendered timestamps, e.g. "Aug 27, 2026, 2:41 PM CDT". */
const CHICAGO_TIMESTAMP = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

/**
 * Render an ISO timestamp in company time (America/Chicago). An unparseable
 * input comes back verbatim — wrong-looking is better than silently dropped.
 * Exported for the round-trip tests in scripts/test-xlsx.ts.
 */
export function formatChicagoTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : CHICAGO_TIMESTAMP.format(date);
}

/**
 * Append the provenance sheet: one bold label + value per row. Values are
 * plain text cells — XLSX strings are literal (never evaluated by Excel),
 * so filter values need no formula-injection escaping.
 */
function addInfoSheet(workbook: Workbook, info: DownloadInfo): void {
  const entries: [string, string][] = [["Dashboard", info.page]];
  for (const filter of info.filters ?? []) entries.push([filter.label, filter.value]);
  entries.push(["Exported", CHICAGO_TIMESTAMP.format(new Date())]);
  if (info.dataAsOf) entries.push(["Data as of", formatChicagoTimestamp(info.dataAsOf)]);

  const sheet = workbook.addWorksheet("Info");
  for (const [label, value] of entries) {
    const row = sheet.addRow([label, value]);
    row.getCell(1).font = { bold: true };
  }
  for (const col of [1, 2] as const) {
    const widest = entries.reduce((max, entry) => Math.max(max, entry[col - 1].length), 0);
    sheet.getColumn(col).width = Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, widest + 2));
  }
}

/**
 * Build a workbook from the same headers/rows a CSV download uses: bold
 * frozen header row, typed number/percent columns, auto-sized column widths.
 * With `info`, a second "Info" sheet records provenance; the "Data" sheet
 * always stays first and active so the file opens on the data. Exported for
 * the round-trip tests in scripts/test-xlsx.ts.
 */
export function buildDownloadWorkbook(
  headers: string[],
  rows: CsvValue[][],
  overrides?: readonly (XlsxColumnFormat | undefined)[],
  info?: DownloadInfo,
): Workbook {
  const formats = resolveColumnFormats(headers, rows, overrides);
  const decimals = headers.map((_, i) =>
    formats[i] === "number" ? columnDecimals(rows, i) : 0,
  );

  const workbook = new Workbook();
  const sheet = workbook.addWorksheet("Data", {
    views: [{ state: "frozen", ySplit: 1 }], // header row stays visible
  });

  const headerRow = sheet.addRow(headers);
  headerRow.font = { bold: true };

  for (const row of rows) {
    const added = sheet.addRow(headers.map((_, i) => toCellValue(row[i], formats[i])));
    // Cell-level formats on numeric cells: reliable in every reader,
    // regardless of how column-level styles are interpreted.
    formats.forEach((format, i) => {
      const numFmt = numFmtFor(format, decimals[i]);
      if (numFmt && typeof added.getCell(i + 1).value === "number") {
        added.getCell(i + 1).numFmt = numFmt;
      }
    });
  }

  formats.forEach((format, i) => {
    const column = sheet.getColumn(i + 1);
    const numFmt = numFmtFor(format, decimals[i]);
    if (numFmt) column.numFmt = numFmt; // column default (e.g. blank PTG cells)
    const widest = rows.reduce(
      (max, row) => Math.max(max, displayWidth(row[i], format, decimals[i])),
      headers[i].length,
    );
    column.width = Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, widest + 2));
  });

  if (info) {
    addInfoSheet(workbook, info);
    // Even with a second sheet, the workbook must open on Data (sheet 0).
    workbook.views = [
      {
        x: 0,
        y: 0,
        width: 20000,
        height: 20000,
        firstSheet: 0,
        activeTab: 0,
        visibility: "visible",
      },
    ];
  }

  return workbook;
}
