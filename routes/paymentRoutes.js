const express = require("express");
const router = express.Router();

const {
  submitPaymentReceipt,
  getMyPayments,
} = require("../controllers/paymentController");

const { protect } = require("../middleware/authMiddleware");
const { upload } = require("../utils/upload");

router.post("/submit", protect, upload.single("receiptImage"), submitPaymentReceipt);
router.get("/my-payments", protect, getMyPayments);

module.exports = router;
