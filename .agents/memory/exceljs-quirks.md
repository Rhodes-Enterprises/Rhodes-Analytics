---
name: exceljs XLSX export quirks
description: Non-obvious exceljs behaviors that bit (or nearly bit) the dashboard's Excel download feature — column-width 9 dropped on write, percent cell scale, node test bundling.
---

# exceljs quirks (XLSX downloads)

## Width 9 is "default" and gets silently dropped
Rule: never emit a column width of exactly 9 (exceljs's default width). A column whose width is 9 and which carries no other style is treated as `isDefault` and its `<col>` element is not written at all — the width silently vanishes when the file is reopened. Our min-width clamp is 10 for this reason.
**Why:** round-trip test failed with `width === undefined` only for the one text column clamped to 9; numeric columns at width 9 survived because their numFmt style forced the `<col>` to be written.
**How to apply:** when auto-sizing columns in any exceljs writer, keep clamps away from 9 (or always attach a style); assert widths in a write→load round trip, not on the in-memory workbook.

## Percent cells want fractions
Excel percent formats multiply by 100 at display time: a dashboard-scale value of 12.5 ("12.5%") must be stored as 0.125 with numFmt `0.0%`. Writing 12.5 shows "1250%".
**How to apply:** divide 0–100-scale app values by 100 when the column is typed percent; keep the raw value for CSV.

## Testing exceljs in node scripts
Bundling exceljs with esbuild `--format=esm` breaks at runtime ("Dynamic require of 'fs' is not supported" — CJS deps requiring node builtins inside ESM output). Use `--format=cjs` (which forbids top-level await — wrap the test in `async main()`). Round-trip via `wb.xlsx.writeBuffer()` → `new Workbook().xlsx.load(buffer)` works fine in-process.
