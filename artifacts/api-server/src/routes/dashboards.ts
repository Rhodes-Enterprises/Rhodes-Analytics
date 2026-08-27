import { Router, type IRouter } from "express";
import {
  getFilterOptions,
  getOverviewWithTargets,
  getYearOverYear,
  type DashboardFilters,
  type TargetKind,
} from "../lib/overview-targets";
import {
  getLeasingDashboard,
  getLeasingFilterOptions,
  type LeasingFilters,
} from "../lib/leasing";
import {
  getWebsiteTraffic,
  getFunnelMetric,
  getEhiGoals,
  getCommunityList,
  type FunnelMetric,
} from "../lib/marketing-dashboards";
import { withDataFreshness } from "../lib/query-cache";

const router: IRouter = Router();

const TARGETS: TargetKind[] = ["proforma", "business_plan", "goal", "waterfall"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayChicago(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
  }).format(new Date());
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

class BadRequestError extends Error {}

/** Validate a YYYY-MM-DD string as a real calendar date; 400 on garbage. */
function parseDateOrDefault(
  raw: string | undefined,
  fallback: string,
  field: string,
): string {
  if (!raw) return fallback;
  if (DATE_RE.test(raw)) {
    const d = new Date(raw + "T00:00:00Z");
    if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === raw) {
      return raw;
    }
  }
  throw new BadRequestError(`${field} must be a valid YYYY-MM-DD date`);
}

function buildFilters(query: Record<string, unknown>): DashboardFilters {
  const today = todayChicago();
  const t = new Date(today + "T00:00:00");
  const q = Math.floor(t.getMonth() / 3);
  const qStart = `${t.getFullYear()}-${String(q * 3 + 1).padStart(2, "0")}-01`;
  const qEndDate = new Date(t.getFullYear(), q * 3 + 3, 0);
  const qEnd = `${qEndDate.getFullYear()}-${String(qEndDate.getMonth() + 1).padStart(2, "0")}-${String(qEndDate.getDate()).padStart(2, "0")}`;

  const startDate = parseDateOrDefault(str(query.startDate), qStart, "startDate");
  const endDate = parseDateOrDefault(str(query.endDate), qEnd, "endDate");
  if (startDate > endDate) {
    throw new BadRequestError("startDate must be on or before endDate");
  }
  // Goals in DM_GOALS are issued per fiscal (calendar) year; a span crossing
  // years would silently mix goal regimes, so reject it explicitly.
  if (startDate.slice(0, 4) !== endDate.slice(0, 4)) {
    throw new BadRequestError(
      "Date range must stay within a single calendar year (goals are issued per fiscal year)",
    );
  }
  const targetRaw = str(query.target);
  const target = TARGETS.includes(targetRaw as TargetKind)
    ? (targetRaw as TargetKind)
    : "goal";

  return {
    company: str(query.company),
    development: str(query.development),
    cohortQuarter: str(query.cohortQuarter),
    leadSource: str(query.leadSource),
    contactChannel: str(query.contactChannel),
    dealChannel: str(query.dealChannel),
    startDate,
    endDate,
    toDate: today < startDate ? startDate : today > endDate ? endDate : today,
    target,
  };
}

function sendSnowflakeError(res: import("express").Response, err: unknown) {
  if (err instanceof BadRequestError) {
    res.status(400).json({ error: err.message });
    return;
  }
  // Keep raw Snowflake details in server logs; return a stable message.
  console.error("Dashboard query failed:", err);
  res.status(502).json({ error: "Upstream data query failed" });
}

router.get("/dashboards/overview-with-targets/filters", async (_req, res) => {
  try {
    res.json(await getFilterOptions());
  } catch (err) {
    sendSnowflakeError(res, err);
  }
});

router.get("/dashboards/overview-with-targets", async (req, res) => {
  try {
    const filters = buildFilters(req.query as Record<string, unknown>);
    const { value: data, dataAsOf, refreshing } = await withDataFreshness(() =>
      getOverviewWithTargets(filters),
    );
    res.json({
      appliedRange: {
        startDate: filters.startDate,
        endDate: filters.endDate,
        toDate: filters.toDate,
        target: filters.target,
      },
      dataAsOf,
      refreshing,
      kpis: data.kpis,
      trafficMatrix: data.trafficMatrix,
      // Record-level lists behind the unknown buckets ride in the same
      // response as the counts they explain, from the same cached bundle —
      // a background cache refresh can never make a drill-down dialog
      // disagree with the matrix row the user clicked.
      unknownRecords: data.unknownRecords,
      divisions: data.divisions,
      developments: data.developments,
      ratios: data.ratios,
    });
  } catch (err) {
    sendSnowflakeError(res, err);
  }
});

