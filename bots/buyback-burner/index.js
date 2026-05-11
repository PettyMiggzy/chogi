#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   CHOGI BUYBACK BURNER — Monorail-powered auto-flywheel bot
   ----------------------------------------------------------------------
   Polls treasury wallet (Monorail fee recipient) every TICK_MS.
   For each non-MON, non-CHOGI token in the wallet > DUST_USD_FLOOR,
     swaps it to MON via Monorail aggregator.
   Then converts excess MON (above OPS_RESERVE_MON) into CHOGI,
   and sends ALL CHOGI in the wallet to the dead address.

   Default mode: DRY_RUN — logs what it WOULD do, signs nothing.
   Set ARMED=true in .env to enable live execution.

   Author: built for King Petty's Chogi Trader HUB (May 2026)
   ════════════════════════════════════════════════════════════════════ */
import 'dotenv/config';
import { ethers, JsonRpcProvider, Wallet, Interface, formatUnits, parseUnits } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';

// ────── Constants ──────
const NATIVE  = '0x0000000000000000000000000000000000000000';
const DEAD    = '0x000000000000000000000000000000000000dEaD';
const CHOGI   = '0x5E1b1A14c8758104B8560514e94ab8320e587777';
const WMON    = '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A';
const APP_ID  = '1176408161625';

const MONORAIL_QUOTE  = 'https://pathfinder.monorail.xyz/v4/quote';
const MONORAIL_WALLET = 'https://api.monorail.xyz/v2/wallet';

// ────── Env config ──────
const cfg = {
  rpcUrls: (process.env.RPC_URLS || 'https://rpc.monad.xyz,https://monad-mainnet.public.blastapi.io').split(','),
  treasuryAddr: process.env.TREASURY_ADDR || '0x4601a7f665ca13c40d2236b8b9ff1e4b87226351',
  privateKey: process.env.PRIVATE_KEY || '',
  armed: String(process.env.ARMED || 'false').toLowerCase() === 'true',
  tickMs: parseInt(process.env.TICK_MS || '600000'),          // 10 min
  opsReserveMon: parseFloat(process.env.OPS_RESERVE_MON || '50'),  // keep 50 MON for ops
  burnThresholdMon: parseFloat(process.env.BURN_THRESHOLD_MON || '5'), // min 5 MON over reserve to fire
  dustUsdFloor: parseFloat(process.env.DUST_USD_FLOOR || '1'), // don't sweep fee tokens worth < $1
  slippageBps: parseInt(process.env.SLIPPAGE_BPS || '300'),    // 3% — bot tolerates more slip
  statsPath: process.env.STATS_PATH || './burn-stats.json',
  logPath: process.env.LOG_PATH || './burn-log.jsonl',
};

