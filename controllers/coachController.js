const { sql, getPool } = require("../config/db");
const { notifyAdmins } = require("../utils/notificationService");
const { processUploadedFile } = require("../utils/upload");

/* =========================================================
   COACH PANEL CONTROLLER
   Everything here is scoped to the sport owned by the coach
   linked to the authenticated account (Coaches.UserID).
========================================================= */

const localISO = (date = new Date()) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const resolveCoach = async (userId) => {
  const pool = getPool();
  const res = await pool
    .request()
    .input("UserID", sql.Int, userId)
    .query(`
      SELECT
        c.CoachID, c.UserID, c.SportID, c.FullName, c.Email, c.Phone,
        c.Specialization, c.ExperienceYears, c.Bio, c.ImageURL, c.Rating,
        c.MonthlySalary, c.IsActive, c.EmployeeCode, c.CreatedAt,
        s.SportName
      FROM Coaches c
      LEFT JOIN Sports s ON s.SportID = c.SportID
      WHERE c.UserID = @UserID
    `);
  return res.recordset[0] || null;
};

const noCoachProfile = (res) =>
  res.status(403).json({
    success: false,
    message: "No coach profile is linked to this account. Please contact the administrator.",
  });

/* ---------------------------------------------------------
   DASHBOARD
--------------------------------------------------------- */
const getCoachOverview = async (req, res) => {
  try {
    const coach = await resolveCoach(req.user.userId);
    if (!coach) return noCoachProfile(res);

    const pool = getPool();
    const today = localISO();

    const statsRes = await pool
      .request()
      .input("CoachID", sql.Int, coach.CoachID)
      .input("SportID", sql.Int, coach.SportID)
      .input("Today", sql.Date, today)
      .query(`
        SELECT
          (SELECT COUNT(*) FROM SportEnrollments WHERE SportID = @SportID AND Status = 'Active') AS ActiveStudents,
          (SELECT COUNT(*) FROM Attendance WHERE SportID = @SportID AND SessionDate = @Today) AS MarkedToday,
          (SELECT COUNT(*) FROM Attendance WHERE SportID = @SportID AND SessionDate = @Today AND Status = 'Present') AS PresentToday,
          (SELECT COUNT(*) FROM Tournaments WHERE CoachID = @CoachID) AS TotalTournaments,
          (SELECT COUNT(*) FROM Tournaments WHERE CoachID = @CoachID AND ApprovalStatus = 'Pending') AS PendingTournaments,
          (SELECT COUNT(*) FROM Equipment WHERE SportID = @SportID) AS EquipmentItems,
          (SELECT COUNT(*) FROM Equipment WHERE CoachID = @CoachID AND ApprovalStatus = 'Pending') AS PendingEquipment,
          (SELECT COUNT(*) FROM Trainers WHERE CoachID = @CoachID AND IsActive = 1) AS Trainers,
          (SELECT COUNT(*) FROM TrainingSchedules WHERE SportID = @SportID AND IsActive = 1) AS ActiveSchedules,
          (SELECT COUNT(*) FROM MemberPerformance WHERE SportID = @SportID) AS Evaluations
      `);

    const stats = statsRes.recordset[0];

    const upcomingRes = await pool
      .request()
      .input("CoachID", sql.Int, coach.CoachID)
      .input("SportID", sql.Int, coach.SportID)
      .query(`
        SELECT TOP 5 TournamentID, TournamentName, StartDate, EndDate, Venue, Status, ApprovalStatus
        FROM Tournaments
        WHERE CoachID = @CoachID OR SportID = @SportID
        ORDER BY StartDate DESC
      `);

    const schedulesRes = await pool
      .request()
      .input("SportID", sql.Int, coach.SportID)
      .query(`
        SELECT ScheduleID, SessionTitle, DaysOfWeek, StartTime, EndTime, Venue, SkillLevel
        FROM TrainingSchedules
        WHERE SportID = @SportID AND IsActive = 1
      `);

    const trainersRes = await pool
      .request()
      .input("CoachID", sql.Int, coach.CoachID)
      .query(`
        SELECT TrainerID, FullName, Specialization, Phone, Shift, MonthlySalary, IsActive
        FROM Trainers WHERE CoachID = @CoachID ORDER BY TrainerID
      `);

    return res.status(200).json({
      success: true,
      coach: {
        CoachID: coach.CoachID,
        FullName: coach.FullName,
        EmployeeCode: coach.EmployeeCode,
        SportName: coach.SportName,
        SportID: coach.SportID,
        Specialization: coach.Specialization,
        MonthlySalary: coach.MonthlySalary,
        ImageURL: coach.ImageURL,
      },
      stats,
      tournaments: upcomingRes.recordset,
      schedules: schedulesRes.recordset,
      trainers: trainersRes.recordset,
      today,
    });
  } catch (error) {
    console.error("getCoachOverview error:", error);
    return res.status(500).json({ success: false, message: "Failed to load coach dashboard." });
  }
};

/* ---------------------------------------------------------
   STUDENTS + ATTENDANCE
--------------------------------------------------------- */
const getCoachStudents = async (req, res) => {
  try {
    const coach = await resolveCoach(req.user.userId);
    if (!coach) return noCoachProfile(res);

    const date = req.query.date || localISO();
    const pool = getPool();

    const result = await pool
      .request()
      .input("SportID", sql.Int, coach.SportID)
      .input("Date", sql.Date, date)
      .query(`
        SELECT
          se.EnrollmentID,
          se.UserID,
          se.SkillLevel,
          se.Status AS EnrollmentStatus,
          se.EnrolledAt,
          u.FullName,
          u.Email,
          u.Phone,
          u.AvatarURL,
          a.AttendanceID,
          a.Status AS AttendanceStatus,
          a.Remarks
        FROM SportEnrollments se
        INNER JOIN Users u ON u.UserID = se.UserID
        LEFT JOIN Attendance a
          ON a.UserID = se.UserID AND a.SportID = se.SportID AND a.SessionDate = @Date
        WHERE se.SportID = @SportID
        ORDER BY u.FullName
      `);

    const summary = result.recordset.reduce(
      (acc, row) => {
        acc.total += 1;
        if (row.AttendanceStatus === "Present") acc.present += 1;
        else if (row.AttendanceStatus === "Absent") acc.absent += 1;
        else if (row.AttendanceStatus === "Late") acc.late += 1;
        else if (row.AttendanceStatus === "Leave") acc.leave += 1;
        else acc.unmarked += 1;
        return acc;
      },
      { total: 0, present: 0, absent: 0, late: 0, leave: 0, unmarked: 0 }
    );

    return res.status(200).json({
      success: true,
      date,
      sport: { SportID: coach.SportID, SportName: coach.SportName },
      students: result.recordset,
      summary,
    });
  } catch (error) {
    console.error("getCoachStudents error:", error);
    return res.status(500).json({ success: false, message: "Failed to load students." });
  }
};

