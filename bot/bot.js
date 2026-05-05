// bot.js — Chogi buy bot · TG buy + burn alerts, slash commands, AI replies.
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Telegraf, Markup } from 'telegraf';
import { config } from './config.js';
import { startDexWatcher } from './dexWatcher.js';
import { findReply } from './replies.js';
import { ask, getStats, setAIEnabled, isAIEnabled } from './aiBrain.js';

// ── boot guards ──────────────────────────────────────────────
if (!process.env.BOT_TOKEN) {
  console.error('FATAL: BOT_TOKEN missing in .env');
  process.exit(1);
}
if (!process.env.CHAT_ID) {
  console.error('FATAL: CHAT_ID missing in .env');
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const CHAT_ID = process.env.CHAT_ID;
const ADMINS = (process.env.ADMINS || '').split(',').map(s => s.trim()).filter(Boolean);
const isAdmin = (ctx) => ADMINS.length === 0 || ADMINS.includes(String(ctx.from?.id));

process.on('unhandledRejection', (err) => console.error('🔥 unhandledRejection:', err?.stack || err));
process.on('uncaughtException',  (err) => console.error('🔥 uncaughtException:',  err?.stack || err));

// ── thresholds ───────────────────────────────────────────────
const MIN_BUY_USD    = Number(process.env.MIN_BUY_USD || 5);    // ignore buys under this USD
const MIN_BURN_CHOGI = Number(process.env.MIN_BURN_CHOGI || 5000);
const TG_MIN_GAP_MS  = Number(process.env.TG_MIN_GAP_MS || 2500);

// ── inline keyboard for buy alerts ───────────────────────────
const buyKeyboard = Markup.inlineKeyboard([
  [Markup.button.url('🟢 Buy $CHOGI', config.buyUrl), Markup.button.url('🔥 Burn',   config.burnUrl)],
  [Markup.button.url('🧪 Lab',         config.labUrl), Markup.button.url('📊 Chart',  config.chartUrl)],
  [Markup.button.url('🌐 chogi.xyz',   config.siteUrl)]
]);

// ── DexScreener USD cache ────────────────────────────────────
const PRICE_REFRESH_MS = Number(process.env.PRICE_REFRESH_MS || 30000);
const CHAIN_CANDIDATES = ['monad', 'monad-mainnet', 'monad_mainnet'];
const usdCache = { priceUsd: 0, mcUsd: 0, change24h: null, volume24h: 0, liq: 0, last: 0, chainUsed: null };

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'chogi-buybot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function refreshUsd(force = false) {
  const now = Date.now();
  if (!force && (now - usdCache.last < PRICE_REFRESH_MS) && usdCache.priceUsd > 0) return;
  const chains = usdCache.chainUsed
    ? [usdCache.chainUsed, ...CHAIN_CANDIDATES.filter(c => c !== usdCache.chainUsed)]
    : CHAIN_CANDIDATES;
  for (const chainId of chains) {
    try {
      const url  = `https://api.dexscreener.com/latest/dex/pairs/${chainId}/${config.pair}`;
      const json = await fetchJson(url);
      const pair = json?.pairs?.[0];
      const pUsd = Number(pair?.priceUsd || 0);
      const mc   = Number(pair?.marketCap || 0) || Number(pair?.fdv || 0);
      if (pUsd > 0) {
        usdCache.priceUsd  = pUsd;
        usdCache.mcUsd     = mc > 0 ? mc : 0;
        usdCache.change24h = pair?.priceChange?.h24 != null ? Number(pair.priceChange.h24) : null;
        usdCache.volume24h = Number(pair?.volume?.h24 || 0);
        usdCache.liq       = Number(pair?.liquidity?.usd || 0);
        usdCache.last      = now;
        usdCache.chainUsed = chainId;
        return;
      }
    } catch {}
  }
}

