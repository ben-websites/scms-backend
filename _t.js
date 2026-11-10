const { getPool, connectDB } = require("./config/db");
(async () => {
  await connectDB();
  const p = getPool();
  try {
    await p.query(
      `UPDATE Tournaments SET ApprovalStatus = $1, Status = CASE WHEN $1 = 'Approved' THEN 'Upcoming' ELSE Status END WHERE TournamentID = $2`,
      ["Approved", 1]
    );
    console.log("plain param: OK");
  } catch (e) { console.log("plain param FAILED:", e.message); }
  try {
    const r = await p.query(
      `UPDATE Tournaments SET ApprovalStatus = CAST($1 AS VARCHAR(20)) WHERE TournamentID = $2 RETURNING "TournamentID"`,
      ["Approved", 1]
    );
    console.log("cast param: OK, rows:", r.rowCount);
  } catch (e) { console.log("cast param FAILED:", e.message); }
})().then(()=>process.exit(0));
