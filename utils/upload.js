const multer = require("multer");
const path = require("path");
const os = require("os");
const fs = require("fs");
const cloudinary = require("cloudinary").v2;

// Configure Cloudinary if environment variables are provided
if (
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  console.log("Cloudinary configured successfully.");
} else {
  console.log("Cloudinary env vars not set. Local storage fallback will be used for uploaded receipts.");
}

// Ensure the upload directory is writable.
//
// On serverless platforms (Vercel) the deployment bundle is read-only, so we
// fall back to the OS temp directory. Temp files disappear with the invocation,
// which is why CLOUDINARY_* should be set in production - Cloudinary is the only
// durable receipt store there.
const pickWritableDir = (preferred) => {
  try {
    if (!fs.existsSync(preferred)) fs.mkdirSync(preferred, { recursive: true });
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch {
    const fallback = path.join(os.tmpdir(), "scms-receipts");
    try {
      fs.mkdirSync(fallback, { recursive: true });
    } catch {
      // Swallow: multer will surface a clear error if the directory is unusable.
    }
    console.warn(
      `Upload directory ${preferred} is not writable (read-only serverless filesystem). ` +
        `Falling back to ${fallback}. Set CLOUDINARY_* env vars so receipts persist.`
    );
    return fallback;
  }
};

const uploadDir = pickWritableDir(path.join(__dirname, "..", "uploads", "receipts"));

// Multer storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, "receipt-" + uniqueSuffix + ext);
  },
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed!"), false);
    }
  },
});

// Helper to upload a local file to Cloudinary (or keep local)
const processUploadedFile = async (file, req) => {
  if (!file) return null;

  // If Cloudinary credentials exist, upload to Cloudinary
  if (
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  ) {
    try {
      const result = await cloudinary.uploader.upload(file.path, {
        folder: "sports_club_receipts",
      });
      // Optionally remove local file after upload
      fs.unlink(file.path, () => {});
      return {
        url: result.secure_url,
        publicId: result.public_id,
      };
    } catch (err) {
      console.warn("Cloudinary upload failed, falling back to local storage URL:", err.message);
    }
  }

  // Fallback to local server static URL
  const protocol = req ? req.protocol : "http";
  const host = req ? req.get("host") : "localhost:5000";
  const localUrl = `${protocol}://${host}/uploads/receipts/${file.filename}`;
  return {
    url: localUrl,
    publicId: file.filename,
  };
};

module.exports = { upload, processUploadedFile, cloudinary };
