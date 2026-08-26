import { querySnowflake } from "../src/lib/snowflake";
async function main() {
  const q = async (label: string, sql: string, binds: any[] = []) => {
    try { console.log("=== " + label); console.log(JSON.stringify(await querySnowflake(sql, binds), null, 0).slice(0, 4000)); }
    catch (e: any) { console.log("=== " + label + " ERROR: " + e.message); }
  };
  await q("RL goal types", "SELECT GOAL_TYPE, FISCAL_YEAR, COUNT(*) N, SUM(GOAL) TOTAL FROM DM_GOALS WHERE GOAL_TYPE ILIKE 'RL%' GROUP BY 1,2 ORDER BY 2,1");
  await q("DM_LEASE cols", "SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='DM_LEASE' ORDER BY ORDINAL_POSITION");
  await q("FCT_LEASES cols", "SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='FCT_LEASES' ORDER BY ORDINAL_POSITION");
}
main();
