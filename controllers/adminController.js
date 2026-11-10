const { sql, getPool } = require("../config/db");
const { calculateVoucherFine, getFineSetting, getDefaultDueDay } = require("../utils/fineCalculator");
const {
  createNotification,
  notifyAdmins,
  notifyUser,
  notifyAllMembers,
} = require("../utils/notificationService");

const MONTH_NAMES = [
  "", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// HELPER: Log Admin Action
const logAdminAction = async (adminId, actionType, description, entityName = null, entityId = null) => {
  try {
    const pool = getPool();
    await pool
      .request()
      .input("AdminID", sql.Int, adminId)
      .input("ActionType", sql.NVarChar(100), actionType)
      .input("Description", sql.NVarChar(sql.MAX), description)
      .input("EntityName", sql.NVarChar(100), entityName)
      .input("EntityID", sql.Int, entityId)
      .query(`
        INSERT INTO AdminLogs (AdminID, ActionType, Description, EntityName, EntityID, CreatedAt)
        VALUES (@AdminID, @ActionType, @Description, @EntityName, @EntityID, SYSDATETIME())
      `);
  } catch (err) {
    console.error("Failed to write admin log:", err.message);
  }
};

// HELPER: Issue one voucher for a membership. Returns the created voucher or
// null when an equivalent voucher already exists (idempotent).
const issueVoucherForMembership = async ({
  membershipId,
  voucherType,
  amount,
  billingMonth = null,
  billingYear = null,
  dueDate,
  voucherNumber,
}) => {
  const pool = getPool();

  // A zero-value charge is never billed (e.g. a plan with no admission fee).
  if (!amount || Number(amount) <= 0) return null;

  const existing =
    voucherType === "Monthly"
      ? await pool
          .request()
          .input("MembershipID", sql.Int, membershipId)
          .input("BillingMonth", sql.Int, billingMonth)
          .input("BillingYear", sql.Int, billingYear)
          .query(`
            SELECT VoucherID FROM FeeVouchers
            WHERE MembershipID = @MembershipID AND VoucherType = 'Monthly'
              AND BillingMonth = @BillingMonth AND BillingYear = @BillingYear
          `)
      : await pool
          .request()
          .input("MembershipID", sql.Int, membershipId)
          .input("VoucherType", sql.NVarChar(20), voucherType)
          .query(`
            SELECT VoucherID FROM FeeVouchers
            WHERE MembershipID = @MembershipID AND VoucherType = @VoucherType
          `);

  if (existing.recordset.length > 0) return null;

  const created = await pool
    .request()
    .input("VoucherNumber", sql.NVarChar(50), voucherNumber)
    .input("MembershipID", sql.Int, membershipId)
    .input("VoucherType", sql.NVarChar(20), voucherType)
    .input("BillingMonth", sql.Int, billingMonth)
    .input("BillingYear", sql.Int, billingYear)
    .input("BaseAmount", sql.Decimal(10, 2), amount)
    .input("DueDate", sql.Date, dueDate)
    .query(`
      INSERT INTO FeeVouchers (
        VoucherNumber, MembershipID, VoucherType, BillingMonth, BillingYear,
        BaseAmount, FineAmount, DueDate, VoucherStatus, CreatedAt
      )
      OUTPUT INSERTED.VoucherID, INSERTED.VoucherNumber, INSERTED.BaseAmount
      VALUES (
        @VoucherNumber, @MembershipID, @VoucherType, @BillingMonth, @BillingYear,
        @BaseAmount, 0, @DueDate, 'Unpaid', SYSDATETIME()
      )
    `);

  return created.recordset[0] || null;
};

// 1. ADMIN DASHBOARD STATS
const getDashboardStats = async (req, res) => {
  try {
    const pool = getPool();
    const finePerDay = await getFineSetting();

    // 1. Overview counts
    const counts = await pool.request().query(`
      SELECT
        (SELECT COUNT(*) FROM Users) AS TotalUsers,
        (SELECT COUNT(*) FROM Users WHERE Role = 'user') AS TotalRegisteredUsers,
        (SELECT COUNT(*) FROM Memberships WHERE MembershipStatus = 'Active') AS ActiveMembers,
        (SELECT COUNT(*) FROM MembershipApplications WHERE ApplicationStatus = 'Pending') AS PendingApplications,
        (SELECT COUNT(*) FROM Payments WHERE PaymentStatus = 'Pending') AS PendingPayments,
        (SELECT ISNULL(SUM(Amount), 0) FROM Payments WHERE PaymentStatus = 'Approved') AS TotalRevenue,
        (SELECT COUNT(*) FROM FeeVouchers WHERE VoucherStatus = 'Unpaid') AS UnpaidVouchersCount
    `);

    // 2. Recent applications
    const recentApplications = await pool.request().query(`
      SELECT TOP 5
        a.ApplicationID,
        a.UserID,
        a.PlanID,
        a.ApplicationStatus,
        a.AppliedAt,
        u.FullName,
        u.Email,
        u.Phone,
        p.PlanName,
        p.MonthlyFee
      FROM MembershipApplications a
      INNER JOIN Users u ON u.UserID = a.UserID
      INNER JOIN MembershipPlans p ON p.PlanID = a.PlanID
      ORDER BY a.AppliedAt DESC
    `);

    // 3. Recent payment submissions
    const recentPayments = await pool.request().query(`
      SELECT TOP 5
        p.PaymentID,
        p.Amount,
        p.PaymentMethod,
        p.PaymentStatus,
        p.TransactionReference,
        p.SubmittedAt,
        v.VoucherNumber,
        v.VoucherType,
        u.FullName,
        r.ImageURL AS ReceiptImageURL
      FROM Payments p
      INNER JOIN FeeVouchers v ON v.VoucherID = p.VoucherID
      INNER JOIN Memberships m ON m.MembershipID = v.MembershipID
      INNER JOIN Users u ON u.UserID = m.UserID
      LEFT JOIN PaymentReceipts r ON r.PaymentID = p.PaymentID
      ORDER BY p.SubmittedAt DESC
    `);

    // 4. Overdue vouchers count & total overdue amount
    const allUnpaid = await pool.request().query(`
      SELECT BaseAmount, FineAmount, DueDate, VoucherStatus
      FROM FeeVouchers
      WHERE VoucherStatus IN ('Unpaid', 'PendingVerification', 'Pending_Approval')
    `);

    let overdueCount = 0;
    let overdueFinesTotal = 0;
    allUnpaid.recordset.forEach((v) => {
      const fineInfo = calculateVoucherFine(v, finePerDay);
      if (fineInfo.isOverdue) {
        overdueCount++;
        overdueFinesTotal += fineInfo.fineAmount;
      }
    });

    return res.status(200).json({
      success: true,
      stats: {
        ...counts.recordset[0],
        overdueCount,
        overdueFinesTotal,
        finePerDay,
      },
      recentApplications: recentApplications.recordset,
      recentPayments: recentPayments.recordset,
    });
  } catch (error) {
    console.error("getDashboardStats error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load dashboard metrics.",
    });
  }
};

