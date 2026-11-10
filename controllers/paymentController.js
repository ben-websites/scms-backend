const { sql, getPool } = require("../config/db");
const { processUploadedFile } = require("../utils/upload");
const { calculateVoucherFine, getFineSetting } = require("../utils/fineCalculator");
const { notifyAdmins, notifyUser } = require("../utils/notificationService");

// SUBMIT PAYMENT RECEIPT (RECEIPT UPLOAD)
const submitPaymentReceipt = async (req, res) => {
  try {
    const { voucherId, paymentMethod, transactionReference, imageUrl } = req.body;
    const userId = req.user.userId;

    if (!voucherId) {
      return res.status(400).json({
        success: false,
        message: "Voucher ID is required.",
      });
    }

    const pool = getPool();

    // Verify voucher belongs to this user
    const voucherCheck = await pool
      .request()
      .input("VoucherID", sql.Int, voucherId)
      .input("UserID", sql.Int, userId)
      .query(`
        SELECT
          v.VoucherID,
          v.VoucherNumber,
          v.BaseAmount,
          v.FineAmount,
          v.DueDate,
          v.VoucherStatus,
          m.MembershipID
        FROM FeeVouchers v
        INNER JOIN Memberships m ON m.MembershipID = v.MembershipID
        WHERE v.VoucherID = @VoucherID AND m.UserID = @UserID
      `);

    if (voucherCheck.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Voucher not found or does not belong to your account.",
      });
    }

    const voucher = voucherCheck.recordset[0];

    if (voucher.VoucherStatus === "Paid") {
      return res.status(400).json({
        success: false,
        message: "This voucher has already been marked as Paid.",
      });
    }

    // Process file upload or fallback URL
    let uploadedImage = null;
    if (req.file) {
      uploadedImage = await processUploadedFile(req.file, req);
    } else if (imageUrl) {
      uploadedImage = {
        url: imageUrl,
        publicId: "manual_url",
      };
    }

    if (!uploadedImage || !uploadedImage.url) {
      return res.status(400).json({
        success: false,
        message: "Please attach a payment receipt image as proof of payment.",
      });
    }

    const finePerDay = await getFineSetting();
    const fineInfo = calculateVoucherFine(voucher, finePerDay);
    const payableAmount = fineInfo.totalAmount;

    // Comply with CK_Payment_Method (strictly 'Manual'). Store channel details in TransactionReference.
    const userChannel = paymentMethod || "Manual";
    const formattedRef = transactionReference
      ? `[${userChannel}] ${transactionReference.trim()}`.slice(0, 100)
      : userChannel.slice(0, 100);

    // Insert payment record
    const payResult = await pool
      .request()
      .input("VoucherID", sql.Int, voucherId)
      .input("Amount", sql.Decimal(10, 2), payableAmount)
      .input("PaymentMethod", sql.NVarChar(50), "Manual")
      .input("PaymentStatus", sql.NVarChar(50), "Pending")
      .input("TransactionReference", sql.NVarChar(100), formattedRef)
      .query(`
        INSERT INTO Payments (
          VoucherID,
          Amount,
          PaymentMethod,
          PaymentStatus,
          TransactionReference,
          SubmittedAt
        )
        OUTPUT INSERTED.PaymentID
        VALUES (
          @VoucherID,
          @Amount,
          @PaymentMethod,
          @PaymentStatus,
          @TransactionReference,
          SYSDATETIME()
        )
      `);

    const paymentId = payResult.recordset[0].PaymentID;

    // Insert payment receipt with Cloudinary / local URL
    await pool
      .request()
      .input("PaymentID", sql.Int, paymentId)
      .input("ImageURL", sql.NVarChar(sql.MAX), uploadedImage.url)
      .input("CloudinaryPublicID", sql.NVarChar(255), uploadedImage.publicId || null)
      .query(`
        INSERT INTO PaymentReceipts (
          PaymentID,
          ImageURL,
          CloudinaryPublicID,
          UploadedAt
        )
        VALUES (
          @PaymentID,
          @ImageURL,
          @CloudinaryPublicID,
          SYSDATETIME()
        )
      `);

    // Update voucher status to PendingVerification (matches CK_Voucher_Status) and update FineAmount
    await pool
      .request()
      .input("VoucherID", sql.Int, voucherId)
      .input("FineAmount", sql.Decimal(10, 2), fineInfo.fineAmount)
      .query(`
        UPDATE FeeVouchers
        SET VoucherStatus = 'PendingVerification', FineAmount = @FineAmount
        WHERE VoucherID = @VoucherID
      `);

    const userRes = await pool.request().input("UID", sql.Int, userId).query("SELECT FullName FROM Users WHERE UserID = @UID");
    const userName = userRes.recordset[0]?.FullName || "Member";

    await Promise.all([
      notifyUser({
        userId,
        title: "Payment Proof Submitted 📤",
        message: `Your payment receipt for Voucher #${voucher.VoucherNumber} (PKR ${payableAmount.toLocaleString()}) has been submitted for admin verification.`,
        type: "payment",
        link: "/user/payments",
      }),
      notifyAdmins({
        title: "New Payment Receipt Received",
        message: `${userName} uploaded receipt for Voucher #${voucher.VoucherNumber} (PKR ${payableAmount.toLocaleString()}). Payment ID: #${paymentId}.`,
        type: "payment",
        link: "/admin/payments",
      }),
    ]);

    return res.status(201).json({
      success: true,
      message: "Payment receipt uploaded successfully! Admin will verify your payment.",
      paymentId,
      receiptUrl: uploadedImage.url,
      amount: payableAmount,
    });
  } catch (error) {
    console.error("submitPaymentReceipt error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to submit payment receipt. " + error.message,
    });
  }
};

// GET USER'S PAYMENT HISTORY
const getMyPayments = async (req, res) => {
  try {
    const userId = req.user.userId;
    const pool = getPool();

    const result = await pool
      .request()
      .input("UserID", sql.Int, userId)
      .query(`
        SELECT
          p.PaymentID,
          p.Amount,
          p.PaymentMethod,
          p.PaymentStatus,
          p.TransactionReference,
          p.SubmittedAt,
          p.ReviewedAt,
          p.AdminRemarks,
          v.VoucherID,
          v.VoucherNumber,
          v.VoucherType,
          v.BillingMonth,
          v.BillingYear,
          r.ImageURL AS ReceiptImageURL,
          u.FullName AS ReviewedByName
        FROM Payments p
        INNER JOIN FeeVouchers v ON v.VoucherID = p.VoucherID
        INNER JOIN Memberships m ON m.MembershipID = v.MembershipID
        LEFT JOIN PaymentReceipts r ON r.PaymentID = p.PaymentID
        LEFT JOIN Users u ON u.UserID = p.ReviewedBy
        WHERE m.UserID = @UserID
        ORDER BY p.SubmittedAt DESC
      `);

    return res.status(200).json({
      success: true,
      payments: result.recordset,
    });
  } catch (error) {
    console.error("getMyPayments error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve payment history.",
    });
  }
};

module.exports = {
  submitPaymentReceipt,
  getMyPayments,
};
