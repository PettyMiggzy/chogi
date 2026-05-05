// dexWatcher.js — watches the CHOGI/WMON Capricorn V3 pool for buys
// and the CHOGI ERC20 contract for transfers to the dead address (burns).
//
// Strategy: WebSocket if available (fast), HTTP poll as fallback.
// Persists last-processed block across restarts via dexwatcher_state.json.
//
// Buys: V3 Swap event on the pool. Token0 = WMON, Token1 = CHOGI for our pair.
//   amount0 < 0 means WMON went OUT of pool to user, CHOGI came IN to pool → SELL
//   amount0 > 0 means WMON went IN to pool, CHOGI went OUT to user → BUY
//   recipient = the buyer (or router that forwards to buyer)
//
// Burns: ERC20 Transfer where to == 0x...dead

import { ethers } from 'ethers';
import fs from 'fs';
import { config } from './config.js';

const V3_POOL_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)'
];

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'event Transfer(address indexed from, address indexed to, uint256 value)'
];

const V3_SWAP_TOPIC = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

const STATE_FILE = './dexwatcher_state.json';
const MAX_BACKFILL_BLOCKS = 50000;   // ~7 hours on Monad
const BACKFILL_PAGE_SIZE  = 95;      // public Monad RPC limits to 100/range
const RECENT_TX_CAP       = 200;

const POOL_LOWER  = config.pool.toLowerCase();
const TOKEN_LOWER = config.token.toLowerCase();
const DEAD_LOWER  = config.dead.toLowerCase();

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));
  } catch {}
  return { lastBlock: 0, processedTxs: [] };
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s,null,2)); } catch {}
}

function buildProviderList() {
  const list = [];
  if (process.env.RPC_URL && process.env.RPC_URL.trim()) list.push(process.env.RPC_URL.trim());
  if (process.env.RPC_URL_2 && process.env.RPC_URL_2.trim()) list.push(process.env.RPC_URL_2.trim());
  if (!list.includes(config.rpcHttp)) list.push(config.rpcHttp);
  return list;
}

class FallbackProvider {
  constructor(urls) {
    this.urls = urls;
    this.providers = urls.map(u => new ethers.JsonRpcProvider(u));
    this.activeIdx = 0;
  }
  async _call(method, args) {
    let lastErr;
    for (let attempt = 0; attempt < this.providers.length; attempt++) {
      const idx = (this.activeIdx + attempt) % this.providers.length;
      const p = this.providers[idx];
      try {
        const res = await p[method](...args);
        if (idx !== this.activeIdx) {
          console.log('[rpc] switched active to', this.urls[idx].slice(0,60)+'…');
          this.activeIdx = idx;
        }
        return res;
      } catch (e) {
        lastErr = e;
        console.warn('[rpc] '+this.urls[idx].slice(0,60)+'… failed:', e.message);
      }
    }
    throw lastErr;
  }
  getBlockNumber() { return this._call('getBlockNumber', []); }
  getLogs(f)       { return this._call('getLogs', [f]); }
  getBlock(b)      { return this._call('getBlock', [b]); }
  call(tx)         { return this._call('call', [tx]); }
  send(m, p)       { return this._call('send', [m, p]); }
}

function getHttpProvider() {
  const urls = buildProviderList();
  console.log('[dexWatcher] HTTP providers:', urls.map(u => u.slice(0,60)+'…').join(' | '));
  if (urls.length === 1) return new ethers.JsonRpcProvider(urls[0]);
  return new FallbackProvider(urls);
}
function getWsProvider() {
  const ws = (process.env.WS_RPC || process.env.RPC_WSS || '').trim();
  if (!ws) return null;
  try { return new ethers.WebSocketProvider(ws); } catch { return null; }
}

