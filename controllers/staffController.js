const bcrypt = require("bcrypt");
const { sql, getPool } = require("../config/db");
const { notifyUser, notifyAdmins } = require("../utils/notificationService");
const { TRAINER_SLOTS, ensureFiveTrainers } = require("../utils/trainerSlots");

/* =========================================================
   ADMIN STAFF CONTROLLER
   Coach accounts, 5-trainer squads, staff attendance register,
   salary payouts and the coach -> admin approval workflow.
========================================================= */

/* ---------------------------------------------------------
   DIRECTORY + SPORT COVERAGE
--------------------------------------------------------- */
const getStaffDirectory = async (req, res) => {
  try {
    const pool = getPool();

    const coaches = await pool.request().query(`
      SELECT
        c.CoachID, c.FullName, c.Email, c.Phone, c.SportID, c.Specialization,
        c.ExperienceYears, c.MonthlySalary, c.IsActive, c.EmployeeCode, c.UserID,
        c.ImageURL, c.Rating,
        s.SportName,
        u.Email AS LoginEmail,
        u.IsActive AS LoginActive,
        CASE WHEN c.UserID IS NULL THEN 0 ELSE 1 END AS HasLogin,
        (SELECT COUNT(*) FROM Trainers t WHERE t.CoachID = c.CoachID AND t.IsActive = 1) AS TrainerCount,
        (SELECT COUNT(*) FROM SportEnrollments se WHERE se.SportID = c.SportID AND se.Status = 'Active') AS Students
      FROM Coaches c
      LEFT JOIN Sports s ON s.SportID = c.SportID
      LEFT JOIN Users u ON u.UserID = c.UserID
      ORDER BY s.SportName, c.FullName
    `);

    const coverage = await pool.request().query(`
      SELECT
        s.SportID, s.SportName, s.ImageURL, s.IsActive,
        (SELECT TOP 1 c.CoachID FROM Coaches c WHERE c.SportID = s.SportID AND c.IsActive = 1 ORDER BY c.CoachID) AS CoachID,
        (SELECT TOP 1 c.FullName FROM Coaches c WHERE c.SportID = s.SportID AND c.IsActive = 1 ORDER BY c.CoachID) AS CoachName,
        (SELECT COUNT(*) FROM Coaches c WHERE c.SportID = s.SportID AND c.IsActive = 1) AS CoachCount
      FROM Sports s
      ORDER BY s.SportName
    `);

    const trainers = await pool.request().query(`
      SELECT t.TrainerID, t.CoachID, t.SportID, t.FullName, t.Email, t.Phone,
             t.Specialization, t.MonthlySalary, t.Shift, t.IsActive,
             c.FullName AS CoachName, s.SportName
      FROM Trainers t
      LEFT JOIN Coaches c ON c.CoachID = t.CoachID
      LEFT JOIN Sports s ON s.SportID = t.SportID
      ORDER BY c.FullName, t.TrainerID
    `);

    return res.status(200).json({
      success: true,
      coaches: coaches.recordset,
      coverage: coverage.recordset,
      trainers: trainers.recordset,
      missingCoachCount: coverage.recordset.filter((s) => s.CoachCount === 0).length,
    });
  } catch (error) {
    console.error("getStaffDirectory error:", error);
    return res.status(500).json({ success: false, message: "Failed to load staff directory." });
  }
};

/* ---------------------------------------------------------
   COACH ACCOUNTS
--------------------------------------------------------- */
const provisionCoachLogin = async (req, res) => {
  try {
    const coachId = parseInt(req.params.id, 10);
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Login email and password are required." });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ success: false, message: "Password must contain at least 8 characters." });
    }

    const pool = getPool();
    const coachRes = await pool
      .request()
      .input("CoachID", sql.Int, coachId)
      .query("SELECT CoachID, FullName, SportID, UserID FROM Coaches WHERE CoachID = @CoachID");

    const coach = coachRes.recordset[0];
    if (!coach) {
      return res.status(404).json({ success: false, message: "Coach not found." });
    }
    if (coach.UserID) {
      return res.status(409).json({ success: false, message: "This coach already has a login account." });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const exists = await pool
      .request()
      .input("Email", sql.NVarChar(150), normalizedEmail)
      .query("SELECT UserID FROM Users WHERE Email = @Email");

    if (exists.recordset.length > 0) {
      return res.status(409).json({ success: false, message: "This email is already used by another account." });
    }

    const passwordHash = await bcrypt.hash(String(password), 12);

    const created = await pool
      .request()
      .input("FullName", sql.NVarChar(100), coach.FullName)
      .input("Email", sql.NVarChar(150), normalizedEmail)
      .input("PasswordHash", sql.NVarChar(255), passwordHash)
      .query(`
        INSERT INTO Users (FullName, Email, PasswordHash, Role, IsActive, CreatedAt)
        OUTPUT INSERTED.UserID
        VALUES (@FullName, @Email, @PasswordHash, 'coach', 1, SYSDATETIME())
      `);

    const userId = created.recordset[0].UserID;

    await pool
      .request()
      .input("UserID", sql.Int, userId)
      .query(`
        INSERT INTO ClubUsers (ClubID, UserID, Role, IsActive, JoinedAt)
        VALUES (current_club(), @UserID, 'coach', 1, SYSDATETIME())
        ON CONFLICT (ClubID, UserID) DO UPDATE SET Role = 'coach', IsActive = 1
      `);

    await pool
      .request()
      .input("CoachID", sql.Int, coachId)
      .input("UserID", sql.Int, userId)
      .input("Email", sql.NVarChar(150), normalizedEmail)
      .query("UPDATE Coaches SET UserID = @UserID, Email = ISNULL(Email, @Email) WHERE CoachID = @CoachID");

    await ensureFiveTrainers(pool, coachId, coach.SportID, null, null);

    return res.status(201).json({
      success: true,
      message: `Coach portal account created for ${coach.FullName}. 5 trainer slots are ready.`,
      userId,
    });
  } catch (error) {
    console.error("provisionCoachLogin error:", error);
    return res.status(500).json({ success: false, message: "Failed to create coach login." });
  }
};

