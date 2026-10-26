const { HttpError, round2 } = require('./jb-util');

const DEFAULTS = {
  // verification
  captcha: 'emoji', captcha_level: 'normal', captcha_ttl: 180, captcha_tries: 3, captcha_cooldown_min: 10,
  require_phone: false, phone_prefix: '+251',
  // referrals
  referral_enabled: true, referral_reward: 1, referral_require_captcha: true, referral_min_tasks: 1, referral_cap: 0,
  // withdrawals (all amounts are Ethiopian Birr, ETB)
  min_withdraw: 50, max_withdraw: 0, fee_pct: 0, fee_flat: 0, auto_approve: false, methods: ['Telebirr', 'Commercial Bank of Ethiopia'],
  // switches
  maintenance_tasks: false, maintenance_withdraw: false, leaderboard: true,
  // membership rules
  recheck_days: 0, reverse_on_leave: false, rules_text: '',
  // fraud
  flag_claims_per_hour: 30,
  // text
  lang: 'en', tz_offset: 3, welcome_text: '', welcome_photo: '', help_text: '', support_username: '',
};
const merge = (raw) => ({ ...DEFAULTS, ...(raw || {}) });

const num = (v, min, max, name) => { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${name} must be between ${min} and ${max}.`); return round2(n); };
const int = (v, min, max, name) => Math.round(num(v, min, max, name));
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const oneOf = (v, list, name) => { if (!list.includes(v)) throw new HttpError(400, `${name} must be one of: ${list.join(', ')}.`); return v; };

function clean(p) {
  const o = {};
  if ('captcha' in p) o.captcha = oneOf(p.captcha, ['emoji', 'math', 'off'], 'Captcha');
  if ('captcha_level' in p) o.captcha_level = oneOf(p.captcha_level, ['easy', 'normal', 'hard'], 'Captcha level');
  if ('captcha_ttl' in p) o.captcha_ttl = int(p.captcha_ttl, 30, 900, 'Captcha time');
  if ('captcha_tries' in p) o.captcha_tries = int(p.captcha_tries, 1, 10, 'Captcha tries');
  if ('captcha_cooldown_min' in p) o.captcha_cooldown_min = int(p.captcha_cooldown_min, 1, 1440, 'Cooldown minutes');
  if ('require_phone' in p) o.require_phone = !!p.require_phone;
  if ('phone_prefix' in p) { const x = str(p.phone_prefix, 6); if (x && !/^\+\d{1,5}$/.test(x)) throw new HttpError(400, 'Phone prefix looks like +251.'); o.phone_prefix = x; }
  if ('referral_enabled' in p) o.referral_enabled = !!p.referral_enabled;
  if ('referral_reward' in p) o.referral_reward = num(p.referral_reward, 0, 100000, 'Referral reward');
  if ('referral_require_captcha' in p) o.referral_require_captcha = !!p.referral_require_captcha;
  if ('referral_min_tasks' in p) o.referral_min_tasks = int(p.referral_min_tasks, 0, 50, 'Referral minimum tasks');
  if ('referral_cap' in p) o.referral_cap = int(p.referral_cap, 0, 1000000, 'Referral limit');
  if ('min_withdraw' in p) o.min_withdraw = num(p.min_withdraw, 1, 10000000, 'Minimum withdraw');
  if ('max_withdraw' in p) o.max_withdraw = num(p.max_withdraw, 0, 10000000, 'Maximum withdraw');
  if ('fee_pct' in p) o.fee_pct = num(p.fee_pct, 0, 50, 'Fee percent');
  if ('fee_flat' in p) o.fee_flat = num(p.fee_flat, 0, 100000, 'Flat fee');
  if ('auto_approve' in p) o.auto_approve = !!p.auto_approve;
  if ('methods' in p) {
    const m = (Array.isArray(p.methods) ? p.methods : String(p.methods || '').split(',')).map((x) => str(x, 40)).filter(Boolean).slice(0, 8);
    if (!m.length) throw new HttpError(400, 'Add at least one withdraw method.');
    o.methods = m;
  }
  if ('maintenance_tasks' in p) o.maintenance_tasks = !!p.maintenance_tasks;
  if ('maintenance_withdraw' in p) o.maintenance_withdraw = !!p.maintenance_withdraw;
  if ('leaderboard' in p) o.leaderboard = !!p.leaderboard;
  if ('recheck_days' in p) o.recheck_days = int(p.recheck_days, 0, 365, 'Recheck days');
  if ('reverse_on_leave' in p) o.reverse_on_leave = !!p.reverse_on_leave;
  if ('rules_text' in p) o.rules_text = str(p.rules_text, 900);
  if ('flag_claims_per_hour' in p) o.flag_claims_per_hour = int(p.flag_claims_per_hour, 5, 1000, 'Claims per hour');
  if ('lang' in p) o.lang = oneOf(p.lang, ['en', 'am'], 'Language');
  if ('tz_offset' in p) o.tz_offset = int(p.tz_offset, -12, 14, 'Time zone');
  if ('welcome_text' in p) o.welcome_text = str(p.welcome_text, 900);
  if ('welcome_photo' in p) o.welcome_photo = str(p.welcome_photo, 400);
  if ('help_text' in p) o.help_text = str(p.help_text, 900);
  if ('support_username' in p) { const u = str(p.support_username, 40).replace(/^@/, ''); if (u && !/^[A-Za-z0-9_]{4,32}$/.test(u)) throw new HttpError(400, 'Support username is not valid.'); o.support_username = u; }
  return o;
}
module.exports = { DEFAULTS, merge, clean };
