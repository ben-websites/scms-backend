const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { sql, getPool } = require("../config/db");
const { processUploadedFile } = require("../utils/upload");
const { notifyAdmins, notifyUser } = require("../utils/notificationService");

const generateToken = (user) => {
  return jwt.sign(
    {
      userId: user.UserID,
      role: user.Role,
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
};

// REGISTER USER
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

    // Public registration ALWAYS creates a normal user.
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
          1,
          SYSDATETIME()
        )
      `);

    const user = result.recordset[0];

    // Notification for user & admins
    await Promise.all([
      notifyUser({
        userId: user.UserID,
        title: "Welcome to Sports Hub! 🏆",
        message: `Welcome ${user.FullName}! Complete your membership application to get access to all club facilities.`,
        type: "system",
        link: "/user/membership",
      }),
      notifyAdmins({
        title: "New User Registered",
        message: `${user.FullName} (${user.Email}) has just registered a new account on Sports Hub.`,
        type: "admin",
        link: "/admin/users",
      }),
    ]);

    return res.status(201).json({
      success: true,
      message: "Registration successful. Please log in.",
      user,
    });
  } catch (error) {
    console.error("Registration error:", error);

    if (error.number === 2601 || error.number === 2627) {
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

// LOGIN USER
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

    const passwordMatches = await bcrypt.compare(
      password,
      user.PasswordHash
    );

    if (!passwordMatches) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password.",
      });
    }

    const token = generateToken(user);

    // Also check if this user has any membership application or active membership
    const membershipCheck = await pool
      .request()
      .input("UserID", sql.Int, user.UserID)
      .query(`
        SELECT TOP 1
          m.MembershipID,
          m.MembershipNumber,
          m.MembershipStatus,
          a.ApplicationID,
          a.ApplicationStatus,
          p.PlanName
        FROM MembershipApplications a
        LEFT JOIN Memberships m ON m.ApplicationID = a.ApplicationID
        LEFT JOIN MembershipPlans p ON p.PlanID = a.PlanID
        WHERE a.UserID = @UserID
        ORDER BY a.AppliedAt DESC
      `);

    const membershipInfo = membershipCheck.recordset[0] || null;

    return res.status(200).json({
      success: true,
      message: "Login successful.",
      token,
      user: {
        userId: user.UserID,
        fullName: user.FullName,
        email: user.Email,
        role: user.Role,
        phone: user.Phone,
        avatarUrl: user.AvatarURL,
        membership: membershipInfo,
      },
    });
  } catch (error) {
    console.error("Login error:", error);

    return res.status(500).json({
      success: false,
      message: "Login failed.",
    });
  }
};

// GET CURRENT AUTHENTICATED USER PROFILE
const getMe = async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool
      .request()
      .input("UserID", sql.Int, req.user.userId)
      .query(`
        SELECT
          u.UserID,
          u.FullName,
          u.Email,
          u.Role,
          u.Phone,
          u.AvatarURL,
          u.IsActive,
          u.CreatedAt,
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
        FROM Users u
        LEFT JOIN MembershipApplications a ON a.UserID = u.UserID
        LEFT JOIN Memberships m ON m.UserID = u.UserID
        LEFT JOIN MembershipPlans p ON p.PlanID = ISNULL(m.PlanID, a.PlanID)
        WHERE u.UserID = @UserID
        ORDER BY a.AppliedAt DESC
      `);

    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    const row = result.recordset[0];

    return res.status(200).json({
      success: true,
      user: {
        userId: row.UserID,
        fullName: row.FullName,
        email: row.Email,
        role: row.Role,
        phone: row.Phone,
        avatarUrl: row.AvatarURL,
        isActive: row.IsActive,
        createdAt: row.CreatedAt,
        hasApplication: !!row.ApplicationID,
        application: row.ApplicationID ? {
          applicationId: row.ApplicationID,
          status: row.ApplicationStatus,
          address: row.Address,
          emergencyContactName: row.EmergencyContactName,
          emergencyContactPhone: row.EmergencyContactPhone,
        } : null,
        membership: row.MembershipID ? {
          membershipId: row.MembershipID,
          membershipNumber: row.MembershipNumber,
          status: row.MembershipStatus,
          startDate: row.StartDate,
          endDate: row.EndDate,
          planId: row.PlanID,
          planName: row.PlanName,
          monthlyFee: row.MonthlyFee,
        } : null,
      },
    });
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
    // Never let a blank field wipe an existing avatar — only a real URL replaces it.
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
          AvatarURL = CASE WHEN @AvatarURL IS NOT NULL THEN @AvatarURL ELSE AvatarURL END
        WHERE UserID = @UserID
      `);

    await notifyUser({
      userId: req.user.userId,
      title: "Profile Updated",
      message: "Your profile information and contact details have been updated successfully.",
      type: "system",
      link: "/user/profile",
    });

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

    await notifyUser({
      userId: req.user.userId,
      title: "Profile Photo Changed",
      message: "Your new profile avatar has been uploaded and applied.",
      type: "system",
      link: "/user/profile",
    });

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

module.exports = { registerUser, loginUser, getMe, updateProfile, uploadAvatar };
