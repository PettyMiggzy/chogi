/* ════════════════════════════════════════════════════════════
   CHOGI HUB — Universal Monad Swap Engine
   Powered by Monorail aggregator (pathfinder.monorail.xyz/v4)
   - One API call returns ready-to-broadcast transaction
   - Routes across Kuru, Crystal, Clober, Capricorn, Octoswap,
     Atlantis, IziSwap, LFJ, Uniswap V3, and others
   - Works for ANY token on Monad — no protocol-specific code
   - Native MON via 0x0 sentinel address
   - Free, no auth/API key needed, fully CORS-open
   Requires: ethers.js v6 UMD loaded before this script
   ════════════════════════════════════════════════════════════ */
(function(){
'use strict';

if (!window.ethers) { console.error('hub-trade.js requires ethers v6 UMD'); return; }

// ────── Constants ──────
const CHAIN_ID    = 143;
const CHAIN_HEX   = '0x8f';
const NATIVE_ZERO = '0x0000000000000000000000000000000000000000';
const EXPLORER    = 'https://monadexplorer.com';

const MONORAIL = {
  QUOTE:  'https://pathfinder.monorail.xyz/v4/quote',
  TOKENS: 'https://api.monorail.xyz/v2/tokens',
  // Chogi's registered App ID — 1% fee, 100% to treasury (0x4601...).
  // Earns CHOGI / output-token on every swap through the hub.
  APP_ID: '1176408161625',
};

const RPC_URLS = (typeof window !== 'undefined' && window.location && /chogi\.xyz$/i.test(window.location.hostname))
  ? ['/api/rpc', 'https://rpc.monad.xyz']
  : ['https://rpc.monad.xyz'];

// ────── ABI Interfaces (only need ERC20 — Monorail handles router calldata) ──────
const tokenIface = new ethers.Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
]);

