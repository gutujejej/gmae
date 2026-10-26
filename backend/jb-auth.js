const crypto = require('crypto');
// Validates Telegram Mini App initData on the server. Returns the Telegram user or null.
function checkInitData(initData, botToken, maxAgeSec = 86400) {
  try {
    const p = new URLSearchParams(String(initData || ''));
    const hash = p.get('hash'); if (!hash) return null;
    p.delete('hash');
    const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
    const a = Buffer.from(calc), b = Buffer.from(hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const age = Date.now() / 1000 - Number(p.get('auth_date') || 0);
    if (!(age >= -60 && age <= maxAgeSec)) return null;
    const user = JSON.parse(p.get('user') || 'null');
    return user && user.id ? user : null;
  } catch (_) { return null; }
}
module.exports = { checkInitData };
