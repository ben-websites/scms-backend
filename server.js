const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const { connectDB, getPool, runWithTenant, runWithPlatform } = require("./config/db");
const { ensureSchema } = require("./db/initSchema");
const { seedInitialData } = require("./utils/seedData");

// Import Routes
const authRoutes = require("./routes/authRoutes");
const publicRoutes = require("./routes/publicRoutes");
const clubRoutes = require("./routes/clubRoutes");
const platformRoutes = require("./routes/platformRoutes");
const membershipRoutes = require("./routes/membershipRoutes");
const voucherRoutes = require("./routes/voucherRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const eventRoutes = require("./routes/eventRoutes");
const adminRoutes = require("./routes/adminRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const sportsManagementRoutes = require("./routes/sportsManagementRoutes");
const coachRoutes = require("./routes/coachRoutes");
const reportRoutes = require("./routes/reportRoutes");
const { getPublicAnnouncements } = require("./controllers/publicController");
const { ensurePlatformOwner } = require("./controllers/platformController");

const { protect } = require("./middleware/authMiddleware");
const { resolveTenant } = require("./middleware/tenantMiddleware");

const app = express();

// Middlewares
// CORS. The deployed frontend lives on a *.vercel.app domain that changes every
// time the project is re-created (sportshub-alpha -> sportshub-zeta), so a pure
// allow-list silently stopped sending Access-Control-Allow-Origin and the
// browser reported it as an opaque CORS failure. Explicit origins still win,
// Vercel deployments and local dev are always trusted, and an unset
// CORS_ORIGINS keeps the old "allow everything" behaviour.
const corsOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const isTrustedOrigin = (origin) =>
  /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.vercel\.app$/i.test(origin) ||
  /^http:\/\/localhost(:\d+)?$/i.test(origin) ||
  /^http:\/\/127\.0\.0\.1(:\d+)?$/i.test(origin);

app.use(
  cors({
    origin: (origin, callback) => {
      // No Origin header: same-origin, curl or server-to-server call.
      if (!origin) return callback(null, true);
      if (corsOrigins.includes(origin)) return callback(null, true);
      if (isTrustedOrigin(origin)) return callback(null, true);
      if (!corsOrigins.length) return callback(null, true);

      // Visible in the Vercel function logs instead of failing silently.
      console.warn(`[cors] Origin not in CORS_ORIGINS: ${origin}`);
      return callback(null, false);
    },
    credentials: true,
    optionsSuccessStatus: 204,
  })
);
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

// Static uploads folder for locally uploaded receipts.
// On Vercel the filesystem is read-only, so receipts must go to Cloudinary
// (set the CLOUDINARY_* env vars) - see utils/upload.js.
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// One-time database bootstrap (connect + schema + migrations + seed), shared by
// every request. On a serverless platform this runs on the first cold-start
// request.
//
// Seeding runs inside the first club's tenant context: the seeded sports,
// plans and announcements are that club's data, so they must not be written
// with an empty ClubID (the column default would be null in platform mode).
//
// The platform owner account is created last, from PLATFORM_ADMIN_EMAILS, so a
// fresh deployment can sign into the console without any manual SQL.
const currentClubId = async () => {
  const { rows } = await getPool().query(
    "select ClubID as clubid from Clubs order by ClubID limit 1"
  );
  return rows.length ? Number(rows[0].clubid) : null;
};

let bootstrap = null;
const ensureDatabase = () => {
  if (!bootstrap) {
    bootstrap = (async () => {
      await connectDB();
      await ensureSchema();

      const clubId = await currentClubId();
      if (clubId) {
        await runWithTenant({ clubId }, () => seedInitialData());
      }

      await ensurePlatformOwner();
    })().catch((err) => {
      bootstrap = null;
      throw err;
    });
  }
  return bootstrap;
};

app.use(async (req, res, next) => {
  try {
    await ensureDatabase();
    next();
  } catch (error) {
    next(error);
  }
});

// Mount API Routes
//
// Two families:
//   /api/auth, /api/public, /api/platform  -> cross-club (login, website, SaaS)
//   everything else                         -> club scoped: `protect` resolves the
//                                              caller and `resolveTenant` opens the
//                                              row level security bubble for the
//                                              club carried by the token.
app.use("/api/auth", authRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/platform", platformRoutes);

app.use("/api/club", protect, resolveTenant, clubRoutes);
app.use("/api/membership", protect, resolveTenant, membershipRoutes);
app.use("/api/vouchers", protect, resolveTenant, voucherRoutes);
app.use("/api/payments", protect, resolveTenant, paymentRoutes);
app.use("/api/events", protect, resolveTenant, eventRoutes);
app.use("/api/admin", protect, resolveTenant, adminRoutes);
app.use("/api/notifications", protect, resolveTenant, notificationRoutes);
app.use("/api/sports-management", protect, resolveTenant, sportsManagementRoutes);
app.use("/api/coach", protect, resolveTenant, coachRoutes);
app.use("/api/reports", protect, resolveTenant, reportRoutes);

// Direct announcements endpoint alias (the featured club's public notices)
app.get("/api/announcements", (req, res, next) =>
  runWithPlatform(() => getPublicAnnouncements(req, res).catch(next))
);

// Root Health Check
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Sports Hub Management System API is running smoothly!",
    timestamp: new Date(),
  });
});

// Database Test Endpoint
app.get("/api/test-db", async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.query(`
      SELECT
        current_database() AS databasename,
        (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public') AS totaltables
    `);

    res.json({
      success: true,
      message: "Database connection verified!",
      database: result.rows[0].databasename,
      totalTables: Number(result.rows[0].totaltables),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `API endpoint not found: ${req.method} ${req.originalUrl}`,
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error("Unhandled Server Error:", err);
  res.status(500).json({
    success: false,
    message: err.message || "Internal server error occurred.",
  });
});

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    await ensureDatabase();

    // Express 5 hands this same callback to the server's "error" event, so the
    // error has to be checked first. Without this a busy port is reported as a
    // successful start and the process then exits silently with code 0 - which
    // is exactly what a second `node server.js` used to look like.
    app.listen(PORT, (error) => {
      if (error) {
        console.error(
          error.code === "EADDRINUSE"
            ? `Port ${PORT} is already in use - another copy of the server is still running.\n` +
                "Stop it first, then start this one again."
            : "Could not start the HTTP server:"
        );
        if (error.code !== "EADDRINUSE") console.error(error);
        process.exit(1);
        return;
      }
      console.log(`Sports Hub Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Server startup failed:", error);
    process.exit(1);
  }
};

// Locally we own the HTTP server; on Vercel the platform imports the app below.
if (require.main === module) {
  startServer();
}

module.exports = app;
