const { ensureSchema, ensureUser } = require('../../lib/db');
const { tg } = require('../../lib/tg');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  await ensureSchema();

  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });

  await ensureUser(userId);

  const payload = `spin:${userId}:${Date.now()}`;
  const price = parseInt(process.env.SPIN_PRICE || '1', 10) || 1;

  try {
    const url = await tg('createInvoiceLink', {
      title: '🎰 Крутка барабана',
      description: 'Один спин барабана удачи',
      payload,
      provider_token: "", // ВАЖНО для Stars (XTR)
      currency: 'XTR',
      prices: [{ label: 'Крутка', amount: price }]
    });

    return res.status(200).json({ invoiceUrl: url, spinKey: payload });
  } catch (e) {
    console.error('createInvoiceLink error:', e.message);
    return res.status(500).json({ error: 'invoice error', details: e.message });
  }
}