/**
 * Focused serializer tests for the shared CSV export utility
 * (`pnpm run test:csv`).
 *
 * Guards the two safety properties of toCsv/csvCell:
 *   1. RFC-4180 quoting — commas, quotes, and line breaks survive a round
 *      trip into Excel/Sheets.
 *   2. Formula-injection defense — a STRING cell whose first non-whitespace
 *      character is =, +, - or @ is prefixed with a literal apostrophe so
 *      spreadsheets render it as text instead of evaluating it. Numbers are
 *      exempt so negative values stay numeric.
 *
 * Bundled with esbuild and run with node (same pattern as the api-server
 * audit scripts): exits 0 when every assertion passes, non-zero otherwise.
 */
import assert from "node:assert/strict";
import { toCsv, type CsvValue } from "../src/lib/utils";

let assertions = 0;
function is(actual: string, expected: string, label: string): void {
  assert.equal(actual, expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  assertions++;
}

/** Serialize one value through the real pipeline and return its cell text. */
function cell(v: CsvValue): string {
  const lines = toCsv(["h"], [[v]]).split("\r\n");
  return lines[1];
}

// ---------- formula-injection defense (dangerous leading characters) ----------
is(cell("=SUM(A1:A2)"), "'=SUM(A1:A2)", "leading =");
is(cell("=1+2"), "'=1+2", "leading = with arithmetic");
is(cell("+12345"), "'+12345", "leading + as string");
is(cell("-cmd"), "'-cmd", "leading - as string");
is(cell("@import"), "'@import", "leading @");
is(cell("  =1"), "'  =1", "= after leading spaces");
is(cell("\t@x"), "'\t@x", "@ after leading tab");

// Combined with RFC-4180 quoting: sanitize first, then quote.
is(cell("=1,2"), `"'=1,2"`, "dangerous + comma is sanitized then quoted");
is(cell('=HYPERLINK("http://evil")'), `"'=HYPERLINK(""http://evil"")"`, "dangerous + quotes");

// ---------- numbers stay numeric (no apostrophe) ----------
is(cell(-42), "-42", "negative number");
is(cell(-19.1), "-19.1", "negative decimal");
is(cell(3.14), "3.14", "positive decimal");
is(cell(0), "0", "zero");

// ---------- null-ish values become empty cells ----------
is(cell(null), "", "null");
is(cell(undefined), "", "undefined");
is(cell(Number.NaN), "", "NaN");
is(cell(""), "", "empty string");

// ---------- RFC-4180 quoting ----------
is(cell("a,b"), `"a,b"`, "comma");
is(cell('say "hi"'), `"say ""hi"""`, "embedded quotes");
is(cell("line1\nline2"), `"line1\nline2"`, "embedded newline");
// An embedded CRLF would confuse the line-splitting cell() helper, so assert
// the whole document: the cell must be quoted with the CRLF preserved inside.
is(
  toCsv(["h"], [["line1\r\nline2"]]),
  `h\r\n"line1\r\nline2"\r\n`,
  "embedded CRLF quoted inside document",
);

// ---------- benign strings pass through untouched ----------
is(cell("Community A"), "Community A", "plain text");
is(cell("–"), "–", "en-dash placeholder");
is(cell("100%"), "100%", "percent suffix");
is(cell("O'Brien Homes"), "O'Brien Homes", "interior apostrophe");

// ---------- whole-document shape ----------
is(
  toCsv(["Month", "Actual", "Goal"], [
    ["Jan", 5, 10],
    ["Feb", null, -3],
  ]),
  "Month,Actual,Goal\r\nJan,5,10\r\nFeb,,-3\r\n",
  "document: CRLF rows + trailing newline, numeric minus preserved",
);

console.log(`csv serializer tests: ${assertions} assertions passed`);
