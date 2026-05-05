// backfill-burns.js — one-time historical scan
// Usage: node backfill-burns.js [days]
//   node backfill-burns.js 7    -> scan last 7 days
//   node backfill-burns.js      -> scan last 3 days (default)
//
// Scans the chain, filters out pool-fee dust, merges results into
// burn_stats.json. Safe to re-run; deduplicates by tx hash.

import 'dotenv/config';
import fs from 'fs';
import { ethers } from 'ethers';
import { config } from './config.js';

const DAYS = Number(process.argv[2] || 3);
const BLOCKS_PER_DAY = 172800; // Monad ~0.5s blocks
const SCAN_BLOCKS = DAYS * BLOCKS_PER_DAY;

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const POOL_LOWER = config.pool.toLowerCase();
const TOKEN = config.token;
const DEAD_PADDED = ethers.zeroPadValue(config.dead, 32);

// Use whichever RPC has the highest range allowance — QuickNode preferred for big scan
const RPC = (process.env.RPC_URL || '').trim() || config.rpcHttp;
console.log(`[backfill] using RPC: ${RPC.slice(0, 60)}…`);
console.log(`[backfill] scanning ${DAYS} days (~${SCAN_BLOCKS.toLocaleString()} blocks)`);

const provider = new ethers.JsonRpcProvider(RPC);

const STATS_FILE = './burn_stats.json';
function loadStats() {
  try {
    if (!fs.existsSync(STATS_FILE)) return { total: 0, count: 0, byWallet: {}, recent: [], seenTx: {} };
    const s = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
    if (!s.seenTx) s.seenTx = {}; // for dedup
    return s;
  } catch (e) {
    console.warn('[backfill] could not load existing stats, starting fresh');
    return { total: 0, count: 0, byWallet: {}, recent: [], seenTx: {} };
  }
}
function saveStats(s) {
  fs.writeFileSync(STATS_FILE, JSON.stringify(s, null, 2));
}

let stats = loadStats();
console.log(`[backfill] existing stats: total=${stats.total.toFixed(0)}, count=${stats.count}`);

let chunkSize = 5000;
const CHUNK_SMALL = 95;
const CHUNK_LARGE = 5000;

async function getLogsAdaptive(fromBlock, toBlock) {
  // try the configured chunk size, shrink on range error
  try {
    return await provider.send('eth_getLogs', [{
      address: TOKEN,
      topics: [TRANSFER_TOPIC, null, DEAD_PADDED],
      fromBlock: '0x' + fromBlock.toString(16),
      toBlock: '0x' + toBlock.toString(16),
    }]);
  } catch (e) {
    if (/range|limit|too many/i.test(e.message) && chunkSize > CHUNK_SMALL) {
      console.log(`[backfill] shrinking chunk: ${chunkSize} -> ${CHUNK_SMALL}`);
      chunkSize = CHUNK_SMALL;
      throw e; // signal caller to retry with smaller chunk
    }
    throw e;
  }
}

async function main() {
  const head = await provider.getBlockNumber();
  const startBlock = Math.max(0, head - SCAN_BLOCKS);
  console.log(`[backfill] head=${head}, scanning ${startBlock} → ${head}`);

  let cursor = startBlock;
  let realBurnCount = 0;
  let dustCount = 0;
  let dupeCount = 0;
  let saveTimer = 0;

  while (cursor <= head) {
    const end = Math.min(cursor + chunkSize - 1, head);
    let logs;
    try {
      logs = await getLogsAdaptive(cursor, end);
    } catch (e) {
      // already shrunk, retry same cursor
      if (chunkSize === CHUNK_SMALL) {
        try { logs = await getLogsAdaptive(cursor, Math.min(cursor + chunkSize - 1, head)); }
        catch (e2) {
          console.warn(`[backfill] chunk ${cursor}-${end} failed twice: ${e2.message}`);
          cursor = end + 1;
          continue;
        }
      } else {
        cursor = end + 1;
        continue;
      }
    }

    for (const log of logs) {
      const txHash = log.transactionHash;
      if (stats.seenTx[txHash]) { dupeCount++; continue; }

      const fromAddr = ('0x' + log.topics[1].slice(-40)).toLowerCase();
      const value = BigInt(log.data);
      const human = Number(value) / 1e18;

      // Skip pool dust + tiny burns
      if (fromAddr === POOL_LOWER) { dustCount++; continue; }
      if (human < 1) { dustCount++; continue; }

      // Real burn — record
      stats.total += human;
      stats.count += 1;
      stats.byWallet[fromAddr] = (stats.byWallet[fromAddr] || 0) + human;
      stats.recent.unshift({ from: fromAddr, amt: human, tx: txHash, t: Date.now() });
      stats.seenTx[txHash] = true;
      realBurnCount++;
    }

    // grow chunk back if it succeeded
    if (chunkSize < CHUNK_LARGE) chunkSize = Math.min(CHUNK_LARGE, chunkSize * 2);

    // periodic save (every 50k blocks)
    saveTimer += (end - cursor + 1);
    if (saveTimer > 50000) {
      // cap recent
      if (stats.recent.length > 200) stats.recent = stats.recent.slice(0, 200);
      saveStats(stats);
      console.log(`[backfill] checkpoint: ${cursor}/${head} · real=${realBurnCount} dust=${dustCount} dupe=${dupeCount}`);
      saveTimer = 0;
    }

    cursor = end + 1;
  }

  // final save
  if (stats.recent.length > 200) stats.recent = stats.recent.slice(0, 200);
  saveStats(stats);

  console.log('');
  console.log('=== BACKFILL COMPLETE ===');
  console.log(`Real burns added: ${realBurnCount}`);
  console.log(`Pool dust skipped: ${dustCount}`);
  console.log(`Dupes skipped: ${dupeCount}`);
  console.log(`New totals: ${stats.total.toFixed(0)} CHOGI across ${stats.count} burns`);
  console.log(`Top wallet: ${Object.entries(stats.byWallet).sort((a,b)=>b[1]-a[1])[0]?.[0]} (${Object.entries(stats.byWallet).sort((a,b)=>b[1]-a[1])[0]?.[1].toFixed(0)} CHOGI)`);
}

main().catch(e => { console.error(e); process.exit(1); });
