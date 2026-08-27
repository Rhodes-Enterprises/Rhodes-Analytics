/**
 * UI binding audit for the LEASING page (`pnpm run audit:ui-leasing`) —
 * sibling of audit:ui, same last-mile purpose.
 *
 * audit:leasing proves GET /api/dashboards/leasing matches independent
 * Snowflake baselines — but a funnel-table cell, a KPI card, or a
 * community-summary column bound to the wrong payload field would still
 * mislead users while that audit stays green. This audit loads the Leasing
 * page in headless Chromium, captures the page's OWN leasing response, and
 * verifies every rendered KPI and table cell against the exact payload
 * field its column header / row label promises — formatting-normalized.
 *
 * The build/serve/browser/capture/normalization machinery is shared with
 * audit:ui — see audit-ui-shared.ts for the harness details and the env
 * vars (AUDIT_API_BASE, AUDIT_UI_PORT, AUDIT_UI_BASE, AUDIT_CHROMIUM)
 * every UI audit honors.
 *
 * Coverage:
 *   - KPI row (7 cards): leaseGoal, leaseTdGoal, leasesRatified,
 *     leasesCancelled, netLeases, ptgVariance (plain number, 1 decimal),
 *     ptgPercent (percent, 2 decimals)
 *   - Leasing Funnel table: all 8 stages (webTraffic, leads, online/onsite
 *     leads, firstTours, online/onsite first tours, moveIns) × Full Span
 *     Goal / To Date Goal / Actual / PTG %, rows located by stage label,
 *     values by column header
 *   - Lease Goals matrix: total / online / onsite / net rows, same columns
 *   - Community Summary: every row (community name + Lease Goal / TD Goal /
 *     Ratified / Online / Onsite / Cancelled / Net / PTG %), the row count
 *     vs the payload, and the client-computed footer totals, which must
 *     equal the sums of the API rows (exactly what the page promises)
 *   - the appliedRange subtitle under the page title and the
 *     "Monthly Trends — {fiscalYear}" chart title (the chart's data-level
 *     agreement with the funnel table is already audited server-side by
 *     audit:leasing's trend-vs-totals consistency checks)
 *
 * Structural drift fails LOUDLY instead of passing vacuously: a missing
 * data-testid/table, a renamed/added/duplicated column, an unknown or
 * missing row label, a row-count mismatch, the error state, or the page
 * never issuing its leasing request are all audit failures.
 *
 * Run from artifacts/api-server (the API server must be reachable):
 *   AUDIT_API_BASE=http://localhost:8099/api pnpm run audit:ui-leasing
 * or as part of the umbrella (which boots a private API server):
 *   pnpm run audit:all
 *
 * Exits 0 when every rendered value matches its API field, 1 otherwise.
 */

import { type Page } from "playwright-core";

import {
  checkCell,
  checkHeaderSet,
  checkText,
  columnIndex,
  fail,
  ok,
  runUiAudit,
} from "./audit-ui-shared";

// ---------- payload shape (the audited API contract this page binds) ----------

interface GoalCell {
  fullSpanGoal: number;
  toDateGoal: number;
  actual: number;
  ptgPercent: number | null;
}
interface CommunityRow {
  community: string;
  fullSpanGoal: number;
  toDateGoal: number;
  ratified: number;
  onlineRatified: number;
  onsiteRatified: number;
  cancelled: number;
  net: number;
  ptgPercent: number | null;
}
interface LeasingPayload {
  appliedRange: { startDate: string; endDate: string; toDate: string };
  fiscalYear: number;
  kpis: {
    leaseGoal: number;
    leaseTdGoal: number;
    leasesRatified: number;
    leasesCancelled: number;
    netLeases: number;
    ptgVariance: number;
    ptgPercent: number | null;
  };
  funnel: {
    webTraffic: GoalCell;
    leads: GoalCell;
    onlineLeads: GoalCell;
    onsiteLeads: GoalCell;
    firstTours: GoalCell;
    onlineFirstTours: GoalCell;
    onsiteFirstTours: GoalCell;
    moveIns: GoalCell;
  };
  matrix: {
    total: GoalCell;
    online: GoalCell;
    onsite: GoalCell;
    net: GoalCell;
  };
  communities: CommunityRow[];
}