const markStudentAttendance = async (req, res) => {
  try {
    const coach = await resolveCoach(req.user.userId);
    if (!coach) return noCoachProfile(res);

    const { date = localISO(), records } = req.body;
    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ success: false, message: "No attendance records were provided." });
    }

    const pool = getPool();

    // Only members enrolled in the coach's own sport can be marked.
    const enrolled = await pool
      .request()
      .input("SportID", sql.Int, coach.SportID)
      .query("SELECT UserID FROM SportEnrollments WHERE SportID = @SportID");
    const allowed = new Set(enrolled.recordset.map((r) => r.UserID));

    let saved = 0;
    let skipped = 0;

    for (const record of records) {
      const userId = parseInt(record.userId || record.UserID, 10);
      if (!allowed.has(userId)) {
        skipped += 1;
        continue;
      }

      const status = ["Present", "Absent", "Late", "Leave"].includes(record.status)
        ? record.status
        : "Present";

      await pool
        .request()
        .input("UserID", sql.Int, userId)
        .input("SportID", sql.Int, coach.SportID)
        .input("SessionDate", sql.Date, date)
        .input("Status", sql.NVarChar(20), status)
        .input("Remarks", sql.NVarChar(250), record.remarks || null)
        .input("MarkedBy", sql.Int, req.user.userId)
        .query(`
          IF EXISTS (
            SELECT 1 FROM Attendance
            WHERE UserID = @UserID AND SportID = @SportID AND SessionDate = @SessionDate
          )
          BEGIN
            UPDATE Attendance
            SET Status = @Status, Remarks = @Remarks, MarkedBy = @MarkedBy
            WHERE UserID = @UserID AND SportID = @SportID AND SessionDate = @SessionDate;
          END
          ELSE
          BEGIN
            INSERT INTO Attendance (UserID, SportID, SessionDate, Status, MarkedBy, Remarks, CreatedAt)
            VALUES (@UserID, @SportID, @SessionDate, @Status, @MarkedBy, @Remarks, SYSDATETIME());
          END
        `);

      saved += 1;
    }

    return res.status(200).json({
      success: true,
      message: `Attendance saved for ${saved} athlete(s) on ${date}.${skipped ? ` ${skipped} record(s) skipped (not enrolled).` : ""}`,
      saved,
      skipped,
    });
  } catch (error) {
    console.error("markStudentAttendance error:", error);
    return res.status(500).json({ success: false, message: "Failed to save attendance." });
  }
};

const getCoachAttendanceHistory = async (req, res) => {
  try {
    const coach = await resolveCoach(req.user.userId);
    if (!coach) return noCoachProfile(res);

    const pool = getPool();
    const result = await pool
      .request()
      .input("SportID", sql.Int, coach.SportID)
      .query(`
        SELECT
          a.SessionDate,
          SUM(CASE WHEN a.Status = 'Present' THEN 1 ELSE 0 END) AS Present,
          SUM(CASE WHEN a.Status = 'Absent' THEN 1 ELSE 0 END) AS Absent,
          SUM(CASE WHEN a.Status = 'Late' THEN 1 ELSE 0 END) AS Late,
          SUM(CASE WHEN a.Status = 'Leave' THEN 1 ELSE 0 END) AS [Leave],
          COUNT(*) AS Marked
        FROM Attendance a
        WHERE a.SportID = @SportID
        GROUP BY a.SessionDate
        ORDER BY a.SessionDate DESC
      `);

    return res.status(200).json({ success: true, history: result.recordset });
  } catch (error) {
    console.error("getCoachAttendanceHistory error:", error);
    return res.status(500).json({ success: false, message: "Failed to load attendance history." });
  }
};

/* ---------------------------------------------------------
   TRAINING SCHEDULES
--------------------------------------------------------- */
const getCoachSchedules = async (req, res) => {
  try {
    const coach = await resolveCoach(req.user.userId);
    if (!coach) return noCoachProfile(res);

    const pool = getPool();
    const result = await pool
      .request()
      .input("SportID", sql.Int, coach.SportID)
      .query(`
        SELECT ScheduleID, SessionTitle, DaysOfWeek, StartTime, EndTime, Venue, SkillLevel, MaxCapacity, IsActive
        FROM TrainingSchedules WHERE SportID = @SportID ORDER BY ScheduleID
      `);

    return res.status(200).json({ success: true, schedules: result.recordset });
  } catch (error) {
    console.error("getCoachSchedules error:", error);
    return res.status(500).json({ success: false, message: "Failed to load schedules." });
  }
};

const createCoachSchedule = async (req, res) => {
  try {
    const coach = await resolveCoach(req.user.userId);
    if (!coach) return noCoachProfile(res);

    const { sessionTitle, daysOfWeek, startTime, endTime, venue, skillLevel, maxCapacity } = req.body;
    if (!sessionTitle || !daysOfWeek || !startTime || !endTime) {
      return res.status(400).json({ success: false, message: "Session title, days, start and end time are required." });
    }

    const pool = getPool();
    const created = await pool
      .request()
      .input("SportID", sql.Int, coach.SportID)
      .input("CoachID", sql.Int, coach.CoachID)
      .input("SessionTitle", sql.NVarChar(150), sessionTitle)
      .input("DaysOfWeek", sql.NVarChar(100), daysOfWeek)
      .input("StartTime", sql.NVarChar(20), startTime)
      .input("EndTime", sql.NVarChar(20), endTime)
      .input("Venue", sql.NVarChar(200), venue || null)
      .input("SkillLevel", sql.NVarChar(50), skillLevel || "All Levels")
      .input("MaxCapacity", sql.Int, parseInt(maxCapacity, 10) || 30)
      .query(`
        INSERT INTO TrainingSchedules
          (SportID, CoachID, SessionTitle, DaysOfWeek, StartTime, EndTime, Venue, SkillLevel, MaxCapacity, IsActive, CreatedAt)
        OUTPUT INSERTED.ScheduleID
        VALUES (@SportID, @CoachID, @SessionTitle, @DaysOfWeek, @StartTime, @EndTime, @Venue, @SkillLevel, @MaxCapacity, 1, SYSDATETIME())
      `);

    return res.status(201).json({
      success: true,
      message: "Training session added to the timetable.",
      scheduleId: created.recordset[0].ScheduleID,
    });
  } catch (error) {
    console.error("createCoachSchedule error:", error);
    return res.status(500).json({ success: false, message: "Failed to create training session." });
  }
};

