/**
 * PostgreSQL (Neon) database layer.
 *
 * The original codebase was written against SQL Server's `mssql` driver:
 *
 *     pool.request().input("UserID", sql.Int, id).query("SELECT TOP 1 ... @UserID")
 *
 * Rather than rewriting ~340 call sites (and risking silent regressions in a
 * live club system), this module keeps that exact API on top of `pg`:
 *
 *   - `.input(name, type, value)` records a named parameter      -> $1, $2, ...
 *   - `.query(tsql)` translates the handful of T-SQL constructs the code uses
 *     (TOP, OUTPUT INSERTED, SYSDATETIME, ISNULL, NVARCHAR, LIKE) and runs it
 *   - the result is returned as `{ recordset, rowsAffected }` like mssql did
 *   - result keys are mapped back to their original CamelCase spelling so the
 *     REST payloads stay byte-for-byte compatible with the frontend
 *
 * Everything that cannot be translated safely (DATEADD / DATEFROMPARTS) was
 * rewritten by hand in the controllers instead.
 */
const fs = require("fs");
const path = require("path");
const { AsyncLocalStorage } = require("node:async_hooks");
const { Pool, types } = require("pg");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

/* ============================================================ tenant context
 * Multi-tenancy is enforced by PostgreSQL row level security, which reads two
 * session settings: app.club_id and app.platform_mode. Those are transaction
 * scoped (set_config(..., true)), so every query batch issued while a tenant
 * context is active runs on one dedicated client inside its own transaction.
 *
 * A batch executed with NO context leaves both settings unset, which makes the
 * ClubID defaults null and every RLS policy false: nothing is visible. That is
 * deliberate - a missing tenant must never degrade into "see every club".
 *
 * Only two kinds of work run without a club: authentication lookups against
 * the shared tables (Users / Clubs / ClubUsers), and platform-owner requests,
 * which opt into platform_mode with runWithPlatform().
 */
const tenantStore = new AsyncLocalStorage();

/** Run `fn` with a club context: { clubId }. */
const runWithTenant = (context, fn) => tenantStore.run(context, fn);

/** Run `fn` with full cross-club visibility (platform owner, bootstrap, seeds). */
const runWithPlatform = (fn) => tenantStore.run({ platform: true }, fn);

const currentTenant = () => tenantStore.getStore() || null;

/* ========================================================== tenant db role
 * Neon hands BYPASSRLS to the database owner, and PostgreSQL skips every
 * policy - even a FORCEd one - for a role that carries it. The owner
 * connection therefore cannot be trusted with a club's query, so each club
 * scoped transaction switches into TENANT_DB_ROLE first: a NOLOGIN role with
 * plain DML grants and no BYPASSRLS, created by db/migrations/003.
 *
 * `set local role` is transaction scoped, so the connection is back to the
 * owner - and can still run the schema DDL on the next boot - as soon as the
 * batch commits.
 */
const TENANT_DB_ROLE = (() => {
  const role = process.env.TENANT_DB_ROLE || "scms_app";
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
    throw new Error(`TENANT_DB_ROLE must be a plain SQL identifier, received "${role}".`);
  }
  return role;
})();

const SET_CONTEXT_SQL =
  "select set_config('app.club_id', $1, true), set_config('app.platform_mode', $2, true)";

const contextValues = (ctx) => [
  ctx && ctx.clubId != null ? String(ctx.clubId) : "",
  ctx && ctx.platform ? "true" : "false",
];

/**
 * Publishes the request's tenant context to the connection. Call it right
 * after `begin`, before any statement that touches a club owned table.
 *
 * A club context drops to the restricted role; a platform context stays on
 * the owner, which is what lets the SaaS console and the bootstrap read
 * across clubs. Failing here is a hard error on purpose: silently continuing
 * as the owner would hand back the bypass we just removed.
 */
const applyTenantContext = async (client, ctx) => {
  if (ctx && ctx.clubId != null && !ctx.platform) {
    await client.query(`set local role ${TENANT_DB_ROLE}`);
  }
  if (ctx) await client.query(SET_CONTEXT_SQL, contextValues(ctx));
};

