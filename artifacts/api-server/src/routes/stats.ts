import { Router, type IRouter } from "express";
import { sql, eq } from "drizzle-orm";
import { db, sitesTable } from "@workspace/db";
import {
  GetStatsSummaryParams,
  GetStatsSummaryQueryParams,
  GetStatsSummaryResponse,
  GetStatsTimeseriesParams,
  GetStatsTimeseriesQueryParams,
  GetStatsTimeseriesResponse,
  GetStatsPagesParams,
  GetStatsPagesQueryParams,
  GetStatsPagesResponse,
  GetStatsReferrersParams,
  GetStatsReferrersQueryParams,
  GetStatsReferrersResponse,
  GetStatsDevicesParams,
  GetStatsDevicesQueryParams,
  GetStatsDevicesResponse,
  GetStatsCountriesParams,
  GetStatsCountriesQueryParams,
  GetStatsCountriesResponse,
} from "@workspace/api-zod";
import { RANGES, pctChange, type RangeKey } from "../lib/ranges";
import { countryName } from "../lib/countries";

const router: IRouter = Router();

async function siteExists(id: number): Promise<boolean> {
  const [site] = await db
    .select({ id: sitesTable.id })
    .from(sitesTable)
    .where(eq(sitesTable.id, id));
  return !!site;
}

router.get("/sites/:id/stats/summary", async (req, res): Promise<void> => {
  const params = GetStatsSummaryParams.safeParse(req.params);
  const query = GetStatsSummaryQueryParams.safeParse(req.query);
  if (!params.success || !query.success) {
    res.status(400).json({ error: "Invalid parameters" });
    return;
  }
  if (!(await siteExists(params.data.id))) {
    res.status(404).json({ error: "Site not found" });
    return;
  }

  const spec = RANGES[query.data.range as RangeKey];
  const interval = sql.raw(`'${spec.interval}'`);

  const result = await db.execute(sql`
    WITH current_period AS (
      SELECT visitor_id, duration_seconds
      FROM events
      WHERE site_id = ${params.data.id}
        AND occurred_at >= NOW() - ${interval}::interval
    ),
    previous_period AS (
      SELECT visitor_id, duration_seconds
      FROM events
      WHERE site_id = ${params.data.id}
        AND occurred_at >= NOW() - ${interval}::interval * 2
        AND occurred_at < NOW() - ${interval}::interval
    ),
    cur AS (
      SELECT
        COUNT(DISTINCT visitor_id) AS visitors,
        COUNT(*) AS pageviews,
        COALESCE(AVG(duration_seconds), 0) AS avg_duration,
        COALESCE(
          (SELECT COUNT(*) FROM (
            SELECT visitor_id FROM current_period GROUP BY visitor_id HAVING COUNT(*) = 1
          ) b)::float / NULLIF(COUNT(DISTINCT visitor_id), 0) * 100,
          0
        ) AS bounce_rate
      FROM current_period
    ),
    prev AS (
      SELECT
        COUNT(DISTINCT visitor_id) AS visitors,
        COUNT(*) AS pageviews,
        COALESCE(AVG(duration_seconds), 0) AS avg_duration,
        COALESCE(
          (SELECT COUNT(*) FROM (
            SELECT visitor_id FROM previous_period GROUP BY visitor_id HAVING COUNT(*) = 1
          ) b)::float / NULLIF(COUNT(DISTINCT visitor_id), 0) * 100,
          0
        ) AS bounce_rate
      FROM previous_period
    ),
    live AS (
      SELECT COUNT(DISTINCT visitor_id) AS live_visitors
      FROM events
      WHERE site_id = ${params.data.id}
        AND occurred_at >= NOW() - INTERVAL '5 minutes'
    )
    SELECT
      cur.visitors AS cur_visitors,
      cur.pageviews AS cur_pageviews,
      cur.avg_duration AS cur_avg_duration,
      cur.bounce_rate AS cur_bounce_rate,
      prev.visitors AS prev_visitors,
      prev.pageviews AS prev_pageviews,
      prev.avg_duration AS prev_avg_duration,
      prev.bounce_rate AS prev_bounce_rate,
      live.live_visitors
    FROM cur, prev, live
  `);

  const row = result.rows[0] ?? {};
  const curVisitors = Number(row["cur_visitors"] ?? 0);
  const curPageviews = Number(row["cur_pageviews"] ?? 0);
  const curAvgDuration = Number(row["cur_avg_duration"] ?? 0);
  const curBounce = Number(row["cur_bounce_rate"] ?? 0);
  const prevVisitors = Number(row["prev_visitors"] ?? 0);
  const prevPageviews = Number(row["prev_pageviews"] ?? 0);
  const prevAvgDuration = Number(row["prev_avg_duration"] ?? 0);
  const prevBounce = Number(row["prev_bounce_rate"] ?? 0);
  const hasPrev = prevPageviews > 0;

  res.json(
    GetStatsSummaryResponse.parse({
      visitors: curVisitors,
      pageviews: curPageviews,
      bounceRate: curBounce,
      avgDurationSeconds: curAvgDuration,
      visitorsChange: pctChange(curVisitors, prevVisitors),
      pageviewsChange: pctChange(curPageviews, prevPageviews),
      bounceRateChange: hasPrev ? curBounce - prevBounce : null,
      avgDurationChange: pctChange(curAvgDuration, prevAvgDuration),
      liveVisitors: Number(row["live_visitors"] ?? 0),
    }),
  );
});

