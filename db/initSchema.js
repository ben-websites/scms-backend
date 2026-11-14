/**
 * Applies db/schema.sql and every pending file in db/migrations, exactly once
 * per database.
 *
 * schema.sql is the canonical shape and is fully idempotent, but running ~700
 * lines of DDL plus the migration on every serverless cold start would be
 * wasteful, so a version marker in `_scms_meta` short-circuits it.
 *
 * Bump SCHEMA_VERSION (and add a new db/migrations/NNN_*.sql) whenever the
 * schema changes.
 */
const fs = require("fs");
const path = require("path");
const { getPool, runWithPlatform } = require("../config/db");

const SCHEMA_VERSION = "3";
const SCHEMA_FILE = path.join(__dirname, "schema.sql");
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

let ready = null;

const readFile = (file, what) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(
      `Could not read ${what} (${err.message}). On Vercel these files must be ` +
        `bundled with the function - see "includeFiles" in vercel.json.`
    );
  }
};

const readDdl = () => readFile(SCHEMA_FILE, "db/schema.sql");

/** Migration files, oldest first (`001_`, `002_`, ...). */
const listMigrations = () => {
  try {
    return fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort();
  } catch {
    return [];
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

  // Migrations are individually idempotent, but they are still recorded so a
  // future schema bump only re-runs what is actually new.
  for (const file of listMigrations()) {
    const key = `migration:${file}`;
    const applied = await pool.query("select value from _scms_meta where key = $1", [key]);
    if (applied.rows.length) continue;

    console.log(`Applying migration ${file}...`);
    await pool.query(readFile(path.join(MIGRATIONS_DIR, file), `db/migrations/${file}`));
    await pool.query(
      `insert into _scms_meta (key, value) values ($1, $2)
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [key, new Date().toISOString()]
    );
  }

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
    // Platform mode: DDL, the migration and its backfills must not be hidden
    // behind the tenant policies they are themselves installing.
    ready = runWithPlatform(() => initSchema()).catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
};

module.exports = { initSchema, ensureSchema, SCHEMA_VERSION, listMigrations };
