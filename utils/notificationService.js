const { sql, getPool } = require("../config/db");

/**
 * Creates a notification record in the Notifications table.
 * @param {Object} params
 * @param {number|null} params.userId - Target user ID (optional if role-targeted)
 * @param {string|null} params.role - Target role: 'admin', 'user', or 'all'
 * @param {string} params.title - Notification headline
 * @param {string} params.message - Notification detailed content
 * @param {string} [params.type='system'] - Category: 'membership', 'payment', 'voucher', 'event', 'announcement', 'sports', 'admin', 'system'
 * @param {string|null} [params.link=null] - Target frontend route
 */
const createNotification = async ({
  userId = null,
  role = null,
  title,
  message,
  type = "system",
  link = null,
}) => {
  try {
    const pool = getPool();
    const result = await pool
      .request()
      .input("UserID", sql.Int, userId)
      .input("Role", sql.NVarChar(20), role)
      .input("Title", sql.NVarChar(255), title)
      .input("Message", sql.NVarChar(sql.MAX), message)
      .input("Type", sql.NVarChar(50), type)
      .input("Link", sql.NVarChar(255), link)
      .query(`
        INSERT INTO Notifications (UserID, Role, Title, Message, Type, Link, IsRead, CreatedAt)
        OUTPUT INSERTED.NotificationID, INSERTED.CreatedAt
        VALUES (@UserID, @Role, @Title, @Message, @Type, @Link, 0, SYSDATETIME())
      `);

    return result.recordset[0];
  } catch (error) {
    console.error("createNotification error:", error.message);
    return null;
  }
};

/**
 * Convenience helper to send notification to all admins
 */
const notifyAdmins = async ({ title, message, type = "admin", link = null }) => {
  return createNotification({
    userId: null,
    role: "admin",
    title,
    message,
    type,
    link,
  });
};

/**
 * Convenience helper to send notification to a specific user
 */
const notifyUser = async ({ userId, title, message, type = "system", link = null }) => {
  return createNotification({
    userId,
    role: "user",
    title,
    message,
    type,
    link,
  });
};

/**
 * Convenience helper to send broadcast to all members
 */
const notifyAllMembers = async ({ title, message, type = "announcement", link = null }) => {
  return createNotification({
    userId: null,
    role: "user",
    title,
    message,
    type,
    link,
  });
};

/**
 * Fetch notifications for a user or admin
 */
const getNotificationsForUser = async ({
  userId,
  role,
  status = "all",
  type = "all",
  limit = 50,
  offset = 0,
}) => {
  try {
    const pool = getPool();
    const req = pool.request();
    req.input("UserID", sql.Int, userId);
    req.input("Limit", sql.Int, Math.min(Math.max(Number(limit) || 50, 1), 100));
    req.input("Offset", sql.Int, Math.max(Number(offset) || 0, 0));

    let whereClause = "";
    if (role === "admin") {
      whereClause = `(Role IN ('admin', 'all') OR UserID = @UserID)`;
    } else {
      whereClause = `(UserID = @UserID OR (Role IN ('user', 'all') AND UserID IS NULL))`;
    }

    if (status === "unread") {
      whereClause += ` AND IsRead = 0`;
    } else if (status === "read") {
      whereClause += ` AND IsRead = 1`;
    }

    if (type && type !== "all") {
      req.input("TypeFilter", sql.NVarChar(50), type);
      whereClause += ` AND Type = @TypeFilter`;
    }

    // Get list
    const listQuery = `
      SELECT
        NotificationID,
        UserID,
        Role,
        Title,
        Message,
        Type,
        Link,
        IsRead,
        CreatedAt
      FROM Notifications
      WHERE ${whereClause}
      ORDER BY CreatedAt DESC
      OFFSET @Offset ROWS
      FETCH NEXT @Limit ROWS ONLY
    `;

    // Get total and unread counts
    let countWhere = "";
    if (role === "admin") {
      countWhere = `(Role IN ('admin', 'all') OR UserID = @UserID)`;
    } else {
      countWhere = `(UserID = @UserID OR (Role IN ('user', 'all') AND UserID IS NULL))`;
    }

    const countQuery = `
      SELECT
        COUNT(*) AS TotalCount,
        SUM(CASE WHEN IsRead = 0 THEN 1 ELSE 0 END) AS UnreadCount
      FROM Notifications
      WHERE ${countWhere}
    `;

    const [listResult, countResult] = await Promise.all([
      req.query(listQuery),
      pool.request().input("UserID", sql.Int, userId).query(countQuery),
    ]);

    const counts = countResult.recordset[0] || { TotalCount: 0, UnreadCount: 0 };

    return {
      notifications: listResult.recordset,
      totalCount: counts.TotalCount || 0,
      unreadCount: counts.UnreadCount || 0,
    };
  } catch (error) {
    console.error("getNotificationsForUser error:", error.message);
    throw error;
  }
};

