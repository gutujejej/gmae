// Automatic payment check shared by the games wallet (same verify.et service
// the store uses). Also reads a pasted Telebirr / CBE SMS receipt.
//
//   CHECK_API_KEY   your verify.et API key (sent as x-api-key)
//   CHECK_API_URL   optional, defaults to https://verify.et
//
// verifyPayment() returns { state: 'verified' | 'failed' | 'unverified', reason, detail }
//   verified   = real, receiver matches, amount matches (when one was claimed)
//   failed     = verify.et answered and something does not match / not found
//   unverified = service unavailable or unclear -> goes to the admin queue, never auto-credited

const VERIFY_BASE = (process.env.CHECK_API_URL || 'https://verify.et').replace(/\/+$/, '').replace(/\/api\/verify$/, '');

const digits = (s) => String(s ?? '').replace(/\D/g, '');
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* SMS / receipt text                                                   */
/* ------------------------------------------------------------------ */
// Reads text like:
//   Dear Bekele  You have transferred ETB 50.00 to Borla Osman (2519****5967) on 14/10/2026 23:38:28.
//   Your transaction number is DJE9T39EU9. ... https://transactioninfo.ethiotelecom.et/receipt/DJE9T39EU9
// Everything here is only a CLAIM made by the user. The real amount and receiver
// always come from verify.et, never from this text.
function parseReceiptText(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  const out = { reference: null, amount: null, receiverMask: null, receiverName: null, date: null };
  if (!text) return out;

  let m = text.match(/transaction (?:number|no\.?|id)\s*(?:is|:)?\s*([A-Z0-9]{6,20})/i)
       || text.match(/\/receipt\/([A-Z0-9]{6,20})/i)
       || text.match(/\b(FT[A-Z0-9]{8,18})\b/);            // CBE reference
  if (m) out.reference = m[1].toUpperCase();

  m = text.match(/transferred\s+ETB\s*([\d,]+(?:\.\d+)?)/i) || text.match(/ETB\s*([\d,]+(?:\.\d+)?)\s+to\b/i);
  if (m) out.amount = round2(m[1].replace(/,/g, ''));

  m = text.match(/\bto\s+(.+?)\s*\((\+?[\d*xX•]{6,})\)/i);
  if (m) { out.receiverName = m[1].trim(); out.receiverMask = m[2]; }

  m = text.match(/on\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
  if (m) out.date = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4] - 3, +m[5], +m[6])).toISOString(); // Ethiopia = UTC+3
  return out;
}