const createCoachWithStaff = async (req, res) => {
  try {
    const {
      fullName, email, password, phone, sportId, specialization,
      experienceYears, monthlySalary, bio,
    } = req.body;

    if (!fullName || !email || !password || !sportId) {
      return res.status(400).json({
        success: false,
        message: "Coach name, login email, password and sport are required.",
      });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ success: false, message: "Password must contain at least 8 characters." });
    }

    const pool = getPool();

    const sportRes = await pool
      .request()
      .input("SportID", sql.Int, sportId)
      .query(`
        SELECT s.SportID, s.SportName,
               (SELECT COUNT(*) FROM Coaches c WHERE c.SportID = s.SportID AND c.IsActive = 1) AS CoachCount
        FROM Sports s WHERE s.SportID = @SportID
      `);

    const sport = sportRes.recordset[0];
    if (!sport) {
      return res.status(404).json({ success: false, message: "Sport not found." });
    }
    if (sport.CoachCount > 0) {
      return res.status(409).json({
        success: false,
        message: `${sport.SportName} already has a head coach. Every sport must have a single dedicated coach.`,
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const exists = await pool
      .request()
      .input("Email", sql.NVarChar(150), normalizedEmail)
      .query("SELECT UserID FROM Users WHERE Email = @Email");

    if (exists.recordset.length > 0) {
      return res.status(409).json({ success: false, message: "This email is already registered." });
    }

    const passwordHash = await bcrypt.hash(String(password), 12);

    const userRes = await pool
      .request()
      .input("FullName", sql.NVarChar(100), String(fullName).trim())
      .input("Email", sql.NVarChar(150), normalizedEmail)
      .input("PasswordHash", sql.NVarChar(255), passwordHash)
      .input("Phone", sql.NVarChar(30), phone || null)
      .query(`
        INSERT INTO Users (FullName, Email, PasswordHash, Role, Phone, IsActive, CreatedAt)
        OUTPUT INSERTED.UserID
        VALUES (@FullName, @Email, @PasswordHash, 'coach', @Phone, 1, SYSDATETIME())
      `);

    const userId = userRes.recordset[0].UserID;
    const salary = Number(monthlySalary) || 75000;

    const coachRes = await pool
      .request()
      .input("FullName", sql.NVarChar(100), String(fullName).trim())
      .input("Email", sql.NVarChar(150), normalizedEmail)
      .input("Phone", sql.NVarChar(30), phone || null)
      .input("SportID", sql.Int, sportId)
      .input("Specialization", sql.NVarChar(150), specialization || `Head Coach - ${sport.SportName}`)
      .input("ExperienceYears", sql.Int, parseInt(experienceYears, 10) || 5)
      .input("Bio", sql.NVarChar(1000), bio || null)
      .input("MonthlySalary", sql.Decimal(10, 2), salary)
      .input("UserID", sql.Int, userId)
      .query(`
        INSERT INTO Coaches
          (FullName, Email, Phone, SportID, Specialization, ExperienceYears, Bio,
           Rating, MonthlySalary, IsActive, CreatedAt, UserID, EmployeeCode)
        OUTPUT INSERTED.CoachID
        VALUES
          (@FullName, @Email, @Phone, @SportID, @Specialization, @ExperienceYears, @Bio,
           4.9, @MonthlySalary, 1, SYSDATETIME(), @UserID, NULL)
      `);

    const coachId = coachRes.recordset[0].CoachID;

    // A coach can only reach this club's dashboard through ClubUsers.
    await pool
      .request()
      .input("UserID", sql.Int, userId)
      .query(`
        INSERT INTO ClubUsers (ClubID, UserID, Role, IsActive, JoinedAt)
        VALUES (current_club(), @UserID, 'coach', 1, SYSDATETIME())
        ON CONFLICT (ClubID, UserID) DO UPDATE SET Role = 'coach', IsActive = 1
      `);

    await pool
      .request()
      .input("CoachID", sql.Int, coachId)
      .query(`UPDATE Coaches SET EmployeeCode = 'COACH-' || LPAD(CAST(CoachID AS VARCHAR(10)), 3, '0') WHERE CoachID = @CoachID`);

    await ensureFiveTrainers(pool, coachId, sportId, specialization || `Head Coach - ${sport.SportName}`, salary);

    await notifyAdmins({
      title: "New Coach Appointed 🏅",
      message: `${fullName} is now the head coach for ${sport.SportName} with ${TRAINER_SLOTS} trainers assigned.`,
      type: "admin",
      link: "/admin/staff",
    });

    return res.status(201).json({
      success: true,
      message: `${fullName} appointed as ${sport.SportName} head coach with ${TRAINER_SLOTS} trainers.`,
      coachId,
      userId,
    });
  } catch (error) {
    console.error("createCoachWithStaff error:", error);
    return res.status(500).json({ success: false, message: "Failed to create coach." });
  }
};

const updateStaffCoach = async (req, res) => {
  try {
    const { specialization, monthlySalary, phone, isActive } = req.body;
    const pool = getPool();

    await pool
      .request()
      .input("CoachID", sql.Int, req.params.id)
      .input("Specialization", sql.NVarChar(150), specialization || null)
      .input("MonthlySalary", sql.Decimal(10, 2), Number(monthlySalary) || null)
      .input("Phone", sql.NVarChar(30), phone || null)
      .input("IsActive", sql.Bit, isActive === undefined ? 1 : isActive ? 1 : 0)
      .query(`
        UPDATE Coaches
        SET Specialization = ISNULL(@Specialization, Specialization),
            MonthlySalary = ISNULL(@MonthlySalary, MonthlySalary),
            Phone = ISNULL(@Phone, Phone),
            IsActive = @IsActive
        WHERE CoachID = @CoachID
      `);

    return res.status(200).json({ success: true, message: "Coach profile updated." });
  } catch (error) {
    console.error("updateStaffCoach error:", error);
    return res.status(500).json({ success: false, message: "Failed to update coach." });
  }
};

/* ---------------------------------------------------------
   TRAINERS
--------------------------------------------------------- */
const createTrainer = async (req, res) => {
  try {
    const { coachId, fullName, email, phone, specialization, monthlySalary, shift } = req.body;
    if (!coachId || !fullName) {
      return res.status(400).json({ success: false, message: "Coach and trainer name are required." });
    }

    const pool = getPool();
    const coachRes = await pool
      .request()
      .input("CoachID", sql.Int, coachId)
      .query("SELECT CoachID, SportID FROM Coaches WHERE CoachID = @CoachID");

    const coach = coachRes.recordset[0];
    if (!coach) {
      return res.status(404).json({ success: false, message: "Coach not found." });
    }

    const active = await pool
      .request()
      .input("CoachID", sql.Int, coachId)
      .query("SELECT COUNT(*) AS c FROM Trainers WHERE CoachID = @CoachID AND IsActive = 1");

    if (active.recordset[0].c >= TRAINER_SLOTS) {
      return res.status(400).json({
        success: false,
        message: `A coach squad is capped at ${TRAINER_SLOTS} trainers. Deactivate one to add another.`,
      });
    }

    await pool
      .request()
      .input("CoachID", sql.Int, coachId)
      .input("SportID", sql.Int, coach.SportID)
      .input("FullName", sql.NVarChar(100), fullName)
      .input("Email", sql.NVarChar(150), email || null)
      .input("Phone", sql.NVarChar(30), phone || null)
      .input("Specialization", sql.NVarChar(150), specialization || "Assistant Coach")
      .input("MonthlySalary", sql.Decimal(10, 2), Number(monthlySalary) || 45000)
      .input("Shift", sql.NVarChar(50), shift || "Morning")
      .query(`
        INSERT INTO Trainers (CoachID, SportID, FullName, Email, Phone, Specialization, MonthlySalary, Shift, IsActive)
        VALUES (@CoachID, @SportID, @FullName, @Email, @Phone, @Specialization, @MonthlySalary, @Shift, 1)
      `);

    return res.status(201).json({ success: true, message: "Trainer added to the coach squad." });
  } catch (error) {
    console.error("createTrainer error:", error);
    return res.status(500).json({ success: false, message: "Failed to add trainer." });
  }
};

const updateTrainer = async (req, res) => {
  try {
    const { fullName, email, phone, specialization, monthlySalary, shift, isActive } = req.body;
    const pool = getPool();

    await pool
      .request()
      .input("TrainerID", sql.Int, req.params.id)
      .input("FullName", sql.NVarChar(100), fullName || null)
      .input("Email", sql.NVarChar(150), email || null)
      .input("Phone", sql.NVarChar(30), phone || null)
      .input("Specialization", sql.NVarChar(150), specialization || null)
      .input("MonthlySalary", sql.Decimal(10, 2), Number(monthlySalary) || null)
      .input("Shift", sql.NVarChar(50), shift || null)
      .input("IsActive", sql.Bit, isActive === undefined ? 1 : isActive ? 1 : 0)
      .query(`
        UPDATE Trainers
        SET FullName = ISNULL(@FullName, FullName),
            Email = ISNULL(@Email, Email),
            Phone = ISNULL(@Phone, Phone),
            Specialization = ISNULL(@Specialization, Specialization),
            MonthlySalary = ISNULL(@MonthlySalary, MonthlySalary),
            Shift = ISNULL(@Shift, Shift),
            IsActive = @IsActive
        WHERE TrainerID = @TrainerID
      `);

    return res.status(200).json({ success: true, message: "Trainer updated." });
  } catch (error) {
    console.error("updateTrainer error:", error);
    return res.status(500).json({ success: false, message: "Failed to update trainer." });
  }
};

const deleteTrainer = async (req, res) => {
  try {
    const pool = getPool();
    const used = await pool
      .request()
      .input("TrainerID", sql.Int, req.params.id)
      .query("SELECT COUNT(*) AS c FROM StaffAttendance WHERE TrainerID = @TrainerID");

    if (used.recordset[0].c > 0) {
      await pool
        .request()
        .input("TrainerID", sql.Int, req.params.id)
        .query("UPDATE Trainers SET IsActive = 0 WHERE TrainerID = @TrainerID");
      return res.status(200).json({
        success: true,
        message: "Trainer has attendance history, so the record was deactivated instead of deleted.",
      });
    }

    await pool
      .request()
      .input("TrainerID", sql.Int, req.params.id)
      .query("DELETE FROM Trainers WHERE TrainerID = @TrainerID");

    return res.status(200).json({ success: true, message: "Trainer removed." });
  } catch (error) {
    console.error("deleteTrainer error:", error);
    return res.status(500).json({ success: false, message: "Failed to delete trainer." });
  }
};

/* ---------------------------------------------------------
   STAFF ATTENDANCE (admin marks coaches + trainers)
--------------------------------------------------------- */
const getStaffAttendance = async (req, res) => {
  try {
    const now = new Date();
    const date = req.query.date || now.toISOString().slice(0, 10);
    const month = parseInt(req.query.month, 10) || now.getMonth() + 1;
    const year = parseInt(req.query.year, 10) || now.getFullYear();
    const pool = getPool();

    const coaches = await pool
      .request()
      .input("Date", sql.Date, date)
      .input("Month", sql.Int, month)
      .input("Year", sql.Int, year)
      .query(`
        SELECT
          c.CoachID, c.FullName, c.EmployeeCode, c.MonthlySalary, c.SportID,
          s.SportName,
          (SELECT TOP 1 sa.Status FROM StaffAttendance sa
             WHERE sa.StaffType = 'Coach' AND sa.CoachID = c.CoachID AND sa.AttendanceDate = @Date) AS Status,
          (SELECT TOP 1 sa.Remarks FROM StaffAttendance sa
             WHERE sa.StaffType = 'Coach' AND sa.CoachID = c.CoachID AND sa.AttendanceDate = @Date) AS Remarks,
          (SELECT COUNT(*) FROM StaffAttendance sa
             WHERE sa.StaffType = 'Coach' AND sa.CoachID = c.CoachID
               AND MONTH(sa.AttendanceDate) = @Month AND YEAR(sa.AttendanceDate) = @Year
               AND sa.Status IN ('Present','Late')) AS PresentDays,
          (SELECT COUNT(*) FROM StaffAttendance sa
             WHERE sa.StaffType = 'Coach' AND sa.CoachID = c.CoachID
               AND MONTH(sa.AttendanceDate) = @Month AND YEAR(sa.AttendanceDate) = @Year
               AND sa.Status = 'Absent') AS AbsentDays
        FROM Coaches c
        LEFT JOIN Sports s ON s.SportID = c.SportID
        WHERE c.IsActive = 1
        ORDER BY s.SportName
      `);

    const trainers = await pool
      .request()
      .input("Date", sql.Date, date)
      .input("Month", sql.Int, month)
      .input("Year", sql.Int, year)
      .query(`
        SELECT
          t.TrainerID, t.CoachID, t.FullName, t.Specialization, t.MonthlySalary, t.SportID,
          c.FullName AS CoachName, s.SportName,
          (SELECT TOP 1 sa.Status FROM StaffAttendance sa
             WHERE sa.StaffType = 'Trainer' AND sa.TrainerID = t.TrainerID AND sa.AttendanceDate = @Date) AS Status,
          (SELECT COUNT(*) FROM StaffAttendance sa
             WHERE sa.StaffType = 'Trainer' AND sa.TrainerID = t.TrainerID
               AND MONTH(sa.AttendanceDate) = @Month AND YEAR(sa.AttendanceDate) = @Year
               AND sa.Status IN ('Present','Late')) AS PresentDays,
          (SELECT COUNT(*) FROM StaffAttendance sa
             WHERE sa.StaffType = 'Trainer' AND sa.TrainerID = t.TrainerID
               AND MONTH(sa.AttendanceDate) = @Month AND YEAR(sa.AttendanceDate) = @Year
               AND sa.Status = 'Absent') AS AbsentDays
        FROM Trainers t
        LEFT JOIN Coaches c ON c.CoachID = t.CoachID
        LEFT JOIN Sports s ON s.SportID = t.SportID
        WHERE t.IsActive = 1
        ORDER BY c.FullName, t.TrainerID
      `);

    return res.status(200).json({
      success: true,
      date,
      month,
      year,
      coaches: coaches.recordset,
      trainers: trainers.recordset,
    });
  } catch (error) {
    console.error("getStaffAttendance error:", error);
    return res.status(500).json({ success: false, message: "Failed to load staff attendance." });
  }
};

const markStaffAttendance = async (req, res) => {
  try {
    const { date, records } = req.body;
    if (!date || !Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ success: false, message: "Date and attendance records are required." });
    }

    const pool = getPool();
    let saved = 0;

    for (const record of records) {
      const staffType = record.staffType === "Trainer" ? "Trainer" : "Coach";
      const coachId = parseInt(record.coachId, 10);
      const trainerId = staffType === "Trainer" ? parseInt(record.trainerId, 10) : null;
      const status = ["Present", "Absent", "Late", "Leave"].includes(record.status)
        ? record.status
        : "Present";

      if (!coachId || (staffType === "Trainer" && !trainerId)) continue;

      const request = pool
        .request()
        .input("StaffType", sql.NVarChar(10), staffType)
        .input("CoachID", sql.Int, coachId)
        .input("TrainerID", sql.Int, trainerId)
        .input("AttendanceDate", sql.Date, date)
        .input("Status", sql.NVarChar(20), status)
        .input("Remarks", sql.NVarChar(250), record.remarks || null)
        .input("MarkedBy", sql.Int, req.user.userId);

      await request.query(`
        IF EXISTS (
          SELECT 1 FROM StaffAttendance
          WHERE StaffType = @StaffType AND CoachID = @CoachID AND AttendanceDate = @AttendanceDate
            AND TrainerID IS NOT DISTINCT FROM @TrainerID
        )
        BEGIN
          UPDATE StaffAttendance
          SET Status = @Status, Remarks = @Remarks, MarkedBy = @MarkedBy
          WHERE StaffType = @StaffType AND CoachID = @CoachID AND AttendanceDate = @AttendanceDate
            AND ((@TrainerID IS NULL AND TrainerID IS NULL) OR TrainerID = @TrainerID);
        END
        ELSE
        BEGIN
          INSERT INTO StaffAttendance (StaffType, CoachID, TrainerID, AttendanceDate, Status, MarkedBy, Remarks)
          VALUES (@StaffType, @CoachID, @TrainerID, @AttendanceDate, @Status, @MarkedBy, @Remarks);
        END
      `);

      saved += 1;
    }

    return res.status(200).json({
      success: true,
      message: `Staff attendance saved for ${saved} record(s) on ${date}.`,
      saved,
    });
  } catch (error) {
    console.error("markStaffAttendance error:", error);
    return res.status(500).json({ success: false, message: "Failed to mark staff attendance." });
  }
};