// 2. USER MANAGEMENT
const getAllUsers = async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.request().query(`
      SELECT
        u.UserID,
        u.FullName,
        u.Email,
        u.Phone,
        u.Role,
        u.IsActive,
        u.CreatedAt,
        m.MembershipNumber,
        m.MembershipStatus,
        p.PlanName
      FROM Users u
      LEFT JOIN Memberships m ON m.UserID = u.UserID
      LEFT JOIN MembershipPlans p ON p.PlanID = m.PlanID
      ORDER BY u.CreatedAt DESC
    `);

    return res.status(200).json({
      success: true,
      users: result.recordset,
    });
  } catch (error) {
    console.error("getAllUsers error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch users.",
    });
  }
};

const toggleUserStatus = async (req, res) => {
  try {
    const targetUserId = req.params.id;
    const adminId = req.user.userId;
    const pool = getPool();

    const userRes = await pool
      .request()
      .input("UserID", sql.Int, targetUserId)
      .query("SELECT UserID, FullName, IsActive, Role FROM Users WHERE UserID = @UserID");

    if (userRes.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const current = userRes.recordset[0];
    const newStatus = current.IsActive ? 0 : 1;

    await pool
      .request()
      .input("UserID", sql.Int, targetUserId)
      .input("IsActive", sql.Bit, newStatus)
      .query("UPDATE Users SET IsActive = @IsActive WHERE UserID = @UserID");

    await logAdminAction(
      adminId,
      "USER_STATUS_TOGGLE",
      `Toggled status for user ${current.FullName} to ${newStatus ? "Active" : "Inactive"}`,
      "Users",
      targetUserId
    );

    await Promise.all([
      notifyUser({
        userId: targetUserId,
        title: "Account Status Update",
        message: `Your account access has been ${newStatus ? "activated" : "deactivated"} by club administration.`,
        type: "system",
      }),
      notifyAdmins({
        title: "User Status Changed",
        message: `User ${current.FullName} was set to ${newStatus ? "Active" : "Inactive"}.`,
        type: "admin",
        link: "/admin/users",
      }),
    ]);

    return res.status(200).json({
      success: true,
      message: `User account has been ${newStatus ? "activated" : "deactivated"}.`,
    });
  } catch (error) {
    console.error("toggleUserStatus error:", error);
    return res.status(500).json({ success: false, message: "Failed to update user status." });
  }
};

// 3. MEMBERSHIP APPLICATIONS MANAGEMENT
const getAllApplications = async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.request().query(`
      SELECT
        a.ApplicationID,
        a.UserID,
        a.PlanID,
        a.Address,
        a.EmergencyContactName,
        a.EmergencyContactPhone,
        a.ApplicationStatus,
        a.AdminRemarks,
        a.ReviewedBy,
        a.ReviewedAt,
        a.AppliedAt,
        u.FullName,
        u.Email,
        u.Phone,
        p.PlanName,
        p.MonthlyFee,
        p.DurationMonths,
        reviewer.FullName AS ReviewerName
      FROM MembershipApplications a
      INNER JOIN Users u ON u.UserID = a.UserID
      INNER JOIN MembershipPlans p ON p.PlanID = a.PlanID
      LEFT JOIN Users reviewer ON reviewer.UserID = a.ReviewedBy
      ORDER BY a.AppliedAt DESC
    `);

    return res.status(200).json({
      success: true,
      applications: result.recordset,
    });
  } catch (error) {
    console.error("getAllApplications error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch applications.",
    });
  }
};