// The SMS shows the receiver as 2519****5967. Compare only the digits it shows.
function maskMatchesAccount(mask, account) {
  const want = digits(account);
  const raw = String(mask || '');
  if (!want || !raw) return null;
  const head = digits(raw.split(/[*xX•]+/)[0] || '');
  const tail = digits(raw.split(/[*xX•]+/).slice(-1)[0] || '');
  if (!head && !tail) return null;
  if (tail && want.slice(-tail.length) !== tail) return false;
  if (head) {
    const w = want.length >= 9 ? '251' + want.slice(-9) : want;
    if (!w.startsWith(head) && !want.startsWith(head)) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* verify.et                                                            */
/* ------------------------------------------------------------------ */
function buildBody(method, reference, receiver) {
  if (method === 'cbe') {
    const acc = digits(receiver);
    const body = { bank: 'cbe', reference, settlementAccount: acc };
    if (/^FT/i.test(reference)) body.accountSuffix = acc.slice(-8);
    return body;
  }
  return { bank: 'telebirr', transactionNumber: reference, settlementAccount: digits(receiver) };
}

function receiverMatches(receiverAccount, want) {
  const w = digits(want);
  if (!w) return null;
  const raw = String(receiverAccount || '');
  const got = digits(raw);
  if (got.length < 4) return null;
  const masked = /[*xX\u2022]/.test(raw);
  const n = masked ? Math.min(4, got.length) : Math.min(9, got.length, w.length);
  return w.slice(-n) === got.slice(-n);
}

async function callVerify(path, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(`${VERIFY_BASE}${path}`, { ...init, signal: ctl.signal });
    const json = await r.json().catch(() => null);
    return { status: r.status, json };
  } finally { clearTimeout(timer); }
}

// expectedAmount may be null (user pasted nothing but the number): then the
// amount verify.et reports is what gets credited.
async function verifyPayment({ method, reference, receiver, expectedAmount = null, idemKey }) {
  const key = process.env.CHECK_API_KEY;
  if (!key) return { state: 'unverified', reason: 'Automatic check is not configured.' };
  if (!receiver) return { state: 'unverified', reason: 'Payment receiver is not set.' };
  const headers = { 'Content-Type': 'application/json', 'x-api-key': key };

  let res;
  try {
    res = await callVerify('/api/verify?waitMs=10000', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': String(idemKey || `${method}-${reference}`).slice(0, 255) },
      body: JSON.stringify(buildBody(method, reference, receiver)),
    });
  } catch (err) {
    return { state: 'unverified', reason: 'The check service did not respond.' };
  }

  if ([401, 402, 403, 429, 503].includes(res.status) || res.status >= 500) {
    return { state: 'unverified', reason: 'The check service is unavailable.', detail: { http: res.status } };
  }
  if (res.status === 409 || res.status === 422) {
    return { state: 'failed', reason: 'That transaction number is not valid. Check it and try again.', detail: { http: res.status } };
  }

  let body = res.json;
  if (res.status === 202 && body && (body.requestId || (body.verification && body.verification.requestId))) {
    const rid = body.requestId || body.verification.requestId;
    for (let i = 0; i < 6; i++) {
      await sleep(2000);
      try {
        const p = await callVerify(`/api/verify/${encodeURIComponent(rid)}`, { headers });
        const d = p.json && p.json.data;
        if (d && !Array.isArray(d) && d.processingStatus === 'completed') {
          body = { success: p.json.success, data: [d] };
          break;
        }
      } catch { /* keep polling */ }
    }
    if (body === res.json) return { state: 'unverified', reason: 'The check is taking longer than usual.' };
  }
  if (!body) return { state: 'unverified', reason: 'The check service gave no clear answer.' };

  const r = Array.isArray(body.data) ? body.data[0] : null;
  if (!r) return { state: 'unverified', reason: 'The check service gave no clear answer.' };

  const verified = r.verified === true && /^(success|completed|verified)$/i.test(String(r.status || 'success'));
  const amount = r.amount == null ? null : Number(String(r.amount).replace(/[^0-9.]/g, ''));
  const detail = {
    amount: Number.isFinite(amount) ? round2(amount) : null,
    receiver: r.receiverAccount || null, receiverName: r.receiverName || null, status: r.status || null,
  };

  if (!verified) {
    const st = String(r.status || '').toLowerCase();
    if (/not.?found|fail|invalid|reject|cancel|reverse/.test(st) || r.verified === false) {
      return { state: 'failed', reason: 'The transaction was not found or is not successful.', detail };
    }
    return { state: 'unverified', reason: 'Could not confirm the transaction.', detail };
  }
  if (detail.amount == null || detail.amount <= 0) return { state: 'unverified', reason: 'The check did not return an amount.', detail };
  if (expectedAmount != null && Math.abs(detail.amount - round2(expectedAmount)) > 0.009) {
    return { state: 'failed', reason: `Amount does not match. The payment was ${detail.amount} ETB, not ${round2(expectedAmount)} ETB.`, detail };
  }

  const m = r.settlementAccountMatch;
  let receiverOk = null;
  if (m && m.matched === true && m.ambiguous !== true) receiverOk = true;
  else if (m && m.matched === false && m.reason === 'candidate_account_mismatch') receiverOk = false;
  if (receiverOk === null) receiverOk = receiverMatches(r.receiverAccount, receiver);
  detail.settlement = m ? { matched: m.matched, reason: m.reason } : null;

  if (receiverOk === false) return { state: 'failed', reason: 'The payment was not sent to our account.', detail };
  if (receiverOk === null) return { state: 'unverified', reason: 'The receiver could not be confirmed.', detail };
  return { state: 'verified', detail };
}

module.exports = { verifyPayment, parseReceiptText, maskMatchesAccount, digits, round2 };