// ---------- DOM extraction ----------

interface MatrixSnapshot {
  headers: string[];
  /** label = first line of the row's first cell (subs live on line 2+). */
  rows: { label: string; cells: string[] }[];
}
interface TableSnapshot {
  headers: string[];
  rows: string[][];
  footer: string[];
}
interface DomSnapshot {
  kpis: Record<string, string | null>;
  rangeSubtitle: string | null;
  monthlyTitle: string | null;
  funnel: MatrixSnapshot | null;
  matrix: MatrixSnapshot | null;
  communities: TableSnapshot | null;
}

async function extractDom(page: Page): Promise<DomSnapshot> {
  return page.evaluate(() => {
    const text = (el: Element | null | undefined): string | null =>
      el ? (el as HTMLElement).innerText.trim() : null;

    const kpis: Record<string, string | null> = {};
    for (const id of [
      "kpi-lease-goal",
      "kpi-lease-td-goal",
      "kpi-leases-ratified",
      "kpi-leases-cancelled",
      "kpi-net-leases",
      "kpi-ptg-variance",
      "kpi-ptg-percent",
    ]) {
      kpis[id] = text(document.querySelector(`[data-testid="${id}"]`));
    }

    // "<start> → <end> · progress through <toDate>" under the page title.
    const rangeSubtitle = text(
      Array.from(document.querySelectorAll("p")).find((el) =>
        (el.textContent ?? "").includes("progress through"),
      ),
    );

    // "Monthly Trends — <fiscalYear>" card title next to the trend chart.
    const monthlyTitle = text(
      Array.from(
        document.querySelectorAll('[data-testid="card-monthly-trends"] h3'),
      ).find((el) => (el.textContent ?? "").includes("Monthly Trends")),
    );

    const headersOf = (table: Element): string[] =>
      Array.from(table.querySelectorAll("thead th")).map((th) => text(th) ?? "");

    const matrixSnap = (
      testid: string,
    ): { headers: string[]; rows: { label: string; cells: string[] }[] } | null => {
      const table = document.querySelector(`[data-testid="${testid}"]`);
      if (!table) return null;
      const rows: { label: string; cells: string[] }[] = [];
      for (const tr of Array.from(table.querySelectorAll("tbody tr"))) {
        const tds = Array.from(tr.querySelectorAll("td"));
        if (tds.length < 2 || tds[0].hasAttribute("colspan")) continue; // section header row
        const labelLines = (text(tds[0]) ?? "").split("\n").map((s) => s.trim());
        rows.push({ label: labelLines[0] ?? "", cells: tds.map((td) => text(td) ?? "") });
      }
      return { headers: headersOf(table), rows };
    };

    const tableSnap = (
      testid: string,
    ): { headers: string[]; rows: string[][]; footer: string[] } | null => {
      const table = document.querySelector(`[data-testid="${testid}"]`);
      if (!table) return null;
      return {
        headers: headersOf(table),
        rows: Array.from(table.querySelectorAll("tbody tr")).map((tr) =>
          Array.from(tr.querySelectorAll("td")).map((td) => text(td) ?? ""),
        ),
        footer: Array.from(table.querySelectorAll("tfoot tr td")).map((td) => text(td) ?? ""),
      };
    };

    return {
      kpis,
      rangeSubtitle,
      monthlyTitle,
      funnel: matrixSnap("table-funnel-matrix"),
      matrix: matrixSnap("table-lease-matrix"),
      communities: tableSnap("table-communities"),
    };
  });
}

// ---------- section checks ----------

function checkKpis(dom: DomSnapshot, p: LeasingPayload): void {
  const specs: { id: string; api: number | null; percent: boolean }[] = [
    { id: "kpi-lease-goal", api: p.kpis.leaseGoal, percent: false },
    { id: "kpi-lease-td-goal", api: p.kpis.leaseTdGoal, percent: false },
    { id: "kpi-leases-ratified", api: p.kpis.leasesRatified, percent: false },
    { id: "kpi-leases-cancelled", api: p.kpis.leasesCancelled, percent: false },
    { id: "kpi-net-leases", api: p.kpis.netLeases, percent: false },
    // ptgVariance renders as a PLAIN number (1 decimal); ptgPercent as a percent.
    { id: "kpi-ptg-variance", api: p.kpis.ptgVariance, percent: false },
    { id: "kpi-ptg-percent", api: p.kpis.ptgPercent, percent: true },
  ];
  for (const s of specs) {
    checkCell(`KPI ${s.id}`, dom.kpis[s.id], s.api, { percent: s.percent });
  }
}