const reviewApplication = async (req, res) => {
  try {
    const applicationId = req.params.id;
    const { action, remarks } = req.body; // action: 'approve' | 'reject'
    const adminId = req.user.userId;

    if (!["approve", "reject"].includes(action?.toLowerCase())) {
      return res.status(400).json({
        success: false,
        message: "Action must be 'approve' or 'reject'.",
      });
    }

    const pool = getPool();

    // Get application details
    const appRes = await pool
      .request()
      .input("ApplicationID", sql.Int, applicationId)
      .query(`
        SELECT a.ApplicationID, a.UserID, a.PlanID, a.ApplicationStatus, p.DurationMonths,
               p.AdmissionFee, p.MonthlyFee, p.PlanName, u.FullName
        FROM MembershipApplications a
        INNER JOIN MembershipPlans p ON p.PlanID = a.PlanID
        INNER JOIN Users u ON u.UserID = a.UserID
        WHERE a.ApplicationID = @ApplicationID
      `);

    if (appRes.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Application not found." });
    }

    const app = appRes.recordset[0];
    const isApprove = action.toLowerCase() === "approve";
    const newStatus = isApprove ? "Approved" : "Rejected";

    // 1. Update MembershipApplications
    await pool
      .request()
      .input("ApplicationID", sql.Int, applicationId)
      .input("Status", sql.NVarChar(50), newStatus)
      .input("AdminRemarks", sql.NVarChar(255), remarks ? remarks.trim() : null)
      .input("ReviewedBy", sql.Int, adminId)
      .query(`
        UPDATE MembershipApplications
        SET
          ApplicationStatus = @Status,
          AdminRemarks = @AdminRemarks,
          ReviewedBy = @ReviewedBy,
          ReviewedAt = SYSDATETIME()
        WHERE ApplicationID = @ApplicationID
      `);

    // 2. Update or Insert Memberships
    if (isApprove) {
      const year = new Date().getFullYear();
      const membershipNumber = `SCMS-${year}-${String(app.ApplicationID).padStart(4, "0")}`;
      const startDate = new Date();
      const endDate = new Date();
      endDate.setMonth(endDate.getMonth() + app.DurationMonths);

      await pool
        .request()
        .input("ApplicationID", sql.Int, applicationId)
        .input("MembershipNumber", sql.NVarChar(50), membershipNumber)
        .input("StartDate", sql.Date, startDate)
        .input("EndDate", sql.Date, endDate)
        .query(`
          UPDATE Memberships
          SET
            MembershipNumber = @MembershipNumber,
            MembershipStatus = 'Active',
            StartDate = @StartDate,
            EndDate = @EndDate
          WHERE ApplicationID = @ApplicationID
        `);

      // ---------------------------------------------------------
      // Issue the member's first vouchers the moment they are approved:
      //   1. one-time Admission Fee
      //   2. the monthly fee of the month the member enrolled in
      // ---------------------------------------------------------
      const membershipRes = await pool
        .request()
        .input("ApplicationID", sql.Int, applicationId)
        .query("SELECT MembershipID FROM Memberships WHERE ApplicationID = @ApplicationID");

      const membershipId = membershipRes.recordset[0]?.MembershipID;
      const now = new Date();
      const periodMonth = now.getMonth() + 1;
      const periodYear = now.getFullYear();
      const dueDay = await getDefaultDueDay();
      const issuedVouchers = [];

      if (membershipId) {
        const admissionVoucher = await issueVoucherForMembership({
          membershipId,
          voucherType: "Admission",
          amount: Number(app.AdmissionFee) || 0,
          dueDate: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
          voucherNumber: `ADM-${periodYear}-${String(membershipId).padStart(4, "0")}`,
        });
        if (admissionVoucher) issuedVouchers.push(admissionVoucher);

        const prepaid = await pool
          .request()
          .input("MembershipID", sql.Int, membershipId)
          .input("Month", sql.Int, periodMonth)
          .input("Year", sql.Int, periodYear)
          .query(`
            SELECT PrepaymentID FROM MemberPrepayments
            WHERE MembershipID = @MembershipID AND BillingMonth = @Month AND BillingYear = @Year
          `);

        if (prepaid.recordset.length === 0) {
          const monthlyVoucher = await issueVoucherForMembership({
            membershipId,
            voucherType: "Monthly",
            amount: Number(app.MonthlyFee) || 0,
            billingMonth: periodMonth,
            billingYear: periodYear,
            dueDate: new Date(periodYear, periodMonth - 1, dueDay),
            voucherNumber: `VCH-${periodYear}${String(periodMonth).padStart(2, "0")}-${String(membershipId).padStart(4, "0")}`,
          });
          if (monthlyVoucher) issuedVouchers.push(monthlyVoucher);
        }
      }

      await logAdminAction(
        adminId,
        "APPLICATION_APPROVED",
        `Approved membership application #${applicationId} for ${app.FullName}. Assigned Membership Number ${membershipNumber}. ` +
          `Vouchers issued: ${issuedVouchers.map((v) => v.VoucherNumber).join(", ") || "none"}.`,
        "Memberships",
        applicationId
      );

      const voucherNote = issuedVouchers.length
        ? ` Admission fee (Rs ${Number(app.AdmissionFee || 0).toLocaleString()}) and ${MONTH_NAMES[periodMonth]} ${periodYear} monthly fee vouchers have been added to your ledger.`
        : "";

      await Promise.all([
        notifyUser({
          userId: app.UserID,
          title: "Membership Approved! 🎉",
          message: `Congratulations! Your membership has been approved with Number ${membershipNumber}. Your digital pass and all sports facilities are now active.${voucherNote}`,
          type: "membership",
          link: "/user/vouchers",
        }),
        notifyAdmins({
          title: "Membership Approved",
          message: `Application #${applicationId} for ${app.FullName} was approved (${membershipNumber}).`,
          type: "admin",
          link: "/admin/memberships",
        }),
      ]);
    } else {
      await pool
        .request()
        .input("ApplicationID", sql.Int, applicationId)
        .query(`
          UPDATE Memberships
          SET MembershipStatus = 'Expired'
          WHERE ApplicationID = @ApplicationID
        `);

      await logAdminAction(
        adminId,
        "APPLICATION_REJECTED",
        `Rejected membership application #${applicationId} for ${app.FullName}. Remarks: ${remarks || "None"}`,
        "MembershipApplications",
        applicationId
      );

      await Promise.all([
        notifyUser({
          userId: app.UserID,
          title: "Application Reviewed",
          message: `Your membership application was reviewed: ${remarks ? remarks : "Please contact club management for more information."}`,
          type: "membership",
          link: "/user/membership",
        }),
        notifyAdmins({
          title: "Membership Rejected",
          message: `Application #${applicationId} for ${app.FullName} was declined. Remarks: ${remarks || "None"}.`,
          type: "admin",
          link: "/admin/memberships",
        }),
      ]);
    }

    return res.status(200).json({
      success: true,
      message: `Membership application has been ${newStatus.toLowerCase()}.`,
    });
  } catch (error) {
    console.error("reviewApplication error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to process application review.",
    });
  }
};

// 4. MEMBERSHIP PLANS CRUD
const getAllPlansAdmin = async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.request().query("SELECT * FROM MembershipPlans ORDER BY CreatedAt DESC");
    return res.status(200).json({ success: true, plans: result.recordset });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to load plans." });
  }
};

const createPlan = async (req, res) => {
  try {
    const { planName, description, monthlyFee, durationMonths, admissionFee } = req.body;
    const adminId = req.user.userId;

    if (!planName || !monthlyFee || !durationMonths) {
      return res.status(400).json({ success: false, message: "Plan name, monthly fee, and duration are required." });
    }

    const pool = getPool();
    const result = await pool
      .request()
      .input("PlanName", sql.NVarChar(100), planName.trim())
      .input("Description", sql.NVarChar(sql.MAX), description ? description.trim() : null)
      .input("MonthlyFee", sql.Decimal(10, 2), Number(monthlyFee))
      .input("AdmissionFee", sql.Decimal(10, 2), Number.isFinite(Number(admissionFee)) ? Number(admissionFee) : 3000)
      .input("DurationMonths", sql.Int, parseInt(durationMonths, 10))
      .query(`
        INSERT INTO MembershipPlans (PlanName, Description, MonthlyFee, AdmissionFee, DurationMonths, IsActive, CreatedAt)
        OUTPUT INSERTED.PlanID
        VALUES (@PlanName, @Description, @MonthlyFee, @AdmissionFee, @DurationMonths, 1, SYSDATETIME())
      `);

    const planId = result.recordset[0].PlanID;
    await logAdminAction(adminId, "PLAN_CREATED", `Created new membership plan "${planName}"`, "MembershipPlans", planId);

    await Promise.all([
      notifyAllMembers({
        title: `✨ New Membership Tier: ${planName.trim()}`,
        message: `${planName.trim()} is now open for enrolment at PKR ${Number(monthlyFee).toLocaleString()}/mo. Duration: ${durationMonths} month(s).`,
        type: "membership",
        link: "/user/membership",
      }),
      notifyAdmins({
        title: "Plan Created",
        message: `Plan '${planName.trim()}' was added to active offerings.`,
        type: "admin",
        link: "/admin/plans",
      }),
    ]);

    return res.status(201).json({ success: true, message: "Membership plan created successfully.", planId });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to create plan." });
  }
};

const updatePlan = async (req, res) => {
  try {
    const planId = req.params.id;
    const { planName, description, monthlyFee, durationMonths, isActive, admissionFee } = req.body;
    const adminId = req.user.userId;

    const pool = getPool();
    await pool
      .request()
      .input("PlanID", sql.Int, planId)
      .input("PlanName", sql.NVarChar(100), planName.trim())
      .input("Description", sql.NVarChar(sql.MAX), description ? description.trim() : null)
      .input("MonthlyFee", sql.Decimal(10, 2), Number(monthlyFee))
      .input("AdmissionFee", sql.Decimal(10, 2), Number.isFinite(Number(admissionFee)) ? Number(admissionFee) : 3000)
      .input("DurationMonths", sql.Int, parseInt(durationMonths, 10))
      .input("IsActive", sql.Bit, isActive !== undefined ? (isActive ? 1 : 0) : 1)
      .query(`
        UPDATE MembershipPlans
        SET
          PlanName = @PlanName,
          Description = @Description,
          MonthlyFee = @MonthlyFee,
          AdmissionFee = @AdmissionFee,
          DurationMonths = @DurationMonths,
          IsActive = @IsActive
        WHERE PlanID = @PlanID
      `);

    await logAdminAction(adminId, "PLAN_UPDATED", `Updated membership plan #${planId}`, "MembershipPlans", planId);

    return res.status(200).json({ success: true, message: "Plan updated successfully." });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to update plan." });
  }
};

