/**
 * Logo and cover uploads for a club's public page.
 *
 * Kept apart from utils/upload.js (payment receipts) because these are branding
 * assets with a tighter size limit and their own folder - a logo should never
 * land in the receipts directory the payment screens list.
 *
 * Localhost installs store the file under uploads/clubs and serve it from
 * /uploads; when CLOUDINARY_* is configured the image goes to Cloudinary and
 * the local copy is removed, exactly like receipts.
 */
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { cloudinary } = require("./upload");

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg"]);
const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
]);

const uploadDir = path.join(__dirname, "..", "uploads", "clubs");

try {
  fs.mkdirSync(uploadDir, { recursive: true });
} catch (error) {
  console.warn("Could not create the club image directory:", error.message);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeExt = IMAGE_EXTENSIONS.has(ext) ? ext : ".png";
    const clubId = req.user?.clubId || "unknown";
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    cb(null, `club-${clubId}-${unique}${safeExt}`);
  },
});

const clubImageUpload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB is plenty for a logo or banner
  fileFilter: (req, file, cb) => {
    if (IMAGE_MIME_TYPES.has(file.mimetype)) cb(null, true);
    else cb(new Error("Upload a PNG, JPG, WEBP or SVG image."), false);
  },
});

// Turns multer's callback-style failures into a JSON 400 instead of letting
// them reach the generic 500 handler.
const singleImage = (fieldName) => (req, res, next) => {
  clubImageUpload.single(fieldName)(req, res, (error) => {
    if (!error) return next();

    const message =
      error.code === "LIMIT_FILE_SIZE"
        ? "That image is larger than 2 MB. Please choose a smaller file."
        : error.message || "The image could not be uploaded.";

    return res.status(400).json({ success: false, message });
  });
};

const cloudinaryConfigured = () =>
  Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
  );

const storeClubImage = async (file, req) => {
  if (!file) return null;

  if (cloudinaryConfigured()) {
    try {
      const result = await cloudinary.uploader.upload(file.path, {
        folder: "scms_club_branding",
      });
      fs.unlink(file.path, () => {});
      return result.secure_url;
    } catch (error) {
      console.warn("Cloudinary club image upload failed, keeping the local copy:", error.message);
    }
  }

  const protocol = req.protocol || "http";
  const host = req.get("host");
  return `${protocol}://${host}/uploads/clubs/${file.filename}`;
};

// Best effort: only files this module created, never an arbitrary path.
const removeLocalImage = (url) => {
  if (!url || typeof url !== "string" || !url.includes("/uploads/clubs/")) return;

  const filename = url.split("/uploads/clubs/").pop().split("?")[0];

  if (!filename || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    return;
  }

  fs.unlink(path.join(uploadDir, filename), () => {});
};

module.exports = { singleImage, storeClubImage, removeLocalImage };
