/**
 * Shared harness for the last-mile UI binding audits (audit:ui — Overview
 * with Targets; audit:ui-leasing — Leasing).
 *
 * The API audits (audit:dashboard, audit:yoy, audit:leasing) prove the API
 * payloads match independent Snowflake baselines. None of them catch a UI
 * mix-up: two columns swapped in a table, a cell bound to the wrong payload
 * field, a percent formatted from the wrong number. Every API audit stays
 * green while users read wrong numbers. The UI audits close that gap, and
 * each page audit provides only what is page-specific — the route, the API
 * pathname it must capture, payload validation, and the DOM binding checks —
 * while this module owns everything they must do identically:
 *
 *   1. Build the rhodes-analytics web app FROM CURRENT SOURCE (same
 *      philosophy as audit:all building the api-server — never audit a
 *      stale bundle), serve the static build on AUDIT_UI_PORT with `/api/*`
 *      proxied to AUDIT_API_BASE.
 *   2. Open the page in headless Chromium (playwright-core driving the
 *      Nix-provided `chromium` binary).
 *   3. Capture the response body of the page's OWN data request — so
 *      rendered values are compared against the exact payload the page
 *      bound, not a second fetch that could disagree.
 *   4. Normalize formatting before comparing (parseRendered/checkCell):
 *      thousands separators and leading `+` are stripped, `%` suffixes are
 *      asserted (percent cells must have one, count cells must not),
 *      fraction-valued API fields can be scaled ×100, the `–` placeholder
 *      must correspond to a null API value, and a rounding tolerance of
 *      half a unit in the last rendered decimal place is allowed. Only real
 *      mis-bindings fail; a cosmetic change in decimal places does not.
 *   5. Anchor cells by COLUMN HEADER (checkHeaderSet/columnIndex): each
 *      table's rendered header multiset must equal the audited binding map
 *      exactly — a renamed, removed, added, or duplicated column fails
 *      until it is registered in the audit.
 *
 * Structural drift fails LOUDLY instead of passing vacuously: a missing
 * data-testid, a renamed/added column header, a row-count mismatch with the
 * payload, the page rendering its error state, or the page never issuing
 * its data request are all audit failures.
 *
 * Env (honored by every page audit):
 *   AUDIT_API_BASE   API base the UI is pointed at
 *                    (default http://localhost:${PORT:-8080}/api)
 *   AUDIT_UI_PORT    port for the private static UI server (default 8098)
 *   AUDIT_UI_BASE    audit an ALREADY-RUNNING UI origin instead of building
 *                    and serving one (e.g. http://localhost:80 for the dev
 *                    preview proxy; the page must reach its API itself)
 *   AUDIT_CHROMIUM   path to a Chromium binary (default: `which chromium`)
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type Page } from "playwright-core";

export const API_BASE =
  process.env.AUDIT_API_BASE ?? `http://localhost:${process.env.PORT ?? "8080"}/api`;
export const UI_PORT = Number(process.env.AUDIT_UI_PORT ?? "8098");
const EXTERNAL_UI_BASE = process.env.AUDIT_UI_BASE?.replace(/\/+$/, "");
const DATA_TIMEOUT_MS = 240_000; // first hit may run cold Snowflake queries

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const uiDir = resolve(pkgDir, "..", "rhodes-analytics");
const uiDist = join(uiDir, "dist", "public");

// ---------- check bookkeeping ----------

let checks = 0;
let failures = 0;

export function ok(label: string, detail: string): void {
  checks++;
  console.log(`OK    ${label}  ${detail}`);
}
export function fail(label: string, detail: string): void {
  checks++;
  failures++;
  console.log(`FAIL  ${label}  ${detail}`);
}
export function auditTotals(): { checks: number; failures: number } {
  return { checks, failures };
}

// ---------- rendered-number normalization ----------

export const EN_DASH = "\u2013"; // the pages' null placeholder "–"

export interface Parsed {
  empty?: boolean;
  invalid?: boolean;
  value?: number;
  decimals?: number;
  isPercent?: boolean;
}

export function parseRendered(raw: string): Parsed {
  const s = raw.trim();
  if (s === EN_DASH) return { empty: true };
  const isPercent = s.endsWith("%");
  let t = isPercent ? s.slice(0, -1).trim() : s;
  t = t.replace(/,/g, "").replace(/^\+/, "");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return { invalid: true };
  const decimals = t.includes(".") ? t.split(".")[1].length : 0;
  return { value: Number(t), decimals, isPercent };
}

/**
 * Compare one rendered cell against the API field it must bind.
 *  - `times100`: API value is a fraction rendered as a percent
 *  - `percent`:  whether the rendered text must (true) / must not (false) carry a % suffix
 * Tolerance is half a unit of the LAST RENDERED decimal place — exactly the
 * information lost to display rounding, nothing more.
 */