const deletePlan = async (req, res) => {
  try {
    const planId = req.params.id;
    const adminId = req.user.userId;
    const pool = getPool();

    // Check if any active memberships or applications exist with this plan
    const check = await pool
      .request()
      .input("PlanID", sql.Int, planId)
      .query("SELECT COUNT(*) AS count FROM MembershipApplications WHERE PlanID = @PlanID");

    if (check.recordset[0].count > 0) {
      // Soft-delete by setting IsActive = 0
      await pool
        .request()
        .input("PlanID", sql.Int, planId)
        .query("UPDATE MembershipPlans SET IsActive = 0 WHERE PlanID = @PlanID");

      return res.status(200).json({
        success: true,
        message: "Plan has existing applications and was deactivated instead of deleted.",
      });
    }

    await pool.request().input("PlanID", sql.Int, planId).query("DELETE FROM MembershipPlans WHERE PlanID = @PlanID");
    await logAdminAction(adminId, "PLAN_DELETED", `Deleted plan #${planId}`, "MembershipPlans", planId);

    return res.status(200).json({ success: true, message: "Plan deleted successfully." });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to delete plan." });
  }
};

// 5. MONTHLY FEE VOUCHERS GENERATION (WITH ADVANCE PREPAYMENT SKIP LOGIC)
const generateMonthlyVouchers = async (req, res) => {
  try {
    const { billingMonth, billingYear, month: mProp, year: yProp, dueDay } = req.body || {};
    const adminId = req.user.userId;

    // Billing is hard-locked to the CURRENT calendar month. Admins can no
    // longer back-date or pre-date a voucher batch.
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();

    const requestedMonth = parseInt(billingMonth || mProp, 10);
    const requestedYear = parseInt(billingYear || yProp, 10);

    if (
      (requestedMonth && requestedMonth !== month) ||
      (requestedYear && requestedYear !== year)
    ) {
      return res.status(400).json({
        success: false,
        message: `Monthly vouchers can only be published for the current period (${MONTH_NAMES[month]} ${year}). Past and future months are locked.`,
      });
    }

    const targetDueDay = parseInt(dueDay, 10) || (await getDefaultDueDay());
    const pool = getPool();

    // Only ONE batch per month. If a monthly voucher already exists for the
    // current period, the month has been pitched and cannot be re-published.
    const batchCheck = await pool
      .request()
      .input("Month", sql.Int, month)
      .input("Year", sql.Int, year)
      .query(`
        SELECT TOP 1 VoucherNumber, CreatedAt
        FROM FeeVouchers
        WHERE VoucherType = 'Monthly' AND BillingMonth = @Month AND BillingYear = @Year
      `);

    if (batchCheck.recordset.length > 0) {
      return res.status(409).json({
        success: false,
        message: `Vouchers for ${MONTH_NAMES[month]} ${year} have already been published. A month can only be pitched once.`,
      });
    }

    // Due date
    const dueDate = new Date(year, month - 1, targetDueDay);

    // Fetch all active members with their plan monthly fees
    const membersRes = await pool.request().query(`
      SELECT
        m.MembershipID,
        m.MembershipNumber,
        p.MonthlyFee,
        u.FullName
      FROM Memberships m
      INNER JOIN MembershipPlans p ON p.PlanID = m.PlanID
      INNER JOIN Users u ON u.UserID = m.UserID
      WHERE m.MembershipStatus = 'Active'
    `);

    const activeMembers = membersRes.recordset;

    let generatedCount = 0;
    let skippedPrepaidCount = 0;
    let alreadyGeneratedCount = 0;

    for (const member of activeMembers) {
      const membershipId = member.MembershipID;

      // 1. CRITICAL CHECK: Has member already paid for this month in advance?
      const prepaidCheck = await pool
        .request()
        .input("MembershipID", sql.Int, membershipId)
        .input("Month", sql.Int, month)
        .input("Year", sql.Int, year)
        .query(`
          SELECT PrepaymentID
          FROM MemberPrepayments
          WHERE MembershipID = @MembershipID AND BillingMonth = @Month AND BillingYear = @Year
        `);

      if (prepaidCheck.recordset.length > 0) {
        skippedPrepaidCount++;
        continue; // SKIP generation! This month was paid in advance!
      }

      // 2. CHECK: Has a monthly voucher already been generated for this month/year?
      const existingVoucherCheck = await pool
        .request()
        .input("MembershipID", sql.Int, membershipId)
        .input("Month", sql.Int, month)
        .input("Year", sql.Int, year)
        .query(`
          SELECT VoucherID
          FROM FeeVouchers
          WHERE MembershipID = @MembershipID AND VoucherType = 'Monthly' AND BillingMonth = @Month AND BillingYear = @Year
        `);

      if (existingVoucherCheck.recordset.length > 0) {
        alreadyGeneratedCount++;
        continue;
      }

      // 3. Generate Voucher
      const voucherNumber = `VCH-${year}${String(month).padStart(2, "0")}-${String(membershipId).padStart(4, "0")}`;

      await pool
        .request()
        .input("VoucherNumber", sql.NVarChar(50), voucherNumber)
        .input("MembershipID", sql.Int, membershipId)
        .input("VoucherType", sql.NVarChar(50), "Monthly")
        .input("BillingMonth", sql.Int, month)
        .input("BillingYear", sql.Int, year)
        .input("BaseAmount", sql.Decimal(10, 2), member.MonthlyFee)
        .input("FineAmount", sql.Decimal(10, 2), 0)
        .input("DueDate", sql.Date, dueDate)
        .input("VoucherStatus", sql.NVarChar(50), "Unpaid")
        .query(`
          INSERT INTO FeeVouchers (
            VoucherNumber,
            MembershipID,
            VoucherType,
            BillingMonth,
            BillingYear,
            BaseAmount,
            FineAmount,
            DueDate,
            VoucherStatus,
            CreatedAt
          )
          VALUES (
            @VoucherNumber,
            @MembershipID,
            @VoucherType,
            @BillingMonth,
            @BillingYear,
            @BaseAmount,
            @FineAmount,
            @DueDate,
            @VoucherStatus,
            SYSDATETIME()
          )
        `);

      generatedCount++;
    }

    await logAdminAction(
      adminId,
      "VOUCHERS_GENERATED",
      `Generated monthly vouchers for ${month}/${year}. Created: ${generatedCount}, Skipped Prepaid: ${skippedPrepaidCount}, Already Generated: ${alreadyGeneratedCount}.`,
      "FeeVouchers"
    );

    if (generatedCount > 0) {
      const monthNames = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      const periodName = `${monthNames[month] || month} ${year}`;
      await Promise.all([
        notifyAllMembers({
          title: `Fee Vouchers Issued (${periodName}) 📄`,
          message: `Monthly fee vouchers for ${periodName} have been issued. Please review your voucher ledger and clear before due date (${targetDueDay}th).`,
          type: "voucher",
          link: "/user/vouchers",
        }),
        notifyAdmins({
          title: "Monthly Vouchers Batch Generated",
          message: `Generated ${generatedCount} vouchers for ${periodName}. (Prepaid skip: ${skippedPrepaidCount}).`,
          type: "admin",
          link: "/admin/vouchers",
        }),
      ]);
    }

    return res.status(200).json({
      success: true,
      message: `Vouchers generation completed. Created: ${generatedCount}, Skipped (Advance Prepaid): ${skippedPrepaidCount}, Already Generated: ${alreadyGeneratedCount}.`,
      period: { month, year, label: `${MONTH_NAMES[month]} ${year}` },
      summary: {
        totalActiveMembers: activeMembers.length,
        generatedCount,
        skippedPrepaidCount,
        alreadyGeneratedCount,
      },
    });
  } catch (error) {
    console.error("generateMonthlyVouchers error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to generate monthly vouchers. " + error.message,
    });
  }
};