/* ---------------------------------------------------------
   SALARY REGISTER
--------------------------------------------------------- */
const getSalaryRegister = async (req, res) => {
  try {
    const now = new Date();
    const month = parseInt(req.query.month, 10) || now.getMonth() + 1;
    const year = parseInt(req.query.year, 10) || now.getFullYear();
    const pool = getPool();

    const staff = await pool
      .request()
      .input("Month", sql.Int, month)
      .input("Year", sql.Int, year)
      .query(`
        SELECT
          'Coach' AS StaffType, c.CoachID, CAST(NULL AS INT) AS TrainerID,
          c.FullName, c.EmployeeCode, c.MonthlySalary AS BaseSalary,
          s.SportName, NULL AS CoachName
        FROM Coaches c
        LEFT JOIN Sports s ON s.SportID = c.SportID
        WHERE c.IsActive = 1
        UNION ALL
        SELECT
          'Trainer' AS StaffType, t.CoachID, t.TrainerID,
          t.FullName, NULL AS EmployeeCode, t.MonthlySalary AS BaseSalary,
          s.SportName, c.FullName AS CoachName
        FROM Trainers t
        LEFT JOIN Coaches c ON c.CoachID = t.CoachID
        LEFT JOIN Sports s ON s.SportID = t.SportID
        WHERE t.IsActive = 1
        ORDER BY StaffType DESC, FullName
      `);

    const payments = await pool
      .request()
      .input("Month", sql.Int, month)
      .input("Year", sql.Int, year)
      .query(`
        SELECT SalaryPaymentID, StaffType, CoachID, TrainerID, BaseSalary, Deductions,
               NetSalary, DaysPresent, DaysAbsent, Status, PaidOn, Remarks
        FROM SalaryPayments
        WHERE SalaryMonth = @Month AND SalaryYear = @Year
      `);

    const attendance = await pool
      .request()
      .input("Month", sql.Int, month)
      .input("Year", sql.Int, year)
      .query(`
        SELECT
          StaffType,
          CoachID,
          TrainerID,
          SUM(CASE WHEN Status IN ('Present','Late') THEN 1 ELSE 0 END) AS PresentDays,
          SUM(CASE WHEN Status = 'Absent' THEN 1 ELSE 0 END) AS AbsentDays,
          SUM(CASE WHEN Status = 'Leave' THEN 1 ELSE 0 END) AS LeaveDays
        FROM StaffAttendance
        WHERE MONTH(AttendanceDate) = @Month AND YEAR(AttendanceDate) = @Year
        GROUP BY StaffType, CoachID, TrainerID
      `);

    const paymentKey = (type, coachId, trainerId) => `${type}-${coachId}-${trainerId || 0}`;
    const paymentMap = new Map(
      payments.recordset.map((p) => [paymentKey(p.StaffType, p.CoachID, p.TrainerID), p])
    );
    const attendanceMap = new Map(
      attendance.recordset.map((a) => [paymentKey(a.StaffType, a.CoachID, a.TrainerID), a])
    );

    const rows = staff.recordset.map((row) => {
      const key = paymentKey(row.StaffType, row.CoachID, row.TrainerID);
      const att = attendanceMap.get(key) || { PresentDays: 0, AbsentDays: 0, LeaveDays: 0 };
      const payment = paymentMap.get(key) || null;
      const base = Number(row.BaseSalary) || 0;
      const suggestedDeduction = Math.round((base / 30) * (att.AbsentDays || 0));

      return {
        ...row,
        BaseSalary: base,
        PresentDays: att.PresentDays || 0,
        AbsentDays: att.AbsentDays || 0,
        LeaveDays: att.LeaveDays || 0,
        SuggestDeduction: suggestedDeduction,
        NetSalary: payment ? Number(payment.NetSalary) : Math.max(0, base - suggestedDeduction),
        PaymentStatus: payment ? payment.Status : "Pending",
        PaidOn: payment ? payment.PaidOn : null,
        Deductions: payment ? Number(payment.Deductions) : suggestedDeduction,
        SalaryPaymentID: payment ? payment.SalaryPaymentID : null,
        Remarks: payment ? payment.Remarks : null,
      };
    });

    return res.status(200).json({
      success: true,
      month,
      year,
      rows,
      totals: {
        payroll: rows.reduce((sum, r) => sum + r.NetSalary, 0),
        paid: rows.filter((r) => r.PaymentStatus === "Paid").length,
        pending: rows.filter((r) => r.PaymentStatus !== "Paid").length,
      },
    });
  } catch (error) {
    console.error("getSalaryRegister error:", error);
    return res.status(500).json({ success: false, message: "Failed to load salary register." });
  }
};

