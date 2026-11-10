const express = require("express");
const router = express.Router();

const {
  registerUser,
  loginUser,
  getMe,
  updateProfile,
  uploadAvatar,
} = require("../controllers/authController");

const { protect } = require("../middleware/authMiddleware");
const { upload } = require("../utils/upload");

router.post("/register", registerUser);
router.post("/login", loginUser);
router.get("/me", protect, getMe);
router.put("/profile", protect, updateProfile);
router.post("/avatar", protect, upload.single("avatar"), uploadAvatar);

module.exports = router;
