const { sleep } = require('./jb-util');
const BASE = () => process.env.TG_API_BASE || 'https://api.telegram.org';

class TgError extends Error { constructor(message, code, params) { super(message); this.code = code; this.params = params || {}; } }

function createApi(token) {
  const call = async (method, params = {}, tries = 3) => {
    for (let i = 0; i < tries; i++) {
      let j;
      try {
        const r = await fetch(`${BASE()}/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
        j = await r.json();
      } catch (e) {
        if (i === tries - 1) throw new TgError(`network: ${e.message}`, 0);
        await sleep(400 * (i + 1)); continue;
      }
      if (j.ok) return j.result;
      if (j.error_code === 429 && i < tries - 1) { await sleep(((j.parameters && j.parameters.retry_after) || 1) * 1000 + 100); continue; }
      throw new TgError(j.description || 'telegram error', j.error_code, j.parameters);
    }
  };
  return { call, token };
}

// true = member, false = not a member, null = could not check (bot not admin, chat missing...)
async function memberOf(api, chatId, userId) {
  try {
    const m = await api.call('getChatMember', { chat_id: chatId, user_id: userId }, 2);
    if (['creator', 'administrator', 'member'].includes(m.status)) return true;
    if (m.status === 'restricted') return !!m.is_member;
    return false;
  } catch (e) {
    if (/user not found|PARTICIPANT_ID_INVALID/i.test(e.message)) return false;
    return null;
  }
}

const isGone = (e) => !!e && (e.code === 403 || /blocked|deactivated|chat not found|kicked|user is deleted/i.test(e.message || ''));

// send text / photo / video with an optional url button. Falls back to plain text if the admin wrote invalid HTML.
async function sendRich(api, chatId, { text, media_type, media_url, photo_url, button_text, button_url }) {
  const mt = media_type && media_type !== 'none' ? media_type : (photo_url ? 'photo' : 'none');
  const murl = media_url || photo_url;
  const reply_markup = button_text && button_url ? { inline_keyboard: [[{ text: button_text, url: button_url }]] } : undefined;
  const attempt = async (parse) => {
    const pm = parse ? { parse_mode: 'HTML' } : {};
    if (mt !== 'none' && murl) {
      const cap = (text || '').length <= 1000;
      const r = await api.call(mt === 'video' ? 'sendVideo' : 'sendPhoto', { chat_id: chatId, [mt === 'video' ? 'video' : 'photo']: murl, ...(cap && text ? { caption: text } : {}), ...pm, reply_markup });
      if (!cap && text) await api.call('sendMessage', { chat_id: chatId, text, ...pm, disable_web_page_preview: true });
      return r;
    }
    return api.call('sendMessage', { chat_id: chatId, text: text || ' ', ...pm, disable_web_page_preview: true, reply_markup });
  };
  try { return await attempt(true); } catch (e) { if (/parse entities|can't find end/i.test(e.message)) return attempt(false); throw e; }
}

module.exports = { createApi, TgError, memberOf, isGone, sendRich };
