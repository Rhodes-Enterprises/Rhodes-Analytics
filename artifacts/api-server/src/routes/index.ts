import { Router, type IRouter } from "express";
import healthRouter from "./health";
import snowflakeRouter from "./snowflake";

const router: IRouter = Router();

router.use(healthRouter);
router.use(snowflakeRouter);

export default router;
