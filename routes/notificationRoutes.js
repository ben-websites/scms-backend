const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  clearAllRead,
} = require("../controllers/notificationController");

// All notification routes require authentication
router.use(protect);

router.get("/", getNotifications);
router.get("/unread-count", getUnreadCount);
router.put("/mark-all-read", markAllAsRead);
router.put("/:id/read", markAsRead);
router.delete("/clear-read", clearAllRead);
router.delete("/:id", deleteNotification);

module.exports = router;