router.get("/dashboards/overview-with-targets/yoy", async (req, res) => {
  try {
    const filters = buildFilters(req.query as Record<string, unknown>);
    res.json(await getYearOverYear(filters));
  } catch (err) {
    sendSnowflakeError(res, err);
  }
});

function buildLeasingFilters(query: Record<string, unknown>): LeasingFilters {
  const today = todayChicago();
  const year = today.slice(0, 4);
  // Leasing defaults to the current year to date (RL goals are annual).
  const startDate = parseDateOrDefault(str(query.startDate), `${year}-01-01`, "startDate");
  const endDate = parseDateOrDefault(str(query.endDate), `${year}-12-31`, "endDate");
  if (startDate > endDate) {
    throw new BadRequestError("startDate must be on or before endDate");
  }
  if (startDate.slice(0, 4) !== endDate.slice(0, 4)) {
    throw new BadRequestError(
      "Date range must stay within a single calendar year (goals are issued per fiscal year)",
    );
  }
  return {
    community: str(query.community),
    channel: str(query.channel),
    startDate,
    endDate,
    toDate: today < startDate ? startDate : today > endDate ? endDate : today,
  };
}

router.get("/dashboards/leasing/filters", async (_req, res) => {
  try {
    res.json(await getLeasingFilterOptions());
  } catch (err) {
    sendSnowflakeError(res, err);
  }
});

router.get("/dashboards/leasing", async (req, res) => {
  try {
    const filters = buildLeasingFilters(req.query as Record<string, unknown>);
    const { value: data, dataAsOf, refreshing } = await withDataFreshness(() =>
      getLeasingDashboard(filters),
    );
    res.json({
      appliedRange: {
        startDate: filters.startDate,
        endDate: filters.endDate,
        toDate: filters.toDate,
      },
      dataAsOf,
      refreshing,
      fiscalYear: data.fiscalYear,
      kpis: data.kpis,
      funnel: data.funnel,
      matrix: data.matrix,
      communities: data.communities,
      monthly: data.monthly,
    });
  } catch (err) {
    sendSnowflakeError(res, err);
  }
});

router.get("/dashboards/website-traffic", async (req, res) => {
  try {
    const filters = buildFilters(req.query as Record<string, unknown>);
    const { value: data, dataAsOf, refreshing } = await withDataFreshness(() =>
      getWebsiteTraffic(filters),
    );
    res.json({ appliedRange: appliedRange(filters), dataAsOf, refreshing, ...data });
  } catch (err) {
    sendSnowflakeError(res, err);
  }
});

const FUNNEL_METRICS: FunnelMetric[] = ["leads", "tours", "gross-sales"];

router.get("/dashboards/funnel", async (req, res) => {
  try {
    const metric = req.query.metric as FunnelMetric;
    if (!FUNNEL_METRICS.includes(metric)) {
      res.status(400).json({ error: "metric must be one of leads, tours, gross-sales" });
      return;
    }
    const filters = buildFilters(req.query as Record<string, unknown>);
    const { value: data, dataAsOf, refreshing } = await withDataFreshness(() =>
      getFunnelMetric(metric, filters),
    );
    res.json({ appliedRange: appliedRange(filters), dataAsOf, refreshing, ...data });
  } catch (err) {
    sendSnowflakeError(res, err);
  }
});

/** EHI Goals always looks at the full fiscal year of the requested range. */
function ehiGoalsYearFilters(filters: DashboardFilters): DashboardFilters {
  const year = filters.startDate.slice(0, 4);
  return { ...filters, startDate: `${year}-01-01`, endDate: `${year}-12-31` };
}

router.get("/dashboards/ehi-goals", async (req, res) => {
  try {
    const yearFilters = ehiGoalsYearFilters(buildFilters(req.query as Record<string, unknown>));
    const { value: data, dataAsOf, refreshing } = await withDataFreshness(() =>
      getEhiGoals(yearFilters),
    );
    res.json({ appliedRange: appliedRange(yearFilters), dataAsOf, refreshing, ...data });
  } catch (err) {
    sendSnowflakeError(res, err);
  }
});

router.get("/dashboards/communities", async (_req, res) => {
  try {
    res.json(await getCommunityList());
  } catch (err) {
    sendSnowflakeError(res, err);
  }
});

function appliedRange(filters: DashboardFilters) {
  return {
    startDate: filters.startDate,
    endDate: filters.endDate,
    toDate: filters.toDate,
    target: filters.target,
  };
}

