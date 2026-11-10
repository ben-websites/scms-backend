const { sql, getPool } = require("../config/db");

/* =========================================================
   ROLE-AWARE REPORTS & ANALYTICS
   ---------------------------------------------------------
   Admin  -> /api/reports/admin  (club wide executive report)
   Coach  -> /api/reports/coach  (own sport + squad + payroll)
   Member -> /api/reports/me     (own fees, attendance, progress)
========================================================= */

const localISO = (date = new Date()) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

// Last N calendar months as [{ month, year, label }], oldest first.
const lastMonths = (count) => {
  const out = [];
  const now = new Date();
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({
      month: d.getMonth() + 1,
      year: d.getFullYear(),
      label: d.toLocaleDateString("en-US", { month: "short" }),
    });
  }
  return out;
};

const pct = (part, total) => (total > 0 ? Math.round((Number(part || 0) / Number(total)) * 100) : 0);

const resolveCoach = async (pool, userId) => {
  const res = await pool
    .request()
    .input("UserID", sql.Int, userId)
    .query(`
      SELECT c.CoachID, c.UserID, c.SportID, c.FullName, c.EmployeeCode,
             c.Specialization, c.MonthlySalary, s.SportName
      FROM Coaches c
      LEFT JOIN Sports s ON s.SportID = c.SportID
      WHERE c.UserID = @UserID
    `);
  return res.recordset[0] || null;
};

