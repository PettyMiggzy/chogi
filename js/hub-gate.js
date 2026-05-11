/* ════════════════════════════════════════════════════════════
   CHOGI TRADER HUB — Access Gate
   Requires ≥ MIN_BALANCE $CHOGI to unlock the hub.
   Reads on-chain balance via RPC (eth_call balanceOf).
   Re-checks every RECHECK_MS while user is on the page.
   ════════════════════════════════════════════════════════════ */
(function(){
'use strict';

const CFG = window.ChogiConfig || {};
const CHOGI_TOKEN  = CFG.TOKEN || '0x5E1b1A14c8758104B8560514e94ab8320e587777';
const MIN_TOKENS   = 1_000_000n;            // 1M $CHOGI
const MIN_RAW      = MIN_TOKENS * 10n**18n; // raw wei
const CHAIN_HEX    = CFG.CHAIN_HEX || '0x8f';
const RECHECK_MS   = 60000;                 // verify every 60s while on hub
const RPC_URLS = [
  'https://rpc.monad.xyz',
  'https://monad-mainnet.public.blastapi.io',
];

async function rpcCall(method, params){
  let lastErr;
  for (const url of RPC_URLS){
    try{
      const ctrl = new AbortController();
      const t = setTimeout(()=>ctrl.abort(), 9000);
      const r = await fetch(url, {
        method:'POST',
        headers:{'content-type':'application/json'},
        body: JSON.stringify({jsonrpc:'2.0',id:Date.now(),method,params}),
        signal: ctrl.signal
      });
      clearTimeout(t);
      if (!r.ok) throw new Error('http '+r.status);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || 'rpc');
      return j.result;
    }catch(e){ lastErr = e; }
  }
  throw lastErr || new Error('all RPCs failed');
}

async function getChogiBalance(account){
  if (!account) return 0n;
  const data = '0x70a08231' + account.toLowerCase().replace('0x','').padStart(64,'0');
  const hex = await rpcCall('eth_call', [{to: CHOGI_TOKEN, data}, 'latest']);
  if (!hex || hex === '0x') return 0n;
  return BigInt(hex);
}

function rawToTokens(raw){
  // 18-decimal → readable number (loses precision below 6 decimals which doesn't matter for display)
  try{
    return Number(raw / 10n**12n) / 1e6;
  }catch(e){ return 0; }
}

function fmt(n, d=0){
  if (n==null || isNaN(n)) return '0';
  const x = +n;
  if (Math.abs(x) >= 1e9) return (x/1e9).toFixed(d)+'B';
  if (Math.abs(x) >= 1e6) return (x/1e6).toFixed(d)+'M';
  if (Math.abs(x) >= 1e3) return (x/1e3).toFixed(d)+'K';
  return x.toFixed(d);
}

function injectStyles(){
  if (document.getElementById('chogi-gate-style')) return;
  const css = `
#chogi-gate-overlay{
  position:fixed;inset:0;z-index:100000;
  background:rgba(10,1,24,.92);
  backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
  display:flex;align-items:center;justify-content:center;
  padding:20px;font-family:'Space Grotesk',system-ui,sans-serif;
  animation:gateIn .35s ease-out;
}
#chogi-gate-overlay.out{animation:gateOut .4s ease-in forwards;}
@keyframes gateIn{from{opacity:0;}to{opacity:1;}}
@keyframes gateOut{from{opacity:1;}to{opacity:0;visibility:hidden;}}
#chogi-gate-card{
  background:rgba(20,8,40,.85);
  border:2px solid #FF1493;
  border-radius:18px;
  box-shadow:0 0 60px rgba(255,20,147,.35),0 0 140px rgba(168,85,247,.25),inset 0 0 30px rgba(255,255,255,.04);
  padding:28px 24px;
  max-width:440px;width:100%;text-align:center;
  position:relative;overflow:hidden;
  color:#FFE9F4;
}
#chogi-gate-card::before{
  content:'';position:absolute;inset:0;pointer-events:none;
  background:
    radial-gradient(ellipse at 50% 0%,rgba(255,20,147,.25),transparent 60%),
    radial-gradient(ellipse at 0% 100%,rgba(168,85,247,.22),transparent 50%);
  z-index:0;
}
#chogi-gate-card > *{position:relative;z-index:1;}
.cg-lock{
  font-size:42px;margin-bottom:12px;
  text-shadow:0 0 24px rgba(255,20,147,.7);
  animation:gateLockPulse 2.4s ease-in-out infinite;
}
@keyframes gateLockPulse{0%,100%{transform:scale(1);}50%{transform:scale(1.06);}}
.cg-title{
  font-family:'Bungee',sans-serif;font-size:22px;letter-spacing:3px;color:#fff;
  margin-bottom:6px;
}
.cg-sub{
  font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:1.5px;
  color:#9a8bb3;margin-bottom:22px;
}
.cg-required{
  background:linear-gradient(135deg,rgba(255,20,147,.16),rgba(168,85,247,.14));
  border:1px solid rgba(255,20,147,.4);
  border-radius:12px;padding:14px;margin-bottom:16px;
  font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:1px;color:#9a8bb3;
}
.cg-required .req-num{
  font-family:'Bungee',sans-serif;font-size:26px;letter-spacing:2px;
  background:linear-gradient(135deg,#FF1493,#A855F7);
  -webkit-background-clip:text;background-clip:text;color:transparent;
  margin:3px 0 1px;display:block;
}
.cg-status{
  display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;
  margin-bottom:14px;
  font-family:'JetBrains Mono',monospace;
}
.cg-status .cell{
  background:rgba(8,0,18,.55);border:1px solid rgba(255,20,147,.15);
  border-radius:8px;padding:9px 6px;
}
.cg-status .lbl{font-size:8px;color:#9a8bb3;letter-spacing:1px;}
.cg-status .val{font-size:13px;color:#fff;font-weight:700;margin-top:2px;}
.cg-status .val.ok{color:#22d36f;}
.cg-status .val.no{color:#ff4d6d;}
.cg-progress{
  background:rgba(8,0,18,.6);border-radius:8px;overflow:hidden;height:24px;
  border:1px solid rgba(255,20,147,.25);margin-bottom:16px;position:relative;
}
.cg-progress-fill{
  height:100%;
  background:linear-gradient(90deg,#FF1493,#A855F7);
  box-shadow:0 0 14px rgba(255,20,147,.5);transition:width .6s;
}
.cg-progress-text{
  position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:1px;
  color:#fff;text-shadow:0 0 6px rgba(0,0,0,.85);
}
.cg-btn{
  display:block;width:100%;
  padding:14px 18px;margin-bottom:9px;
  border:none;border-radius:10px;cursor:pointer;text-decoration:none;
  font-family:'Bungee',sans-serif;font-size:12px;letter-spacing:2px;
  background:linear-gradient(135deg,#FF1493,#A855F7);color:#fff;
  box-shadow:0 0 22px rgba(255,20,147,.35);
  transition:all .15s;
  text-align:center;
}
.cg-btn:hover{transform:translateY(-1px);filter:brightness(1.1);}
.cg-btn.ghost{
  background:transparent;border:1px solid rgba(255,20,147,.4);color:#FF1493;
  box-shadow:none;
}
.cg-btn.ghost:hover{background:rgba(255,20,147,.1);color:#fff;}
.cg-btn.cyan{
  background:linear-gradient(135deg,#22d3ee,#A855F7);
}
.cg-btn:disabled{opacity:.55;cursor:wait;}
.cg-foot{
  margin-top:14px;font-family:'JetBrains Mono',monospace;font-size:9px;
  color:#6d5f7f;letter-spacing:.8px;line-height:1.6;
}
.cg-foot a{color:#FF1493;text-decoration:none;}
.cg-err{
  background:rgba(255,77,109,.12);color:#ff4d6d;border:1px solid rgba(255,77,109,.4);
  padding:9px 11px;border-radius:7px;margin-bottom:10px;
  font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.5px;
  display:none;
}
.cg-err.show{display:block;}
.cg-wallet{
  font-family:'JetBrains Mono',monospace;font-size:9px;color:#9a8bb3;
  letter-spacing:1px;margin-top:6px;
}
.cg-wallet a{color:#22d3ee;text-decoration:none;cursor:pointer;margin-left:6px;}
`;
  const style = document.createElement('style');
  style.id = 'chogi-gate-style';
  style.textContent = css;
  document.head.appendChild(style);
}

function buildOverlay(){
  injectStyles();
  const wrap = document.createElement('div');
  wrap.id = 'chogi-gate-overlay';
  wrap.innerHTML = `
<div id="chogi-gate-card">
  <div class="cg-lock">🔒</div>
  <div class="cg-title">GATED ACCESS</div>
  <div class="cg-sub">Chogi Trader HUB · holders only</div>

  <div class="cg-required">
    you need to hold
    <span class="req-num">1,000,000 $CHOGI</span>
    to unlock the hub
  </div>

  <div class="cg-err" id="cg-err"></div>

  <div id="cg-disconnected">
    <button class="cg-btn" id="cg-connect">⚡ CONNECT WALLET TO VERIFY</button>
  </div>

  <div id="cg-connected" style="display:none;">
    <div class="cg-status">
      <div class="cell"><div class="lbl">YOUR HOLD</div><div class="val" id="cg-hold">—</div></div>
      <div class="cell"><div class="lbl">REQUIRED</div><div class="val">1M</div></div>
      <div class="cell"><div class="lbl">GAP</div><div class="val no" id="cg-gap">—</div></div>
    </div>
    <div class="cg-progress">
      <div class="cg-progress-fill" id="cg-fill" style="width:0%;"></div>
      <div class="cg-progress-text" id="cg-pct">0%</div>
    </div>

    <a class="cg-btn cyan" href="/swap" id="cg-buy">🛒 BUY $CHOGI</a>
    <button class="cg-btn ghost" id="cg-refresh">↻ REFRESH BALANCE</button>

    <div class="cg-wallet">connected: <span id="cg-addr">—</span> · <a id="cg-disconnect">disconnect</a></div>
  </div>

  <div class="cg-foot">
    Hold 1M+ $CHOGI to use the trader hub. Live token feed · cross-holder map · subject watch · native on-page swap.
    <br>$CHOGI: <a href="https://nad.fun/tokens/${CHOGI_TOKEN}" target="_blank" rel="noopener">nad.fun</a> · <a href="https://dexscreener.com/monad/${CHOGI_TOKEN}" target="_blank" rel="noopener">chart</a>
  </div>
</div>`;
  document.body.appendChild(wrap);
  document.body.style.overflow = 'hidden';
  return wrap;
}

function teardown(){
  const ov = document.getElementById('chogi-gate-overlay');
  if (!ov) return;
  ov.classList.add('out');
  document.body.style.overflow = '';
  setTimeout(()=>{ ov.remove(); }, 420);
}

async function ensureMonad(){
  if (!window.ethereum) return;
  try{
    const cid = await window.ethereum.request({method:'eth_chainId'});
    if (cid !== CHAIN_HEX){
      try{
        await window.ethereum.request({method:'wallet_switchEthereumChain', params:[{chainId:CHAIN_HEX}]});
      }catch(e){
        if (e && e.code === 4902){
          await window.ethereum.request({method:'wallet_addEthereumChain', params:[{
            chainId: CHAIN_HEX,
            chainName:'Monad Mainnet',
            nativeCurrency:{name:'Monad', symbol:'MON', decimals:18},
            rpcUrls:['https://rpc.monad.xyz'],
            blockExplorerUrls:['https://monadexplorer.com']
          }]});
        }
      }
    }
  }catch(e){}
}

function showErr(msg){
  const el = document.getElementById('cg-err');
  if (!el) return;
  if (!msg){ el.classList.remove('show'); el.textContent=''; return; }
  el.classList.add('show');
  el.textContent = msg;
}

function showDisconnected(){
  document.getElementById('cg-disconnected').style.display = '';
  document.getElementById('cg-connected').style.display = 'none';
}

function showConnected(account, balanceRaw){
  document.getElementById('cg-disconnected').style.display = 'none';
  document.getElementById('cg-connected').style.display = '';

  const have = rawToTokens(balanceRaw);
  const need = 1_000_000;
  const pct = Math.min(100, (have / need) * 100);
  const gap = Math.max(0, need - have);

  document.getElementById('cg-hold').textContent = fmt(have, have < 1000 ? 0 : 2);
  document.getElementById('cg-gap').textContent  = gap > 0 ? fmt(gap, gap < 1000 ? 0 : 2) : '0';
  document.getElementById('cg-gap').className    = 'val ' + (gap > 0 ? 'no' : 'ok');
  document.getElementById('cg-fill').style.width = pct + '%';
  document.getElementById('cg-pct').textContent  = pct.toFixed(1) + '%' + (pct >= 100 ? ' ✓' : '');
  document.getElementById('cg-addr').textContent = account.slice(0,6)+'…'+account.slice(-4);

  // if eligible — auto-unlock after a beat
  if (balanceRaw >= MIN_RAW){
    document.getElementById('cg-pct').textContent = '✓ ACCESS GRANTED';
    setTimeout(teardown, 500);
  }
}

async function verify(account, silent){
  try{
    const bal = await getChogiBalance(account);
    showConnected(account, bal);
    return bal >= MIN_RAW;
  }catch(e){
    if (!silent) showErr('Failed to check balance: '+e.message);
    return false;
  }
}

let connectedAccount = null;
let recheckTimer = null;

async function connectAndVerify(){
  showErr('');
  if (!window.ethereum){
    showErr('No wallet detected. Open this page inside MetaMask, Rabby, Phantom, or Trust Wallet.');
    return;
  }
  const btn = document.getElementById('cg-connect');
  if (btn){ btn.disabled = true; btn.textContent = '⌛ CONNECTING…'; }
  try{
    const accs = await window.ethereum.request({method:'eth_requestAccounts'});
    const a = accs && accs[0];
    if (!a) throw new Error('No account returned');
    await ensureMonad();
    connectedAccount = a;
    const ok = await verify(a);
    if (ok){ startRecheck(); }
  }catch(e){
    showErr(e.message || 'Connect failed');
  } finally {
    if (btn){ btn.disabled = false; btn.textContent = '⚡ CONNECT WALLET TO VERIFY'; }
  }
}

function startRecheck(){
  clearInterval(recheckTimer);
  recheckTimer = setInterval(async ()=>{
    if (!connectedAccount){ clearInterval(recheckTimer); return; }
    const ok = await verify(connectedAccount, true);
    if (!ok){
      // user dumped — re-show gate
      clearInterval(recheckTimer);
      document.body.style.overflow = 'hidden';
      const existing = document.getElementById('chogi-gate-overlay');
      if (!existing){ buildOverlay(); wireGate(); }
    }
  }, RECHECK_MS);
}

function wireGate(){
  document.getElementById('cg-connect') && (document.getElementById('cg-connect').onclick = connectAndVerify);
  document.getElementById('cg-refresh') && (document.getElementById('cg-refresh').onclick = async ()=>{
    if (!connectedAccount) return;
    const btn = document.getElementById('cg-refresh');
    btn.disabled = true; btn.textContent = '⌛ CHECKING…';
    await verify(connectedAccount);
    btn.disabled = false; btn.textContent = '↻ REFRESH BALANCE';
  });
  document.getElementById('cg-disconnect') && (document.getElementById('cg-disconnect').onclick = ()=>{
    connectedAccount = null;
    clearInterval(recheckTimer);
    showDisconnected();
  });
}

async function init(){
  buildOverlay();
  wireGate();

  // try silent auto-connect (was previously authorized)
  if (window.ethereum){
    try{
      const accs = await window.ethereum.request({method:'eth_accounts'});
      if (accs && accs[0]){
        connectedAccount = accs[0];
        const ok = await verify(accs[0], true);
        if (ok) startRecheck();
      }
    }catch(e){}

    // listen for account/chain changes
    window.ethereum.on && window.ethereum.on('accountsChanged', accs=>{
      connectedAccount = (accs && accs[0]) || null;
      if (connectedAccount){
        verify(connectedAccount).then(ok=>{ if(ok) startRecheck(); });
      } else {
        clearInterval(recheckTimer);
        showDisconnected();
      }
    });
    window.ethereum.on && window.ethereum.on('chainChanged', ()=>{
      if (connectedAccount) verify(connectedAccount, true);
    });
  }
}

window.ChogiHubGate = { init, verify, getChogiBalance, MIN_RAW, MIN_TOKENS, CHOGI_TOKEN };

// auto-init when DOM ready
if (document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();
