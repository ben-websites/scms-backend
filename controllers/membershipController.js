const { sql, getPool } = require("../config/db");
const { notifyAdmins, notifyUser } = require("../utils/notificationService");

// SUBMIT MEMBERSHIP APPLICATION
const applyMembership = async (req, res) => {
  try {
    const { planId, address, emergencyContactName, emergencyContactPhone } = req.body;
    const userId = req.user.userId;

    if (!planId) {
      return res.status(400).json({
        success: false,
        message: "Please select a membership plan.",
      });
    }

    const pool = getPool();

    // Verify the plan exists and is active
    const planCheck = await pool
      .request()
      .input("PlanID", sql.Int, planId)
      .query("SELECT PlanID, PlanName, MonthlyFee, DurationMonths FROM MembershipPlans WHERE PlanID = @PlanID AND IsActive = 1");

    if (planCheck.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Selected membership plan is invalid or inactive.",
      });
    }

    // Check if user already has an active or pending membership application
    const existingCheck = await pool
      .request()
      .input("UserID", sql.Int, userId)
      .query(`
        SELECT ApplicationID, ApplicationStatus
        FROM MembershipApplications
        WHERE UserID = @UserID AND ApplicationStatus IN ('Pending', 'Approved')
      `);

    if (existingCheck.recordset.length > 0) {
      const existingStatus = existingCheck.recordset[0].ApplicationStatus;
      if (existingStatus === "Approved") {
        return res.status(409).json({
          success: false,
          message: "You already have an active membership with Sports Hub.",
        });
      } else {
        return res.status(409).json({
          success: false,
          message: "You already have a pending membership application undergoing admin review.",
        });
      }
    }

    // Insert into MembershipApplications
    const appResult = await pool
      .request()
      .input("UserID", sql.Int, userId)
      .input("PlanID", sql.Int, planId)
      .input("Address", sql.NVarChar(255), address ? address.trim() : null)
      .input("EmergencyContactName", sql.NVarChar(100), emergencyContactName ? emergencyContactName.trim() : null)
      .input("EmergencyContactPhone", sql.NVarChar(20), emergencyContactPhone ? emergencyContactPhone.trim() : null)
      .query(`
        INSERT INTO MembershipApplications (
          UserID,
          PlanID,
          Address,
          EmergencyContactName,
          EmergencyContactPhone,
          ApplicationStatus,
          AppliedAt
        )
        OUTPUT INSERTED.ApplicationID
        VALUES (
          @UserID,
          @PlanID,
          @Address,
          @EmergencyContactName,
          @EmergencyContactPhone,
          'Pending',
          SYSDATETIME()
        )
      `);

    const applicationId = appResult.recordset[0].ApplicationID;
    const tempMembershipNumber = `APP-${String(applicationId).padStart(4, "0")}`;

    // Create a pending record in Memberships (allowed CK_Membership_Status values: 'PendingPayment', 'Active', 'Suspended', 'Expired')
    await pool
      .request()
      .input("MembershipNumber", sql.NVarChar(50), tempMembershipNumber)
      .input("ApplicationID", sql.Int, applicationId)
      .input("UserID", sql.Int, userId)
      .input("PlanID", sql.Int, planId)
      .query(`
        INSERT INTO Memberships (
          MembershipNumber,
          ApplicationID,
          UserID,
          PlanID,
          MembershipStatus,
          CreatedAt
        )
        VALUES (
          @MembershipNumber,
          @ApplicationID,
          @UserID,
          @PlanID,
          'PendingPayment',
          SYSDATETIME()
        )
      `);

    const selectedPlan = planCheck.recordset[0];
    const userRes = await pool.request().input("UID", sql.Int, userId).query("SELECT FullName FROM Users WHERE UserID = @UID");
    const userName = userRes.recordset[0]?.FullName || "Member";

    await Promise.all([
      notifyUser({
        userId,
        title: "Membership Application Received 📋",
        message: `Your application for '${selectedPlan.PlanName}' (PKR ${selectedPlan.MonthlyFee}/mo) has been submitted. Admin is currently reviewing your application.`,
        type: "membership",
        link: "/user/membership",
      }),
      notifyAdmins({
        title: "New Membership Application",
        message: `${userName} applied for '${selectedPlan.PlanName}'. Application ID: #${applicationId}.`,
        type: "membership",
        link: "/admin/memberships",
      }),
    ]);

    return res.status(201).json({
      success: true,
      message: "Membership application submitted successfully! Your dashboard is now active.",
      applicationId,
    });
  } catch (error) {
    console.error("applyMembership error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to submit membership application. " + error.message,
    });
  }
};

// GET MY MEMBERSHIP STATUS & DETAILS
const getMyMembership = async (req, res) => {
  try {
    const userId = req.user.userId;
    const pool = getPool();

    const result = await pool
      .request()
      .input("UserID", sql.Int, userId)
      .query(`
        SELECT TOP 1
          m.MembershipID,
          m.MembershipNumber,
          m.MembershipStatus,
          m.StartDate,
          m.EndDate,
          m.CreatedAt AS MembershipCreatedAt,
          a.ApplicationID,
          a.ApplicationStatus,
          a.Address,
          a.EmergencyContactName,
          a.EmergencyContactPhone,
          a.AppliedAt,
          a.AdminRemarks,
          p.PlanID,
          p.PlanName,
          p.Description AS PlanDescription,
          p.MonthlyFee,
          p.DurationMonths,
          u.FullName,
          u.Email,
          u.Phone
        FROM Users u
        LEFT JOIN MembershipApplications a ON a.UserID = u.UserID
        LEFT JOIN Memberships m ON m.ApplicationID = a.ApplicationID
        LEFT JOIN MembershipPlans p ON p.PlanID = a.PlanID
        WHERE u.UserID = @UserID
        ORDER BY a.AppliedAt DESC
      `);

    if (result.recordset.length === 0 || !result.recordset[0].ApplicationID) {
      return res.status(200).json({
        success: true,
        hasMembership: false,
        membership: null,
      });
    }

    return res.status(200).json({
      success: true,
      hasMembership: true,
      membership: result.recordset[0],
    });
  } catch (error) {
    console.error("getMyMembership error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load membership details.",
    });
  }
};

// GET DIGITAL CARD DATA
const getDigitalCard = async (req, res) => {
  try {
    const userId = req.user.userId;
    const pool = getPool();

    const result = await pool
      .request()
      .input("UserID", sql.Int, userId)
      .query(`
        SELECT TOP 1
          m.MembershipID,
          m.MembershipNumber,
          m.MembershipStatus,
          m.StartDate,
          m.EndDate,
          p.PlanName,
          p.MonthlyFee,
          u.FullName,
          u.Email,
          u.Phone,
          u.CreatedAt AS MemberSince
        FROM Memberships m
        INNER JOIN Users u ON u.UserID = m.UserID
        INNER JOIN MembershipPlans p ON p.PlanID = m.PlanID
        WHERE m.UserID = @UserID
        ORDER BY m.CreatedAt DESC
      `);

    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No membership found for this account.",
      });
    }

    return res.status(200).json({
      success: true,
      card: result.recordset[0],
    });
  } catch (error) {
    console.error("getDigitalCard error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve digital card.",
    });
  }
};

module.exports = {
  applyMembership,
  getMyMembership,
  getDigitalCard,
};