const deleteCoachSchedule = async (req, res) => {
  try {
    const coach = await resolveCoach(req.user.userId);
    if (!coach) return noCoachProfile(res);

    const pool = getPool();
    await pool
      .request()
      .input("ScheduleID", sql.Int, req.params.id)
      .input("SportID", sql.Int, coach.SportID)
      .query("DELETE FROM TrainingSchedules WHERE ScheduleID = @ScheduleID AND SportID = @SportID");

    return res.status(200).json({ success: true, message: "Training session removed." });
  } catch (error) {
    console.error("deleteCoachSchedule error:", error);
    return res.status(500).json({ success: false, message: "Failed to delete training session." });
  }
};

/* ---------------------------------------------------------
   TOURNAMENTS (coach creates, admin approves)
--------------------------------------------------------- */
const getCoachTournaments = async (req, res) => {
  try {
    const coach = await resolveCoach(req.user.userId);
    if (!coach) return noCoachProfile(res);

    const pool = getPool();
    const tournaments = await pool
      .request()
      .input("CoachID", sql.Int, coach.CoachID)
      .input("SportID", sql.Int, coach.SportID)
      .query(`
        SELECT
          t.TournamentID, t.TournamentName, t.SportID, t.Description, t.TournamentType,
          t.StartDate, t.EndDate, t.Venue, t.PrizePool, t.MaxTeams, t.Status, t.BannerURL,
          t.CoachID, t.ApprovalStatus, t.AdminRemarks, t.CreatedAt,
          (SELECT COUNT(*) FROM TournamentMatches m WHERE m.TournamentID = t.TournamentID) AS MatchCount,
          CASE WHEN t.CoachID = @CoachID THEN 1 ELSE 0 END AS IsMine
        FROM Tournaments t
        WHERE t.SportID = @SportID
        ORDER BY t.StartDate DESC
      `);

    const matches = await pool
      .request()
      .input("SportID", sql.Int, coach.SportID)
      .query(`
        SELECT
          m.MatchID, m.TournamentID, m.MatchTitle, m.Team1ID, m.Team2ID,
          m.Participant1Name, m.Participant2Name, m.MatchDate, m.Venue, m.Stage,
          m.ScoreTeam1, m.ScoreTeam2, m.WinnerTeamID, m.WinnerName, m.Status,
          t1.TeamName AS Team1Name,
          t2.TeamName AS Team2Name
        FROM TournamentMatches m
        LEFT JOIN Teams t1 ON t1.TeamID = m.Team1ID
        LEFT JOIN Teams t2 ON t2.TeamID = m.Team2ID
        WHERE m.SportID = @SportID
        ORDER BY m.MatchDate DESC
      `);

    const teams = await pool
      .request()
      .input("SportID", sql.Int, coach.SportID)
      .query("SELECT TeamID, TeamName FROM Teams WHERE SportID = @SportID ORDER BY TeamName");

    return res.status(200).json({
      success: true,
      tournaments: tournaments.recordset,
      matches: matches.recordset,
      teams: teams.recordset,
    });
  } catch (error) {
    console.error("getCoachTournaments error:", error);
    return res.status(500).json({ success: false, message: "Failed to load tournaments." });
  }
};

const createCoachTournament = async (req, res) => {
  try {
    const coach = await resolveCoach(req.user.userId);
    if (!coach) return noCoachProfile(res);

    const {
      tournamentName, description, tournamentType, startDate, endDate,
      venue, prizePool, maxTeams,
    } = req.body;

    if (!tournamentName || !startDate) {
      return res.status(400).json({ success: false, message: "Tournament name and start date are required." });
    }

    const pool = getPool();
    const created = await pool
      .request()
      .input("TournamentName", sql.NVarChar(150), tournamentName)
      .input("SportID", sql.Int, coach.SportID)
      .input("Description", sql.NVarChar(1000), description || null)
      .input("TournamentType", sql.NVarChar(50), tournamentType || "Knockout")
      .input("StartDate", sql.DateTime2, startDate)
      .input("EndDate", sql.DateTime2, endDate || null)
      .input("Venue", sql.NVarChar(200), venue || null)
      .input("PrizePool", sql.NVarChar(100), prizePool || null)
      .input("MaxTeams", sql.Int, parseInt(maxTeams, 10) || 16)
      .input("CoachID", sql.Int, coach.CoachID)
      .query(`
        INSERT INTO Tournaments
          (TournamentName, SportID, Description, TournamentType, StartDate, EndDate,
           Venue, PrizePool, MaxTeams, Status, CreatedAt, CoachID, ApprovalStatus, CreatedByRole)
        OUTPUT INSERTED.TournamentID
        VALUES
          (@TournamentName, @SportID, @Description, @TournamentType, @StartDate, @EndDate,
           @Venue, @PrizePool, @MaxTeams, 'Upcoming', SYSDATETIME(), @CoachID, 'Pending', 'coach')
      `);

    await notifyAdmins({
      title: "Tournament Awaiting Approval 🏆",
      message: `${coach.FullName} (${coach.SportName}) submitted "${tournamentName}" for approval.`,
      type: "admin",
      link: "/admin/approvals",
    });

    return res.status(201).json({
      success: true,
      message: "Tournament submitted to the admin for approval.",
      tournamentId: created.recordset[0].TournamentID,
    });
  } catch (error) {
    console.error("createCoachTournament error:", error);
    return res.status(500).json({ success: false, message: "Failed to create tournament." });
  }
};

const assertOwnTournament = async (pool, tournamentId, coachId) => {
  const res = await pool
    .request()
    .input("TournamentID", sql.Int, tournamentId)
    .query("SELECT TournamentID, CoachID, ApprovalStatus FROM Tournaments WHERE TournamentID = @TournamentID");
  const row = res.recordset[0];
  if (!row) return { error: "notfound" };
  if (row.CoachID !== coachId) return { error: "forbidden" };
  return { row };
};

