const { sql, getPool } = require("../config/db");
const { notifyAdmins, notifyUser } = require("../utils/notificationService");

// REGISTER FOR AN EVENT
const registerEvent = async (req, res) => {
  try {
    const eventId = req.params.id;
    const userId = req.user.userId;

    const pool = getPool();

    // Check if event exists and is upcoming
    const eventCheck = await pool
      .request()
      .input("EventID", sql.Int, eventId)
      .query(`
        SELECT
          EventID,
          EventName,
          MaximumParticipants,
          EventStatus,
          RegistrationDeadline,
          (SELECT COUNT(*) FROM EventRegistrations WHERE EventID = @EventID AND RegistrationStatus = 'Registered') AS CurrentCount
        FROM Events
        WHERE EventID = @EventID
      `);

    if (eventCheck.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Event not found.",
      });
    }

    const event = eventCheck.recordset[0];

    if (event.EventStatus !== "Upcoming") {
      return res.status(400).json({
        success: false,
        message: "Registration is closed for this event.",
      });
    }

    if (event.RegistrationDeadline && new Date() > new Date(event.RegistrationDeadline)) {
      return res.status(400).json({
        success: false,
        message: "The registration deadline for this event has passed.",
      });
    }

    if (event.MaximumParticipants && event.CurrentCount >= event.MaximumParticipants) {
      return res.status(400).json({
        success: false,
        message: "This event has reached its maximum participant capacity.",
      });
    }

    // Check if already registered
    const regCheck = await pool
      .request()
      .input("EventID", sql.Int, eventId)
      .input("UserID", sql.Int, userId)
      .query("SELECT RegistrationID, RegistrationStatus FROM EventRegistrations WHERE EventID = @EventID AND UserID = @UserID");

    if (regCheck.recordset.length > 0) {
      const reg = regCheck.recordset[0];
      if (reg.RegistrationStatus === "Registered") {
        return res.status(409).json({
          success: false,
          message: "You are already registered for this event.",
        });
      } else {
        // Re-activate registration
        await pool
          .request()
          .input("RegistrationID", sql.Int, reg.RegistrationID)
          .query("UPDATE EventRegistrations SET RegistrationStatus = 'Registered', RegisteredAt = SYSDATETIME() WHERE RegistrationID = @RegistrationID");

        return res.status(200).json({
          success: true,
          message: "Your registration for this event has been reactivated!",
        });
      }
    }

    // Insert new registration
    await pool
      .request()
      .input("EventID", sql.Int, eventId)
      .input("UserID", sql.Int, userId)
      .query(`
        INSERT INTO EventRegistrations (EventID, UserID, RegistrationStatus, RegisteredAt)
        VALUES (@EventID, @UserID, 'Registered', SYSDATETIME())
      `);

    const userRes = await pool.request().input("UID", sql.Int, userId).query("SELECT FullName FROM Users WHERE UserID = @UID");
    const userName = userRes.recordset[0]?.FullName || "Member";

    await Promise.all([
      notifyUser({
        userId,
        title: `Event Registration Confirmed 🏅`,
        message: `You have successfully enrolled in '${event.EventName}'! Event date is set for ${new Date(event.RegistrationDeadline || Date.now()).toLocaleDateString()}.`,
        type: "event",
        link: "/user/events",
      }),
      notifyAdmins({
        title: "New Event Registration",
        message: `${userName} signed up for '${event.EventName}'.`,
        type: "event",
        link: "/admin/events",
      }),
    ]);

    return res.status(201).json({
      success: true,
      message: `Successfully registered for "${event.EventName}"!`,
    });
  } catch (error) {
    console.error("registerEvent error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to register for event.",
    });
  }
};

// CANCEL REGISTRATION
const cancelRegistration = async (req, res) => {
  try {
    const eventId = req.params.id;
    const userId = req.user.userId;

    const pool = getPool();

    await pool
      .request()
      .input("EventID", sql.Int, eventId)
      .input("UserID", sql.Int, userId)
      .query(`
        UPDATE EventRegistrations
        SET RegistrationStatus = 'Cancelled'
        WHERE EventID = @EventID AND UserID = @UserID
      `);

    const [uRes, evRes] = await Promise.all([
      pool.request().input("UID", sql.Int, userId).query("SELECT FullName FROM Users WHERE UserID = @UID"),
      pool.request().input("EID", sql.Int, eventId).query("SELECT EventName FROM Events WHERE EventID = @EID"),
    ]);
    const userName = uRes.recordset[0]?.FullName || "Member";
    const evName = evRes.recordset[0]?.EventName || "Club Event";

    await Promise.all([
      notifyUser({
        userId,
        title: "Registration Cancelled",
        message: `Your registration for '${evName}' has been cancelled.`,
        type: "event",
        link: "/user/events",
      }),
      notifyAdmins({
        title: "Event Registration Withdrawn",
        message: `${userName} withdrew from '${evName}'.`,
        type: "event",
        link: "/admin/events",
      }),
    ]);

    return res.status(200).json({
      success: true,
      message: "Event registration cancelled.",
    });
  } catch (error) {
    console.error("cancelRegistration error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to cancel registration.",
    });
  }
};

// GET MY REGISTERED EVENTS
const getMyRegistrations = async (req, res) => {
  try {
    const userId = req.user.userId;
    const pool = getPool();

    const result = await pool
      .request()
      .input("UserID", sql.Int, userId)
      .query(`
        SELECT
          r.RegistrationID,
          r.RegistrationStatus,
          r.RegisteredAt,
          e.EventID,
          e.EventName,
          e.Description,
          e.EventDate,
          e.Venue,
          e.EventStatus,
          e.EventImageURL,
          s.SportName
        FROM EventRegistrations r
        INNER JOIN Events e ON e.EventID = r.EventID
        LEFT JOIN Sports s ON s.SportID = e.SportID
        WHERE r.UserID = @UserID
        ORDER BY e.EventDate ASC
      `);

    return res.status(200).json({
      success: true,
      registrations: result.recordset,
    });
  } catch (error) {
    console.error("getMyRegistrations error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch event registrations.",
    });
  }
};

module.exports = {
  registerEvent,
  cancelRegistration,
  getMyRegistrations,
};