/* ------------------------------------------------------------------
   ADMIN — club wide executive report
------------------------------------------------------------------ */
const getAdminReport = async (req, res) => {
  try {
    const pool = getPool();
    const months = lastMonths(6);

    const membersRes = await pool.request().query(`
      SELECT
        (SELECT COUNT(*) FROM Users WHERE Role = 'user') AS TotalMembers,
        (SELECT COUNT(*) FROM Users WHERE Role = 'coach') AS TotalCoaches,
        (SELECT COUNT(*) FROM Users) AS TotalAccounts,
        (SELECT COUNT(*) FROM Memberships WHERE MembershipStatus = 'Active') AS ActiveMemberships,
        (SELECT COUNT(*) FROM Memberships WHERE MembershipStatus = 'PendingPayment') AS PendingMemberships,
        (SELECT COUNT(*) FROM Memberships WHERE MembershipStatus = 'Expired') AS ExpiredMemberships,
        (SELECT COUNT(*) FROM MembershipApplications WHERE ApplicationStatus = 'Pending') AS PendingApplications,
        (SELECT COUNT(*) FROM MembershipApplications WHERE ApplicationStatus = 'Approved') AS ApprovedApplications
    `);

    const revenueRes = await pool.request().query(`
      SELECT
        (SELECT ISNULL(SUM(Amount), 0) FROM Payments WHERE PaymentStatus = 'Approved') AS TotalCollected,
        (SELECT COUNT(*) FROM Payments WHERE PaymentStatus = 'Approved') AS PaidTransactions,
        (SELECT COUNT(*) FROM Payments WHERE PaymentStatus = 'Pending') AS PendingVerifications,
        (SELECT COUNT(*) FROM Payments WHERE PaymentStatus = 'Rejected') AS RejectedPayments,
        (SELECT ISNULL(SUM(BaseAmount + FineAmount), 0) FROM FeeVouchers WHERE VoucherStatus IN ('Unpaid', 'Overdue')) AS OutstandingDues,
        (SELECT ISNULL(SUM(FineAmount), 0) FROM FeeVouchers) AS TotalFines,
        (SELECT COUNT(*) FROM FeeVouchers WHERE VoucherStatus = 'Paid') AS PaidVouchers,
        (SELECT COUNT(*) FROM FeeVouchers) AS TotalVouchers
    `);

    // 6 month collection trend
    const trendRes = await pool.request().query(`
      SELECT
        YEAR(ISNULL(ReviewedAt, SubmittedAt)) AS [Year],
        MONTH(ISNULL(ReviewedAt, SubmittedAt)) AS [Month],
        ISNULL(SUM(CASE WHEN PaymentStatus = 'Approved' THEN Amount ELSE 0 END), 0) AS Collected,
        COUNT(CASE WHEN PaymentStatus = 'Approved' THEN 1 END) AS Receipts
      FROM Payments
      WHERE ISNULL(ReviewedAt, SubmittedAt) >= (DATE_TRUNC('month', NOW()) - INTERVAL '5 months')
      GROUP BY YEAR(ISNULL(ReviewedAt, SubmittedAt)), MONTH(ISNULL(ReviewedAt, SubmittedAt))
    `);

    const trendMap = new Map(trendRes.recordset.map((r) => [`${r.Year}-${r.Month}`, r]));
    const revenueTrend = months.map((m) => {
      const row = trendMap.get(`${m.year}-${m.month}`);
      return {
        label: `${m.label} ${String(m.year).slice(2)}`,
        Collected: Number(row?.Collected || 0),
        Receipts: Number(row?.Receipts || 0),
      };
    });

    const sportsRanking = await pool.request().query(`
      SELECT TOP 10
        s.SportID, s.SportName,
        (SELECT COUNT(*) FROM SportEnrollments e WHERE e.SportID = s.SportID AND e.Status = 'Active') AS EnrolledAthletes,
        (SELECT COUNT(*) FROM Equipment q WHERE q.SportID = s.SportID) AS GearItems
      FROM Sports s
      ORDER BY EnrolledAthletes DESC, s.SportName ASC
    `);

    const equipmentRes = await pool.request().query(`
      SELECT
        ISNULL(SUM(TotalQuantity), 0) AS TotalInventory,
        ISNULL(SUM(AvailableQuantity), 0) AS InStock,
        ISNULL(SUM(TotalQuantity - AvailableQuantity), 0) AS CurrentlyIssued,
        (SELECT COUNT(*) FROM Equipment WHERE ApprovalStatus = 'Pending') AS PendingRequests
      FROM Equipment
    `);

    const attendanceRes = await pool.request().query(`
      SELECT
        COUNT(*) AS TotalSessions,
        SUM(CASE WHEN Status IN ('Present', 'Late') THEN 1 ELSE 0 END) AS AttendedSessions,
        SUM(CASE WHEN Status = 'Absent' THEN 1 ELSE 0 END) AS MissedSessions
      FROM Attendance
    `);

    const eventsRes = await pool.request().query(`
      SELECT
        (SELECT COUNT(*) FROM Tournaments) AS TotalTournaments,
        (SELECT COUNT(*) FROM TournamentMatches) AS TotalMatches,
        (SELECT COUNT(*) FROM Tournaments WHERE ApprovalStatus = 'Pending') AS PendingTournaments,
        (SELECT COUNT(*) FROM Events WHERE EventDate >= CAST(SYSDATETIME() AS DATE)) AS UpcomingEvents,
        (SELECT COUNT(*) FROM EventRegistrations) AS EventRegistrations
    `);

    const coachPerformance = await pool.request().query(`
      SELECT
        c.CoachID, c.FullName, c.EmployeeCode, s.SportName,
        (SELECT COUNT(*) FROM SportEnrollments e WHERE e.SportID = c.SportID AND e.Status = 'Active') AS Students,
        (SELECT COUNT(*) FROM Trainers t WHERE t.CoachID = c.CoachID AND t.IsActive = 1) AS Trainers,
        (SELECT COUNT(*) FROM Tournaments t WHERE t.CoachID = c.CoachID) AS Tournaments,
        (SELECT COUNT(*) FROM Tournaments t WHERE t.CoachID = c.CoachID AND t.ApprovalStatus = 'Pending') AS PendingApprovals,
        (SELECT COUNT(*) FROM Attendance a WHERE a.SportID = c.SportID) AS SessionsMarked
      FROM Coaches c
      LEFT JOIN Sports s ON s.SportID = c.SportID
      WHERE c.IsActive = 1
      ORDER BY Students DESC, c.FullName ASC
    `);

    const members = membersRes.recordset[0] || {};
    const revenue = revenueRes.recordset[0] || {};
    const attendance = attendanceRes.recordset[0] || {};

    return res.status(200).json({
      success: true,
      generatedAt: new Date().toISOString(),
      members,
      revenue: {
        ...revenue,
        CollectionRate: pct(revenue.PaidVouchers, revenue.TotalVouchers),
      },
      revenueTrend,
      sportsRanking: sportsRanking.recordset,
      equipment: equipmentRes.recordset[0] || {},
      attendance: {
        ...attendance,
        Rate: pct(attendance.AttendedSessions, attendance.TotalSessions),
      },
      events: eventsRes.recordset[0] || {},
      coaches: coachPerformance.recordset,
    });
  } catch (error) {
    console.error("getAdminReport error:", error);
    return res.status(500).json({ success: false, message: "Failed to build the club report." });
  }
};

