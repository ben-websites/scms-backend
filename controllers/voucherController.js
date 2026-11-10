const { sql, getPool } = require("../config/db");
const { calculateVoucherFine, getFineSetting } = require("../utils/fineCalculator");
const { notifyAdmins, notifyUser } = require("../utils/notificationService");

// GET ALL VOUCHERS FOR CURRENT USER
const getMyVouchers = async (req, res) => {
  try {
    const userId = req.user.userId;
    const pool = getPool();
    const finePerDay = await getFineSetting();

    // Find user's membership
    const memberRes = await pool
      .request()
      .input("UserID", sql.Int, userId)
      .query("SELECT MembershipID FROM Memberships WHERE UserID = @UserID");

    if (memberRes.recordset.length === 0) {
      return res.status(200).json({
        success: true,
        vouchers: [],
      });
    }

    const membershipId = memberRes.recordset[0].MembershipID;

    // Fetch all vouchers with payment details (if any)
    const vouchersRes = await pool
      .request()
      .input("MembershipID", sql.Int, membershipId)
      .query(`
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
          p.PaymentID,
          p.PaymentStatus,
          p.PaymentMethod,
          p.TransactionReference,
          p.SubmittedAt,
          p.ReviewedAt,
          p.AdminRemarks,
          r.ImageURL AS ReceiptImageURL
        FROM FeeVouchers v
        LEFT JOIN Payments p ON p.VoucherID = v.VoucherID
        LEFT JOIN PaymentReceipts r ON r.PaymentID = p.PaymentID
        WHERE v.MembershipID = @MembershipID
        ORDER BY v.CreatedAt DESC
      `);

    // For each voucher, enrich with dynamic late fine and advance months if applicable
    const enrichedVouchers = await Promise.all(
      vouchersRes.recordset.map(async (v) => {
        const fineInfo = calculateVoucherFine(v, finePerDay);

        let advanceMonths = [];
        if (v.VoucherType === "Advance") {
          const advRes = await pool
            .request()
            .input("VoucherID", sql.Int, v.VoucherID)
            .query("SELECT BillingMonth, BillingYear FROM AdvanceVoucherMonths WHERE VoucherID = @VoucherID ORDER BY BillingYear, BillingMonth");
          advanceMonths = advRes.recordset;
        }

        return {
          ...v,
          daysLate: fineInfo.daysLate,
          calculatedFine: fineInfo.fineAmount,
          totalPayable: fineInfo.totalAmount,
          isOverdue: fineInfo.isOverdue,
          advanceMonths,
        };
      })
    );

    return res.status(200).json({
      success: true,
      vouchers: enrichedVouchers,
      finePerDay,
    });
  } catch (error) {
    console.error("getMyVouchers error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve vouchers.",
    });
  }
};

// GET USER'S FEE & PREPAYMENT SUMMARY
const getMyFeeSummary = async (req, res) => {
  try {
    const userId = req.user.userId;
    const pool = getPool();
    const finePerDay = await getFineSetting();

    const memberRes = await pool
      .request()
      .input("UserID", sql.Int, userId)
      .query(`
        SELECT m.MembershipID, m.MembershipNumber, m.MembershipStatus, p.PlanName, p.MonthlyFee
        FROM Memberships m
        INNER JOIN MembershipPlans p ON p.PlanID = m.PlanID
        WHERE m.UserID = @UserID
      `);

    if (memberRes.recordset.length === 0) {
      return res.status(200).json({
        success: true,
        summary: null,
      });
    }

    const membership = memberRes.recordset[0];
    const membershipId = membership.MembershipID;

    // Get all vouchers
    const vouchersRes = await pool
      .request()
      .input("MembershipID", sql.Int, membershipId)
      .query(`
        SELECT
          VoucherID,
          VoucherNumber,
          VoucherType,
          BillingMonth,
          BillingYear,
          BaseAmount,
          FineAmount,
          DueDate,
          VoucherStatus
        FROM FeeVouchers
        WHERE MembershipID = @MembershipID
      `);

    let totalOutstanding = 0;
    let unpaidVouchersCount = 0;
    let overdueCount = 0;
    let totalPaid = 0;

    vouchersRes.recordset.forEach((v) => {
      if (v.VoucherStatus === "Unpaid" || v.VoucherStatus === "PendingVerification" || v.VoucherStatus === "Pending_Approval") {
        unpaidVouchersCount++;
        const fineInfo = calculateVoucherFine(v, finePerDay);
        totalOutstanding += fineInfo.totalAmount;
        if (fineInfo.isOverdue) overdueCount++;
      } else if (v.VoucherStatus === "Paid") {
        totalPaid += Number(v.BaseAmount) + Number(v.FineAmount);
      }
    });

    // Get approved prepaid months from MemberPrepayments
    const prepaymentsRes = await pool
      .request()
      .input("MembershipID", sql.Int, membershipId)
      .query(`
        SELECT PrepaymentID, BillingMonth, BillingYear, Amount, ApprovedAt
        FROM MemberPrepayments
        WHERE MembershipID = @MembershipID
        ORDER BY BillingYear ASC, BillingMonth ASC
      `);

    return res.status(200).json({
      success: true,
      summary: {
        membership,
        totalOutstanding,
        unpaidVouchersCount,
        overdueCount,
        totalPaid,
        finePerDay,
        prepaidMonths: prepaymentsRes.recordset,
      },
    });
  } catch (error) {
    console.error("getMyFeeSummary error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load fee summary.",
    });
  }
};