const paySalaries = async (req, res) => {
  try {
    const { month, year, records } = req.body;
    if (!month || !year || !Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ success: false, message: "Month, year and salary records are required." });
    }

    const pool = getPool();
    let paidCount = 0;
    let totalPaid = 0;

    for (const record of records) {
      const staffType = record.staffType === "Trainer" ? "Trainer" : "Coach";
      const coachId = parseInt(record.coachId, 10);
      const trainerId = staffType === "Trainer" ? parseInt(record.trainerId, 10) : null;
      if (!coachId || (staffType === "Trainer" && !trainerId)) continue;

      // A trainer is paid from Trainers, a coach from Coaches. Branching here
      // instead of in SQL keeps the parameter typed: a bare "@Id IS NULL" gives
      // Postgres nothing to infer the parameter type from (error 42P08).
      const salaryRes = trainerId
        ? await pool
            .request()
            .input("TrainerID", sql.Int, trainerId)
            .query("SELECT MonthlySalary AS BaseSalary FROM Trainers WHERE TrainerID = @TrainerID")
        : await pool
            .request()
            .input("CoachID", sql.Int, coachId)
            .query("SELECT MonthlySalary AS BaseSalary FROM Coaches WHERE CoachID = @CoachID");

      const base = Number(salaryRes.recordset[0]?.BaseSalary) || 0;

      const attRes = await pool
        .request()
        .input("StaffType", sql.NVarChar(10), staffType)
        .input("CoachID", sql.Int, coachId)
        .input("TrainerID", sql.Int, trainerId)
        .input("Month", sql.Int, month)
        .input("Year", sql.Int, year)
        .query(`
          SELECT
            SUM(CASE WHEN Status IN ('Present','Late') THEN 1 ELSE 0 END) AS PresentDays,
            SUM(CASE WHEN Status = 'Absent' THEN 1 ELSE 0 END) AS AbsentDays
          FROM StaffAttendance
          WHERE StaffType = @StaffType AND CoachID = @CoachID
            AND TrainerID IS NOT DISTINCT FROM @TrainerID
            AND MONTH(AttendanceDate) = @Month AND YEAR(AttendanceDate) = @Year
        `);

      const presentDays = attRes.recordset[0]?.PresentDays || 0;
      const absentDays = attRes.recordset[0]?.AbsentDays || 0;
      const deductions = record.deductions === undefined || record.deductions === null || record.deductions === ""
        ? Math.round((base / 30) * absentDays)
        : Number(record.deductions);
      const net = Math.max(0, base - deductions);

      const existing = await pool
        .request()
        .input("StaffType", sql.NVarChar(10), staffType)
        .input("CoachID", sql.Int, coachId)
        .input("TrainerID", sql.Int, trainerId)
        .input("Month", sql.Int, month)
        .input("Year", sql.Int, year)
        .query(`
          SELECT SalaryPaymentID FROM SalaryPayments
          WHERE StaffType = @StaffType AND CoachID = @CoachID
            AND TrainerID IS NOT DISTINCT FROM @TrainerID
            AND SalaryMonth = @Month AND SalaryYear = @Year
        `);

      if (existing.recordset.length > 0) {
        await pool
          .request()
          .input("SalaryPaymentID", sql.Int, existing.recordset[0].SalaryPaymentID)
          .input("BaseSalary", sql.Decimal(10, 2), base)
          .input("Deductions", sql.Decimal(10, 2), deductions)
          .input("NetSalary", sql.Decimal(10, 2), net)
          .input("DaysPresent", sql.Int, presentDays)
          .input("DaysAbsent", sql.Int, absentDays)
          .input("Remarks", sql.NVarChar(250), record.remarks || null)
          .input("PaidBy", sql.Int, req.user.userId)
          .query(`
            UPDATE SalaryPayments
            SET BaseSalary = @BaseSalary, Deductions = @Deductions, NetSalary = @NetSalary,
                DaysPresent = @DaysPresent, DaysAbsent = @DaysAbsent, Status = 'Paid',
                PaidOn = SYSDATETIME(), PaidBy = @PaidBy, Remarks = @Remarks
            WHERE SalaryPaymentID = @SalaryPaymentID
          `);
      } else {
        await pool
          .request()
          .input("StaffType", sql.NVarChar(10), staffType)
          .input("CoachID", sql.Int, coachId)
          .input("TrainerID", sql.Int, trainerId)
          .input("SalaryMonth", sql.Int, month)
          .input("SalaryYear", sql.Int, year)
          .input("BaseSalary", sql.Decimal(10, 2), base)
          .input("Deductions", sql.Decimal(10, 2), deductions)
          .input("NetSalary", sql.Decimal(10, 2), net)
          .input("DaysPresent", sql.Int, presentDays)
          .input("DaysAbsent", sql.Int, absentDays)
          .input("PaidBy", sql.Int, req.user.userId)
          .input("Remarks", sql.NVarChar(250), record.remarks || null)
          .query(`
            INSERT INTO SalaryPayments
              (StaffType, CoachID, TrainerID, SalaryMonth, SalaryYear, BaseSalary, Deductions,
               NetSalary, DaysPresent, DaysAbsent, Status, PaidOn, PaidBy, Remarks)
            VALUES
              (@StaffType, @CoachID, @TrainerID, @SalaryMonth, @SalaryYear, @BaseSalary, @Deductions,
               @NetSalary, @DaysPresent, @DaysAbsent, 'Paid', SYSDATETIME(), @PaidBy, @Remarks)
          `);
      }

      if (staffType === "Coach") {
        const coachUser = await pool
          .request()
          .input("CoachID", sql.Int, coachId)
          .query("SELECT UserID, FullName FROM Coaches WHERE CoachID = @CoachID");

        if (coachUser.recordset[0]?.UserID) {
          await notifyUser({
            userId: coachUser.recordset[0].UserID,
            title: "Salary Disbursed 💰",
            message: `Your salary for ${month}/${year} has been paid: Rs ${net.toLocaleString()} (deductions Rs ${deductions.toLocaleString()}).`,
            type: "system",
            link: "/coach/salary",
          });
        }
      }

      paidCount += 1;
      totalPaid += net;
    }

    return res.status(200).json({
      success: true,
      message: `Salary paid for ${paidCount} staff member(s). Total payout: Rs ${totalPaid.toLocaleString()}.`,
      paidCount,
      totalPaid,
    });
  } catch (error) {
    console.error("paySalaries error:", error);
    return res.status(500).json({ success: false, message: "Failed to process salary payments." });
  }
};