// 6. ALL VOUCHERS LISTING
const getAllVouchersAdmin = async (req, res) => {
  try {
    const pool = getPool();
    const finePerDay = await getFineSetting();

    const result = await pool.request().query(`
      SELECT
        v.VoucherID,
        v.VoucherNumber,
        v.MembershipID,
        v.VoucherType,
        v.BillingMonth,
        v.BillingYear,
        v.BaseAmount,
        v.FineAmount,
        v.DueDate,
        v.VoucherStatus,
        v.CreatedAt,
        m.MembershipNumber,
        u.FullName,
        u.Email,
        p.PlanName,
        pay.PaymentID,
        pay.PaymentStatus,
        pay.SubmittedAt,
        rc.ImageURL AS ReceiptImageURL
      FROM FeeVouchers v
      INNER JOIN Memberships m ON m.MembershipID = v.MembershipID
      INNER JOIN Users u ON u.UserID = m.UserID
      INNER JOIN MembershipPlans p ON p.PlanID = m.PlanID
      LEFT JOIN Payments pay ON pay.VoucherID = v.VoucherID
      LEFT JOIN PaymentReceipts rc ON rc.PaymentID = pay.PaymentID
      ORDER BY v.CreatedAt DESC
    `);

    const enriched = result.recordset.map((v) => {
      const fineInfo = calculateVoucherFine(v, finePerDay);
      return {
        ...v,
        daysLate: fineInfo.daysLate,
        calculatedFine: fineInfo.fineAmount,
        totalPayable: fineInfo.totalAmount,
        isOverdue: fineInfo.isOverdue,
      };
    });

    return res.status(200).json({
      success: true,
      vouchers: enriched,
      finePerDay,
    });
  } catch (error) {
    console.error("getAllVouchersAdmin error:", error);
    return res.status(500).json({ success: false, message: "Failed to load vouchers." });
  }
};

// 7. PAYMENTS & RECEIPT VERIFICATION
const getAllPaymentsAdmin = async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.request().query(`
      SELECT
        p.PaymentID,
        p.VoucherID,
        p.Amount,
        p.PaymentMethod,
        p.PaymentStatus,
        p.TransactionReference,
        p.SubmittedAt,
        p.ReviewedAt,
        p.AdminRemarks,
        v.VoucherNumber,
        v.VoucherType,
        v.BillingMonth,
        v.BillingYear,
        v.BaseAmount,
        v.FineAmount,
        m.MembershipID,
        m.MembershipNumber,
        u.FullName,
        u.Email,
        u.Phone,
        r.ReceiptID,
        r.ImageURL AS ReceiptImageURL,
        reviewer.FullName AS ReviewerName
      FROM Payments p
      INNER JOIN FeeVouchers v ON v.VoucherID = p.VoucherID
      INNER JOIN Memberships m ON m.MembershipID = v.MembershipID
      INNER JOIN Users u ON u.UserID = m.UserID
      LEFT JOIN PaymentReceipts r ON r.PaymentID = p.PaymentID
      LEFT JOIN Users reviewer ON reviewer.UserID = p.ReviewedBy
      ORDER BY p.SubmittedAt DESC
    `);

    return res.status(200).json({
      success: true,
      payments: result.recordset,
    });
  } catch (error) {
    console.error("getAllPaymentsAdmin error:", error);
    return res.status(500).json({ success: false, message: "Failed to load payments." });
  }
};