// Try ALL RPC URLs in parallel via Promise.any. Resilient to ad-blockers
// blocking one URL, Vercel function cold starts, and regional flakiness.
// First valid response wins; only fails if every URL fails.
async function rpcCall(method, params){
  const body = JSON.stringify({jsonrpc:'2.0', id:Date.now(), method, params});
  const errors = [];
  const tries = RPC_URLS.map(url => new Promise(async (resolve, reject) => {
    try{
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(url, {
        method: 'POST',
        headers: {'content-type':'application/json'},
        body,
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!r.ok){ errors.push(url + ' http ' + r.status); return reject(); }
      const j = await r.json();
      if (j.error){ errors.push(url + ' rpc ' + (j.error.message || '?')); return reject(); }
      resolve(j.result);
    }catch(e){
      errors.push(url + ' ' + (e && e.message ? e.message : String(e)));
      reject();
    }
  }));
  try{
    return await Promise.any(tries);
  }catch(e){
    throw new Error('RPC unreachable: ' + errors.join(' | '));
  }
}
async function ethCall(to, data){ return rpcCall('eth_call', [{to, data}, 'latest']); }

// ────── nad.fun LENS fallback (for pre-grad bonding-curve tokens) ──────
const NADFUN_LENS = '0x7e78A8DE94f21804F7a17F4E8BF9EC2c872187ea';
const lensIface = new ethers.Interface([
  'function getAmountOut(address _token, uint256 _amountIn, bool _isBuy) view returns (address router, uint256 amountOut)',
  'function isGraduated(address _token) view returns (bool)',
]);
const nadRouterIface = new ethers.Interface([
  'function buy((uint256 amountOutMin,address token,address to,uint256 deadline) params) payable returns (uint256)',
  'function sell((uint256 amountIn,uint256 amountOutMin,address token,address to,uint256 deadline) params) returns (uint256)',
]);

function parseUnitsBig(numStr, decimals){
  const s = String(numStr).trim();
  const [w='0', f=''] = s.split('.');
  const fPad = (f + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(w) * (10n**BigInt(decimals)) + BigInt(fPad || 0);
}

async function nadfunQuote(token, amountWei, isBuy){
  const data = lensIface.encodeFunctionData('getAmountOut', [token, amountWei, isBuy]);
  const res = await ethCall(NADFUN_LENS, data);
  if (!res || res === '0x') throw new Error('nad.fun: token not indexed');
  const [router, amount] = lensIface.decodeFunctionResult('getAmountOut', res);
  if (!amount || amount === 0n) throw new Error('nad.fun: zero output');
  return { router, amount };
}

// ────── Monorail quote ──────
async function monorailQuote({from, to, amount, sender, slippageBps, deadlineSec}){
  // amount = HUMAN-READABLE decimal string (e.g. "1.5") — Monorail handles wei conversion
  const params = new URLSearchParams({
    from: from || NATIVE_ZERO,
    to,
    amount: String(amount),
    sender,
    slippage: String(slippageBps || 100),  // bps where 100 = 1%
    source: MONORAIL.APP_ID,                // chogi App ID → 1% fee → treasury
  });
  if (deadlineSec) params.set('deadline', String(deadlineSec));
  const url = `${MONORAIL.QUOTE}?${params.toString()}`;
  let j;
  try{
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const r = await fetch(url, {cache:'no-cache', signal: ctrl.signal});
    clearTimeout(t);
    if (!r.ok) throw new Error('Monorail HTTP ' + r.status);
    j = await r.json();
  }catch(e){
    if (e && e.name === 'AbortError') throw new Error('Monorail quote timed out — slow network');
    throw new Error('Monorail unreachable: ' + (e && e.message ? e.message : 'network error'));
  }
  if (j.message && !j.transaction){
    throw new Error(j.message);  // e.g. "no valid routes found"
  }
  return j;
}

// ────── ROUTE PICKER — Monorail primary, nad.fun LENS fallback ──────
// nad.fun LENS handles pre-grad bonding-curve tokens that Monorail can't see yet.
// Monorail handles everything else (universal: Capricorn, Kuru, Crystal, etc).
async function quoteRoute({from, to, amount, sender, slippageBps}){
  // First: Monorail (covers graduated tokens + cross-DEX aggregation)
  try{
    const q = await monorailQuote({from, to, amount, sender, slippageBps});
    q._source = 'monorail';
    return q;
  }catch(monoErr){
    // Fallback: nad.fun LENS for pre-grad curve tokens
    const isBuy = (from === NATIVE_ZERO || !from);
    const tokenAddr = isBuy ? to : from;
    const amountWei = parseUnitsBig(amount, 18);
    let lensQ;
    try{
      lensQ = await nadfunQuote(tokenAddr, amountWei, isBuy);
    }catch(nadErr){
      throw monoErr;  // surface Monorail's error (usually more informative)
    }
    // Synthesize a Monorail-shaped response so callers don't need to branch
    const minOut = lensQ.amount - (lensQ.amount * BigInt(slippageBps || 100)) / 10000n;
    const deadline = BigInt(Math.floor(Date.now()/1000) + 1200);
    const data = isBuy
      ? nadRouterIface.encodeFunctionData('buy',  [{amountOutMin: minOut, token: tokenAddr, to: sender, deadline}])
      : nadRouterIface.encodeFunctionData('sell', [{amountIn: amountWei, amountOutMin: minOut, token: tokenAddr, to: sender, deadline}]);
    return {
      _source: 'nadfun',
      input: amountWei.toString(),
      input_formatted: String(amount),
      output: lensQ.amount.toString(),
      output_formatted: ethers.formatUnits(lensQ.amount, 18),
      min_output: minOut.toString(),
      min_output_formatted: ethers.formatUnits(minOut, 18),
      compound_impact: '0',  // LENS doesn't surface impact data
      gas_estimate: 250000,
      routes: [[{
        from_symbol: isBuy ? 'MON' : 'TOKEN',
        to_symbol:   isBuy ? 'TOKEN' : 'MON',
        splits: [{ protocol: 'nad.fun', fee: '1.000', percentage: '100', price_impact: '0' }]
      }]],
      transaction: {
        to: lensQ.router,
        data: data,
        value: isBuy ? '0x' + amountWei.toString(16) : '0x0',
      },
    };
  }
}

// ────── Token reads ──────
async function tokenBalance(token, owner){
  const data = tokenIface.encodeFunctionData('balanceOf', [owner]);
  const res = await ethCall(token, data);
  const [bal] = tokenIface.decodeFunctionResult('balanceOf', res);
  return bal;
}
async function tokenAllowance(token, owner, spender){
  const data = tokenIface.encodeFunctionData('allowance', [owner, spender]);
  const res = await ethCall(token, data);
  const [a] = tokenIface.decodeFunctionResult('allowance', res);
  return a;
}
async function nativeBalance(owner){
  const hex = await rpcCall('eth_getBalance', [owner, 'latest']);
  return BigInt(hex);
}
async function tokenInfo(token){
  const calls = [
    tokenIface.encodeFunctionData('symbol', []),
    tokenIface.encodeFunctionData('name', []),
    tokenIface.encodeFunctionData('decimals', []),
  ];
  const out = {};
  try{
    const [sR, nR, dR] = await Promise.all(calls.map(d => ethCall(token, d)));
    out.symbol   = tokenIface.decodeFunctionResult('symbol',  sR)[0];
    out.name     = tokenIface.decodeFunctionResult('name',    nR)[0];
    out.decimals = Number(tokenIface.decodeFunctionResult('decimals', dR)[0]);
  }catch(e){
    out.symbol = '?'; out.name = '?'; out.decimals = 18;
  }
  return out;
}

// ────── Wallet connect ──────
async function ensureMonadChain(){
  try{
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{chainId: CHAIN_HEX}],
    });
  }catch(e){
    if (e && e.code === 4902){
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: CHAIN_HEX,
          chainName: 'Monad Mainnet',
          nativeCurrency: {name:'Monad', symbol:'MON', decimals:18},
          rpcUrls: ['https://rpc.monad.xyz'],
          blockExplorerUrls: [EXPLORER],
        }],
      });
    } else throw e;
  }
}
async function connect(){
  if (!window.ethereum){
    throw new Error('No wallet detected. Open this page inside MetaMask, Rabby, Phantom, or Trust Wallet.');
  }
  const accounts = await window.ethereum.request({method:'eth_requestAccounts'});
  await ensureMonadChain();
  return accounts[0];
}
function isConnected(){ return !!(window.ethereum && window.ethereum.selectedAddress); }

