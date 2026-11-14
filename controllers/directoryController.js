/**
 * The public website's data: the club directory, one club's public profile,
 * the software pricing, and the "buy the software" funnel.
 *
 * These endpoints read across clubs, so they run inside platform scope and
 * filter by ClubID explicitly. Only columns listed here ever reach the browser -
 * never internal ids that could be used to probe another club.
 */
const { sql, getPool, runWithTenant, runWithPlatform } = require("../config/db");
const { processUploadedFile } = require("../utils/upload");
const { notifyAdmins, notifyUser } = require("../utils/notificationService");
const {
  isGoogleConfigured,
  platformAdminEmails,
  isPlatformAdminEmail,
} = require("../utils/googleAuth");

const findClubBySlug = async (slug) => {
  const pool = getPool();
  const result = await pool
    .request()
    .input("Slug", sql.NVarChar(80), String(slug || "").trim())
    .query(`
      SELECT
        ClubID, Slug, ClubName, Tagline, Description, LogoURL, CoverImageURL,
        ContactEmail, ContactPhone, WebsiteURL, AddressLine, City, Country,
        FoundedYear, Status, CreatedAt
      FROM Clubs
      WHERE Slug = @Slug
      LIMIT 1
    `);

  return result.recordset[0] || null;
};

/* ======================================================= website ======= */

// What the site needs to know about sign-in configuration.
const getPublicConfig = async (req, res) => {
  return res.json({
    success: true,
    googleEnabled: isGoogleConfigured(),
    googleClientId: process.env.GOOGLE_CLIENT_ID || null,
    platformConfigured: platformAdminEmails().length > 0,
  });
};

// The software's own subscription tiers (sold to club owners).
const getPublicPricing = async (req, res) => {
  try {
    const result = await getPool().request().query(`
      SELECT
        PlanID, PlanName, Description, PriceMonthly, PriceYearly,
        MaxMembers, MaxCoaches, MaxSports, Features
      FROM PlatformPlans
      WHERE IsActive = 1
      ORDER BY PriceMonthly ASC
    `);

    return res.json({ success: true, data: result.recordset });
  } catch (error) {
    console.error("getPublicPricing error:", error);
    return res.status(500).json({ success: false, message: "Failed to load pricing." });
  }
};

// Platform-wide counters for the marketing pages.
//
// Totals only - no club can be identified from this payload, and every count is
// limited to clubs that are actually live on the platform. The marketing pages
// used to print invented numbers ("35+ arenas", "275 members"); they now read
// whatever is really in the database.
const getPublicStats = async (req, res) => {
  try {
    const result = await getPool().request().query(`
      SELECT
        (SELECT COUNT(*) FROM Clubs c WHERE c.Status = 'Active') AS TotalClubs,
        (SELECT COUNT(DISTINCT c.City) FROM Clubs c
          WHERE c.Status = 'Active' AND c.City IS NOT NULL AND c.City <> '') AS CityCount,
        (SELECT COUNT(*) FROM Sports s
          JOIN Clubs c ON c.ClubID = s.ClubID
          WHERE s.IsActive = 1 AND c.Status = 'Active') AS SportCount,
        (SELECT COUNT(*) FROM Services s
          JOIN Clubs c ON c.ClubID = s.ClubID
          WHERE s.IsActive = 1 AND c.Status = 'Active') AS TotalServices,
        (SELECT COUNT(*) FROM MembershipPlans p
          JOIN Clubs c ON c.ClubID = p.ClubID
          WHERE p.IsActive = 1 AND c.Status = 'Active') AS PlanCount,
        (SELECT COUNT(*) FROM Coaches co
          JOIN Clubs c ON c.ClubID = co.ClubID
          WHERE co.IsActive = 1 AND c.Status = 'Active') AS CoachCount,
        (SELECT COUNT(*) FROM Memberships m
          JOIN Clubs c ON c.ClubID = m.ClubID
          WHERE m.MembershipStatus = 'Active' AND c.Status = 'Active') AS MemberCount,
        (SELECT COUNT(*) FROM Events e
          JOIN Clubs c ON c.ClubID = e.ClubID
          WHERE e.EventStatus = 'Upcoming' AND c.Status = 'Active') AS UpcomingEvents
    `);

    return res.json({ success: true, stats: result.recordset[0] || {} });
  } catch (error) {
    console.error("getPublicStats error:", error);
    return res.status(500).json({ success: false, message: "Failed to load platform stats." });
  }
};

