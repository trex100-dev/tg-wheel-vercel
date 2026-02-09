const { sql, db } = require('@vercel/postgres');

let schemaReady = global.__schemaReady;

async function ensureSchema() {
  if (schemaReady) return schemaReady;

  schemaReady = (async () => {
    await sql`CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      total_spent INT NOT NULL DEFAULT 0,
      spins_count INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );`;

    await sql`CREATE TABLE IF NOT EXISTS user_progress (
      user_id TEXT PRIMARY KEY,
      trig_prize_3 BOOLEAN NOT NULL DEFAULT false,
      trig_prize_6 BOOLEAN NOT NULL DEFAULT false,
      trig_prize_4 BOOLEAN NOT NULL DEFAULT false,
      trig_prize_5 BOOLEAN NOT NULL DEFAULT false,
      guarantee_queue JSONB NOT NULL DEFAULT '[]'::jsonb
    );`;

    await sql`CREATE TABLE IF NOT EXISTS inventory (
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
    );`;

    await sql`CREATE INDEX IF NOT EXISTS idx_inventory_user_id ON inventory(user_id);`;

    await sql`CREATE TABLE IF NOT EXISTS payments (
      spin_key TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      paid BOOLEAN NOT NULL DEFAULT true,
      used BOOLEAN NOT NULL DEFAULT false,
      paid_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );`;

    return true;
  })();

  global.__schemaReady = schemaReady;
  return schemaReady;
}

async function ensureUser(userId) {
  await ensureSchema();
  await sql`
    INSERT INTO users(user_id) VALUES(${String(userId)})
    ON CONFLICT (user_id) DO NOTHING
  `;
  await sql`
    INSERT INTO user_progress(user_id) VALUES(${String(userId)})
    ON CONFLICT (user_id) DO NOTHING
  `;
}

/**
 * Транзакция через db.connect() — работает на Vercel.
 * fn получает tx — это tagged template: tx`SELECT ...`
 */
async function withTransaction(fn) {
  await ensureSchema();
  const client = await db.connect();

  try {
    await client.sql`BEGIN`;
    const result = await fn(client.sql);
    await client.sql`COMMIT`;
    return result;
  } catch (e) {
    try { await client.sql`ROLLBACK`; } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { sql, ensureSchema, ensureUser, withTransaction };