const updateCoachTournament = async (req, res) => {
  try {
    const coach = await resolveCoach(req.user.userId);
    if (!coach) return noCoachProfile(res);

    const pool = getPool();
    const check = await assertOwnTournament(pool, req.params.id, coach.CoachID);
    if (check.error === "notfound") {
      return res.status(404).json({ success: false, message: "Tournament not found." });
    }
    if (check.error === "forbidden") {
      return res.status(403).json({ success: false, message: "You can only edit tournaments you created." });
    }
    if (check.row.ApprovalStatus === "Approved") {
      return res.status(403).json({
        success: false,
        message: "This tournament is already approved and locked. Contact the admin for changes.",
      });
    }

    const {
      tournamentName, description, tournamentType, startDate, endDate,
      venue, prizePool, maxTeams, status,
    } = req.body;

    await pool
      .request()
      .input("TournamentID", sql.Int, req.params.id)
      .input("TournamentName", sql.NVarChar(150), tournamentName || null)
      .input("Description", sql.NVarChar(1000), description || null)
      .input("TournamentType", sql.NVarChar(50), tournamentType || "Knockout")
      .input("StartDate", sql.DateTime2, startDate || null)
      .input("EndDate", sql.DateTime2, endDate || null)
      .input("Venue", sql.NVarChar(200), venue || null)
      .input("PrizePool", sql.NVarChar(100), prizePool || null)
      .input("MaxTeams", sql.Int, parseInt(maxTeams, 10) || 16)
      .input("Status", sql.NVarChar(20), status || "Upcoming")
      .query(`
        UPDATE Tournaments
        SET TournamentName = ISNULL(@TournamentName, TournamentName),
            Description = @Description,
            TournamentType = @TournamentType,
            StartDate = ISNULL(@StartDate, StartDate),
            EndDate = @EndDate,
            Venue = @Venue,
            PrizePool = @PrizePool,
            MaxTeams = @MaxTeams,
            Status = @Status,
            ApprovalStatus = 'Pending'
        WHERE TournamentID = @TournamentID
      `);

    return res.status(200).json({
      success: true,
      message: "Tournament updated and sent back to the admin for approval.",
    });
  } catch (error) {
    console.error("updateCoachTournament error:", error);
    return res.status(500).json({ success: false, message: "Failed to update tournament." });
  }
};

const deleteCoachTournament = async (req, res) => {
  try {
    const coach = await resolveCoach(req.user.userId);
    if (!coach) return noCoachProfile(res);

    const pool = getPool();
    const check = await assertOwnTournament(pool, req.params.id, coach.CoachID);
    if (check.error === "notfound") {
      return res.status(404).json({ success: false, message: "Tournament not found." });
    }
    if (check.error === "forbidden") {
      return res.status(403).json({ success: false, message: "You can only delete tournaments you created." });
    }
    if (check.row.ApprovalStatus === "Approved") {
      return res.status(403).json({
        success: false,
        message: "Approved tournaments cannot be deleted by a coach.",
      });
    }

    await pool
      .request()
      .input("TournamentID", sql.Int, req.params.id)
      .query(`
        DELETE FROM TournamentMatches WHERE TournamentID = @TournamentID;
        DELETE FROM Tournaments WHERE TournamentID = @TournamentID;
      `);

    return res.status(200).json({ success: true, message: "Tournament deleted." });
  } catch (error) {
    console.error("deleteCoachTournament error:", error);
    return res.status(500).json({ success: false, message: "Failed to delete tournament." });
  }
};

/* ---------------------------------------------------------
   MATCHES (with full detail management)
--------------------------------------------------------- */
const createCoachMatch = async (req, res) => {
  try {
    const coach = await resolveCoach(req.user.userId);
    if (!coach) return noCoachProfile(res);

    const {
      tournamentId, matchTitle, team1Id, team2Id, participant1Name, participant2Name,
      matchDate, venue, stage, status,
    } = req.body;

    if (!matchTitle || !matchDate) {
      return res.status(400).json({ success: false, message: "Match title and date/time are required." });
    }

    const pool = getPool();
    const created = await pool
      .request()
      .input("TournamentID", sql.Int, tournamentId ? parseInt(tournamentId, 10) : null)
      .input("SportID", sql.Int, coach.SportID)
      .input("MatchTitle", sql.NVarChar(150), matchTitle)
      .input("Team1ID", sql.Int, team1Id ? parseInt(team1Id, 10) : null)
      .input("Team2ID", sql.Int, team2Id ? parseInt(team2Id, 10) : null)
      .input("Participant1Name", sql.NVarChar(100), participant1Name || null)
      .input("Participant2Name", sql.NVarChar(100), participant2Name || null)
      .input("MatchDate", sql.DateTime2, matchDate)
      .input("Venue", sql.NVarChar(200), venue || null)
      .input("Stage", sql.NVarChar(50), stage || "Group Stage")
      .input("Status", sql.NVarChar(20), status || "Scheduled")
      .query(`
        INSERT INTO TournamentMatches
          (TournamentID, SportID, MatchTitle, Team1ID, Team2ID, Participant1Name, Participant2Name,
           MatchDate, Venue, Stage, Status, CreatedAt)
        OUTPUT INSERTED.MatchID
        VALUES
          (@TournamentID, @SportID, @MatchTitle, @Team1ID, @Team2ID, @Participant1Name, @Participant2Name,
           @MatchDate, @Venue, @Stage, @Status, SYSDATETIME())
      `);

    return res.status(201).json({
      success: true,
      message: "Match fixture added.",
      matchId: created.recordset[0].MatchID,
    });
  } catch (error) {
    console.error("createCoachMatch error:", error);
    return res.status(500).json({ success: false, message: "Failed to create match." });
  }
};

