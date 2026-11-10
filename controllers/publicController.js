const { sql, getPool } = require("../config/db");

// Get active membership plans
const getPublicPlans = async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.request().query(`
      SELECT
        PlanID,
        PlanName,
        Description,
        MonthlyFee,
        DurationMonths,
        IsActive
      FROM MembershipPlans
      WHERE IsActive = 1
      ORDER BY MonthlyFee ASC
    `);

    return res.status(200).json({
      success: true,
      data: result.recordset,
    });
  } catch (error) {
    console.error("getPublicPlans error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load membership plans.",
    });
  }
};

// Get sports facilities
const getPublicSports = async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.request().query(`
      SELECT
        SportID,
        SportName,
        Description,
        ImageURL,
        IsActive
      FROM Sports
      WHERE IsActive = 1
      ORDER BY SportName ASC
    `);

    return res.status(200).json({
      success: true,
      data: result.recordset,
    });
  } catch (error) {
    console.error("getPublicSports error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load sports facilities.",
    });
  }
};

// Get club services
const getPublicServices = async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.request().query(`
      SELECT
        ServiceID,
        ServiceName,
        Description,
        ImageURL,
        IsActive
      FROM Services
      WHERE IsActive = 1
      ORDER BY ServiceName ASC
    `);

    return res.status(200).json({
      success: true,
      data: result.recordset,
    });
  } catch (error) {
    console.error("getPublicServices error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load services.",
    });
  }
};

// Get upcoming events
const getPublicEvents = async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.request().query(`
      SELECT
        e.EventID,
        e.EventName,
        e.Description,
        e.EventImageURL,
        e.EventDate,
        e.RegistrationDeadline,
        e.Venue,
        e.MaximumParticipants,
        e.EventStatus,
        s.SportName,
        (SELECT COUNT(*) FROM EventRegistrations r WHERE r.EventID = e.EventID AND r.RegistrationStatus = 'Registered') AS RegisteredCount
      FROM Events e
      LEFT JOIN Sports s ON s.SportID = e.SportID
      WHERE e.EventStatus IN ('Upcoming', 'Ongoing')
      ORDER BY e.EventDate ASC
    `);

    return res.status(200).json({
      success: true,
      data: result.recordset,
    });
  } catch (error) {
    console.error("getPublicEvents error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load events.",
    });
  }
};

// Get announcements
const getPublicAnnouncements = async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.request().query(`
      SELECT
        AnnouncementID,
        Title,
        Message,
        Audience,
        PublishedAt
      FROM Announcements
      WHERE IsPublished = 1
      ORDER BY PublishedAt DESC
    `);

    return res.status(200).json({
      success: true,
      data: result.recordset,
    });
  } catch (error) {
    console.error("getPublicAnnouncements error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load announcements.",
    });
  }
};

// Get club settings & statistics for hero counter
const getClubInfo = async (req, res) => {
  try {
    const pool = getPool();

    // Stats
    const statsQuery = await pool.request().query(`
      SELECT
        (SELECT COUNT(*) FROM Sports WHERE IsActive = 1) AS TotalSports,
        (SELECT COUNT(*) FROM Services WHERE IsActive = 1) AS TotalServices,
        (SELECT COUNT(*) FROM Memberships WHERE MembershipStatus = 'Active') AS ActiveMembers,
        (SELECT COUNT(*) FROM Events WHERE EventStatus = 'Upcoming') AS UpcomingEvents
    `);

    // Settings
    let settingsMap = {};
    try {
      const settingsResult = await pool.request().query("SELECT SettingKey, SettingValue FROM ClubSettings");
      settingsResult.recordset.forEach((row) => {
        settingsMap[row.SettingKey] = row.SettingValue;
      });
    } catch (e) {
      // If table not queried
    }

    return res.status(200).json({
      success: true,
      stats: statsQuery.recordset[0],
      settings: settingsMap,
    });
  } catch (error) {
    console.error("getClubInfo error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load club info.",
    });
  }
};

module.exports = {
  getPublicPlans,
  getPublicSports,
  getPublicServices,
  getPublicEvents,
  getPublicAnnouncements,
  getClubInfo,
};
