const express = require("express");
const router = express.Router();

const {
  getSportsComprehensive,
  getAllCoaches,
  getCoachById,
  createCoach,
  updateCoach,
  deleteCoach,
  getMySportEnrollments,
  enrollInSport,
  dropSportEnrollment,
  getAllTeams,
  getTeamById,
  createTeam,
  addTeamMember,
  removeTeamMember,
  getAllTournaments,
  getTournamentById,
  createTournament,
  createMatch,
  updateMatch,
  getMyAttendance,
  getSportAttendance,
  markAttendance,
  getTrainingSchedules,
  createTrainingSchedule,
  deleteTrainingSchedule,
  getMyPerformance,
  recordMemberPerformance,
  getAllEquipment,
  createEquipment,
  issueEquipment,
  returnEquipment,
  getClubAnalyticsReport,
} = require("../controllers/sportsManagementController");

const { protect, adminOnly } = require("../middleware/authMiddleware");

// ==========================================
// PUBLIC / BROWSEABLE ROUTES
// ==========================================
router.get("/sports", getSportsComprehensive);
router.get("/coaches", getAllCoaches);
router.get("/coaches/:id", getCoachById);
router.get("/schedules", getTrainingSchedules);
router.get("/teams", getAllTeams);
router.get("/teams/:id", getTeamById);
router.get("/tournaments", getAllTournaments);
router.get("/tournaments/:id", getTournamentById);

// ==========================================
// MEMBER PROTECTED ROUTES
// ==========================================
router.get("/enrollments/my", protect, getMySportEnrollments);
router.post("/enroll", protect, enrollInSport);
router.delete("/enrollments/:enrollmentId", protect, dropSportEnrollment);
router.get("/attendance/my", protect, getMyAttendance);
router.get("/performance/my", protect, getMyPerformance);

// ==========================================
// ADMIN / COACH MANAGEMENT ROUTES
// ==========================================
router.post("/coaches", protect, adminOnly, createCoach);
router.put("/coaches/:id", protect, adminOnly, updateCoach);
router.delete("/coaches/:id", protect, adminOnly, deleteCoach);

router.post("/teams", protect, adminOnly, createTeam);
router.post("/teams/:id/members", protect, adminOnly, addTeamMember);
router.delete("/teams/members/:memberId", protect, adminOnly, removeTeamMember);

router.post("/tournaments", protect, adminOnly, createTournament);
router.post("/matches", protect, adminOnly, createMatch);
router.put("/matches/:matchId", protect, adminOnly, updateMatch);

router.get("/attendance/sport/:sportId", protect, adminOnly, getSportAttendance);
router.post("/attendance/mark", protect, adminOnly, markAttendance);

router.post("/schedules", protect, adminOnly, createTrainingSchedule);
router.delete("/schedules/:id", protect, adminOnly, deleteTrainingSchedule);

router.post("/performance", protect, adminOnly, recordMemberPerformance);

router.get("/equipment", protect, adminOnly, getAllEquipment);
router.post("/equipment", protect, adminOnly, createEquipment);
router.post("/equipment/issue", protect, adminOnly, issueEquipment);
router.put("/equipment/return/:issueId", protect, adminOnly, returnEquipment);

router.get("/analytics", protect, adminOnly, getClubAnalyticsReport);

module.exports = router;

