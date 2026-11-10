const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const { connectDB, getPool } = require("./config/db");
const { ensureSchema } = require("./db/initSchema");
const { seedInitialData } = require("./utils/seedData");

// Import Routes
const authRoutes = require("./routes/authRoutes");
const publicRoutes = require("./routes/publicRoutes");
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

// One-time database bootstrap (connect + schema + seed), shared by every
// request. On a serverless platform this runs on the first cold-start request.
let bootstrap = null;
const ensureDatabase = () => {
  if (!bootstrap) {
    bootstrap = (async () => {
      await connectDB();
      await ensureSchema();
      await seedInitialData();
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
app.use("/api/auth", authRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/membership", membershipRoutes);
app.use("/api/vouchers", voucherRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/sports-management", sportsManagementRoutes);
app.use("/api/coach", coachRoutes);
app.use("/api/reports", reportRoutes);

// Direct announcements endpoint alias
app.get("/api/announcements", getPublicAnnouncements);

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

    app.listen(PORT, () => {
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