router.get("/sites/:id/stats/timeseries", async (req, res): Promise<void> => {
  const params = GetStatsTimeseriesParams.safeParse(req.params);
  const query = GetStatsTimeseriesQueryParams.safeParse(req.query);
  if (!params.success || !query.success) {
    res.status(400).json({ error: "Invalid parameters" });
    return;
  }
  if (!(await siteExists(params.data.id))) {
    res.status(404).json({ error: "Site not found" });
    return;
  }

  const spec = RANGES[query.data.range as RangeKey];
  const interval = sql.raw(`'${spec.interval}'`);
  const bucket = sql.raw(`'${spec.bucket}'`);
  const step = sql.raw(spec.bucket === "hour" ? "'1 hour'" : "'1 day'");

  const result = await db.execute(sql`
    WITH buckets AS (
      SELECT generate_series(
        date_trunc(${bucket}, NOW() - ${interval}::interval),
        date_trunc(${bucket}, NOW()),
        ${step}::interval
      ) AS bucket
    ),
    counts AS (
      SELECT
        date_trunc(${bucket}, occurred_at) AS bucket,
        COUNT(DISTINCT visitor_id) AS visitors,
        COUNT(*) AS pageviews
      FROM events
      WHERE site_id = ${params.data.id}
        AND occurred_at >= NOW() - ${interval}::interval
      GROUP BY 1
    )
    SELECT
      b.bucket,
      COALESCE(c.visitors, 0) AS visitors,
      COALESCE(c.pageviews, 0) AS pageviews
    FROM buckets b
    LEFT JOIN counts c ON c.bucket = b.bucket
    ORDER BY b.bucket ASC
  `);

  res.json(
    GetStatsTimeseriesResponse.parse(
      result.rows.map((row) => ({
        bucket: new Date(row["bucket"] as string).toISOString(),
        visitors: Number(row["visitors"]),
        pageviews: Number(row["pageviews"]),
      })),
    ),
  );
});

router.get("/sites/:id/stats/pages", async (req, res): Promise<void> => {
  const params = GetStatsPagesParams.safeParse(req.params);
  const query = GetStatsPagesQueryParams.safeParse(req.query);
  if (!params.success || !query.success) {
    res.status(400).json({ error: "Invalid parameters" });
    return;
  }
  if (!(await siteExists(params.data.id))) {
    res.status(404).json({ error: "Site not found" });
    return;
  }

  const spec = RANGES[query.data.range as RangeKey];
  const interval = sql.raw(`'${spec.interval}'`);

  const result = await db.execute(sql`
    SELECT
      path,
      COUNT(DISTINCT visitor_id) AS visitors,
      COUNT(*) AS pageviews
    FROM events
    WHERE site_id = ${params.data.id}
      AND occurred_at >= NOW() - ${interval}::interval
    GROUP BY path
    ORDER BY pageviews DESC
    LIMIT 12
  `);

  res.json(
    GetStatsPagesResponse.parse(
      result.rows.map((row) => ({
        path: String(row["path"]),
        visitors: Number(row["visitors"]),
        pageviews: Number(row["pageviews"]),
      })),
    ),
  );
});