const updateCoachMatch = async (req, res) => {
  try {
    const coach = await resolveCoach(req.user.userId);
    if (!coach) return noCoachProfile(res);

    const {
      matchTitle, team1Id, team2Id, participant1Name, participant2Name,
      matchDate, venue, stage, scoreTeam1, scoreTeam2, winnerTeamId, winnerName, status,
    } = req.body;

    const pool = getPool();
    const existing = await pool
      .request()
      .input("MatchID", sql.Int, req.params.matchId)
      .query("SELECT MatchID, SportID FROM TournamentMatches WHERE MatchID = @MatchID");

    if (existing.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Match not found." });
    }
    if (existing.recordset[0].SportID !== coach.SportID) {
      return res.status(403).json({ success: false, message: "You can only manage matches of your sport." });
    }

    await pool
      .request()
      .input("MatchID", sql.Int, req.params.matchId)
      .input("MatchTitle", sql.NVarChar(150), matchTitle || null)
      .input("Team1ID", sql.Int, team1Id ? parseInt(team1Id, 10) : null)
      .input("Team2ID", sql.Int, team2Id ? parseInt(team2Id, 10) : null)
      .input("Participant1Name", sql.NVarChar(100), participant1Name || null)
      .input("Participant2Name", sql.NVarChar(100), participant2Name || null)
      .input("MatchDate", sql.DateTime2, matchDate || null)
      .input("Venue", sql.NVarChar(200), venue || null)
      .input("Stage", sql.NVarChar(50), stage || "Group Stage")
      .input("ScoreTeam1", sql.NVarChar(50), scoreTeam1 || null)
      .input("ScoreTeam2", sql.NVarChar(50), scoreTeam2 || null)
      .input("WinnerTeamID", sql.Int, winnerTeamId ? parseInt(winnerTeamId, 10) : null)
      .input("WinnerName", sql.NVarChar(100), winnerName || null)
      .input("Status", sql.NVarChar(20), status || "Scheduled")
      .query(`
        UPDATE TournamentMatches
        SET MatchTitle = ISNULL(@MatchTitle, MatchTitle),
            Team1ID = @Team1ID,
            Team2ID = @Team2ID,
            Participant1Name = @Participant1Name,
            Participant2Name = @Participant2Name,
            MatchDate = ISNULL(@MatchDate, MatchDate),
            Venue = @Venue,
            Stage = @Stage,
            ScoreTeam1 = @ScoreTeam1,
            ScoreTeam2 = @ScoreTeam2,
            WinnerTeamID = @WinnerTeamID,
            WinnerName = @WinnerName,
            Status = @Status
        WHERE MatchID = @MatchID
      `);

    return res.status(200).json({ success: true, message: "Match updated." });
  } catch (error) {
    console.error("updateCoachMatch error:", error);
    return res.status(500).json({ success: false, message: "Failed to update match." });
  }
};

const deleteCoachMatch = async (req, res) => {
  try {
    const coach = await resolveCoach(req.user.userId);
    if (!coach) return noCoachProfile(res);

    const pool = getPool();
    await pool
      .request()
      .input("MatchID", sql.Int, req.params.matchId)
      .input("SportID", sql.Int, coach.SportID)
      .query("DELETE FROM TournamentMatches WHERE MatchID = @MatchID AND SportID = @SportID");

    return res.status(200).json({ success: true, message: "Match removed." });
  } catch (error) {
    console.error("deleteCoachMatch error:", error);
    return res.status(500).json({ success: false, message: "Failed to delete match." });
  }
};

/* ---------------------------------------------------------
   EQUIPMENT / GEAR (coach manages, admin approves)
--------------------------------------------------------- */
const getCoachEquipment = async (req, res) => {
  try {
    const coach = await resolveCoach(req.user.userId);
    if (!coach) return noCoachProfile(res);

    const pool = getPool();
    const result = await pool
      .request()
      .input("SportID", sql.Int, coach.SportID)
      .query(`
        SELECT
          e.EquipmentID, e.ItemName, e.Category, e.TotalQuantity, e.AvailableQuantity,
          e.Condition, e.StorageLocation, e.CoachID, e.ApprovalStatus, e.AdminRemarks, e.CreatedAt,
          (SELECT COUNT(*) FROM EquipmentIssues i WHERE i.EquipmentID = e.EquipmentID AND i.ReturnDate IS NULL) AS OpenIssues
        FROM Equipment e
        WHERE e.SportID = @SportID
        ORDER BY e.ItemName
      `);

    return res.status(200).json({ success: true, equipment: result.recordset });
  } catch (error) {
    console.error("getCoachEquipment error:", error);
    return res.status(500).json({ success: false, message: "Failed to load equipment." });
  }
};

const createCoachEquipment = async (req, res) => {
  try {
    const coach = await resolveCoach(req.user.userId);
    if (!coach) return noCoachProfile(res);

    const { itemName, category, totalQuantity, condition, storageLocation } = req.body;
    if (!itemName) {
      return res.status(400).json({ success: false, message: "Equipment name is required." });
    }

    const quantity = parseInt(totalQuantity, 10) || 1;
    const pool = getPool();

    const created = await pool
      .request()
      .input("SportID", sql.Int, coach.SportID)
      .input("ItemName", sql.NVarChar(150), itemName)
      .input("Category", sql.NVarChar(100), category || "General")
      .input("TotalQuantity", sql.Int, quantity)
      .input("Condition", sql.NVarChar(50), condition || "Good")
      .input("StorageLocation", sql.NVarChar(150), storageLocation || null)
      .input("CoachID", sql.Int, coach.CoachID)
      .query(`
        INSERT INTO Equipment
          (SportID, ItemName, Category, TotalQuantity, AvailableQuantity, Condition, StorageLocation,
           CreatedAt, CoachID, ApprovalStatus, RequestedByRole)
        OUTPUT INSERTED.EquipmentID
        VALUES
          (@SportID, @ItemName, @Category, @TotalQuantity, @TotalQuantity, @Condition, @StorageLocation,
           SYSDATETIME(), @CoachID, 'Pending', 'coach')
      `);

    await notifyAdmins({
      title: "New Gear Request 📦",
      message: `${coach.FullName} (${coach.SportName}) added "${itemName}" (x${quantity}) to the equipment register.`,
      type: "admin",
      link: "/admin/approvals",
    });

    return res.status(201).json({
      success: true,
      message: "Equipment submitted for admin approval.",
      equipmentId: created.recordset[0]?.EquipmentID,
    });
  } catch (error) {
    console.error("createCoachEquipment error:", error);
    return res.status(500).json({ success: false, message: "Failed to add equipment." });
  }
};

