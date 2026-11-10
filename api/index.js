/**
 * Vercel serverless entry point.
 *
 * Vercel routes every incoming request here (see "rewrites" in vercel.json) and
 * invokes the exported handler. server.js only calls app.listen() when it is run
 * directly, so importing it here just hands back the configured Express app -
 * the platform owns the HTTP server.
 *
 * Locally nothing changes: `node server.js` still starts a normal listener.
 */
module.exports = require("../server.js");