export function startDexWatcher({ onBuy, onBurn }) {
  let httpProvider = getHttpProvider();
  let wsProvider = getWsProvider();
  let chogiIsToken0 = false;     // CHOGI = token1 in our pool (verified)
  let chogiDecimals = 18;
  let wmonDecimals  = 18;

  const state = loadState();
  const recentTxs = new Set(state.processedTxs || []);

  function rememberTx(hash, kind) {
    const k = `${kind}:${hash.toLowerCase()}`;
    if (recentTxs.has(k)) return false;
    recentTxs.add(k);
    if (recentTxs.size > RECENT_TX_CAP) {
      const arr = [...recentTxs];
      recentTxs.clear();
      arr.slice(-RECENT_TX_CAP).forEach(x => recentTxs.add(x));
    }
    state.processedTxs = [...recentTxs];
    return true;
  }

  async function init() {
    const pool = new ethers.Contract(config.pool, V3_POOL_ABI, httpProvider);
    const t0 = (await pool.token0()).toLowerCase();
    const t1 = (await pool.token1()).toLowerCase();
    chogiIsToken0 = (t0 === TOKEN_LOWER);
    console.log(`[dexWatcher] pool ok · CHOGI is ${chogiIsToken0 ? 'token0' : 'token1'}`);

    try {
      const erc = new ethers.Contract(config.token, ERC20_ABI, httpProvider);
      const dec = await erc.decimals();
      // ethers v6 returns BigInt — coerce to Number so 10**dec works
      chogiDecimals = Number(dec);
      console.log('[dexWatcher] CHOGI decimals:', chogiDecimals);
    } catch (e) {
      console.warn('[dexWatcher] decimals fetch failed, using 18:', e.message);
    }
    if (state.lastBlock === 0) {
      state.lastBlock = await httpProvider.getBlockNumber();
      saveState(state);
    }
  }

  // ── parse V3 swap log into a buy/sell event ───────────────────
  function parseSwapLog(log) {
    try {
      const iface = new ethers.Interface(V3_POOL_ABI);
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      const { sender, recipient, amount0, amount1 } = parsed.args;

      // For our pool: token0 = WMON, token1 = CHOGI
      // BUY = CHOGI out of pool to user = amount1 negative (assuming chogi=token1)
      const a0 = BigInt(amount0.toString());
      const a1 = BigInt(amount1.toString());

      let isBuy = false;
      let chogiAmount = 0n;
      let monAmount   = 0n;

      if (chogiIsToken0) {
        // chogi=token0, wmon=token1
        if (a0 < 0n && a1 > 0n) { isBuy = true; chogiAmount = -a0; monAmount = a1; }
        else if (a0 > 0n && a1 < 0n) { isBuy = false; chogiAmount = a0; monAmount = -a1; }
        else return null;
      } else {
        // chogi=token1, wmon=token0
        if (a1 < 0n && a0 > 0n) { isBuy = true; chogiAmount = -a1; monAmount = a0; }
        else if (a1 > 0n && a0 < 0n) { isBuy = false; chogiAmount = a1; monAmount = -a0; }
        else return null;
      }

      const dec = Number(chogiDecimals) || 18;
      const wDec = Number(wmonDecimals) || 18;
      const chogiH = Number(chogiAmount) / Math.pow(10, dec);
      const monH = Number(monAmount) / Math.pow(10, wDec);
      return {
        isBuy,
        sender: sender.toLowerCase(),
        recipient: recipient.toLowerCase(),
        chogiAmount,
        monAmount,
        chogiHuman: Number.isFinite(chogiH) ? chogiH : 0,
        monHuman:   Number.isFinite(monH)   ? monH   : 0,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
      };
    } catch (e) {
      console.warn('[dexWatcher] parseSwap err:', e.message);
      return null;
    }
  }

  function parseTransferLog(log) {
    try {
      const fromAddr = '0x' + log.topics[1].slice(-40);
      const toAddr   = '0x' + log.topics[2].slice(-40);
      const value    = BigInt(log.data);
      const dec      = Number(chogiDecimals) || 18;
      const human    = Number(value) / Math.pow(10, dec);
      return {
        from: fromAddr.toLowerCase(),
        to:   toAddr.toLowerCase(),
        amount: value,
        chogiHuman: Number.isFinite(human) ? human : 0,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
      };
    } catch (e) {
      console.warn('[dexWatcher] parseTransfer err:', e.message);
      return null;
    }
  }

  // ── handle a swap log ─────────────────────────────────────────
  async function handleSwapLog(log) {
    const parsed = parseSwapLog(log);
    if (!parsed) return;
    if (!parsed.isBuy) return; // skip sells

    if (!rememberTx(log.transactionHash, 'buy')) return;

    try { onBuy && await onBuy(parsed); }
    catch (e) { console.error('[dexWatcher] onBuy err:', e.message); }
    saveState(state);
  }

  async function handleTransferLog(log) {
    const parsed = parseTransferLog(log);
    if (!parsed) return;
    if (parsed.to !== DEAD_LOWER) return;

    if (!rememberTx(log.transactionHash, 'burn')) return;

    try { onBurn && await onBurn(parsed); }
    catch (e) { console.error('[dexWatcher] onBurn err:', e.message); }
    saveState(state);
  }

  // ── backfill missed blocks since last run ─────────────────────
  async function backfill() {
    try {
      const head = await httpProvider.getBlockNumber();
      const fromBlock = Math.max(state.lastBlock + 1, head - MAX_BACKFILL_BLOCKS);
      if (fromBlock > head) return;

      console.log(`[dexWatcher] backfilling ${fromBlock} → ${head}`);

      let cursor = fromBlock;
      while (cursor <= head) {
        const end = Math.min(cursor + BACKFILL_PAGE_SIZE - 1, head);

        // swaps
        try {
          const swapLogs = await httpProvider.getLogs({
            address: config.pool, topics: [V3_SWAP_TOPIC],
            fromBlock: cursor, toBlock: end
          });
          for (const log of swapLogs) await handleSwapLog(log);
        } catch (e) { console.warn('[dexWatcher] swap backfill err:', e.message); }

        // burns
        try {
          const xferLogs = await httpProvider.getLogs({
            address: config.token,
            topics: [TRANSFER_TOPIC, null, ethers.zeroPadValue(config.dead, 32)],
            fromBlock: cursor, toBlock: end
          });
          for (const log of xferLogs) await handleTransferLog(log);
        } catch (e) { console.warn('[dexWatcher] burn backfill err:', e.message); }

        cursor = end + 1;
      }

      state.lastBlock = head;
      saveState(state);
    } catch (e) {
      console.error('[dexWatcher] backfill fatal:', e.message);
    }
  }

  // ── live listener (WS preferred) ──────────────────────────────
  function attachWs() {
    if (!wsProvider) return false;

    try {
      // BUY filter: pool Swap event
      wsProvider.on(
        { address: config.pool, topics: [V3_SWAP_TOPIC] },
        (log) => { handleSwapLog(log); }
      );

      // BURN filter: CHOGI Transfer to dead
      wsProvider.on(
        { address: config.token, topics: [TRANSFER_TOPIC, null, ethers.zeroPadValue(config.dead, 32)] },
        (log) => { handleTransferLog(log); }
      );

      console.log('[dexWatcher] WS live listener attached');
      return true;
    } catch (e) {
      console.warn('[dexWatcher] WS attach failed:', e.message);
      return false;
    }
  }

  // ── HTTP poll fallback ─────────────────────────────────────────
  let pollTimer = null;
  function startHttpPoll() {
    const ms = Number(process.env.POLL_MS || 8000);
    console.log('[dexWatcher] HTTP poll active every', ms, 'ms');
    pollTimer = setInterval(async () => {
      await backfill();
    }, ms);
  }

  // ── boot ───────────────────────────────────────────────────────
  (async () => {
    try {
      await init();
      await backfill();
      const wsOk = attachWs();
      if (!wsOk) startHttpPoll();
    } catch (e) {
      console.error('[dexWatcher] boot fatal:', e.message);
      // still start HTTP poll as last resort
      startHttpPoll();
    }
  })();

  return {
    stop() {
      if (pollTimer) clearInterval(pollTimer);
      try { wsProvider && wsProvider.destroy && wsProvider.destroy(); } catch {}
    }
  };
}
