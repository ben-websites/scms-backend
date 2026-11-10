const { getPool } = require("../config/db");

/* =========================================================
   STAFF / COACH MODULE BACKFILLS
   ---------------------------------------------------------
   The tables themselves live in db/schema.sql (generated from
   the original SQL Server database). This module only performs
   the idempotent data backfills:
     - coach employee codes
     - 5 auto provisioned trainers per coach
========================================================= */

const ensureStaffModules = async () => {
  const pool = getPool();

  try {
    // Employee code, e.g. COACH-001
    await pool.request().query(`
      UPDATE Coaches
      SET EmployeeCode = 'COACH-' || LPAD(CAST(CoachID AS VARCHAR(10)), 3, '0')
      WHERE EmployeeCode IS NULL
    `);

    // Every coach gets five assistant trainer slots (only when missing).
    await pool.request().query(`
      INSERT INTO Trainers (CoachID, SportID, FullName, Specialization, MonthlySalary, Shift, IsActive)
      SELECT
        c.CoachID,
        c.SportID,
        'Assistant Trainer ' || CAST(n.n AS VARCHAR(10)),
        COALESCE(c.Specialization, 'Assistant Coach'),
        CAST(COALESCE(c.MonthlySalary, 75000) * 0.6 AS DECIMAL(10,2)),
        'Morning',
        1
      FROM Coaches c
      CROSS JOIN (VALUES (1),(2),(3),(4),(5)) AS n(n)
      WHERE NOT EXISTS (SELECT 1 FROM Trainers t WHERE t.CoachID = c.CoachID)
    `);
  } catch (error) {
    console.error("Error initializing staff modules:", error.message);
  }
};

module.exports = { ensureStaffModules };