// ────── State ──────
const erc20Iface = new Interface([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

function makeProvider(){
  return new JsonRpcProvider(cfg.rpcUrls[0]);
}

// Simple log helpers
function log(msg, data){
  const line = JSON.stringify({ ts: new Date().toISOString(), msg, ...data }) + '\n';
  fs.appendFileSync(cfg.logPath, line);
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`, data || '');
}

function loadStats(){
  try { return JSON.parse(fs.readFileSync(cfg.statsPath, 'utf8')); }
  catch { return { lifetime_burned_chogi: '0', total_burns: 0, last_burn_ts: null, last_burn_tx: null }; }
}
function saveStats(s){
  fs.writeFileSync(cfg.statsPath, JSON.stringify(s, null, 2));
}

// ────── Monorail API ──────
async function fetchTreasuryBalances(addr){
  const url = `${MONORAIL_WALLET}/${addr}/balances`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`balances HTTP ${r.status}`);
  return r.json();
}

async function monorailQuote({ from, to, amount, sender, slippageBps }){
  const params = new URLSearchParams({
    from, to, amount: String(amount), sender,
    slippage: String(slippageBps),
    source: APP_ID,
    deadline: '300',
  });
  const r = await fetch(`${MONORAIL_QUOTE}?${params}`);
  const j = await r.json();
  if (j.message && !j.transaction){
    throw new Error(`Monorail: ${j.message}`);
  }
  return j;
}

// ────── Swap execution ──────
async function executeSwap(wallet, quote){
  if (!cfg.armed){
    log('DRY_RUN swap (would execute)', {
      from: quote.from?.symbol || '?',
      to: quote.to?.symbol || '?',
      input: quote.input_formatted,
      output: quote.output_formatted,
      route: quote.routes?.[0]?.[0]?.splits?.[0]?.protocol,
    });
    return null;
  }
  const tx = quote.transaction;
  const txParams = {
    to: tx.to,
    data: tx.data,
    value: tx.value || '0x0',
    gasLimit: BigInt(tx.gas_estimate || 500000),
  };
  const sent = await wallet.sendTransaction(txParams);
  log('swap sent', { hash: sent.hash, input: quote.input_formatted, output: quote.output_formatted });
  const rec = await sent.wait();
  if (rec.status !== 1) throw new Error(`swap reverted: ${sent.hash}`);
  log('swap mined', { hash: sent.hash, gas_used: rec.gasUsed.toString() });
  return sent.hash;
}

async function transferToken(wallet, tokenAddr, to, amount){
  if (!cfg.armed){
    log('DRY_RUN transfer (would execute)', { tokenAddr, to, amount: amount.toString() });
    return null;
  }
  const data = erc20Iface.encodeFunctionData('transfer', [to, amount]);
  const sent = await wallet.sendTransaction({ to: tokenAddr, data });
  const rec = await sent.wait();
  if (rec.status !== 1) throw new Error(`transfer reverted: ${sent.hash}`);
  log('transfer mined', { hash: sent.hash, token: tokenAddr, to, amount: amount.toString() });
  return sent.hash;
}

// ────── Main tick ──────
async function tick(){
  log('tick start', { armed: cfg.armed, treasury: cfg.treasuryAddr });

  let wallet = null;
  if (cfg.armed){
    if (!cfg.privateKey) throw new Error('ARMED=true but PRIVATE_KEY not set');
    wallet = new Wallet(cfg.privateKey, makeProvider());
    const onchain = await wallet.getAddress();
    if (onchain.toLowerCase() !== cfg.treasuryAddr.toLowerCase()){
      throw new Error(`PRIVATE_KEY wallet (${onchain}) != TREASURY_ADDR (${cfg.treasuryAddr})`);
    }
  }

  // Step 1: read treasury balances
  let balances;
  try { balances = await fetchTreasuryBalances(cfg.treasuryAddr); }
  catch(e){ log('balances fetch failed', { error: e.message }); return; }

  const wmonOrMon = balances.find(b => b.address.toLowerCase() === NATIVE || b.address.toLowerCase() === WMON.toLowerCase());
  const chogiBal  = balances.find(b => b.address.toLowerCase() === CHOGI.toLowerCase());
  const others    = balances.filter(b => {
    const a = b.address.toLowerCase();
    return a !== NATIVE && a !== WMON.toLowerCase() && a !== CHOGI.toLowerCase()
        && parseFloat(b.balance || 0) > 0
        && parseFloat(b.usd_per_token || 0) * parseFloat(b.balance || 0) >= cfg.dustUsdFloor;
  });

  log('treasury snapshot', {
    mon: wmonOrMon ? wmonOrMon.balance : '0',
    chogi: chogiBal ? chogiBal.balance : '0',
    other_tokens: others.length,
    other_value_usd: others.reduce((s, t) => s + parseFloat(t.usd_per_token||0)*parseFloat(t.balance||0), 0).toFixed(2),
  });

  // Step 2: swap each non-MON, non-CHOGI token → MON
  for (const t of others){
    try{
      const q = await monorailQuote({
        from: t.address, to: NATIVE,
        amount: t.balance,
        sender: cfg.treasuryAddr,
        slippageBps: cfg.slippageBps,
      });
      log(`sweep ${t.symbol} → MON`, { in: q.input_formatted, out: q.output_formatted, route: q.routes?.[0]?.[0]?.splits?.[0]?.protocol });
      if (wallet) await executeSwap(wallet, q);
    }catch(e){ log(`sweep ${t.symbol} failed`, { error: e.message }); }
    await new Promise(r => setTimeout(r, 1500));  // pace between txs
  }

  // Step 3: refresh balances after sweeps (skip in dry-run since no state changed)
  if (cfg.armed && others.length > 0){
    balances = await fetchTreasuryBalances(cfg.treasuryAddr);
  }

  // Step 4: convert excess MON → CHOGI
  const monNow = balances.find(b => b.address.toLowerCase() === NATIVE) ||
                 balances.find(b => b.address.toLowerCase() === WMON.toLowerCase());
  const monFloat = monNow ? parseFloat(monNow.balance || 0) : 0;
  const excessMon = monFloat - cfg.opsReserveMon;

  if (excessMon < cfg.burnThresholdMon){
    log('no burn this tick', { mon_balance: monFloat, ops_reserve: cfg.opsReserveMon, excess: excessMon, threshold: cfg.burnThresholdMon });
  } else {
    try{
      const q = await monorailQuote({
        from: NATIVE, to: CHOGI,
        amount: excessMon.toFixed(6),
        sender: cfg.treasuryAddr,
        slippageBps: cfg.slippageBps,
      });
      log('MON → CHOGI buyback quote', { in: q.input_formatted, out: q.output_formatted, route: q.routes?.[0]?.[0]?.splits?.[0]?.protocol });
      if (wallet) await executeSwap(wallet, q);
    }catch(e){ log('buyback swap failed', { error: e.message }); }
  }

  // Step 5: burn ALL CHOGI in treasury
  if (cfg.armed){
    const prov = makeProvider();
    const data = erc20Iface.encodeFunctionData('balanceOf', [cfg.treasuryAddr]);
    const res = await prov.call({ to: CHOGI, data });
    const balRaw = BigInt(erc20Iface.decodeFunctionResult('balanceOf', res)[0]);
    if (balRaw > 0n){
      const hash = await transferToken(wallet, CHOGI, DEAD, balRaw);
      const stats = loadStats();
      stats.lifetime_burned_chogi = (BigInt(stats.lifetime_burned_chogi || '0') + balRaw).toString();
      stats.total_burns += 1;
      stats.last_burn_ts = Date.now();
      stats.last_burn_tx = hash;
      stats.last_burn_amount_chogi = balRaw.toString();
      saveStats(stats);
      log('🔥 BURNED', { amount: formatUnits(balRaw, 18), tx: hash, lifetime: formatUnits(stats.lifetime_burned_chogi, 18) });
    } else {
      log('no CHOGI to burn this tick', {});
    }
  } else if (chogiBal && parseFloat(chogiBal.balance) > 0){
    log('DRY_RUN would burn', { amount: chogiBal.balance, would_send_to: DEAD });
  }

  log('tick end', {});
}

// ────── Loop ──────
async function main(){
  log('bot starting', {
    armed: cfg.armed,
    mode: cfg.armed ? '🔥 LIVE' : '👁 DRY-RUN',
    treasury: cfg.treasuryAddr,
    tick_min: cfg.tickMs / 60000,
    ops_reserve_mon: cfg.opsReserveMon,
    burn_threshold_mon: cfg.burnThresholdMon,
  });

  // Tick immediately, then on interval
  while (true){
    try { await tick(); }
    catch(e){ log('tick error', { error: e.message, stack: e.stack }); }
    await new Promise(r => setTimeout(r, cfg.tickMs));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
