const express = require("express");
const router = express.Router();

const {
  registerUser,
  loginUser,
  googleLogin,
  selectClub,
  getMe,
  updateProfile,
  uploadAvatar,
} = require("../controllers/authController");

const { protect } = require("../middleware/authMiddleware");
const { upload } = require("../utils/upload");

// Cross-club endpoints: they cannot touch club data, only identity.
router.post("/register", registerUser);
router.post("/login", loginUser);
router.post("/google", googleLogin);
router.post("/select-club", protect, selectClub);

router.get("/me", protect, getMe);
router.put("/profile", protect, updateProfile);
router.post("/avatar", protect, upload.single("avatar"), uploadAvatar);

module.exports = router;
