const express = require("express");
const router = express.Router();

const {
  getMyVouchers,
  getMyFeeSummary,
  createAdvanceVoucher,
  getVoucherById,
} = require("../controllers/voucherController");

const { protect } = require("../middleware/authMiddleware");

router.get("/my-vouchers", protect, getMyVouchers);
router.get("/my-summary", protect, getMyFeeSummary);
router.post("/advance-request", protect, createAdvanceVoucher);
router.post("/advance", protect, createAdvanceVoucher);
router.get("/:id", protect, getVoucherById);

module.exports = router;