export function checkCell(
  label: string,
  raw: string | null | undefined,
  api: number | null | undefined,
  opts: { times100?: boolean; percent: boolean },
): void {
  if (raw == null) {
    fail(label, `rendered cell not found on page (api=${api})`);
    return;
  }
  const p = parseRendered(raw);
  const apiIsNull = api == null || Number.isNaN(api);
  if (apiIsNull) {
    if (p.empty) ok(label, `"${raw.trim()}" ↔ api null`);
    else fail(label, `api value is null but page rendered "${raw.trim()}" instead of "${EN_DASH}"`);
    return;
  }
  if (p.empty) {
    fail(label, `page rendered placeholder "${EN_DASH}" but api value is ${api}`);
    return;
  }
  if (p.invalid) {
    fail(label, `unparseable rendered value "${raw.trim()}" (api=${api})`);
    return;
  }
  if (opts.percent && !p.isPercent) {
    fail(label, `expected a percent but page rendered "${raw.trim()}" without % (api=${api})`);
    return;
  }
  if (!opts.percent && p.isPercent) {
    fail(label, `expected a plain number but page rendered "${raw.trim()}" with % (api=${api})`);
    return;
  }
  const expected = opts.times100 ? api * 100 : api;
  const tol = 0.5 * Math.pow(10, -(p.decimals ?? 0)) + 1e-9;
  const diff = Math.abs((p.value as number) - expected);
  if (diff <= tol) {
    ok(label, `rendered "${raw.trim()}" ↔ api ${expected}${opts.times100 ? ` (${api} ×100)` : ""}`);
  } else {
    fail(
      label,
      `rendered "${raw.trim()}" (=${p.value}) does not match api ${expected}` +
        `${opts.times100 ? ` (${api} ×100)` : ""} — diff ${diff} exceeds display-rounding tolerance ${tol}`,
    );
  }
}

export function checkText(
  label: string,
  rendered: string | null | undefined,
  expected: string,
): void {
  if (rendered == null) {
    fail(label, `rendered text not found on page (expected "${expected}")`);
  } else if (rendered.trim() === expected) {
    ok(label, `"${expected}"`);
  } else {
    fail(label, `rendered "${rendered.trim()}" but api says "${expected}"`);
  }
}

// ---------- header-anchored column lookup ----------

/**
 * The rendered headers must equal the audited binding map EXACTLY as a
 * multiset: an added, renamed, removed, or DUPLICATED column is an unaudited
 * binding, not a cosmetic change. On mismatch the table's cell checks are
 * skipped (returns false) — with an unknown column layout, "the number under
 * this header" is no longer well-defined, so we fail before reading cells.
 */
export function checkHeaderSet(
  tableLabel: string,
  rendered: string[],
  expected: string[],
): boolean {
  const tally = (xs: string[]) => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const have = tally(rendered);
  const want = tally(expected);
  const problems: string[] = [];
  for (const [h, n] of have) {
    const w = want.get(h) ?? 0;
    if (n > w) problems.push(w === 0 ? `unexpected "${h}"` : `"${h}" appears ×${n}, expected ×${w}`);
  }
  for (const [h, n] of want) {
    const r = have.get(h) ?? 0;
    if (r < n) problems.push(r === 0 ? `missing "${h}"` : `"${h}" appears ×${r}, expected ×${n}`);
  }
  if (problems.length > 0) {
    fail(
      `${tableLabel} · columns`,
      `rendered headers [${rendered.join(" | ")}] do not exactly match the audited binding map ` +
        `[${expected.join(" | ")}]: ${problems.join("; ")} — cell checks for this table skipped ` +
        `until the audit's binding map covers every rendered column`,
    );
    return false;
  }
  ok(
    `${tableLabel} · columns`,
    `rendered headers exactly match the audited binding contract (${expected.length} columns)`,
  );
  return true;
}

