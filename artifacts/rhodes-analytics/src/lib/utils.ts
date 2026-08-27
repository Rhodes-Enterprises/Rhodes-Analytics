import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

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

/**
 * Trigger a browser download of the given data as a CSV file.
 * A UTF-8 BOM is prepended so Excel detects the encoding correctly.
 */
export function downloadCsv(filename: string, headers: string[], rows: CsvValue[][]): void {
  const name = filename.toLowerCase().endsWith(".csv") ? filename : `${filename}.csv`;
  const blob = new Blob(["\uFEFF" + toCsv(headers, rows)], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