const updateCoachEquipment = async (req, res) => {
  try {
    const coach = await resolveCoach(req.user.userId);
    if (!coach) return noCoachProfile(res);

    const { itemName, category, totalQuantity, condition, storageLocation } = req.body;
    const pool = getPool();

    const result = await pool
      .request()
      .input("EquipmentID", sql.Int, req.params.id)
      .input("SportID", sql.Int, coach.SportID)
      .input("ItemName", sql.NVarChar(150), itemName || null)
      .input("Category", sql.NVarChar(100), category || "General")
      .input("TotalQuantity", sql.Int, parseInt(totalQuantity, 10) || 1)
      .input("Condition", sql.NVarChar(50), condition || "Good")
      .input("StorageLocation", sql.NVarChar(150), storageLocation || null)
      .query(`
        UPDATE Equipment
        SET ItemName = ISNULL(@ItemName, ItemName),
            Category = @Category,
            TotalQuantity = @TotalQuantity,
            AvailableQuantity = CASE WHEN @TotalQuantity > AvailableQuantity THEN @TotalQuantity ELSE AvailableQuantity END,
            Condition = @Condition,
            StorageLocation = @StorageLocation,
            ApprovalStatus = 'Pending'
        WHERE EquipmentID = @EquipmentID AND SportID = @SportID
      `);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ success: false, message: "Equipment not found for your sport." });
    }

    return res.status(200).json({ success: true, message: "Equipment updated and re-submitted for approval." });
  } catch (error) {
    console.error("updateCoachEquipment error:", error);
    return res.status(500).json({ success: false, message: "Failed to update equipment." });
  }
};

const deleteCoachEquipment = async (req, res) => {
  try {
    const coach = await resolveCoach(req.user.userId);
    if (!coach) return noCoachProfile(res);

    const pool = getPool();
    const open = await pool
      .request()
      .input("EquipmentID", sql.Int, req.params.id)
      .query("SELECT COUNT(*) AS c FROM EquipmentIssues WHERE EquipmentID = @EquipmentID AND ReturnDate IS NULL");

    if (open.recordset[0].c > 0) {
      return res.status(400).json({
        success: false,
        message: "Cannot delete equipment that still has items issued to members.",
      });
    }

    await pool
      .request()
      .input("EquipmentID", sql.Int, req.params.id)
      .input("SportID", sql.Int, coach.SportID)
      .query(`
        DELETE FROM EquipmentIssues WHERE EquipmentID = @EquipmentID;
        DELETE FROM Equipment WHERE EquipmentID = @EquipmentID AND SportID = @SportID;
      `);

    return res.status(200).json({ success: true, message: "Equipment removed." });
  } catch (error) {
    console.error("deleteCoachEquipment error:", error);
    return res.status(500).json({ success: false, message: "Failed to delete equipment." });
  }
};

const issueCoachEquipment = async (req, res) => {
  try {
    const coach = await resolveCoach(req.user.userId);
    if (!coach) return noCoachProfile(res);

    const { equipmentId, userId, quantity, expectedReturnDate, remarks } = req.body;
    const qty = parseInt(quantity, 10) || 1;

    if (!equipmentId || !userId) {
      return res.status(400).json({ success: false, message: "Equipment and member are required." });
    }

    const pool = getPool();
    const itemRes = await pool
      .request()
      .input("EquipmentID", sql.Int, equipmentId)
      .input("SportID", sql.Int, coach.SportID)
      .query("SELECT EquipmentID, AvailableQuantity, ApprovalStatus FROM Equipment WHERE EquipmentID = @EquipmentID AND SportID = @SportID");

    const item = itemRes.recordset[0];
    if (!item) {
      return res.status(404).json({ success: false, message: "Equipment not found for your sport." });
    }
    if (item.ApprovalStatus !== "Approved") {
      return res.status(400).json({ success: false, message: "Only approved equipment can be issued." });
    }
    if (item.AvailableQuantity < qty) {
      return res.status(400).json({ success: false, message: "Not enough units available." });
    }

    await pool
      .request()
      .input("EquipmentID", sql.Int, equipmentId)
      .input("UserID", sql.Int, userId)
      .input("QuantityIssued", sql.Int, qty)
      .input("ExpectedReturnDate", sql.DateTime2, expectedReturnDate || null)
      .input("Remarks", sql.NVarChar(250), remarks || null)
      .query(`
        INSERT INTO EquipmentIssues (EquipmentID, UserID, QuantityIssued, IssuedDate, ExpectedReturnDate, Status, Remarks)
        VALUES (@EquipmentID, @UserID, @QuantityIssued, SYSDATETIME(), @ExpectedReturnDate, 'Issued', @Remarks);

        UPDATE Equipment SET AvailableQuantity = AvailableQuantity - @QuantityIssued WHERE EquipmentID = @EquipmentID;
      `);

    return res.status(201).json({ success: true, message: "Equipment issued to member." });
  } catch (error) {
    console.error("issueCoachEquipment error:", error);
    return res.status(500).json({ success: false, message: "Failed to issue equipment." });
  }
};

const returnCoachEquipment = async (req, res) => {
  try {
    const coach = await resolveCoach(req.user.userId);
    if (!coach) return noCoachProfile(res);

    const pool = getPool();
    const issueRes = await pool
      .request()
      .input("IssueID", sql.Int, req.params.issueId)
      .query(`
        SELECT i.IssueID, i.EquipmentID, i.QuantityIssued, e.SportID
        FROM EquipmentIssues i
        INNER JOIN Equipment e ON e.EquipmentID = i.EquipmentID
        WHERE i.IssueID = @IssueID
      `);

    const issue = issueRes.recordset[0];
    if (!issue || issue.SportID !== coach.SportID) {
      return res.status(404).json({ success: false, message: "Issue record not found for your sport." });
    }

    await pool
      .request()
      .input("IssueID", sql.Int, req.params.issueId)
      .input("EquipmentID", sql.Int, issue.EquipmentID)
      .input("Quantity", sql.Int, issue.QuantityIssued)
      .query(`
        UPDATE EquipmentIssues SET ReturnDate = SYSDATETIME(), Status = 'Returned' WHERE IssueID = @IssueID;
        UPDATE Equipment SET AvailableQuantity = AvailableQuantity + @Quantity WHERE EquipmentID = @EquipmentID;
      `);

    return res.status(200).json({ success: true, message: "Equipment returned to the store." });
  } catch (error) {
    console.error("returnCoachEquipment error:", error);
    return res.status(500).json({ success: false, message: "Failed to return equipment." });
  }
};

const getCoachEquipmentIssues = async (req, res) => {
  try {
    const coach = await resolveCoach(req.user.userId);
    if (!coach) return noCoachProfile(res);

    const pool = getPool();
    const result = await pool
      .request()
      .input("SportID", sql.Int, coach.SportID)
      .query(`
        SELECT i.IssueID, i.QuantityIssued, i.IssuedDate, i.ExpectedReturnDate, i.ReturnDate, i.Status,
               e.ItemName, u.FullName AS MemberName
        FROM EquipmentIssues i
        INNER JOIN Equipment e ON e.EquipmentID = i.EquipmentID
        INNER JOIN Users u ON u.UserID = i.UserID
        WHERE e.SportID = @SportID
        ORDER BY i.IssuedDate DESC
      `);

    return res.status(200).json({ success: true, issues: result.recordset });
  } catch (error) {
    console.error("getCoachEquipmentIssues error:", error);
    return res.status(500).json({ success: false, message: "Failed to load equipment issues." });
  }
};