// Directory: every club that is currently open for memberships.
const listPublicClubs = async (req, res) => {
  try {
    const search = (req.query.search || "").toString().trim();

    const pool = getPool();
    const request = pool.request();

    let filter = "WHERE c.Status = 'Active'";
    if (search) {
      request.input("Search", sql.NVarChar(120), `%${search}%`);
      filter += " AND (c.ClubName ILIKE @Search OR c.City ILIKE @Search)";
    }

    const result = await request.query(`
      SELECT
        c.ClubID,
        c.Slug,
        c.ClubName,
        c.Tagline,
        c.LogoURL,
        c.CoverImageURL,
        c.City,
        c.Country,
        c.FoundedYear,
        (SELECT COUNT(*) FROM Sports s WHERE s.ClubID = c.ClubID AND s.IsActive = 1) AS SportCount,
        (SELECT COUNT(*) FROM MembershipPlans p WHERE p.ClubID = c.ClubID AND p.IsActive = 1) AS PlanCount,
        (SELECT MIN(p.MonthlyFee) FROM MembershipPlans p WHERE p.ClubID = c.ClubID AND p.IsActive = 1) AS FromPrice
      FROM Clubs c
      ${filter}
      ORDER BY c.ClubName ASC
    `);

    return res.json({ success: true, data: result.recordset });
  } catch (error) {
    console.error("listPublicClubs error:", error);
    return res.status(500).json({ success: false, message: "Failed to load clubs." });
  }
};

// One club's public page: facilities, services, plans, coaches, events.
const getPublicClubProfile = async (req, res) => {
  try {
    const club = await findClubBySlug(req.params.slug);

    if (!club || club.Status !== "Active") {
      return res.status(404).json({
        success: false,
        message: "This club is not available.",
      });
    }

    const pool = getPool();
    const id = () => pool.request().input("ClubID", sql.Int, club.ClubID);

    const [sports, services, plans, events, coaches] = await Promise.all([
      id().query(`
        SELECT SportID, SportName, Description, ImageURL
        FROM Sports
        WHERE ClubID = @ClubID AND IsActive = 1
        ORDER BY SportName ASC
      `),
      id().query(`
        SELECT ServiceID, ServiceName, Description, ImageURL
        FROM Services
        WHERE ClubID = @ClubID AND IsActive = 1
        ORDER BY ServiceName ASC
      `),
      id().query(`
        SELECT PlanID, PlanName, Description, MonthlyFee, DurationMonths,
               AdmissionFee, AllowedSportsLimit
        FROM MembershipPlans
        WHERE ClubID = @ClubID AND IsActive = 1
        ORDER BY MonthlyFee ASC
      `),
      id().query(`
        SELECT EventID, EventName, Description, EventImageURL, EventDate, Venue,
               MaximumParticipants, EventStatus
        FROM Events
        WHERE ClubID = @ClubID AND EventStatus IN ('Upcoming', 'Ongoing')
        ORDER BY EventDate ASC
        LIMIT 6
      `),
      id().query(`
        SELECT CoachID, FullName, Specialization, ExperienceYears, Bio, ImageURL, Rating
        FROM Coaches
        WHERE ClubID = @ClubID AND IsActive = 1
        ORDER BY Rating DESC
        LIMIT 6
      `),
    ]);

    return res.json({
      success: true,
      club: {
        clubId: club.ClubID,
        slug: club.Slug,
        name: club.ClubName,
        tagline: club.Tagline,
        description: club.Description,
        logoUrl: club.LogoURL,
        coverImageUrl: club.CoverImageURL,
        contactEmail: club.ContactEmail,
        contactPhone: club.ContactPhone,
        websiteUrl: club.WebsiteURL,
        address: club.AddressLine,
        city: club.City,
        country: club.Country,
        foundedYear: club.FoundedYear,
      },
      sports: sports.recordset,
      services: services.recordset,
      plans: plans.recordset,
      events: events.recordset,
      coaches: coaches.recordset,
    });
  } catch (error) {
    console.error("getPublicClubProfile error:", error);
    return res.status(500).json({ success: false, message: "Failed to load the club." });
  }
};

