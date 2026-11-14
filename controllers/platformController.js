const crypto = require("crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { sql, getPool, withTransaction, runWithPlatform } = require("../config/db");
const {
  verifyGoogleCredential,
  isGoogleConfigured,
  platformAdminEmails,
  isPlatformAdminEmail,
} = require("../utils/googleAuth");

/* =========================================================== helpers ===== */

const generatePassword = () =>
  "Hub-" +
  crypto.randomBytes(3).toString("hex").toUpperCase() +
  "-" +
  (crypto.randomInt(100, 999) || "");

const slugify = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "club";

const uniqueSlug = async (tx, base) => {
  let slug = base;
  let attempt = 1;

  // A club keeps its name in the URL, so the suffix only appears on a clash.
  while (true) {
    const found = await tx.query("select 1 from Clubs where Slug = $1", [slug]);
    if (!found.rows.length) return slug;
    attempt += 1;
    slug = `${base}-${attempt}`;
  }
};

const platformTokenPayload = (userId) => ({ userId });

/**
 * Makes sure the platform owner account exists.
 *
 * PLATFORM_ADMIN_EMAILS is the allow-list; PLATFORM_ADMIN_PASSWORD (optional)
 * becomes the fallback credential so the console stays reachable even before
 * Google sign-in is configured.
 */
const ensurePlatformOwner = async () => {
  const emails = platformAdminEmails();
  if (!emails.length) return;

  const password = process.env.PLATFORM_ADMIN_PASSWORD || "";
  const hash = password ? await bcrypt.hash(password, 12) : null;

  await runWithPlatform(async () => {
    const pool = getPool();

    for (const email of emails) {
      const existing = await pool
        .request()
        .input("Email", sql.NVarChar(150), email)
        .query("SELECT UserID FROM Users WHERE Email = @Email");

      if (existing.recordset.length) {
        await pool
          .request()
          .input("Email", sql.NVarChar(150), email)
          .input("PasswordHash", sql.NVarChar(255), hash)
          .query(`
            UPDATE Users
            SET
              Role = 'super_admin',
              IsActive = 1,
              PasswordHash = COALESCE(@PasswordHash, PasswordHash)
            WHERE Email = @Email
          `);
        continue;
      }

      await pool
        .request()
        .input("FullName", sql.NVarChar(100), "Platform Owner")
        .input("Email", sql.NVarChar(150), email)
        .input("PasswordHash", sql.NVarChar(255), hash)
        .query(`
          INSERT INTO Users (FullName, Email, PasswordHash, Role, AuthProvider, IsActive, CreatedAt)
          VALUES (@FullName, @Email, @PasswordHash, 'super_admin', 'password', 1, SYSDATETIME())
        `);
    }
  });
};

/* ============================================================ auth ======= */

// PLATFORM LOGIN - Google (preferred) or the env fallback password.
const platformLogin = async (req, res) => {
  try {
    const { credential, email, password } = req.body || {};

    if (!platformAdminEmails().length) {
      return res.status(503).json({
        success: false,
        code: "PLATFORM_NOT_CONFIGURED",
        message:
          "No platform owner is configured. Set PLATFORM_ADMIN_EMAILS in the back-end environment.",
      });
    }

    const pool = getPool();
    let user = null;

    if (credential) {
      if (!isGoogleConfigured()) {
        return res.status(503).json({
          success: false,
          code: "GOOGLE_NOT_CONFIGURED",
          message: "Google sign-in is not configured on this server yet.",
        });
      }

      const profile = await verifyGoogleCredential(credential);

      if (!isPlatformAdminEmail(profile.email)) {
        return res.status(403).json({
          success: false,
          message: "This Google account is not a platform owner.",
        });
      }

      await ensurePlatformOwner();

      const found = await pool
        .request()
        .input("Email", sql.NVarChar(150), profile.email)
        .query("SELECT UserID, FullName, Email, AvatarURL FROM Users WHERE Email = @Email");

      user = found.recordset[0];

      await pool
        .request()
        .input("UserID", sql.Int, user.UserID)
        .input("GoogleSub", sql.NVarChar(255), profile.sub)
        .query(`
          UPDATE Users
          SET GoogleSub = @GoogleSub, AuthProvider = 'google', LastLoginAt = SYSDATETIME()
          WHERE UserID = @UserID
        `);
    } else {
      if (!email || !password) {
        return res.status(400).json({
          success: false,
          message: "Email and password are required.",
        });
      }

      if (!isPlatformAdminEmail(email)) {
        return res.status(403).json({
          success: false,
          message: "This account is not a platform owner.",
        });
      }

      // Bring the account (and its password) in line with the environment
      // before comparing, so the console is reachable on a fresh database.
      await ensurePlatformOwner();

      const found = await pool
        .request()
        .input("Email", sql.NVarChar(150), String(email).trim().toLowerCase())
        .query("SELECT UserID, FullName, Email, PasswordHash, AvatarURL FROM Users WHERE Email = @Email");

      user = found.recordset[0];

      if (!user || !user.PasswordHash) {
        return res.status(401).json({
          success: false,
          message: "Invalid platform credentials.",
        });
      }

      const matches = await bcrypt.compare(password, user.PasswordHash);

      if (!matches) {
        return res.status(401).json({
          success: false,
          message: "Invalid platform credentials.",
        });
      }
    }

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Platform account not found.",
      });
    }

    const token = jwt.sign(
      { ...platformTokenPayload(user.UserID), role: "super_admin", platform: true },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    return res.status(200).json({
      success: true,
      message: "Platform console unlocked.",
      token,
      user: {
        userId: user.UserID,
        fullName: user.FullName,
        email: user.Email,
        avatarUrl: user.AvatarURL,
        role: "super_admin",
      },
    });
  } catch (error) {
    console.error("platformLogin error:", error);
    return res.status(401).json({
      success: false,
      message: "Platform sign-in failed.",
    });
  }
};