/**
 * Mark a single notification as read
 */
const markNotificationAsRead = async (notificationId, userId, role) => {
  try {
    const pool = getPool();
    let authClause = "";
    if (role === "admin") {
      authClause = `Role IN ('admin', 'all') OR UserID = @UserID`;
    } else {
      authClause = `UserID = @UserID OR (Role IN ('user', 'all') AND UserID IS NULL)`;
    }

    await pool
      .request()
      .input("NotificationID", sql.Int, notificationId)
      .input("UserID", sql.Int, userId)
      .query(`
        UPDATE Notifications
        SET IsRead = 1
        WHERE NotificationID = @NotificationID AND (${authClause})
      `);

    return true;
  } catch (error) {
    console.error("markNotificationAsRead error:", error.message);
    throw error;
  }
};

/**
 * Mark all notifications as read for current user/admin
 */
const markAllAsReadForUser = async (userId, role) => {
  try {
    const pool = getPool();
    let authClause = "";
    if (role === "admin") {
      authClause = `Role IN ('admin', 'all') OR UserID = @UserID`;
    } else {
      authClause = `UserID = @UserID OR (Role IN ('user', 'all') AND UserID IS NULL)`;
    }

    await pool
      .request()
      .input("UserID", sql.Int, userId)
      .query(`
        UPDATE Notifications
        SET IsRead = 1
        WHERE IsRead = 0 AND (${authClause})
      `);

    return true;
  } catch (error) {
    console.error("markAllAsReadForUser error:", error.message);
    throw error;
  }
};

/**
 * Delete a notification
 */
const deleteNotificationById = async (notificationId, userId, role) => {
  try {
    const pool = getPool();
    let authClause = "";
    if (role === "admin") {
      authClause = `Role IN ('admin', 'all') OR UserID = @UserID`;
    } else {
      authClause = `UserID = @UserID OR (Role IN ('user', 'all') AND UserID IS NULL)`;
    }

    await pool
      .request()
      .input("NotificationID", sql.Int, notificationId)
      .input("UserID", sql.Int, userId)
      .query(`
        DELETE FROM Notifications
        WHERE NotificationID = @NotificationID AND (${authClause})
      `);

    return true;
  } catch (error) {
    console.error("deleteNotificationById error:", error.message);
    throw error;
  }
};

/**
 * Clear all read notifications
 */
const clearReadNotifications = async (userId, role) => {
  try {
    const pool = getPool();
    let authClause = "";
    if (role === "admin") {
      authClause = `Role IN ('admin', 'all') OR UserID = @UserID`;
    } else {
      authClause = `UserID = @UserID OR (Role IN ('user', 'all') AND UserID IS NULL)`;
    }

    await pool
      .request()
      .input("UserID", sql.Int, userId)
      .query(`
        DELETE FROM Notifications
        WHERE IsRead = 1 AND (${authClause})
      `);

    return true;
  } catch (error) {
    console.error("clearReadNotifications error:", error.message);
    throw error;
  }
};

module.exports = {
  createNotification,
  notifyAdmins,
  notifyUser,
  notifyAllMembers,
  getNotificationsForUser,
  markNotificationAsRead,
  markAllAsReadForUser,
  deleteNotificationById,
  clearReadNotifications,
};

