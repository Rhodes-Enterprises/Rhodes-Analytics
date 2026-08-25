import { Router, type IRouter } from "express";
import healthRouter from "./health";
import sitesRouter from "./sites";
import eventsRouter from "./events";
import statsRouter from "./stats";
import overviewRouter from "./overview";

const router: IRouter = Router();

router.use(healthRouter);
router.use(sitesRouter);
router.use(eventsRouter);
router.use(statsRouter);
router.use(overviewRouter);

export default router;
