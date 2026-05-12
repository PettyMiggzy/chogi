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

const RPC_URLS = [
  'https://rpc.monad.xyz',
  'https://monad-mainnet.public.blastapi.io',
];

// ────── ABI Interfaces (only need ERC20 — Monorail handles router calldata) ──────
const tokenIface = new ethers.Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
]);

// ────── Raw RPC fallback ──────
async function rpcCall(method, params){
  let lastErr;
  for (const url of RPC_URLS){
    try{
      const ctrl = new AbortController();
      const t = setTimeout(()=>ctrl.abort(), 10000);
      const r = await fetch(url, {
        method:'POST',
        headers:{'content-type':'application/json'},
        body: JSON.stringify({jsonrpc:'2.0',id:Date.now(),method,params}),
        signal: ctrl.signal
      });
      clearTimeout(t);
      if (!r.ok) throw new Error('http '+r.status);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || 'rpc error');
      return j.result;
    }catch(e){ lastErr = e; }
  }
  throw lastErr || new Error('all RPCs failed');
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
    const r = await fetch(url, {cache:'no-cache'});
    j = await r.json();
  }catch(e){
    throw new Error('Network: cannot reach Monorail');
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
  if (low.includes('insufficient_output_amount') || low.includes('amount_out_min') || low.includes('slippage'))
    return 'Slippage too tight — price moved between quote and execution. Try 3% or 5%.';
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
async function executeBuy({token, amountHuman, slippageBps, account}){
  const q = await quoteRoute({
    from: NATIVE_ZERO,
    to: token,
    amount: amountHuman,
    sender: account,
    slippageBps,
  });
  if (!q.transaction) throw new Error('No transaction returned');
  const sim = await simulateCall(q.transaction.to, q.transaction.data, account, q.transaction.value);
  if (!sim.ok) throw new Error(explainRevert(sim.error));
  const txHash = await sendTx({
    from: account,
    to: q.transaction.to,
    data: q.transaction.data,
    value: q.transaction.value,
  });
  return { txHash, quote: q };
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
async function executeSwap({from, to, amountHuman, slippageBps, account, onApproveStarted, onApproveConfirmed}){
  // Normalize: empty/missing = native MON sentinel
  const fromAddr = (from && from !== NATIVE_ZERO) ? from : NATIVE_ZERO;
  const toAddr   = (to && to !== NATIVE_ZERO)     ? to   : NATIVE_ZERO;
  if (fromAddr.toLowerCase() === toAddr.toLowerCase()){
    throw new Error('From and To tokens are the same.');
  }
  const q = await quoteRoute({
    from: fromAddr, to: toAddr,
    amount: amountHuman, sender: account, slippageBps,
  });
  if (!q.transaction) throw new Error('No transaction returned');

  const isNativeFrom = fromAddr === NATIVE_ZERO;

  // ERC20 swaps require approval to the router. Native MON swaps don't —
  // value rides on the tx itself.
  if (!isNativeFrom){
    const spender = q.transaction.to;
    const amountInWei = BigInt(q.input);
    const current = await tokenAllowance(fromAddr, account, spender);
    if (current < amountInWei){
      if (onApproveStarted) onApproveStarted();
      const approveData = tokenIface.encodeFunctionData('approve', [spender, (2n**256n - 1n)]);
      const simA = await simulateCall(fromAddr, approveData, account, null);
      if (!simA.ok) throw new Error('Approve will fail: ' + explainRevert(simA.error));
      const approveTx = await sendTx({ from: account, to: fromAddr, data: approveData });
      const rec = await waitReceipt(approveTx, 90000);
      if (!rec) throw new Error('Approve tx not confirmed in 90s — try again');
      if (onApproveConfirmed) onApproveConfirmed(approveTx);
    }
  }

  // Simulate the swap before signing — surfaces revert reasons cleanly
  const valueForSim = isNativeFrom ? q.transaction.value : '0x0';
  const sim = await simulateCall(q.transaction.to, q.transaction.data, account, valueForSim);
  if (!sim.ok) throw new Error(explainRevert(sim.error));

  const txHash = await sendTx({
    from: account,
    to: q.transaction.to,
    data: q.transaction.data,
    value: isNativeFrom ? q.transaction.value : '0x0',
  });
  return { txHash, quote: q };
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
