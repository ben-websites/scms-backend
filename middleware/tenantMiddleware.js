const { runWithTenant, runWithPlatform } = require("../config/db");

const clubRequired = (res) =>
  res.status(403).json({
    success: false,
    code: "CLUB_REQUIRED",
    message:
      "This session is not scoped to a club yet. Choose a club to continue.",
  });

/**
 * Opens the club "bubble" for the rest of the request.
 *
 * Everything downstream - every query, including the ones the controllers
 * already write - runs with app.club_id set, so PostgreSQL row level security
 * only exposes the rows of this club. Must run after `protect`.
 */
const resolveTenant = (req, res, next) => {
  const clubId = req.user?.clubId;

  if (!clubId) return clubRequired(res);

  return runWithTenant({ clubId }, () => next());
};

/**
 * Platform owner scope: cross-club access. `protect` has already rejected
 * ordinary members, so this only checks the token was minted for the platform.
 */
const platformOnly = (req, res, next) => {
  if (req.user?.role !== "super_admin" || !req.user?.platform) {
    return res.status(403).json({
      success: false,
      message: "Platform owner access required.",
    });
  }

  return runWithPlatform(() => next());
};

/**
 * For public endpoints that may or may not have a session (a club profile page
 * rendered while logged in, for example): opens the club bubble when the URL
 * carries one, but never blocks anonymous visitors.
 */
const optionalTenant = (req, res, next) => {
  const clubId = req.clubContextId;
  if (!clubId) return runWithPlatform(() => next());
  return runWithTenant({ clubId }, () => next());
};

/**
 * Scope for the anonymous website: cross-club reads.
 *
 * The directory and a club's public page have to see rows of clubs the visitor
 * is not a member of, which row level security only allows in platform mode.
 * Every controller underneath still filters by an explicit ClubID and returns
 * whitelisted columns only, so this does not open the internal tables.
 */
const publicScope = (req, res, next) => runWithPlatform(() => next());

module.exports = { resolveTenant, platformOnly, optionalTenant, publicScope, clubRequired };
