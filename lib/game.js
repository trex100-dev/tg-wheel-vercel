const { sql, ensureUser } = require('./db');
const { isVip, VIP_WEIGHTS } = require('./env');

const wheelSectors = [
  { id: 'prize_1', name: 'Медведь' }, // 0
  { id: 'prize_2', name: 'Роза' },    // 1
  { id: 'prize_3', name: 'Леденец' }, // 2
  { id: 'prize_4', name: 'Сига' },    // 3
  { id: 'prize_5', name: 'Папаха' },  // 4
  { id: 'prize_6', name: 'Кнопка' }   // 5
];

function pickByWeights(weights) {
  let total = 0;
  for (const k in weights) total += Number(weights[k]) || 0;
  if (total <= 0) return 'prize_1';

  let r = Math.random() * total;
  for (const k in weights) {
    r -= Number(weights[k]) || 0;
    if (r <= 0) return k;
  }
  return 'prize_1';
}

async function addGuaranteesIfNeeded(tx, userId) {
  const thresholds = [
    { prizeId: 'prize_5', amount: 17000, col: 'trig_prize_5' },
    { prizeId: 'prize_4', amount: 4500,  col: 'trig_prize_4' },
    { prizeId: 'prize_6', amount: 1000,  col: 'trig_prize_6' },
    { prizeId: 'prize_3', amount: 800,   col: 'trig_prize_3' }
  ];

  const u = await tx`SELECT total_spent FROM users WHERE user_id=${String(userId)} FOR UPDATE`;
  const p = await tx`SELECT * FROM user_progress WHERE user_id=${String(userId)} FOR UPDATE`;
  if (!u.rows[0] || !p.rows[0]) return;

  const spent = u.rows[0].total_spent;
  let prog = p.rows[0];
  let queue = prog.guarantee_queue || [];

  for (const t of thresholds) {
    if (prog[t.col] === false && spent >= t.amount) {
      queue = [...queue, t.prizeId];
      prog[t.col] = true;
    }
  }

  await tx`
    UPDATE user_progress
    SET trig_prize_3=${prog.trig_prize_3},
        trig_prize_6=${prog.trig_prize_6},
        trig_prize_4=${prog.trig_prize_4},
        trig_prize_5=${prog.trig_prize_5},
        guarantee_queue=${JSON.stringify(queue)}::jsonb
    WHERE user_id=${String(userId)}
  `;
}

async function selectPrizeId(tx, userId) {
  await ensureUser(userId);

  if (isVip(userId)) {
    // VIP: нет гарантов, нет порогов
    return pickByWeights(VIP_WEIGHTS);
  }

  const u = await tx`SELECT total_spent FROM users WHERE user_id=${String(userId)} FOR UPDATE`;
  const p = await tx`SELECT guarantee_queue FROM user_progress WHERE user_id=${String(userId)} FOR UPDATE`;

  const spent = u.rows[0]?.total_spent ?? 0;
  const queue = p.rows[0]?.guarantee_queue ?? [];

  // гарант
  if (queue.length > 0) {
    const g = queue[0];
    const newQueue = queue.slice(1);
    await tx`
      UPDATE user_progress
      SET guarantee_queue=${JSON.stringify(newQueue)}::jsonb
      WHERE user_id=${String(userId)}
    `;
    return g;
  }

  // обычные шансы + пороги
  const pRose = 15;
  const pCandy = spent >= 800 ? 4 : 0;
  const pButton = spent >= 1000 ? 2 : 0;
  const pSiga = spent >= 4500 ? 1 : 0;
  const pPapakha = 0;

  let pBear = 100 - (pRose + pCandy + pButton + pSiga + pPapakha);
  if (pBear < 0) pBear = 0;

  const weights = {
    prize_1: pBear,
    prize_2: pRose,
    prize_3: pCandy,
    prize_6: pButton,
    prize_4: pSiga,
    prize_5: pPapakha
  };

  return pickByWeights(weights);
}

module.exports = { wheelSectors, selectPrizeId, addGuaranteesIfNeeded };