/* ---------------------------------------------------------
   APPROVALS (tournaments + equipment submitted by coaches)
--------------------------------------------------------- */
const getPendingApprovals = async (req, res) => {
  try {
    const pool = getPool();

    const tournaments = await pool.request().query(`
      SELECT t.TournamentID, t.TournamentName, t.Description, t.StartDate, t.EndDate, t.Venue,
             t.Status, t.ApprovalStatus, t.AdminRemarks, t.CreatedAt, t.SportID,
             s.SportName, c.FullName AS CoachName, c.CoachID
      FROM Tournaments t
      LEFT JOIN Sports s ON s.SportID = t.SportID
      LEFT JOIN Coaches c ON c.CoachID = t.CoachID
      WHERE t.ApprovalStatus = 'Pending'
      ORDER BY t.CreatedAt DESC
    `);

    const equipment = await pool.request().query(`
      SELECT e.EquipmentID, e.ItemName, e.Category, e.TotalQuantity, e.AvailableQuantity,
             e.Condition, e.StorageLocation, e.ApprovalStatus, e.AdminRemarks, e.CreatedAt,
             s.SportName, c.FullName AS CoachName, c.CoachID
      FROM Equipment e
      LEFT JOIN Sports s ON s.SportID = e.SportID
      LEFT JOIN Coaches c ON c.CoachID = e.CoachID
      WHERE e.ApprovalStatus = 'Pending'
      ORDER BY e.CreatedAt DESC
    `);

    return res.status(200).json({
      success: true,
      tournaments: tournaments.recordset,
      equipment: equipment.recordset,
    });
  } catch (error) {
    console.error("getPendingApprovals error:", error);
    return res.status(500).json({ success: false, message: "Failed to load pending approvals." });
  }
};

