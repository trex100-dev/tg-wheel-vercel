const { sql: vercelSql, db } = require('@vercel/postgres');

// Используем `DATABASE_URL` от Neon, если `POSTGRES_URL` не задан
// Это более универсальный подход для Vercel Postgres / Neon
const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;

if (!connectionString) {
  console.error('ERROR: Missing POSTGRES_URL or DATABASE_URL environment variable.');
  process.exit(1);
}

// Создаем pool один раз
const { Pool } = require('pg'); // Напрямую pg, чтобы управлять транзакциями
const pool = new Pool({
  connectionString: connectionString,
  // Дополнительные параметры для Neon, если DATABASE_URL pooled
  // idle_timeout: 0, // Не закрывать соединение быстро
  // max_lifetime: 0, // Не убивать соединение
});

let schemaReady = global.__schemaReady;

async function ensureSchema() {
  if (schemaReady) return schemaReady;

  schemaReady = (async () => {
    // Используем raw pg.query для создания таблиц, чтобы не зависеть от vercelSql syntax
    await pool.query(`CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      total_spent INT NOT NULL DEFAULT 0,
      spins_count INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );`);

    await pool.query(`CREATE TABLE IF NOT EXISTS user_progress (
      user_id TEXT PRIMARY KEY,
      trig_prize_3 BOOLEAN NOT NULL DEFAULT false,
      trig_prize_6 BOOLEAN NOT NULL DEFAULT false,
      trig_prize_4 BOOLEAN NOT NULL DEFAULT false,
      trig_prize_5 BOOLEAN NOT NULL DEFAULT false,
      guarantee_queue JSONB NOT NULL DEFAULT '[]'::jsonb
    );`);

    await pool.query(`CREATE TABLE IF NOT EXISTS inventory (
      uid TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      prize_id TEXT NOT NULL,
      prize_name TEXT NOT NULL,
      won_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL DEFAULT 'inventory',
      withdraw_username TEXT NOT NULL DEFAULT '',
      withdrawn_at TIMESTAMPTZ NULL,
      completed_at TIMESTAMPTZ NULL,
      rejected_at TIMESTAMPTZ NULL
    );`);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_inventory_user_id ON inventory(user_id);`);

    await pool.query(`CREATE TABLE IF NOT EXISTS payments (
      spin_key TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      paid BOOLEAN NOT NULL DEFAULT true,
      used BOOLEAN NOT NULL DEFAULT false,
      paid_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );`);

    await pool.query(`
    CREATE TABLE IF NOT EXISTS user_overrides (
      user_id TEXT PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT true,
      multipliers_json JSONB NOT NULL DEFAULT '{}'::jsonb
    );`);

    await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_state (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );`);

    const existing = await pool.query(`SELECT v FROM bot_state WHERE k='polling_offset'`);
    if (existing.rows.length === 0) {
      await pool.query(`INSERT INTO bot_state(k, v) VALUES('polling_offset', '0')`);
    }

    return true;
  })();

  global.__schemaReady = schemaReady;
  return schemaReady;
}

async function ensureUser(userId) {
  await ensureSchema();
  await pool.query(
    `INSERT INTO users(user_id) VALUES($1) ON CONFLICT (user_id) DO NOTHING`,
    [String(userId)]
  );
  await pool.query(
    `INSERT INTO user_progress(user_id) VALUES($1) ON CONFLICT (user_id) DO NOTHING`,
    [String(userId)]
  );
}

/**
 * Executes queries using the pool directly for better compatibility
 * with various connection strings (pooled/unpooled) for simple queries.
 */
async function query(text, params) {
    await ensureSchema();
    return pool.query(text, params);
}

/**
 * Runs a function within a transaction.
 * @param {function(function(string, any[]): Promise<any>): Promise<any>} fn - Function receiving tx client.
 */
async function withTransaction(fn) {
  await ensureSchema();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn((text, params) => client.query(text, params));
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Tagged template literal for simple queries (like vercelSql, but uses our pool)
// This simplifies direct queries without transactions
const taggedSql = async (strings, ...values) => {
    await ensureSchema();
    // Build query with $1, $2, etc.
    let text = strings[0];
    for (let i = 0; i < values.length; i++) {
        text += `$${i + 1}${strings[i + 1]}`;
    }
    return pool.query(text, values);
};

module.exports = { sql: taggedSql, query, ensureSchema, ensureUser, withTransaction };