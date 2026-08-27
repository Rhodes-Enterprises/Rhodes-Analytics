import app from "./app";
import { logger } from "./lib/logger";
import { warmDefaultDashboardCaches } from "./routes/dashboards";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  // Fire-and-forget: pre-populate dashboard caches for the default view so
  // the first page load doesn't pay for cold Snowflake queries.
  warmDefaultDashboardCaches(logger).catch((err) => {
    logger.error({ err }, "Dashboard cache warm-up crashed");
  });
});
