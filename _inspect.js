const sql = require("mssql/msnodesqlv8");
(async () => {
  const pool = await sql.connect({
    server: "(localdb)\\MSSQLLocalDB",
    database: "SportsClubDB",
    driver: "ODBC Driver 18 for SQL Server",
    options: { trustedConnection: true, trustServerCertificate: true, encrypt: false },
  });
  const t = await pool.request().query(`
    SELECT t.TABLE_NAME AS name,
      (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS c WHERE c.TABLE_NAME = t.TABLE_NAME) AS cols
    FROM INFORMATION_SCHEMA.TABLES t WHERE t.TABLE_TYPE='BASE TABLE' ORDER BY t.TABLE_NAME`);
  console.log("Tables:", t.recordset.length);
  for (const r of t.recordset) {
    const c = await pool.request().query(`SELECT COUNT(*) AS n FROM [${r.name}]`);
    console.log(`  ${r.name.padEnd(28)} cols=${r.cols}  rows=${c.recordset[0].n}`);
  }
  process.exit(0);
})().catch(e => { console.error("MSSQL FAIL:", e.message); process.exit(1); });