// ────── Tx sending ──────
async function sendTx(params){
  return window.ethereum.request({method:'eth_sendTransaction', params:[params]});
}
async function waitReceipt(hash, maxMs=90000){
  const start = Date.now();
  while (Date.now() - start < maxMs){
    try{
      const r = await rpcCall('eth_getTransactionReceipt', [hash]);
      if (r && r.blockNumber) return r;
    }catch(e){}
    await new Promise(r=>setTimeout(r, 1500));
  }
  return null;
}

// ────── Pre-flight simulation ──────
async function simulateCall(to, data, fromAccount, value){
  // value can be hex string (from Monorail) OR bigint
  const isHex = typeof value === 'string';
  const valueBig = isHex ? BigInt(value) : (value || 0n);
  const overrideBalance = valueBig > 0n ? (valueBig * 4n) + 10n**18n : 10n**18n;
  const call = { from: fromAccount, to, data };
  if (valueBig > 0n) call.value = isHex ? value : '0x'+valueBig.toString(16);
  const params = [
    call,
    'latest',
    { [fromAccount]: { balance: '0x'+overrideBalance.toString(16) } }
  ];
  try{
    await rpcCall('eth_call', params);
    return { ok: true };
  }catch(e){
    return { ok: false, error: e };
  }
}

function explainRevert(err){
  const m = (err && (err.message || err.shortMessage || String(err))) || '';
  const low = m.toLowerCase();
  if (low.includes('no valid routes'))
    return 'No swap route found. Token may have zero liquidity or not be indexed on any Monad DEX.';
  if (low.includes('swap amount is required'))
    return 'Enter an amount to swap.';
  if (low.includes('insufficient balance') || low.includes('insufficient funds'))
    return 'Not enough balance in your wallet to cover this trade + gas.';
  // Match ONLY real on-chain output-amount reverts. The bare word
  // 'slippage' previously matched Monorail's own quote-side errors
  // ('slippage out of range' etc) and masked the real cause.
  if (low.includes('insufficient_output_amount') || low.includes('amount_out_min'))
    return 'Slippage too tight — price moved between quote and execution. Try 5% or 10%.';
  if (low.includes('expired') || low.includes('deadline'))
    return 'Tx deadline passed. Retry the trade.';
  if (low.includes('transfer_failed') || low.includes('transfer failed'))
    return 'Token transfer blocked. Token may have transfer restrictions.';
  if (low.includes('user denied') || low.includes('user rejected'))
    return 'Wallet signature cancelled.';
  if (low.includes('execution reverted') && !low.includes('reason'))
    return 'Trade simulation failed (no reason). Try a smaller amount or larger slippage.';
  return m || 'Unknown error';
}