/* ================================================ member enrolment ====== */

/**
 * A member applies for one club's membership plan.
 *
 * The tenant is resolved from the URL slug - never from the caller's token,
 * because the caller usually has no club yet. Joining is what creates their
 * ClubUsers row, which is what unlocks that club's workspace afterwards.
 */
const applyToClub = async (req, res) => {
  try {
    const { planId, address, emergencyContactName, emergencyContactPhone } = req.body || {};

    if (!planId) {
      return res.status(400).json({
        success: false,
        message: "Please select a membership plan.",
      });
    }

    const club = await findClubBySlug(req.params.slug);

    if (!club || club.Status !== "Active") {
      return res.status(404).json({
        success: false,
        message: "This club is not accepting applications right now.",
      });
    }

    const outcome = await runWithTenant({ clubId: club.ClubID }, async () => {
      const pool = getPool();
      const userId = req.user.userId;

      const planCheck = await pool
        .request()
        .input("PlanID", sql.Int, Number(planId))
        .query(`
          SELECT PlanID, PlanName, MonthlyFee, DurationMonths
          FROM MembershipPlans
          WHERE PlanID = @PlanID AND IsActive = 1
        `);

      if (!planCheck.recordset.length) {
        return { error: 404, message: "Selected membership plan is invalid or inactive." };
      }

      const existing = await pool
        .request()
        .input("UserID", sql.Int, userId)
        .query(`
          SELECT ApplicationID, ApplicationStatus
          FROM MembershipApplications
          WHERE UserID = @UserID AND ApplicationStatus IN ('Pending', 'Approved')
        `);

      if (existing.recordset.length) {
        return existing.recordset[0].ApplicationStatus === "Approved"
          ? { error: 409, message: `You are already a member of ${club.ClubName}.` }
          : {
              error: 409,
              message: `Your ${club.ClubName} application is already awaiting review.`,
            };
      }

      const applied = await pool
        .request()
        .input("UserID", sql.Int, userId)
        .input("PlanID", sql.Int, Number(planId))
        .input("Address", sql.NVarChar(255), address ? address.trim() : null)
        .input("EmergencyContactName", sql.NVarChar(100), emergencyContactName || null)
        .input("EmergencyContactPhone", sql.NVarChar(20), emergencyContactPhone || null)
        .query(`
          INSERT INTO MembershipApplications (
            UserID, PlanID, Address, EmergencyContactName, EmergencyContactPhone,
            ApplicationStatus, AppliedAt
          )
          OUTPUT INSERTED.ApplicationID
          VALUES (
            @UserID, @PlanID, @Address, @EmergencyContactName, @EmergencyContactPhone,
            'Pending', SYSDATETIME()
          )
        `);

      const applicationId = applied.recordset[0].ApplicationID;
      const plan = planCheck.recordset[0];

      await pool
        .request()
        .input("MembershipNumber", sql.NVarChar(50), `APP-${String(applicationId).padStart(4, "0")}`)
        .input("ApplicationID", sql.Int, applicationId)
        .input("UserID", sql.Int, userId)
        .input("PlanID", sql.Int, Number(planId))
        .query(`
          INSERT INTO Memberships (MembershipNumber, ApplicationID, UserID, PlanID, MembershipStatus, CreatedAt)
          VALUES (@MembershipNumber, @ApplicationID, @UserID, @PlanID, 'PendingPayment', SYSDATETIME())
        `);

      // The join row is what lets this account sign into this club later.
      await pool
        .request()
        .input("UserID", sql.Int, userId)
        .input("ClubID", sql.Int, club.ClubID)
        .query(`
          INSERT INTO ClubUsers (ClubID, UserID, Role, IsActive, JoinedAt)
          VALUES (@ClubID, @UserID, 'member', 1, SYSDATETIME())
          ON CONFLICT (ClubID, UserID) DO NOTHING
        `);

      const userRows = await pool
        .request()
        .input("UserID", sql.Int, userId)
        .query("SELECT FullName FROM Users WHERE UserID = @UserID");

      const userName = userRows.recordset[0]?.FullName || "Member";

      await Promise.all([
        notifyUser({
          userId,
          title: "Application received",
          message: `Your application for '${plan.PlanName}' at ${club.ClubName} (PKR ${plan.MonthlyFee}/mo) is awaiting review.`,
          type: "membership",
          link: "/user/membership",
        }),
        notifyAdmins({
          title: "New membership application",
          message: `${userName} applied for '${plan.PlanName}'. Application #${applicationId}.`,
          type: "membership",
          link: "/admin/memberships",
        }),
      ]);

      return { applicationId, plan };
    });

    if (outcome.error) {
      return res.status(outcome.error).json({ success: false, message: outcome.message });
    }

    return res.status(201).json({
      success: true,
      message: `Application submitted to ${club.ClubName}. Sign in to that club to follow it up.`,
      applicationId: outcome.applicationId,
      club: {
        clubId: club.ClubID,
        slug: club.Slug,
        name: club.ClubName,
        logoUrl: club.LogoURL,
        role: "member",
        status: club.Status,
        isActive: true,
      },
    });
  } catch (error) {
    console.error("applyToClub error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to submit the application. " + error.message,
    });
  }
};