// REVIEW PAYMENT (APPROVE / REJECT)
const reviewPayment = async (req, res) => {
  try {
    const paymentId = req.params.id;
    const { action, remarks } = req.body; // 'approve' | 'reject'
    const adminId = req.user.userId;

    if (!["approve", "reject"].includes(action?.toLowerCase())) {
      return res.status(400).json({ success: false, message: "Action must be approve or reject." });
    }

    const pool = getPool();

    // Fetch payment and associated voucher
    const payRes = await pool
      .request()
      .input("PaymentID", sql.Int, paymentId)
      .query(`
        SELECT
          p.PaymentID,
          p.VoucherID,
          p.Amount,
          p.PaymentStatus,
          v.VoucherNumber,
          v.VoucherType,
          v.MembershipID,
          u.UserID,
          u.FullName
        FROM Payments p
        INNER JOIN FeeVouchers v ON v.VoucherID = p.VoucherID
        INNER JOIN Memberships m ON m.MembershipID = v.MembershipID
        INNER JOIN Users u ON u.UserID = m.UserID
        WHERE p.PaymentID = @PaymentID
      `);

    if (payRes.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Payment record not found." });
    }

    const payment = payRes.recordset[0];
    const isApprove = action.toLowerCase() === "approve";
    const newStatus = isApprove ? "Approved" : "Rejected";

    // 1. Update Payment record
    await pool
      .request()
      .input("PaymentID", sql.Int, paymentId)
      .input("Status", sql.NVarChar(50), newStatus)
      .input("AdminRemarks", sql.NVarChar(255), remarks ? remarks.trim() : null)
      .input("ReviewedBy", sql.Int, adminId)
      .query(`
        UPDATE Payments
        SET
          PaymentStatus = @Status,
          AdminRemarks = @AdminRemarks,
          ReviewedBy = @ReviewedBy,
          ReviewedAt = SYSDATETIME()
        WHERE PaymentID = @PaymentID
      `);

    // 2. Update Voucher status
    const voucherStatus = isApprove ? "Paid" : "Unpaid";
    await pool
      .request()
      .input("VoucherID", sql.Int, payment.VoucherID)
      .input("Status", sql.NVarChar(50), voucherStatus)
      .query("UPDATE FeeVouchers SET VoucherStatus = @Status WHERE VoucherID = @VoucherID");

    // 3. ADVANCE PAYMENT APPROVED: RECORD PREPAYMENTS
    if (isApprove && payment.VoucherType === "Advance") {
      // Find all months in AdvanceVoucherMonths for this voucher
      const advMonthsRes = await pool
        .request()
        .input("VoucherID", sql.Int, payment.VoucherID)
        .query("SELECT BillingMonth, BillingYear FROM AdvanceVoucherMonths WHERE VoucherID = @VoucherID");

      const months = advMonthsRes.recordset;
      const count = months.length;
      const amountPerMonth = count > 0 ? Number(payment.Amount) / count : 0;

      for (const m of months) {
        // Avoid duplicate entry if re-approving
        await pool
          .request()
          .input("MembershipID", sql.Int, payment.MembershipID)
          .input("PaymentID", sql.Int, paymentId)
          .input("BillingMonth", sql.Int, m.BillingMonth)
          .input("BillingYear", sql.Int, m.BillingYear)
          .input("Amount", sql.Decimal(10, 2), amountPerMonth)
          .query(`
            IF NOT EXISTS (
              SELECT 1 FROM MemberPrepayments
              WHERE MembershipID = @MembershipID AND BillingMonth = @BillingMonth AND BillingYear = @BillingYear
            )
            BEGIN
              INSERT INTO MemberPrepayments (MembershipID, PaymentID, BillingMonth, BillingYear, Amount, ApprovedAt)
              VALUES (@MembershipID, @PaymentID, @BillingMonth, @BillingYear, @Amount, SYSDATETIME());
            END
          `);
      }
    }

    await logAdminAction(
      adminId,
      `PAYMENT_${newStatus.toUpperCase()}`,
      `${newStatus} payment of Rs. ${payment.Amount} for voucher #${payment.VoucherNumber} (${payment.FullName}). Remarks: ${remarks || "None"}`,
      "Payments",
      paymentId
    );

    if (isApprove) {
      await Promise.all([
        notifyUser({
          userId: payment.UserID,
          title: "Payment Approved & Verified! ✅",
          message: `Your payment of PKR ${Number(payment.Amount).toLocaleString()} for Voucher #${payment.VoucherNumber} has been verified and marked as Paid. Thank you!`,
          type: "payment",
          link: "/user/payments",
        }),
        notifyAdmins({
          title: "Payment Approved",
          message: `Verified payment of PKR ${Number(payment.Amount).toLocaleString()} for Voucher #${payment.VoucherNumber} (${payment.FullName}).`,
          type: "admin",
          link: "/admin/payments",
        }),
      ]);
    } else {
      await Promise.all([
        notifyUser({
          userId: payment.UserID,
          title: "Payment Verification Issue ⚠️",
          message: `Your payment receipt for Voucher #${payment.VoucherNumber} was declined: ${remarks || "Proof was invalid or unreadable"}. Please upload a clear receipt.`,
          type: "payment",
          link: "/user/upload-receipt",
        }),
        notifyAdmins({
          title: "Payment Rejected",
          message: `Declined receipt for Voucher #${payment.VoucherNumber} (${payment.FullName}). Reason: ${remarks || "None"}.`,
          type: "admin",
          link: "/admin/payments",
        }),
      ]);
    }

    return res.status(200).json({
      success: true,
      message: `Payment has been successfully ${newStatus.toLowerCase()}!`,
    });
  } catch (error) {
    console.error("reviewPayment error:", error);
    return res.status(500).json({ success: false, message: "Failed to process payment review." });
  }
};

// 8. FINES & POLICIES
const getFinesOverview = async (req, res) => {
  try {
    const pool = getPool();
    const finePerDay = await getFineSetting();
    const defaultDueDay = await getDefaultDueDay();

    const result = await pool.request().query(`
      SELECT
        v.VoucherID,
        v.VoucherNumber,
        v.VoucherType,
        v.BillingMonth,
        v.BillingYear,
        v.BaseAmount,
        v.FineAmount,
        v.DueDate,
        v.VoucherStatus,
        m.MembershipNumber,
        u.FullName,
        u.Email,
        u.Phone
      FROM FeeVouchers v
      INNER JOIN Memberships m ON m.MembershipID = v.MembershipID
      INNER JOIN Users u ON u.UserID = m.UserID
      WHERE v.VoucherStatus IN ('Unpaid', 'PendingVerification', 'Pending_Approval')
      ORDER BY v.DueDate ASC
    `);

    const overdueList = [];
    let totalOverdueFines = 0;
    let totalOverdueBase = 0;

    result.recordset.forEach((v) => {
      const fineInfo = calculateVoucherFine(v, finePerDay);
      if (fineInfo.isOverdue) {
        overdueList.push({
          ...v,
          daysLate: fineInfo.daysLate,
          calculatedFine: fineInfo.fineAmount,
          totalPayable: fineInfo.totalAmount,
        });
        totalOverdueFines += fineInfo.fineAmount;
        totalOverdueBase += Number(v.BaseAmount);
      }
    });

    return res.status(200).json({
      success: true,
      policy: {
        lateFinePerDay: finePerDay,
        defaultDueDay,
      },
      stats: {
        totalOverdueCount: overdueList.length,
        totalOverdueFines,
        totalOverdueBase,
        totalOutstanding: totalOverdueBase + totalOverdueFines,
      },
      overdueVouchers: overdueList,
    });
  } catch (error) {
    console.error("getFinesOverview error:", error);
    return res.status(500).json({ success: false, message: "Failed to load fines data." });
  }
};

const updateFinePolicy = async (req, res) => {
  try {
    const { lateFinePerDay, defaultDueDay } = req.body;
    const adminId = req.user.userId;
    const pool = getPool();

    if (lateFinePerDay !== undefined) {
      await pool
        .request()
        .input("Value", sql.NVarChar(255), String(lateFinePerDay))
        .query("UPDATE ClubSettings SET SettingValue = @Value, UpdatedAt = SYSDATETIME() WHERE SettingKey = 'LateFinePerDay'");
    }

    if (defaultDueDay !== undefined) {
      await pool
        .request()
        .input("Value", sql.NVarChar(255), String(defaultDueDay))
        .query("UPDATE ClubSettings SET SettingValue = @Value, UpdatedAt = SYSDATETIME() WHERE SettingKey = 'DefaultDueDay'");
    }

    await logAdminAction(
      adminId,
      "FINE_POLICY_UPDATED",
      `Updated fine policy: Fine per day = Rs. ${lateFinePerDay}, Due day = ${defaultDueDay}`,
      "ClubSettings"
    );

    await Promise.all([
      notifyAllMembers({
        title: "Club Fee & Fine Policy Update ℹ️",
        message: `Club policy updated: Standard monthly due day is the ${defaultDueDay || 10}th of each month. Late fine overdue rate: PKR ${lateFinePerDay || 100}/day.`,
        type: "voucher",
        link: "/user/fees",
      }),
      notifyAdmins({
        title: "Fine & Policy Settings Updated",
        message: `Admin updated fee policy: Fine = PKR ${lateFinePerDay}/day, Due day = ${defaultDueDay}th.`,
        type: "admin",
        link: "/admin/fines",
      }),
    ]);

    return res.status(200).json({
      success: true,
      message: "Fine policy updated successfully.",
    });
  } catch (error) {
    console.error("updateFinePolicy error:", error);
    return res.status(500).json({ success: false, message: "Failed to update fine policy." });
  }
};

