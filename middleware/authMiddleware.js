
const jwt = require("jsonwebtoken");


const protect = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    const token = authHeader.split(" ")[1];

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.user = {
      userId: decoded.userId,
      UserID: decoded.userId,
      role: decoded.role,
      Role: decoded.role,
    };

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token.",
    });
  }
};

const adminOnly = (req, res, next) => {
  if (req.user && req.user.role === "admin") {
    return next();
  }

  return res.status(403).json({
    success: false,
    message: "Admin access required.",
  });
};

const coachOnly = (req, res, next) => {
  if (req.user && req.user.role === "coach") {
    return next();
  }

  return res.status(403).json({
    success: false,
    message: "Coach access required.",
  });
};

const coachOrAdmin = (req, res, next) => {
  if (req.user && ["coach", "admin"].includes(req.user.role)) {
    return next();
  }

  return res.status(403).json({
    success: false,
    message: "Coach or admin access required.",
  });
};

module.exports = { protect, adminOnly, coachOnly, coachOrAdmin };