/* ============================================================== type parsers
 * SQL Server handed us plain JS numbers for COUNT(*), DECIMAL and BIGINT.
 * node-postgres returns BIGINT/DECIMAL as strings, so restore numbers to keep
 * every arithmetic/comparison site (`row.count === 0`, `Number(x)`, ...) valid.
 */
const toNumber = (v) => (v === null ? null : Number(v));
types.setTypeParser(20, toNumber); // int8  -> COUNT(*), BIGINT
types.setTypeParser(1700, toNumber); // numeric -> DECIMAL
types.setTypeParser(1701, toNumber); // numeric[] safeguard
types.setTypeParser(700, toNumber); // real

/* =============================================================== key casing */
const SCHEMA_FILE = path.resolve(__dirname, "../db/schema.sql");

function buildCaseMap() {
  const map = new Map();

  // 1. Every real column / table, parsed from the canonical schema file.
  try {
    const ddl = fs.readFileSync(SCHEMA_FILE, "utf8");
    const createRe = /create table if not exists\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi;
    let m;
    while ((m = createRe.exec(ddl))) map.set(m[1].toLowerCase(), m[1]);

    const colRe =
      /^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s+(?:integer|bigint|smallint|numeric|text|varchar|char|date|time|timestamp|timestamptz|uuid|bytea|real|double precision|xml)\b/gim;
    while ((m = colRe.exec(ddl))) map.set(m[1].toLowerCase(), m[1]);
  } catch (err) {
    console.warn("Could not read db/schema.sql for key casing:", err.message);
  }

  // 2. Computed aliases that are not real columns (e.g. ReceiptImageURL).
  try {
    for (const name of require("../db/aliases")) {
      const key = String(name).toLowerCase();
      if (!map.has(key)) map.set(key, name);
    }
  } catch {
    /* optional */
  }

  return map;
}

const CASE_MAP = buildCaseMap();

function restoreKeyCasing(row) {
  const out = {};
  for (const key of Object.keys(row)) {
    const canonical = CASE_MAP.get(key.toLowerCase());
    out[canonical || key] = row[key];
  }
  return out;
}

/* ================================================== T-SQL -> Postgres pieces */

/** Marks which characters sit inside a string literal / comment / quoted name. */
function buildCodeMask(text) {
  const mask = new Uint8Array(text.length).fill(1);
  let i = 0;

  const blank = (from, to) => {
    for (let k = from; k < to && k < text.length; k++) mask[k] = 0;
  };

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    // 'string literal' with '' escaping
    if (ch === "'") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "'") {
          if (text[j + 1] === "'") {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }

    // "quoted identifier"
    if (ch === '"') {
      const j = text.indexOf('"', i + 1);
      const end = j === -1 ? text.length : j + 1;
      blank(i, end);
      i = end;
      continue;
    }

    // -- line comment
    if (ch === "-" && next === "-") {
      const j = text.indexOf("\n", i);
      const end = j === -1 ? text.length : j;
      blank(i, end);
      i = end;
      continue;
    }

    // /* block comment */
    if (ch === "/" && next === "*") {
      const j = text.indexOf("*/", i + 2);
      const end = j === -1 ? text.length : j + 2;
      blank(i, end);
      i = end;
      continue;
    }

    i += 1;
  }

  return mask;
}

/**
 * Applies `replacer` only where the position is real code (not inside a string
 * literal or comment).
 *
 * The mask is rebuilt on every call because each pass changes the text length;
 * reusing an old mask would silently skip or corrupt characters.
 */
function replaceInCode(text, regex, replacer) {
  const mask = buildCodeMask(text);
  const apply =
    typeof replacer === "function"
      ? replacer
      : (match) => (typeof replacer === "string" ? match.replace(regex, replacer) : replacer);

  return text.replace(regex, (...args) => {
    const offset = args[args.length - 2];
    if (typeof offset !== "number" || mask[offset] !== 1) return args[0];
    return apply(...args.slice(0, args.length - 2));
  });
}

/**
 * `SELECT TOP n ...` -> `SELECT ... LIMIT n`, placed at the true end of that
 * SELECT (end of text, or just before the closing paren of a sub-query).
 */
