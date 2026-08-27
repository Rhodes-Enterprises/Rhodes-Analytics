/**
 * Static percent-header convention check for the Excel download call sites
 * (`pnpm run test:xlsx-headers`; also runs as part of `pnpm run test`).
 *
 * Why this exists: buildDownloadWorkbook (src/lib/xlsx.ts) types a column as
 * a true Excel percent only when its header contains "%". Every dashboard
 * header follows that convention today ("PTG %", "Attainment %"), but a
 * future column named e.g. "Conversion Rate" holding 0–100-scale values
 * would silently export as a plain number — off by 100x the moment someone
 * formats the cell as a percent in Excel, with no error anywhere. The
 * per-column override parameter exists for exactly that case, but nothing
 * enforced that call sites actually use it. This script makes the mistake
 * loud at test time.
 *
 * What it does: parses every file under src/ (minus the download helpers
 * themselves and test files) with the TypeScript compiler API, finds every
 * `downloadData(...)` / `downloadXlsx(...)` call, and flags any header whose
 * wording suggests ratio/percent semantics — whole words `rate(s)`,
 * `ratio(s)`, `pct`, `percent(age|ages)`, `ptg`, `attainment`, case-
 * insensitive — when that header has no "%" in its literal text AND the call
 * site passes no explicit format override for that column. Word boundaries
 * keep "Ratified", "Operated", "Corporate", "Percentile" out of it.
 *
 * How to fix a finding:
 *   - If the column IS a 0–100-scale percent: put "%" in the header text
 *     (e.g. "Conversion Rate %") — that is what turns on true Excel percent
 *     cells (value/100 + "0.0%" format).
 *   - If it is NOT a percent (false positive): pass the explicit per-column
 *     override — the escape hatch this check honors:
 *         downloadData(format, name, headers, rows, [..., "number", ...])
 *     ("number" for plain 0–100-scale numeric values that must NOT be
 *     rescaled, "text" for label columns; the override array is positional —
 *     aligned with headers — and `undefined` entries keep inference.)
 *
 * Deliberate scope choices:
 *   - `downloadCsv`-only calls are NOT checked: CSV has no typed columns, so
 *     the convention cannot misfire there.
 *   - Headers whose text is entirely dynamic (a variable or computed string)
 *     cannot be read statically and are skipped; template literals ARE
 *     checked via their static parts (`${label} PTG %` counts as "%"-marked).
 *   - A suspicious header inside a spread (or any position the checker
 *     cannot map to a column index) cannot be matched to an override, so it
 *     is flagged regardless — put "%" in its literal text or restructure.
 *
 * So the check itself cannot rot silently:
 *   - Fixture self-tests run first: a synthetic violation MUST be flagged
 *     and synthetic compliant call sites MUST pass, or the checker fails.
 *   - Vacuity floors: the real scan must find a minimum number of files,
 *     call sites and "%"-marked headers (all set well below today's counts),
 *     so renaming the download helpers or moving the pages directory fails
 *     loudly instead of passing on an empty scan.
 *
 * Exits 0 when every call site complies, non-zero otherwise.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

// Bundled to dist-test/ (CJS) — the package root is one level up from there.
const PKG_DIR = join(__dirname, "..");
const SRC_DIR = join(PKG_DIR, "src");

/** Header words that suggest the column holds ratio/percent-scale values. */
const SUSPICIOUS = /\b(rates?|ratios?|pct|percent(?:ages?)?|ptg|attainment)\b/i;

/** Stand-in for `${...}` slots when reading a template literal's static text. */
const PLACEHOLDER = "\u2039\u2026\u203A"; // ‹…›

/**
 * The download helpers and where their headers/format-override args sit.
 * A Map, NOT a plain object: `{}[name]` would also "find" Object.prototype
 * members, silently counting every `x.toString()` as a download call site.
 */
const DOWNLOAD_FNS = new Map<string, { headersArg: number; formatsArg: number }>([
  ["downloadData", { headersArg: 2, formatsArg: 4 }],
  ["downloadXlsx", { headersArg: 1, formatsArg: 3 }],
]);

/** The helper modules themselves — definitions, not call sites. */
const EXCLUDED_FILES = new Set(["lib/utils.ts", "lib/xlsx.ts"]);

// Floors are deliberately far below today's reality (21 call sites in 7 page
// files, ~90 headers, ~25 "%"-marked) — they only exist so a helper rename or
// a directory move fails THIS check loudly instead of leaving it scanning
// nothing. If a legitimate refactor lowers the real counts, lower these
// floors in the same change, deliberately.
const FLOORS = {
  filesScanned: 10,
  filesWithCallSites: 3,
  callSites: 8,
  headersSeen: 20,
  percentMarked: 5,
};

