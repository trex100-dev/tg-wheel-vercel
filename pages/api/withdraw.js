const { sql, ensureSchema, ensureUser } = require('../../lib/db');
const { tg } = require('../../lib/tg');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  await ensureSchema();

  const { userId, itemUid, username } = req.body || {};
  if (!userId || !itemUid) return res.status(400).json({ error: 'missing params' });
  if (!username || !String(username).trim()) return res.status(400).json({ error: 'Username обязателен' });

  const uName = String(username).trim().replace(/^@/, '');

  await ensureUser(userId);

  const item = await sql`
    SELECT * FROM inventory
    WHERE user_id=${String(userId)} AND uid=${String(itemUid)}
  `;

  if (item.rows.length === 0) return res.status(404).json({ error: 'Not found' });
  if (item.rows[0].status !== 'inventory') return res.status(400).json({ error: 'Уже обработано' });

  await sql`
    UPDATE inventory
    SET status='pending',
        withdraw_username=${uName},
        withdrawn_at=now()
    WHERE uid=${String(itemUid)}
  `;

  // сообщение в админ чат с кнопками
  try {
    await tg('sendMessage', {
      chat_id: process.env.ADMIN_CHAT_ID,
      parse_mode: 'HTML',
      text:
        '📤 <b>Заявка на вывод</b>\n\n' +
        '👤 @' + uName + '\n' +
        '🆔 <code>' + String(userId) + '</code>\n\n' +
        '🎁 <b>' + item.rows[0].prize_name + '</b>\n' +
        '🔑 <code>' + item.rows[0].uid + '</code>\n\n' +
        '⏳ <b>Ожидание</b>',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Выведено', callback_data: 'withdraw_done:' + String(userId) + ':' + item.rows[0].uid },
          { text: '❌ Отказано', callback_data: 'withdraw_reject:' + String(userId) + ':' + item.rows[0].uid }
        ]]
      }
    });
  } catch (e) {
    console.error('sendMessage admin error:', e.message);
  }

  return res.status(200).json({ success: true });
}