/**
 * Every endpoint the startup warm-up pre-computes, paired with the exact HTTP
 * request path a default (no-filter) visit issues. The warm job and the
 * request path MUST stay in lockstep: warming only helps if the job populates
 * the very cache keys the route handler later reads for that path.
 * scripts/audit-warmup.ts exercises BOTH sides of this table and fails when
 * they diverge — so add new warmed endpoints here, not ad-hoc inside
 * warmDefaultDashboardCaches, and they are covered automatically.
 */
export interface WarmedEndpoint {
  name: string;
  /** Path (incl. query string) of the default request this job pre-warms. */
  requestPath: string;
  run: (filters: DashboardFilters) => Promise<unknown>;
}

export const WARMED_ENDPOINTS: WarmedEndpoint[] = [
  // Overview is the landing page, so warm it first: the first visitor after
  // a restart almost always hits these three endpoints.
  {
    name: "overview-filters",
    requestPath: "/api/dashboards/overview-with-targets/filters",
    run: () => getFilterOptions(),
  },
  {
    name: "overview-with-targets",
    requestPath: "/api/dashboards/overview-with-targets",
    run: (filters) => getOverviewWithTargets(filters),
  },
  {
    name: "overview-yoy",
    requestPath: "/api/dashboards/overview-with-targets/yoy",
    run: (filters) => getYearOverYear(filters),
  },
  {
    name: "website-traffic",
    requestPath: "/api/dashboards/website-traffic",
    run: (filters) => getWebsiteTraffic(filters),
  },
  ...FUNNEL_METRICS.map(
    (m): WarmedEndpoint => ({
      name: `funnel:${m}`,
      requestPath: `/api/dashboards/funnel?metric=${m}`,
      run: (filters) => getFunnelMetric(m, filters),
    }),
  ),
  {
    name: "ehi-goals",
    requestPath: "/api/dashboards/ehi-goals",
    run: (filters) => getEhiGoals(ehiGoalsYearFilters(filters)),
  },
  {
    name: "communities",
    requestPath: "/api/dashboards/communities",
    run: () => getCommunityList(),
  },
  // Leasing (current year to date) — warmed after Overview since Overview is
  // the landing page. Leasing has its own filter defaults: the warm jobs use
  // buildLeasingFilters({}) exactly like a no-param request to its routes.
  {
    name: "leasing-filters",
    requestPath: "/api/dashboards/leasing/filters",
    run: () => getLeasingFilterOptions(),
  },
  {
    name: "leasing",
    requestPath: "/api/dashboards/leasing",
    run: () => getLeasingDashboard(buildLeasingFilters({})),
  },
];

export interface WarmupResult {
  warmed: string[];
  failed: string[];
  /** True when WARM_DASHBOARD_CACHE disabled warming entirely. */
  skipped: boolean;
  elapsedMs: number;
}

/**
 * Pre-populates the in-memory query cache for the default (current-quarter)
 * view of the Overview page, each marketing dashboard, and the Leasing page
 * (current year to date) so the first visitor after a restart gets warm
 * responses. Failures only mean a cold first load.
 * Disable with WARM_DASHBOARD_CACHE=0 (or "false").
 *
 * The production caller (index.ts) intentionally does not await this; the
 * returned summary exists so the warm-up audit can wait for completion and
 * verify the warmed keys are the ones real default requests read.
 */
export async function warmDefaultDashboardCaches(logger: {
  info: Function;
  warn: Function;
}): Promise<WarmupResult> {
  const flag = process.env.WARM_DASHBOARD_CACHE;
  if (flag === "0" || flag === "false") {
    return { warmed: [], failed: [], skipped: true, elapsedMs: 0 };
  }
  const filters = buildFilters({});
  const started = Date.now();
  const warmed: string[] = [];
  const failed: string[] = [];
  // One endpoint at a time: each endpoint already fans out its own queries
  // in parallel, and warming all endpoints at once bursts past the connector
  // proxy's ~10 req/s rate limit. A user request arriving mid-warm-up shares
  // in-flight queries via the cache's single-flight dedupe.
  for (const { name, run } of WARMED_ENDPOINTS) {
    try {
      await run(filters);
      warmed.push(name);
    } catch {
      // One-off proxy/network hiccups happen; retry each endpoint once
      // after a short pause before giving up on warming it.
      await new Promise((r) => setTimeout(r, 2000));
      try {
        await run(filters);
        warmed.push(name);
      } catch {
        failed.push(name);
      }
    }
  }
  const elapsedMs = Date.now() - started;
  if (failed.length > 0) {
    logger.warn(
      { elapsedMs, failed },
      "Dashboard cache warm-up finished with failures (endpoints will fall back to cold queries)",
    );
  } else {
    logger.info({ elapsedMs, warmed: warmed.length }, "Dashboard cache warm-up complete");
  }
  return { warmed, failed, skipped: false, elapsedMs };
}

export default router;
