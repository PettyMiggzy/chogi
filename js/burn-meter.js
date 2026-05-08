/* CHOGI Burn Meter — polls Monad RPC for $CHOGI balance at the dead address.
   Hydrates any element with [data-burn-meter] attribute. Refreshes every 30s.
   Sub-element hooks: [data-burn-amount], [data-burn-pct], [data-burn-supply]. */
(function(){
  var TOKEN  = '0x5E1b1A14c8758104B8560514e94ab8320e587777';
  var DEAD   = '0x000000000000000000000000000000000000dead';
  var RPC    = '/api/rpc';
  var DEC    = 1e18;

  function pad(addr){ return addr.toLowerCase().replace('0x','').padStart(64,'0'); }
  function bn(hex){ try{ return BigInt(hex||'0x0'); }catch(e){ return 0n; } }
  function fromWei(big){ return Number(big / 10n**14n) / 10000; } // 4 decimal precision
  function fmt(n){
    if(n>=1e9) return (n/1e9).toFixed(2)+'B';
    if(n>=1e6) return (n/1e6).toFixed(2)+'M';
    if(n>=1e3) return (n/1e3).toFixed(1)+'K';
    return n.toFixed(0);
  }
  function fmtFull(n){ return Math.floor(n).toLocaleString('en-US'); }

  function rpc(data){
    return fetch(RPC,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',method:'eth_call',params:[{to:TOKEN,data:data},'latest'],id:1})
    }).then(function(r){return r.json();}).then(function(j){return j.result;});
  }

  function fetchBurn(){
    return Promise.all([
      rpc('0x18160ddd'),                    // totalSupply()
      rpc('0x70a08231'+pad(DEAD))           // balanceOf(dead)
    ]).then(function(a){
      var total = bn(a[0]), burned = bn(a[1]);
      return {
        total:  fromWei(total),
        burned: fromWei(burned),
        pct:    total>0n ? Number(burned*1000000n/total)/10000 : 0
      };
    });
  }

  function paint(data){
    var meters = document.querySelectorAll('[data-burn-meter]');
    meters.forEach(function(el){
      var amt = el.querySelector('[data-burn-amount]');
      var pct = el.querySelector('[data-burn-pct]');
      var sup = el.querySelector('[data-burn-supply]');
      var bar = el.querySelector('[data-burn-bar]');
      var compact = el.getAttribute('data-burn-meter') === 'compact';
      if(amt) amt.textContent = compact ? fmt(data.burned) : fmtFull(data.burned);
      if(pct) pct.textContent = data.pct.toFixed(4)+'%';
      if(sup) sup.textContent = fmt(data.total);
      if(bar) bar.style.width = Math.max(0.5, Math.min(100, data.pct))+'%';
      el.classList.add('burn-meter-loaded');
    });
  }

  function paintErr(){
    document.querySelectorAll('[data-burn-meter] [data-burn-amount]').forEach(function(el){
      if(!el.textContent || el.textContent==='—') el.textContent='—';
    });
  }

  function tick(){ fetchBurn().then(paint).catch(paintErr); }

  // expose for the burn page to refresh after a tx
  window.ChogiBurnMeter = { refresh: tick, fetch: fetchBurn };

  if(document.readyState!=='loading') tick();
  else document.addEventListener('DOMContentLoaded', tick);
  setInterval(tick, 30000);
})();