const platformMe = async (req, res) => {
  const pool = getPool();
  const result = await pool
    .request()
    .input("UserID", sql.Int, req.user.userId)
    .query("SELECT UserID, FullName, Email, AvatarURL FROM Users WHERE UserID = @UserID");

  if (!result.recordset.length) {
    return res.status(404).json({ success: false, message: "Platform account not found." });
  }

  const row = result.recordset[0];

  return res.json({
    success: true,
    user: {
      userId: row.UserID,
      fullName: row.FullName,
      email: row.Email,
      avatarUrl: row.AvatarURL,
      role: "super_admin",
      platform: true,
    },
  });
};

/* =========================================================== stats ======= */

const getStats = async (req, res) => {
  try {
    const pool = getPool();

    const [clubs, requests, revenue, memberships] = await Promise.all([
      pool.request().query(`
        SELECT
          COUNT(*) AS TotalClubs,
          SUM(CASE WHEN Status = 'Active' THEN 1 ELSE 0 END) AS ActiveClubs,
          SUM(CASE WHEN Status = 'Suspended' THEN 1 ELSE 0 END) AS SuspendedClubs
        FROM Clubs
      `),
      pool.request().query(`
        SELECT
          SUM(CASE WHEN Status = 'Pending' THEN 1 ELSE 0 END) AS PendingRequests,
          SUM(CASE WHEN Status = 'Approved' THEN 1 ELSE 0 END) AS ApprovedRequests,
          SUM(CASE WHEN Status = 'Rejected' THEN 1 ELSE 0 END) AS RejectedRequests
        FROM SubscriptionRequests
      `),
      pool.request().query(`
        SELECT
          COALESCE(SUM(CASE WHEN Status <> 'Cancelled' THEN Amount ELSE 0 END), 0) AS TotalRevenue,
          COALESCE(SUM(CASE WHEN Status = 'Active' AND BillingCycle = 'Monthly' THEN Amount ELSE 0 END), 0) AS MonthlyRecurringRevenue
        FROM Subscriptions
      `),
      pool.request().query(`
        SELECT
          COUNT(*) AS TotalAccounts,
          SUM(CASE WHEN Role = 'member' THEN 1 ELSE 0 END) AS TotalMembers,
          SUM(CASE WHEN Role = 'admin' THEN 1 ELSE 0 END) AS ClubAdmins,
          SUM(CASE WHEN Role = 'coach' THEN 1 ELSE 0 END) AS TotalCoaches
        FROM ClubUsers
      `),
    ]);

    return res.json({
      success: true,
      clubs: clubs.recordset[0] || {},
      requests: requests.recordset[0] || {},
      revenue: revenue.recordset[0] || {},
      accounts: memberships.recordset[0] || {},
    });
  } catch (error) {
    console.error("platform getStats error:", error);
    return res.status(500).json({ success: false, message: "Failed to load platform stats." });
  }
};