/* ---------------------------------------------------------
   TRAINERS + SALARY (read only for the coach)
--------------------------------------------------------- */
const getCoachTrainers = async (req, res) => {
  try {
    const coach = await resolveCoach(req.user.userId);
    if (!coach) return noCoachProfile(res);

    const now = new Date();
    const pool = getPool();
    const result = await pool
      .request()
      .input("CoachID", sql.Int, coach.CoachID)
      .input("Month", sql.Int, now.getMonth() + 1)
      .input("Year", sql.Int, now.getFullYear())
      .query(`
        SELECT
          t.TrainerID, t.FullName, t.Email, t.Phone, t.Specialization, t.MonthlySalary,
          t.Shift, t.IsActive, t.CreatedAt,
          (SELECT COUNT(*) FROM StaffAttendance sa
             WHERE sa.TrainerID = t.TrainerID AND MONTH(sa.AttendanceDate) = @Month
               AND YEAR(sa.AttendanceDate) = @Year AND sa.Status IN ('Present','Late')) AS PresentDays,
          (SELECT COUNT(*) FROM StaffAttendance sa
             WHERE sa.TrainerID = t.TrainerID AND MONTH(sa.AttendanceDate) = @Month
               AND YEAR(sa.AttendanceDate) = @Year AND sa.Status = 'Absent') AS AbsentDays
        FROM Trainers t
        WHERE t.CoachID = @CoachID
        ORDER BY t.TrainerID
      `);

    return res.status(200).json({ success: true, trainers: result.recordset });
  } catch (error) {
    console.error("getCoachTrainers error:", error);
    return res.status(500).json({ success: false, message: "Failed to load trainers." });
  }
};

const getCoachSalary = async (req, res) => {
  try {
    const coach = await resolveCoach(req.user.userId);
    if (!coach) return noCoachProfile(res);

    const now = new Date();
    const month = parseInt(req.query.month, 10) || now.getMonth() + 1;
    const year = parseInt(req.query.year, 10) || now.getFullYear();
    const pool = getPool();

    const payments = await pool
      .request()
      .input("CoachID", sql.Int, coach.CoachID)
      .query(`
        SELECT
          s.SalaryPaymentID, s.StaffType, s.TrainerID, s.SalaryMonth, s.SalaryYear,
          s.BaseSalary, s.Deductions, s.NetSalary, s.DaysPresent, s.DaysAbsent,
          s.Status, s.PaidOn, s.Remarks, t.FullName AS TrainerName
        FROM SalaryPayments s
        LEFT JOIN Trainers t ON t.TrainerID = s.TrainerID
        WHERE s.CoachID = @CoachID
        ORDER BY s.SalaryYear DESC, s.SalaryMonth DESC
      `);

    const attendance = await pool
      .request()
      .input("CoachID", sql.Int, coach.CoachID)
      .input("Month", sql.Int, month)
      .input("Year", sql.Int, year)
      .query(`
        SELECT
          SUM(CASE WHEN Status IN ('Present','Late') THEN 1 ELSE 0 END) AS PresentDays,
          SUM(CASE WHEN Status = 'Absent' THEN 1 ELSE 0 END) AS AbsentDays,
          SUM(CASE WHEN Status = 'Leave' THEN 1 ELSE 0 END) AS LeaveDays
        FROM StaffAttendance
        WHERE StaffType = 'Coach' AND CoachID = @CoachID
          AND MONTH(AttendanceDate) = @Month AND YEAR(AttendanceDate) = @Year
      `);

    return res.status(200).json({
      success: true,
      month,
      year,
      monthlySalary: coach.MonthlySalary,
      payments: payments.recordset,
      attendance: attendance.recordset[0] || { PresentDays: 0, AbsentDays: 0, LeaveDays: 0 },
    });
  } catch (error) {
    console.error("getCoachSalary error:", error);
    return res.status(500).json({ success: false, message: "Failed to load salary ledger." });
  }
};

/* ---------------------------------------------------------
   OWN PROFILE
--------------------------------------------------------- */
const getCoachProfile = async (req, res) => {
  try {
    const coach = await resolveCoach(req.user.userId);
    if (!coach) return noCoachProfile(res);

    const pool = getPool();
    const now = new Date();

    const accountRes = await pool
      .request()
      .input("UserID", sql.Int, req.user.userId)
      .query(`SELECT Email, Phone, AvatarURL, Role, CreatedAt FROM Users WHERE UserID = @UserID`);

    const statsRes = await pool
      .request()
      .input("CoachID", sql.Int, coach.CoachID)
      .input("SportID", sql.Int, coach.SportID)
      .input("Month", sql.Int, now.getMonth() + 1)
      .input("Year", sql.Int, now.getFullYear())
      .query(`
        SELECT
          (SELECT COUNT(*) FROM SportEnrollments WHERE SportID = @SportID AND Status = 'Active') AS Students,
          (SELECT COUNT(*) FROM Trainers WHERE CoachID = @CoachID AND IsActive = 1) AS Trainers,
          (SELECT COUNT(*) FROM TrainingSchedules WHERE SportID = @SportID AND IsActive = 1) AS Schedules,
          (SELECT COUNT(*) FROM Tournaments WHERE CoachID = @CoachID) AS Tournaments,
          (SELECT COUNT(*) FROM Equipment WHERE CoachID = @CoachID) AS Equipment,
          (SELECT COUNT(*) FROM MemberPerformance WHERE SportID = @SportID) AS Evaluations,
          (SELECT COUNT(*) FROM StaffAttendance
             WHERE StaffType = 'Coach' AND CoachID = @CoachID
               AND MONTH(AttendanceDate) = @Month AND YEAR(AttendanceDate) = @Year
               AND Status IN ('Present', 'Late')) AS PresentDays,
          (SELECT COUNT(*) FROM StaffAttendance
             WHERE StaffType = 'Coach' AND CoachID = @CoachID
               AND MONTH(AttendanceDate) = @Month AND YEAR(AttendanceDate) = @Year
               AND Status = 'Absent') AS AbsentDays
      `);

    const trainersRes = await pool
      .request()
      .input("CoachID", sql.Int, coach.CoachID)
      .query(`
        SELECT TOP 5 TrainerID, FullName, Specialization, Phone, Shift, IsActive
        FROM Trainers WHERE CoachID = @CoachID ORDER BY TrainerID
      `);

    const tournamentsRes = await pool
      .request()
      .input("CoachID", sql.Int, coach.CoachID)
      .query(`
        SELECT TOP 4 TournamentID, TournamentName, StartDate, EndDate, Venue, Status, ApprovalStatus
        FROM Tournaments WHERE CoachID = @CoachID ORDER BY StartDate DESC
      `);

    const salaryRes = await pool
      .request()
      .input("CoachID", sql.Int, coach.CoachID)
      .query(`
        SELECT TOP 4 SalaryPaymentID, SalaryMonth, SalaryYear, NetSalary, Status, PaidOn
        FROM SalaryPayments
        WHERE StaffType = 'Coach' AND CoachID = @CoachID
        ORDER BY SalaryYear DESC, SalaryMonth DESC
      `);

    return res.status(200).json({
      success: true,
      coach: {
        CoachID: coach.CoachID,
        EmployeeCode: coach.EmployeeCode,
        FullName: coach.FullName,
        Email: coach.Email,
        Phone: coach.Phone,
        SportID: coach.SportID,
        SportName: coach.SportName,
        Specialization: coach.Specialization,
        ExperienceYears: coach.ExperienceYears,
        Bio: coach.Bio,
        ImageURL: coach.ImageURL,
        Rating: coach.Rating,
        MonthlySalary: coach.MonthlySalary,
        IsActive: coach.IsActive,
        JoinedAt: coach.CreatedAt,
      },
      account: accountRes.recordset[0] || null,
      stats: statsRes.recordset[0] || {},
      trainers: trainersRes.recordset,
      tournaments: tournamentsRes.recordset,
      salary: salaryRes.recordset,
    });
  } catch (error) {
    console.error("getCoachProfile error:", error);
    return res.status(500).json({ success: false, message: "Failed to load your profile." });
  }
};

