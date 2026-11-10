const express = require("express");
const router = express.Router();

const {
  getCoachProfile,
  updateCoachProfile,
  uploadCoachPhoto,
  getCoachOverview,
  getCoachStudents,
  markStudentAttendance,
  getCoachAttendanceHistory,
  getCoachSchedules,
  createCoachSchedule,
  deleteCoachSchedule,
  getCoachTournaments,
  createCoachTournament,
  updateCoachTournament,
  deleteCoachTournament,
  createCoachMatch,
  updateCoachMatch,
  deleteCoachMatch,
  getCoachEquipment,
  createCoachEquipment,
  updateCoachEquipment,
  deleteCoachEquipment,
  issueCoachEquipment,
  returnCoachEquipment,
  getCoachEquipmentIssues,
  getCoachTrainers,
  getCoachSalary,
} = require("../controllers/coachController");

const { protect, coachOnly } = require("../middleware/authMiddleware");
const { upload } = require("../utils/upload");

// Every route in this router requires an authenticated coach account
router.use(protect, coachOnly);

// Multer failures (wrong file type / too large) must surface as 400, not 500.
const uploadPhoto = (req, res, next) =>
  upload.single("avatar")(req, res, (err) =>
    err
      ? res.status(400).json({
          success: false,
          message: err.message || "Only image files up to 10MB are allowed.",
        })
      : next()
  );

// Own profile
router.get("/profile", getCoachProfile);
router.put("/profile", updateCoachProfile);
router.post("/profile/photo", uploadPhoto, uploadCoachPhoto);

// Dashboard
router.get("/overview", getCoachOverview);

// Students & attendance
router.get("/students", getCoachStudents);
router.get("/attendance/history", getCoachAttendanceHistory);
router.post("/attendance", markStudentAttendance);

// Training schedules
router.get("/schedules", getCoachSchedules);
router.post("/schedules", createCoachSchedule);
router.delete("/schedules/:id", deleteCoachSchedule);

// Tournaments + matches
router.get("/tournaments", getCoachTournaments);
router.post("/tournaments", createCoachTournament);
router.put("/tournaments/:id", updateCoachTournament);
router.delete("/tournaments/:id", deleteCoachTournament);

router.post("/matches", createCoachMatch);
router.put("/matches/:matchId", updateCoachMatch);
router.delete("/matches/:matchId", deleteCoachMatch);

// Equipment / gear
router.get("/equipment", getCoachEquipment);
router.get("/equipment/issues", getCoachEquipmentIssues);
router.post("/equipment", createCoachEquipment);
router.put("/equipment/:id", updateCoachEquipment);
router.delete("/equipment/:id", deleteCoachEquipment);
router.post("/equipment/issue", issueCoachEquipment);
router.put("/equipment/return/:issueId", returnCoachEquipment);

// Squad (trainers) + salary ledger
router.get("/trainers", getCoachTrainers);
router.get("/salary", getCoachSalary);

module.exports = router;
