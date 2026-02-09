// lib/db.js

// Позволяем использовать Neon/любой Postgres с переменной DATABASE_URL.
// @vercel/postgres по умолчанию ждёт POSTGRES_URL / POSTGRES_URL_NON_POOLING.
if (!process.env.POSTGRES_URL && process.env.DATABASE_URL) {
  process.env.POSTGRES_URL = process.env.DATABASE_URL;
}
if (!process.env.POSTGRES_URL_NON_POOLING && process.env.DATABASE_URL) {
  process.env.POSTGRES_URL_NON_POOLING = process.env.DATABASE_URL;
}

const { sql, db } = require('@vercel/postgres');

function assertDbEnv() {
  const missing = [];
  if (!process.env.POSTGRES_URL) missing.push('POSTGRES_URL');
  if (!process.env.POSTGRES_URL_NON_POOLING) missing.push('POSTGRES_URL_NON_POOLING');

  if (missing.length) {
    throw new Error(
      `DB env missing: ${missing.join(', ')}. ` +
        `Добавь их в Vercel → Project Settings → Environment Variables. ` +
        `Если у тебя Neon, можешь поставить POSTGRES_URL и POSTGRES_URL_NON_POOLING равными DATABASE_URL (с sslmode=require).`
    );
  }
}
assertDbEnv();

// кешируем промис инициализации схемы между вызовами (когда инстанс "тёплый")
const g = globalThis;
g.__schemaReadyPromise = g.__schemaReadyPromise || null;

async function ensureSchema() {
  if (g.__schemaReadyPromise) return g.__schemaReadyPromise;

  g.__schemaReadyPromise = (async () => {
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

    // (не обязательно, но полезно под частые проверки)
    await sql`CREATE INDEX IF NOT EXISTS idx_payments_user_paid_used
      ON payments(user_id, paid, used);`;

    return true;
  })();

  return g.__schemaReadyPromise;
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
 * Транзакция через db.connect().
 * ВАЖНО: для транзакций нужен POSTGRES_URL_NON_POOLING.
 * fn получает tx — это tagged template: tx`SELECT ...`
 */
async function withTransaction(fn) {
  await ensureSchema();

  const client = await db.connect(); // использует NON_POOLING

  try {
    await client.sql`BEGIN`;
    const result = await fn(client.sql);
    await client.sql`COMMIT`;
    return result;
  } catch (e) {
    try {
      await client.sql`ROLLBACK`;
    } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { sql, ensureSchema, ensureUser, withTransaction };