const reviewTournament = async (req, res) => {
  try {
    const { action, remarks } = req.body;
    const status = action === "approve" ? "Approved" : "Rejected";

    if (!["approve", "reject"].includes(action)) {
      return res.status(400).json({ success: false, message: "Action must be approve or reject." });
    }

    const pool = getPool();
    const found = await pool
      .request()
      .input("TournamentID", sql.Int, req.params.id)
      .query(`
        SELECT t.TournamentID, t.TournamentName, t.CoachID, c.UserID AS CoachUserID
        FROM Tournaments t LEFT JOIN Coaches c ON c.CoachID = t.CoachID
        WHERE t.TournamentID = @TournamentID
      `);

    const tournament = found.recordset[0];
    if (!tournament) {
      return res.status(404).json({ success: false, message: "Tournament not found." });
    }

    await pool
      .request()
      .input("TournamentID", sql.Int, req.params.id)
      .input("Status", sql.NVarChar(20), status)
      .input("ApprovedBy", sql.Int, req.user.userId)
      .input("Remarks", sql.NVarChar(300), remarks || null)
      .query(`
        UPDATE Tournaments
        SET ApprovalStatus = @Status, ApprovedBy = @ApprovedBy, ApprovedAt = SYSDATETIME(),
            AdminRemarks = @Remarks,
            Status = CASE WHEN CAST(@Status AS VARCHAR(20)) = 'Approved' THEN 'Upcoming' ELSE Status END
        WHERE TournamentID = @TournamentID
      `);

    if (tournament.CoachUserID) {
      await notifyUser({
        userId: tournament.CoachUserID,
        title: `Tournament ${status}`,
        message: `"${tournament.TournamentName}" was ${status.toLowerCase()} by the admin.${remarks ? ` Remarks: ${remarks}` : ""}`,
        type: "system",
        link: "/coach/tournaments",
      });
    }

    return res.status(200).json({ success: true, message: `Tournament ${status.toLowerCase()}.` });
  } catch (error) {
    console.error("reviewTournament error:", error);
    return res.status(500).json({ success: false, message: "Failed to review tournament." });
  }
};