// 9. ADVANCE PAYMENTS MANAGEMENT
const getAdvancePaymentsAdmin = async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.request().query(`
      SELECT
        v.VoucherID,
        v.VoucherNumber,
        v.BaseAmount,
        v.VoucherStatus,
        v.CreatedAt,
        m.MembershipNumber,
        u.FullName,
        u.Email,
        p.PaymentID,
        p.PaymentStatus,
        p.SubmittedAt,
        r.ImageURL AS ReceiptImageURL,
        (
          SELECT STRING_AGG(CONCAT(mth.BillingMonth, '/', mth.BillingYear), ', ')
          FROM AdvanceVoucherMonths mth
          WHERE mth.VoucherID = v.VoucherID
        ) AS CoveredMonths
      FROM FeeVouchers v
      INNER JOIN Memberships m ON m.MembershipID = v.MembershipID
      INNER JOIN Users u ON u.UserID = m.UserID
      LEFT JOIN Payments p ON p.VoucherID = v.VoucherID
      LEFT JOIN PaymentReceipts r ON r.PaymentID = p.PaymentID
      WHERE v.VoucherType = 'Advance'
      ORDER BY v.CreatedAt DESC
    `);

    // Also get all prepaid records
    const prepaidList = await pool.request().query(`
      SELECT
        mp.PrepaymentID,
        mp.BillingMonth,
        mp.BillingYear,
        mp.Amount,
        mp.ApprovedAt,
        m.MembershipNumber,
        u.FullName
      FROM MemberPrepayments mp
      INNER JOIN Memberships m ON m.MembershipID = mp.MembershipID
      INNER JOIN Users u ON u.UserID = m.UserID
      ORDER BY mp.ApprovedAt DESC
    `);

    return res.status(200).json({
      success: true,
      advanceVouchers: result.recordset,
      prepaidMonths: prepaidList.recordset,
    });
  } catch (error) {
    console.error("getAdvancePaymentsAdmin error:", error);
    return res.status(500).json({ success: false, message: "Failed to load advance payments." });
  }
};

// 10. ANNOUNCEMENTS CRUD
const getAllAnnouncementsAdmin = async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.request().query(`
      SELECT a.*, u.FullName AS AuthorName
      FROM Announcements a
      INNER JOIN Users u ON u.UserID = a.CreatedBy
      ORDER BY a.CreatedAt DESC
    `);
    return res.status(200).json({ success: true, announcements: result.recordset });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to load announcements." });
  }
};

const createAnnouncement = async (req, res) => {
  try {
    const { title, message, audience, isPublished } = req.body;
    const adminId = req.user.userId;

    if (!title || !message) {
      return res.status(400).json({ success: false, message: "Title and message are required." });
    }

    const pool = getPool();
    await pool
      .request()
      .input("Title", sql.NVarChar(200), title.trim())
      .input("Message", sql.NVarChar(sql.MAX), message.trim())
      .input("Audience", sql.NVarChar(50), audience || "All")
      .input("IsPublished", sql.Bit, isPublished !== false ? 1 : 0)
      .input("CreatedBy", sql.Int, adminId)
      .query(`
        INSERT INTO Announcements (Title, Message, Audience, IsPublished, PublishedAt, CreatedBy, CreatedAt)
        VALUES (@Title, @Message, @Audience, @IsPublished, SYSDATETIME(), @CreatedBy, SYSDATETIME())
      `);

    await logAdminAction(adminId, "ANNOUNCEMENT_CREATED", `Published announcement "${title}"`, "Announcements");

    if (isPublished !== false) {
      await Promise.all([
        notifyAllMembers({
          title: `📢 New Club Notice: ${title.trim()}`,
          message: message.trim().slice(0, 200) + (message.length > 200 ? "..." : ""),
          type: "announcement",
          link: "/user/announcements",
        }),
        notifyAdmins({
          title: "Announcement Published",
          message: `Published announcement '${title.trim()}'.`,
          type: "announcement",
          link: "/admin/announcements",
        }),
      ]);
    }

    return res.status(201).json({ success: true, message: "Announcement published successfully." });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to create announcement." });
  }
};

const deleteAnnouncement = async (req, res) => {
  try {
    const id = req.params.id;
    const adminId = req.user.userId;
    const pool = getPool();

    await pool.request().input("ID", sql.Int, id).query("DELETE FROM Announcements WHERE AnnouncementID = @ID");
    await logAdminAction(adminId, "ANNOUNCEMENT_DELETED", `Deleted announcement #${id}`, "Announcements", id);

    return res.status(200).json({ success: true, message: "Announcement deleted." });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to delete announcement." });
  }
};

// 11. EVENTS CRUD
const getAllEventsAdmin = async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.request().query(`
      SELECT
        e.*,
        s.SportName,
        u.FullName AS CreatedByName,
        (SELECT COUNT(*) FROM EventRegistrations r WHERE r.EventID = e.EventID AND r.RegistrationStatus = 'Registered') AS RegisteredCount
      FROM Events e
      LEFT JOIN Sports s ON s.SportID = e.SportID
      INNER JOIN Users u ON u.UserID = e.CreatedBy
      ORDER BY e.EventDate DESC
    `);
    return res.status(200).json({ success: true, events: result.recordset });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to load events." });
  }
};