/* ------------------------------------------------------------------
   COACH — own sport report
------------------------------------------------------------------ */
const getCoachReport = async (req, res) => {
  try {
    const pool = getPool();
    const coach = await resolveCoach(pool, req.user.userId);
    if (!coach) {
      return res.status(403).json({
        success: false,
        message: "No coach profile is linked to this account. Please contact the administrator.",
      });
    }

    const months = lastMonths(6);

    const kpiRes = await pool
      .request()
      .input("CoachID", sql.Int, coach.CoachID)
      .input("SportID", sql.Int, coach.SportID)
      .query(`
        SELECT
          (SELECT COUNT(*) FROM SportEnrollments WHERE SportID = @SportID AND Status = 'Active') AS Students,
          (SELECT COUNT(*) FROM Trainers WHERE CoachID = @CoachID AND IsActive = 1) AS Trainers,
          (SELECT COUNT(*) FROM TrainingSchedules WHERE SportID = @SportID AND IsActive = 1) AS Schedules,
          (SELECT COUNT(*) FROM Tournaments WHERE CoachID = @CoachID) AS Tournaments,
          (SELECT COUNT(*) FROM Tournaments WHERE CoachID = @CoachID AND ApprovalStatus = 'Pending') AS PendingTournaments,
          (SELECT COUNT(*) FROM Equipment WHERE SportID = @SportID) AS EquipmentItems,
          (SELECT ISNULL(SUM(TotalQuantity), 0) FROM Equipment WHERE SportID = @SportID) AS EquipmentUnits,
          (SELECT ISNULL(SUM(TotalQuantity - AvailableQuantity), 0) FROM Equipment WHERE SportID = @SportID) AS EquipmentOut,
          (SELECT COUNT(*) FROM MemberPerformance WHERE SportID = @SportID) AS Evaluations,
          (SELECT ISNULL(AVG(CAST(FitnessScore AS DECIMAL(5,1))), 0) FROM MemberPerformance WHERE SportID = @SportID) AS AvgFitness,
          (SELECT ISNULL(AVG(CAST(SkillScore AS DECIMAL(5,1))), 0) FROM MemberPerformance WHERE SportID = @SportID) AS AvgSkill
      `);

    const attendanceRes = await pool
      .request()
      .input("SportID", sql.Int, coach.SportID)
      .query(`
        SELECT
          COUNT(*) AS TotalSessions,
          SUM(CASE WHEN Status IN ('Present', 'Late') THEN 1 ELSE 0 END) AS AttendedSessions,
          SUM(CASE WHEN Status = 'Absent' THEN 1 ELSE 0 END) AS MissedSessions
        FROM Attendance WHERE SportID = @SportID
      `);

    const trendRes = await pool
      .request()
      .input("SportID", sql.Int, coach.SportID)
      .query(`
        SELECT
          YEAR(SessionDate) AS [Year],
          MONTH(SessionDate) AS [Month],
          COUNT(*) AS Sessions,
          SUM(CASE WHEN Status IN ('Present', 'Late') THEN 1 ELSE 0 END) AS Present
        FROM Attendance
        WHERE SportID = @SportID
          AND SessionDate >= (DATE_TRUNC('month', NOW()) - INTERVAL '5 months')
        GROUP BY YEAR(SessionDate), MONTH(SessionDate)
      `);

    const trendMap = new Map(trendRes.recordset.map((r) => [`${r.Year}-${r.Month}`, r]));
    const attendanceTrend = months.map((m) => {
      const row = trendMap.get(`${m.year}-${m.month}`);
      const sessions = Number(row?.Sessions || 0);
      const present = Number(row?.Present || 0);
      return {
        label: m.label,
        Sessions: sessions,
        Present: present,
        Rate: pct(present, sessions),
      };
    });

    const studentsRes = await pool
      .request()
      .input("SportID", sql.Int, coach.SportID)
      .query(`
        SELECT TOP 8
          u.UserID, u.FullName, e.SkillLevel, e.EnrolledAt,
          (SELECT COUNT(*) FROM Attendance a
             WHERE a.UserID = u.UserID AND a.SportID = @SportID AND a.Status IN ('Present', 'Late')) AS PresentSessions,
          (SELECT COUNT(*) FROM Attendance a
             WHERE a.UserID = u.UserID AND a.SportID = @SportID AND a.Status = 'Absent') AS MissedSessions,
          (SELECT TOP 1 CAST((p.FitnessScore + p.SkillScore + p.AttendanceScore) / 3 AS DECIMAL(5,1))
             FROM MemberPerformance p
             WHERE p.UserID = u.UserID AND p.SportID = @SportID
             ORDER BY p.EvaluationDate DESC) AS LatestScore
        FROM SportEnrollments e
        JOIN Users u ON u.UserID = e.UserID
        WHERE e.SportID = @SportID AND e.Status = 'Active'
        ORDER BY PresentSessions DESC, u.FullName ASC
      `);

    const tournamentsRes = await pool
      .request()
      .input("CoachID", sql.Int, coach.CoachID)
      .query(`
        SELECT
          t.TournamentID, t.TournamentName, t.StartDate, t.EndDate, t.Venue, t.Status, t.ApprovalStatus,
          (SELECT COUNT(*) FROM TournamentMatches m WHERE m.TournamentID = t.TournamentID) AS Matches,
          (SELECT COUNT(*) FROM TournamentMatches m WHERE m.TournamentID = t.TournamentID AND m.Status = 'Completed') AS CompletedMatches
        FROM Tournaments t
        WHERE t.CoachID = @CoachID
        ORDER BY t.StartDate DESC
      `);

    const trainersRes = await pool
      .request()
      .input("CoachID", sql.Int, coach.CoachID)
      .input("Month", sql.Int, new Date().getMonth() + 1)
      .input("Year", sql.Int, new Date().getFullYear())
      .query(`
        SELECT
          t.TrainerID, t.FullName, t.Specialization, t.Shift, t.MonthlySalary, t.IsActive,
          (SELECT COUNT(*) FROM StaffAttendance sa
             WHERE sa.TrainerID = t.TrainerID AND MONTH(sa.AttendanceDate) = @Month
               AND YEAR(sa.AttendanceDate) = @Year AND sa.Status IN ('Present', 'Late')) AS PresentDays,
          (SELECT COUNT(*) FROM StaffAttendance sa
             WHERE sa.TrainerID = t.TrainerID AND MONTH(sa.AttendanceDate) = @Month
               AND YEAR(sa.AttendanceDate) = @Year AND sa.Status = 'Absent') AS AbsentDays
        FROM Trainers t
        WHERE t.CoachID = @CoachID
        ORDER BY t.TrainerID
      `);

    const payrollRes = await pool
      .request()
      .input("CoachID", sql.Int, coach.CoachID)
      .query(`
        SELECT
          ISNULL(SUM(CASE WHEN Status = 'Paid' THEN NetSalary ELSE 0 END), 0) AS PaidNet,
          ISNULL(SUM(CASE WHEN Status <> 'Paid' THEN NetSalary ELSE 0 END), 0) AS PendingNet,
          COUNT(*) AS Records
        FROM SalaryPayments WHERE CoachID = @CoachID
      `);

    const kpi = kpiRes.recordset[0] || {};
    const attendance = attendanceRes.recordset[0] || {};

    return res.status(200).json({
      success: true,
      generatedAt: new Date().toISOString(),
      coach: {
        CoachID: coach.CoachID,
        FullName: coach.FullName,
        EmployeeCode: coach.EmployeeCode,
        SportName: coach.SportName,
        Specialization: coach.Specialization,
        MonthlySalary: coach.MonthlySalary,
      },
      kpis: {
        ...kpi,
        AvgFitness: Number(kpi.AvgFitness || 0).toFixed(1),
        AvgSkill: Number(kpi.AvgSkill || 0).toFixed(1),
      },
      attendance: {
        ...attendance,
        Rate: pct(attendance.AttendedSessions, attendance.TotalSessions),
      },
      attendanceTrend,
      students: studentsRes.recordset,
      tournaments: tournamentsRes.recordset,
      trainers: trainersRes.recordset,
      payroll: payrollRes.recordset[0] || {},
      today: localISO(),
    });
  } catch (error) {
    console.error("getCoachReport error:", error);
    return res.status(500).json({ success: false, message: "Failed to build the coaching report." });
  }
};

