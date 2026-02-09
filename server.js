require('dotenv').config();
const express = require('express');
const https = require('https');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = 3000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const SPIN_PRICE = parseInt(process.env.SPIN_PRICE, 10) || 1;
const ADMIN_SECRET_RAW = process.env.ADMIN_SECRET || '';

if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
  console.error('Заполни BOT_TOKEN и ADMIN_CHAT_ID в .env');
  process.exit(1);
}

app.use(express.static('public'));
app.use(express.json());

// ===================== ADMIN_SECRET parse (VIP inside) =====================
function parseAdminSecret(raw) {
  // Форматы:
  // 1) "SECRET=xxx;VIP=1,2,3"
  // 2) "VIP=1,2,3"
  // 3) "xxx" (старый формат — только секрет)
  let adminSecret = raw || '';
  let vipIds = [];

  const vipMatch = (raw || '').match(/VIP=([^;]+)/i);
  if (vipMatch && vipMatch[1]) {
    vipIds = vipMatch[1]
      .split(/[, ]+/)
      .map(s => s.trim())
      .filter(Boolean);
  }

  const secretMatch = (raw || '').match(/SECRET=([^;]+)/i);
  if (secretMatch && secretMatch[1]) {
    adminSecret = secretMatch[1].trim();
  } else {
    // если строка содержит ; и начинается не с VIP=, берём часть до ;
    if ((raw || '').includes(';')) {
      const first = raw.split(';')[0].trim();
      adminSecret = first.startsWith('VIP=') ? '' : first;
    }
    // если это чисто VIP=..., админ секрета нет
    if ((raw || '').trim().startsWith('VIP=')) adminSecret = '';
  }

  return { adminSecret, vipIds };
}

const parsed = parseAdminSecret(ADMIN_SECRET_RAW);
const ADMIN_SECRET = parsed.adminSecret;   // для /api/admin/*
const VIP_IDS = new Set(parsed.vipIds);    // VIP userIds

function isVip(userId) {
  return VIP_IDS.has(String(userId));
}

// VIP веса: редкие предметы чаще медведя
// Можно менять как хочешь (это именно "подкрутка для VIP")
const VIP_WEIGHTS = {
  // Медведь — специально низко
  prize_1: 8,   // Медведь
  prize_2: 7,   // Роза
  prize_3: 28,  // Леденец
  prize_4: 25,  // Сига
  prize_5: 5,   // Папаха (у VIP может падать, если не хочешь — поставь 0)
  prize_6: 27   // Кнопка
};

// ===================== DB =====================
const DB_FILE = path.join(__dirname, 'data.sqlite');
const db = new sqlite3.Database(DB_FILE);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, function (err, row) {
      if (err) reject(err);
      else resolve(row);
    });
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, function (err, rows) {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch (e) { return fallback; }
}