export function columnIndex(
  tableLabel: string,
  headers: string[],
  header: string,
  missing: Set<string>,
): number {
  const idx = headers.indexOf(header);
  if (idx === -1 && !missing.has(`${tableLabel}|${header}`)) {
    missing.add(`${tableLabel}|${header}`);
    fail(
      `${tableLabel} · header "${header}"`,
      `column not found — page headers are [${headers.join(" | ")}]. ` +
        `A renamed/removed column breaks the audited binding contract.`,
    );
  }
  return idx;
}

// ---------- private UI server (static build + /api proxy) ----------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain",
};

function buildUi(name: string): void {
  console.log(`${name} — building rhodes-analytics UI from current source (${uiDir})...`);
  const build = spawnSync("pnpm", ["run", "build"], {
    cwd: uiDir,
    stdio: "inherit",
    env: {
      ...process.env,
      BASE_PATH: "/",
      PORT: String(UI_PORT),
      NODE_ENV: "production",
    },
  });
  if (build.status !== 0) {
    throw new Error(`${name}: UI build failed — cannot audit a page that does not build.`);
  }
  if (!existsSync(join(uiDist, "index.html"))) {
    throw new Error(`${name}: UI build produced no ${join(uiDist, "index.html")}`);
  }
}

function startUiServer(name: string): Promise<Server> {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://localhost:${UI_PORT}`);

      // Proxy /api/* to the audited API server (page and audit hit the SAME API).
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        const target = `${API_BASE}${url.pathname.slice("/api".length)}${url.search}`;
        try {
          const upstream = await fetch(target, {
            method: req.method,
            headers: { accept: req.headers["accept"] ?? "application/json" },
          });
          const body = Buffer.from(await upstream.arrayBuffer());
          res.writeHead(upstream.status, {
            "content-type": upstream.headers.get("content-type") ?? "application/json",
          });
          res.end(body);
        } catch (err) {
          res.writeHead(502, { "content-type": "text/plain" });
          res.end(`${name} proxy error for ${target}: ${String(err)}`);
        }
        return;
      }

      // Static files from the built UI, SPA-fallback to index.html.
      let filePath = normalize(join(uiDist, decodeURIComponent(url.pathname)));
      if (!filePath.startsWith(uiDist)) {
        res.writeHead(403).end();
        return;
      }
      if (!existsSync(filePath) || extname(filePath) === "") {
        filePath = join(uiDist, "index.html");
      }
      try {
        const data = readFileSync(filePath);
        res.writeHead(200, {
          "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
        });
        res.end(data);
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(String(err));
      }
    })().catch((err) => {
      try {
        res.writeHead(500).end(String(err));
      } catch {
        /* headers already sent */
      }
    });
  });
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(UI_PORT, "127.0.0.1", () => {
      console.log(`${name} — serving built UI on http://localhost:${UI_PORT} (api → ${API_BASE})`);
      resolvePromise(server);
    });
  });
}

// ---------- browser ----------

