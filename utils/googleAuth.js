/**
 * Google Identity Services verification.
 *
 * The browser gets an ID token (JWT) from the Google button; the server must
 * never trust it blindly. Google's tokeninfo endpoint validates the signature
 * and expiry for us, so this works with zero extra npm dependencies. The one
 * thing it cannot check for us is that the token was minted for *our* client,
 * which is why `aud` is compared against GOOGLE_CLIENT_ID.
 */
const GOOGLE_TOKENINFO = "https://oauth2.googleapis.com/tokeninfo";

const isGoogleConfigured = () => Boolean(process.env.GOOGLE_CLIENT_ID);

const verifyGoogleCredential = async (credential) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;

  if (!clientId) {
    const err = new Error("Google sign-in is not configured.");
    err.code = "GOOGLE_NOT_CONFIGURED";
    throw err;
  }

  const response = await fetch(
    `${GOOGLE_TOKENINFO}?id_token=${encodeURIComponent(credential)}`
  );

  if (!response.ok) {
    const err = new Error("Google credential could not be verified.");
    err.code = "GOOGLE_TOKEN_INVALID";
    throw err;
  }

  const data = await response.json();

  if (data.aud !== clientId) {
    const err = new Error("Google credential was issued for a different application.");
    err.code = "GOOGLE_AUDIENCE_MISMATCH";
    throw err;
  }

  if (!data.sub || !data.email) {
    const err = new Error("Google profile is missing an email address.");
    err.code = "GOOGLE_PROFILE_INCOMPLETE";
    throw err;
  }

  return {
    sub: data.sub,
    email: String(data.email).trim().toLowerCase(),
    name: data.name || String(data.email).split("@")[0],
    picture: data.picture || null,
    emailVerified: data.email_verified === "true" || data.email_verified === true,
  };
};

/** Emails allowed to sign in to the platform (software owner) console. */
const platformAdminEmails = () =>
  (process.env.PLATFORM_ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

const isPlatformAdminEmail = (email) =>
  platformAdminEmails().includes(String(email || "").trim().toLowerCase());

module.exports = {
  isGoogleConfigured,
  verifyGoogleCredential,
  platformAdminEmails,
  isPlatformAdminEmail,
};
