/**
 * Legacy single-club public feed.
 *
 * These endpoints used to read "the one club". They now resolve a featured club
 * (`?club=<slug>`, or the oldest active club) and run every query inside that
 * club's tenant bubble, so the website can never leak another club's data the
 * way an unscoped SELECT used to.
 *
 * The new website is served by directoryController (/api/public/clubs, ...);
 * this file stays for the marketing pages and for anything still calling it.
 */
const { sql, getPool, runWithTenant } = require("../config/db");

// The club whose notices the marketing pages show when none is specified.
const resolveFeaturedClub = async (slug) => {
  const pool = getPool();

  if (slug) {
    const result = await pool
      .request()
      .input("Slug", sql.NVarChar(80), String(slug).trim())
      .query(`
        SELECT ClubID, Slug, ClubName, LogoURL, Status
        FROM Clubs
        WHERE Slug = @Slug
        LIMIT 1
      `);
    return result.recordset[0] || null;
  }

  const result = await pool.query(`
    SELECT ClubID, Slug, ClubName, LogoURL, Status
    FROM Clubs
    WHERE Status = 'Active'
    ORDER BY ClubID ASC
    LIMIT 1
  `);
  return result.recordset[0] || null;
};

/**
 * Runs `loader` inside the featured club's tenant context.
 * Responds with an empty payload (not an error) when no club exists yet, so the
 * marketing pages render their empty states on a fresh platform.
 */
const withFeaturedClub = (loader) => async (req, res) => {
  try {
    const club = await resolveFeaturedClub(req.query.club);

    if (!club) {
      return res.status(200).json({ success: true, data: [], club: null });
    }

    const data = await runWithTenant({ clubId: club.ClubID }, () => loader(club, req));

    return res.status(200).json({
      success: true,
      club: {
        clubId: club.ClubID,
        slug: club.Slug,
        name: club.ClubName,
        logoUrl: club.LogoURL,
      },
      data,
    });
  } catch (error) {
    console.error("public feed error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load this section.",
    });
  }
};

const getPublicPlans = withFeaturedClub(async () => {
  const result = await getPool().request().query(`
    SELECT PlanID, PlanName, Description, MonthlyFee, DurationMonths, IsActive
    FROM MembershipPlans
    WHERE IsActive = 1
    ORDER BY MonthlyFee ASC
  `);
  return result.recordset;
});

const getPublicSports = withFeaturedClub(async () => {
  const result = await getPool().request().query(`
    SELECT SportID, SportName, Description, ImageURL, IsActive
    FROM Sports
    WHERE IsActive = 1
    ORDER BY SportName ASC
  `);
  return result.recordset;
});

const getPublicServices = withFeaturedClub(async () => {
  const result = await getPool().request().query(`
    SELECT ServiceID, ServiceName, Description, ImageURL, IsActive
    FROM Services
    WHERE IsActive = 1
    ORDER BY ServiceName ASC
  `);
  return result.recordset;
});

const getPublicEvents = withFeaturedClub(async () => {
  const result = await getPool().request().query(`
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
  return result.recordset;
});

const getPublicAnnouncements = withFeaturedClub(async () => {
  const result = await getPool().request().query(`
    SELECT AnnouncementID, Title, Message, Audience, PublishedAt
    FROM Announcements
    WHERE IsPublished = 1
    ORDER BY PublishedAt DESC
  `);
  return result.recordset;
});

// Hero counters + club settings (contact details, opening hours, ...).
const getClubInfo = async (req, res) => {
  try {
    const club = await resolveFeaturedClub(req.query.club);

    if (!club) {
      return res.status(200).json({ success: true, club: null, stats: {}, settings: {} });
    }

    const payload = await runWithTenant({ clubId: club.ClubID }, async () => {
      const pool = getPool();

      const statsQuery = await pool.request().query(`
        SELECT
          (SELECT COUNT(*) FROM Sports WHERE IsActive = 1) AS TotalSports,
          (SELECT COUNT(*) FROM Services WHERE IsActive = 1) AS TotalServices,
          (SELECT COUNT(*) FROM Memberships WHERE MembershipStatus = 'Active') AS ActiveMembers,
          (SELECT COUNT(*) FROM Events WHERE EventStatus = 'Upcoming') AS UpcomingEvents
      `);

      const settingsMap = {};
      try {
        const settingsResult = await pool
          .request()
          .query("SELECT SettingKey, SettingValue FROM ClubSettings");
        settingsResult.recordset.forEach((row) => {
          settingsMap[row.SettingKey] = row.SettingValue;
        });
      } catch (e) {
        // The table may not exist yet on a very first boot.
      }

      return { stats: statsQuery.recordset[0] || {}, settings: settingsMap };
    });

    return res.status(200).json({
      success: true,
      club: {
        clubId: club.ClubID,
        slug: club.Slug,
        name: club.ClubName,
        logoUrl: club.LogoURL,
      },
      stats: payload.stats,
      settings: payload.settings,
    });
  } catch (error) {
    console.error("getClubInfo error:", error);
    return res.status(500).json({ success: false, message: "Failed to load club info." });
  }
};

module.exports = {
  resolveFeaturedClub,
  getPublicPlans,
  getPublicSports,
  getPublicServices,
  getPublicEvents,
  getPublicAnnouncements,
  getClubInfo,
};
