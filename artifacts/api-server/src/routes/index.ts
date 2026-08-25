import { Router, type IRouter } from "express";
import healthRouter from "./health";
import snowflakeRouter from "./snowflake";
import dashboardsRouter from "./dashboards";

const router: IRouter = Router();

router.use(healthRouter);
router.use(snowflakeRouter);
router.use(dashboardsRouter);

export default router;