router.get("/sites/:id/stats/referrers", async (req, res): Promise<void> => {
  const params = GetStatsReferrersParams.safeParse(req.params);
  const query = GetStatsReferrersQueryParams.safeParse(req.query);
  if (!params.success || !query.success) {
    res.status(400).json({ error: "Invalid parameters" });
    return;
  }
  if (!(await siteExists(params.data.id))) {
    res.status(404).json({ error: "Site not found" });
    return;
  }

  const spec = RANGES[query.data.range as RangeKey];
  const interval = sql.raw(`'${spec.interval}'`);

  const result = await db.execute(sql`
    SELECT
      COALESCE(referrer, 'Direct') AS referrer,
      COUNT(DISTINCT visitor_id) AS visitors
    FROM events
    WHERE site_id = ${params.data.id}
      AND occurred_at >= NOW() - ${interval}::interval
    GROUP BY 1
    ORDER BY visitors DESC
    LIMIT 12
  `);

  res.json(
    GetStatsReferrersResponse.parse(
      result.rows.map((row) => ({
        referrer: String(row["referrer"]),
        visitors: Number(row["visitors"]),
      })),
    ),
  );
});

router.get("/sites/:id/stats/devices", async (req, res): Promise<void> => {
  const params = GetStatsDevicesParams.safeParse(req.params);
  const query = GetStatsDevicesQueryParams.safeParse(req.query);
  if (!params.success || !query.success) {
    res.status(400).json({ error: "Invalid parameters" });
    return;
  }
  if (!(await siteExists(params.data.id))) {
    res.status(404).json({ error: "Site not found" });
    return;
  }

  const spec = RANGES[query.data.range as RangeKey];
  const interval = sql.raw(`'${spec.interval}'`);

  async function breakdown(
    column: "browser" | "os" | "device_type",
  ): Promise<{ name: string; visitors: number; percentage: number }[]> {
    const col = sql.raw(column);
    const result = await db.execute(sql`
      WITH grouped AS (
        SELECT
          COALESCE(${col}, 'Unknown') AS name,
          COUNT(DISTINCT visitor_id) AS visitors
        FROM events
        WHERE site_id = ${params.data!.id}
          AND occurred_at >= NOW() - ${interval}::interval
        GROUP BY 1
      )
      SELECT
        name,
        visitors,
        COALESCE(visitors::float / NULLIF(SUM(visitors) OVER (), 0) * 100, 0) AS percentage
      FROM grouped
      ORDER BY visitors DESC
      LIMIT 8
    `);
    return result.rows.map((row) => ({
      name: String(row["name"]),
      visitors: Number(row["visitors"]),
      percentage: Number(row["percentage"]),
    }));
  }

  const [browsers, operatingSystems, deviceTypes] = await Promise.all([
    breakdown("browser"),
    breakdown("os"),
    breakdown("device_type"),
  ]);

  res.json(
    GetStatsDevicesResponse.parse({ browsers, operatingSystems, deviceTypes }),
  );
});

router.get("/sites/:id/stats/countries", async (req, res): Promise<void> => {
  const params = GetStatsCountriesParams.safeParse(req.params);
  const query = GetStatsCountriesQueryParams.safeParse(req.query);
  if (!params.success || !query.success) {
    res.status(400).json({ error: "Invalid parameters" });
    return;
  }
  if (!(await siteExists(params.data.id))) {
    res.status(404).json({ error: "Site not found" });
    return;
  }

  const spec = RANGES[query.data.range as RangeKey];
  const interval = sql.raw(`'${spec.interval}'`);

  const result = await db.execute(sql`
    SELECT
      country,
      COUNT(DISTINCT visitor_id) AS visitors
    FROM events
    WHERE site_id = ${params.data.id}
      AND occurred_at >= NOW() - ${interval}::interval
      AND country IS NOT NULL
    GROUP BY country
    ORDER BY visitors DESC
    LIMIT 12
  `);

  res.json(
    GetStatsCountriesResponse.parse(
      result.rows.map((row) => ({
        country: String(row["country"]),
        countryName: countryName(String(row["country"])),
        visitors: Number(row["visitors"]),
      })),
    ),
  );
});

export default router;