// CREATE ADVANCE PAYMENT VOUCHER
const createAdvanceVoucher = async (req, res) => {
  try {
    const { monthsCount } = req.body;
    const userId = req.user.userId;

    const parsedMonths = parseInt(monthsCount, 10);
    if (!parsedMonths || parsedMonths < 1 || parsedMonths > 12) {
      return res.status(400).json({
        success: false,
        message: "Please choose between 1 and 12 months for advance payment.",
      });
    }

    const pool = getPool();

    // Get active membership & plan monthly fee
    const memberRes = await pool
      .request()
      .input("UserID", sql.Int, userId)
      .query(`
        SELECT m.MembershipID, m.MembershipNumber, m.MembershipStatus, p.MonthlyFee, p.PlanName
        FROM Memberships m
        INNER JOIN MembershipPlans p ON p.PlanID = m.PlanID
        WHERE m.UserID = @UserID
      `);

    if (memberRes.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: "You must have an approved membership to request advance payments.",
      });
    }

    const member = memberRes.recordset[0];
    const membershipId = member.MembershipID;
    const monthlyFee = Number(member.MonthlyFee);

    // Get all months already covered in MemberPrepayments or active monthly vouchers
    const existingPrepaid = await pool
      .request()
      .input("MembershipID", sql.Int, membershipId)
      .query("SELECT BillingMonth, BillingYear FROM MemberPrepayments WHERE MembershipID = @MembershipID");

    const existingVouchers = await pool
      .request()
      .input("MembershipID", sql.Int, membershipId)
      .query(`
        SELECT BillingMonth, BillingYear
        FROM FeeVouchers
        WHERE MembershipID = @MembershipID AND VoucherType = 'Monthly' AND VoucherStatus IN ('Unpaid', 'PendingVerification', 'Paid')
      `);

    const coveredSet = new Set();
    existingPrepaid.recordset.forEach((p) => coveredSet.add(`${p.BillingYear}-${p.BillingMonth}`));
    existingVouchers.recordset.forEach((v) => {
      if (v.BillingMonth && v.BillingYear) {
        coveredSet.add(`${v.BillingYear}-${v.BillingMonth}`);
      }
    });

    // Determine the next unbilled months
    const now = new Date();
    let currentMonth = now.getMonth() + 1; // 1-12
    let currentYear = now.getFullYear();

    const selectedMonths = [];
    let checkMonth = currentMonth;
    let checkYear = currentYear;

    while (selectedMonths.length < parsedMonths) {
      const key = `${checkYear}-${checkMonth}`;
      if (!coveredSet.has(key)) {
        selectedMonths.push({ month: checkMonth, year: checkYear });
      }

      checkMonth++;
      if (checkMonth > 12) {
        checkMonth = 1;
        checkYear++;
      }

      // Safety guard against infinite loops
      if (checkYear > currentYear + 5) break;
    }

    const totalBaseAmount = parsedMonths * monthlyFee;
    const voucherNumber = `ADV-${Date.now().toString().slice(-6)}-${String(membershipId).padStart(3, "0")}`;

    // Due date 7 days from today
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 7);

    // Create Voucher
    const vResult = await pool
      .request()
      .input("VoucherNumber", sql.NVarChar(50), voucherNumber)
      .input("MembershipID", sql.Int, membershipId)
      .input("VoucherType", sql.NVarChar(50), "Advance")
      .input("BaseAmount", sql.Decimal(10, 2), totalBaseAmount)
      .input("FineAmount", sql.Decimal(10, 2), 0)
      .input("DueDate", sql.Date, dueDate)
      .input("VoucherStatus", sql.NVarChar(50), "Unpaid")
      .query(`
        INSERT INTO FeeVouchers (
          VoucherNumber,
          MembershipID,
          VoucherType,
          BaseAmount,
          FineAmount,
          DueDate,
          VoucherStatus,
          CreatedAt
        )
        OUTPUT INSERTED.VoucherID
        VALUES (
          @VoucherNumber,
          @MembershipID,
          @VoucherType,
          @BaseAmount,
          @FineAmount,
          @DueDate,
          @VoucherStatus,
          SYSDATETIME()
        )
      `);

    const voucherId = vResult.recordset[0].VoucherID;

    // Insert months into AdvanceVoucherMonths
    for (const m of selectedMonths) {
      await pool
        .request()
        .input("VoucherID", sql.Int, voucherId)
        .input("BillingMonth", sql.Int, m.month)
        .input("BillingYear", sql.Int, m.year)
        .query(`
          INSERT INTO AdvanceVoucherMonths (VoucherID, BillingMonth, BillingYear)
          VALUES (@VoucherID, @BillingMonth, @BillingYear)
        `);
    }

    const uRes = await pool.request().input("UID", sql.Int, userId).query("SELECT FullName FROM Users WHERE UserID = @UID");
    const userName = uRes.recordset[0]?.FullName || "Member";

    await Promise.all([
      notifyUser({
        userId,
        title: "Advance Voucher Generated 💳",
        message: `Advance voucher #${voucherNumber} for ${parsedMonths} month(s) (PKR ${totalBaseAmount.toLocaleString()}) has been generated. Please proceed to upload payment receipt.`,
        type: "voucher",
        link: "/user/upload-receipt",
      }),
      notifyAdmins({
        title: "Advance Voucher Created",
        message: `${userName} generated advance fee voucher #${voucherNumber} for ${parsedMonths} month(s) (PKR ${totalBaseAmount.toLocaleString()}).`,
        type: "voucher",
        link: "/admin/advance-payments",
      }),
    ]);

    return res.status(201).json({
      success: true,
      message: `Advance voucher for ${parsedMonths} month(s) generated successfully. Total: Rs. ${totalBaseAmount.toLocaleString()}`,
      voucherId,
      voucherNumber,
      totalAmount: totalBaseAmount,
      months: selectedMonths,
    });
  } catch (error) {
    console.error("createAdvanceVoucher error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create advance voucher. " + error.message,
    });
  }
};

