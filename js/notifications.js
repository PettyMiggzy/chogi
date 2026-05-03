/* Chogi PWA Notifications — buys + burns
   ──────────────────────────────────────────────────────────────────
   Polls Monad RPC every 30s for new ERC20 Transfer events on $CHOGI:
     - from == pool  → BUY  (CHOGI left pool to a wallet)
     - to   == dead  → BURN
   Fires native Notification when PWA is hidden, in-page toast when visible.
   Bell button (bottom-left) toggles on/off. Settings panel for thresholds.
   ────────────────────────────────────────────────────────────────── */
(function () {
  var TOKEN    = '0x5e1b1a14c8758104b8560514e94ab8320e587777';
  var POOL     = '0x75c3ab752e313544f00f08fc945fce7d22ef4f0d';
  var DEAD     = '0x000000000000000000000000000000000000dead';
  var RPC      = 'https://rpc.monad.xyz';
  var TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  var POLL_MS  = 30000;
  var LS_KEY   = 'chogi-notif-cfg';

  function defaults(){
    return { enabled:false, buys:true, burns:true, buyMinUsd:50, burnMinChogi:10000, lastBlock:null, priceUsd:0, priceTs:0 };
  }
  function loadCfg(){
    try{ var s=localStorage.getItem(LS_KEY); if(!s) return defaults();
      var p=JSON.parse(s), d=defaults();
      Object.keys(d).forEach(function(k){ if(!(k in p)) p[k]=d[k]; });
      return p;
    }catch(e){ return defaults(); }
  }
  function saveCfg(){ try{ localStorage.setItem(LS_KEY, JSON.stringify(cfg)); }catch(e){} }
  var cfg = loadCfg();

  /* ── helpers ── */
  function pad(a){ return a.toLowerCase().replace('0x','').padStart(64,'0'); }
  function bn(h){ try{return BigInt(h||'0x0');}catch(e){return 0n;} }
  function fromWei(big){ return Number(big/10n**14n)/10000; }
  function fmt(n){
    if(n>=1e9) return (n/1e9).toFixed(2)+'B';
    if(n>=1e6) return (n/1e6).toFixed(2)+'M';
    if(n>=1e3) return (n/1e3).toFixed(1)+'K';
    return n.toFixed(0);
  }
  function fmtUsd(n){
    if(n>=1e6) return '$'+(n/1e6).toFixed(2)+'M';
    if(n>=1e3) return '$'+(n/1e3).toFixed(1)+'K';
    return '$'+n.toFixed(2);
  }
  function shortAddr(a){ return a.slice(0,6)+'…'+a.slice(-4); }

  function rpc(method, params){
    return fetch(RPC, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0', method:method, params:params, id:1})
    }).then(function(r){return r.json();}).then(function(j){
      if(j.error) throw new Error(j.error.message||'rpc');
      return j.result;
    });
  }

  function getPriceUsd(){
    var now = Date.now();
    if(cfg.priceUsd && now - cfg.priceTs < 60000) return Promise.resolve(cfg.priceUsd);
    return fetch('https://api.dexscreener.com/latest/dex/tokens/'+TOKEN)
      .then(function(r){return r.json();})
      .then(function(j){
        var p = j.pairs && j.pairs[0] && Number(j.pairs[0].priceUsd) || 0;
        cfg.priceUsd = p; cfg.priceTs = now; saveCfg();
        return p;
      })
      .catch(function(){ return cfg.priceUsd || 0; });
  }

  /* ── notification dispatch ── */
  function showNative(title, body, tag, url){
    var opts = {
      body: body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-96.png',
      tag: tag,
      data: { url: url || '/' },
      vibrate: [80,40,80]
    };
    if('serviceWorker' in navigator && navigator.serviceWorker.controller){
      navigator.serviceWorker.ready.then(function(reg){
        reg.showNotification(title, opts).catch(function(){
          try{ new Notification(title, opts); }catch(e){}
        });
      });
    } else {
      try{ new Notification(title, opts); }catch(e){}
    }
  }

  function injectToastStyle(){
    if(document.getElementById('chogi-toast-style')) return;
    var s = document.createElement('style'); s.id='chogi-toast-style';
    s.textContent =
      '.chogi-toast{position:fixed;bottom:80px;right:14px;z-index:10000;display:flex;gap:12px;align-items:center;padding:13px 18px 13px 14px;max-width:340px;background:linear-gradient(135deg,rgba(20,2,40,.96),rgba(10,1,24,.96));border:1.5px solid rgba(255,20,147,.5);border-radius:14px;backdrop-filter:blur(14px);box-shadow:0 12px 40px rgba(0,0,0,.6),0 0 24px rgba(255,20,147,.25);transform:translateX(120%);transition:transform .35s cubic-bezier(.2,.8,.2,1);font-family:system-ui,sans-serif;}'+
      '.chogi-toast.show{transform:translateX(0);}'+
      '.chogi-toast .em{font-size:22px;line-height:1;}'+
      '.chogi-toast .l1{font-family:Bungee,system-ui,sans-serif;font-size:13px;letter-spacing:1.5px;color:#fff;line-height:1.2;}'+
      '.chogi-toast .l2{font-family:JetBrains Mono,monospace;font-size:11px;color:#FFE9F4;opacity:.7;margin-top:3px;}';
    document.head.appendChild(s);
  }
  function inPageToast(emoji, l1, l2){
    injectToastStyle();
    var t = document.createElement('div');
    t.className='chogi-toast';
    t.innerHTML = '<div class="em">'+emoji+'</div><div><div class="l1">'+l1+'</div><div class="l2">'+l2+'</div></div>';
    document.body.appendChild(t);
    requestAnimationFrame(function(){ t.classList.add('show'); });
    setTimeout(function(){ t.classList.remove('show'); setTimeout(function(){ if(t.parentNode) t.remove(); }, 350); }, 5500);
  }

  function dispatchEvent(kind, d){
    var hidden = document.visibilityState === 'hidden';
    if(kind==='buy'){
      var title = d.usd >= 5000 ? '🚨 WHALE BUY · $CHOGI' :
                  d.usd >= 1000 ? '🐋 BIG BUY · $CHOGI' :
                  d.usd >= 200  ? '🚀 BUY · $CHOGI' :
                                  '🟢 buy · $CHOGI';
      var body = fmt(d.amount)+' CHOGI · '+fmtUsd(d.usd)+' · '+shortAddr(d.buyer);
      if(hidden) showNative(title, body, 'buy-'+d.tx, 'https://dexscreener.com/monad/0x75c3ab752e313544f00f08fc945fce7d22ef4f0d');
      else inPageToast(d.usd>=1000?'🐋':'🟢', title.replace(/^[^A-Z]+/,''), body);
    } else if(kind==='burn'){
      var big = d.amount >= 1e6;
      var title2 = big ? '🔥🔥 MAJOR BURN · $CHOGI' : '🔥 BURN · $CHOGI';
      var body2  = fmt(d.amount)+' CHOGI to the void · '+shortAddr(d.burner);
      if(hidden) showNative(title2, body2, 'burn-'+d.tx, '/burn');
      else inPageToast('🔥', title2.replace(/^[^A-Z]+/,''), body2);
    }
  }

  /* ── poller ── */
  var pollTimer = null, inFlight = false;
  async function pollOnce(){
    if(!cfg.enabled || inFlight) return;
    inFlight = true;
    try{
      var headHex = await rpc('eth_blockNumber', []);
      var head = Number(bn(headHex));
      if(cfg.lastBlock === null){ cfg.lastBlock = head; saveCfg(); return; }
      if(head <= cfg.lastBlock) return;
      var fromBlock = cfg.lastBlock + 1;
      var toBlock   = Math.min(head, fromBlock + 4500);
      var logs = await rpc('eth_getLogs', [{
        address: TOKEN,
        fromBlock: '0x'+fromBlock.toString(16),
        toBlock:   '0x'+toBlock.toString(16),
        topics: [TRANSFER]
      }]);
      logs.sort(function(a,b){
        var ba=Number(bn(a.blockNumber)), bb=Number(bn(b.blockNumber));
        if(ba!==bb) return ba-bb;
        return Number(bn(a.logIndex)) - Number(bn(b.logIndex));
      });
      var price = await getPriceUsd();
      for(var i=0;i<logs.length;i++){
        var log = logs[i];
        var fromAddr = '0x'+(log.topics[1]||'').toLowerCase().slice(-40);
        var toAddr   = '0x'+(log.topics[2]||'').toLowerCase().slice(-40);
        var amt = fromWei(bn(log.data||'0x0'));
        if(cfg.burns && toAddr === DEAD.toLowerCase()){
          if(amt >= cfg.burnMinChogi) dispatchEvent('burn', { amount:amt, burner:fromAddr, tx:log.transactionHash });
          continue;
        }
        if(cfg.buys && fromAddr === POOL.toLowerCase() && toAddr !== DEAD.toLowerCase() && toAddr !== POOL.toLowerCase()){
          var usd = amt * price;
          if(usd >= cfg.buyMinUsd) dispatchEvent('buy', { amount:amt, usd:usd, buyer:toAddr, tx:log.transactionHash });
        }
      }
      cfg.lastBlock = toBlock; saveCfg();
    }catch(e){ console.warn('[chogi-notif] poll err', e.message); }
    finally{ inFlight = false; }
  }
  function startPoll(){ if(pollTimer) return; pollOnce(); pollTimer = setInterval(pollOnce, POLL_MS); }
  function stopPoll(){ if(pollTimer){ clearInterval(pollTimer); pollTimer = null; } }
  document.addEventListener('visibilitychange', function(){
    if(document.visibilityState === 'visible' && cfg.enabled) pollOnce();
  });

  /* ── bell + panel UI ── */
  function injectUiStyle(){
    if(document.getElementById('chogi-bell-style')) return;
    var s = document.createElement('style'); s.id='chogi-bell-style';
    s.textContent =
      '#chogi-bell{position:fixed;bottom:18px;left:18px;z-index:9998;width:48px;height:48px;border-radius:50%;border:2px solid rgba(255,20,147,.5);background:linear-gradient(135deg,#1a0436,#2a0855);color:#fff;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px rgba(0,0,0,.5),0 0 18px rgba(255,20,147,.25);transition:all .2s;font-family:system-ui;}'+
      '#chogi-bell:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,.6),0 0 24px rgba(255,20,147,.45);}'+
      '#chogi-bell.on{border-color:#FCD34D;box-shadow:0 6px 20px rgba(0,0,0,.5),0 0 18px rgba(252,211,77,.5);animation:cBellPulse 2.6s infinite;}'+
      '@keyframes cBellPulse{0%,100%{box-shadow:0 6px 20px rgba(0,0,0,.5),0 0 0 0 rgba(252,211,77,.4);}50%{box-shadow:0 6px 20px rgba(0,0,0,.5),0 0 0 8px rgba(252,211,77,0);}}'+
      '#chogi-notif-panel{position:fixed;bottom:78px;left:18px;z-index:9999;width:300px;padding:18px;background:linear-gradient(180deg,rgba(20,2,40,.97),rgba(10,1,24,.97));border:1.5px solid rgba(255,20,147,.45);border-radius:14px;backdrop-filter:blur(14px);box-shadow:0 12px 40px rgba(0,0,0,.6),0 0 24px rgba(255,20,147,.2);color:#FFE9F4;font-family:system-ui,sans-serif;display:none;}'+
      '#chogi-notif-panel.show{display:block;}'+
      '#chogi-notif-panel h4{font-family:Bungee,system-ui,sans-serif;font-size:13px;letter-spacing:2.5px;color:#FF1493;margin-bottom:14px;}'+
      '#chogi-notif-panel .row{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.06);}'+
      '#chogi-notif-panel .row:last-of-type{border-bottom:none;}'+
      '#chogi-notif-panel .lbl{font-family:JetBrains Mono,monospace;font-size:11px;letter-spacing:1px;color:rgba(255,233,244,.85);}'+
      '#chogi-notif-panel input{width:88px;padding:6px 8px;background:rgba(255,255,255,.05);border:1px solid rgba(255,20,147,.3);border-radius:6px;color:#fff;font-family:JetBrains Mono,monospace;font-size:11px;text-align:right;}'+
      '#chogi-notif-panel .tg{position:relative;width:38px;height:22px;background:rgba(255,255,255,.1);border-radius:12px;cursor:pointer;border:1px solid rgba(255,255,255,.18);transition:background .2s;flex-shrink:0;}'+
      '#chogi-notif-panel .tg::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;background:#fff;border-radius:50%;transition:transform .2s;}'+
      '#chogi-notif-panel .tg.on{background:linear-gradient(135deg,#FF1493,#A855F7);border-color:transparent;}'+
      '#chogi-notif-panel .tg.on::after{transform:translateX(16px);}'+
      '#chogi-notif-panel .cta{display:block;width:100%;margin-top:14px;padding:11px;background:linear-gradient(135deg,#FF1493,#A855F7);color:#fff;border:none;border-radius:9px;font-family:Bungee,sans-serif;font-size:11px;letter-spacing:2px;cursor:pointer;}'+
      '#chogi-notif-panel .cta.off{background:rgba(255,255,255,.08);}'+
      '#chogi-notif-panel .ft{font-size:9px;letter-spacing:1px;color:rgba(255,233,244,.5);margin-top:10px;line-height:1.5;}';
    document.head.appendChild(s);
  }

  function paintBell(){
    var b = document.getElementById('chogi-bell'); if(!b) return;
    b.classList.toggle('on', !!cfg.enabled);
    b.title = cfg.enabled ? 'Chogi alerts ON · tap to manage' : 'Tap to enable Chogi alerts';
    b.textContent = cfg.enabled ? '🔔' : '🔕';
  }

  function paintPanel(){
    var p = document.getElementById('chogi-notif-panel'); if(!p) return;
    p.querySelector('[data-tg="enabled"]').classList.toggle('on', !!cfg.enabled);
    p.querySelector('[data-tg="buys"]').classList.toggle('on', !!cfg.buys);
    p.querySelector('[data-tg="burns"]').classList.toggle('on', !!cfg.burns);
    p.querySelector('[data-in="buyMinUsd"]').value = cfg.buyMinUsd;
    p.querySelector('[data-in="burnMinChogi"]').value = cfg.burnMinChogi;
    var c = p.querySelector('.cta');
    c.textContent = cfg.enabled ? 'TURN OFF' : 'ENABLE NOTIFICATIONS';
    c.classList.toggle('off', !!cfg.enabled);
  }

  function buildPanel(){
    var p = document.createElement('div');
    p.id = 'chogi-notif-panel';
    p.innerHTML =
      '<h4>🔔 LAB ALERTS</h4>'+
      '<div class="row"><span class="lbl">Buy alerts</span><div class="tg" data-tg="buys"></div></div>'+
      '<div class="row"><span class="lbl">Min buy ($)</span><input type="number" min="0" step="10" data-in="buyMinUsd"></div>'+
      '<div class="row"><span class="lbl">Burn alerts</span><div class="tg" data-tg="burns"></div></div>'+
      '<div class="row"><span class="lbl">Min burn (CHOGI)</span><input type="number" min="0" step="1000" data-in="burnMinChogi"></div>'+
      '<button class="cta" type="button">ENABLE NOTIFICATIONS</button>'+
      '<div class="ft">Buys + burns straight to your phone. Works best when Chogi is installed as an app.</div>';
    document.body.appendChild(p);

    // toggles
    p.querySelector('[data-tg="buys"]').addEventListener('click', function(){ cfg.buys=!cfg.buys; saveCfg(); paintPanel(); });
    p.querySelector('[data-tg="burns"]').addEventListener('click', function(){ cfg.burns=!cfg.burns; saveCfg(); paintPanel(); });
    // inputs
    p.querySelector('[data-in="buyMinUsd"]').addEventListener('change', function(e){ cfg.buyMinUsd = Math.max(0, Number(e.target.value)||0); saveCfg(); });
    p.querySelector('[data-in="burnMinChogi"]').addEventListener('change', function(e){ cfg.burnMinChogi = Math.max(0, Number(e.target.value)||0); saveCfg(); });
    // main CTA
    p.querySelector('.cta').addEventListener('click', function(){
      if(cfg.enabled){
        cfg.enabled = false; saveCfg(); stopPoll(); paintBell(); paintPanel();
      } else {
        requestPermissionAndEnable();
      }
    });

    return p;
  }

  async function requestPermissionAndEnable(){
    if(!('Notification' in window)){
      cfg.enabled = true; saveCfg(); startPoll(); paintBell(); paintPanel();
      return;
    }
    if(Notification.permission === 'granted'){
      cfg.enabled = true; saveCfg(); startPoll(); paintBell(); paintPanel(); return;
    }
    if(Notification.permission === 'denied'){
      cfg.enabled = true; saveCfg(); startPoll(); paintBell(); paintPanel();
      alert('Background alerts are blocked in your browser settings. In-page toasts will still work while the app is open.');
      return;
    }
    var perm = await Notification.requestPermission();
    cfg.enabled = perm !== 'denied';
    saveCfg(); startPoll(); paintBell(); paintPanel();
    if(perm === 'granted'){
      showNative('🧪 Chogi Alerts ON',
        'You\'ll get pinged for buys ≥ '+fmtUsd(cfg.buyMinUsd)+' and burns ≥ '+fmt(cfg.burnMinChogi)+' CHOGI.',
        'welcome', '/');
    }
  }

  function buildBell(){
    var b = document.createElement('button');
    b.id = 'chogi-bell'; b.type = 'button';
    b.textContent = '🔕';
    b.addEventListener('click', function(e){
      e.stopPropagation();
      var p = document.getElementById('chogi-notif-panel') || buildPanel();
      var open = p.classList.contains('show');
      p.classList.toggle('show', !open);
      if(!open) paintPanel();
    });
    document.body.appendChild(b);
    paintBell();
  }

  // close panel when clicking outside
  document.addEventListener('click', function(e){
    var p = document.getElementById('chogi-notif-panel');
    var b = document.getElementById('chogi-bell');
    if(!p || !b) return;
    if(p.contains(e.target) || b.contains(e.target)) return;
    p.classList.remove('show');
  });

  /* boot */
  function boot(){
    if(!('fetch' in window)) return;
    injectUiStyle();
    buildBell();
    if(cfg.enabled) startPoll();
  }
  if(document.readyState !== 'loading') boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
