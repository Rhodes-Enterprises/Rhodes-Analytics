import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { GetOverviewResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/overview", async (_req, res): Promise<void> => {
  const result = await db.execute(sql`
    WITH totals AS (
      SELECT
        COUNT(DISTINCT visitor_id) AS visitors_24h,
        COUNT(*) AS pageviews_24h
      FROM events
      WHERE occurred_at >= NOW() - INTERVAL '24 hours'
    ),
    live AS (
      SELECT COUNT(DISTINCT visitor_id) AS live_visitors
      FROM events
      WHERE occurred_at >= NOW() - INTERVAL '5 minutes'
    ),
    site_count AS (
      SELECT COUNT(*) AS total_sites FROM sites
    ),
    top_site AS (
      SELECT s.id, s.name, s.domain, COUNT(DISTINCT e.visitor_id) AS visitors_24h
      FROM sites s
      JOIN events e ON e.site_id = s.id
        AND e.occurred_at >= NOW() - INTERVAL '24 hours'
      GROUP BY s.id, s.name, s.domain
      ORDER BY visitors_24h DESC
      LIMIT 1
    )
    SELECT
      site_count.total_sites,
      totals.visitors_24h,
      totals.pageviews_24h,
      live.live_visitors,
      top_site.id AS top_id,
      top_site.name AS top_name,
      top_site.domain AS top_domain,
      top_site.visitors_24h AS top_visitors
    FROM totals, live, site_count
    LEFT JOIN top_site ON TRUE
  `);

  const row = result.rows[0] ?? {};

  res.json(
    GetOverviewResponse.parse({
      totalSites: Number(row["total_sites"] ?? 0),
      visitors24h: Number(row["visitors_24h"] ?? 0),
      pageviews24h: Number(row["pageviews_24h"] ?? 0),
      liveVisitors: Number(row["live_visitors"] ?? 0),
      topSite:
        row["top_id"] != null
          ? {
              id: Number(row["top_id"]),
              name: String(row["top_name"]),
              domain: String(row["top_domain"]),
              visitors24h: Number(row["top_visitors"]),
            }
          : null,
    }),
  );
});

export default router;