/**
 * Shared checker for the two goal-matrix style tables (Leasing Funnel and
 * Lease Goals): rows located by their label in `bindings`, values by column
 * header. An unknown rendered label, a missing expected row, or a header
 * mismatch fails.
 */
function checkGoalTable(
  tableLabel: string,
  testid: string,
  snap: MatrixSnapshot | null,
  labelHeader: string,
  bindings: Record<string, GoalCell>,
): void {
  if (!snap) {
    fail(tableLabel, `table [data-testid="${testid}"] not found on page`);
    return;
  }
  if (
    !checkHeaderSet(tableLabel, snap.headers, [
      labelHeader,
      "Full Span Goal",
      "To Date Goal",
      "Actual",
      "PTG %",
    ])
  ) {
    return;
  }
  const missing = new Set<string>();
  const col = (h: string) => columnIndex(tableLabel, snap.headers, h, missing);
  const cFull = col("Full Span Goal");
  const cToDate = col("To Date Goal");
  const cActual = col("Actual");
  const cPtg = col("PTG %");

  const seen = new Set<string>();
  for (const row of snap.rows) {
    const cell = bindings[row.label];
    if (!cell) {
      fail(`${tableLabel} · "${row.label}"`, "row label does not match any audited API metric");
      continue;
    }
    seen.add(row.label);
    if (cFull >= 0)
      checkCell(`${tableLabel} "${row.label}" · Full Span Goal`, row.cells[cFull], cell.fullSpanGoal, { percent: false });
    if (cToDate >= 0)
      checkCell(`${tableLabel} "${row.label}" · To Date Goal`, row.cells[cToDate], cell.toDateGoal, { percent: false });
    if (cActual >= 0)
      checkCell(`${tableLabel} "${row.label}" · Actual`, row.cells[cActual], cell.actual, { percent: false });
    if (cPtg >= 0)
      checkCell(`${tableLabel} "${row.label}" · PTG %`, row.cells[cPtg], cell.ptgPercent, { percent: true });
  }
  for (const label of Object.keys(bindings)) {
    if (!seen.has(label)) {
      fail(`${tableLabel} · "${label}"`, "expected row is missing from the rendered table");
    }
  }
}

