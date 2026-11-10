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

router.get("/plans", getPublicPlans);
router.get("/sports", getPublicSports);
router.get("/services", getPublicServices);
router.get("/events", getPublicEvents);
router.get("/announcements", getPublicAnnouncements);
router.get("/club-info", getClubInfo);

module.exports = router;
