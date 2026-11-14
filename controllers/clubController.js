/**
 * Everything a signed-in workspace user reads about their own club.
 *
 * These handlers run behind `protect` + `resolveTenant`, so the club id comes
 * from the token and every SELECT below is additionally narrowed by row level
 * security. The club profile (the public page's content) is platform data, so
 * it is read/written directly - only an admin of the club may change it.
 */
const { sql, getPool } = require("../config/db");
const { storeClubImage, removeLocalImage } = require("../utils/clubImages");

const SETTINGS_EXPOSED = [
  "ClubName",
  "ClubEmail",
  "ClubPhone",
  "ClubAddress",
  "OpeningHours",
  "AboutUs",
  "FacebookURL",
  "InstagramURL",
];

const currentClubId = (req) => Number(req.user.clubId);

const getClubProfile = async (req, res) => {
  try {
    const pool = getPool();

    const clubRows = await pool
      .request()
      .input("ClubID", sql.Int, currentClubId(req))
      .query(`
        SELECT
          ClubID, Slug, ClubName, LegalName, Tagline, Description, LogoURL,
          CoverImageURL, ContactEmail, ContactPhone, AddressLine, City, Country,
          WebsiteURL, FoundedYear, Status, CreatedAt, ApprovedAt
        FROM Clubs
        WHERE ClubID = @ClubID
      `);

    if (!clubRows.recordset.length) {
      return res.status(404).json({ success: false, message: "Club not found." });
    }

    const settings = {};
    const settingsRows = await pool
      .request()
      .query("SELECT SettingKey, SettingValue FROM ClubSettings");

    settingsRows.recordset.forEach((row) => {
      if (SETTINGS_EXPOSED.includes(row.SettingKey)) {
        settings[row.SettingKey] = row.SettingValue;
      }
    });

    return res.json({
      success: true,
      data: clubRows.recordset[0],
      settings,
    });
  } catch (error) {
    console.error("getClubProfile error:", error);
    return res.status(500).json({ success: false, message: "Failed to load the club profile." });
  }
};

// The public page's content, edited by the club's own admin.
const updateClubProfile = async (req, res) => {
  try {
    const {
      clubName,
      legalName,
      tagline,
      description,
      logoUrl,
      coverImageUrl,
      contactEmail,
      contactPhone,
      addressLine,
      city,
      country,
      websiteUrl,
      foundedYear,
    } = req.body || {};

    if (!clubName || !String(clubName).trim()) {
      return res.status(400).json({ success: false, message: "Club name is required." });
    }

    if (!contactEmail || !String(contactEmail).includes("@")) {
      return res.status(400).json({ success: false, message: "A valid contact email is required." });
    }

    const year = foundedYear ? Number(foundedYear) : null;

    await getPool()
      .request()
      .input("ClubID", sql.Int, currentClubId(req))
      .input("ClubName", sql.NVarChar(150), String(clubName).trim())
      .input("LegalName", sql.NVarChar(200), legalName ? String(legalName).trim() : null)
      .input("Tagline", sql.NVarChar(200), tagline ? String(tagline).trim() : null)
      .input("Description", sql.NVarChar(sql.MAX), description || null)
      .input("LogoURL", sql.NVarChar(1000), logoUrl || null)
      .input("CoverImageURL", sql.NVarChar(1000), coverImageUrl || null)
      .input("ContactEmail", sql.NVarChar(150), String(contactEmail).trim().toLowerCase())
      .input("ContactPhone", sql.NVarChar(50), contactPhone || null)
      .input("AddressLine", sql.NVarChar(250), addressLine || null)
      .input("City", sql.NVarChar(100), city || null)
      .input("Country", sql.NVarChar(100), country || null)
      .input("WebsiteURL", sql.NVarChar(255), websiteUrl || null)
      .input("FoundedYear", sql.Int, Number.isFinite(year) ? year : null)
      .query(`
        UPDATE Clubs
        SET
          ClubName = @ClubName,
          LegalName = @LegalName,
          Tagline = @Tagline,
          Description = @Description,
          LogoURL = @LogoURL,
          CoverImageURL = @CoverImageURL,
          ContactEmail = @ContactEmail,
          ContactPhone = @ContactPhone,
          AddressLine = @AddressLine,
          City = @City,
          Country = @Country,
          WebsiteURL = @WebsiteURL,
          FoundedYear = @FoundedYear
        WHERE ClubID = @ClubID
      `);

    return res.json({ success: true, message: "Club profile updated." });
  } catch (error) {
    console.error("updateClubProfile error:", error);
    return res.status(500).json({ success: false, message: "Failed to update the club profile." });
  }
};

/* ------------------------- branding (logo / cover) --------------------- */

// Which column each brand image lives in. The kind also picks the property
// name in the response, so the client never has to guess.
const BRAND_IMAGES = {
  logo: { column: "LogoURL", key: "logoUrl", label: "logo" },
  cover: { column: "CoverImageURL", key: "coverImageUrl", label: "cover image" },
};