const reviewEquipment = async (req, res) => {
  try {
    const { action, remarks } = req.body;
    if (!["approve", "reject"].includes(action)) {
      return res.status(400).json({ success: false, message: "Action must be approve or reject." });
    }
    const status = action === "approve" ? "Approved" : "Rejected";

    const pool = getPool();
    const found = await pool
      .request()
      .input("EquipmentID", sql.Int, req.params.id)
      .query(`
        SELECT e.EquipmentID, e.ItemName, e.CoachID, c.UserID AS CoachUserID
        FROM Equipment e LEFT JOIN Coaches c ON c.CoachID = e.CoachID
        WHERE e.EquipmentID = @EquipmentID
      `);

    const equipment = found.recordset[0];
    if (!equipment) {
      return res.status(404).json({ success: false, message: "Equipment not found." });
    }

    await pool
      .request()
      .input("EquipmentID", sql.Int, req.params.id)
      .input("Status", sql.NVarChar(20), status)
      .input("ApprovedBy", sql.Int, req.user.userId)
      .input("Remarks", sql.NVarChar(300), remarks || null)
      .query(`
        UPDATE Equipment
        SET ApprovalStatus = @Status, ApprovedBy = @ApprovedBy, ApprovedAt = SYSDATETIME(),
            AdminRemarks = @Remarks
        WHERE EquipmentID = @EquipmentID
      `);

    if (equipment.CoachUserID) {
      await notifyUser({
        userId: equipment.CoachUserID,
        title: `Equipment Request ${status}`,
        message: `"${equipment.ItemName}" was ${status.toLowerCase()} by the admin.${remarks ? ` Remarks: ${remarks}` : ""}`,
        type: "system",
        link: "/coach/equipment",
      });
    }

    return res.status(200).json({ success: true, message: `Equipment ${status.toLowerCase()}.` });
  } catch (error) {
    console.error("reviewEquipment error:", error);
    return res.status(500).json({ success: false, message: "Failed to review equipment." });
  }
};

module.exports = {
  getStaffDirectory,
  provisionCoachLogin,
  createCoachWithStaff,
  updateStaffCoach,
  createTrainer,
  updateTrainer,
  deleteTrainer,
  getStaffAttendance,
  markStaffAttendance,
  getSalaryRegister,
  paySalaries,
  getPendingApprovals,
  reviewTournament,
  reviewEquipment,
};