/* ==================================================== subscriptions ===== */

const listRequests = async (req, res) => {
  try {
    const status = (req.query.status || "").toString().trim();
    const pool = getPool();
    const request = pool.request();

    let filter = "";
    if (status && status !== "all") {
      request.input("Status", sql.NVarChar(20), status);
      filter = "WHERE r.Status = @Status";
    }

    const result = await request.query(`
      SELECT
        r.RequestID,
        r.UserID,
        r.CompanyName,
        r.ContactPerson,
        r.ContactEmail,
        r.ContactPhone,
        r.City,
        r.AddressLine,
        r.WebsiteURL,
        r.ClubDescription,
        r.ExpectedMembers,
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
        u.FullName AS OwnerName,
        u.Email AS OwnerEmail,
        u.AvatarURL AS OwnerAvatar
      FROM SubscriptionRequests r
      INNER JOIN PlatformPlans p ON p.PlanID = r.PlanID
      INNER JOIN Users u ON u.UserID = r.UserID
      ${filter}
      ORDER BY
        CASE WHEN r.Status = 'Pending' THEN 0 ELSE 1 END,
        r.RequestedAt DESC
    `);

    return res.json({ success: true, data: result.recordset });
  } catch (error) {
    console.error("listRequests error:", error);
    return res.status(500).json({ success: false, message: "Failed to load requests." });
  }
};

/**
 * Approve or reject a subscription request.
 *
 * Approval is the moment a tenant is born: the club row, its subscription, the
 * owner's admin membership and its starter settings are all created inside one
 * transaction, so a half-provisioned club can never exist.
 */
