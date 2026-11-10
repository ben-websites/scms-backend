const express = require("express");
const router = express.Router();

const {
  registerEvent,
  cancelRegistration,
  getMyRegistrations,
} = require("../controllers/eventController");

const { protect } = require("../middleware/authMiddleware");

router.post("/:id/register", protect, registerEvent);
router.delete("/:id/register", protect, cancelRegistration);
router.get("/my-registrations", protect, getMyRegistrations);

module.exports = router;
