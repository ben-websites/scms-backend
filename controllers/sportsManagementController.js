const { sql, getPool } = require("../config/db");
const { notifyAdmins, notifyUser, notifyAllMembers } = require("../utils/notificationService");
const { ensureFiveTrainers } = require("../utils/trainerSlots");

/**
 * =========================================================================
 * 1. SPORTS & COACH MANAGEMENT (Features 4 & 5)
 * =========================================================================
 */

// GET all sports with coaches, schedules, and active student enrollment count
const getSportsComprehensive = async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.request().query(`
      SELECT 
        s.SportID,
        s.SportName,
        s.Description,
        s.ImageURL,
        s.IsActive,
        s.CreatedAt,
        c.CoachID,
        c.FullName AS CoachName,
        c.Specialization AS CoachSpecialization,
        c.Rating AS CoachRating,
        c.ImageURL AS CoachImage,
        c.Phone AS CoachPhone,
        c.Email AS CoachEmail,
        (SELECT COUNT(*) FROM SportEnrollments se WHERE se.SportID = s.SportID AND se.Status = 'Active') AS ActiveEnrollmentCount,
        (SELECT COUNT(*) FROM TrainingSchedules ts WHERE ts.SportID = s.SportID AND ts.IsActive = 1) AS ScheduleCount,
        (SELECT COUNT(*) FROM Equipment eq WHERE eq.SportID = s.SportID) AS EquipmentCount
      FROM Sports s
      LEFT JOIN Coaches c ON s.SportID = c.SportID AND c.IsActive = 1
      ORDER BY s.SportName ASC
    `);

    res.json({
      success: true,
      count: result.recordset.length,
      data: result.recordset,
    });
  } catch (error) {
    console.error("getSportsComprehensive error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET all coaches
const getAllCoaches = async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.request().query(`
      SELECT 
        c.CoachID,
        c.FullName,
        c.Email,
        c.Phone,
        c.SportID,
        s.SportName,
        c.Specialization,
        c.ExperienceYears,
        c.Bio,
        c.ImageURL,
        c.Rating,
        c.MonthlySalary,
        c.IsActive,
        c.CreatedAt,
        (SELECT COUNT(*) FROM SportEnrollments se WHERE se.SportID = c.SportID AND se.Status = 'Active') AS ActiveStudentCount
      FROM Coaches c
      LEFT JOIN Sports s ON c.SportID = s.SportID
      ORDER BY c.FullName ASC
    `);

    res.json({
      success: true,
      count: result.recordset.length,
      data: result.recordset,
    });
  } catch (error) {
    console.error("getAllCoaches error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET single coach by ID with assigned students and schedule
const getCoachById = async (req, res) => {
  try {
    const { id } = req.params;
    const pool = getPool();

    const coachRes = await pool.request()
      .input("CoachID", sql.Int, id)
      .query(`
        SELECT c.*, s.SportName
        FROM Coaches c
        LEFT JOIN Sports s ON c.SportID = s.SportID
        WHERE c.CoachID = @CoachID
      `);

    if (coachRes.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Coach not found." });
    }

    const coach = coachRes.recordset[0];

    // Get coach's schedules
    const schedRes = await pool.request()
      .input("SportID", sql.Int, coach.SportID)
      .query(`SELECT * FROM TrainingSchedules WHERE SportID = @SportID AND IsActive = 1`);

    // Get coach's students
    const studentRes = await pool.request()
      .input("SportID", sql.Int, coach.SportID)
      .query(`
        SELECT 
          se.EnrollmentID, se.UserID, u.FullName, u.Email, u.Phone,
          se.SkillLevel, se.Status, se.EnrolledAt
        FROM SportEnrollments se
        JOIN Users u ON se.UserID = u.UserID
        WHERE se.SportID = @SportID AND se.Status = 'Active'
        ORDER BY se.EnrolledAt DESC
      `);

    res.json({
      success: true,
      data: {
        ...coach,
        schedules: schedRes.recordset,
        students: studentRes.recordset,
      },
    });
  } catch (error) {
    console.error("getCoachById error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// CREATE a coach (Admin)
const createCoach = async (req, res) => {
  try {
    const { fullName, email, phone, sportId, specialization, experienceYears, bio, imageUrl, monthlySalary } = req.body;

    if (!fullName) {
      return res.status(400).json({ success: false, message: "Coach full name is required." });
    }

    const pool = getPool();

    // One head coach per sport — every sport is covered by its own dedicated coach.
    if (sportId) {
      const existing = await pool
        .request()
        .input("SportID", sql.Int, parseInt(sportId))
        .query("SELECT COUNT(*) AS c FROM Coaches WHERE SportID = @SportID AND IsActive = 1");

      if (existing.recordset[0].c > 0) {
        return res.status(409).json({
          success: false,
          message: "This sport already has a head coach. Deactivate the current coach first.",
        });
      }
    }

    const result = await pool.request()
      .input("FullName", sql.NVarChar(100), fullName)
      .input("Email", sql.NVarChar(150), email || null)
      .input("Phone", sql.NVarChar(50), phone || null)
      .input("SportID", sql.Int, sportId ? parseInt(sportId) : null)
      .input("Specialization", sql.NVarChar(150), specialization || "Head Coach")
      .input("ExperienceYears", sql.Int, experienceYears ? parseInt(experienceYears) : 3)
      .input("Bio", sql.NVarChar(1000), bio || null)
      .input("ImageURL", sql.NVarChar(1000), imageUrl || "https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=500&q=80")
      .input("MonthlySalary", sql.Decimal(10, 2), monthlySalary ? parseFloat(monthlySalary) : 75000)
      .query(`
        INSERT INTO Coaches (FullName, Email, Phone, SportID, Specialization, ExperienceYears, Bio, ImageURL, Rating, MonthlySalary, IsActive, CreatedAt)
        OUTPUT INSERTED.*
        VALUES (@FullName, @Email, @Phone, @SportID, @Specialization, @ExperienceYears, @Bio, @ImageURL, 4.9, @MonthlySalary, 1, SYSDATETIME())
      `);

    await notifyAdmins({
      title: "New Coach Appointed 🏆",
      message: `Coach ${fullName} has been appointed to the athletic training faculty.`,
      type: "sports",
      link: "/admin/sports-services",
    });

    // Give every newly appointed head coach an employee code and a 5-trainer squad.
    const createdCoach = result.recordset[0];
    const employeeCode = `COACH-${String(createdCoach.CoachID).padStart(3, "0")}`;
    await pool
      .request()
      .input("CoachID", sql.Int, createdCoach.CoachID)
      .input("EmployeeCode", sql.NVarChar(30), employeeCode)
      .query("UPDATE Coaches SET EmployeeCode = @EmployeeCode WHERE CoachID = @CoachID");

    if (createdCoach.SportID) {
      try {
        await ensureFiveTrainers(
          pool,
          createdCoach.CoachID,
          createdCoach.SportID,
          createdCoach.Specialization,
          createdCoach.MonthlySalary
        );
      } catch (trainerError) {
        console.error("Trainer provisioning skipped:", trainerError.message);
      }
    }

    res.status(201).json({
      success: true,
      message: "Coach profile created successfully.",
      data: { ...createdCoach, EmployeeCode: employeeCode },
    });
  } catch (error) {
    console.error("createCoach error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// UPDATE a coach (Admin)
const updateCoach = async (req, res) => {
  try {
    const { id } = req.params;
    const { fullName, email, phone, sportId, specialization, experienceYears, bio, imageUrl, monthlySalary, isActive } = req.body;

    const pool = getPool();
    await pool.request()
      .input("CoachID", sql.Int, id)
      .input("FullName", sql.NVarChar(100), fullName)
      .input("Email", sql.NVarChar(150), email)
      .input("Phone", sql.NVarChar(50), phone)
      .input("SportID", sql.Int, sportId ? parseInt(sportId) : null)
      .input("Specialization", sql.NVarChar(150), specialization)
      .input("ExperienceYears", sql.Int, experienceYears ? parseInt(experienceYears) : 3)
      .input("Bio", sql.NVarChar(1000), bio)
      .input("ImageURL", sql.NVarChar(1000), imageUrl)
      .input("MonthlySalary", sql.Decimal(10, 2), monthlySalary ? parseFloat(monthlySalary) : 75000)
      .input("IsActive", sql.Bit, isActive !== undefined ? (isActive ? 1 : 0) : 1)
      .query(`
        UPDATE Coaches
        SET FullName = @FullName,
            Email = @Email,
            Phone = @Phone,
            SportID = @SportID,
            Specialization = @Specialization,
            ExperienceYears = @ExperienceYears,
            Bio = @Bio,
            ImageURL = @ImageURL,
            MonthlySalary = @MonthlySalary,
            IsActive = @IsActive
        WHERE CoachID = @CoachID
      `);

    res.json({ success: true, message: "Coach updated successfully." });
  } catch (error) {
    console.error("updateCoach error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE a coach (Admin)
const deleteCoach = async (req, res) => {
  try {
    const { id } = req.params;
    const pool = getPool();
    await pool.request()
      .input("CoachID", sql.Int, id)
      .query("UPDATE Coaches SET IsActive = 0 WHERE CoachID = @CoachID");

    res.json({ success: true, message: "Coach deactivated successfully." });
  } catch (error) {
    console.error("deleteCoach error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};


/**
 * =========================================================================
 * 2. MEMBER SPORT ENROLLMENTS WITH PLAN LIMITS (Special Requirement)
 * Bronze: 1 Sport | Silver: 3 Sports | Gold: 6 Sports | Platinum: 20 Sports
 * =========================================================================
 */

// GET Member's Sport Enrollments and Limit Info
const getMySportEnrollments = async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.UserID;
    const pool = getPool();

    // Check membership and plan
    const memberPlan = await pool.request()
      .input("UserID", sql.Int, userId)
      .query(`
        SELECT 
          m.MembershipID,
          m.MembershipNumber,
          m.MembershipStatus,
          p.PlanID,
          p.PlanName,
          p.MonthlyFee,
          ISNULL(p.AllowedSportsLimit, 1) AS AllowedSportsLimit
        FROM Memberships m
        JOIN MembershipPlans p ON m.PlanID = p.PlanID
        WHERE m.UserID = @UserID AND m.MembershipStatus = 'Active'
      `);

    let membership = null;
    let allowedLimit = 0;
    let planName = "No Active Membership";

    if (memberPlan.recordset.length > 0) {
      membership = memberPlan.recordset[0];
      allowedLimit = membership.AllowedSportsLimit;
      planName = membership.PlanName;
    }

    // Get active enrollments
    const enrollments = await pool.request()
      .input("UserID", sql.Int, userId)
      .query(`
        SELECT 
          se.EnrollmentID,
          se.SportID,
          s.SportName,
          s.Description AS SportDesc,
          s.ImageURL AS SportImage,
          se.SkillLevel,
          se.Status,
          se.EnrolledAt,
          c.CoachID,
          c.FullName AS CoachName,
          c.Specialization AS CoachSpecialization,
          c.Phone AS CoachPhone,
          c.ImageURL AS CoachImage
        FROM SportEnrollments se
        JOIN Sports s ON se.SportID = s.SportID
        LEFT JOIN Coaches c ON se.CoachID = c.CoachID OR (c.SportID = s.SportID AND c.IsActive = 1)
        WHERE se.UserID = @UserID AND se.Status = 'Active'
        ORDER BY se.EnrolledAt DESC
      `);

    const currentEnrolledCount = enrollments.recordset.length;
    const remainingSlots = Math.max(0, allowedLimit - currentEnrolledCount);

    res.json({
      success: true,
      hasActiveMembership: !!membership,
      membership,
      planName,
      allowedLimit,
      currentEnrolledCount,
      remainingSlots,
      data: enrollments.recordset,
    });
  } catch (error) {
    console.error("getMySportEnrollments error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ENROLL into a Sport (Enforces Plan Limits)
const enrollInSport = async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.UserID;
    const { sportId, skillLevel } = req.body;

    if (!sportId) {
      return res.status(400).json({ success: false, message: "Sport ID is required." });
    }

    const pool = getPool();

    // 1. Verify Active Membership
    const memberCheck = await pool.request()
      .input("UserID", sql.Int, userId)
      .query(`
        SELECT 
          m.MembershipID,
          m.MembershipNumber,
          m.MembershipStatus,
          p.PlanID,
          p.PlanName,
          ISNULL(p.AllowedSportsLimit, 1) AS AllowedSportsLimit
        FROM Memberships m
        JOIN MembershipPlans p ON m.PlanID = p.PlanID
        WHERE m.UserID = @UserID AND m.MembershipStatus = 'Active'
      `);

    if (memberCheck.recordset.length === 0) {
      return res.status(403).json({
        success: false,
        message: "Active club membership required! Please submit a membership application and clear fee dues to enroll in sports.",
      });
    }

    const plan = memberCheck.recordset[0];
    const allowedLimit = plan.AllowedSportsLimit;

    // 2. Check if already enrolled in this sport
    const existing = await pool.request()
      .input("UserID", sql.Int, userId)
      .input("SportID", sql.Int, sportId)
      .query("SELECT * FROM SportEnrollments WHERE UserID = @UserID AND SportID = @SportID");

    if (existing.recordset.length > 0 && existing.recordset[0].Status === "Active") {
      return res.status(400).json({
        success: false,
        message: "You are already actively enrolled in this sport!",
      });
    }

    // 3. Check Current Active Sports Count vs Plan Limit
    const countRes = await pool.request()
      .input("UserID", sql.Int, userId)
      .query("SELECT COUNT(*) AS activeCount FROM SportEnrollments WHERE UserID = @UserID AND Status = 'Active'");

    const activeCount = countRes.recordset[0].activeCount;

    if (activeCount >= allowedLimit) {
      return res.status(400).json({
        success: false,
        limitReached: true,
        message: `Plan Limit Reached: Your '${plan.PlanName}' plan allows enrollment in up to ${allowedLimit} sport(s). You have already selected ${activeCount} sport(s). Please upgrade to a higher tier (Silver: 3, Gold: 6, Platinum: All 20) to unlock more sports!`,
      });
    }

    // 4. Find the Head Coach for this sport
    const coachRes = await pool.request()
      .input("SportID", sql.Int, sportId)
      .query("SELECT TOP 1 CoachID, FullName FROM Coaches WHERE SportID = @SportID AND IsActive = 1");

    const coachId = coachRes.recordset.length > 0 ? coachRes.recordset[0].CoachID : null;

    // 5. Insert or Reactivate Enrollment
    if (existing.recordset.length > 0) {
      await pool.request()
        .input("UserID", sql.Int, userId)
        .input("SportID", sql.Int, sportId)
        .input("CoachID", sql.Int, coachId)
        .input("SkillLevel", sql.NVarChar(30), skillLevel || "Beginner")
        .query(`
          UPDATE SportEnrollments 
          SET Status = 'Active', CoachID = @CoachID, SkillLevel = @SkillLevel, EnrolledAt = SYSDATETIME()
          WHERE UserID = @UserID AND SportID = @SportID
        `);
    } else {
      await pool.request()
        .input("UserID", sql.Int, userId)
        .input("SportID", sql.Int, sportId)
        .input("CoachID", sql.Int, coachId)
        .input("SkillLevel", sql.NVarChar(30), skillLevel || "Beginner")
        .query(`
          INSERT INTO SportEnrollments (UserID, SportID, CoachID, SkillLevel, Status, EnrolledAt)
          VALUES (@UserID, @SportID, @CoachID, @SkillLevel, 'Active', SYSDATETIME())
        `);
    }

    // Get Sport Name for notifications
    const sportInfo = await pool.request()
      .input("SportID", sql.Int, sportId)
      .query("SELECT SportName FROM Sports WHERE SportID = @SportID");
    const sportName = sportInfo.recordset[0]?.SportName || "Sport";

    // Notify member
    await notifyUser({
      userId,
      title: `Sport Enrollment Confirmed: ${sportName} 🏅`,
      message: `You have successfully enrolled in ${sportName} under your ${plan.PlanName} plan (${activeCount + 1}/${allowedLimit} slots used). Check your training schedule!`,
      type: "sports",
      link: "/user/dashboard",
    });

    // Get member name for admin notification
    const userRow = await pool.request()
      .input("UID", sql.Int, userId)
      .query("SELECT FullName FROM Users WHERE UserID = @UID");
    const memberName = userRow.recordset[0]?.FullName || "Club Member";

    // Notify admin
    await notifyAdmins({
      title: "New Sport Enrollment 🏃",
      message: `${memberName} enrolled in ${sportName} (${plan.PlanName}).`,
      type: "sports",
      link: "/admin/sports-services",
    });

    res.status(201).json({
      success: true,
      message: `Successfully enrolled in ${sportName}! Slots used: ${activeCount + 1}/${allowedLimit}.`,
      slotsUsed: activeCount + 1,
      totalSlots: allowedLimit,
    });
  } catch (error) {
    console.error("enrollInSport error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// CANCEL / DROP Sport Enrollment
const dropSportEnrollment = async (req, res) => {
  try {
    const { enrollmentId } = req.params;
    const userId = req.user?.userId || req.user?.UserID;
    const isAdmin = (req.user?.role || req.user?.Role) === "admin";

    const pool = getPool();
    const query = isAdmin
      ? "UPDATE SportEnrollments SET Status = 'Dropped' WHERE EnrollmentID = @EnrollmentID"
      : "UPDATE SportEnrollments SET Status = 'Dropped' WHERE EnrollmentID = @EnrollmentID AND UserID = @UserID";

    const reqq = pool.request().input("EnrollmentID", sql.Int, enrollmentId);
    if (!isAdmin) reqq.input("UserID", sql.Int, userId);

    await reqq.query(query);

    res.json({ success: true, message: "Sport enrollment dropped successfully. Slot is now freed." });
  } catch (error) {
    console.error("dropSportEnrollment error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};


/**
 * =========================================================================
 * 3. TEAM MANAGEMENT (Feature 6)
 * =========================================================================
 */

// GET all teams with sport, coach, and member count
const getAllTeams = async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.request().query(`
      SELECT 
        t.TeamID,
        t.TeamName,
        t.SportID,
        s.SportName,
        t.CoachID,
        c.FullName AS CoachName,
        t.CaptainUserID,
        u.FullName AS CaptainName,
        t.MaxMembers,
        t.LogoURL,
        t.Status,
        t.CreatedAt,
        (SELECT COUNT(*) FROM TeamMembers tm WHERE tm.TeamID = t.TeamID) AS CurrentMemberCount
      FROM Teams t
      JOIN Sports s ON t.SportID = s.SportID
      LEFT JOIN Coaches c ON t.CoachID = c.CoachID
      LEFT JOIN Users u ON t.CaptainUserID = u.UserID
      ORDER BY t.CreatedAt DESC
    `);

    res.json({ success: true, count: result.recordset.length, data: result.recordset });
  } catch (error) {
    console.error("getAllTeams error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET single team with roster
const getTeamById = async (req, res) => {
  try {
    const { id } = req.params;
    const pool = getPool();

    const teamRes = await pool.request()
      .input("TeamID", sql.Int, id)
      .query(`
        SELECT 
          t.*, s.SportName, c.FullName AS CoachName, u.FullName AS CaptainName
        FROM Teams t
        JOIN Sports s ON t.SportID = s.SportID
        LEFT JOIN Coaches c ON t.CoachID = c.CoachID
        LEFT JOIN Users u ON t.CaptainUserID = u.UserID
        WHERE t.TeamID = @TeamID
      `);

    if (teamRes.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Team not found." });
    }

    const membersRes = await pool.request()
      .input("TeamID", sql.Int, id)
      .query(`
        SELECT 
          tm.TeamMemberID, tm.UserID, u.FullName, u.Email, u.Phone,
          tm.JerseyNumber, tm.Position, tm.JoinedAt
        FROM TeamMembers tm
        JOIN Users u ON tm.UserID = u.UserID
        WHERE tm.TeamID = @TeamID
        ORDER BY tm.JerseyNumber ASC, tm.JoinedAt DESC
      `);

    res.json({
      success: true,
      data: {
        ...teamRes.recordset[0],
        members: membersRes.recordset,
      },
    });
  } catch (error) {
    console.error("getTeamById error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// CREATE a team (Admin)
const createTeam = async (req, res) => {
  try {
    const { teamName, sportId, coachId, captainUserId, maxMembers, logoUrl } = req.body;

    if (!teamName || !sportId) {
      return res.status(400).json({ success: false, message: "Team name and sport are required." });
    }

    const pool = getPool();
    const result = await pool.request()
      .input("TeamName", sql.NVarChar(100), teamName)
      .input("SportID", sql.Int, sportId)
      .input("CoachID", sql.Int, coachId || null)
      .input("CaptainUserID", sql.Int, captainUserId || null)
      .input("MaxMembers", sql.Int, maxMembers || 15)
      .input("LogoURL", sql.NVarChar(1000), logoUrl || null)
      .query(`
        INSERT INTO Teams (TeamName, SportID, CoachID, CaptainUserID, MaxMembers, LogoURL, Status, CreatedAt)
        OUTPUT INSERTED.*
        VALUES (@TeamName, @SportID, @CoachID, @CaptainUserID, @MaxMembers, @LogoURL, 'Active', SYSDATETIME())
      `);

    res.status(201).json({ success: true, message: "Team created successfully.", data: result.recordset[0] });
  } catch (error) {
    console.error("createTeam error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ADD member to team (Admin/Coach)
const addTeamMember = async (req, res) => {
  try {
    const { id } = req.params; // TeamID
    const { userId, jerseyNumber, position } = req.body;

    if (!userId) {
      return res.status(400).json({ success: false, message: "User ID is required." });
    }

    const pool = getPool();
    await pool.request()
      .input("TeamID", sql.Int, id)
      .input("UserID", sql.Int, userId)
      .input("JerseyNumber", sql.Int, jerseyNumber || null)
      .input("Position", sql.NVarChar(50), position || "Player")
      .query(`
        INSERT INTO TeamMembers (TeamID, UserID, JerseyNumber, Position, JoinedAt)
        VALUES (@TeamID, @UserID, @JerseyNumber, @Position, SYSDATETIME())
      `);

    // Notify member
    await notifyUser({
      userId,
      title: "Assigned to Sports Team! 🛡️",
      message: `Congratulations! You have been assigned to club squad #${id}. Check your team roster in the portal.`,
      type: "sports",
      link: "/user/dashboard",
    });

    res.status(201).json({ success: true, message: "Member drafted into squad successfully." });
  } catch (error) {
    console.error("addTeamMember error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// REMOVE member from team
const removeTeamMember = async (req, res) => {
  try {
    const { memberId } = req.params;
    const pool = getPool();
    await pool.request()
      .input("TeamMemberID", sql.Int, memberId)
      .query("DELETE FROM TeamMembers WHERE TeamMemberID = @TeamMemberID");

    res.json({ success: true, message: "Member removed from team roster." });
  } catch (error) {
    console.error("removeTeamMember error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};


/**
 * =========================================================================
 * 4. TOURNAMENTS & MATCH SCHEDULING (Features 10 & 11)
 * =========================================================================
 */

// GET all tournaments
const getAllTournaments = async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.request().query(`
      SELECT 
        tr.TournamentID,
        tr.TournamentName,
        tr.SportID,
        s.SportName,
        tr.Description,
        tr.TournamentType,
        tr.StartDate,
        tr.EndDate,
        tr.Venue,
        tr.PrizePool,
        tr.MaxTeams,
        tr.Status,
        tr.BannerURL,
        tr.CreatedAt,
        (SELECT COUNT(*) FROM TournamentMatches tm WHERE tm.TournamentID = tr.TournamentID) AS TotalMatches,
        (SELECT COUNT(*) FROM TournamentMatches tm WHERE tm.TournamentID = tr.TournamentID AND tm.Status = 'Completed') AS CompletedMatches
      FROM Tournaments tr
      JOIN Sports s ON tr.SportID = s.SportID
      ORDER BY tr.StartDate ASC
    `);

    res.json({ success: true, count: result.recordset.length, data: result.recordset });
  } catch (error) {
    console.error("getAllTournaments error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET tournament by ID with all matches
const getTournamentById = async (req, res) => {
  try {
    const { id } = req.params;
    const pool = getPool();

    const tourRes = await pool.request()
      .input("TournamentID", sql.Int, id)
      .query(`
        SELECT tr.*, s.SportName
        FROM Tournaments tr
        JOIN Sports s ON tr.SportID = s.SportID
        WHERE tr.TournamentID = @TournamentID
      `);

    if (tourRes.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Tournament not found." });
    }

    const matchesRes = await pool.request()
      .input("TournamentID", sql.Int, id)
      .query(`
        SELECT 
          m.*, 
          t1.TeamName AS Team1Name, 
          t2.TeamName AS Team2Name,
          w.TeamName AS WinnerTeamName
        FROM TournamentMatches m
        LEFT JOIN Teams t1 ON m.Team1ID = t1.TeamID
        LEFT JOIN Teams t2 ON m.Team2ID = t2.TeamID
        LEFT JOIN Teams w ON m.WinnerTeamID = w.TeamID
        WHERE m.TournamentID = @TournamentID
        ORDER BY m.MatchDate ASC
      `);

    res.json({
      success: true,
      data: {
        ...tourRes.recordset[0],
        matches: matchesRes.recordset,
      },
    });
  } catch (error) {
    console.error("getTournamentById error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// CREATE a Tournament (Admin)
const createTournament = async (req, res) => {
  try {
    const { tournamentName, sportId, description, tournamentType, startDate, endDate, venue, prizePool, maxTeams, bannerUrl } = req.body;

    if (!tournamentName || !sportId || !startDate) {
      return res.status(400).json({ success: false, message: "Tournament name, sport, and start date are required." });
    }

    const pool = getPool();
    const result = await pool.request()
      .input("Name", sql.NVarChar(150), tournamentName)
      .input("SportID", sql.Int, sportId)
      .input("Desc", sql.NVarChar(1000), description || null)
      .input("Type", sql.NVarChar(50), tournamentType || "Knockout")
      .input("StartDate", sql.DateTime2, new Date(startDate))
      .input("EndDate", sql.DateTime2, endDate ? new Date(endDate) : null)
      .input("Venue", sql.NVarChar(200), venue || "Main Sports Complex")
      .input("PrizePool", sql.NVarChar(100), prizePool || null)
      .input("MaxTeams", sql.Int, maxTeams || 16)
      .input("BannerURL", sql.NVarChar(1000), bannerUrl || null)
      .query(`
        INSERT INTO Tournaments (TournamentName, SportID, Description, TournamentType, StartDate, EndDate, Venue, PrizePool, MaxTeams, Status, BannerURL, CreatedAt)
        OUTPUT INSERTED.*
        VALUES (@Name, @SportID, @Desc, @Type, @StartDate, @EndDate, @Venue, @PrizePool, @MaxTeams, 'Upcoming', @BannerURL, SYSDATETIME())
      `);

    await notifyAllMembers({
      title: `New Tournament Announced: ${tournamentName}! 🏆`,
      message: `Registration is open for the upcoming ${tournamentType} tournament at ${venue}. Check the tournament schedule!`,
      type: "event",
      link: "/user/events",
    });

    res.status(201).json({ success: true, message: "Tournament created successfully.", data: result.recordset[0] });
  } catch (error) {
    console.error("createTournament error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// CREATE / SCHEDULE A MATCH (Admin)
const createMatch = async (req, res) => {
  try {
    const { tournamentId, sportId, matchTitle, team1Id, team2Id, participant1Name, participant2Name, matchDate, venue, stage } = req.body;

    if (!sportId || !matchTitle || !matchDate) {
      return res.status(400).json({ success: false, message: "Sport, match title, and date are required." });
    }

    const pool = getPool();
    const result = await pool.request()
      .input("TournID", sql.Int, tournamentId || null)
      .input("SportID", sql.Int, sportId)
      .input("Title", sql.NVarChar(150), matchTitle)
      .input("T1", sql.Int, team1Id || null)
      .input("T2", sql.Int, team2Id || null)
      .input("P1", sql.NVarChar(100), participant1Name || null)
      .input("P2", sql.NVarChar(100), participant2Name || null)
      .input("MatchDate", sql.DateTime2, new Date(matchDate))
      .input("Venue", sql.NVarChar(200), venue || "Main Club Court")
      .input("Stage", sql.NVarChar(50), stage || "Group Stage")
      .query(`
        INSERT INTO TournamentMatches (TournamentID, SportID, MatchTitle, Team1ID, Team2ID, Participant1Name, Participant2Name, MatchDate, Venue, Stage, Status, CreatedAt)
        OUTPUT INSERTED.*
        VALUES (@TournID, @SportID, @Title, @T1, @T2, @P1, @P2, @MatchDate, @Venue, @Stage, 'Scheduled', SYSDATETIME())
      `);

    res.status(201).json({ success: true, message: "Match scheduled successfully.", data: result.recordset[0] });
  } catch (error) {
    console.error("createMatch error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// UPDATE MATCH (Scores, Winner, Status)
const updateMatch = async (req, res) => {
  try {
    const { matchId } = req.params;
    const { scoreTeam1, scoreTeam2, winnerTeamId, winnerName, status } = req.body;

    const pool = getPool();
    await pool.request()
      .input("MatchID", sql.Int, matchId)
      .input("Score1", sql.NVarChar(50), scoreTeam1 || null)
      .input("Score2", sql.NVarChar(50), scoreTeam2 || null)
      .input("WinnerTeamID", sql.Int, winnerTeamId || null)
      .input("WinnerName", sql.NVarChar(100), winnerName || null)
      .input("Status", sql.NVarChar(20), status || "Completed")
      .query(`
        UPDATE TournamentMatches
        SET ScoreTeam1 = @Score1,
            ScoreTeam2 = @Score2,
            WinnerTeamID = @WinnerTeamID,
            WinnerName = @WinnerName,
            Status = @Status
        WHERE MatchID = @MatchID
      `);

    res.json({ success: true, message: "Match score and status updated successfully." });
  } catch (error) {
    console.error("updateMatch error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};


/**
 * =========================================================================
 * 5. ATTENDANCE MANAGEMENT (Feature 12)
 * =========================================================================
 */

// GET Member's Attendance Log
const getMyAttendance = async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.UserID;
    const pool = getPool();

    const records = await pool.request()
      .input("UserID", sql.Int, userId)
      .query(`
        SELECT 
          a.AttendanceID, a.SessionDate, a.Status, a.Remarks, a.CreatedAt,
          s.SportID, s.SportName
        FROM Attendance a
        JOIN Sports s ON a.SportID = s.SportID
        WHERE a.UserID = @UserID
        ORDER BY a.SessionDate DESC
      `);

    const stats = await pool.request()
      .input("UserID", sql.Int, userId)
      .query(`
        SELECT 
          COUNT(*) AS TotalSessions,
          SUM(CASE WHEN Status = 'Present' THEN 1 ELSE 0 END) AS PresentCount,
          SUM(CASE WHEN Status = 'Late' THEN 1 ELSE 0 END) AS LateCount,
          SUM(CASE WHEN Status = 'Absent' THEN 1 ELSE 0 END) AS AbsentCount
        FROM Attendance
        WHERE UserID = @UserID
      `);

    const summary = stats.recordset[0];
    const total = summary.TotalSessions || 0;
    const present = (summary.PresentCount || 0) + (summary.LateCount || 0);
    const attendancePercentage = total > 0 ? Math.round((present / total) * 100) : 100;

    res.json({
      success: true,
      data: records.recordset,
      stats: {
        totalSessions: total,
        presentCount: summary.PresentCount || 0,
        lateCount: summary.LateCount || 0,
        absentCount: summary.AbsentCount || 0,
        attendancePercentage,
      },
    });
  } catch (error) {
    console.error("getMyAttendance error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET Attendance for a Sport & Date (Admin/Coach)
const getSportAttendance = async (req, res) => {
  try {
    const { sportId } = req.params;
    const date = req.query.date || new Date().toISOString().split("T")[0];
    const pool = getPool();

    // Get all enrolled members in this sport
    const enrolled = await pool.request()
      .input("SportID", sql.Int, sportId)
      .input("SessionDate", sql.Date, date)
      .query(`
        SELECT 
          u.UserID,
          u.FullName,
          u.Email,
          u.Phone,
          se.SkillLevel,
          a.AttendanceID,
          ISNULL(a.Status, 'Unmarked') AS AttendanceStatus,
          a.Remarks
        FROM SportEnrollments se
        JOIN Users u ON se.UserID = u.UserID
        LEFT JOIN Attendance a ON a.UserID = u.UserID AND a.SportID = @SportID AND a.SessionDate = @SessionDate
        WHERE se.SportID = @SportID AND se.Status = 'Active'
        ORDER BY u.FullName ASC
      `);

    res.json({ success: true, date, data: enrolled.recordset });
  } catch (error) {
    console.error("getSportAttendance error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// MARK ATTENDANCE (Bulk or Single) (Admin/Coach)
const markAttendance = async (req, res) => {
  try {
    const { sportId, sessionDate, records } = req.body;
    const markedBy = req.user?.userId || req.user?.UserID;

    if (!sportId || !sessionDate || !Array.isArray(records)) {
      return res.status(400).json({ success: false, message: "Sport ID, session date, and records array required." });
    }

    const pool = getPool();

    for (const r of records) {
      if (!r.userId || !r.status) continue;

      await pool.request()
        .input("UserID", sql.Int, r.userId)
        .input("SportID", sql.Int, sportId)
        .input("SessionDate", sql.Date, sessionDate)
        .input("Status", sql.NVarChar(20), r.status)
        .input("MarkedBy", sql.Int, markedBy)
        .input("Remarks", sql.NVarChar(250), r.remarks || null)
        .query(`
          IF EXISTS (SELECT 1 FROM Attendance WHERE UserID = @UserID AND SportID = @SportID AND SessionDate = @SessionDate)
          BEGIN
            UPDATE Attendance 
            SET Status = @Status, MarkedBy = @MarkedBy, Remarks = @Remarks, CreatedAt = SYSDATETIME()
            WHERE UserID = @UserID AND SportID = @SportID AND SessionDate = @SessionDate;
          END
          ELSE
          BEGIN
            INSERT INTO Attendance (UserID, SportID, SessionDate, Status, MarkedBy, Remarks, CreatedAt)
            VALUES (@UserID, @SportID, @SessionDate, @Status, @MarkedBy, @Remarks, SYSDATETIME());
          END
        `);
    }

    res.json({ success: true, message: `Attendance marked for ${records.length} members.` });
  } catch (error) {
    console.error("markAttendance error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};


/**
 * =========================================================================
 * 6. TRAINING SCHEDULES (Feature 13)
 * =========================================================================
 */

// GET All Training Schedules
const getTrainingSchedules = async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.request().query(`
      SELECT 
        ts.ScheduleID,
        ts.SportID,
        s.SportName,
        ts.CoachID,
        c.FullName AS CoachName,
        ts.SessionTitle,
        ts.DaysOfWeek,
        ts.StartTime,
        ts.EndTime,
        ts.Venue,
        ts.SkillLevel,
        ts.MaxCapacity,
        ts.IsActive,
        (SELECT COUNT(*) FROM SportEnrollments se WHERE se.SportID = ts.SportID AND se.Status = 'Active') AS EnrolledCount
      FROM TrainingSchedules ts
      JOIN Sports s ON ts.SportID = s.SportID
      LEFT JOIN Coaches c ON ts.CoachID = c.CoachID
      WHERE ts.IsActive = 1
      ORDER BY s.SportName ASC, ts.ScheduleID ASC
    `);

    res.json({ success: true, count: result.recordset.length, data: result.recordset });
  } catch (error) {
    console.error("getTrainingSchedules error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// CREATE Training Schedule (Admin)
const createTrainingSchedule = async (req, res) => {
  try {
    const { sportId, coachId, sessionTitle, daysOfWeek, startTime, endTime, venue, skillLevel, maxCapacity } = req.body;

    if (!sportId || !sessionTitle || !daysOfWeek || !startTime || !endTime) {
      return res.status(400).json({ success: false, message: "Sport, title, days, and times are required." });
    }

    const pool = getPool();
    const result = await pool.request()
      .input("SportID", sql.Int, sportId)
      .input("CoachID", sql.Int, coachId || null)
      .input("Title", sql.NVarChar(150), sessionTitle)
      .input("Days", sql.NVarChar(100), daysOfWeek)
      .input("Start", sql.NVarChar(20), startTime)
      .input("End", sql.NVarChar(20), endTime)
      .input("Venue", sql.NVarChar(200), venue || "Main Club Court")
      .input("Level", sql.NVarChar(50), skillLevel || "All Levels")
      .input("Cap", sql.Int, maxCapacity || 30)
      .query(`
        INSERT INTO TrainingSchedules (SportID, CoachID, SessionTitle, DaysOfWeek, StartTime, EndTime, Venue, SkillLevel, MaxCapacity, IsActive, CreatedAt)
        OUTPUT INSERTED.*
        VALUES (@SportID, @CoachID, @Title, @Days, @Start, @End, @Venue, @Level, @Cap, 1, SYSDATETIME())
      `);

    res.status(201).json({ success: true, message: "Training session scheduled successfully.", data: result.recordset[0] });
  } catch (error) {
    console.error("createTrainingSchedule error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE Training Schedule (Admin)
const deleteTrainingSchedule = async (req, res) => {
  try {
    const { id } = req.params;
    const pool = getPool();
    await pool.request()
      .input("ScheduleID", sql.Int, id)
      .query("DELETE FROM TrainingSchedules WHERE ScheduleID = @ScheduleID");

    res.json({ success: true, message: "Training schedule removed." });
  } catch (error) {
    console.error("deleteTrainingSchedule error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};


/**
 * =========================================================================
 * 7. PERFORMANCE TRACKING (Feature 16)
 * =========================================================================
 */

// GET Member's own Performance scorecard
const getMyPerformance = async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.UserID;
    const pool = getPool();

    const records = await pool.request()
      .input("UserID", sql.Int, userId)
      .query(`
        SELECT 
          mp.*, s.SportName, c.FullName AS CoachName
        FROM MemberPerformance mp
        JOIN Sports s ON mp.SportID = s.SportID
        LEFT JOIN Coaches c ON mp.CoachID = c.CoachID
        WHERE mp.UserID = @UserID
        ORDER BY mp.EvaluationDate DESC
      `);

    // Averages
    const avgRes = await pool.request()
      .input("UserID", sql.Int, userId)
      .query(`
        SELECT 
          AVG(FitnessScore) AS AvgFitness,
          AVG(SkillScore) AS AvgSkill,
          AVG(AttendanceScore) AS AvgAttendance,
          SUM(MatchesPlayed) AS TotalMatches,
          SUM(MatchesWon) AS TotalWins
        FROM MemberPerformance
        WHERE UserID = @UserID
      `);

    res.json({
      success: true,
      data: records.recordset,
      averages: avgRes.recordset[0] || {},
    });
  } catch (error) {
    console.error("getMyPerformance error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// RECORD Member Performance (Admin/Coach)
const recordMemberPerformance = async (req, res) => {
  try {
    const { userId, sportId, coachId, fitnessScore, skillScore, attendanceScore, matchesPlayed, matchesWon, coachFeedback, nextMilestones } = req.body;

    if (!userId || !sportId) {
      return res.status(400).json({ success: false, message: "User ID and Sport ID are required." });
    }

    const pool = getPool();
    const result = await pool.request()
      .input("UserID", sql.Int, userId)
      .input("SportID", sql.Int, sportId)
      .input("CoachID", sql.Int, coachId || null)
      .input("Fitness", sql.Int, fitnessScore || 85)
      .input("Skill", sql.Int, skillScore || 80)
      .input("Attendance", sql.Int, attendanceScore || 90)
      .input("Played", sql.Int, matchesPlayed || 0)
      .input("Won", sql.Int, matchesWon || 0)
      .input("Feedback", sql.NVarChar(1000), coachFeedback || null)
      .input("Milestones", sql.NVarChar(500), nextMilestones || null)
      .query(`
        INSERT INTO MemberPerformance (UserID, SportID, CoachID, EvaluationDate, FitnessScore, SkillScore, AttendanceScore, MatchesPlayed, MatchesWon, CoachFeedback, NextMilestones, CreatedAt)
        OUTPUT INSERTED.*
        VALUES (@UserID, @SportID, @CoachID, CAST(SYSDATETIME() AS DATE), @Fitness, @Skill, @Attendance, @Played, @Won, @Feedback, @Milestones, SYSDATETIME())
      `);

    // Notify member of progress report
    await notifyUser({
      userId,
      title: "Coach Performance Evaluation Updated! 📈",
      message: `Your coach submitted a new athletic evaluation report. Fitness: ${fitnessScore}%, Skill: ${skillScore}%.`,
      type: "sports",
      link: "/user/dashboard",
    });

    res.status(201).json({ success: true, message: "Performance evaluation saved.", data: result.recordset[0] });
  } catch (error) {
    console.error("recordMemberPerformance error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};


/**
 * =========================================================================
 * 8. EQUIPMENT MANAGEMENT (Feature 18)
 * =========================================================================
 */

// GET all equipment inventory
const getAllEquipment = async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.request().query(`
      SELECT 
        eq.*, s.SportName
      FROM Equipment eq
      JOIN Sports s ON eq.SportID = s.SportID
      ORDER BY s.SportName ASC, eq.ItemName ASC
    `);

    res.json({ success: true, count: result.recordset.length, data: result.recordset });
  } catch (error) {
    console.error("getAllEquipment error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// CREATE equipment item (Admin)
const createEquipment = async (req, res) => {
  try {
    const { sportId, itemName, category, totalQuantity, condition, storageLocation } = req.body;

    if (!sportId || !itemName) {
      return res.status(400).json({ success: false, message: "Sport and item name are required." });
    }

    const qty = totalQuantity ? parseInt(totalQuantity) : 1;
    const pool = getPool();
    const result = await pool.request()
      .input("SportID", sql.Int, sportId)
      .input("ItemName", sql.NVarChar(150), itemName)
      .input("Cat", sql.NVarChar(100), category || "Gear")
      .input("Tot", sql.Int, qty)
      .input("Avail", sql.Int, qty)
      .input("Cond", sql.NVarChar(50), condition || "Good")
      .input("Loc", sql.NVarChar(150), storageLocation || "Central Store")
      .query(`
        INSERT INTO Equipment (SportID, ItemName, Category, TotalQuantity, AvailableQuantity, Condition, StorageLocation, CreatedAt)
        OUTPUT INSERTED.*
        VALUES (@SportID, @ItemName, @Cat, @Tot, @Avail, @Cond, @Loc, SYSDATETIME())
      `);

    res.status(201).json({ success: true, message: "Equipment added to inventory.", data: result.recordset[0] });
  } catch (error) {
    console.error("createEquipment error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ISSUE equipment to a member (Admin)
const issueEquipment = async (req, res) => {
  try {
    const { equipmentId, userId, quantityIssued, expectedReturnDate, remarks } = req.body;

    if (!equipmentId || !userId) {
      return res.status(400).json({ success: false, message: "Equipment ID and Member User ID are required." });
    }

    const qty = quantityIssued ? parseInt(quantityIssued) : 1;
    const pool = getPool();

    // Check availability
    const eqRes = await pool.request()
      .input("EquipmentID", sql.Int, equipmentId)
      .query("SELECT AvailableQuantity, ItemName FROM Equipment WHERE EquipmentID = @EquipmentID");

    if (eqRes.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Equipment not found." });
    }

    const eq = eqRes.recordset[0];
    if (eq.AvailableQuantity < qty) {
      return res.status(400).json({ success: false, message: `Only ${eq.AvailableQuantity} units available.` });
    }

    // Insert issue record & decrement available
    await pool.request()
      .input("EquipmentID", sql.Int, equipmentId)
      .input("UserID", sql.Int, userId)
      .input("Qty", sql.Int, qty)
      .input("ExpectedReturnDate", sql.DateTime2, expectedReturnDate ? new Date(expectedReturnDate) : null)
      .input("Remarks", sql.NVarChar(250), remarks || null)
      .query(`
        INSERT INTO EquipmentIssues (EquipmentID, UserID, QuantityIssued, IssuedDate, ExpectedReturnDate, Status, Remarks)
        VALUES (@EquipmentID, @UserID, @Qty, SYSDATETIME(), @ExpectedReturnDate, 'Issued', @Remarks);

        UPDATE Equipment SET AvailableQuantity = AvailableQuantity - @Qty WHERE EquipmentID = @EquipmentID;
      `);

    await notifyUser({
      userId,
      title: "Equipment Issued 🎽",
      message: `You have checked out ${qty}x ${eq.ItemName}. Please return to the equipment desk after your training session.`,
      type: "sports",
      link: "/user/dashboard",
    });

    res.json({ success: true, message: `Successfully issued ${qty}x ${eq.ItemName} to member.` });
  } catch (error) {
    console.error("issueEquipment error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// RETURN equipment (Admin)
const returnEquipment = async (req, res) => {
  try {
    const { issueId } = req.params;
    const pool = getPool();

    const issueRes = await pool.request()
      .input("IssueID", sql.Int, issueId)
      .query("SELECT * FROM EquipmentIssues WHERE IssueID = @IssueID");

    if (issueRes.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Issue record not found." });
    }

    const issue = issueRes.recordset[0];
    if (issue.Status === "Returned") {
      return res.status(400).json({ success: false, message: "Item is already returned." });
    }

    await pool.request()
      .input("IssueID", sql.Int, issueId)
      .input("EquipmentID", sql.Int, issue.EquipmentID)
      .input("Qty", sql.Int, issue.QuantityIssued)
      .query(`
        UPDATE EquipmentIssues SET Status = 'Returned', ReturnDate = SYSDATETIME() WHERE IssueID = @IssueID;
        UPDATE Equipment SET AvailableQuantity = AvailableQuantity + @Qty WHERE EquipmentID = @EquipmentID;
      `);

    res.json({ success: true, message: "Equipment checked back in successfully." });
  } catch (error) {
    console.error("returnEquipment error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};


/**
 * =========================================================================
 * 9. REPORTS & ANALYTICS (Feature 19)
 * =========================================================================
 */

const getClubAnalyticsReport = async (req, res) => {
  try {
    const pool = getPool();

    // 1. Members count summary
    const membersSummary = await pool.request().query(`
      SELECT 
        COUNT(*) AS TotalUsers,
        SUM(CASE WHEN Role = 'user' THEN 1 ELSE 0 END) AS RegisteredAthletes,
        SUM(CASE WHEN Role = 'admin' THEN 1 ELSE 0 END) AS TotalStaff,
        (SELECT COUNT(*) FROM Memberships WHERE MembershipStatus = 'Active') AS ActiveMemberships,
        (SELECT COUNT(*) FROM Memberships WHERE MembershipStatus = 'PendingPayment') AS PendingMemberships,
        (SELECT COUNT(*) FROM Memberships WHERE MembershipStatus = 'Expired') AS ExpiredMemberships
      FROM Users
    `);

    // 2. Revenue Breakdown
    const revenueSummary = await pool.request().query(`
      SELECT 
        ISNULL(SUM(Amount), 0) AS TotalCollectedRevenue,
        (SELECT COUNT(*) FROM Payments WHERE PaymentStatus = 'Approved') AS TotalPaidTransactions,
        (SELECT COUNT(*) FROM Payments WHERE PaymentStatus = 'Pending') AS PendingVerifications,
        (SELECT ISNULL(SUM(BaseAmount + FineAmount), 0) FROM FeeVouchers WHERE VoucherStatus IN ('Unpaid', 'Overdue')) AS OutstandingDues
      FROM Payments
      WHERE PaymentStatus = 'Approved'
    `);

    // 3. Sports Popularity Ranking (Active Enrollments)
    const sportsRanking = await pool.request().query(`
      SELECT TOP 10
        s.SportID,
        s.SportName,
        COUNT(se.EnrollmentID) AS EnrolledAthletes
      FROM Sports s
      LEFT JOIN SportEnrollments se ON s.SportID = se.SportID AND se.Status = 'Active'
      GROUP BY s.SportID, s.SportName
      ORDER BY EnrolledAthletes DESC, s.SportName ASC
    `);

    // 4. Equipment Utilization
    const equipSummary = await pool.request().query(`
      SELECT 
        SUM(TotalQuantity) AS TotalInventory,
        SUM(AvailableQuantity) AS InStock,
        SUM(TotalQuantity - AvailableQuantity) AS CurrentlyIssued
      FROM Equipment
    `);

    // 5. Attendance overall percentage
    const attendanceSummary = await pool.request().query(`
      SELECT 
        COUNT(*) AS TotalMarkedSessions,
        SUM(CASE WHEN Status IN ('Present', 'Late') THEN 1 ELSE 0 END) AS AttendedCount
      FROM Attendance
    `);

    const attRec = attendanceSummary.recordset[0];
    const avgAttendanceRate = attRec.TotalMarkedSessions > 0
      ? Math.round((attRec.AttendedCount / attRec.TotalMarkedSessions) * 100)
      : 92;

    // 6. Tournaments & Events Count
    const eventsTourns = await pool.request().query(`
      SELECT 
        (SELECT COUNT(*) FROM Tournaments) AS TotalTournaments,
        (SELECT COUNT(*) FROM TournamentMatches) AS TotalMatchesScheduled,
        (SELECT COUNT(*) FROM Events) AS TotalClubEvents,
        (SELECT COUNT(*) FROM EventRegistrations) AS TotalEventRegistrations
    `);

    res.json({
      success: true,
      data: {
        members: membersSummary.recordset[0],
        revenue: revenueSummary.recordset[0],
        sportsRanking: sportsRanking.recordset,
        equipment: equipSummary.recordset[0],
        attendanceRate: avgAttendanceRate,
        tournamentsEvents: eventsTourns.recordset[0],
      },
    });
  } catch (error) {
    console.error("getClubAnalyticsReport error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  getSportsComprehensive,
  getAllCoaches,
  getCoachById,
  createCoach,
  updateCoach,
  deleteCoach,
  getMySportEnrollments,
  enrollInSport,
  dropSportEnrollment,
  getAllTeams,
  getTeamById,
  createTeam,
  addTeamMember,
  removeTeamMember,
  getAllTournaments,
  getTournamentById,
  createTournament,
  createMatch,
  updateMatch,
  getMyAttendance,
  getSportAttendance,
  markAttendance,
  getTrainingSchedules,
  createTrainingSchedule,
  deleteTrainingSchedule,
  getMyPerformance,
  recordMemberPerformance,
  getAllEquipment,
  createEquipment,
  issueEquipment,
  returnEquipment,
  getClubAnalyticsReport,
};

