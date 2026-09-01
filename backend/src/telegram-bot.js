/* ====================================================================== */
/*  telegram-bot.js                                                       */
/*  Runs inside this same backend process (started from server.js) as a   */
/*  long-polling worker - no separate service, no public webhook URL      */
/*  needed. Handles:                                                      */
/*    - /start: asks the user to share their phone number via Telegram's  */
/*      native "Share Contact" button, then auto-registers them through   */
/*      POST /api/auth/telegram-register (this backend's own endpoint,    */
/*      called over loopback/self URL, HMAC-signed) and replies with a    */
/*      "Play" button that opens the site as a Telegram Mini App - with   */
/*      the session token baked into the URL, so the user lands already  */
/*      logged in, no separate login step.                                */
/*    - /start ref_CODE: same flow, but passes the referral code through  */
/*      to telegram-register so the referrer gets credited - this is      */
/*      what a shared t.me/<bot>?start=ref_CODE deep-link resolves to.    */
/*    - broadcastMessage(): called from admin.js's POST /admin/broadcast  */
/*      to message every registered Telegram user.                        */
/* ====================================================================== */

const crypto = require('crypto');
const { logger } = require('./core');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SHARED_SECRET = process.env.TELEGRAM_BOT_SHARED_SECRET;
// Same backend, called over its own public URL - simplest way for this
// module to reach POST /api/auth/telegram-register without importing
// users.js's router internals directly (keeps this file swappable for a
// separate bot service later with a one-line change).
const SELF_API_URL = process.env.SELF_API_URL || `http://localhost:${process.env.PORT || 5000}`;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

// Required channel/group membership, enforced on every /start - not just
// at first registration. The bot must be an admin in both for
// getChatMember to return reliable results (Telegram does not guarantee
// accurate membership data to non-admin bots). Usernames only, no @.
const REQUIRED_CHANNEL = process.env.TELEGRAM_REQUIRED_CHANNEL || 'buna_gam';
const REQUIRED_GROUP = process.env.TELEGRAM_REQUIRED_GROUP || 'bunagames_meber';

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

let pollingActive = false;
let pollOffset = 0;

/* ------------------------------------------------------------------ */
/*  Low-level Telegram Bot API calls                                    */
/* ------------------------------------------------------------------ */

async function telegramCall(method, payload) {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    logger.warn(`[telegram-bot] ${method} failed`, { description: data.description, payload });
  }
  return data;
}

// Statuses that count as "still a member" for Telegram's getChatMember.
// 'left' and 'kicked' mean they're not in the chat (kicked = banned, which
// Telegram also returns for someone who simply left a channel they'd
// been removed from before - either way, not a member).
const MEMBER_STATUSES = new Set(['creator', 'administrator', 'member', 'restricted']);

async function isChatMember(chatUsername, telegramUserId) {
  const data = await telegramCall('getChatMember', {
    chat_id: `@${chatUsername}`,
    user_id: telegramUserId,
  });
  if (!data.ok) {
    // Bot not admin there, chat doesn't exist, or a transient API error -
    // treated as "not joined" so the gate fails safe (blocks access)
    // rather than silently letting everyone through on an API hiccup.
    return false;
  }
  return MEMBER_STATUSES.has(data.result?.status);
}

// Checks both required chats for one Telegram user. Called by the
// GET /api/telegram/membership-status route (see users.js) that the
// frontend's join-gate polls.
async function checkRequiredMembership(telegramUserId) {
  const [channelJoined, groupJoined] = await Promise.all([
    isChatMember(REQUIRED_CHANNEL, telegramUserId),
    isChatMember(REQUIRED_GROUP, telegramUserId),
  ]);
  return {
    channel_joined: channelJoined,
    group_joined: groupJoined,
    channel_url: `https://t.me/${REQUIRED_CHANNEL}`,
    group_url: `https://t.me/${REQUIRED_GROUP}`,
  };
}

