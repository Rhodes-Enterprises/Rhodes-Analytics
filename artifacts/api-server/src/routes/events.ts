import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, sitesTable, eventsTable } from "@workspace/db";
import {
  CollectEventBody,
  CollectEventResponse,
  GetRecentEventsParams,
  GetRecentEventsQueryParams,
  GetRecentEventsResponse,
} from "@workspace/api-zod";
import { countryName } from "../lib/countries";

const router: IRouter = Router();

interface ParsedAgent {
  browser: string | null;
  os: string | null;
  deviceType: string | null;
}

function parseUserAgent(ua: string | null | undefined): ParsedAgent {
  if (!ua) return { browser: null, os: null, deviceType: null };

  let browser: string | null = null;
  if (/edg\//i.test(ua)) browser = "Edge";
  else if (/opr\/|opera/i.test(ua)) browser = "Opera";
  else if (/chrome|crios/i.test(ua)) browser = "Chrome";
  else if (/firefox|fxios/i.test(ua)) browser = "Firefox";
  else if (/safari/i.test(ua)) browser = "Safari";

  let os: string | null = null;
  if (/windows/i.test(ua)) os = "Windows";
  else if (/android/i.test(ua)) os = "Android";
  else if (/iphone|ipad|ios/i.test(ua)) os = "iOS";
  else if (/mac os|macintosh/i.test(ua)) os = "macOS";
  else if (/linux/i.test(ua)) os = "Linux";

  let deviceType: string | null = null;
  if (/ipad|tablet/i.test(ua)) deviceType = "Tablet";
  else if (/mobi|iphone|android/i.test(ua)) deviceType = "Mobile";
  else deviceType = "Desktop";

  return { browser, os, deviceType };
}

router.post("/collect", async (req, res): Promise<void> => {
  const parsed = CollectEventBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [site] = await db
    .select()
    .from(sitesTable)
    .where(eq(sitesTable.trackingId, parsed.data.trackingId));

  if (!site) {
    res.status(400).json({ error: "Unknown tracking ID" });
    return;
  }

  const agent = parseUserAgent(parsed.data.userAgent);

  await db.insert(eventsTable).values({
    siteId: site.id,
    path: parsed.data.path,
    referrer: parsed.data.referrer ?? null,
    visitorId: parsed.data.visitorId,
    browser: agent.browser,
    os: agent.os,
    deviceType: agent.deviceType,
    country: parsed.data.country?.toUpperCase() ?? null,
    durationSeconds: parsed.data.durationSeconds ?? null,
  });

  res.status(202).json(CollectEventResponse.parse({ accepted: true }));
});

router.get("/sites/:id/events/recent", async (req, res): Promise<void> => {
  const params = GetRecentEventsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const query = GetRecentEventsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const [site] = await db
    .select({ id: sitesTable.id })
    .from(sitesTable)
    .where(eq(sitesTable.id, params.data.id));

  if (!site) {
    res.status(404).json({ error: "Site not found" });
    return;
  }

  const events = await db
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.siteId, params.data.id))
    .orderBy(desc(eventsTable.occurredAt))
    .limit(query.data.limit);

  res.json(
    GetRecentEventsResponse.parse(
      events.map((e) => ({
        id: e.id,
        path: e.path,
        referrer: e.referrer,
        country: e.country,
        countryName: e.country ? countryName(e.country) : null,
        browser: e.browser,
        os: e.os,
        deviceType: e.deviceType,
        occurredAt: e.occurredAt.toISOString(),
      })),
    ),
  );
});

export default router;
