function parseAdminSecret(raw) {
  raw = (raw || '').trim();

  let adminSecret = '';
  let vipIds = [];

  // VIP=...
  const vipMatch = raw.match(/VIP=([^;]+)/i);
  if (vipMatch && vipMatch[1]) {
    vipIds = vipMatch[1]
      .split(/[, ]+/)
      .map(s => s.trim())
      .filter(Boolean);
  } else {
    // если строка выглядит как "111,222,333"
    if (/^\d+([,\s]+\d+)*$/.test(raw)) {
      vipIds = raw.split(/[, ]+/).map(s => s.trim()).filter(Boolean);
    }
  }

  // SECRET=...
  const secretMatch = raw.match(/SECRET=([^;]+)/i);
  if (secretMatch && secretMatch[1]) {
    adminSecret = secretMatch[1].trim();
  } else {
    // если не выглядит как vip-список — считаем секретом
    if (vipIds.length === 0 && raw && !raw.includes('VIP=')) adminSecret = raw;
  }

  return { adminSecret, vipIds };
}

const parsed = parseAdminSecret(process.env.ADMIN_SECRET || '');

const ADMIN_SECRET = parsed.adminSecret || '';
const VIP_IDS = new Set(parsed.vipIds.map(String));

function isVip(userId) {
  return VIP_IDS.has(String(userId));
}

// VIP веса (редкие чаще медведя). Настраивай как хочешь.
const VIP_WEIGHTS = {
  prize_1: 8,   // Медведь (мало)
  prize_2: 7,   // Роза
  prize_3: 28,  // Леденец
  prize_4: 25,  // Сига
  prize_5: 5,   // Папаха (если не надо — поставь 0)
  prize_6: 27   // Кнопка
};

module.exports = { ADMIN_SECRET, VIP_IDS, isVip, VIP_WEIGHTS };