const reviewRequest = async (req, res) => {
  try {
    const requestId = Number(req.params.id);
    const { action, remarks } = req.body || {};

    if (!requestId) {
      return res.status(400).json({ success: false, message: "Invalid request id." });
    }

    if (!["approve", "reject"].includes(action)) {
      return res.status(400).json({
        success: false,
        message: "Action must be 'approve' or 'reject'.",
      });
    }

    const outcome = await withTransaction(async (tx) => {
      const found = await tx.request().input("RequestID", sql.Int, requestId).query(`
        SELECT
          r.RequestID, r.UserID, r.CompanyName, r.ContactEmail, r.ContactPhone,
          r.City, r.AddressLine, r.WebsiteURL, r.ClubDescription, r.BillingCycle,
          r.Status, r.PlanID, p.PriceMonthly, p.PriceYearly
        FROM SubscriptionRequests r
        INNER JOIN PlatformPlans p ON p.PlanID = r.PlanID
        WHERE r.RequestID = @RequestID
      `);

      const request = found.recordset[0];

      if (!request) {
        const err = new Error("Subscription request not found.");
        err.status = 404;
        throw err;
      }

      if (request.Status !== "Pending") {
        const err = new Error(`This request was already ${request.Status.toLowerCase()}.`);
        err.status = 409;
        throw err;
      }

      if (action === "reject") {
        await tx.request()
          .input("RequestID", sql.Int, requestId)
          .input("Remarks", sql.NVarChar(1000), remarks || null)
          .input("ReviewedBy", sql.Int, req.user.userId)
          .query(`
            UPDATE SubscriptionRequests
            SET Status = 'Rejected', PlatformRemarks = @Remarks, ReviewedBy = @ReviewedBy, ReviewedAt = SYSDATETIME()
            WHERE RequestID = @RequestID
          `);

        return { rejected: true };
      }

      const ownerRows = await tx.request()
        .input("UserID", sql.Int, request.UserID)
        .query("SELECT UserID, FullName, Email, PasswordHash FROM Users WHERE UserID = @UserID");

      const owner = ownerRows.recordset[0];

      if (!owner) {
        const err = new Error("The owner account no longer exists.");
        err.status = 409;
        throw err;
      }

      // 1. The club itself
      const slug = await uniqueSlug(tx, slugify(request.CompanyName));

      const clubRows = await tx.request()
        .input("Slug", sql.NVarChar(80), slug)
        .input("ClubName", sql.NVarChar(150), request.CompanyName)
        .input("LegalName", sql.NVarChar(200), request.CompanyName)
        .input("Description", sql.NVarChar(sql.MAX), request.ClubDescription)
        .input("ContactEmail", sql.NVarChar(150), request.ContactEmail)
        .input("ContactPhone", sql.NVarChar(50), request.ContactPhone)
        .input("City", sql.NVarChar(100), request.City)
        .input("AddressLine", sql.NVarChar(250), request.AddressLine)
        .input("WebsiteURL", sql.NVarChar(255), request.WebsiteURL)
        .input("OwnerUserID", sql.Int, request.UserID)
        .query(`
          INSERT INTO Clubs (
            Slug, ClubName, LegalName, Description, ContactEmail, ContactPhone,
            City, AddressLine, WebsiteURL, Status, OwnerUserID, CreatedAt, ApprovedAt
          )
          OUTPUT INSERTED.ClubID, INSERTED.Slug, INSERTED.ClubName
          VALUES (
            @Slug, @ClubName, @LegalName, @Description, @ContactEmail, @ContactPhone,
            @City, @AddressLine, @WebsiteURL, 'Active', @OwnerUserID, SYSDATETIME(), SYSDATETIME()
          )
        `);

      const club = clubRows.recordset[0];

      // 2. Its software subscription
      const amount =
        request.BillingCycle === "Yearly" ? request.PriceYearly : request.PriceMonthly;

      const subRows = await tx.request()
        .input("ClubID", sql.Int, club.ClubID)
        .input("PlanID", sql.Int, request.PlanID)
        .input("BillingCycle", sql.NVarChar(20), request.BillingCycle)
        .input("Amount", sql.Decimal(10, 2), amount)
        .query(`
          INSERT INTO Subscriptions (ClubID, PlanID, BillingCycle, Amount, StartDate, Status, CreatedAt)
          OUTPUT INSERTED.SubscriptionID
          VALUES (
            @ClubID, @PlanID, @BillingCycle, @Amount, CURRENT_DATE, 'Active', SYSDATETIME()
          )
        `);

      await tx.request()
        .input("ClubID", sql.Int, club.ClubID)
        .input("SubscriptionID", sql.Int, subRows.recordset[0].SubscriptionID)
        .query("UPDATE Clubs SET SubscriptionID = @SubscriptionID WHERE ClubID = @ClubID");

      // 3. The owner becomes this club's admin on the account they applied with.
      //    An owner who already registered a password keeps it; an account with
      //    no password (one the platform created itself) gets a temporary one
      //    that has to be handed over once.
      const needsPassword = !owner.PasswordHash;
      const tempPassword = needsPassword ? generatePassword() : null;
      const passwordHash = needsPassword ? await bcrypt.hash(tempPassword, 12) : null;

      await tx.request()
        .input("UserID", sql.Int, owner.UserID)
        .input("PasswordHash", sql.NVarChar(255), passwordHash)
        .input("Email", sql.NVarChar(150), owner.Email)
        .query(`
          UPDATE Users
          SET Role = 'admin',
              IsActive = 1,
              PasswordHash = COALESCE(@PasswordHash, PasswordHash)
          WHERE UserID = @UserID AND Email = @Email
        `);

      await tx.request()
        .input("ClubID", sql.Int, club.ClubID)
        .input("UserID", sql.Int, owner.UserID)
        .query(`
          INSERT INTO ClubUsers (ClubID, UserID, Role, IsActive, JoinedAt)
          VALUES (@ClubID, @UserID, 'admin', 1, SYSDATETIME())
          ON CONFLICT (ClubID, UserID) DO UPDATE SET Role = 'admin', IsActive = 1
        `);

      // 4. Starter settings so the new club's billing modules work day one.
      const starterSettings = [
        ["ClubName", request.CompanyName, "Official name of the club"],
        ["ClubPhone", request.ContactPhone || "", "Contact phone number"],
        ["ClubEmail", request.ContactEmail, "Contact email"],
        ["LateFinePerDay", "100", "Late payment penalty fine per day overdue"],
        ["DefaultDueDay", "10", "Default monthly due day (1 to 28)"],
        ["BankName", "", "Club bank account name"],
        ["AccountNumber", "", "Bank account number for fee deposits"],
        ["AccountTitle", request.CompanyName, "Account title"],
      ];

      for (const [key, value, description] of starterSettings) {
        await tx.request()
          .input("ClubID", sql.Int, club.ClubID)
          .input("Key", sql.NVarChar(50), key)
          .input("Value", sql.NVarChar(255), value || "")
          .input("Desc", sql.NVarChar(255), description)
          .query(`
            INSERT INTO ClubSettings (ClubID, SettingKey, SettingValue, Description)
            VALUES (@ClubID, @Key, @Value, @Desc)
            ON CONFLICT (ClubID, SettingKey) DO NOTHING
          `);
      }

      // 5. Close the request
      await tx.request()
        .input("RequestID", sql.Int, requestId)
        .input("ClubID", sql.Int, club.ClubID)
        .input("Remarks", sql.NVarChar(1000), remarks || null)
        .input("ReviewedBy", sql.Int, req.user.userId)
        .query(`
          UPDATE SubscriptionRequests
          SET Status = 'Approved', ClubID = @ClubID, PlatformRemarks = @Remarks,
              ReviewedBy = @ReviewedBy, ReviewedAt = SYSDATETIME()
          WHERE RequestID = @RequestID
        `);

      await tx.request()
        .input("ClubID", sql.Int, club.ClubID)
        .input("UserID", sql.Int, owner.UserID)
        .input("Title", sql.NVarChar(255), "Welcome to your club workspace")
        .input("Message", sql.NVarChar(sql.MAX), `Your subscription for ${request.CompanyName} is active. Add your facilities, membership plans and coaches from the admin console.`)
        .query(`
          INSERT INTO Notifications (ClubID, UserID, Role, Title, Message, Type, Link, IsRead, CreatedAt)
          VALUES (@ClubID, @UserID, 'admin', @Title, @Message, 'system', '/admin/dashboard', 0, SYSDATETIME())
        `);

      return { club, adminEmail: owner.Email, tempPassword, passwordKept: !needsPassword };
    });

    if (outcome.rejected) {
      return res.json({
        success: true,
        message: "Subscription request rejected.",
      });
    }

    return res.json({
      success: true,
      message: outcome.passwordKept
        ? `${outcome.club.ClubName} is live. The owner keeps the password they registered with.`
        : `${outcome.club.ClubName} is live. Hand these credentials to the owner.`,
      club: outcome.club,
      credentials: {
        email: outcome.adminEmail,
        password: outcome.tempPassword,
        loginUrl: "/owner/login",
      },
    });
  } catch (error) {
    console.error("reviewRequest error:", error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || "Failed to review the request.",
    });
  }
};

