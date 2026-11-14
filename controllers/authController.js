const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { sql, getPool, runWithTenant } = require("../config/db");
const { processUploadedFile } = require("../utils/upload");
const { notifyAdmins, notifyUser } = require("../utils/notificationService");
const { verifyGoogleCredential, isGoogleConfigured } = require("../utils/googleAuth");

/**
 * Tokens come in two shapes.
 *
 * Club session  -> { userId, clubId, role }        role = role inside that club
 * Platform      -> { userId, role:'super_admin', platform:true }
 *
 * The club id is what activates row level security on every later request, so
 * it is never taken from the client - only from ClubUsers.
 */
const generateToken = ({ userId, role, clubId = null, platform = false }) => {
  const payload = { userId, role };
  if (clubId != null) payload.clubId = clubId;
  if (platform) payload.platform = true;

  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d" });
};

/** Clubs this account belongs to (shared tables, readable without a tenant). */
const loadClubsForUser = async (userId) => {
  const pool = getPool();
  const result = await pool
    .request()
    .input("UserID", sql.Int, userId)
    .query(`
      SELECT
        c.ClubID,
        c.Slug,
        c.ClubName,
        c.LogoURL,
        c.City,
        c.Status,
        cu.Role AS ClubRole,
        cu.IsActive AS MembershipActive
      FROM ClubUsers cu
      INNER JOIN Clubs c ON c.ClubID = cu.ClubID
      WHERE cu.UserID = @UserID
      ORDER BY c.ClubName ASC
    `);

  return result.recordset.map((row) => ({
    clubId: row.ClubID,
    slug: row.Slug,
    name: row.ClubName,
    logoUrl: row.LogoURL,
    city: row.City,
    status: row.Status,
    // Aliased columns only keep their casing when they are registered in
    // db/aliases.js; reading both spellings keeps a missing entry from
    // silently turning every session into "no club" (which locked owners out
    // of their own dashboard).
    role: row.ClubRole ?? row.clubrole,
    isActive: Boolean(row.MembershipActive ?? row.membershipactive),
  }));
};

/** The club a session should default to, if any. */
const pickDefaultClub = (clubs) => {
  const usable = clubs.filter((c) => c.isActive && c.status === "Active");
  return usable.length === 1 ? usable[0] : null;
};

const clubSession = (user, club) => ({
  token: generateToken({
    userId: user.UserID,
    clubId: club.clubId,
    role: club.role === "member" ? "user" : club.role,
  }),
  club,
});

