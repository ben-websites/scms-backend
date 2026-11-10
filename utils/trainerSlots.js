const { sql } = require("../config/db");

/* Shared trainer provisioning: every head coach is guaranteed 5 trainer slots. */

const TRAINER_SLOTS = 5;

const ensureFiveTrainers = async (pool, coachId, sportId, specialization, salary) => {
  const count = await pool
    .request()
    .input("CoachID", sql.Int, coachId)
    .query("SELECT COUNT(*) AS c FROM Trainers WHERE CoachID = @CoachID");

  if (count.recordset[0].c > 0) return;

  for (let slot = 1; slot <= TRAINER_SLOTS; slot += 1) {
    await pool
      .request()
      .input("CoachID", sql.Int, coachId)
      .input("SportID", sql.Int, sportId)
      .input("FullName", sql.NVarChar(100), `Assistant Trainer ${slot}`)
      .input("Specialization", sql.NVarChar(150), specialization || "Assistant Coach")
      .input("MonthlySalary", sql.Decimal(10, 2), Math.round((Number(salary) || 75000) * 0.6))
      .query(`
        INSERT INTO Trainers (CoachID, SportID, FullName, Specialization, MonthlySalary, Shift, IsActive)
        VALUES (@CoachID, @SportID, @FullName, @Specialization, @MonthlySalary, 'Morning', 1)
      `);
  }
};

const nextEmployeeCode = async (pool) => {
  const res = await pool.request().query("SELECT COUNT(*) AS c FROM Coaches WHERE EmployeeCode IS NOT NULL");
  return `COACH-${String(res.recordset[0].c + 1).padStart(3, "0")}`;
};

module.exports = { TRAINER_SLOTS, ensureFiveTrainers, nextEmployeeCode };