const readBrandImage = async (clubId, column) => {
  const result = await getPool()
    .request()
    .input("ClubID", sql.Int, clubId)
    .query(`SELECT ${column} FROM Clubs WHERE ClubID = @ClubID`);

  return result.recordset[0]?.[column] || null;
};

const writeBrandImage = async (clubId, column, url) => {
  await getPool()
    .request()
    .input("ClubID", sql.Int, clubId)
    .input("ImageURL", sql.NVarChar(1000), url)
    .query(`UPDATE Clubs SET ${column} = @ImageURL WHERE ClubID = @ClubID`);
};

/**
 * Store an uploaded logo/cover for the signed-in admin's own club.
 *
 * The club is always taken from the token - never from the body - so one club's
 * admin cannot rewrite another club's branding by changing a request field.
 */
const saveBrandImage = async (req, res, kind) => {
  const target = BRAND_IMAGES[kind];

  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "Choose an image to upload." });
    }

    const clubId = currentClubId(req);
    const previous = await readBrandImage(clubId, target.column);
    const url = await storeClubImage(req.file, req);

    await writeBrandImage(clubId, target.column, url);

    // Only after the new URL is safely stored, and only if it was one of ours.
    if (previous && previous !== url) removeLocalImage(previous);

    return res.json({
      success: true,
      message: `Club ${target.label} updated.`,
      data: { [target.key]: url },
    });
  } catch (error) {
    console.error(`saveBrandImage(${kind}) error:`, error);
    return res.status(500).json({ success: false, message: "Failed to save the image." });
  }
};

const clearBrandImage = async (req, res, kind) => {
  const target = BRAND_IMAGES[kind];

  try {
    const clubId = currentClubId(req);
    const previous = await readBrandImage(clubId, target.column);

    await writeBrandImage(clubId, target.column, null);
    removeLocalImage(previous);

    return res.json({
      success: true,
      message: `Club ${target.label} removed.`,
      data: { [target.key]: null },
    });
  } catch (error) {
    console.error(`clearBrandImage(${kind}) error:`, error);
    return res.status(500).json({ success: false, message: "Failed to remove the image." });
  }
};

const uploadClubLogo = (req, res) => saveBrandImage(req, res, "logo");
const uploadClubCover = (req, res) => saveBrandImage(req, res, "cover");
const deleteClubLogo = (req, res) => clearBrandImage(req, res, "logo");
const deleteClubCover = (req, res) => clearBrandImage(req, res, "cover");

/* -------------------------- workspace read endpoints ------------------- */

const getClubPlans = async (req, res) => {
  try {
    const result = await getPool().request().query(`
      SELECT PlanID, PlanName, Description, MonthlyFee, DurationMonths,
             AdmissionFee, AllowedSportsLimit, IsActive
      FROM MembershipPlans
      WHERE IsActive = 1
      ORDER BY MonthlyFee ASC
    `);

    return res.json({ success: true, data: result.recordset });
  } catch (error) {
    console.error("getClubPlans error:", error);
    return res.status(500).json({ success: false, message: "Failed to load plans." });
  }
};

const getClubSports = async (req, res) => {
  try {
    const result = await getPool().request().query(`
      SELECT SportID, SportName, Description, ImageURL, IsActive
      FROM Sports
      WHERE IsActive = 1
      ORDER BY SportName ASC
    `);

    return res.json({ success: true, data: result.recordset });
  } catch (error) {
    console.error("getClubSports error:", error);
    return res.status(500).json({ success: false, message: "Failed to load sports." });
  }
};

const getClubServices = async (req, res) => {
  try {
    const result = await getPool().request().query(`
      SELECT ServiceID, ServiceName, Description, ImageURL, IsActive
      FROM Services
      WHERE IsActive = 1
      ORDER BY ServiceName ASC
    `);

    return res.json({ success: true, data: result.recordset });
  } catch (error) {
    console.error("getClubServices error:", error);
    return res.status(500).json({ success: false, message: "Failed to load services." });
  }
};

const getClubEvents = async (req, res) => {
  try {
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
      ORDER BY e.EventDate ASC
    `);

    return res.json({ success: true, data: result.recordset });
  } catch (error) {
    console.error("getClubEvents error:", error);
    return res.status(500).json({ success: false, message: "Failed to load events." });
  }
};

const getClubAnnouncements = async (req, res) => {
  try {
    const result = await getPool().request().query(`
      SELECT AnnouncementID, Title, Message, Audience, PublishedAt
      FROM Announcements
      WHERE IsPublished = 1
      ORDER BY PublishedAt DESC
    `);

    return res.json({ success: true, data: result.recordset });
  } catch (error) {
    console.error("getClubAnnouncements error:", error);
    return res.status(500).json({ success: false, message: "Failed to load announcements." });
  }
};

module.exports = {
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
};