// REGISTER USER (global member account - no club yet)
const registerUser = async (req, res) => {
  try {
    const { fullName, email, password, phone } = req.body;

    if (!fullName || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Name, email and password are required.",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must contain at least 8 characters.",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const pool = getPool();

    const existingUser = await pool
      .request()
      .input("Email", sql.NVarChar(150), normalizedEmail)
      .query(`
        SELECT UserID
        FROM Users
        WHERE Email = @Email
      `);

    if (existingUser.recordset.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Email is already registered.",
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Public registration ALWAYS creates a normal member account. The club
    // they join is chosen afterwards, from that club's public page.
    const result = await pool
      .request()
      .input("FullName", sql.NVarChar(100), fullName.trim())
      .input("Email", sql.NVarChar(150), normalizedEmail)
      .input("PasswordHash", sql.NVarChar(255), passwordHash)
      .input("Phone", sql.NVarChar(20), phone ? phone.trim() : null)
      .query(`
        INSERT INTO Users (
          FullName,
          Email,
          PasswordHash,
          Phone,
          Role,
          AuthProvider,
          IsActive,
          CreatedAt
        )
        OUTPUT
          INSERTED.UserID,
          INSERTED.FullName,
          INSERTED.Email,
          INSERTED.Role
        VALUES (
          @FullName,
          @Email,
          @PasswordHash,
          @Phone,
          'user',
          'password',
          1,
          SYSDATETIME()
        )
      `);

    const user = result.recordset[0];

    return res.status(201).json({
      success: true,
      message:
        "Account created. Pick a club to apply for membership and your member dashboard unlocks.",
      user,
    });
  } catch (error) {
    console.error("Registration error:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Email is already registered.",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Registration failed. " + error.message,
    });
  }
};

// LOGIN USER (email + password - members, coaches, club admins)
const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required.",
      });
    }

    const pool = getPool();

    const result = await pool
      .request()
      .input("Email", sql.NVarChar(150), email.trim().toLowerCase())
      .query(`
        SELECT
          UserID,
          FullName,
          Email,
          PasswordHash,
          Role,
          Phone,
          AvatarURL,
          IsActive
        FROM Users
        WHERE Email = @Email
      `);

    if (result.recordset.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password.",
      });
    }

    const user = result.recordset[0];

    if (!user.IsActive) {
      return res.status(403).json({
        success: false,
        message: "Your account has been deactivated. Please contact administration.",
      });
    }

    // Accounts created by the retired Google flow have no password hash.
    if (!user.PasswordHash) {
      return res.status(400).json({
        success: false,
        code: "NO_PASSWORD",
        message: "This account has no password set. Ask the platform owner to reset it.",
      });
    }

    const passwordMatches = await bcrypt.compare(password, user.PasswordHash);

    if (!passwordMatches) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password.",
      });
    }

    // The software owner owns no club, so this door cannot mint a console
    // session - it used to hand back a member token with an empty workspace and
    // the owner never reached the review queue. Refuse, and name the right door.
    if (user.Role === "super_admin") {
      return res.status(403).json({
        success: false,
        code: "PLATFORM_OWNER",
        message: "This is the software owner account. Sign in at the owner console.",
      });
    }

    await pool
      .request()
      .input("UserID", sql.Int, user.UserID)
      .query("UPDATE Users SET LastLoginAt = SYSDATETIME() WHERE UserID = @UserID");

    const clubs = await loadClubsForUser(user.UserID);
    const activeClub = pickDefaultClub(clubs);

    const baseUser = {
      userId: user.UserID,
      fullName: user.FullName,
      email: user.Email,
      role: user.Role,
      phone: user.Phone,
      avatarUrl: user.AvatarURL,
    };

    // Exactly one usable club: go straight in, no chooser screen.
    if (activeClub) {
      const session = clubSession(user, activeClub);
      return res.status(200).json({
        success: true,
        message: "Login successful.",
        token: session.token,
        club: session.club,
        clubs,
        requiresClubSelection: false,
        user: { ...baseUser, club: session.club },
      });
    }

    // Several clubs (or none): hand back an unscoped token so the client can
    // list/choose. It cannot read any club data until a club is selected.
    return res.status(200).json({
      success: true,
      message: clubs.length
        ? "Choose a club to continue."
        : "Login successful. Join a club to unlock your member dashboard.",
      token: generateToken({ userId: user.UserID, role: user.Role }),
      clubs,
      requiresClubSelection: clubs.filter((c) => c.status === "Active").length > 0,
      user: baseUser,
    });
  } catch (error) {
    console.error("Login error:", error);

    return res.status(500).json({
      success: false,
      message: "Login failed.",
    });
  }
};

// GOOGLE SIGN-IN (club owners buying the software, and members who prefer it)
const googleLogin = async (req, res) => {
  try {
    const { credential, intent } = req.body || {};

    if (!credential) {
      return res.status(400).json({
        success: false,
        message: "A Google credential is required.",
      });
    }

    if (!isGoogleConfigured()) {
      return res.status(503).json({
        success: false,
        code: "GOOGLE_NOT_CONFIGURED",
        message:
          "Google sign-in is not configured on this server yet (GOOGLE_CLIENT_ID is missing).",
      });
    }

    const profile = await verifyGoogleCredential(credential);

    if (!profile.emailVerified) {
      return res.status(403).json({
        success: false,
        message: "Your Google account email is not verified.",
      });
    }

    const pool = getPool();

    const found = await pool
      .request()
      .input("Email", sql.NVarChar(150), profile.email)
      .query(`
        SELECT UserID, FullName, Email, Role, Phone, AvatarURL, IsActive, GoogleSub
        FROM Users
        WHERE Email = @Email
      `);

    let user = found.recordset[0];

    if (user && !user.IsActive) {
      return res.status(403).json({
        success: false,
        message: "Your account has been deactivated. Please contact administration.",
      });
    }

    if (!user) {
      const inserted = await pool
        .request()
        .input("FullName", sql.NVarChar(100), profile.name)
        .input("Email", sql.NVarChar(150), profile.email)
        .input("GoogleSub", sql.NVarChar(255), profile.sub)
        .input("AvatarURL", sql.NVarChar(sql.MAX), profile.picture)
        .query(`
          INSERT INTO Users (FullName, Email, PasswordHash, Role, AvatarURL, GoogleSub, AuthProvider, IsActive, CreatedAt)
          OUTPUT INSERTED.UserID, INSERTED.FullName, INSERTED.Email, INSERTED.Role, INSERTED.AvatarURL, INSERTED.Phone, INSERTED.IsActive
          VALUES (@FullName, @Email, NULL, 'user', @AvatarURL, @GoogleSub, 'google', 1, SYSDATETIME())
        `);

      user = inserted.recordset[0];
    } else {
      // Link the Google identity to the existing account so the two sign-in
      // paths always resolve to the same person.
      await pool
        .request()
        .input("UserID", sql.Int, user.UserID)
        .input("GoogleSub", sql.NVarChar(255), profile.sub)
        .query(`
          UPDATE Users
          SET
            GoogleSub = @GoogleSub,
            AuthProvider = 'google',
            LastLoginAt = SYSDATETIME()
          WHERE UserID = @UserID
        `);
    }

    const clubs = await loadClubsForUser(user.UserID);
    const activeClub = pickDefaultClub(clubs);

    const baseUser = {
      userId: user.UserID,
      fullName: user.FullName,
      email: user.Email,
      role: user.Role,
      phone: user.Phone,
      avatarUrl: user.AvatarURL,
    };

    // `intent: "owner"` never opens a club session - it is only ever used to
    // start/check a software subscription request.
    if (intent === "owner") {
      return res.status(200).json({
        success: true,
        message: "Signed in with Google.",
        token: generateToken({ userId: user.UserID, role: user.Role }),
        user: baseUser,
        clubs,
        requiresClubSelection: false,
      });
    }

    if (activeClub) {
      const session = clubSession(user, activeClub);
      return res.status(200).json({
        success: true,
        message: "Signed in with Google.",
        token: session.token,
        club: session.club,
        clubs,
        requiresClubSelection: false,
        user: { ...baseUser, club: session.club },
      });
    }

    return res.status(200).json({
      success: true,
      message: clubs.length
        ? "Choose a club to continue."
        : "Signed in. Join a club to unlock your member dashboard.",
      token: generateToken({ userId: user.UserID, role: user.Role }),
      clubs,
      requiresClubSelection: clubs.filter((c) => c.status === "Active").length > 0,
      user: baseUser,
    });
  } catch (error) {
    console.error("Google login error:", error);

    return res.status(401).json({
      success: false,
      message: "Google sign-in failed. Please try again.",
    });
  }
};

