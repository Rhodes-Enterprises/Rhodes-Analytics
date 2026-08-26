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
    const data = await getOverviewWithTargets(filters);
    res.json({
      appliedRange: {
        startDate: filters.startDate,
        endDate: filters.endDate,
        toDate: filters.toDate,
        target: filters.target,
      },
      kpis: data.kpis,
      trafficMatrix: data.trafficMatrix,
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
    const data = await getLeasingDashboard(filters);
    res.json({
      appliedRange: {
        startDate: filters.startDate,
        endDate: filters.endDate,
        toDate: filters.toDate,
      },
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
    const data = await getWebsiteTraffic(filters);
    res.json({ appliedRange: appliedRange(filters), ...data });
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
    const data = await getFunnelMetric(metric, filters);
    res.json({ appliedRange: appliedRange(filters), ...data });
  } catch (err) {
    sendSnowflakeError(res, err);
  }
});

router.get("/dashboards/ehi-goals", async (req, res) => {
  try {
    // EHI Goals always looks at the full fiscal year of the requested range.
    const filters = buildFilters(req.query as Record<string, unknown>);
    const year = filters.startDate.slice(0, 4);
    const yearFilters: DashboardFilters = {
      ...filters,
      startDate: `${year}-01-01`,
      endDate: `${year}-12-31`,
    };
    const data = await getEhiGoals(yearFilters);
    res.json({ appliedRange: appliedRange(yearFilters), ...data });
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

export default router;
