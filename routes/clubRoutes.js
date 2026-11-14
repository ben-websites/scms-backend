const express = require("express");
const router = express.Router();

const {
  getClubProfile,
  updateClubProfile,
  uploadClubLogo,
  uploadClubCover,
  deleteClubLogo,
  deleteClubCover,
  getClubPlans,
  getClubSports,
  getClubServices,
  getClubEvents,
  getClubAnnouncements,
} = require("../controllers/clubController");

const { adminOnly } = require("../middleware/authMiddleware");
const { singleImage } = require("../utils/clubImages");

/**
 * Club-scoped reads for the workspace.
 *
 * Mounted behind `protect` + `resolveTenant` in server.js, so `req.user.clubId`
 * is always set and row level security confines every query to this club.
 * These replace the workspace's old calls to /api/public/*, which used to mean
 * "the one club" and would now be ambiguous.
 */

router.get("/profile", getClubProfile);
router.put("/profile", adminOnly, updateClubProfile);

// Branding. Multipart uploads of a single "image" field, admin only:
// the controller stores it against the club id in the token.
router.post("/profile/logo", adminOnly, singleImage("image"), uploadClubLogo);
router.delete("/profile/logo", adminOnly, deleteClubLogo);
router.post("/profile/cover", adminOnly, singleImage("image"), uploadClubCover);
router.delete("/profile/cover", adminOnly, deleteClubCover);

router.get("/plans", getClubPlans);
router.get("/sports", getClubSports);
router.get("/services", getClubServices);
router.get("/events", getClubEvents);
router.get("/announcements", getClubAnnouncements);

module.exports = router;
