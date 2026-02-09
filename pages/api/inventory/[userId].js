const { sql, ensureSchema, ensureUser } = require('../../../lib/db');

export default async function handler(req, res) {
  await ensureSchema();

  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  await ensureUser(userId);

  const rows = await sql`
    SELECT uid,
           prize_id as id,
           prize_name as name,
           won_at as "wonAt",
           status,
           withdraw_username as "withdrawUsername"
    FROM inventory
    WHERE user_id=${String(userId)}
    ORDER BY won_at ASC
  `;

  return res.status(200).json({ inventory: rows.rows });
}