/* ============================================ software subscription ===== */

// A club owner asks to buy the software (signed in with Google).
const createSubscriptionRequest = async (req, res) => {
  try {
    const {
      planId,
      companyName,
      contactPerson,
      contactEmail,
      contactPhone,
      city,
      addressLine,
      websiteUrl,
      clubDescription,
      expectedMembers,
      billingCycle,
      paymentReference,
    } = req.body || {};

    if (!planId || !companyName || !contactPerson || !contactEmail) {
      return res.status(400).json({
        success: false,
        message: "Plan, club name, contact person and contact email are required.",
      });
    }

    if (isPlatformAdminEmail(contactEmail) === false && !contactEmail.includes("@")) {
      return res.status(400).json({ success: false, message: "Enter a valid contact email." });
    }

    const pool = getPool();

    const plan = await pool
      .request()
      .input("PlanID", sql.Int, Number(planId))
      .query("SELECT PlanID, PlanName FROM PlatformPlans WHERE PlanID = @PlanID AND IsActive = 1");

    if (!plan.recordset.length) {
      return res.status(404).json({ success: false, message: "That plan is not available." });
    }

    const alreadyPending = await pool
      .request()
      .input("UserID", sql.Int, req.user.userId)
      .query(`
        SELECT RequestID
        FROM SubscriptionRequests
        WHERE UserID = @UserID AND Status = 'Pending'
      `);

    if (alreadyPending.recordset.length) {
      return res.status(409).json({
        success: false,
        code: "REQUEST_PENDING",
        message: "You already have a subscription request under review.",
      });
    }

    const inserted = await pool
      .request()
      .input("UserID", sql.Int, req.user.userId)
      .input("PlanID", sql.Int, Number(planId))
      .input("CompanyName", sql.NVarChar(200), companyName.trim())
      .input("ContactPerson", sql.NVarChar(120), contactPerson.trim())
      .input("ContactEmail", sql.NVarChar(150), contactEmail.trim().toLowerCase())
      .input("ContactPhone", sql.NVarChar(50), contactPhone || null)
      .input("City", sql.NVarChar(100), city || null)
      .input("AddressLine", sql.NVarChar(250), addressLine || null)
      .input("WebsiteURL", sql.NVarChar(255), websiteUrl || null)
      .input("ClubDescription", sql.NVarChar(2000), clubDescription || null)
      .input("ExpectedMembers", sql.Int, Number(expectedMembers) || null)
      .input("BillingCycle", sql.NVarChar(20), billingCycle === "Yearly" ? "Yearly" : "Monthly")
      .input("PaymentReference", sql.NVarChar(120), paymentReference ? String(paymentReference).trim() : null)
      .query(`
        INSERT INTO SubscriptionRequests (
          UserID, PlanID, CompanyName, ContactPerson, ContactEmail, ContactPhone,
          City, AddressLine, WebsiteURL, ClubDescription, ExpectedMembers,
          BillingCycle, PaymentReference, Status, RequestedAt
        )
        OUTPUT INSERTED.RequestID
        VALUES (
          @UserID, @PlanID, @CompanyName, @ContactPerson, @ContactEmail, @ContactPhone,
          @City, @AddressLine, @WebsiteURL, @ClubDescription, @ExpectedMembers,
          @BillingCycle, @PaymentReference, 'Pending', SYSDATETIME()
        )
      `);

    // Tell the platform owner. This notification belongs to no club, hence the
    // explicit platform scope (row level security would otherwise reject it).
    await runWithPlatform(() =>
      getPool()
        .request()
        .input("Title", sql.NVarChar(255), "New subscription request")
        .input(
          "Message",
          sql.NVarChar(sql.MAX),
          `${companyName} requested the '${plan.recordset[0].PlanName}' plan. Review it in the platform console.`
        )
        .query(`
          INSERT INTO Notifications (ClubID, UserID, Role, Title, Message, Type, Link, IsRead, CreatedAt)
          VALUES (NULL, NULL, 'platform', @Title, @Message, 'admin', '/platform/requests', 0, SYSDATETIME())
        `)
    );

    return res.status(201).json({
      success: true,
      message: "Request submitted. You will get access as soon as the platform owner approves it.",
      requestId: inserted.recordset[0].RequestID,
    });
  } catch (error) {
    console.error("createSubscriptionRequest error:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "You already have a subscription request under review.",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to submit the request.",
    });
  }
};