function checkCommunities(dom: DomSnapshot, p: LeasingPayload): void {
  const tableLabel = "communities";
  const snap = dom.communities;
  if (!snap) {
    fail(tableLabel, 'table [data-testid="table-communities"] not found on page');
    return;
  }
  const numericCols: { header: string; field: keyof CommunityRow; percent: boolean }[] = [
    { header: "Lease Goal", field: "fullSpanGoal", percent: false },
    { header: "TD Goal", field: "toDateGoal", percent: false },
    { header: "Ratified", field: "ratified", percent: false },
    { header: "Online", field: "onlineRatified", percent: false },
    { header: "Onsite", field: "onsiteRatified", percent: false },
    { header: "Cancelled", field: "cancelled", percent: false },
    { header: "Net", field: "net", percent: false },
    { header: "PTG %", field: "ptgPercent", percent: true },
  ];
  if (
    !checkHeaderSet(tableLabel, snap.headers, [
      "Community",
      ...numericCols.map((c) => c.header),
    ])
  ) {
    return;
  }
  const missing = new Set<string>();
  const col = (h: string) => columnIndex(tableLabel, snap.headers, h, missing);
  const cName = col("Community");

  if (snap.rows.length !== p.communities.length) {
    fail(
      `${tableLabel} · row count`,
      `page renders ${snap.rows.length} rows but api payload has ${p.communities.length}`,
    );
  } else {
    ok(`${tableLabel} · row count`, `${p.communities.length} rows`);
  }

  // EVERY row: name (catches row-order / mapping drift) + every numeric cell.
  const n = Math.min(snap.rows.length, p.communities.length);
  for (let i = 0; i < n; i++) {
    const rendered = snap.rows[i];
    const api = p.communities[i];
    if (cName >= 0) checkText(`${tableLabel}[${i}] · name`, rendered[cName], api.community);
    for (const c of numericCols) {
      const idx = col(c.header);
      if (idx < 0) continue;
      checkCell(
        `${tableLabel} "${api.community}" · ${c.header}`,
        rendered[idx],
        api[c.field] as number | null,
        { percent: c.percent },
      );
    }
  }

  // Footer totals are computed CLIENT-SIDE as sums of the rendered rows —
  // the audit recomputes them from the API rows, which is exactly what the
  // page promises to display. (The PTG % footer cell is intentionally
  // empty on the page, so it has no audited binding.)
  if (snap.footer.length !== snap.headers.length) {
    fail(
      `${tableLabel} · footer`,
      `footer has ${snap.footer.length} cell(s) but the table has ${snap.headers.length} columns — ` +
        "the totals row no longer lines up with the audited column layout",
    );
    return;
  }
  const sum = (pick: (r: CommunityRow) => number) =>
    p.communities.reduce((t, r) => t + pick(r), 0);
  const footerSpecs: { header: string; api: number }[] = [
    { header: "Lease Goal", api: sum((r) => r.fullSpanGoal) },
    { header: "TD Goal", api: sum((r) => r.toDateGoal) },
    { header: "Ratified", api: sum((r) => r.ratified) },
    { header: "Online", api: sum((r) => r.onlineRatified) },
    { header: "Onsite", api: sum((r) => r.onsiteRatified) },
    { header: "Cancelled", api: sum((r) => r.cancelled) },
    { header: "Net", api: sum((r) => r.net) },
  ];
  for (const f of footerSpecs) {
    const idx = col(f.header);
    if (idx < 0) continue;
    checkCell(`${tableLabel} · footer ${f.header}`, snap.footer[idx], f.api, { percent: false });
  }
}

/** Header subtitle and chart title — the two payload bindings outside tables/KPIs. */
function checkHeaderTexts(dom: DomSnapshot, p: LeasingPayload): void {
  checkText(
    "appliedRange subtitle",
    dom.rangeSubtitle,
    `${p.appliedRange.startDate} → ${p.appliedRange.endDate} · progress through ${p.appliedRange.toDate}`,
  );
  checkText("Monthly Trends title", dom.monthlyTitle, `Monthly Trends — ${p.fiscalYear}`);
}

// ---------- main ----------

runUiAudit<LeasingPayload>({
  auditName: "audit:ui-leasing",
  pageLabel: "Leasing",
  pagePath: "/workspaces/marketing/leasing",
  apiPathname: "/api/dashboards/leasing",
  readyTestId: "kpi-lease-goal",
  validatePayload: (p) =>
    !p?.kpis || !p?.funnel || !p?.matrix || !Array.isArray(p?.communities)
      ? "missing expected sections (kpis/funnel/matrix/communities)"
      : null,
  payloadSummary: (p) =>
    `payload range ${p.appliedRange.startDate} → ${p.appliedRange.endDate}` +
    ` (through ${p.appliedRange.toDate}, FY${p.fiscalYear}); ` +
    `${p.communities.length} community row(s)`,
  runChecks: async (page, payload) => {
    const dom = await extractDom(page);

    checkKpis(dom, payload);
    checkHeaderTexts(dom, payload);

    checkGoalTable("funnel", "table-funnel-matrix", dom.funnel, "Stage", {
      "Web Traffic": payload.funnel.webTraffic,
      Leads: payload.funnel.leads,
      "Online Leads": payload.funnel.onlineLeads,
      "Onsite Leads": payload.funnel.onsiteLeads,
      "First Tours": payload.funnel.firstTours,
      "Online First Tours": payload.funnel.onlineFirstTours,
      "Onsite First Tours": payload.funnel.onsiteFirstTours,
      "Move-Ins": payload.funnel.moveIns,
    });

    checkGoalTable("lease matrix", "table-lease-matrix", dom.matrix, "Measure", {
      "Leases Ratified": payload.matrix.total,
      "Online Leases Ratified": payload.matrix.online,
      "Onsite Leases Ratified": payload.matrix.onsite,
      "Net Leases": payload.matrix.net,
    });

    checkCommunities(dom, payload);
  },
}).catch((err) => {
  console.error(`AUDIT ERRORED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