const updateCoachProfile = async (req, res) => {
  try {
    const coach = await resolveCoach(req.user.userId);
    if (!coach) return noCoachProfile(res);

    const phone = req.body.phone === undefined ? coach.Phone : String(req.body.phone || "").trim();
    const bio = req.body.bio === undefined ? coach.Bio : String(req.body.bio || "").trim();
    const rawImage = req.body.imageUrl === undefined ? null : String(req.body.imageUrl || "").trim();

    if (phone.length > 50) {
      return res.status(400).json({ success: false, message: "Phone number is too long (max 50 characters)." });
    }
    if (bio.length > 1000) {
      return res.status(400).json({ success: false, message: "Bio is too long (max 1000 characters)." });
    }
    if (rawImage && !/^(https?:\/\/|\/)/i.test(rawImage)) {
      return res.status(400).json({ success: false, message: "Photo link must be a valid http(s) URL." });
    }

    const pool = getPool();

    await pool
      .request()
      .input("CoachID", sql.Int, coach.CoachID)
      .input("Phone", sql.NVarChar(50), phone || null)
      .input("Bio", sql.NVarChar(1000), bio || null)
      .input("ImageURL", sql.NVarChar(1000), rawImage || null)
      .query(`
        UPDATE Coaches
        SET Phone = @Phone,
            Bio = @Bio,
            ImageURL = CASE WHEN @ImageURL IS NULL THEN ImageURL ELSE @ImageURL END
        WHERE CoachID = @CoachID
      `);

    // Keep the login account in step so the sidebar avatar / contact match.
    await pool
      .request()
      .input("UserID", sql.Int, req.user.userId)
      .input("Phone", sql.NVarChar(20), phone ? phone.slice(0, 20) : null)
      .input("AvatarURL", sql.NVarChar(sql.MAX), rawImage || null)
      .query(`
        UPDATE Users
        SET Phone = @Phone,
            AvatarURL = CASE WHEN @AvatarURL IS NULL THEN AvatarURL ELSE @AvatarURL END
        WHERE UserID = @UserID
      `);

    return res.status(200).json({
      success: true,
      message: "Coach profile updated successfully.",
      coach: {
        Phone: phone || null,
        Bio: bio || null,
        ImageURL: rawImage || coach.ImageURL,
      },
    });
  } catch (error) {
    console.error("updateCoachProfile error:", error);
    return res.status(500).json({ success: false, message: "Failed to update your profile." });
  }
};

const uploadCoachPhoto = async (req, res) => {
  try {
    const coach = await resolveCoach(req.user.userId);
    if (!coach) return noCoachProfile(res);

    if (!req.file) {
      return res.status(400).json({ success: false, message: "Please choose an image file for your profile picture." });
    }

    const uploaded = await processUploadedFile(req.file, req);
    if (!uploaded || !uploaded.url) {
      return res.status(400).json({ success: false, message: "Failed to process the image file." });
    }

    const pool = getPool();
    await pool
      .request()
      .input("CoachID", sql.Int, coach.CoachID)
      .input("ImageURL", sql.NVarChar(1000), uploaded.url)
      .query("UPDATE Coaches SET ImageURL = @ImageURL WHERE CoachID = @CoachID");

    await pool
      .request()
      .input("UserID", sql.Int, req.user.userId)
      .input("AvatarURL", sql.NVarChar(sql.MAX), uploaded.url)
      .query("UPDATE Users SET AvatarURL = @AvatarURL WHERE UserID = @UserID");

    return res.status(200).json({
      success: true,
      message: "Profile photo updated successfully!",
      imageUrl: uploaded.url,
    });
  } catch (error) {
    console.error("uploadCoachPhoto error:", error);
    return res.status(500).json({ success: false, message: "Failed to upload your profile picture." });
  }
};

module.exports = {
  getCoachProfile,
  updateCoachProfile,
  uploadCoachPhoto,
  getCoachOverview,
  getCoachStudents,
  markStudentAttendance,
  getCoachAttendanceHistory,
  getCoachSchedules,
  createCoachSchedule,
  deleteCoachSchedule,
  getCoachTournaments,
  createCoachTournament,
  updateCoachTournament,
  deleteCoachTournament,
  createCoachMatch,
  updateCoachMatch,
  deleteCoachMatch,
  getCoachEquipment,
  createCoachEquipment,
  updateCoachEquipment,
  deleteCoachEquipment,
  issueCoachEquipment,
  returnCoachEquipment,
  getCoachEquipmentIssues,
  getCoachTrainers,
  getCoachSalary,
};
