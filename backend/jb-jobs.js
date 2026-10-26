// Background work: scheduled posts, broadcasts, membership recheck. Runs inside the same server process.
const { sendRich, isGone } = require('./jb-tg');
const { sleep } = require('./jb-util');
const E = require('./jb-engine');

const nextRun = (runAt, repeat) => new Date(new Date(runAt).getTime() + (repeat === 'weekly' ? 7 : 1) * 86400000).toISOString();

/* ------------------------------ scheduled posts ------------------------------ */
async function publishPost(ctx, post, runKey) {
  const ids = (post.targets || []).map(Number);
  const chans = ids.length ? E.must(await ctx.db.from('jb_channels').select('*').eq('bot_id', ctx.bot.id).in('id', ids)) : [];
  const results = [];
  for (const ch of chans) {
    const ex = (await ctx.db.from('jb_published').select('id,status').eq('post_id', post.id).eq('run_key', runKey).eq('channel_id', ch.id).maybeSingle()).data;
    if (ex && ex.status === 'ok') { results.push({ channel_id: ch.id, ok: true, skipped: true }); continue; }   // a retry never posts twice
    let row;
    try {
      const m = await sendRich(ctx.api, ch.chat_id, post);
      row = { status: 'ok', message_id: m && m.message_id ? m.message_id : null, error: null };
      await ctx.db.from('jb_channels').update({ last_error: null }).eq('id', ch.id);
    } catch (e) {
      row = { status: 'failed', message_id: null, error: String(e.message).slice(0, 200) };
      await ctx.db.from('jb_channels').update({ last_error: row.error }).eq('id', ch.id);
    }
    if (ex) await ctx.db.from('jb_published').update(row).eq('id', ex.id);
    else await ctx.db.from('jb_published').insert({ bot_id: ctx.bot.id, post_id: post.id, run_key: runKey, channel_id: ch.id, ...row });
    results.push({ channel_id: ch.id, ok: row.status === 'ok', error: row.error });
    await sleep(60);
  }
  return results;
}

async function runDuePosts(registry, db) {
  const due = E.must(await db.from('jb_posts').select('*').eq('status', 'scheduled').lte('run_at', new Date().toISOString()).order('run_at', { ascending: true }).limit(20));
  let n = 0;
  for (const post of due) {
    const upd = post.repeat === 'none' ? { status: 'done', last_run_at: post.run_at } : { run_at: nextRun(post.run_at, post.repeat), last_run_at: post.run_at };
    // claim: only one worker can move this row from its current run_at, so a retried job never publishes twice
    const claim = await db.from('jb_posts').update(upd).eq('id', post.id).eq('status', 'scheduled').eq('run_at', post.run_at).select();
    if (claim.error || !claim.data || !claim.data.length) continue;
    const ctx = await registry.ctxFor(post.bot_id);
    if (!ctx || ctx.bot.status !== 'active') continue;
    const results = await publishPost(ctx, post, new Date(post.run_at).toISOString());
    if (results.length && results.every((r) => !r.ok) && post.repeat === 'none') await db.from('jb_posts').update({ status: 'error' }).eq('id', post.id);
    n++;
  }
  return n;
}

/* ------------------------------ broadcasts ------------------------------ */
const running = new Set();

async function audienceFilter(ctx, audience) {
  let doers = null;
  if (audience === 'task_doers') doers = new Set(E.must(await ctx.db.from('jb_task_claims').select('user_id').eq('bot_id', ctx.bot.id).eq('status', 'approved')).map((r) => Number(r.user_id)));
  const since = Date.now() - 7 * 86400000;
  return (u) => !u.blocked && !u.banned && (audience === 'all' || (audience === 'verified' && u.captcha_ok) || (audience === 'active' && new Date(u.last_seen).getTime() >= since) || (audience === 'task_doers' && doers.has(Number(u.tg_id))));
}

async function countAudience(ctx, audience) {
  const ok = await audienceFilter(ctx, audience); let n = 0, cur = 0;
  for (;;) {
    const page = E.must(await ctx.db.from('jb_users').select('tg_id,blocked,banned,captcha_ok,last_seen').eq('bot_id', ctx.bot.id).gt('tg_id', cur).order('tg_id', { ascending: true }).limit(1000));
    if (!page.length) break;
    n += page.filter(ok).length; cur = page[page.length - 1].tg_id;
  }
  return n;
}

async function runBroadcast(registry, db, bc, pace = 50) {
  if (running.has(bc.id)) return;
  running.add(bc.id);
  try {
    const ctx = await registry.ctxFor(bc.bot_id);
    if (!ctx || ctx.bot.status !== 'active') return;
    const ok = await audienceFilter(ctx, bc.audience);
    let { cursor_id: cur, sent, failed } = bc;
    if (bc.status === 'queued') await db.from('jb_broadcasts').update({ status: 'running', total: await countAudience(ctx, bc.audience) }).eq('id', bc.id);
    for (;;) {
      const fresh = (await db.from('jb_broadcasts').select('status').eq('id', bc.id).maybeSingle()).data;
      if (!fresh || fresh.status === 'cancelled') return;
      const page = E.must(await db.from('jb_users').select('tg_id,blocked,banned,captcha_ok,last_seen').eq('bot_id', bc.bot_id).gt('tg_id', cur).order('tg_id', { ascending: true }).limit(100));
      if (!page.length) break;
      for (const u of page) {
        cur = u.tg_id;
        if (!ok(u)) continue;
        try { await sendRich(ctx.api, u.tg_id, bc); sent++; }
        catch (e) { failed++; if (isGone(e)) await db.from('jb_users').update({ blocked: true }).eq('bot_id', bc.bot_id).eq('tg_id', u.tg_id); }
        await sleep(pace);                       // about 20 messages per second, under Telegram's limit
      }
      await db.from('jb_broadcasts').update({ cursor_id: cur, sent, failed }).eq('id', bc.id);
    }
    await db.from('jb_broadcasts').update({ status: 'done', sent, failed, cursor_id: cur, finished_at: new Date().toISOString() }).eq('id', bc.id);
  } finally { running.delete(bc.id); }
}

async function runDueBroadcasts(registry, db) {
  const rows = E.must(await db.from('jb_broadcasts').select('*').in('status', ['queued', 'running']).lte('run_at', new Date().toISOString()).limit(3));
  for (const bc of rows) runBroadcast(registry, db, bc).catch((e) => console.error('broadcast error:', e.message));
  return rows.length;
}

/* ------------------------------ membership recheck ------------------------------ */
async function runRechecks(registry) {
  for (const id of await registry.activeBots()) {
    const ctx = await registry.ctxFor(id);
    if (ctx && Number(ctx.S.recheck_days) > 0) await E.recheckMembership(ctx, 40).catch((e) => console.error('recheck error:', e.message));
  }
}

function start(registry, db) {
  const safe = (name, fn) => () => fn().catch((e) => console.error(`${name} error:`, e.message));
  const timers = [
    setInterval(safe('posts', () => runDuePosts(registry, db)), 30 * 1000),
    setInterval(safe('broadcasts', () => runDueBroadcasts(registry, db)), 10 * 1000),
    setInterval(safe('recheck', () => runRechecks(registry)), 10 * 60 * 1000),
  ];
  timers.forEach((t) => t.unref());
  return () => timers.forEach(clearInterval);
}

module.exports = { publishPost, runDuePosts, runBroadcast, runDueBroadcasts, countAudience, runRechecks, start, nextRun };