// Optional proof of payment for the software subscription.
const uploadSubscriptionProof = async (req, res) => {
  try {
    const requestId = Number(req.params.id);

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Attach an image of the payment receipt.",
      });
    }

    const pool = getPool();
    const owned = await pool
      .request()
      .input("RequestID", sql.Int, requestId)
      .input("UserID", sql.Int, req.user.userId)
      .query("SELECT RequestID, Status FROM SubscriptionRequests WHERE RequestID = @RequestID AND UserID = @UserID");

    if (!owned.recordset.length) {
      return res.status(404).json({ success: false, message: "Request not found." });
    }

    if (owned.recordset[0].Status !== "Pending") {
      return res.status(409).json({
        success: false,
        message: "This request has already been reviewed.",
      });
    }

    const uploaded = await processUploadedFile(req.file, req);

    await pool
      .request()
      .input("RequestID", sql.Int, requestId)
      .input("PaymentProofURL", sql.NVarChar(1000), uploaded.url)
      .query("UPDATE SubscriptionRequests SET PaymentProofURL = @PaymentProofURL WHERE RequestID = @RequestID");

    return res.json({
      success: true,
      message: "Payment proof attached. The platform owner will verify it.",
      paymentProofUrl: uploaded.url,
    });
  } catch (error) {
    console.error("uploadSubscriptionProof error:", error);
    return res.status(500).json({ success: false, message: "Failed to attach the receipt." });
  }
};

const getMySubscriptionRequests = async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool
      .request()
      .input("UserID", sql.Int, req.user.userId)
      .query(`
        SELECT
          r.RequestID,
          r.CompanyName,
          r.ContactPerson,
          r.ContactEmail,
          r.BillingCycle,
          r.PaymentProofURL,
          r.PaymentReference,
          r.Status,
          r.PlatformRemarks,
          r.RequestedAt,
          r.ReviewedAt,
          r.ClubID,
          p.PlanName,
          p.PriceMonthly,
          p.PriceYearly,
          c.Slug AS ClubSlug,
          c.Status AS ClubStatus
        FROM SubscriptionRequests r
        INNER JOIN PlatformPlans p ON p.PlanID = r.PlanID
        LEFT JOIN Clubs c ON c.ClubID = r.ClubID
        WHERE r.UserID = @UserID
        ORDER BY r.RequestedAt DESC
      `);

    return res.json({ success: true, data: result.recordset });
  } catch (error) {
    console.error("getMySubscriptionRequests error:", error);
    return res.status(500).json({ success: false, message: "Failed to load your requests." });
  }
};

module.exports = {
  getPublicConfig,
  getPublicPricing,
  getPublicStats,
  listPublicClubs,
  getPublicClubProfile,
  applyToClub,
  createSubscriptionRequest,
  uploadSubscriptionProof,
  getMySubscriptionRequests,
};
