import snowflake from "snowflake-sdk";
import crypto from "node:crypto";
snowflake.configure({logLevel:"ERROR"});
const body = process.env.SNOWFLAKE_PRIVATE_KEY.replace(/\s+/g,"").match(/.{1,64}/g).join("\n");
const pem = crypto.createPrivateKey({key:`-----BEGIN ENCRYPTED PRIVATE KEY-----\n${body}\n-----END ENCRYPTED PRIVATE KEY-----`,format:"pem",passphrase:process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE}).export({type:"pkcs8",format:"pem"});
const c = snowflake.createConnection({account:process.env.SNOWFLAKE_ACCOUNT,username:process.env.SNOWFLAKE_USER,authenticator:"SNOWFLAKE_JWT",privateKey:pem,warehouse:process.env.SNOWFLAKE_WAREHOUSE,database:"PC_DBT_DB",schema:"DBT_ECORONADO",role:process.env.SNOWFLAKE_ROLE});
export const q=(sql)=>new Promise((res,rej)=>c.execute({sqlText:sql,complete:(e,_s,r)=>e?rej(e):res(r)}));
export const connect=()=>new Promise((res,rej)=>c.connect(e=>e?rej(e):res()));
