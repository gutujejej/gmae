/* ====================================================================== */
/*  core.js                                                                */
/*  Merged from: database.js + logger.js                                  */
/*  Shared low-level infra used by every other module. (Mechanical merge  */
/*  only — no logic changed.)                                             */
/* ====================================================================== */

const { Pool } = require('pg');

/* ======================================================================
 *  SECTION 1 — formerly database.js
 * ==================================================================== */

// Supabase Postgres connection. Use the "Connection Pooling" URI from your
// Supabase project settings (Session or Transaction mode) as DATABASE_URL -
// this works well from a long-running Railway service.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('supabase')
    ? { rejectUnauthorized: false }
    : undefined,
});

pool.on('error', (err) => {
  console.error('[database] Unexpected error on idle Postgres client', err);
});

// Second, OPTIONAL connection to the OLD Supabase database, used only
// during the migration transition: broadcast reads telegram_ids from
// both databases (see admin.js), and telegram-bot.js checks it to know
// whether a /start user is "old-DB only" and needs a fresh new-DB
// account created. Entirely inert if OLD_DATABASE_URL isn't set - every
// caller checks oldPool !== null first, so removing the env var once the
// transition is done cleanly turns this off with no code changes needed.
const oldPool = process.env.OLD_DATABASE_URL
  ? new Pool({
      connectionString: process.env.OLD_DATABASE_URL,
      ssl: process.env.OLD_DATABASE_URL.includes('supabase') ? { rejectUnauthorized: false } : undefined,
    })
  : null;

if (oldPool) {
  oldPool.on('error', (err) => {
    console.error('[database] Unexpected error on idle OLD Postgres client', err);
  });
}

function queryOldDb(text, params) {
  if (!oldPool) {
    return Promise.reject(new Error('OLD_DATABASE_URL is not configured'));
  }
  return oldPool.query(text, params);
}

async function connectDatabase() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set in environment variables');
  }
  // Simple connectivity check on boot.
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    console.log('[database] Connected to Postgres (Supabase)');
  } finally {
    client.release();
  }

  if (oldPool) {
    try {
      const oldClient = await oldPool.connect();
      await oldClient.query('SELECT 1');
      oldClient.release();
      console.log('[database] Connected to OLD Postgres (migration transition mode)');
    } catch (err) {
      console.error('[database] OLD_DATABASE_URL is set but could not connect - migration-transition features will fail:', err.message);
    }
  }
}

/**
 * Thin query helper. Use parameterized queries ($1, $2, ...) everywhere -
 * never string-interpolate user input into SQL.
 */
function query(text, params) {
  return pool.query(text, params);
}

/* ======================================================================
 *  SECTION 2 — formerly logger.js
 * ==================================================================== */

// Minimal structured logger. Swap for pino/winston in production if desired.
function timestamp() {
  return new Date().toISOString();
}

const logger = {
  info: (msg, meta = {}) => console.log(`[${timestamp()}] INFO: ${msg}`, meta),
  warn: (msg, meta = {}) => console.warn(`[${timestamp()}] WARN: ${msg}`, meta),
  error: (msg, meta = {}) => console.error(`[${timestamp()}] ERROR: ${msg}`, meta),
};

module.exports = { connectDatabase, query, queryOldDb, pool, oldPool, logger };
