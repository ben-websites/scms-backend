const { connectDB, getPool } = require("./config/db");
const { initSchema } = require("./db/initSchema");
(async () => {
  await connectDB();
  await initSchema();
  const { rows } = await getPool().query(
    "select table_name from information_schema.tables where table_schema='public' order by 1");
  console.log("TABLES (" + rows.length + "):", rows.map(r => r.table_name).join(", "));
  const fk = await getPool().query("select count(*)::int as n from pg_constraint where contype='f'");
  const uq = await getPool().query("select count(*)::int as n from pg_indexes where indexdef ilike '%unique index%'");
  console.log("FKs:", fk.rows[0].n, " unique indexes:", uq.rows[0].n);
})().catch(e => { console.error("ERR:", e.message); process.exit(1); }).then(()=>process.exit(0));