// CHOOSE WHICH CLUB THIS SESSION WORKS IN
const selectClub = async (req, res) => {
  try {
    const { clubSlug, slug } = req.body || {};
    const wanted = String(clubSlug || slug || "").trim();

    if (!wanted) {
      return res.status(400).json({
        success: false,
        message: "A club is required.",
      });
    }

    const clubs = await loadClubsForUser(req.user.userId);
    const club = clubs.find((c) => c.slug.toLowerCase() === wanted.toLowerCase());

    if (!club) {
      return res.status(403).json({
        success: false,
        message: "You do not have access to this club.",
      });
    }

    if (!club.isActive) {
      return res.status(403).json({
        success: false,
        message: "Your access to this club has been revoked.",
      });
    }

    if (club.status !== "Active") {
      return res.status(403).json({
        success: false,
        message: `This club is currently ${club.status.toLowerCase()}. Please contact the club administrator.`,
      });
    }

    const pool = getPool();
    const account = await pool
      .request()
      .input("UserID", sql.Int, req.user.userId)
      .query("SELECT FullName, Email, AvatarURL, Phone FROM Users WHERE UserID = @UserID");

    const row = account.recordset[0] || {};

    return res.status(200).json({
      success: true,
      message: `Switched to ${club.name}.`,
      token: generateToken({
        userId: req.user.userId,
        clubId: club.clubId,
        role: club.role === "member" ? "user" : club.role,
      }),
      club,
      clubs,
      user: {
        userId: req.user.userId,
        fullName: row.FullName,
        email: row.Email,
        phone: row.Phone,
        avatarUrl: row.AvatarURL,
        club,
      },
    });
  } catch (error) {
    console.error("selectClub error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to switch club.",
    });
  }
};

