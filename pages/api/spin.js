const { sql, ensureSchema, ensureUser } = require('../../lib/db');
const { wheelSectors, selectPrizeId } = require('../../lib/game');

function uidGen() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  await ensureSchema();

  const { userId, spinKey } = req.body || {};
  if (!userId || !spinKey) return res.status(400).json({ error: 'missing params' });

  await ensureUser(userId);

  try {
    const result = await sql.begin(async (tx) => {
      // atomic consume payment
      const pay = await tx`
        UPDATE payments
        SET used=true
        WHERE spin_key=${String(spinKey)}
          AND user_id=${String(userId)}
          AND paid=true
          AND used=false
        RETURNING spin_key
      `;

      if (pay.rows.length === 0) {
        // либо не оплачено, либо уже использовано
        return { err: 'not_ready' };
      }

      const wonId = await selectPrizeId(tx, userId);
      const segmentIndex = wheelSectors.findIndex(p => p.id === wonId);
      const prize = wheelSectors[segmentIndex >= 0 ? segmentIndex : 0];

      const uid = uidGen();
      const wonAt = new Date().toISOString();

      await tx`
        INSERT INTO inventory(uid, user_id, prize_id, prize_name, won_at, status)
        VALUES(${uid}, ${String(userId)}, ${prize.id}, ${prize.name}, ${wonAt}, 'inventory')
      `;

      return {
        prize: { id: prize.id, name: prize.name, uid, wonAt, status: 'inventory' },
        segmentIndex: segmentIndex >= 0 ? segmentIndex : 0
      };
    });

    if (result.err === 'not_ready') {
      // фронт будет ретраить (как у тебя)
      return res.status(402).json({ error: 'not paid yet' });
    }

    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: 'spin error' });
  }
};