// ── Formatters ───────────────────────────────────────────────
function short(addr) { return `${addr.slice(0, 6)}…${addr.slice(-4)}`; }
function fmtUsd(x) {
  if (!Number.isFinite(x) || x <= 0) return '—';
  if (x >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (x >= 1e6) return `$${(x / 1e6).toFixed(2)}M`;
  if (x >= 1e3) return `$${(x / 1e3).toFixed(1)}K`;
  if (x >= 1)   return `$${x.toFixed(2)}`;
  if (x > 0)    return `$${x.toFixed(4)}`;
  return '—';
}
function fmtNum(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  if (n >= 1)   return n.toFixed(2);
  return n.toFixed(4);
}
function fmtPct(p) {
  if (p == null || !Number.isFinite(p)) return '—';
  const sign = p >= 0 ? '+' : '';
  return `${sign}${p.toFixed(1)}%`;
}
function escapeMd(s) { return String(s).replace(/[_*[\]()~`>#+=|{}.!-]/g, m => '\\' + m); }

// ── Tier scaling (theatrical buy levels) ─────────────────────
function buyTier(usd) {
  if (usd >= 10000) return { label: 'MEGA WHALE · CONTAINMENT BREACH',  emoji: '🚨', breach: true,  rockets: 15, level: 4 };
  if (usd >= 5000)  return { label: 'WHALE BUY · CONTAINMENT BREACH',   emoji: '🚨', breach: true,  rockets: 10, level: 3 };
  if (usd >= 1000)  return { label: 'BIG BUY · CONTAINED',              emoji: '🐋', breach: false, rockets: 6,  level: 2 };
  if (usd >= 200)   return { label: 'BUY · LAB SECURE',                 emoji: '🚀', breach: false, rockets: 3,  level: 1 };
  if (usd >= 50)    return { label: 'BUY',                              emoji: '🟢', breach: false, rockets: 1,  level: 0 };
  return                   { label: 'small buy',                        emoji: '🟢', breach: false, rockets: 0,  level: 0 };
}

// ── Buy alert composer ───────────────────────────────────────
function composeBuyMsg(buy, usd) {
  const t = buyTier(usd);
  const priceLine = usdCache.priceUsd > 0 ? `$${usdCache.priceUsd.toFixed(8)}` : '—';
  const mc  = usdCache.mcUsd > 0 ? fmtUsd(usdCache.mcUsd) : '—';
  const ch  = fmtPct(usdCache.change24h);
  const vol = fmtUsd(usdCache.volume24h);

  const rocketLine = t.rockets > 0 ? '🚀'.repeat(t.rockets) : '';

  let head;
  if (t.level === 4) {
    head = [
      `🚨🚨🚨 *MEGA WHALE BUY* 🚨🚨🚨`,
      `*CONTAINMENT BREACH · ALL HANDS*`,
      ``,
      `🐋🐋🐋  $CHOGI  🐋🐋🐋`,
      ``,
      `💸 *${fmtNum(buy.monHuman)} MON spent*`,
      `💵 *${fmtUsd(usd)}*`,
      `🧪 *${fmtNum(buy.chogiHuman)} CHOGI* secured`,
    ].join('\n');
  } else if (t.level === 3) {
    head = [
      `🚨🚨 *WHALE BUY · $CHOGI* 🚨🚨`,
      `*CONTAINMENT BREACH*`,
      ``,
      `🐋  scientists deployed  🐋`,
      ``,
      `💸 *${fmtNum(buy.monHuman)} MON spent*`,
      `💵 *${fmtUsd(usd)}*`,
      `🧪 *${fmtNum(buy.chogiHuman)} CHOGI* contained`,
    ].join('\n');
  } else if (t.level === 2) {
    head = [
      `🐋 *BIG BUY · $CHOGI* 🐋`,
      ``,
      `💸 *${fmtNum(buy.monHuman)} MON* spent (${fmtUsd(usd)})`,
      `🧪 *${fmtNum(buy.chogiHuman)} CHOGI* received`,
    ].join('\n');
  } else if (t.level === 1) {
    head = [
      `🚀 *BUY · $CHOGI* 🚀`,
      ``,
      `💸 *${fmtNum(buy.monHuman)} MON* spent (${fmtUsd(usd)})`,
      `🧪 *${fmtNum(buy.chogiHuman)} CHOGI* received`,
    ].join('\n');
  } else {
    head = [
      `🟢 *buy · $CHOGI*`,
      ``,
      `💸 ${fmtNum(buy.monHuman)} MON (${fmtUsd(usd)})`,
      `🧪 ${fmtNum(buy.chogiHuman)} CHOGI received`,
    ].join('\n');
  }

  const lines = [
    head,
    rocketLine,
    ``,
    `💵 Price: \`${priceLine}\``,
    `📊 MC: *${mc}*  ·  24h: *${ch}*`,
    `💱 Vol: ${vol}`,
    `👤 ${short(buy.recipient)}`,
    `🔗 [view tx](${config.explorer}/tx/${buy.txHash})`,
  ];

  return lines.filter(Boolean).join('\n');
}

// ── Burn alert composer ──────────────────────────────────────
function composeBurnMsg(burn) {
  const big = burn.chogiHuman >= 1_000_000;
  const head = big
    ? `🔥🔥 *MAJOR BURN · $CHOGI* 🔥🔥\n\n*${fmtNum(burn.chogiHuman)} CHOGI* destroyed forever`
    : `🔥 *BURN · $CHOGI*\n\n*${fmtNum(burn.chogiHuman)} CHOGI* sent to the void`;

  return [
    head,
    ``,
    `👤 by ${short(burn.from)}`,
    `🔗 [view tx](${config.explorer}/tx/${burn.txHash})`,
    ``,
    `[🔥 Burn yours](${config.burnUrl})`,
  ].join('\n');
}

// ── Send rate limiter (avoid TG flood) ───────────────────────
let lastSendAt = 0;
async function safeSend(text, opts = {}) {
  const now = Date.now();
  const wait = Math.max(0, lastSendAt + TG_MIN_GAP_MS - now);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastSendAt = Date.now();
  try {
    return await bot.telegram.sendMessage(CHAT_ID, text, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      ...opts,
    });
  } catch (e) {
    console.error('[safeSend] err:', e.message);
    // retry once without markdown if parse error
    if (/parse|markdown/i.test(e.message)) {
      try {
        return await bot.telegram.sendMessage(CHAT_ID, text.replace(/[*_`]/g,''), { disable_web_page_preview: true, ...opts });
      } catch (e2) { console.error('[safeSend] retry err:', e2.message); }
    }
  }
}

// Send a video/animation with caption, falling back to text-only if the file is missing
const BUY_VIDEO_PATH = './buy.mp4';
let buyVideoFileId = null;     // cached after first upload — reuse for speed

async function sendBuyAlert(captionText, replyMarkup) {
  const now = Date.now();
  const wait = Math.max(0, lastSendAt + TG_MIN_GAP_MS - now);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastSendAt = Date.now();

  const opts = {
    caption: captionText,
    parse_mode: 'Markdown',
    ...replyMarkup,
  };

  // 1) Reuse cached file_id if we have one (instant, no upload)
  if (buyVideoFileId) {
    try {
      return await bot.telegram.sendVideo(CHAT_ID, buyVideoFileId, opts);
    } catch (e) {
      console.warn('[sendBuyAlert] cached file_id failed, re-uploading:', e.message);
      buyVideoFileId = null;
    }
  }

  // 2) Upload from disk if buy.mp4 exists
  if (fs.existsSync(BUY_VIDEO_PATH)) {
    try {
      const res = await bot.telegram.sendVideo(CHAT_ID, { source: BUY_VIDEO_PATH }, opts);
      // Cache the file_id from response so subsequent sends are instant
      const v = res?.video || res?.animation;
      if (v?.file_id) buyVideoFileId = v.file_id;
      return res;
    } catch (e) {
      console.error('[sendBuyAlert] video send err:', e.message);
      // fall through to text-only
    }
  }

  // 3) Fallback: text-only
  try {
    return await bot.telegram.sendMessage(CHAT_ID, captionText, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      ...replyMarkup,
    });
  } catch (e) {
    console.error('[sendBuyAlert] text fallback err:', e.message);
    if (/parse|markdown/i.test(e.message)) {
      try { return await bot.telegram.sendMessage(CHAT_ID, captionText.replace(/[*_`]/g,''), { disable_web_page_preview: true, ...replyMarkup }); }
      catch (e2) { console.error('[sendBuyAlert] plain retry err:', e2.message); }
    }
  }
}

// ── Buy / burn handlers ──────────────────────────────────────
async function handleBuy(buy) {
  await refreshUsd();
  // CHOGI's USD price × CHOGI received = USD value of the trade
  const usdReal = buy.chogiHuman * (usdCache.priceUsd || 0);

  if (usdReal > 0 && usdReal < MIN_BUY_USD) {
    console.log(`[buy] skipped, $${usdReal.toFixed(2)} < $${MIN_BUY_USD} min`);
    return;
  }

  const msg = composeBuyMsg(buy, usdReal);
  await sendBuyAlert(msg, buyKeyboard);
  console.log(`[buy] alerted · ${buy.chogiHuman.toFixed(0)} CHOGI · ${usdReal.toFixed(2)} USD · ${short(buy.recipient)}`);
}

// ── Burn stats tracker (persists to ./burn_stats.json) ───────
const BURN_STATS_FILE = './burn_stats.json';
function loadBurnStats() {
  try {
    if (!fs.existsSync(BURN_STATS_FILE)) return { total: 0, count: 0, byWallet: {}, recent: [] };
    return JSON.parse(fs.readFileSync(BURN_STATS_FILE, 'utf-8'));
  } catch (e) {
    console.warn('[burnStats] load failed:', e.message);
    return { total: 0, count: 0, byWallet: {}, recent: [] };
  }
}
function saveBurnStats(s) {
  try { fs.writeFileSync(BURN_STATS_FILE, JSON.stringify(s, null, 2)); }
  catch (e) { console.warn('[burnStats] save failed:', e.message); }
}
let burnStats = loadBurnStats();

function recordBurn(burn) {
  const amt = Number(burn.chogiHuman) || 0;
  if (!Number.isFinite(amt) || amt <= 0) return;
  const from = (burn.from || '').toLowerCase();

  // self-heal: if stats got corrupted previously (NaN total), reset before adding
  if (!Number.isFinite(burnStats.total)) {
    console.warn('[burnStats] detected corrupted total, resetting');
    burnStats = { total: 0, count: 0, byWallet: {}, recent: [] };
  }

  burnStats.total = (Number(burnStats.total) || 0) + amt;
  burnStats.count = (Number(burnStats.count) || 0) + 1;
  burnStats.byWallet[from] = (Number(burnStats.byWallet[from]) || 0) + amt;
  burnStats.recent.unshift({ from, amt, tx: burn.txHash, t: Date.now() });
  if (burnStats.recent.length > 200) burnStats.recent = burnStats.recent.slice(0, 200);
  saveBurnStats(burnStats);
}

function burnStatsBlock() {
  const total = burnStats.total || 0;
  const count = burnStats.count || 0;
  const last24h = (burnStats.recent || []).filter(r => Date.now() - r.t < 86400000);
  const burned24h = last24h.reduce((s, r) => s + r.amt, 0);
  const top = Object.entries(burnStats.byWallet || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const topLines = top.map(([w, a], i) => `${i + 1}. ${short(w)} · ${fmtNum(a)} CHOGI`).join('\n') || '(no burns yet)';
  return [
    `🔥 *CHOGI BURN STATS*`,
    ``,
    `🌋 Total burned: *${fmtNum(total)} CHOGI*`,
    `📊 Burn count: *${count}* tx`,
    `⏱ Last 24h: *${fmtNum(burned24h)} CHOGI* across ${last24h.length} burns`,
    ``,
    `*🏆 TOP BURNERS*`,
    topLines,
    ``,
    `[🔥 Burn yours](${config.burnUrl})`,
  ].join('\n');
}

async function handleBurn(burn) {
  // Sanity: refuse weird/zero amounts
  const amt = Number(burn.chogiHuman);
  if (!Number.isFinite(amt) || amt <= 0) {
    console.warn(`[burn] skipped invalid amount: ${burn.chogiHuman} from ${burn.from}`);
    return;
  }
  // Skip pool dust entirely — the Capricorn V3 pool sweeps tiny rounding errors to dead
  // on every swap. These are protocol-level, not user burns. ~9000 wei = effectively 0.
  if ((burn.from || '').toLowerCase() === config.pool.toLowerCase()) {
    return; // silent skip — don't pollute stats, don't log
  }
  // Skip dust amounts (anything under 1 CHOGI is noise from rounding)
  if (amt < 1) {
    return;
  }
  recordBurn({ ...burn, chogiHuman: amt });
  if (amt < MIN_BURN_CHOGI) {
    console.log(`[burn] tracked but skipped alert, ${amt.toFixed(0)} < ${MIN_BURN_CHOGI} min`);
    return;
  }
  const msg = composeBurnMsg({ ...burn, chogiHuman: amt });
  await safeSend(msg);
  console.log(`[burn] alerted · ${amt.toFixed(0)} CHOGI · ${short(burn.from)}`);
}

// ── Slash commands ───────────────────────────────────────────
async function statsBlock() {
  await refreshUsd(true);
  const p = usdCache.priceUsd > 0 ? `$${usdCache.priceUsd.toFixed(8)}` : '—';
  const mc = usdCache.mcUsd > 0 ? fmtUsd(usdCache.mcUsd) : '—';
  const ch = fmtPct(usdCache.change24h);
  const vol = fmtUsd(usdCache.volume24h);
  const liq = fmtUsd(usdCache.liq);
  return [
    `🧪 *$CHOGI · live*`,
    ``,
    `💵 Price: ${p}`,
    `📊 Market Cap: ${mc}`,
    `📈 24h Change: ${ch}`,
    `💱 24h Volume: ${vol}`,
    `💧 Liquidity: ${liq}`,
    ``,
    `[📊 Chart](${config.chartUrl}) · [🟢 Buy](${config.buyUrl}) · [🔥 Burn](${config.burnUrl})`,
  ].join('\n');
}

bot.command('start', (ctx) => ctx.reply(
  `🧪 I'm Chogi · Experiment 7777.\nLoose on Monad. Run by the people now.\n\nTry: /price /stats /burn /buy /chart /lab /site /help`
));

bot.command('help', (ctx) => ctx.reply(
`🧪 *$CHOGI commands*\n
/price — quick price
/stats — full live stats
/mc — market cap
/burn — burn page
/burnstats — total burned + top burners
/buy — buy link
/chart — DexScreener
/lab — live lab dashboard
/site — chogi.xyz
/holders — holder count
@chogibot — talk to me`,
  { parse_mode: 'Markdown', disable_web_page_preview: true }
));

bot.command('price', async (ctx) => {
  await refreshUsd(true);
  const p = usdCache.priceUsd > 0 ? `$${usdCache.priceUsd.toFixed(8)}` : '—';
  const ch = fmtPct(usdCache.change24h);
  ctx.reply(`💵 *$CHOGI* ${p} · 24h ${ch}\n[chart](${config.chartUrl})`, { parse_mode: 'Markdown', disable_web_page_preview: true });
});

bot.command('mc', async (ctx) => {
  await refreshUsd(true);
  const mc = usdCache.mcUsd > 0 ? fmtUsd(usdCache.mcUsd) : '—';
  ctx.reply(`📊 *$CHOGI MC*: ${mc}`, { parse_mode: 'Markdown' });
});

bot.command('stats', async (ctx) => {
  ctx.reply(await statsBlock(), { parse_mode: 'Markdown', disable_web_page_preview: true });
});

bot.command('buy',   (ctx) => ctx.reply(`🟢 *Buy $CHOGI*: ${config.buyUrl}`, { parse_mode: 'Markdown', disable_web_page_preview: true }));
bot.command('burn',  (ctx) => ctx.reply(`🔥 *Burn page*: ${config.burnUrl}`, { parse_mode: 'Markdown', disable_web_page_preview: true }));
bot.command('chart', (ctx) => ctx.reply(`📊 *Chart*: ${config.chartUrl}`, { parse_mode: 'Markdown', disable_web_page_preview: true }));
bot.command('lab',   (ctx) => ctx.reply(`🧪 *Lab dashboard*: ${config.labUrl}`, { parse_mode: 'Markdown', disable_web_page_preview: true }));
bot.command('site',  (ctx) => ctx.reply(`🌐 ${config.siteUrl}`, { disable_web_page_preview: true }));

bot.command('holders', async (ctx) => {
  // Best-effort: pull from DexScreener if available, else punt
  await refreshUsd(true);
  ctx.reply(`👥 Holder count varies — check the live count at [chogi.xyz/lab](${config.labUrl})`, { parse_mode: 'Markdown', disable_web_page_preview: true });
});

bot.command('burnstats', async (ctx) => {
  ctx.reply(burnStatsBlock(), { parse_mode: 'Markdown', disable_web_page_preview: true });
});

bot.command('burnreset', async (ctx) => {
  if (!isAdmin(ctx)) return;
  burnStats = { total: 0, count: 0, byWallet: {}, recent: [] };
  saveBurnStats(burnStats);
  ctx.reply('🧹 burn stats reset · backfill from chain on next bot restart will repopulate', { parse_mode: 'Markdown' });
});

// ── Admin commands ──────────────────────────────────────────
bot.command('ai_status', (ctx) => {
  if (!isAdmin(ctx)) return;
  const s = getStats();
  ctx.reply(`🧠 *AI status*\n\nEnabled: ${s.enabled}\nMonth budget: $${s.monthlyBudget}\nSpent: $${s.spent} (${s.pctUsed}%)\nRemaining: $${s.remaining}\nRequests: ${s.requestsThisMonth}\nUser/hr limit: ${s.userHourlyLimit}\nReply cooldown: ${s.replyCooldownSec}s`, { parse_mode: 'Markdown' });
});
bot.command('ai_on',  (ctx) => { if (isAdmin(ctx)) { setAIEnabled(true);  ctx.reply('🧠 AI enabled.'); } });
bot.command('ai_off', (ctx) => { if (isAdmin(ctx)) { setAIEnabled(false); ctx.reply('🧠 AI disabled.'); } });

bot.command('chatid', (ctx) => {
  // Useful for setting up — works in any chat
  ctx.reply(`This chat's ID is: \`${ctx.chat.id}\``, { parse_mode: 'Markdown' });
});

// ── Text handler: reply on @mention or reply-to-bot ──────────
let botUsername = null;
async function whenAddressed(ctx) {
  const msg = ctx.message;
  if (!msg || !msg.text) return false;
  if (msg.reply_to_message?.from?.is_bot &&
      msg.reply_to_message.from.username?.toLowerCase() === (botUsername || '').toLowerCase()) {
    return true;
  }
  if (msg.entities) {
    for (const e of msg.entities) {
      if (e.type === 'mention') {
        const tag = msg.text.slice(e.offset, e.offset + e.length).toLowerCase();
        if (tag === `@${(botUsername || '').toLowerCase()}`) return true;
      }
    }
  }
  return false;
}

bot.on('text', async (ctx) => {
  try {
    const text = ctx.message.text || '';
    if (text.startsWith('/')) return; // slash commands handled separately

    if (!(await whenAddressed(ctx))) return;

    // 1) Try fast canned reply first (free, instant)
    const stripped = text.replace(new RegExp(`@${botUsername}`, 'gi'), '').trim();
    const canned = findReply(stripped);
    if (canned) {
      return ctx.reply(canned, { parse_mode: 'Markdown', disable_web_page_preview: true, reply_parameters: { message_id: ctx.message.message_id } });
    }

    // 2) Fall through to AI (rate-limited, budget-capped)
    await refreshUsd();
    const context = {
      price: usdCache.priceUsd,
      mc: usdCache.mcUsd,
      change24h: usdCache.change24h,
      volume24h: usdCache.volume24h,
    };
    const reply = await ask({
      userText: stripped,
      userId: ctx.from?.id,
      chatId: ctx.chat?.id,
      context,
    });
    if (reply) {
      ctx.reply(reply, { reply_parameters: { message_id: ctx.message.message_id } });
    }
    // if blocked (rate / budget / cooldown), silently ignore
  } catch (e) {
    console.error('[text handler] err:', e?.stack || e?.message);
  }
});

// ── Boot ────────────────────────────────────────────────────
async function boot() {
  console.log('🧪 Chogi buybot booting…');

  const me = await bot.telegram.getMe();
  botUsername = me.username;
  console.log(`Bot: @${botUsername}  ·  chat: ${CHAT_ID}`);

  await refreshUsd(true);
  console.log(`Initial price: $${usdCache.priceUsd.toFixed(8)}  ·  MC: ${fmtUsd(usdCache.mcUsd)}`);

  startDexWatcher({
    onBuy:  handleBuy,
    onBurn: handleBurn,
  });

  bot.launch();
  console.log('✅ Chogi bot live.');

  // graceful shutdown
  process.once('SIGINT',  () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

boot().catch(e => {
  console.error('💥 boot fatal:', e?.stack || e?.message);
  process.exit(1);
});