// GET SPECIFIC VOUCHER DETAILS FOR PRINT / MODAL
const getVoucherById = async (req, res) => {
  try {
    const voucherId = req.params.id;
    const pool = getPool();
    const finePerDay = await getFineSetting();

    const result = await pool
      .request()
      .input("VoucherID", sql.Int, voucherId)
      .query(`
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
          v.CreatedAt,
          m.MembershipID,
          m.MembershipNumber,
          p.PlanName,
          p.MonthlyFee,
          u.FullName,
          u.Email,
          u.Phone,
          a.Address
        FROM FeeVouchers v
        INNER JOIN Memberships m ON m.MembershipID = v.MembershipID
        INNER JOIN MembershipPlans p ON p.PlanID = m.PlanID
        INNER JOIN Users u ON u.UserID = m.UserID
        LEFT JOIN MembershipApplications a ON a.ApplicationID = m.ApplicationID
        WHERE v.VoucherID = @VoucherID
      `);

    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Voucher not found.",
      });
    }

    const voucher = result.recordset[0];
    const fineInfo = calculateVoucherFine(voucher, finePerDay);

    let advanceMonths = [];
    if (voucher.VoucherType === "Advance") {
      const advRes = await pool
        .request()
        .input("VoucherID", sql.Int, voucherId)
        .query("SELECT BillingMonth, BillingYear FROM AdvanceVoucherMonths WHERE VoucherID = @VoucherID ORDER BY BillingYear, BillingMonth");
      advanceMonths = advRes.recordset;
    }

    // Get club bank settings
    let bankInfo = {
      bankName: "Habib Bank Limited (HBL)",
      accountNumber: "0123-45678901-03",
      accountTitle: "Sports Hub Management",
    };
    try {
      const settings = await pool.request().query("SELECT SettingKey, SettingValue FROM ClubSettings");
      settings.recordset.forEach((s) => {
        if (s.SettingKey === "BankName") bankInfo.bankName = s.SettingValue;
        if (s.SettingKey === "AccountNumber") bankInfo.accountNumber = s.SettingValue;
        if (s.SettingKey === "AccountTitle") bankInfo.accountTitle = s.SettingValue;
      });
    } catch (e) {}

    return res.status(200).json({
      success: true,
      voucher: {
        ...voucher,
        daysLate: fineInfo.daysLate,
        calculatedFine: fineInfo.fineAmount,
        totalPayable: fineInfo.totalAmount,
        isOverdue: fineInfo.isOverdue,
        advanceMonths,
        bankInfo,
      },
    });
  } catch (error) {
    console.error("getVoucherById error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve voucher details.",
    });
  }
};

module.exports = {
  getMyVouchers,
  getMyFeeSummary,
  createAdvanceVoucher,
  getVoucherById,
};
