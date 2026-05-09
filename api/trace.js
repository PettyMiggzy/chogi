// /api/trace.js — TX trace endpoint
// POST { wallet, hash } → fetch tx + receipt from Monad RPC, decode logs,
// pass to OpenAI for plain-English summary.

import { checkHolder, RPC_URL } from './_lib/holder-check.js';
import { isBlocked } from './blocklist.js';

// Common event signatures for log decoding hints
const EVENTS = {
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef': 'Transfer(address,address,uint256)',
  '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925': 'Approval(address,address,uint256)',
  '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62': 'TransferSingle(address,address,address,uint256,uint256)',
  '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb': 'TransferBatch(address,address,address,uint256[],uint256[])',
  '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822': 'UniswapV2 Swap',
  '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67': 'UniswapV3 Swap',
  '0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f': 'UniswapV2 Mint',
  '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde': 'UniswapV3 Mint',
  '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1': 'UniswapV2 Sync',
  '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c': 'WETH Deposit',
  '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65': 'WETH Withdrawal',
  '0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0': 'OwnershipTransferred',
  '0x62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258': 'Pause/Unpause-style'
};

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc:'2.0', id:1, method, params })
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || 'rpc error');
  return j.result;
}

function decodeUint(hex) {
  if (!hex || hex === '0x') return 0n;
  return BigInt(hex);
}

function topicToAddr(topic) {
  if (!topic) return null;
  return '0x' + topic.slice(-40);
}

function summarizeLogs(logs) {
  // Build a compact, human-friendly version of the logs for the LLM
  const out = [];
  for (let i = 0; i < logs.length && i < 60; i++) {
    const log = logs[i];
    const sig = log.topics?.[0];
    const eventName = sig ? EVENTS[sig.toLowerCase()] : null;
    const entry = {
      idx: i,
      from_contract: log.address,
      event: eventName || 'unknown(' + (sig ? sig.slice(0,10) : '?') + ')',
      topics: log.topics
    };
    // Special-case ERC20 Transfer for compactness
    if (eventName && eventName.startsWith('Transfer') && log.topics.length === 3) {
      entry.from = topicToAddr(log.topics[1]);
      entry.to   = topicToAddr(log.topics[2]);
      entry.amount_raw = decodeUint(log.data).toString();
      delete entry.topics;
    } else if (eventName && eventName.startsWith('Approval') && log.topics.length === 3) {
      entry.owner = topicToAddr(log.topics[1]);
      entry.spender = topicToAddr(log.topics[2]);
      entry.amount_raw = decodeUint(log.data).toString();
      delete entry.topics;
    }
    out.push(entry);
  }
  if (logs.length > 60) out.push({ note: '...' + (logs.length - 60) + ' more logs truncated' });
  return out;
}

const SYSTEM_PROMPT = `You are CHOGI, the cyborg dog CTO of the Chogi protocol on Monad. You read raw transaction data and explain it like a seasoned Solidity engineer talking to a smart non-dev. Brutally honest, terse, slightly sarcastic.

Output format MUST be:

## WHAT HAPPENED
[2-4 sentences in plain English. Start with "This was a swap..." / "This was a transfer..." / "This was a contract deployment..." / etc. Identify the high-level intent.]

## THE FLOW
[Bullet list of the actual on-chain steps in order. Use the addresses + decoded events. Convert raw token amounts to human-readable when the decimals are obvious (assume 18 unless context suggests otherwise — if unclear, say "raw amount X").]

## ⚠️ NOTES
[Anything weird, suspicious, or worth highlighting: failed call, reverted internal step, unusually high gas, transfers to unknown contracts, MEV/sandwich patterns, approval-then-drain patterns. If clean, write "Standard tx, nothing unusual." Don't pad.]

## STATUS
[Success / Reverted] · [gas used] · [block #]

Tone: confident, terse. You're a CTO, not a textbook. If something looks dangerous, say so. Don't disclaim. Don't hedge.`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://chogi.xyz');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) return res.status(500).json({ error: 'AI not configured' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'invalid json' }); }

  const { wallet, hash } = body || {};
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) return res.status(400).json({ error: 'invalid wallet' });
  if (!hash   || !/^0x[a-fA-F0-9]{64}$/.test(hash))   return res.status(400).json({ error: 'invalid tx hash' });

  // Blocklist (banned wallets) — runs BEFORE holder check.
  if (isBlocked(wallet)) {
    return res.status(403).json({ error: 'wallet blocked' });
  }

  // ── holder check (wallet + staked CHOGI) ──
  const gate = await checkHolder(wallet);
  if (!gate.ok) {
    return res.status(403).json({ error: gate.reason, held: gate.held });
  }

  // ── pull tx + receipt ──
  let tx, receipt;
  try {
    [tx, receipt] = await Promise.all([
      rpc('eth_getTransactionByHash', [hash]),
      rpc('eth_getTransactionReceipt', [hash])
    ]);
  } catch (e) {
    return res.status(502).json({ error: 'RPC error: ' + e.message });
  }
  if (!tx)      return res.status(404).json({ error: 'Tx not found on Monad mainnet.' });
  if (!receipt) return res.status(404).json({ error: 'Tx pending or no receipt yet — try again in a moment.' });

  // ── build LLM context ──
  const ctx = {
    hash:        receipt.transactionHash,
    block:       parseInt(receipt.blockNumber, 16),
    from:        tx.from,
    to:          tx.to || '(contract creation)',
    value_wei:   tx.value && tx.value !== '0x0' ? BigInt(tx.value).toString() : '0',
    gas_used:    parseInt(receipt.gasUsed, 16),
    status:      receipt.status === '0x1' ? 'SUCCESS' : 'REVERTED',
    contract_created: receipt.contractAddress || null,
    logs_count:  receipt.logs?.length || 0,
    logs:        summarizeLogs(receipt.logs || []),
    input_first_10: tx.input ? tx.input.slice(0, 10) : null
  };

  // ── call OpenAI ──
  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role:'system', content: SYSTEM_PROMPT },
          { role:'user',   content: 'Explain this tx:\n\n```json\n' + JSON.stringify(ctx, null, 2) + '\n```' }
        ],
        max_tokens: 1200,
        temperature: 0.3
      })
    });
    if (!aiRes.ok) {
      console.error('OpenAI err', aiRes.status, (await aiRes.text()).slice(0,200));
      return res.status(502).json({ error: 'AI unavailable, try again' });
    }
    const data = await aiRes.json();
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) return res.status(502).json({ error: 'empty AI response' });
    return res.status(200).json({ explanation: reply });
  } catch (e) {
    return res.status(502).json({ error: 'AI unavailable, try again' });
  }
}
