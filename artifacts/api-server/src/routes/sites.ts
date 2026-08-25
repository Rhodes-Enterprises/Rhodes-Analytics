import { randomBytes } from "node:crypto";
import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db, sitesTable } from "@workspace/db";
import {
  CreateSiteBody,
  CreateSiteResponse,
  GetSiteParams,
  GetSiteResponse,
  UpdateSiteParams,
  UpdateSiteBody,
  UpdateSiteResponse,
  DeleteSiteParams,
  ListSitesResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

function newTrackingId(): string {
  return `ra_${randomBytes(8).toString("hex")}`;
}

router.get("/sites", async (_req, res): Promise<void> => {
  const result = await db.execute(sql`
    WITH last24 AS (
      SELECT
        site_id,
        COUNT(DISTINCT visitor_id) AS visitors,
        COUNT(*) AS pageviews
      FROM events
      WHERE occurred_at >= NOW() - INTERVAL '24 hours'
      GROUP BY site_id
    ),
    live AS (
      SELECT site_id, COUNT(DISTINCT visitor_id) AS live_visitors
      FROM events
      WHERE occurred_at >= NOW() - INTERVAL '5 minutes'
      GROUP BY site_id
    ),
    hourly AS (
      SELECT
        site_id,
        FLOOR(EXTRACT(EPOCH FROM (NOW() - occurred_at)) / 3600)::int AS hours_ago,
        COUNT(*) AS pageviews
      FROM events
      WHERE occurred_at >= NOW() - INTERVAL '24 hours'
      GROUP BY site_id, hours_ago
    )
    SELECT
      s.id,
      s.name,
      s.domain,
      s.tracking_id,
      s.created_at,
      COALESCE(l.visitors, 0) AS visitors_24h,
      COALESCE(l.pageviews, 0) AS pageviews_24h,
      COALESCE(lv.live_visitors, 0) AS live_visitors,
      COALESCE(
        (
          SELECT ARRAY_AGG(COALESCE(h.pageviews, 0) ORDER BY g.hours_ago DESC)
          FROM generate_series(0, 23) AS g(hours_ago)
          LEFT JOIN hourly h
            ON h.site_id = s.id AND h.hours_ago = g.hours_ago
        ),
        ARRAY[]::bigint[]
      ) AS sparkline
    FROM sites s
    LEFT JOIN last24 l ON l.site_id = s.id
    LEFT JOIN live lv ON lv.site_id = s.id
    ORDER BY s.created_at ASC
  `);

  const sites = result.rows.map((row) => ({
    id: Number(row["id"]),
    name: String(row["name"]),
    domain: String(row["domain"]),
    trackingId: String(row["tracking_id"]),
    createdAt: new Date(row["created_at"] as string).toISOString(),
    visitors24h: Number(row["visitors_24h"]),
    pageviews24h: Number(row["pageviews_24h"]),
    liveVisitors: Number(row["live_visitors"]),
    sparkline: ((row["sparkline"] as unknown[]) ?? []).map((n) => Number(n)),
  }));

  res.json(ListSitesResponse.parse(sites));
});

router.post("/sites", async (req, res): Promise<void> => {
  const parsed = CreateSiteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [site] = await db
    .insert(sitesTable)
    .values({
      name: parsed.data.name,
      domain: parsed.data.domain
        .replace(/^https?:\/\//, "")
        .replace(/\/.*$/, ""),
      trackingId: newTrackingId(),
    })
    .returning();

  res.status(201).json(
    CreateSiteResponse.parse({
      ...site,
      createdAt: site!.createdAt.toISOString(),
    }),
  );
});

router.get("/sites/:id", async (req, res): Promise<void> => {
  const params = GetSiteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [site] = await db
    .select()
    .from(sitesTable)
    .where(eq(sitesTable.id, params.data.id));

  if (!site) {
    res.status(404).json({ error: "Site not found" });
    return;
  }

  res.json(
    GetSiteResponse.parse({ ...site, createdAt: site.createdAt.toISOString() }),
  );
});

router.patch("/sites/:id", async (req, res): Promise<void> => {
  const params = UpdateSiteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateSiteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updates: Partial<{ name: string; domain: string }> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.domain !== undefined) {
    updates.domain = parsed.data.domain
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
  }

  if (Object.keys(updates).length === 0) {
    const [existing] = await db
      .select()
      .from(sitesTable)
      .where(eq(sitesTable.id, params.data.id));
    if (!existing) {
      res.status(404).json({ error: "Site not found" });
      return;
    }
    res.json(
      UpdateSiteResponse.parse({
        ...existing,
        createdAt: existing.createdAt.toISOString(),
      }),
    );
    return;
  }

  const [site] = await db
    .update(sitesTable)
    .set(updates)
    .where(eq(sitesTable.id, params.data.id))
    .returning();

  if (!site) {
    res.status(404).json({ error: "Site not found" });
    return;
  }

  res.json(
    UpdateSiteResponse.parse({
      ...site,
      createdAt: site.createdAt.toISOString(),
    }),
  );
});

router.delete("/sites/:id", async (req, res): Promise<void> => {
  const params = DeleteSiteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [site] = await db
    .delete(sitesTable)
    .where(eq(sitesTable.id, params.data.id))
    .returning();

  if (!site) {
    res.status(404).json({ error: "Site not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