// GET CURRENT AUTHENTICATED USER PROFILE
const getMe = async (req, res) => {
  try {
    const pool = getPool();
    const clubs = await loadClubsForUser(req.user.userId);

    const result = await pool
      .request()
      .input("UserID", sql.Int, req.user.userId)
      .query(`
        SELECT
          UserID,
          FullName,
          Email,
          Role,
          Phone,
          AvatarURL,
          IsActive,
          CreatedAt
        FROM Users
        WHERE UserID = @UserID
      `);

    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    const row = result.recordset[0];
    const activeClub = req.user.clubId
      ? clubs.find((c) => c.clubId === req.user.clubId) || null
      : null;

    const profile = {
      userId: row.UserID,
      fullName: row.FullName,
      email: row.Email,
      role: req.user.role,
      accountRole: row.Role,
      phone: row.Phone,
      avatarUrl: row.AvatarURL,
      isActive: row.IsActive,
      createdAt: row.CreatedAt,
      clubs,
      club: activeClub,
      hasApplication: false,
      application: null,
      membership: null,
    };

    // Without a club there is no membership to look up (and nothing the RLS
    // policies would let us read anyway).
    if (!req.user.clubId) {
      return res.status(200).json({ success: true, user: profile });
    }

    const membership = await runWithTenant({ clubId: req.user.clubId }, async () => {
      const scoped = getPool();
      return scoped
        .request()
        .input("UserID", sql.Int, req.user.userId)
        .query(`
          SELECT
            m.MembershipID,
            m.MembershipNumber,
            m.MembershipStatus,
            m.StartDate,
            m.EndDate,
            a.ApplicationID,
            a.ApplicationStatus,
            a.Address,
            a.EmergencyContactName,
            a.EmergencyContactPhone,
            p.PlanID,
            p.PlanName,
            p.MonthlyFee
          FROM MembershipApplications a
          LEFT JOIN Memberships m ON m.ApplicationID = a.ApplicationID
          LEFT JOIN MembershipPlans p ON p.PlanID = ISNULL(m.PlanID, a.PlanID)
          WHERE a.UserID = @UserID
          ORDER BY a.AppliedAt DESC
        `);
    });

    const m = membership.recordset[0];

    if (m && m.ApplicationID) {
      profile.hasApplication = true;
      profile.application = {
        applicationId: m.ApplicationID,
        status: m.ApplicationStatus,
        address: m.Address,
        emergencyContactName: m.EmergencyContactName,
        emergencyContactPhone: m.EmergencyContactPhone,
      };

      if (m.MembershipID) {
        profile.membership = {
          membershipId: m.MembershipID,
          membershipNumber: m.MembershipNumber,
          status: m.MembershipStatus,
          startDate: m.StartDate,
          endDate: m.EndDate,
          planId: m.PlanID,
          planName: m.PlanName,
          monthlyFee: m.MonthlyFee,
        };
      }
    }

    return res.status(200).json({ success: true, user: profile });
  } catch (error) {
    console.error("GetMe error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch user profile.",
    });
  }
};

// UPDATE USER PROFILE
const updateProfile = async (req, res) => {
  try {
    const { fullName, phone, avatarUrl } = req.body;

    if (!fullName) {
      return res.status(400).json({
        success: false,
        message: "Full name is required.",
      });
    }

    const pool = getPool();
    // Never let a blank field wipe an existing avatar - only a real URL replaces it.
    const avatarUpdate =
      typeof avatarUrl === "string" && avatarUrl.trim() ? avatarUrl.trim() : null;

    await pool
      .request()
      .input("UserID", sql.Int, req.user.userId)
      .input("FullName", sql.NVarChar(100), fullName.trim())
      .input("Phone", sql.NVarChar(20), phone ? phone.trim() : null)
      .input("AvatarURL", sql.NVarChar(sql.MAX), avatarUpdate)
      .query(`
        UPDATE Users
        SET
          FullName = @FullName,
          Phone = @Phone,
          AvatarURL = COALESCE(@AvatarURL, AvatarURL)
        WHERE UserID = @UserID
      `);

    if (req.user.clubId) {
      await runWithTenant({ clubId: req.user.clubId }, () =>
        notifyUser({
          userId: req.user.userId,
          title: "Profile Updated",
          message:
            "Your profile information and contact details have been updated successfully.",
          type: "system",
          link: "/user/profile",
        })
      );
    }

    return res.status(200).json({
      success: true,
      message: "Profile updated successfully.",
      user: {
        fullName: fullName.trim(),
        phone: phone ? phone.trim() : null,
        avatarUrl: avatarUpdate || undefined,
      },
    });
  } catch (error) {
    console.error("Update profile error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update profile.",
    });
  }
};

// UPLOAD PROFILE AVATAR
const uploadAvatar = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please choose an image file for your profile picture.",
      });
    }

    const uploaded = await processUploadedFile(req.file, req);
    if (!uploaded || !uploaded.url) {
      return res.status(400).json({
        success: false,
        message: "Failed to process image file.",
      });
    }

    const pool = getPool();
    await pool
      .request()
      .input("UserID", sql.Int, req.user.userId)
      .input("AvatarURL", sql.NVarChar(sql.MAX), uploaded.url)
      .query("UPDATE Users SET AvatarURL = @AvatarURL WHERE UserID = @UserID");

    if (req.user.clubId) {
      await runWithTenant({ clubId: req.user.clubId }, () =>
        notifyUser({
          userId: req.user.userId,
          title: "Profile Photo Changed",
          message: "Your new profile avatar has been uploaded and applied.",
          type: "system",
          link: "/user/profile",
        })
      );
    }

    return res.status(200).json({
      success: true,
      message: "Profile picture uploaded successfully!",
      avatarUrl: uploaded.url,
    });
  } catch (error) {
    console.error("uploadAvatar error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to upload profile picture. " + error.message,
    });
  }
};

module.exports = {
  registerUser,
  loginUser,
  googleLogin,
  selectClub,
  getMe,
  updateProfile,
  uploadAvatar,
  loadClubsForUser,
};
