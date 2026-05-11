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

// ────── Monorail quote ──────
async function monorailQuote({from, to, amount, sender, slippageBps, deadlineSec}){
  // amount = HUMAN-READABLE decimal string (e.g. "1.5") — Monorail handles wei conversion
  const params = new URLSearchParams({
    from: from || NATIVE_ZERO,
    to,
    amount: String(amount),
    sender,
    slippage: String(slippageBps || 100),  // bps where 100 = 1%
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

// ────── BUY via Monorail (native MON → token) ──────
async function executeBuy({token, amountHuman, slippageBps, account}){
  const q = await monorailQuote({
    from: NATIVE_ZERO,
    to: token,
    amount: amountHuman,
    sender: account,
    slippageBps,
  });
  if (!q.transaction) throw new Error('No transaction returned from Monorail');
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

// ────── SELL via Monorail (token → native MON) ──────
async function executeSell({token, amountHuman, slippageBps, account, onApproveStarted, onApproveConfirmed}){
  const q = await monorailQuote({
    from: token,
    to: NATIVE_ZERO,
    amount: amountHuman,
    sender: account,
    slippageBps,
  });
  if (!q.transaction) throw new Error('No transaction returned from Monorail');

  // Sells require token approval to Monorail's router
  const spender = q.transaction.to;
  const amountInWei = BigInt(q.input);
  const current = await tokenAllowance(token, account, spender);
  if (current < amountInWei){
    if (onApproveStarted) onApproveStarted();
    const approveData = tokenIface.encodeFunctionData('approve', [spender, (2n**256n - 1n)]);
    const simA = await simulateCall(token, approveData, account, null);
    if (!simA.ok) throw new Error('Approve will fail: ' + explainRevert(simA.error));
    const approveTx = await sendTx({ from: account, to: token, data: approveData });
    const rec = await waitReceipt(approveTx, 90000);
    if (!rec) throw new Error('Approve tx not confirmed in 90s — try again');
    if (onApproveConfirmed) onApproveConfirmed(approveTx);
  }

  const sim = await simulateCall(q.transaction.to, q.transaction.data, account, '0x0');
  if (!sim.ok) throw new Error(explainRevert(sim.error));

  const txHash = await sendTx({
    from: account,
    to: q.transaction.to,
    data: q.transaction.data,
    value: '0x0',
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
  monorailQuote, searchTokens,
  connect, isConnected, ensureMonadChain,
  tokenBalance, tokenAllowance, nativeBalance, tokenInfo,
  executeBuy, executeSell, waitReceipt,
  rpcCall, ethCall, explainRevert,
};

})();
