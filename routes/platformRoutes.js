const express = require("express");
const router = express.Router();

const {
  platformLogin,
  platformMe,
  getStats,
  listRequests,
  reviewRequest,
  listSubscriptions,
  listClubs,
  updateClubStatus,
  resetClubAdminPassword,
  listPlans,
  createPlan,
  updatePlan,
} = require("../controllers/platformController");

const { protect } = require("../middleware/authMiddleware");
const { platformOnly } = require("../middleware/tenantMiddleware");

// Public: the sign-in form itself.
router.post("/auth/login", platformLogin);

// Everything below looks across every club, so it is gated twice: a valid
// token, and a token minted for the platform owner.
router.use(protect, platformOnly);

router.get("/auth/me", platformMe);

router.get("/stats", getStats);

router.get("/requests", listRequests);
router.put("/requests/:id/review", reviewRequest);

router.get("/subscriptions", listSubscriptions);

router.get("/clubs", listClubs);
router.put("/clubs/:id/status", updateClubStatus);
router.post("/clubs/:id/credentials", resetClubAdminPassword);

router.get("/plans", listPlans);
router.post("/plans", createPlan);
router.put("/plans/:id", updatePlan);

module.exports = router;
