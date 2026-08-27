import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import type { XlsxColumnFormat } from "./xlsx"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatNumber(num: number): string {
  return new Intl.NumberFormat('en-US').format(num)
}

export function formatPercentage(num: number): string {
  return new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(num / 100)
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

// ---------- CSV download ----------

/** A single CSV cell. Nulls/undefined/NaN become empty cells. */
export type CsvValue = string | number | null | undefined;

function csvCell(value: CsvValue): string {
  if (value == null || (typeof value === "number" && Number.isNaN(value))) return "";
  let s = String(value);
  // Formula-injection guard: spreadsheets evaluate cells whose first
  // non-whitespace character is =, +, - or @. Neutralize STRING values by
  // prefixing a literal apostrophe (Excel/Sheets then render them as text).
  // Numbers are exempt so negative values stay numeric in the export.
  if (typeof value === "string" && /^\s*[=+\-@]/.test(s)) {
    s = `'${s}`;
  }
  // Quote cells containing commas, quotes, or line breaks (RFC 4180).
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialize headers + rows to CSV text (CRLF line endings for Excel). */
export function toCsv(headers: string[], rows: CsvValue[][]): string {
  return (
    [headers as CsvValue[], ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") +
    "\r\n"
  );
}

/** Shared browser download trigger for the CSV and XLSX paths. */
function triggerBlobDownload(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Trigger a browser download of the given data as a CSV file.
 * A UTF-8 BOM is prepended so Excel detects the encoding correctly.
 */
export function downloadCsv(filename: string, headers: string[], rows: CsvValue[][]): void {
  const name = filename.toLowerCase().endsWith(".csv") ? filename : `${filename}.csv`;
  triggerBlobDownload(
    name,
    new Blob(["\uFEFF" + toCsv(headers, rows)], { type: "text/csv;charset=utf-8;" }),
  );
}

// ---------- Excel (XLSX) download ----------

/** File formats offered by every DownloadDataButton menu. */
export type DownloadFormat = "csv" | "xlsx";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Trigger a browser download of the given data as an Excel workbook: typed
 * number/percent columns (a "%" in a header marks a 0–100-scale percent
 * column), bold frozen header row, auto-sized widths — see src/lib/xlsx.ts.
 * The exceljs-backed builder is loaded lazily so it never weighs down the
 * initial bundle. Same base-name convention as downloadCsv, `.xlsx` extension.
 *
 * Rejects if the workbook can't be built (e.g. the lazy chunk fails to
 * load) — callers surface that; DownloadDataButton shows a toast.
 */
export async function downloadXlsx(
  filename: string,
  headers: string[],
  rows: CsvValue[][],
  formats?: readonly (XlsxColumnFormat | undefined)[],
): Promise<void> {
  const name = filename.toLowerCase().endsWith(".xlsx") ? filename : `${filename}.xlsx`;
  const { buildDownloadWorkbook } = await import("./xlsx");
  const workbook = buildDownloadWorkbook(headers, rows, formats);
  const buffer = await workbook.xlsx.writeBuffer();
  triggerBlobDownload(name, new Blob([buffer], { type: XLSX_MIME }));
}

/**
 * One entry point behind the CSV/Excel download menu: the same filename base
 * and the exact same headers/rows feed both formats, so the two files always
 * carry identical data. Returns the XLSX promise so the caller (typically a
 * DownloadDataButton handler) can report failures.
 */
export function downloadData(
  format: DownloadFormat,
  filename: string,
  headers: string[],
  rows: CsvValue[][],
  xlsxFormats?: readonly (XlsxColumnFormat | undefined)[],
): void | Promise<void> {
  if (format === "xlsx") return downloadXlsx(filename, headers, rows, xlsxFormats);
  downloadCsv(filename, headers, rows);
}