/* ------------------------------------------------------------------
   MEMBER — own fees / attendance / progress report
------------------------------------------------------------------ */
const getMemberReport = async (req, res) => {
  try {
    const userId = req.user.userId;
    const pool = getPool();
    const months = lastMonths(6);

    const membershipRes = await pool
      .request()
      .input("UserID", sql.Int, userId)
      .query(`
        SELECT TOP 1
          m.MembershipID, m.MembershipNumber, m.MembershipStatus, m.StartDate, m.EndDate,
          p.PlanName, p.MonthlyFee, p.AdmissionFee
        FROM Memberships m
        LEFT JOIN MembershipPlans p ON p.PlanID = m.PlanID
        WHERE m.UserID = @UserID
        ORDER BY m.MembershipID DESC
      `);

    const membership = membershipRes.recordset[0] || null;

    const feesRes = membership
      ? await pool
          .request()
          .input("MembershipID", sql.Int, membership.MembershipID)
          .query(`
            SELECT
              COUNT(*) AS TotalVouchers,
              SUM(CASE WHEN VoucherStatus = 'Paid' THEN 1 ELSE 0 END) AS PaidVouchers,
              SUM(CASE WHEN VoucherStatus IN ('Unpaid', 'Overdue', 'PendingVerification') THEN 1 ELSE 0 END) AS OpenVouchers,
              ISNULL(SUM(CASE WHEN VoucherStatus = 'Paid' THEN BaseAmount + FineAmount ELSE 0 END), 0) AS PaidAmount,
              ISNULL(SUM(CASE WHEN VoucherStatus IN ('Unpaid', 'Overdue', 'PendingVerification') THEN BaseAmount + FineAmount ELSE 0 END), 0) AS OutstandingAmount,
              ISNULL(SUM(FineAmount), 0) AS TotalFines
            FROM FeeVouchers WHERE MembershipID = @MembershipID
          `)
      : { recordset: [{}] };

    const paymentsRes = await pool
      .request()
      .input("UserID", sql.Int, userId)
      .query(`
        SELECT
          COUNT(*) AS TotalSubmissions,
          SUM(CASE WHEN p.PaymentStatus = 'Approved' THEN 1 ELSE 0 END) AS ApprovedPayments,
          SUM(CASE WHEN p.PaymentStatus = 'Pending' THEN 1 ELSE 0 END) AS PendingPayments,
          SUM(CASE WHEN p.PaymentStatus = 'Rejected' THEN 1 ELSE 0 END) AS RejectedPayments,
          ISNULL(SUM(CASE WHEN p.PaymentStatus = 'Approved' THEN p.Amount ELSE 0 END), 0) AS TotalPaid
        FROM Payments p
        JOIN FeeVouchers v ON v.VoucherID = p.VoucherID
        JOIN Memberships m ON m.MembershipID = v.MembershipID
        WHERE m.UserID = @UserID
      `);

    const monthlyRes = await pool
      .request()
      .input("UserID", sql.Int, userId)
      .query(`
        SELECT
          YEAR(ISNULL(p.ReviewedAt, p.SubmittedAt)) AS [Year],
          MONTH(ISNULL(p.ReviewedAt, p.SubmittedAt)) AS [Month],
          ISNULL(SUM(CASE WHEN p.PaymentStatus = 'Approved' THEN p.Amount ELSE 0 END), 0) AS Paid
        FROM Payments p
        JOIN FeeVouchers v ON v.VoucherID = p.VoucherID
        JOIN Memberships m ON m.MembershipID = v.MembershipID
        WHERE m.UserID = @UserID
          AND ISNULL(p.ReviewedAt, p.SubmittedAt) >= (DATE_TRUNC('month', NOW()) - INTERVAL '5 months')
        GROUP BY YEAR(ISNULL(p.ReviewedAt, p.SubmittedAt)), MONTH(ISNULL(p.ReviewedAt, p.SubmittedAt))
      `);

    const monthlyMap = new Map(monthlyRes.recordset.map((r) => [`${r.Year}-${r.Month}`, r]));
    const paymentTrend = months.map((m) => ({
      label: m.label,
      Paid: Number(monthlyMap.get(`${m.year}-${m.month}`)?.Paid || 0),
    }));

    const sportsRes = await pool
      .request()
      .input("UserID", sql.Int, userId)
      .query(`
        SELECT
          s.SportID, s.SportName, e.SkillLevel, e.Status AS EnrollmentStatus, e.EnrolledAt,
          c.FullName AS CoachName,
          (SELECT COUNT(*) FROM Attendance a
             WHERE a.UserID = @UserID AND a.SportID = s.SportID AND a.Status IN ('Present', 'Late')) AS PresentSessions,
          (SELECT COUNT(*) FROM Attendance a
             WHERE a.UserID = @UserID AND a.SportID = s.SportID AND a.Status = 'Absent') AS MissedSessions,
          (SELECT TOP 1 CAST((p.FitnessScore + p.SkillScore + p.AttendanceScore) / 3 AS DECIMAL(5,1))
             FROM MemberPerformance p
             WHERE p.UserID = @UserID AND p.SportID = s.SportID
             ORDER BY p.EvaluationDate DESC) AS LatestScore
        FROM SportEnrollments e
        JOIN Sports s ON s.SportID = e.SportID
        LEFT JOIN Coaches c ON c.CoachID = e.CoachID
        WHERE e.UserID = @UserID
        ORDER BY s.SportName
      `);

    const performanceRes = await pool
      .request()
      .input("UserID", sql.Int, userId)
      .query(`
        SELECT
          p.PerformanceID, p.EvaluationDate, s.SportName,
          p.FitnessScore, p.SkillScore, p.AttendanceScore,
          p.MatchesPlayed, p.MatchesWon, p.CoachFeedback, p.NextMilestones
        FROM MemberPerformance p
        LEFT JOIN Sports s ON s.SportID = p.SportID
        WHERE p.UserID = @UserID
        ORDER BY p.EvaluationDate DESC
      `);

    const attendanceRes = await pool
      .request()
      .input("UserID", sql.Int, userId)
      .query(`
        SELECT
          COUNT(*) AS TotalSessions,
          SUM(CASE WHEN Status IN ('Present', 'Late') THEN 1 ELSE 0 END) AS AttendedSessions,
          SUM(CASE WHEN Status = 'Absent' THEN 1 ELSE 0 END) AS MissedSessions
        FROM Attendance WHERE UserID = @UserID
      `);

    const attendance = attendanceRes.recordset[0] || {};
    const fees = feesRes.recordset[0] || {};
    const payments = paymentsRes.recordset[0] || {};

    return res.status(200).json({
      success: true,
      generatedAt: new Date().toISOString(),
      membership,
      fees: {
        ...fees,
        CollectionRate: pct(fees.PaidVouchers, fees.TotalVouchers),
      },
      payments,
      paymentTrend,
      attendance: {
        ...attendance,
        Rate: pct(attendance.AttendedSessions, attendance.TotalSessions),
      },
      sports: sportsRes.recordset,
      performance: performanceRes.recordset,
    });
  } catch (error) {
    console.error("getMemberReport error:", error);
    return res.status(500).json({ success: false, message: "Failed to build your personal report." });
  }
};

module.exports = { getAdminReport, getCoachReport, getMemberReport };
