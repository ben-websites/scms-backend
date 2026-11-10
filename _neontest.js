const { neon } = require("@neondatabase/serverless");
require("dotenv").config();
(async () => {
  const sql = neon("postgresql://neondb_owner:npg_OwEUW5pSoC9n@ep-odd-credit-aoml6zdm-pooler.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require");
  const v = await sql`SELECT version() as version, current_database() as db`;
  console.log("OK:", v[0].version.split(",")[0], "| db:", v[0].db);
  const t = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`;
  console.log("existing tables:", t.length ? t.map(x=>x.table_name).join(", ") : "(none)");
})().catch(e => console.error("FAIL:", e.message));
