import { Router, type IRouter } from "express";
import { GetSnowflakeStatusResponse } from "@workspace/api-zod";
import { checkSnowflake } from "../lib/snowflake";

const router: IRouter = Router();

router.get("/snowflake/status", async (_req, res) => {
  const status = await checkSnowflake();
  const data = GetSnowflakeStatusResponse.parse(status);
  res.json(data);
});

export default router;
