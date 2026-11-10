const express = require("express");
const router = express.Router();

const { getAdminReport, getCoachReport, getMemberReport } = require("../controllers/reportController");
const { protect, adminOnly, coachOnly } = require("../middleware/authMiddleware");

// Club wide executive report (admin only)
router.get("/admin", protect, adminOnly, getAdminReport);

// Own sport / squad report (coach only)
router.get("/coach", protect, coachOnly, getCoachReport);

// Own fees / attendance / progress report (any signed in account)
router.get("/me", protect, getMemberReport);

module.exports = router;