function translateTop(text, mask) {
  const edits = [];
  const re = /\bSELECT\s+TOP\s+\(?\s*(\d+)\s*\)?/gi;
  let m;

  while ((m = re.exec(text))) {
    if (mask[m.index] !== 1) continue;

    const limit = m[1];
    const start = m.index;
    const afterTop = m.index + m[0].length;

    // Walk forward to the end of this SELECT statement.
    let depth = 0;
    let end = text.length;
    for (let i = afterTop; i < text.length; i++) {
      if (mask[i] !== 1) continue;
      const ch = text[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        if (depth === 0) {
          end = i;
          break;
        }
        depth -= 1;
      }
    }

    edits.push({ start, end: afterTop, text: "SELECT " });
    edits.push({ start: end, end, text: ` LIMIT ${limit}` });
  }

  if (!edits.length) return text;

  // Apply right-to-left so earlier offsets stay valid.
  edits.sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of edits) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

/** `OUTPUT INSERTED.a, INSERTED.b` (before VALUES) -> trailing `RETURNING a, b` */
function translateOutput(text, mask) {
  const re = /\bOUTPUT\s+([\s\S]*?)(?=\bVALUES\b|\bSELECT\b|\bDEFAULT\b|$)/i;
  const m = re.exec(text);
  if (!m || mask[m.index] !== 1) return text;

  const rawCols = m[1]
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => c.replace(/^INSERTED\./i, "").trim());

  const cols = rawCols.includes("*") ? "*" : rawCols.join(", ");
  if (!cols) return text;

  let body = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
  body = body.replace(/;\s*$/, "");
  return `${body} RETURNING ${cols}`;
}