const createEvent = async (req, res) => {
  try {
    const { eventName, description, sportId, eventImageURL, eventDate, registrationDeadline, venue, maximumParticipants } = req.body;
    const adminId = req.user.userId;

    if (!eventName || !eventDate) {
      return res.status(400).json({ success: false, message: "Event name and date are required." });
    }

    const pool = getPool();
    await pool
      .request()
      .input("EventName", sql.NVarChar(150), eventName.trim())
      .input("Description", sql.NVarChar(sql.MAX), description ? description.trim() : null)
      .input("SportID", sql.Int, sportId ? parseInt(sportId, 10) : null)
      .input("EventImageURL", sql.NVarChar(500), eventImageURL ? eventImageURL.trim() : null)
      .input("EventDate", sql.DateTime2, new Date(eventDate))
      .input("RegistrationDeadline", sql.DateTime2, registrationDeadline ? new Date(registrationDeadline) : null)
      .input("Venue", sql.NVarChar(150), venue ? venue.trim() : null)
      .input("MaxPart", sql.Int, maximumParticipants ? parseInt(maximumParticipants, 10) : null)
      .input("CreatedBy", sql.Int, adminId)
      .query(`
        INSERT INTO Events (
          EventName,
          Description,
          SportID,
          EventImageURL,
          EventDate,
          RegistrationDeadline,
          Venue,
          MaximumParticipants,
          EventStatus,
          CreatedBy,
          CreatedAt
        )
        VALUES (
          @EventName,
          @Description,
          @SportID,
          @EventImageURL,
          @EventDate,
          @RegistrationDeadline,
          @Venue,
          @MaxPart,
          'Upcoming',
          @CreatedBy,
          SYSDATETIME()
        )
      `);

    await logAdminAction(adminId, "EVENT_CREATED", `Created event "${eventName}"`, "Events");

    const formattedDate = new Date(eventDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    await Promise.all([
      notifyAllMembers({
        title: `🏆 New Event: ${eventName.trim()}`,
        message: `${eventName.trim()} is scheduled for ${formattedDate} at ${venue || "Club Grounds"}. Registrations are now open!`,
        type: "event",
        link: "/user/events",
      }),
      notifyAdmins({
        title: "Event Published",
        message: `Event '${eventName.trim()}' published for ${formattedDate}.`,
        type: "event",
        link: "/admin/events",
      }),
    ]);

    return res.status(201).json({ success: true, message: "Event created successfully." });
  } catch (error) {
    console.error("createEvent error:", error);
    return res.status(500).json({ success: false, message: "Failed to create event." });
  }
};

const getEventParticipants = async (req, res) => {
  try {
    const eventId = req.params.id;
    const pool = getPool();

    const result = await pool
      .request()
      .input("EventID", sql.Int, eventId)
      .query(`
        SELECT
          r.RegistrationID,
          r.RegistrationStatus,
          r.RegisteredAt,
          u.FullName,
          u.Email,
          u.Phone,
          m.MembershipNumber
        FROM EventRegistrations r
        INNER JOIN Users u ON u.UserID = r.UserID
        LEFT JOIN Memberships m ON m.UserID = u.UserID
        WHERE r.EventID = @EventID
        ORDER BY r.RegisteredAt DESC
      `);

    return res.status(200).json({ success: true, participants: result.recordset });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to fetch event participants." });
  }
};

const deleteEvent = async (req, res) => {
  try {
    const eventId = req.params.id;
    const adminId = req.user.userId;
    const pool = getPool();

    await pool.request().input("ID", sql.Int, eventId).query("DELETE FROM EventRegistrations WHERE EventID = @ID");
    await pool.request().input("ID", sql.Int, eventId).query("DELETE FROM Events WHERE EventID = @ID");
    await logAdminAction(adminId, "EVENT_DELETED", `Deleted event #${eventId}`, "Events", eventId);

    return res.status(200).json({ success: true, message: "Event deleted." });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to delete event." });
  }
};

// 12. SPORTS & SERVICES CRUD
const getAllSportsAdmin = async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.request().query("SELECT * FROM Sports ORDER BY SportName ASC");
    return res.status(200).json({ success: true, sports: result.recordset });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to load sports." });
  }
};

const createSport = async (req, res) => {
  try {
    const { sportName, description, imageUrl } = req.body;
    const pool = getPool();

    await pool
      .request()
      .input("Name", sql.NVarChar(100), sportName.trim())
      .input("Description", sql.NVarChar(sql.MAX), description ? description.trim() : null)
      .input("ImageURL", sql.NVarChar(500), imageUrl ? imageUrl.trim() : null)
      .query("INSERT INTO Sports (SportName, Description, ImageURL, IsActive, CreatedAt) VALUES (@Name, @Description, @ImageURL, 1, SYSDATETIME())");

    await Promise.all([
      notifyAllMembers({
        title: `⚽ New Facility Available: ${sportName.trim()}`,
        message: `We've introduced a new sports facility: '${sportName.trim()}'. Check details on the club services page!`,
        type: "sports",
        link: "/services",
      }),
      notifyAdmins({
        title: "Sport Added",
        message: `New facility '${sportName.trim()}' added to club offerings.`,
        type: "admin",
        link: "/admin/sports-services",
      }),
    ]);

    return res.status(201).json({ success: true, message: "Sport added successfully." });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to add sport." });
  }
};

const deleteSport = async (req, res) => {
  try {
    const id = req.params.id;
    const pool = getPool();
    await pool.request().input("ID", sql.Int, id).query("DELETE FROM Sports WHERE SportID = @ID");
    return res.status(200).json({ success: true, message: "Sport deleted." });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to delete sport." });
  }
};

const getAllServicesAdmin = async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.request().query("SELECT * FROM Services ORDER BY ServiceName ASC");
    return res.status(200).json({ success: true, services: result.recordset });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to load services." });
  }
};

const createService = async (req, res) => {
  try {
    const { serviceName, description, imageUrl } = req.body;
    const pool = getPool();

    await pool
      .request()
      .input("Name", sql.NVarChar(100), serviceName.trim())
      .input("Description", sql.NVarChar(sql.MAX), description ? description.trim() : null)
      .input("ImageURL", sql.NVarChar(500), imageUrl ? imageUrl.trim() : null)
      .query("INSERT INTO Services (ServiceName, Description, ImageURL, IsActive, CreatedAt) VALUES (@Name, @Description, @ImageURL, 1, SYSDATETIME())");

    await Promise.all([
      notifyAllMembers({
        title: `⚡ New Club Service: ${serviceName.trim()}`,
        message: `A new member service '${serviceName.trim()}' is now operational!`,
        type: "sports",
        link: "/services",
      }),
      notifyAdmins({
        title: "Service Added",
        message: `Service '${serviceName.trim()}' launched.`,
        type: "admin",
        link: "/admin/sports-services",
      }),
    ]);

    return res.status(201).json({ success: true, message: "Service added successfully." });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to add service." });
  }
};

const deleteService = async (req, res) => {
  try {
    const id = req.params.id;
    const pool = getPool();
    await pool.request().input("ID", sql.Int, id).query("DELETE FROM Services WHERE ServiceID = @ID");
    return res.status(200).json({ success: true, message: "Service deleted." });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to delete service." });
  }
};

module.exports = {
  getDashboardStats,
  getAllUsers,
  toggleUserStatus,
  getAllApplications,
  reviewApplication,
  getAllPlansAdmin,
  createPlan,
  updatePlan,
  deletePlan,
  generateMonthlyVouchers,
  getAllVouchersAdmin,
  getAllPaymentsAdmin,
  reviewPayment,
  getFinesOverview,
  updateFinePolicy,
  getAdvancePaymentsAdmin,
  getAllAnnouncementsAdmin,
  createAnnouncement,
  deleteAnnouncement,
  getAllEventsAdmin,
  createEvent,
  getEventParticipants,
  deleteEvent,
  getAllSportsAdmin,
  createSport,
  deleteSport,
  getAllServicesAdmin,
  createService,
  deleteService,
};
