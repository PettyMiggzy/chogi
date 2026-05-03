// aiBrain.js — budget cap + per-user hourly rate limit + reply cooldown.
// Wraps chogiAI for safe production use.
import fs from 'fs';
import { chogiTextReply } from './chogiAI.js';

const BUDGET_FILE = './ai_budget.json';
const RATELIMIT_FILE = './ai_ratelimit.json';

// gpt-4o-mini pricing: $0.15/M input, $0.60/M output
const COST_PER_INPUT_TOKEN  = 0.15 / 1_000_000;
const COST_PER_OUTPUT_TOKEN = 0.60 / 1_000_000;

const MONTHLY_BUDGET = Number(process.env.AI_MONTHLY_BUDGET_USD || 15);
const USER_HOURLY    = Number(process.env.AI_USER_HOURLY_LIMIT  || 6);
const REPLY_COOLDOWN = Number(process.env.TG_REPLY_COOLDOWN_SEC || 8);

// in-memory state
let enabled = true;
let lastReplyAtChat = new Map();   // chatId → ts

function loadJson(path, fallback) {
  try { if (fs.existsSync(path)) return JSON.parse(fs.readFileSync(path,'utf8')); } catch {}
  return fallback;
}
function saveJson(path, data) {
  try { fs.writeFileSync(path, JSON.stringify(data,null,2)); } catch (e) { console.warn('save', path, e.message); }
}

function monthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
}

function getBudget() {
  const b = loadJson(BUDGET_FILE, { month: monthKey(), spentUsd: 0, requests: 0 });
  if (b.month !== monthKey()) { b.month = monthKey(); b.spentUsd = 0; b.requests = 0; }
  return b;
}
function bumpBudget(usd) {
  const b = getBudget();
  b.spentUsd += usd;
  b.requests += 1;
  saveJson(BUDGET_FILE, b);
  return b;
}

function checkUserRate(userId) {
  const r = loadJson(RATELIMIT_FILE, {});
  const now = Date.now();
  const hourAgo = now - 60*60*1000;
  const arr = (r[userId] || []).filter(ts => ts > hourAgo);
  if (arr.length >= USER_HOURLY) return false;
  arr.push(now);
  r[userId] = arr;
  // GC: drop user keys empty / cap entries
  for (const k of Object.keys(r)) {
    r[k] = (r[k] || []).filter(ts => ts > hourAgo);
    if (r[k].length === 0) delete r[k];
  }
  saveJson(RATELIMIT_FILE, r);
  return true;
}

function checkChatCooldown(chatId) {
  const last = lastReplyAtChat.get(chatId) || 0;
  const elapsed = (Date.now() - last) / 1000;
  if (elapsed < REPLY_COOLDOWN) return false;
  lastReplyAtChat.set(chatId, Date.now());
  return true;
}

export function setAIEnabled(v) { enabled = !!v; }
export function isAIEnabled() { return enabled; }

export function getStats() {
  const b = getBudget();
  return {
    enabled,
    monthlyBudget: MONTHLY_BUDGET,
    spent: Number(b.spentUsd.toFixed(4)),
    remaining: Number((MONTHLY_BUDGET - b.spentUsd).toFixed(4)),
    requestsThisMonth: b.requests,
    pctUsed: Number(((b.spentUsd / MONTHLY_BUDGET) * 100).toFixed(1)),
    userHourlyLimit: USER_HOURLY,
    replyCooldownSec: REPLY_COOLDOWN,
  };
}

/**
 * Ask Chogi to reply.
 * Returns null if blocked (disabled / budget / rate / cooldown).
 */
export async function ask({ userText, userId, chatId, context = {} }) {
  if (!enabled) return null;

  const b = getBudget();
  if (b.spentUsd >= MONTHLY_BUDGET) {
    console.warn('[aiBrain] monthly budget exceeded:', b.spentUsd, '/', MONTHLY_BUDGET);
    return null;
  }
  if (userId && !checkUserRate(String(userId))) {
    return null; // user hit hourly limit, silent fail
  }
  if (chatId && !checkChatCooldown(String(chatId))) {
    return null; // chat cooldown still active
  }

  try {
    const reply = await chogiTextReply(userText, context);
    // Estimate token usage (no usage object returned by OpenAI in this path,
    // so estimate from char count: ~4 chars per token)
    const inTokens = Math.ceil((userText.length + JSON.stringify(context).length + 1200) / 4);
    const outTokens = Math.ceil(reply.length / 4);
    const cost = inTokens * COST_PER_INPUT_TOKEN + outTokens * COST_PER_OUTPUT_TOKEN;
    bumpBudget(cost);
    return reply || null;
  } catch (e) {
    console.error('[aiBrain] err:', e.message);
    return null;
  }
}
