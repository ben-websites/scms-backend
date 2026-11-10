const express = require("express");
const router = express.Router();

const {
  getDashboardStats,
  getAllUsers,
  toggleUserStatus,
  getAllApplications,
  reviewApplication,
  getAllPlansAdmin,
  createPlan,
  updatePlan,
  deletePlan,
  generateMonthlyVouchers,
  getAllVouchersAdmin,
  getAllPaymentsAdmin,
  reviewPayment,
  getFinesOverview,
  updateFinePolicy,
  getAdvancePaymentsAdmin,
  getAllAnnouncementsAdmin,
  createAnnouncement,
  deleteAnnouncement,
  getAllEventsAdmin,
  createEvent,
  getEventParticipants,
  deleteEvent,
  getAllSportsAdmin,
  createSport,
  deleteSport,
  getAllServicesAdmin,
  createService,
  deleteService,
} = require("../controllers/adminController");

const {
  getStaffDirectory,
  provisionCoachLogin,
  createCoachWithStaff,
  updateStaffCoach,
  createTrainer,
  updateTrainer,
  deleteTrainer,
  getStaffAttendance,
  markStaffAttendance,
  getSalaryRegister,
  paySalaries,
  getPendingApprovals,
  reviewTournament,
  reviewEquipment,
} = require("../controllers/staffController");

const { protect, adminOnly } = require("../middleware/authMiddleware");

// All admin routes are protected and adminOnly
router.use(protect, adminOnly);

// Dashboard
router.get("/dashboard", getDashboardStats);

// Users
router.get("/users", getAllUsers);
router.put("/users/:id/toggle", toggleUserStatus);

// Applications
router.get("/applications", getAllApplications);
router.put("/applications/:id/review", reviewApplication);

// Plans
router.get("/plans", getAllPlansAdmin);
router.post("/plans", createPlan);
router.put("/plans/:id", updatePlan);
router.delete("/plans/:id", deletePlan);

// Monthly Fee Vouchers
router.post("/vouchers/generate-monthly", generateMonthlyVouchers);
router.get("/vouchers", getAllVouchersAdmin);

// Payments & Receipts
router.get("/payments", getAllPaymentsAdmin);
router.put("/payments/:id/review", reviewPayment);

// Fines
router.get("/fines", getFinesOverview);
router.put("/fines/policy", updateFinePolicy);

// Advance Payments
router.get("/advance-payments", getAdvancePaymentsAdmin);

// Announcements
router.get("/announcements", getAllAnnouncementsAdmin);
router.post("/announcements", createAnnouncement);
router.delete("/announcements/:id", deleteAnnouncement);

// Events
router.get("/events", getAllEventsAdmin);
router.post("/events", createEvent);
router.get("/events/:id/participants", getEventParticipants);
router.delete("/events/:id", deleteEvent);

// Sports
router.get("/sports", getAllSportsAdmin);
router.post("/sports", createSport);
router.delete("/sports/:id", deleteSport);

// Services
router.get("/services", getAllServicesAdmin);
router.post("/services", createService);
router.delete("/services/:id", deleteService);

// ==========================================
// COACHING STAFF / TRAINERS / SALARIES
// ==========================================
router.get("/staff", getStaffDirectory);
router.post("/staff/coaches", createCoachWithStaff);
router.post("/staff/coaches/:id/account", provisionCoachLogin);
router.put("/staff/coaches/:id", updateStaffCoach);

router.post("/staff/trainers", createTrainer);
router.put("/staff/trainers/:id", updateTrainer);
router.delete("/staff/trainers/:id", deleteTrainer);

router.get("/staff/attendance", getStaffAttendance);
router.post("/staff/attendance", markStaffAttendance);

router.get("/staff/salaries", getSalaryRegister);
router.post("/staff/salaries", paySalaries);

// Coach submissions awaiting approval
router.get("/staff/approvals", getPendingApprovals);
router.put("/staff/tournaments/:id/review", reviewTournament);
router.put("/staff/equipment/:id/review", reviewEquipment);

module.exports = router;