interface HeaderLit {
  text: string;
  /** Column index when statically known; null inside spreads/dynamic exprs. */
  index: number | null;
  line: number;
}

interface Violation {
  file: string;
  line: number;
  header: string;
  note?: string;
}

interface Stats {
  filesScanned: number;
  filesWithCallSites: Set<string>;
  callSites: number;
  dynamicHeaderCalls: number;
  headersSeen: number;
  percentMarked: number;
  overridden: number;
}

function freshStats(): Stats {
  return {
    filesScanned: 0,
    filesWithCallSites: new Set(),
    callSites: 0,
    dynamicHeaderCalls: 0,
    headersSeen: 0,
    percentMarked: 0,
    overridden: 0,
  };
}

/** Peel `as const`, parens, `satisfies`, `!` — they never change the value. */
function stripWrappers(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (
    ts.isAsExpression(e) ||
    ts.isParenthesizedExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = stripWrappers(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/** Static text of a string/template literal (template slots become ‹…›). */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return (
      node.head.text + node.templateSpans.map((s) => PLACEHOLDER + s.literal.text).join("")
    );
  }
  return null;
}

function lineOf(node: ts.Node, sf: ts.SourceFile): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** Collect every string/template literal anywhere under `node`. */
function collectLiteralsDeep(
  node: ts.Node,
  sf: ts.SourceFile,
  index: number | null,
  out: HeaderLit[],
): void {
  const text = literalText(node);
  if (text != null) {
    out.push({ text, index, line: lineOf(node, sf) });
    return;
  }
  ts.forEachChild(node, (child) => collectLiteralsDeep(child, sf, index, out));
}

/** First same-file `const NAME = [...]` initializer, for headers-as-variable. */
function findConstArrayInit(sf: ts.SourceFile, name: string): ts.ArrayLiteralExpression | null {
  let found: ts.ArrayLiteralExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      const init = stripWrappers(node.initializer);
      if (ts.isArrayLiteralExpression(init)) {
        found = init;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function resolveArrayLiteral(
  expr0: ts.Expression,
  sf: ts.SourceFile,
): ts.ArrayLiteralExpression | null {
  const expr = stripWrappers(expr0);
  if (ts.isArrayLiteralExpression(expr)) return expr;
  if (ts.isIdentifier(expr)) return findConstArrayInit(sf, expr.text);
  return null;
}

type Overrides =
  | { kind: "none" }
  | { kind: "dynamic" } // present but not statically readable
  | { kind: "array"; explicit: Set<number> };

function resolveOverrides(expr0: ts.Expression | undefined, sf: ts.SourceFile): Overrides {
  if (!expr0) return { kind: "none" };
  const expr = stripWrappers(expr0);
  if (ts.isIdentifier(expr) && expr.text === "undefined") return { kind: "none" };
  const arr = resolveArrayLiteral(expr, sf);
  if (!arr) return { kind: "dynamic" };
  const explicit = new Set<number>();
  arr.elements.forEach((el0, i) => {
    const el = stripWrappers(el0);
    // Any string literal ("text" | "number" | "percent" — tsc enforces the
    // union) counts as an explicit, deliberate choice for that column.
    if (ts.isStringLiteral(el) || ts.isNoSubstitutionTemplateLiteral(el)) explicit.add(i);
  });
  return { kind: "array", explicit };
}

function handleCallSite(
  call: ts.CallExpression,
  spec: { headersArg: number; formatsArg: number },
  sf: ts.SourceFile,
  fileLabel: string,
  violations: Violation[],
  stats: Stats,
): void {
  stats.callSites++;
  stats.filesWithCallSites.add(fileLabel);

  const headersExpr = call.arguments[spec.headersArg];
  if (!headersExpr) return; // arity mismatch is tsc's department

  const overrides = resolveOverrides(call.arguments[spec.formatsArg], sf);
  const headers: HeaderLit[] = [];
  const headersArray = resolveArrayLiteral(headersExpr, sf);

  if (headersArray) {
    // Element position = column index until the first spread; after that the
    // real column offsets are unknowable statically.
    let indexKnown = true;
    headersArray.elements.forEach((el0, i) => {
      const el = stripWrappers(el0);
      if (ts.isSpreadElement(el)) {
        collectLiteralsDeep(el.expression, sf, null, headers);
        indexKnown = false;
        return;
      }
      const text = literalText(el);
      const index = indexKnown ? i : null;
      if (text != null) headers.push({ text, index, line: lineOf(el, sf) });
      // Dynamic element (identifier, call, conditional...): any literals
      // inside it still belong to this column, so keep the index.
      else collectLiteralsDeep(el, sf, index, headers);
    });
  } else {
    // e.g. `cond ? [...] : [...]` or a non-const variable: check every
    // literal we can see, without column alignment.
    stats.dynamicHeaderCalls++;
    collectLiteralsDeep(headersExpr, sf, null, headers);
  }

  for (const h of headers) {
    stats.headersSeen++;
    if (h.text.includes("%")) {
      stats.percentMarked++;
      continue;
    }
    if (!SUSPICIOUS.test(h.text)) continue;
    if (h.index != null && overrides.kind === "array" && overrides.explicit.has(h.index)) {
      stats.overridden++;
      continue;
    }
    violations.push({
      file: fileLabel,
      line: h.line,
      header: h.text,
      note:
        overrides.kind === "dynamic"
          ? "this call passes a format override the checker cannot read statically — inline the override array literal"
          : h.index == null
            ? 'header sits inside a spread/dynamic expression, so an override cannot be aligned to it — put "%" in its literal text or restructure'
            : undefined,
    });
  }
}

function analyzeSourceFile(
  sf: ts.SourceFile,
  fileLabel: string,
  violations: Violation[],
  stats: Stats,
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const spec = name ? DOWNLOAD_FNS.get(name) : undefined;
      if (spec) handleCallSite(node, spec, sf, fileLabel, violations, stats);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// ---------------------------------------------------------------------------
// Self-tests: prove the checker can actually fail (and knows when not to).
// ---------------------------------------------------------------------------
const FIXTURES: {
  name: string;
  source: string;
  expect: string[];
  /** When set, the fixture also pins how many call sites the scan counts. */
  expectCallSites?: number;
}[] = [
  {
    name: "unmarked rate/ratio-ish headers are flagged (incl. bare PTG/Attainment)",
    source:
      'downloadData(format, "f", ["Community", "Conversion Rate", "PTG", "Attainment"], rows);',
    expect: ["Attainment", "Conversion Rate", "PTG"],
  },
  {
    name: '"%" in the header passes',
    source: 'downloadData(format, "f", ["Conversion Rate %", "PTG %", "Attainment %"], rows);',
    expect: [],
  },
  {
    name: "explicit per-column override is the escape hatch",
    source:
      'downloadData(format, "f", ["Label", "Run Rate"], rows, [undefined, "number"]);',
    expect: [],
  },
  {
    name: "an override for a DIFFERENT column does not cover the suspicious one",
    source: 'downloadData(format, "f", ["Ratio", "Total"], rows, [undefined, "number"]);',
    expect: ["Ratio"],
  },
  {
    name: "downloadXlsx argument positions (headers 2nd, overrides 4th)",
    source: 'downloadXlsx("f", ["Run Rate"], rows, ["number"]);',
    expect: [],
  },
  {
    name: "a non-literal override array cannot vouch for a suspicious header",
    source: 'downloadData(format, "f", ["Run Rate"], rows, fmts);',
    expect: ["Run Rate"],
  },
  {
    name: "template headers inside a spread are still checked",
    source:
      'downloadXlsx("f", ["Month", ...ms.flatMap((m) => [`${m} Close Rate`])], rows);',
    expect: [`${PLACEHOLDER} Close Rate`],
  },
  {
    name: 'template "%" headers inside a spread pass',
    source:
      'downloadData(format, "f", ["Division", ...ms.flatMap((m) => [`${m} PTG %`])], rows);',
    expect: [],
  },
  {
    name: "headers behind a same-file const are resolved (incl. `as const`)",
    source: 'const HEADERS = ["Cancel Ratio"] as const;\ndownloadXlsx("f", HEADERS, rows);',
    expect: ["Cancel Ratio"],
  },
  {
    name: "word boundaries: Ratified/Operated/Corporate/Percentile are fine",
    source:
      'downloadData(format, "f", ["Ratified", "Operated", "Corporate", "Percentile"], rows);',
    expect: [],
  },
  {
    name: "downloadCsv is out of scope (CSV has no typed columns)",
    source: 'downloadCsv("f", ["Conversion Rate"], rows);',
    expect: [],
    expectCallSites: 0,
  },
  {
    name: "Object.prototype method names are not download call sites",
    source: 'x.toString(1, 2, ["Fake Rate"]); y.hasOwnProperty("z"); v.valueOf();',
    expect: [],
    expectCallSites: 0,
  },
  {
    name: "sanity: a plain call site is counted exactly once",
    source: 'downloadData(format, "f", ["Month"], rows);',
    expect: [],
    expectCallSites: 1,
  },
];

function runSelfTests(): void {
  const failures: string[] = [];
  for (const f of FIXTURES) {
    const sf = ts.createSourceFile(
      "fixture.tsx",
      f.source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const found: Violation[] = [];
    const stats = freshStats();
    analyzeSourceFile(sf, "fixture.tsx", found, stats);
    const got = found.map((v) => v.header).sort();
    const want = [...f.expect].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failures.push(
        `  ${f.name}\n    expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
      );
    }
    if (f.expectCallSites !== undefined && stats.callSites !== f.expectCallSites) {
      failures.push(
        `  ${f.name}\n    expected ${f.expectCallSites} counted call site(s), got ${stats.callSites}`,
      );
    }
  }
  if (failures.length > 0) {
    console.error(
      "check-xlsx-percent-headers: SELF-TEST FAILED — the checker itself is broken, fix it before trusting any scan result:\n" +
        failures.join("\n"),
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Real scan.
// ---------------------------------------------------------------------------
function collectSourceFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, out);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.(test|spec)\.(ts|tsx)$/.test(entry.name) || /\.d\.ts$/.test(entry.name)) continue;
    if (EXCLUDED_FILES.has(relative(SRC_DIR, full))) continue;
    out.push(full);
  }
}

function main(): void {
  runSelfTests();

  const files: string[] = [];
  collectSourceFiles(SRC_DIR, files);
  files.sort();

  const stats = freshStats();
  const violations: Violation[] = [];
  for (const file of files) {
    const sf = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    stats.filesScanned++;
    analyzeSourceFile(sf, relative(PKG_DIR, file), violations, stats);
  }

  // Vacuity floors: an empty or shrunken scan is a failure of THIS check,
  // never a pass.
  const floorBreaches: string[] = [];
  const actuals: Record<keyof typeof FLOORS, number> = {
    filesScanned: stats.filesScanned,
    filesWithCallSites: stats.filesWithCallSites.size,
    callSites: stats.callSites,
    headersSeen: stats.headersSeen,
    percentMarked: stats.percentMarked,
  };
  for (const key of Object.keys(FLOORS) as (keyof typeof FLOORS)[]) {
    if (actuals[key] < FLOORS[key]) {
      floorBreaches.push(`  ${key}: found ${actuals[key]}, floor is ${FLOORS[key]}`);
    }
  }
  if (floorBreaches.length > 0) {
    console.error(
      "check-xlsx-percent-headers: FAILED — the scan found less than it must (did the download helpers get renamed, or src/ restructured?). " +
        "If the shrink is a deliberate refactor, lower FLOORS in scripts/check-xlsx-percent-headers.ts in the same change:\n" +
        floorBreaches.join("\n"),
    );
    process.exit(1);
  }

  if (violations.length > 0) {
    console.error(
      `check-xlsx-percent-headers: FAILED — ${violations.length} header(s) look like ratio/percent columns but would export as plain numbers:\n`,
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  header "${v.header}"${v.note ? `  (${v.note})` : ""}`);
    }
    console.error(
      `\nWhy this matters: a header only becomes a true Excel percent column when it contains "%". ` +
        `A 0–100-scale column without it exports as a plain number — off by 100x once formatted as a percent in Excel, silently.\n` +
        `Fix each finding at its call site:\n` +
        `  - If the values ARE 0–100-scale percents: add "%" to the header text (e.g. "Conversion Rate %").\n` +
        `  - If not (false positive): pass the explicit per-column override, e.g.\n` +
        `        downloadData(format, name, headers, rows, [..., "number", ...])\n` +
        `    ("number" = plain numeric column, "text" = label column; the array is positional — ` +
        `use undefined for columns that should keep normal inference).`,
    );
    process.exit(1);
  }

  console.log(
    `check-xlsx-percent-headers: OK — ${stats.callSites} download call site(s) across ` +
      `${stats.filesWithCallSites.size} file(s) (${stats.filesScanned} scanned); ` +
      `${stats.headersSeen} header literal(s) checked: ${stats.percentMarked} "%"-marked, ` +
      `${stats.overridden} explicitly overridden, ${stats.dynamicHeaderCalls} call(s) with dynamic headers. ` +
      `All ${FIXTURES.length} self-test fixtures passed.`,
  );
}

main();