function sendMessage(chatId, text, extra = {}) {
  return telegramCall('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
}

// Sends the native "share your phone number" prompt. Telegram shows this
// as a button on the user's own keyboard (not inline) - tapping it lets
// the user share their real account phone number with one tap, no typing.
function requestPhoneNumber(chatId) {
  return sendMessage(chatId, "Welcome to Buna Games! Tap the button below to get started - we just need your phone number to set up your account.", {
    reply_markup: {
      keyboard: [[{ text: '📱 Share my phone number', request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
}

// Sends the Play button once the user is registered/logged in. It's a
// WebApp button (not a plain URL button) so it opens INSIDE Telegram as
// a Mini App rather than kicking the user out to their regular browser.
// The session token is embedded in the URL so the frontend can log the
// user in immediately on load - see app-shell.jsx's token-from-URL
// handling.
function sendPlayButton(chatId, token) {
  const playUrl = `${CLIENT_ORIGIN}/?tg_token=${encodeURIComponent(token)}`;
  return sendMessage(chatId, "You're all set! Tap below to play.", {
    reply_markup: {
      remove_keyboard: true,
      inline_keyboard: [[{ text: '🎮 Play', web_app: { url: playUrl } }]],
    },
  });
}

/* ------------------------------------------------------------------ */
/*  Registration bridge - calls this backend's own telegram-register    */
/*  endpoint, signed the same way an external bot server would.         */
/* ------------------------------------------------------------------ */

async function registerWithBackend({ telegram_id, first_name, phone, referral_code }) {
  if (!SHARED_SECRET) {
    logger.error('[telegram-bot] TELEGRAM_BOT_SHARED_SECRET is not set - cannot register users');
    return { error: 'not_configured' };
  }

  const body = JSON.stringify({ telegram_id, first_name, phone, referral_code });
  const signature = crypto.createHmac('sha256', SHARED_SECRET).update(body).digest('hex');

  try {
    const res = await fetch(`${SELF_API_URL}/api/auth/telegram-register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Signature': signature },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      logger.warn('[telegram-bot] telegram-register rejected', { status: res.status, error: data.error });
      return { error: data.error || 'registration_failed' };
    }
    return data; // { token, user, isNewUser }
  } catch (err) {
    logger.error('[telegram-bot] telegram-register unreachable', { error: err.message });
    return { error: 'unreachable' };
  }
}

/* ------------------------------------------------------------------ */
/*  Update handling                                                     */
/* ------------------------------------------------------------------ */

// Pending referral codes, keyed by telegram chat id, captured from a
// /start ref_CODE deep-link and applied once the user actually shares
// their phone number a moment later. Small in-memory map is fine here -
// it only needs to survive the few seconds between /start and the
// contact-share reply, and the bot process is a single instance.
const pendingReferralByChat = new Map();

async function handleStart(message) {
  const chatId = message.chat.id;
  const text = message.text || '';

  // Deep-link payload: "/start ref_ABC123" -> referral code "ABC123".
  const match = text.match(/^\/start\s+ref_(\S+)/);
  if (match) {
    pendingReferralByChat.set(chatId, match[1]);
  }

  await requestPhoneNumber(chatId);
}

async function handleContact(message) {
  const chatId = message.chat.id;
  const contact = message.contact;

  // Only accept the user sharing THEIR OWN contact card, never a
  // forwarded contact for someone else - otherwise anyone could register
  // an account "as" a phone number that isn't theirs.
  if (!contact || contact.user_id !== message.from.id) {
    await sendMessage(chatId, "Please use the button to share your own phone number.");
    return;
  }

  const referralCode = pendingReferralByChat.get(chatId) || null;
  pendingReferralByChat.delete(chatId);

  const result = await registerWithBackend({
    telegram_id: message.from.id,
    first_name: message.from.first_name || '',
    phone: contact.phone_number,
    referral_code: referralCode,
  });

  if (result.error === 'not_configured') {
    await sendMessage(chatId, "Registration is temporarily unavailable. Please try again shortly.");
    return;
  }
  if (result.error) {
    await sendMessage(chatId, "Something went wrong setting up your account. Please try /start again.");
    return;
  }

  await sendPlayButton(chatId, result.token);
}

async function handleUpdate(update) {
  const message = update.message;
  if (!message) return;

  if (message.text && message.text.startsWith('/start')) {
    await handleStart(message);
  } else if (message.contact) {
    await handleContact(message);
  }
}

/* ------------------------------------------------------------------ */
/*  Long polling loop                                                   */
/* ------------------------------------------------------------------ */

async function pollOnce() {
  const data = await telegramCall('getUpdates', { offset: pollOffset, timeout: 25 });
  if (!data.ok || !Array.isArray(data.result)) return;

  for (const update of data.result) {
    pollOffset = update.update_id + 1;
    try {
      await handleUpdate(update);
    } catch (err) {
      logger.error('[telegram-bot] Failed handling update', { error: err.message, update_id: update.update_id });
    }
  }
}

async function pollLoop() {
  while (pollingActive) {
    try {
      await pollOnce();
    } catch (err) {
      logger.error('[telegram-bot] Poll cycle failed', { error: err.message });
      // Back off briefly on a hard failure (e.g. network blip) so a
      // persistent outage doesn't spin in a tight error loop.
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

function startTelegramBot() {
  if (!BOT_TOKEN) {
    logger.warn('[telegram-bot] TELEGRAM_BOT_TOKEN not set - bot disabled');
    return;
  }
  if (!SHARED_SECRET) {
    logger.warn('[telegram-bot] TELEGRAM_BOT_SHARED_SECRET not set - bot disabled');
    return;
  }
  if (pollingActive) return;

  pollingActive = true;
  logger.info('[telegram-bot] Starting long-polling loop');
  pollLoop();
}

function stopTelegramBot() {
  pollingActive = false;
}

/* ------------------------------------------------------------------ */
/*  Admin broadcast - called from admin.js's POST /admin/broadcast      */
/* ------------------------------------------------------------------ */

async function broadcastMessage(telegramIds, text) {
  if (!BOT_TOKEN) {
    return { sent: 0, failed: telegramIds.length, error: 'Bot is not configured (TELEGRAM_BOT_TOKEN missing)' };
  }

  let sent = 0;
  let failed = 0;

  // Sent sequentially with a small delay rather than all at once -
  // Telegram rate-limits outgoing messages (roughly 30/second across all
  // chats), and blasting them all in parallel would just trigger 429s
  // that turn into failures we could have avoided.
  for (const telegramId of telegramIds) {
    const result = await sendMessage(telegramId, text);
    if (result.ok) {
      sent += 1;
    } else {
      failed += 1;
    }
    await new Promise((r) => setTimeout(r, 40));
  }

  return { sent, failed };
}

module.exports = { startTelegramBot, stopTelegramBot, broadcastMessage, checkRequiredMembership };
