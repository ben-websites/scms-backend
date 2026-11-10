const express = require("express");
const router = express.Router();

const {
  applyMembership,
  getMyMembership,
  getDigitalCard,
} = require("../controllers/membershipController");

const { protect } = require("../middleware/authMiddleware");

router.post("/apply", protect, applyMembership);
router.get("/my-status", protect, getMyMembership);
router.get("/digital-card", protect, getDigitalCard);

module.exports = router;