const listSubscriptions = async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.request().query(`
      SELECT
        s.SubscriptionID,
        s.BillingCycle,
        s.Amount,
        s.StartDate,
        s.EndDate,
        s.Status,
        s.CreatedAt,
        c.ClubID,
        c.ClubName,
        c.Slug,
        p.PlanName
      FROM Subscriptions s
      INNER JOIN Clubs c ON c.ClubID = s.ClubID
      LEFT JOIN PlatformPlans p ON p.PlanID = s.PlanID
      ORDER BY s.CreatedAt DESC
    `);

    return res.json({ success: true, data: result.recordset });
  } catch (error) {
    console.error("listSubscriptions error:", error);
    return res.status(500).json({ success: false, message: "Failed to load subscriptions." });
  }
};

/* =========================================================== clubs ======= */

const listClubs = async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.request().query(`
      SELECT
        c.ClubID,
        c.Slug,
        c.ClubName,
        c.City,
        c.ContactEmail,
        c.ContactPhone,
        c.Status,
        c.CreatedAt,
        c.ApprovedAt,
        u.FullName AS OwnerName,
        u.Email AS OwnerEmail,
        p.PlanName,
        s.Status AS SubscriptionStatus,
        s.EndDate AS SubscriptionEndDate,
        (SELECT COUNT(*) FROM ClubUsers cu WHERE cu.ClubID = c.ClubID AND cu.Role = 'member') AS MemberCount,
        (SELECT COUNT(*) FROM ClubUsers cu WHERE cu.ClubID = c.ClubID AND cu.Role = 'coach') AS CoachCount
      FROM Clubs c
      LEFT JOIN Users u ON u.UserID = c.OwnerUserID
      LEFT JOIN Subscriptions s ON s.SubscriptionID = c.SubscriptionID
      LEFT JOIN PlatformPlans p ON p.PlanID = s.PlanID
      ORDER BY c.CreatedAt DESC
    `);

    return res.json({ success: true, data: result.recordset });
  } catch (error) {
    console.error("platform listClubs error:", error);
    return res.status(500).json({ success: false, message: "Failed to load clubs." });
  }
};

