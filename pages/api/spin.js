const { sql, ensureSchema, ensureUser, withTransaction } = require('../../lib/db');
const { wheelSectors, selectPrizeId } = require('../../lib/game');

function uidGen() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  await ensureSchema();

  const { userId, spinKey } = req.body || {};
  if (!userId || !spinKey) return res.status(400).json({ error: 'missing params' });

  await ensureUser(userId);

  try {
    const result = await withTransaction(async (tx) => {
      // атомарно помечаем оплату использованной
      const pay = await tx(
        `UPDATE payments
         SET used=true
         WHERE spin_key=$1 AND user_id=$2 AND paid=true AND used=false
         RETURNING spin_key`,
        [String(spinKey), String(userId)]
      );

      if (pay.rows.length === 0) {
        return { err: 'not_ready' }; // фронт будет ретраить
      }

      const wonId = await selectPrizeId(tx, userId); // передаём tx
      const segmentIndex = wheelSectors.findIndex((p) => p.id === wonId);
      const prize = wheelSectors[segmentIndex >= 0 ? segmentIndex : 0];

      const uid = uidGen();
      const wonAt = new Date().toISOString();

      await tx(
        `INSERT INTO inventory(uid, user_id, prize_id, prize_name, won_at, status)
         VALUES($1, $2, $3, $4, $5, 'inventory')`,
        [uid, String(userId), prize.id, prize.name, wonAt]
      );

      return {
        prize: { id: prize.id, name: prize.name, uid, wonAt, status: 'inventory' },
        segmentIndex: segmentIndex >= 0 ? segmentIndex : 0
      };
    });

    if (result.err === 'not_ready') {
      return res.status(402).json({ error: 'not paid yet' });
    }

    return res.status(200).json(result);
  } catch (e) {
    console.error('spin error:', e.message);
    return res.status(500).json({ error: 'spin error' });
  }
}