async function initDb() {
  await run(`PRAGMA journal_mode = WAL;`);

  await run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      total_spent INTEGER NOT NULL DEFAULT 0,
      spins_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS user_progress (
      user_id TEXT PRIMARY KEY,
      trig_prize_3 INTEGER NOT NULL DEFAULT 0,
      trig_prize_6 INTEGER NOT NULL DEFAULT 0,
      trig_prize_4 INTEGER NOT NULL DEFAULT 0,
      trig_prize_5 INTEGER NOT NULL DEFAULT 0,
      guarantee_queue TEXT NOT NULL DEFAULT '[]'
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS inventory (
      uid TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      prize_id TEXT NOT NULL,
      prize_name TEXT NOT NULL,
      won_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'inventory',
      withdraw_username TEXT DEFAULT '',
      withdrawn_at TEXT DEFAULT '',
      completed_at TEXT DEFAULT '',
      rejected_at TEXT DEFAULT ''
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS payments (
      spin_key TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      paid INTEGER NOT NULL DEFAULT 0,
      used INTEGER NOT NULL DEFAULT 0,
      paid_at TEXT NOT NULL
    );
  `);

  // overrides (по желанию, для обычных — можно оставить)
  await run(`
    CREATE TABLE IF NOT EXISTS user_overrides (
      user_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      multipliers_json TEXT NOT NULL DEFAULT '{}'
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS bot_state (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
  `);

  const existing = await get(`SELECT v FROM bot_state WHERE k='polling_offset'`);
  if (!existing) {
    await run(`INSERT INTO bot_state(k, v) VALUES('polling_offset', '0')`);
  }
}

async function ensureUser(userId) {
  const now = new Date().toISOString();
  await run(
    `INSERT OR IGNORE INTO users(user_id, total_spent, spins_count, created_at)
     VALUES(?, 0, 0, ?)`,
    [userId, now]
  );
  await run(
    `INSERT OR IGNORE INTO user_progress(user_id, trig_prize_3, trig_prize_6, trig_prize_4, trig_prize_5, guarantee_queue)
     VALUES(?, 0, 0, 0, 0, '[]')`,
    [userId]
  );
}

async function addGuaranteesIfNeeded(userId) {
  // обычные пользователи получают гарант
  const thresholds = [
    { prizeId: 'prize_5', amount: 17000, trigCol: 'trig_prize_5' }, // Папаха
    { prizeId: 'prize_4', amount: 4500,  trigCol: 'trig_prize_4' }, // Сига
    { prizeId: 'prize_6', amount: 1000,  trigCol: 'trig_prize_6' }, // Кнопка
    { prizeId: 'prize_3', amount: 800,   trigCol: 'trig_prize_3' }  // Леденец
  ];

  const user = await get(`SELECT total_spent FROM users WHERE user_id=?`, [userId]);
  const prog = await get(`SELECT * FROM user_progress WHERE user_id=?`, [userId]);
  if (!user || !prog) return;

  const spent = user.total_spent;
  let queue = safeJsonParse(prog.guarantee_queue, []);

  for (const t of thresholds) {
    if (prog[t.trigCol] === 0 && spent >= t.amount) {
      queue.push(t.prizeId);
      await run(`UPDATE user_progress SET ${t.trigCol} = 1 WHERE user_id=?`, [userId]);
    }
  }

  await run(`UPDATE user_progress SET guarantee_queue=? WHERE user_id=?`, [JSON.stringify(queue), userId]);
}

// ===================== Overrides (optional) =====================
async function getUserOverride(userId) {
  const row = await get(
    `SELECT enabled, multipliers_json FROM user_overrides WHERE user_id=?`,
    [userId]
  );
  if (!row) return { enabled: false, unlockAll: false, multipliers: {}, forceWeights: null };

  const cfg = safeJsonParse(row.multipliers_json, {});
  const multipliers = (cfg.multipliers && typeof cfg.multipliers === 'object') ? cfg.multipliers : cfg;

  return {
    enabled: row.enabled === 1,
    unlockAll: !!cfg.unlockAll,
    multipliers: multipliers || {},
    forceWeights: (cfg.forceWeights && typeof cfg.forceWeights === 'object') ? cfg.forceWeights : null
  };
}

// ===================== Telegram API =====================
function telegramRequest(method, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: '/bot' + BOT_TOKEN + '/' + method,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.ok) resolve(parsed);
          else reject(new Error(parsed.description || 'Telegram API error'));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ===================== Polling =====================
let pollingOffset = 0;

async function loadPollingOffset() {
  const row = await get(`SELECT v FROM bot_state WHERE k='polling_offset'`);
  pollingOffset = row ? (parseInt(row.v, 10) || 0) : 0;
}

async function savePollingOffset(value) {
  await run(`UPDATE bot_state SET v=? WHERE k='polling_offset'`, [String(value)]);
}

async function poll() {
  try {
    const resp = await telegramRequest('getUpdates', {
      offset: pollingOffset,
      timeout: 5,
      allowed_updates: ['callback_query', 'pre_checkout_query', 'message']
    });

    const updates = resp.result || [];
    for (const upd of updates) {
      pollingOffset = upd.update_id + 1;
      await savePollingOffset(pollingOffset);

      if (upd.pre_checkout_query) await handlePreCheckout(upd.pre_checkout_query);
      if (upd.message && upd.message.successful_payment) await handleSuccessfulPayment(upd.message);
      if (upd.callback_query) await handleCallback(upd.callback_query);
    }

    setTimeout(poll, 300);
  } catch (e) {
    console.error('Polling error:', e.message);
    setTimeout(poll, 3000);
  }
}

async function handlePreCheckout(query) {
  try {
    await telegramRequest('answerPreCheckoutQuery', {
      pre_checkout_query_id: query.id,
      ok: true
    });
  } catch (e) {
    console.error('answerPreCheckoutQuery error:', e.message);
  }
}

async function handleSuccessfulPayment(message) {
  const payment = message.successful_payment;
  const payload = payment.invoice_payload; // spin:userId:timestamp
  const parts = payload.split(':');

  if (parts[0] !== 'spin' || !parts[1]) return;
  const userId = parts[1];

  await ensureUser(userId);

  // защита от повторного учёта оплаты после рестарта
  const ins = await run(
    `INSERT OR IGNORE INTO payments(spin_key, user_id, paid, used, paid_at)
     VALUES(?, ?, 1, 0, ?)`,
    [payload, userId, new Date().toISOString()]
  );
  if (ins.changes === 0) return;

  await run(
    `UPDATE users SET total_spent = total_spent + ?, spins_count = spins_count + 1 WHERE user_id=?`,
    [SPIN_PRICE, userId]
  );

  if (isVip(userId)) {
    // VIP: гарантов нет — очищаем очередь гарантов на всякий случай
    await run(`UPDATE user_progress SET guarantee_queue='[]' WHERE user_id=?`, [userId]);
  } else {
    await addGuaranteesIfNeeded(userId);
  }
}

// ===================== Withdraw callbacks =====================
async function handleCallback(cb) {
  const data = cb.data || '';
  const parts = data.split(':');
  const action = parts[0];
  const cbUserId = parts[1];
  const cbUid = parts[2];

  if (!cbUserId || !cbUid) return;
  if (action !== 'withdraw_done' && action !== 'withdraw_reject') return;

  const item = await get(`SELECT * FROM inventory WHERE user_id=? AND uid=?`, [cbUserId, cbUid]);
  if (!item) return answerCb(cb.id, 'Приз не найден');
  if (item.status !== 'pending') return answerCb(cb.id, 'Уже обработано');

  if (action === 'withdraw_done') {
    await run(`UPDATE inventory SET status='completed', completed_at=? WHERE uid=?`, [new Date().toISOString(), cbUid]);
    await telegramRequest('editMessageText', {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      parse_mode: 'HTML',
      text:
        '📤 <b>Заявка</b>\n\n' +
        '👤 @' + (item.withdraw_username || '') + '\n' +
        '🆔 <code>' + cbUserId + '</code>\n\n' +
        '🎁 <b>' + item.prize_name + '</b>\n\n' +
        '✅ <b>ВЫВЕДЕНО</b>\n' +
        '🔑 <code>' + item.uid + '</code>'
    }).catch(()=>{});
    return answerCb(cb.id, '✅ Выведено');
  } else {
    await run(`UPDATE inventory SET status='rejected', rejected_at=? WHERE uid=?`, [new Date().toISOString(), cbUid]);
    await telegramRequest('editMessageText', {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      parse_mode: 'HTML',
      text:
        '📤 <b>Заявка</b>\n\n' +
        '👤 @' + (item.withdraw_username || '') + '\n' +
        '🆔 <code>' + cbUserId + '</code>\n\n' +
        '🎁 <b>' + item.prize_name + '</b>\n\n' +
        '❌ <b>ОТКАЗАНО</b>\n' +
        '🔑 <code>' + item.uid + '</code>'
    }).catch(()=>{});
    return answerCb(cb.id, '❌ Отказано');
  }
}

async function answerCb(callbackQueryId, text) {
  try {
    await telegramRequest('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
      show_alert: false
    });
  } catch (e) {}
}

// ===================== Prize logic =====================
// порядок секторов = порядок PRIZES на фронте
const wheelSectors = [
  { id: 'prize_1', name: 'Медведь' }, // 0
  { id: 'prize_2', name: 'Роза' },    // 1
  { id: 'prize_3', name: 'Леденец' }, // 2
  { id: 'prize_4', name: 'Сига' },    // 3
  { id: 'prize_5', name: 'Папаха' },  // 4
  { id: 'prize_6', name: 'Кнопка' }   // 5
];

function pickByWeights(weightsMap) {
  let total = 0;
  for (const k in weightsMap) total += (Number(weightsMap[k]) || 0);
  if (total <= 0) return 'prize_1';

  let r = Math.random() * total;
  for (const k in weightsMap) {
    r -= (Number(weightsMap[k]) || 0);
    if (r <= 0) return k;
  }
  return 'prize_1';
}

async function selectPrizeIdForUser(userId) {
  await ensureUser(userId);

  // VIP: нет гарантов, нет порогов, редкие намного чаще
  if (isVip(userId)) {
    return pickByWeights(VIP_WEIGHTS);
  }

  // Обычные: гарант + пороги + (по желанию) overrides
  const user = await get(`SELECT total_spent FROM users WHERE user_id=?`, [userId]);
  const prog = await get(`SELECT guarantee_queue FROM user_progress WHERE user_id=?`, [userId]);
  const spent = user ? user.total_spent : 0;

  // гарант
  let queue = safeJsonParse(prog ? prog.guarantee_queue : '[]', []);
  if (queue.length > 0) {
    const g = queue.shift();
    await run(`UPDATE user_progress SET guarantee_queue=? WHERE user_id=?`, [JSON.stringify(queue), userId]);
    return g;
  }

  // базовые шансы + пороги
  let pRose = 15;
  let pCandy = spent >= 800 ? 4 : 0;
  let pButton = spent >= 1000 ? 2 : 0;
  let pSiga = spent >= 4500 ? 1 : 0;
  let pPapakha = 0;

  let pBear = 100 - (pRose + pCandy + pButton + pSiga + pPapakha);
  if (pBear < 0) pBear = 0;

  let weights = {
    prize_1: pBear,
    prize_2: pRose,
    prize_3: pCandy,
    prize_6: pButton,
    prize_4: pSiga,
    prize_5: pPapakha
  };

  // overrides (если используешь)
  const ov = await getUserOverride(userId);
  if (ov.enabled) {
    // unlockAll: снимает блокировки порогов
    if (ov.unlockAll) {
      weights.prize_3 = 4;
      weights.prize_6 = 2;
      weights.prize_4 = 1;
      // папаха по умолчанию 0
      let sumOther = weights.prize_2 + weights.prize_3 + weights.prize_6 + weights.prize_4 + weights.prize_5;
      weights.prize_1 = Math.max(0, 100 - sumOther);
    }

    // forceWeights: полный контроль
    if (ov.forceWeights) {
      weights = {
        prize_1: Number(ov.forceWeights.prize_1 || 0),
        prize_2: Number(ov.forceWeights.prize_2 || 0),
        prize_3: Number(ov.forceWeights.prize_3 || 0),
        prize_4: Number(ov.forceWeights.prize_4 || 0),
        prize_5: Number(ov.forceWeights.prize_5 || 0),
        prize_6: Number(ov.forceWeights.prize_6 || 0)
      };
    } else if (ov.multipliers) {
      for (const pid in weights) {
        const m = ov.multipliers[pid];
        if (typeof m === 'number' && isFinite(m) && m > 0) {
          weights[pid] = weights[pid] * m;
        }
      }
    }
  }

  return pickByWeights(weights);
}

// ===================== API =====================
app.get('/api/config', (req, res) => {
  res.json({ spinPrice: SPIN_PRICE });
});

app.post('/api/create-invoice', async (req, res) => {
  try {
    const userId = req.body.userId;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    await ensureUser(userId);

    const payload = 'spin:' + userId + ':' + Date.now();

    const tgResp = await telegramRequest('createInvoiceLink', {
      title: '🎰 Крутка барабана',
      description: 'Один спин барабана удачи',
      payload,
      currency: 'XTR',
      prices: [{ label: 'Крутка', amount: SPIN_PRICE }]
    });

    res.json({ invoiceUrl: tgResp.result, spinKey: payload });
  } catch (e) {
    console.error('create-invoice error:', e.message);
    res.status(500).json({ error: 'invoice error' });
  }
});

app.post('/api/spin', async (req, res) => {
  try {
    const userId = req.body.userId;
    const spinKey = req.body.spinKey;
    if (!userId || !spinKey) return res.status(400).json({ error: 'missing params' });

    await ensureUser(userId);

    const pay = await get(`SELECT * FROM payments WHERE spin_key=?`, [spinKey]);
    if (!pay || pay.paid !== 1) return res.status(402).json({ error: 'not paid' });
    if (pay.used === 1) return res.status(400).json({ error: 'used' });
    if (pay.user_id !== userId) return res.status(403).json({ error: 'wrong user' });

    await run(`UPDATE payments SET used=1 WHERE spin_key=?`, [spinKey]);

    const wonId = await selectPrizeIdForUser(userId);
    const segmentIndex = wheelSectors.findIndex(p => p.id === wonId);
    const wonPrize = wheelSectors[segmentIndex >= 0 ? segmentIndex : 0];

    const uid = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const wonAt = new Date().toISOString();

    await run(
      `INSERT INTO inventory(uid, user_id, prize_id, prize_name, won_at, status)
       VALUES(?, ?, ?, ?, ?, 'inventory')`,
      [uid, userId, wonPrize.id, wonPrize.name, wonAt]
    );

    res.json({
      prize: { id: wonPrize.id, name: wonPrize.name, uid, wonAt, status: 'inventory' },
      segmentIndex: segmentIndex >= 0 ? segmentIndex : 0
    });
  } catch (e) {
    console.error('spin error:', e.message);
    res.status(500).json({ error: 'spin error' });
  }
});

app.get('/api/inventory/:userId', async (req, res) => {
  const userId = req.params.userId;
  await ensureUser(userId);

  const rows = await all(
    `SELECT uid,
            prize_id as id,
            prize_name as name,
            won_at as wonAt,
            status,
            withdraw_username as withdrawUsername
     FROM inventory
     WHERE user_id=?
     ORDER BY won_at ASC`,
    [userId]
  );

  res.json({ inventory: rows });
});

app.post('/api/withdraw', async (req, res) => {
  try {
    const userId = req.body.userId;
    const itemUid = req.body.itemUid;
    let username = req.body.username;

    if (!username || !username.trim()) return res.status(400).json({ error: 'Username обязателен' });
    username = username.trim().replace(/^@/, '');

    await ensureUser(userId);

    const item = await get(`SELECT * FROM inventory WHERE user_id=? AND uid=?`, [userId, itemUid]);
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (item.status !== 'inventory') return res.status(400).json({ error: 'Уже обработано' });

    await run(
      `UPDATE inventory SET status='pending', withdraw_username=?, withdrawn_at=? WHERE uid=?`,
      [username, new Date().toISOString(), itemUid]
    );

    await telegramRequest('sendMessage', {
      chat_id: ADMIN_CHAT_ID,
      parse_mode: 'HTML',
      text:
        '📤 <b>Заявка на вывод</b>\n\n' +
        '👤 @' + username + '\n' +
        '🆔 <code>' + userId + '</code>\n\n' +
        '🎁 <b>' + item.prize_name + '</b>\n' +
        '🔑 <code>' + item.uid + '</code>\n\n' +
        '⏳ <b>Ожидание</b>',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Выведено', callback_data: 'withdraw_done:' + userId + ':' + item.uid },
          { text: '❌ Отказано', callback_data: 'withdraw_reject:' + userId + ':' + item.uid }
        ]]
      }
    });

    res.json({ success: true });
  } catch (e) {
    console.error('withdraw error:', e.message);
    res.json({ success: true });
  }
});

// (optional) admin override endpoint (работает только если ADMIN_SECRET задан как SECRET=...)
app.post('/api/admin/set-override', async (req, res) => {
  try {
    const secret = req.body.secret || '';
    if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const userId = String(req.body.userId || '');
    const enabled = req.body.enabled === false ? 0 : 1;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    await ensureUser(userId);

    const cfg = {
      unlockAll: !!req.body.unlockAll,
      multipliers: req.body.multipliers || {},
      forceWeights: req.body.forceWeights || null
    };

    await run(
      `INSERT INTO user_overrides(user_id, enabled, multipliers_json)
       VALUES(?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled, multipliers_json=excluded.multipliers_json`,
      [userId, enabled, JSON.stringify(cfg)]
    );

    res.json({ success: true, cfg });
  } catch (e) {
    console.error('set-override error:', e.message);
    res.status(500).json({ error: 'error' });
  }
});

// ===================== Start =====================
(async () => {
  await initDb();
  await loadPollingOffset();

  console.log('DB:', DB_FILE);
  console.log('Server: http://localhost:' + PORT);
  console.log('SPIN_PRICE:', SPIN_PRICE, 'Stars');
  console.log('VIP IDs:', Array.from(VIP_IDS).join(', ') || '(none)');
  console.log('Polling offset:', pollingOffset);

  try { await telegramRequest('deleteWebhook', {}); } catch (e) {}

  app.listen(PORT, () => {
    console.log('Polling started...');
    poll();
  });
})();