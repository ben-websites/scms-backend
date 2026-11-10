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
const { Pool, types } = require("pg");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

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

class Request {
  constructor() {
    this.inputs = {};
  }

  /** Supports both `.input(name, type, value)` and `.input(name, value)`. */
  input(name, typeOrValue, value) {
    this.inputs[name] = arguments.length >= 3 ? value : typeOrValue;
    if (this.inputs[name] === undefined) this.inputs[name] = null;
    return this;
  }

  async query(commandText) {
    const pool = getPool();
    const translated = translateTsql(String(commandText));
    const statements = splitStatements(translated);

    let rows = [];
    let rowCount = -1;

    for (const statement of statements) {
      const { text, values } = bindNamedParams(statement, this.inputs);
      const result = await pool.query(text, values);
      rows = result.rows || [];
      rowCount = typeof result.rowCount === "number" ? result.rowCount : rowCount;
    }

    return {
      recordset: rows.map(restoreKeyCasing),
      rowsAffected: rowCount,
      output: {},
    };
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
    return getRawPool().query(text, values);
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

module.exports = { sql, connectDB, getPool, translateTsql, restoreKeyCasing };