const updateClubStatus = async (req, res) => {
  try {
    const clubId = Number(req.params.id);
    const { status } = req.body || {};

    if (!["Active", "Suspended"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Status must be 'Active' or 'Suspended'.",
      });
    }

    const pool = getPool();
    const updated = await pool
      .request()
      .input("ClubID", sql.Int, clubId)
      .input("Status", sql.NVarChar(20), status)
      .query(`
        UPDATE Clubs SET Status = @Status
        OUTPUT INSERTED.ClubID, INSERTED.ClubName, INSERTED.Status
        WHERE ClubID = @ClubID
      `);

    if (!updated.recordset.length) {
      return res.status(404).json({ success: false, message: "Club not found." });
    }

    return res.json({
      success: true,
      message:
        status === "Suspended"
          ? "Club suspended. Its members and staff can no longer sign in."
          : "Club reactivated.",
      club: updated.recordset[0],
    });
  } catch (error) {
    console.error("updateClubStatus error:", error);
    return res.status(500).json({ success: false, message: "Failed to update the club." });
  }
};

/** Issues a fresh one-time password for a club's admin. */
const resetClubAdminPassword = async (req, res) => {
  try {
    const clubId = Number(req.params.id);

    const result = await withTransaction(async (tx) => {
      const adminRows = await tx.request()
        .input("ClubID", sql.Int, clubId)
        .query(`
          SELECT u.UserID, u.Email, u.FullName
          FROM ClubUsers cu
          INNER JOIN Users u ON u.UserID = cu.UserID
          WHERE cu.ClubID = @ClubID AND cu.Role = 'admin' AND cu.IsActive = 1
          ORDER BY cu.ClubUserID
          LIMIT 1
        `);

      const admin = adminRows.recordset[0];

      if (!admin) {
        const err = new Error("This club has no active admin account.");
        err.status = 404;
        throw err;
      }

      const tempPassword = generatePassword();
      const passwordHash = await bcrypt.hash(tempPassword, 12);

      await tx.request()
        .input("UserID", sql.Int, admin.UserID)
        .input("PasswordHash", sql.NVarChar(255), passwordHash)
        .query("UPDATE Users SET PasswordHash = @PasswordHash WHERE UserID = @UserID");

      return { email: admin.Email, fullName: admin.FullName, tempPassword };
    });

    return res.json({
      success: true,
      message: "New admin credentials issued. Share them privately with the club owner.",
      credentials: result,
    });
  } catch (error) {
    console.error("resetClubAdminPassword error:", error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || "Failed to reset the admin password.",
    });
  }
};

