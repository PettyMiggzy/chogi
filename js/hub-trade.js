/* ════════════════════════════════════════════════════════════
   CHOGI HUB — Native nad.fun trade engine
   Single API for curve + DEX swaps via LENS oracle
   - LENS auto-routes to the right router (curve vs uni-v3)
   - Wallet connect via window.ethereum (MetaMask, Rabby, Phantom, Trust)
   - Buy: payable router.buy({amountOutMin, token, to, deadline})
   - Sell: approve(router) then router.sell({amountIn, amountOutMin, token, to, deadline})
   Requires: ethers.js v6 UMD loaded before this script
   ════════════════════════════════════════════════════════════ */
(function(){
'use strict';

if (!window.ethers) { console.error('hub-trade.js requires ethers v6 UMD'); return; }

const LENS_ADDR   = '0x7e78A8DE94f21804F7a17F4E8BF9EC2c872187ea';
const CHAIN_ID    = 143;
const CHAIN_HEX   = '0x8f';
const MONAD_NAME  = 'Monad Mainnet';
const NATIVE_SYM  = 'MON';
const EXPLORER    = 'https://monadexplorer.com';

const RPC_URLS = [
  'https://rpc.monad.xyz',
  'https://monad-mainnet.public.blastapi.io',
];

// ────── ABI Interfaces ──────
const lensIface = new ethers.Interface([
  'function getAmountOut(address _token, uint256 _amountIn, bool _isBuy) view returns (address router, uint256 amountOut)',
  'function getAmountIn(address _token, uint256 _amountOut, bool _isBuy) view returns (address router, uint256 amountIn)',
  'function getProgress(address _token) view returns (uint256)',
  'function isGraduated(address _token) view returns (bool)',
  'function isLocked(address _token) view returns (bool)',
  'function availableBuyTokens(address _token) view returns (uint256 availableBuyToken, uint256 requiredMonAmount)',
]);

const routerIface = new ethers.Interface([
  'function buy((uint256 amountOutMin,address token,address to,uint256 deadline) params) payable returns (uint256 amountOut)',
  'function sell((uint256 amountIn,uint256 amountOutMin,address token,address to,uint256 deadline) params) returns (uint256 amountOut)',
]);

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

async function ethCall(to, data){
  return rpcCall('eth_call', [{to, data}, 'latest']);
}

// ────── LENS quote helpers ──────
async function getAmountOut(token, amountInWei, isBuy){
  const data = lensIface.encodeFunctionData('getAmountOut', [token, amountInWei, isBuy]);
  const res = await ethCall(LENS_ADDR, data);
  const [router, amount] = lensIface.decodeFunctionResult('getAmountOut', res);
  return { router, amount };
}

async function getProgress(token){
  try{
    const data = lensIface.encodeFunctionData('getProgress', [token]);
    const res = await ethCall(LENS_ADDR, data);
    const [progress] = lensIface.decodeFunctionResult('getProgress', res);
    // progress is 0–10000 (bps) per nad.fun convention — verify on integration
    return Number(progress) / 10000;
  }catch(e){ return null; }
}

async function isGraduated(token){
  try{
    const data = lensIface.encodeFunctionData('isGraduated', [token]);
    const res = await ethCall(LENS_ADDR, data);
    const [g] = lensIface.decodeFunctionResult('isGraduated', res);
    return !!g;
  }catch(e){ return null; }
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
          chainName: MONAD_NAME,
          nativeCurrency: {name:'Monad', symbol: NATIVE_SYM, decimals: 18},
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

function isConnected(){
  return !!(window.ethereum && window.ethereum.selectedAddress);
}

// ────── Tx sending ──────
async function sendTx(params){
  return window.ethereum.request({method:'eth_sendTransaction', params:[params]});
}

async function waitReceipt(hash, maxMs=60000){
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
async function simulateCall(to, data, fromAccount, valueWei){
  // run eth_call with state-override to test if the tx would revert
  // (state-override gives the from-address enough MON to bypass the balance check
  //  so the only revert we see is the actual contract logic)
  const overrideBalance = valueWei ? (valueWei * 4n) + 10n**18n : 10n**18n;
  const params = [
    { from: fromAccount, to, data, ...(valueWei != null ? {value: '0x'+valueWei.toString(16)} : {}) },
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
  if (low.includes('insufficient balance') || low.includes('insufficient funds'))
    return 'Not enough MON in your wallet to cover this trade + gas.';
  if (low.includes('insufficient_output_amount') || low.includes('amount_out_min'))
    return 'Slippage too tight — price moved. Try increasing slippage to 3% or 5%.';
  if (low.includes('expired') || low.includes('deadline'))
    return 'Tx deadline passed. Retry the trade.';
  if (low.includes('transfer_failed') || low.includes('transfer failed'))
    return 'Token transfer blocked. Token may have transfer restrictions.';
  if (low.includes('not graduated') || low.includes('locked'))
    return 'Curve still locked. Try the bonding-curve buy on nad.fun directly.';
  if (low.includes('execution reverted') && !low.includes('reason'))
    return 'Trade simulation failed (no reason returned). Likely causes: slippage too tight, low pool liquidity, or token not tradeable on nad.fun. Try a larger slippage or use a different token.';
  if (low.includes('user denied') || low.includes('user rejected'))
    return 'Wallet signature cancelled.';
  // fallback
  return m || 'Unknown revert';
}

// ────── BUY execution ──────
async function executeBuy({token, amountInWei, slippageBps, account}){
  // 1) Quote → router + expected output
  let quote;
  try{
    quote = await getAmountOut(token, amountInWei, true);
  }catch(e){
    throw new Error('This token isn\'t indexed on nad.fun — quote unavailable. Use Monorail (monorail.xyz) for non-nad.fun tokens, or trade via the nad.fun website directly.');
  }
  const router = quote.router;
  const expected = quote.amount;
  if (!expected || expected === 0n)
    throw new Error('Quote returned zero output. Pool may be drained — try a different amount.');
  // 2) min-out with slippage
  const minOut = expected - (expected * BigInt(slippageBps) / 10000n);
  // 3) Build calldata
  const deadline = BigInt(Math.floor(Date.now()/1000) + 1200);
  const data = routerIface.encodeFunctionData('buy', [{
    amountOutMin: minOut,
    token,
    to: account,
    deadline,
  }]);
  // 4) PRE-FLIGHT SIMULATION — catch reverts BEFORE wallet sign
  const sim = await simulateCall(router, data, account, amountInWei);
  if (!sim.ok){
    throw new Error(explainRevert(sim.error));
  }
  // 5) Send tx
  const txHash = await sendTx({
    from: account,
    to: router,
    value: '0x' + amountInWei.toString(16),
    data,
  });
  return { txHash, router, expected, minOut };
}

// ────── SELL execution ──────
async function executeSell({token, amountInWei, slippageBps, account, onApproveStarted, onApproveConfirmed}){
  // 1) Quote
  let quote;
  try{
    quote = await getAmountOut(token, amountInWei, false);
  }catch(e){
    throw new Error('This token isn\'t indexed on nad.fun — sell quote unavailable. Use Monorail or the nad.fun website.');
  }
  const router = quote.router;
  const expected = quote.amount;
  if (!expected || expected === 0n)
    throw new Error('Sell quote returned zero MON. Pool too thin or amount too large.');
  const minOut = expected - (expected * BigInt(slippageBps) / 10000n);
  // 2) Check allowance + approve if needed
  const current = await tokenAllowance(token, account, router);
  if (current < amountInWei){
    if (onApproveStarted) onApproveStarted();
    const approveData = tokenIface.encodeFunctionData('approve', [router, (2n**256n - 1n)]);
    // pre-flight the approve too
    const simA = await simulateCall(token, approveData, account, null);
    if (!simA.ok) throw new Error('Approve will fail: ' + explainRevert(simA.error));
    const approveTx = await sendTx({ from: account, to: token, data: approveData });
    const rec = await waitReceipt(approveTx, 90000);
    if (!rec) throw new Error('Approve tx not confirmed in 90s — try again');
    if (onApproveConfirmed) onApproveConfirmed(approveTx);
  }
  // 3) Sell calldata
  const deadline = BigInt(Math.floor(Date.now()/1000) + 1200);
  const data = routerIface.encodeFunctionData('sell', [{
    amountIn: amountInWei,
    amountOutMin: minOut,
    token,
    to: account,
    deadline,
  }]);
  // 4) Pre-flight
  const sim = await simulateCall(router, data, account, null);
  if (!sim.ok){
    throw new Error(explainRevert(sim.error));
  }
  // 5) Send tx
  const txHash = await sendTx({ from: account, to: router, data });
  return { txHash, router, expected, minOut };
}

// ────── Token metadata read ──────
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

window.ChogiTrade = {
  // constants
  LENS_ADDR, CHAIN_ID, CHAIN_HEX, EXPLORER, NATIVE_SYM,
  // quotes
  getAmountOut, getProgress, isGraduated,
  // wallet
  connect, isConnected, ensureMonadChain,
  // balances
  tokenBalance, tokenAllowance, nativeBalance, tokenInfo,
  // execute
  executeBuy, executeSell, waitReceipt,
  // raw
  rpcCall, ethCall,
};

})();
