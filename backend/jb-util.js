const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (n, cur) => `${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${cur ? ' ' + cur : ''}`;
const TZ_H = Number(process.env.TZ_OFFSET_HOURS || 3);
const addisDate = (t = Date.now()) => new Date(t + TZ_H * 3600000).toISOString().slice(0, 10);
const shuffle = (a) => { const r = [...a]; for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const round2 = (n) => Math.round(Number(n) * 100) / 100;
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
// Mini App address: join.html on your Vercel site (/join/ID).
const appUrl = (publicUrl, id) => (process.env.JB_APP_URL ? `${process.env.JB_APP_URL}/join/${id}` : null);
module.exports = { appUrl, sleep, esc, money, addisDate, shuffle, chunk, round2, HttpError };