const CAST_TYPE_FIXES = [
  [/\bAS\s+N?VARCHAR\s*\(\s*MAX\s*\)/gi, "AS TEXT"],
  [/\bAS\s+NVARCHAR\s*\(/gi, "AS VARCHAR("],
  [/\bAS\s+NCHAR\s*\(/gi, "AS CHAR("],
  [/\bAS\s+NTEXT\b/gi, "AS TEXT"],
  [/\bAS\s+DATETIME2?\b/gi, "AS TIMESTAMP"],
  [/\bAS\s+SMALLDATETIME\b/gi, "AS TIMESTAMP"],
  [/\bAS\s+BIT\b/gi, "AS INTEGER"],
  [/\bAS\s+UNIQUEIDENTIFIER\b/gi, "AS UUID"],
  [/\bAS\s+MONEY\b/gi, "AS NUMERIC(19,4)"],
];

function translateTsql(text) {
  if (!text) return "";

  let codeMask = buildCodeMask(text);
  let sql = text;

  // 1. INSERT ... OUTPUT INSERTED.x ... VALUES -> INSERT ... VALUES ... RETURNING x
  sql = translateOutput(sql, codeMask);

  // 2. SELECT TOP n -> LIMIT n
  codeMask = buildCodeMask(sql);
  sql = translateTop(sql, codeMask);

  // 3. scalar functions / helpers (code-only, case-insensitive)
  sql = replaceInCode(sql, /\bSYSDATETIMEOFFSET\s*\(\s*\)/gi, "now()");
  sql = replaceInCode(sql, /\bSYSDATETIME\s*\(\s*\)/gi, "now()");
  sql = replaceInCode(sql, /\bGETDATE\s*\(\s*\)/gi, "now()");
  sql = replaceInCode(sql, /\bGETUTCDATE\s*\(\s*\)/gi, "(now() at time zone 'utc')");
  sql = replaceInCode(sql, /\bISNULL\s*\(/gi, "COALESCE(");

  // SQL Server: YEAR(x) / MONTH(x) / DAY(x). Postgres spells these EXTRACT(...).
  sql = replaceInCode(sql, /\bYEAR\s*\(/gi, "EXTRACT(YEAR FROM ");
  sql = replaceInCode(sql, /\bMONTH\s*\(/gi, "EXTRACT(MONTH FROM ");
  sql = replaceInCode(sql, /\bDAY\s*\(/gi, "EXTRACT(DAY FROM ");

  // SQL Server bracket identifiers: [Year] -> "Year"
  sql = replaceInCode(sql, /\[([A-Za-z_][A-Za-z0-9_]*)\]/g, (_m, name) => `"${name}"`);

  // 4. CAST target types that do not exist in Postgres
  for (const [re, to] of CAST_TYPE_FIXES) {
    sql = replaceInCode(sql, re, to);
  }

  // 5. SQL Server defaults to a case-insensitive collation; Postgres LIKE is
  //    case-sensitive. ILIKE keeps the existing search behaviour.
  sql = replaceInCode(sql, /(?<![A-Za-z0-9_"])LIKE(?![A-Za-z0-9_"])/gi, "ILIKE");

  return sql;
}

/* ---------------------------------------------------------- named params */

/** Splits a translated script into individual statements (code-only `;`). */
function splitStatements(sql) {
  const mask = buildCodeMask(sql);
  const out = [];
  let start = 0;

  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === ";" && mask[i] === 1) {
      const piece = sql.slice(start, i).trim();
      if (piece) out.push(piece);
      start = i + 1;
    }
  }

  const tail = sql.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/** Replaces `@Name` with `$n` and returns the matching values array. */
function bindNamedParams(statement, inputs) {
  const mask = buildCodeMask(statement);
  const order = [];
  const values = [];

  const text = statement.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (match, name, offset) => {
    if (mask[offset] !== 1) return match;

    let idx = order.indexOf(name);
    if (idx === -1) {
      if (!Object.prototype.hasOwnProperty.call(inputs, name)) {
        throw new Error(`SQL parameter @${name} was never supplied via .input()`);
      }
      order.push(name);
      values.push(inputs[name]);
      idx = order.length - 1;
    }
    return `$${idx + 1}`;
  });

  return { text, values };
}

/* ================================================================= adapter */

const sql = (() => {
  const mk = (name) => {
    const fn = () => ({ __mssqlType: name });
    fn.__mssqlType = name;
    return fn;
  };

  return {
    MAX: "max",
    Int: mk("Int"),
    BigInt: mk("BigInt"),
    SmallInt: mk("SmallInt"),
    TinyInt: mk("TinyInt"),
    Bit: mk("Bit"),
    Decimal: mk("Decimal"),
    Numeric: mk("Numeric"),
    Float: mk("Float"),
    Real: mk("Real"),
    Money: mk("Money"),
    NVarChar: mk("NVarChar"),
    VarChar: mk("VarChar"),
    NChar: mk("NChar"),
    Char: mk("Char"),
    Text: mk("Text"),
    Date: mk("Date"),
    DateTime: mk("DateTime"),
    DateTime2: mk("DateTime2"),
    Time: mk("Time"),
    UniqueIdentifier: mk("UniqueIdentifier"),
    VarBinary: mk("VarBinary"),
  };
})();

/**
 * Adds the mssql-shaped `recordset` to a raw `pg` result.
 *
 * A pooled query used to return bare `pg` output, so call sites that read
 * `.recordset` (the legacy public feed in publicController) blew up with
 * "Cannot read properties of undefined (reading '0')". Keeping `rows` as well
 * means the raw-pg call sites are untouched.
 */
const withRecordset = (result) => {
  if (result && Array.isArray(result.rows)) {
    result.recordset = result.rows.map(restoreKeyCasing);
  }
  return result;
};

class Request {
  constructor(client = null) {
    this.inputs = {};
    // Set when the request belongs to withTransaction(): statements then run
    // on that transaction instead of acquiring one of their own.
    this.client = client;
  }

  /** Supports both `.input(name, type, value)` and `.input(name, value)`. */
  input(name, typeOrValue, value) {
    this.inputs[name] = arguments.length >= 3 ? value : typeOrValue;
    if (this.inputs[name] === undefined) this.inputs[name] = null;
    return this;
  }

  /** Executes every statement of the script through one executor. */
  async runStatements(executor, statements) {
    let rows = [];
    let rowCount = -1;

    for (const statement of statements) {
      const { text, values } = bindNamedParams(statement, this.inputs);
      const result = await executor.query(text, values);
      rows = result.rows || [];
      rowCount = typeof result.rowCount === "number" ? result.rowCount : rowCount;
    }

    return {
      recordset: rows.map(restoreKeyCasing),
      rowsAffected: rowCount,
      output: {},
    };
  }

  async query(commandText) {
    const translated = translateTsql(String(commandText));
    const statements = splitStatements(translated);

    // Already inside withTransaction(): reuse that connection/transaction.
    if (this.client) {
      return this.runStatements(
        { query: (text, values) => this.client.query(text, values) },
        statements
      );
    }

    const ctx = currentTenant();

    // No tenant context: plain pooled call. RLS-protected tables return
    // nothing, shared tables behave normally.
    if (!ctx) {
      return this.runStatements(getRawPool(), statements);
    }

    const client = await getRawPool().connect();
    try {
      await client.query("begin");
      await applyTenantContext(client, ctx);
      const result = await this.runStatements(
        { query: (text, values) => client.query(text, values) },
        statements
      );
      await client.query("commit");
      return result;
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        /* connection already gone */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** mssql compatibility no-ops */
  async batch(commandText) {
    return this.query(commandText);
  }
}

class PoolAdapter {
  request() {
    return new Request();
  }

  async query(text, values) {
    const ctx = currentTenant();

    // DDL and migrations run through here; honour the context when one is
    // active so a bootstrap/seed is not blocked by row level security.
    if (!ctx) return withRecordset(await getRawPool().query(text, values));

    const client = await getRawPool().connect();
    try {
      await client.query("begin");
      await applyTenantContext(client, ctx);
      const result = await client.query(text, values);
      await client.query("commit");
      return withRecordset(result);
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        /* connection already gone */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Graceful shutdown for one-off scripts (`pool.end()` as mssql had it). */
  async close() {
    if (pool) {
      const current = pool;
      pool = null;
      await current.end();
    }
  }

  get connected() {
    return true;
  }
}

/**
 * Runs `fn` inside a single database transaction.
 *
 * `fn` receives a transaction handle with mssql-compatible `request()` and a
 * raw `query()`. Anything that must be all-or-nothing (a club subscription
 * being approved, for example) goes through here instead of several
 * independent `getPool().request()` calls.
 */
async function withTransaction(fn) {
  const client = await getRawPool().connect();
  try {
    await client.query("begin");

    const ctx = currentTenant();
    await applyTenantContext(client, ctx);

    const tx = {
      request: () => new Request(client),
      query: (text, values) => client.query(text, values),
    };

    const result = await fn(tx);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      /* connection already gone */
    }
    throw error;
  } finally {
    client.release();
  }
}

/* --------------------------------------------------------------- pg pool */

let pool = null;
const adapter = new PoolAdapter();

function normaliseConnectionString(raw) {
  if (!raw) throw new Error("DATABASE_URL is not configured.");
  if (!raw.startsWith("postgres")) {
    throw new Error("DATABASE_URL must be a PostgreSQL connection string.");
  }

  const url = new URL(raw);
  // `channel_binding` is a libpq option that node-postgres does not understand.
  url.searchParams.delete("channel_binding");
  const wantsSsl = (url.searchParams.get("sslmode") || "").toLowerCase();
  url.searchParams.delete("sslmode");

  return {
    connectionString: url.toString(),
    // Neon requires TLS. Node trusts its public CA by default, so keep full
    // verification on. PGSSL_RELAXED=true is only for a private/proxy setup
    // whose certificate cannot be validated.
    ssl: needsSsl(wantsSsl) ? { rejectUnauthorized: process.env.PGSSL_RELAXED !== "true" } : undefined,
  };
}

function needsSsl(sslmode) {
  return sslmode === "require" || sslmode === "verify-ca" || sslmode === "verify-full" || sslmode === "";
}

function getRawPool() {
  if (pool) return pool;

  const { connectionString, ssl } = normaliseConnectionString(process.env.DATABASE_URL);

  pool = new Pool({
    connectionString,
    ssl,
    max: Number(process.env.PGPOOL_MAX || 3),
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 15000,
    allowExitOnIdle: true,
  });

  pool.on("error", (err) => {
    console.error("Unexpected Postgres pool error:", err.message);
  });

  return pool;
}

const connectDB = async () => {
  const client = await getRawPool().connect();
  try {
    const { rows } = await client.query(
      "select current_database() as db, current_setting('server_version') as version"
    );
    console.log(`Postgres (Neon) connected successfully! db=${rows[0].db} v${rows[0].version}`);
  } finally {
    client.release();
  }
  return adapter;
};

const getPool = () => adapter;

module.exports = {
  sql,
  connectDB,
  getPool,
  translateTsql,
  restoreKeyCasing,
  runWithTenant,
  runWithPlatform,
  currentTenant,
  withTransaction,
};
