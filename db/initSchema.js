/**
 * Applies db/schema.sql exactly once per database.
 *
 * schema.sql is generated from the original SQL Server database (see
 * Migration/generate-schema.js) and is fully idempotent, but running ~600 lines
 * of DDL on every serverless cold start would be wasteful, so a version marker
 * in `_scms_meta` short-circuits it.
 *
 * Bump SCHEMA_VERSION (and regenerate schema.sql) whenever the schema changes.
 */
const fs = require("fs");
const path = require("path");
const { getPool } = require("../config/db");

const SCHEMA_VERSION = "1";
const SCHEMA_FILE = path.join(__dirname, "schema.sql");

let ready = null;

const readDdl = () => {
  try {
    return fs.readFileSync(SCHEMA_FILE, "utf8");
  } catch (err) {
    throw new Error(
      `Could not read db/schema.sql (${err.message}). On Vercel this file must be ` +
        `bundled with the function - see "includeFiles" in vercel.json.`
    );
  }
};

const initSchema = async () => {
  const pool = getPool();

  await pool.query(`
    create table if not exists _scms_meta (
      key varchar(50) primary key,
      value varchar(255),
      updated_at timestamp not null default now()
    )
  `);

  const { rows } = await pool.query(
    "select value from _scms_meta where key = 'schema_version'"
  );

  if (rows.length && rows[0].value === SCHEMA_VERSION) return;

  console.log(`Applying database schema (version ${SCHEMA_VERSION})...`);
  await pool.query(readDdl());
  await pool.query(
    `insert into _scms_meta (key, value) values ('schema_version', $1)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [SCHEMA_VERSION]
  );
  console.log("Database schema is up to date.");
};

/** Memoised so concurrent cold-start requests share a single bootstrap. */
const ensureSchema = () => {
  if (!ready) {
    ready = initSchema().catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
};

module.exports = { initSchema, ensureSchema, SCHEMA_VERSION };