/* =========================================================== plans ======= */

const listPlans = async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.request().query(`
      SELECT PlanID, PlanName, Description, PriceMonthly, PriceYearly,
             MaxMembers, MaxCoaches, MaxSports, Features, IsActive, CreatedAt
      FROM PlatformPlans
      ORDER BY PriceMonthly ASC
    `);

    return res.json({ success: true, data: result.recordset });
  } catch (error) {
    console.error("listPlans error:", error);
    return res.status(500).json({ success: false, message: "Failed to load plans." });
  }
};

const createPlan = async (req, res) => {
  try {
    const {
      planName,
      description,
      priceMonthly,
      priceYearly,
      maxMembers,
      maxCoaches,
      maxSports,
      features,
    } = req.body || {};

    if (!planName) {
      return res.status(400).json({ success: false, message: "A plan name is required." });
    }

    const pool = getPool();
    const result = await pool
      .request()
      .input("PlanName", sql.NVarChar(100), planName.trim())
      .input("Description", sql.NVarChar(500), description || null)
      .input("PriceMonthly", sql.Decimal(10, 2), Number(priceMonthly) || 0)
      .input("PriceYearly", sql.Decimal(10, 2), Number(priceYearly) || 0)
      .input("MaxMembers", sql.Int, Number(maxMembers) || 100)
      .input("MaxCoaches", sql.Int, Number(maxCoaches) || 5)
      .input("MaxSports", sql.Int, Number(maxSports) || 5)
      .input("Features", sql.NVarChar(2000), features || null)
      .query(`
        INSERT INTO PlatformPlans (PlanName, Description, PriceMonthly, PriceYearly, MaxMembers, MaxCoaches, MaxSports, Features, IsActive, CreatedAt)
        OUTPUT INSERTED.PlanID
        VALUES (@PlanName, @Description, @PriceMonthly, @PriceYearly, @MaxMembers, @MaxCoaches, @MaxSports, @Features, 1, SYSDATETIME())
      `);

    return res.status(201).json({
      success: true,
      message: "Plan created.",
      planId: result.recordset[0].PlanID,
    });
  } catch (error) {
    console.error("createPlan error:", error);
    return res.status(500).json({ success: false, message: "Failed to create the plan." });
  }
};

const updatePlan = async (req, res) => {
  try {
    const planId = Number(req.params.id);
    const { priceMonthly, priceYearly, isActive, features, description } = req.body || {};

    const pool = getPool();
    await pool
      .request()
      .input("PlanID", sql.Int, planId)
      .input("PriceMonthly", sql.Decimal(10, 2), Number(priceMonthly) || 0)
      .input("PriceYearly", sql.Decimal(10, 2), Number(priceYearly) || 0)
      .input("IsActive", sql.Int, isActive === false || isActive === 0 ? 0 : 1)
      .input("Features", sql.NVarChar(2000), features || null)
      .input("Description", sql.NVarChar(500), description || null)
      .query(`
        UPDATE PlatformPlans
        SET PriceMonthly = @PriceMonthly,
            PriceYearly = @PriceYearly,
            IsActive = @IsActive,
            Features = COALESCE(@Features, Features),
            Description = COALESCE(@Description, Description)
        WHERE PlanID = @PlanID
      `);

    return res.json({ success: true, message: "Plan updated." });
  } catch (error) {
    console.error("updatePlan error:", error);
    return res.status(500).json({ success: false, message: "Failed to update the plan." });
  }
};

module.exports = {
  ensurePlatformOwner,
  platformLogin,
  platformMe,
  getStats,
  listRequests,
  reviewRequest,
  listSubscriptions,
  listClubs,
  updateClubStatus,
  resetClubAdminPassword,
  listPlans,
  createPlan,
  updatePlan,
};
