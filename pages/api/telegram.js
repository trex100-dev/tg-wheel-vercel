const { sql, ensureSchema, ensureUser, withTransaction } = require('../../lib/db');
const { tg } = require('../../lib/tg');
const { isVip } = require('../../lib/env');
const { addGuaranteesIfNeeded } = require('../../lib/game');

export default async function handler(req, res) {
  await ensureSchema();

  // Telegram всегда ждёт 200 быстро
  res.status(200).json({ ok: true });

  const update = req.body || {};

  try {
    // 1) pre_checkout_query
    if (update.pre_checkout_query) {
      // console.log('TG UPDATE: pre_checkout_query'); // Отладочный лог
      await tg('answerPreCheckoutQuery', {
        pre_checkout_query_id: update.pre_checkout_query.id,
        ok: true
      });
      return;
    }

    // 2) successful_payment
    if (update.message && update.message.successful_payment) {
      // console.log('TG UPDATE: successful_payment'); // Отладочный лог
      const sp = update.message.successful_payment;
      const payload = sp.invoice_payload; // spin:userId:timestamp
      const parts = String(payload || '').split(':');

      if (parts[0] === 'spin' && parts[1]) {
        const userId = String(parts[1]);
        // console.log('API TG: Processing successful payment for spinKey:', payload); // Отладочный лог
        await ensureUser(userId);

        // idempotent insert (если уже вставлено — не считаем повторно)
        const ins = await sql`
          INSERT INTO payments(spin_key, user_id, paid, used, paid_at)
          VALUES(${payload}, ${userId}, true, false, now())
          ON CONFLICT (spin_key) DO NOTHING
          RETURNING spin_key
        `;

        if (ins.rows.length > 0) {
          const price = parseInt(process.env.SPIN_PRICE || '1', 10) || 1;

          await withTransaction(async (tx) => {
            await tx(
              `UPDATE users
               SET total_spent = total_spent + $1,
                   spins_count = spins_count + 1
               WHERE user_id=$2`,
              [price, userId]
            );

            if (isVip(userId)) {
              await tx(
                `UPDATE user_progress SET guarantee_queue='[]'::jsonb WHERE user_id=$1`,
                [userId]
              );
            } else {
              await addGuaranteesIfNeeded(tx, userId);
            }
          });
        }
      }
      return;
    }

    // 3) callback_query (кнопки админа)
    if (update.callback_query) {
      // console.log('TG UPDATE: callback_query', update.callback_query.data); // Отладочный лог
      const cb = update.callback_query;
      const data = String(cb.data || '');
      const parts = data.split(':');

      const action = parts[0];
      const userId = parts[1];
      const uid = parts[2];

      if (!userId || !uid) {
        await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Ошибка' });
        return;
      }

      const item = await sql`
        SELECT * FROM inventory WHERE user_id=${String(userId)} AND uid=${String(uid)}
      `;

      if (item.rows.length === 0) {
        await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Приз не найден' });
        return;
      }

      const it = item.rows[0];
      if (it.status !== 'pending') {
        await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Уже обработано' });
        return;
      }

      if (action === 'withdraw_done') {
        await sql`UPDATE inventory SET status='completed', completed_at=now() WHERE uid=${String(uid)}`;

        await tg('editMessageText', {
          chat_id: cb.message.chat.id,
          message_id: cb.message.message_id,
          parse_mode: 'HTML',
          text:
            '📤 <b>Заявка</b>\n\n' +
            '👤 @' + (it.withdraw_username || '') + '\n' +
            '🆔 <code>' + String(userId) + '</code>\n\n' +
            '🎁 <b>' + it.prize_name + '</b>\n\n' +
            '✅ <b>ВЫВЕДЕНО</b>\n' +
            '🔑 <code>' + it.uid + '</code>'
        });

        await tg('answerCallbackQuery', { callback_query_id: cb.id, text: '✅ Выведено' });
        return;
      }

      if (action === 'withdraw_reject') {
        await sql`UPDATE inventory SET status='rejected', rejected_at=now() WHERE uid=${String(uid)}`;

        await tg('editMessageText', {
          chat_id: cb.message.chat.id,
          message_id: cb.message.message_id,
          parse_mode: 'HTML',
          text:
            '📤 <b>Заявка</b>\n\n' +
            '👤 @' + (it.withdraw_username || '') + '\n' +
            '🆔 <code>' + String(userId) + '</code>\n\n' +
            '🎁 <b>' + it.prize_name + '</b>\n\n' +
            '❌ <b>ОТКАЗАНО</b>\n' +
            '🔑 <code>' + it.uid + '</code>'
        });

        await tg('answerCallbackQuery', { callback_query_id: cb.id, text: '❌ Отказано' });
        return;
      }

      await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Неизвестно' });
      return;
    }
  } catch (e) {
    console.error('telegram webhook error:', e.message);
  }
}