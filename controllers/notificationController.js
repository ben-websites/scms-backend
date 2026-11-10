const {
  getNotificationsForUser,
  markNotificationAsRead,
  markAllAsReadForUser,
  deleteNotificationById,
  clearReadNotifications,
} = require("../utils/notificationService");

// GET ALL NOTIFICATIONS (USER OR ADMIN)
const getNotifications = async (req, res) => {
  try {
    const userId = req.user.userId;
    const role = req.user.role;
    const { status = "all", type = "all", limit = 50, offset = 0 } = req.query;

    const data = await getNotificationsForUser({
      userId,
      role,
      status,
      type,
      limit,
      offset,
    });

    return res.status(200).json({
      success: true,
      notifications: data.notifications,
      totalCount: data.totalCount,
      unreadCount: data.unreadCount,
    });
  } catch (error) {
    console.error("getNotifications controller error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve notifications.",
    });
  }
};

// GET UNREAD COUNT
const getUnreadCount = async (req, res) => {
  try {
    const userId = req.user.userId;
    const role = req.user.role;

    const data = await getNotificationsForUser({
      userId,
      role,
      status: "unread",
      limit: 1,
      offset: 0,
    });

    return res.status(200).json({
      success: true,
      unreadCount: data.unreadCount,
    });
  } catch (error) {
    console.error("getUnreadCount error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch unread count.",
    });
  }
};

// MARK SINGLE NOTIFICATION AS READ
const markAsRead = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;
    const role = req.user.role;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Notification ID is required.",
      });
    }

    await markNotificationAsRead(parseInt(id, 10), userId, role);

    return res.status(200).json({
      success: true,
      message: "Notification marked as read.",
    });
  } catch (error) {
    console.error("markAsRead error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to mark notification as read.",
    });
  }
};

// MARK ALL AS READ
const markAllAsRead = async (req, res) => {
  try {
    const userId = req.user.userId;
    const role = req.user.role;

    await markAllAsReadForUser(userId, role);

    return res.status(200).json({
      success: true,
      message: "All notifications marked as read.",
    });
  } catch (error) {
    console.error("markAllAsRead error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to mark all notifications as read.",
    });
  }
};

// DELETE SINGLE NOTIFICATION
const deleteNotification = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;
    const role = req.user.role;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Notification ID is required.",
      });
    }

    await deleteNotificationById(parseInt(id, 10), userId, role);

    return res.status(200).json({
      success: true,
      message: "Notification deleted.",
    });
  } catch (error) {
    console.error("deleteNotification error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to delete notification.",
    });
  }
};

// CLEAR ALL READ NOTIFICATIONS
const clearAllRead = async (req, res) => {
  try {
    const userId = req.user.userId;
    const role = req.user.role;

    await clearReadNotifications(userId, role);

    return res.status(200).json({
      success: true,
      message: "Cleared all read notifications.",
    });
  } catch (error) {
    console.error("clearAllRead error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to clear notifications.",
    });
  }
};

module.exports = {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  clearAllRead,
};

