const express = require("express");
const router = express.Router();

const {
  getPublicPlans,
  getPublicSports,
  getPublicServices,
  getPublicEvents,
  getPublicAnnouncements,
  getClubInfo,
} = require("../controllers/publicController");

const {
  getPublicConfig,
  getPublicPricing,
  getPublicStats,
  listPublicClubs,
  getPublicClubProfile,
  applyToClub,
  createSubscriptionRequest,
  uploadSubscriptionProof,
  getMySubscriptionRequests,
} = require("../controllers/directoryController");

const { protect } = require("../middleware/authMiddleware");
const { publicScope } = require("../middleware/tenantMiddleware");
const { upload } = require("../utils/upload");

/**
 * The public website API. No tenant is carried by the visitor's session here:
 * the directory reads many clubs, and a visitor applies to a club named in the
 * URL. `publicScope` opens the cross-club read path, and each controller still
 * filters by an explicit ClubID and returns whitelisted columns only.
 */
router.use(publicScope);

/* ------------------------------- platform ------------------------------ */

router.get("/config", getPublicConfig);
router.get("/pricing", getPublicPricing);
router.get("/stats", getPublicStats);

/* ------------------------------- directory ----------------------------- */

router.get("/clubs", listPublicClubs);
router.get("/clubs/:slug", getPublicClubProfile);

/* --------------------------- member enrolment -------------------------- */

// Sign-in required, because the application has to belong to a real account.
router.post("/clubs/:slug/apply", protect, applyToClub);

/* ------------------------- software subscription ----------------------- */

router.post("/subscriptions", protect, createSubscriptionRequest);
router.get("/subscriptions/my", protect, getMySubscriptionRequests);
router.post(
  "/subscriptions/:id/proof",
  protect,
  upload.single("proof"),
  uploadSubscriptionProof
);

/* ------------------------- legacy single-club feed --------------------- */

router.get("/plans", getPublicPlans);
router.get("/sports", getPublicSports);
router.get("/services", getPublicServices);
router.get("/events", getPublicEvents);
router.get("/announcements", getPublicAnnouncements);
router.get("/club-info", getClubInfo);

module.exports = router;