function chromiumPath(name: string): string {
  if (process.env.AUDIT_CHROMIUM) return process.env.AUDIT_CHROMIUM;
  try {
    return execSync("which chromium", { encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      `${name}: no chromium binary found. Install the \`chromium\` system dependency or set AUDIT_CHROMIUM.`,
    );
  }
}

interface CapturedResponse {
  url: string;
  status: number;
  body: Promise<unknown>;
}

// ---------- the audit harness ----------

export interface UiAuditSpec<TPayload> {
  /** Script name used as the log prefix, e.g. "audit:ui-leasing". */
  auditName: string;
  /** Human-readable page name for messages, e.g. "Leasing". */
  pageLabel: string;
  /** SPA route of the page under audit, e.g. "/workspaces/marketing/leasing". */
  pagePath: string;
  /** EXACT pathname of the page's own data request to capture (query ignored). */
  apiPathname: string;
  /** A data-testid that only renders once the page has bound its payload. */
  readyTestId: string;
  /** Return a problem description when the captured payload is malformed, else null. */
  validatePayload(payload: TPayload): string | null;
  /** One-line description of the captured payload for the log. */
  payloadSummary(payload: TPayload): string;
  /** Page-specific DOM extraction + binding checks (report via ok/fail/checkCell/...). */
  runChecks(page: Page, payload: TPayload): Promise<void>;
}

export async function runUiAudit<TPayload>(spec: UiAuditSpec<TPayload>): Promise<void> {
  const name = spec.auditName;
  console.log(`${name} — auditing rendered ${spec.pageLabel} against ${API_BASE}`);

  let server: Server | null = null;
  let browser: Browser | null = null;
  try {
    let uiBase: string;
    if (EXTERNAL_UI_BASE) {
      uiBase = EXTERNAL_UI_BASE;
      console.log(`${name} — using already-running UI at ${uiBase} (AUDIT_UI_BASE)`);
    } else {
      buildUi(name);
      server = await startUiServer(name);
      uiBase = `http://localhost:${UI_PORT}`;
    }

    const executablePath = chromiumPath(name);
    console.log(`${name} — launching headless chromium (${executablePath})`);
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const page = await browser.newPage({ viewport: { width: 1720, height: 1200 } });

    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

    const captured: CapturedResponse[] = [];
    page.on("response", (res) => {
      try {
        const u = new URL(res.url());
        if (u.pathname === spec.apiPathname) {
          captured.push({
            url: res.url(),
            status: res.status(),
            body: res.json().catch((e) => ({ __parseError: String(e) })),
          });
        }
      } catch {
        /* ignore non-URL responses */
      }
    });

    const pageUrl = `${uiBase}${spec.pagePath}`;
    console.log(`${name} — loading ${pageUrl}`);
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // Wait until the dashboard either rendered data or its error state.
    const ready = page.locator(`[data-testid="${spec.readyTestId}"]`);
    const errorAlert = page.getByText("Failed to load dashboard data");
    await ready.or(errorAlert).first().waitFor({ state: "visible", timeout: DATA_TIMEOUT_MS });
    const throwIfErrorState = async (): Promise<void> => {
      if (await errorAlert.isVisible().catch(() => false)) {
        const details = await errorAlert
          .locator("xpath=ancestor::*[@role='alert']")
          .first()
          .innerText()
          .catch(() => "Failed to load dashboard data");
        throw new Error(
          `page rendered its ERROR state instead of data:\n${details}\n` +
            (consoleErrors.length ? `console errors:\n${consoleErrors.join("\n")}` : ""),
        );
      }
    };
    await throwIfErrorState();
    // Let the remaining sections (rendered from the same payload) settle.
    await page.waitForTimeout(1000);
    await throwIfErrorState();

    if (captured.length === 0) {
      throw new Error(
        `page never issued GET ${spec.apiPathname} — cannot audit bindings` +
          (consoleErrors.length ? `\nconsole errors:\n${consoleErrors.join("\n")}` : ""),
      );
    }
    const last = captured[captured.length - 1];
    console.log(
      `${name} — captured the page's own request: ${last.url} → HTTP ${last.status}` +
        (captured.length > 1 ? ` (${captured.length} requests, comparing against the latest)` : ""),
    );
    if (last.status !== 200) {
      throw new Error(`the page's ${spec.apiPathname} request returned HTTP ${last.status}`);
    }
    const payload = (await last.body) as TPayload & { __parseError?: string };
    if (payload.__parseError) {
      throw new Error(`could not parse the page's ${spec.apiPathname} response: ${payload.__parseError}`);
    }
    const problem = spec.validatePayload(payload);
    if (problem) {
      throw new Error(
        `captured payload is ${problem}: ${JSON.stringify(payload).slice(0, 400)}`,
      );
    }
    console.log(`${name} — ${spec.payloadSummary(payload)}\n`);

    await spec.runChecks(page, payload);

    if (consoleErrors.length > 0) {
      console.log(`\n${name} — note: ${consoleErrors.length} browser console error(s):`);
      for (const e of consoleErrors.slice(0, 10)) console.log(`  ${e}`);
    }

    console.log("");
    if (failures > 0) {
      console.error(
        `AUDIT FAILED: ${failures} of ${checks} rendered value(s) do not match the API fields they must bind. ` +
          `The dashboard is showing users numbers the audited API did not produce.`,
      );
      process.exitCode = 1;
    } else {
      console.log(
        `Audit passed: all ${checks} rendered values on ${spec.pageLabel} match the page's own API payload.`,
      );
    }
  } finally {
    await browser?.close().catch(() => {});
    server?.close();
  }
}