// ────── BUY (native MON → token) ──────
// Delegates to executeSwap so the auto-wrap fallback for thin-pool tokens
// (MONI, MOYAKI, etc.) kicks in transparently.
async function executeBuy({token, amountHuman, slippageBps, account, onApproveStarted, onApproveConfirmed}){
  return executeSwap({
    from: NATIVE_ZERO, to: token,
    amountHuman, slippageBps, account,
    onApproveStarted, onApproveConfirmed,
  });
}

// ────── SELL (token → native MON) ──────
async function executeSell({token, amountHuman, slippageBps, account, onApproveStarted, onApproveConfirmed}){
  return executeSwap({
    from: token, to: NATIVE_ZERO,
    amountHuman, slippageBps, account, onApproveStarted, onApproveConfirmed
  });
}

// ────── ANY-TO-ANY SWAP ──────
// Handles all four cases: MON→token, token→MON, token→token (Monorail
// auto-routes via WMON or whichever intermediary it picks), and is the
// real workhorse — executeBuy/executeSell are thin wrappers.
const WMON_ADDRESS_INTERNAL = '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A';

async function executeSwap({from, to, amountHuman, slippageBps, account, onApproveStarted, onApproveConfirmed}){
  // Normalize: empty/missing = native MON sentinel
  const fromAddr = (from && from !== NATIVE_ZERO) ? from : NATIVE_ZERO;
  const toAddr   = (to && to !== NATIVE_ZERO)     ? to   : NATIVE_ZERO;
  if (fromAddr.toLowerCase() === toAddr.toLowerCase()){
    throw new Error('From and To tokens are the same.');
  }

  // Quote what Monorail picks natively first
  let q = await quoteRoute({
    from: fromAddr, to: toAddr,
    amount: amountHuman, sender: account, slippageBps,
  });
  console.log('[chogi-swap] initial quote', { hops: q.routes?.[0]?.length, protocols: q.routes?.[0]?.map(s=>s.splits?.[0]?.protocol) });

  let usedSrc = fromAddr;
  let usedDst = toAddr;
  let didWrap = false;
  let needsUnwrap = false;
  const baseHops = (q.routes?.[0]?.length) ?? 1;

  // FORWARD auto-rewrite: MON → thin-pool token, multi-hop → use WMON path
  if (fromAddr === NATIVE_ZERO && baseHops >= 2){
    try {
      const alt = await quoteRoute({
        from: WMON_ADDRESS_INTERNAL, to: toAddr,
        amount: amountHuman, sender: account, slippageBps,
      });
      const altHops = alt.routes?.[0]?.length ?? 99;
      if (altHops < baseHops){
        console.log('[chogi-swap] using WMON forward route', { hops: altHops });
        q = alt; usedSrc = WMON_ADDRESS_INTERNAL; didWrap = true;
      }
    } catch(e){ console.warn('[chogi-swap] forward WMON quote failed', e); }
  }

  // REVERSE auto-rewrite: thin-pool token → MON, multi-hop → use WMON path + unwrap
  if (toAddr === NATIVE_ZERO && baseHops >= 2){
    try {
      const alt = await quoteRoute({
        from: fromAddr, to: WMON_ADDRESS_INTERNAL,
        amount: amountHuman, sender: account, slippageBps,
      });
      const altHops = alt.routes?.[0]?.length ?? 99;
      if (altHops < baseHops){
        console.log('[chogi-swap] using WMON reverse route + unwrap', { hops: altHops });
        q = alt; usedDst = WMON_ADDRESS_INTERNAL; needsUnwrap = true;
      }
    } catch(e){ console.warn('[chogi-swap] reverse WMON quote failed', e); }
  }

  if (!q.transaction) throw new Error('No transaction returned');

  const isNativeFrom = usedSrc === NATIVE_ZERO;

  // PRE-STEP (silent): if forward path was rewritten to WMON, wrap MON first
  if (didWrap){
    const amountWei = parseUnitsBig(amountHuman, 18);
    if (onApproveStarted) onApproveStarted();
    const wrapTx = await sendTx({
      from: account, to: WMON_ADDRESS_INTERNAL,
      data: '0xd0e30db0', value: '0x' + amountWei.toString(16),
      gas: '0x13880',
    });
    const wrapRec = await waitReceipt(wrapTx, 90000);
    if (!wrapRec) throw new Error('First step not confirmed in 90s — try again');
    if (onApproveConfirmed) onApproveConfirmed(wrapTx);
  }

  // ERC20 swaps require approval to the router. Native MON swaps don't —
  // value rides on the tx itself.
  if (!isNativeFrom){
    const spender = q.transaction.to;
    const amountInWei = BigInt(q.input);
    const current = await tokenAllowance(usedSrc, account, spender);
    if (current < amountInWei){
      if (onApproveStarted) onApproveStarted();
      // Exact-amount approval (not MaxUint256) — unlimited approvals trigger MetaMask/Blockaid spending-cap warnings.
      const approveData = tokenIface.encodeFunctionData('approve', [spender, amountInWei]);
      const simA = await simulateCall(usedSrc, approveData, account, null);
      if (!simA.ok){ console.error('[chogi-swap] approve sim failed', simA.error); throw new Error('Approve will fail: ' + explainRevert(simA.error)); }
      const approveTx = await sendTx({ from: account, to: usedSrc, data: approveData });
      const rec = await waitReceipt(approveTx, 90000);
      if (!rec) throw new Error('Approve tx not confirmed in 90s — try again');
      if (onApproveConfirmed) onApproveConfirmed(approveTx);
    }
  }

  // Simulate the swap before signing — surfaces revert reasons cleanly
  const valueForSim = isNativeFrom ? q.transaction.value : '0x0';
  const sim = await simulateCall(q.transaction.to, q.transaction.data, account, valueForSim);
  if (!sim.ok){ console.error('[chogi-swap] main sim failed', sim.error); throw new Error(explainRevert(sim.error)); }

  const txHash = await sendTx({
    from: account,
    to: q.transaction.to,
    data: q.transaction.data,
    value: isNativeFrom ? q.transaction.value : '0x0',
  });

  // POST-STEP (silent): if reverse path was rewritten to WMON, unwrap to MON
  if (needsUnwrap){
    const swapRec = await waitReceipt(txHash, 120000);
    if (swapRec){
      try{
        const wmonBal = await rpcCall('eth_call', [{
          to: WMON_ADDRESS_INTERNAL,
          data: tokenIface.encodeFunctionData('balanceOf', [account]),
        }, 'latest']);
        const wmonBalBig = BigInt(wmonBal);
        if (wmonBalBig > 0n){
          const withdrawData = '0x2e1a7d4d' + wmonBalBig.toString(16).padStart(64, '0');
          await sendTx({
            from: account, to: WMON_ADDRESS_INTERNAL,
            data: withdrawData, gas: '0x13880',
          });
        }
      }catch(e){ console.warn('[chogi-swap] auto-unwrap WMON failed (user has WMON, can unwrap manually)', e); }
    }
  }

  return { txHash, quote: q, viaWrap: didWrap, viaUnwrap: needsUnwrap };
}

// ────── Token search (Monorail catalog) ──────
async function searchTokens(query){
  const url = `${MONORAIL.TOKENS}?find=${encodeURIComponent(query)}`;
  try{
    const r = await fetch(url);
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  }catch(e){ return []; }
}

window.ChogiTrade = {
  CHAIN_ID, CHAIN_HEX, EXPLORER, NATIVE_ZERO, MONORAIL,
  monorailQuote, quoteRoute, nadfunQuote, searchTokens,
  connect, isConnected, ensureMonadChain,
  tokenBalance, tokenAllowance, nativeBalance, tokenInfo,
  executeBuy, executeSell, executeSwap, waitReceipt,
  rpcCall, ethCall, explainRevert,
};

})();
