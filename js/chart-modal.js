/* Chogi Chart Modal
   ──────────────────────────────────────────────
   Replaces "CHART" links that bounce users to dexscreener.com with an
   in-page modal embedding the DexScreener chart via iframe. Users stay
   on chogi.xyz, see real candles + timeframes, and can still pop out
   to dexscreener if they want the full UI.

   USAGE (auto-wires on page load):
   - Any <a> or <button> with class="chogi-chart-trigger" opens the modal
   - Or call window.ChogiChart.open() directly
   - Or any <a href="https://dexscreener.com/monad/..."> gets auto-intercepted
     unless it has the class="external-chart" opt-out

   The modal embeds:
   https://dexscreener.com/monad/<pair>?embed=1&theme=dark&trades=0&info=0
*/
(function(){
  if(window.ChogiChart) return;

  var PAIR = '0x75c3ab752e313544f00f08fc945fce7d22ef4f0d';  // $CHOGI/WMON on Crust
  var EMBED_URL = 'https://dexscreener.com/monad/' + PAIR
    + '?embed=1&theme=dark&trades=0&info=0';
  var EXTERNAL_URL = 'https://dexscreener.com/monad/' + PAIR;

  function injectStyles(){
    if(document.getElementById('chogi-chart-styles')) return;
    var css = ''
      + '.chogi-chart-backdrop{'
      + '  position:fixed;inset:0;z-index:9998;'
      + '  background:rgba(10,1,24,0.85);backdrop-filter:blur(8px);'
      + '  display:none;align-items:center;justify-content:center;padding:24px;'
      + '  animation:chogi-chart-fade 0.2s ease-out;'
      + '}'
      + '.chogi-chart-backdrop.show{display:flex}'
      + '@keyframes chogi-chart-fade{from{opacity:0}to{opacity:1}}'
      + '.chogi-chart-modal{'
      + '  position:relative;width:100%;max-width:1100px;height:80vh;max-height:780px;'
      + '  background:#0a0118;'
      + '  border:1.5px solid rgba(255,20,147,0.45);border-radius:14px;overflow:hidden;'
      + '  box-shadow:0 32px 80px rgba(0,0,0,0.6),0 0 40px rgba(255,20,147,0.2);'
      + '  animation:chogi-chart-up 0.28s cubic-bezier(.2,.9,.2,1);'
      + '  display:flex;flex-direction:column;'
      + '}'
      + '@keyframes chogi-chart-up{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}'
      + '.chogi-chart-bar{'
      + '  display:flex;justify-content:space-between;align-items:center;'
      + '  padding:11px 16px;background:linear-gradient(90deg,rgba(255,20,147,0.12),rgba(168,85,247,0.08));'
      + '  border-bottom:1px solid rgba(255,20,147,0.25);flex-shrink:0;'
      + '  font-family:"JetBrains Mono",ui-monospace,monospace;'
      + '}'
      + '.chogi-chart-bar .ttl{'
      + '  font-size:11px;letter-spacing:0.18em;color:#FF1493;font-weight:700;'
      + '  display:flex;align-items:center;gap:8px;'
      + '}'
      + '.chogi-chart-bar .ttl .led{'
      + '  width:8px;height:8px;border-radius:50%;background:#6eff9c;'
      + '  box-shadow:0 0 8px #6eff9c;animation:chogi-chart-led 1.4s ease-in-out infinite;'
      + '}'
      + '@keyframes chogi-chart-led{0%,49%{opacity:1}50%,100%{opacity:0.3}}'
      + '.chogi-chart-bar .actions{display:flex;align-items:center;gap:6px}'
      + '.chogi-chart-bar a.popout,.chogi-chart-bar button.cls{'
      + '  font-family:"JetBrains Mono",monospace;font-size:10px;letter-spacing:0.15em;'
      + '  padding:7px 11px;background:rgba(255,255,255,0.04);'
      + '  border:1px solid rgba(255,255,255,0.12);border-radius:6px;'
      + '  color:rgba(255,233,244,0.8);text-decoration:none;cursor:pointer;'
      + '  transition:all 0.15s;'
      + '}'
      + '.chogi-chart-bar a.popout:hover,.chogi-chart-bar button.cls:hover{'
      + '  background:rgba(255,20,147,0.15);border-color:rgba(255,20,147,0.5);color:#fff;'
      + '}'
      + '.chogi-chart-bar button.cls{font-size:14px;padding:5px 11px;line-height:1}'
      + '.chogi-chart-frame{flex:1;background:#0a0118;border:0;width:100%}'
      + '.chogi-chart-loading{'
      + '  position:absolute;inset:0;display:flex;align-items:center;justify-content:center;'
      + '  flex-direction:column;gap:14px;color:#FF1493;font-family:"JetBrains Mono",monospace;'
      + '  font-size:11px;letter-spacing:0.18em;pointer-events:none;'
      + '}'
      + '.chogi-chart-loading.gone{display:none}'
      + '.chogi-chart-loading .spin{'
      + '  width:36px;height:36px;border:2px solid rgba(255,20,147,0.2);'
      + '  border-top-color:#FF1493;border-radius:50%;'
      + '  animation:chogi-chart-spin 0.7s linear infinite;'
      + '}'
      + '@keyframes chogi-chart-spin{to{transform:rotate(360deg)}}'
      + '@media (max-width:640px){'
      + '  .chogi-chart-backdrop{padding:0}'
      + '  .chogi-chart-modal{height:100vh;max-height:none;border-radius:0;border:0}'
      + '  .chogi-chart-bar .ttl{font-size:10px;letter-spacing:0.12em}'
      + '}';
    var s = document.createElement('style');
    s.id = 'chogi-chart-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  function buildModal(){
    if(document.getElementById('chogi-chart-backdrop')) return;
    var bd = document.createElement('div');
    bd.id = 'chogi-chart-backdrop';
    bd.className = 'chogi-chart-backdrop';
    bd.setAttribute('role','dialog');
    bd.setAttribute('aria-modal','true');
    bd.setAttribute('aria-label','Chogi price chart');
    bd.innerHTML =
      '<div class="chogi-chart-modal">' +
        '<div class="chogi-chart-bar">' +
          '<div class="ttl"><span class="led"></span> $CHOGI · LIVE CHART</div>' +
          '<div class="actions">' +
            '<a class="popout" href="' + EXTERNAL_URL + '" target="_blank" rel="noopener">OPEN IN DEXSCREENER ↗</a>' +
            '<button class="cls" type="button" aria-label="Close chart">✕</button>' +
          '</div>' +
        '</div>' +
        '<div style="position:relative;flex:1;display:flex">' +
          '<div class="chogi-chart-loading"><div class="spin"></div><div>▌LOADING TELEMETRY...</div></div>' +
          '<iframe class="chogi-chart-frame" title="$CHOGI live price chart" loading="lazy"></iframe>' +
        '</div>' +
      '</div>';
    document.body.appendChild(bd);

    // close on backdrop click
    bd.addEventListener('click', function(e){
      if(e.target === bd) close();
    });
    // close button
    bd.querySelector('.cls').addEventListener('click', close);
    // hide loader once iframe loads
    bd.querySelector('.chogi-chart-frame').addEventListener('load', function(){
      var ld = bd.querySelector('.chogi-chart-loading');
      if(ld) ld.classList.add('gone');
    });
  }

  function open(){
    injectStyles();
    buildModal();
    var bd = document.getElementById('chogi-chart-backdrop');
    var iframe = bd.querySelector('.chogi-chart-frame');
    var loader = bd.querySelector('.chogi-chart-loading');
    // only set src on first open (or if iframe was reset)
    if(iframe && !iframe.src){
      iframe.src = EMBED_URL;
    }
    if(loader) loader.classList.remove('gone');
    bd.classList.add('show');
    document.body.style.overflow = 'hidden';
    // ESC closes
    document.addEventListener('keydown', escListener);
  }
  function close(){
    var bd = document.getElementById('chogi-chart-backdrop');
    if(bd) bd.classList.remove('show');
    document.body.style.overflow = '';
    document.removeEventListener('keydown', escListener);
  }
  function escListener(e){
    if(e.key === 'Escape') close();
  }

  // ─── AUTO-WIRE EXISTING CHART LINKS ─────────────────────────────────────
  function wire(){
    // explicit class triggers
    var triggers = document.querySelectorAll('.chogi-chart-trigger');
    triggers.forEach(function(el){
      if(el.dataset.chogiChartWired) return;
      el.dataset.chogiChartWired = '1';
      el.addEventListener('click', function(e){
        e.preventDefault();
        open();
      });
    });

    // any <a> that points to dexscreener.com/monad/<our pair>
    // unless it has class="external-chart" (explicit opt-out)
    var dexLinks = document.querySelectorAll(
      'a[href*="dexscreener.com/monad/"]:not(.external-chart)'
    );
    dexLinks.forEach(function(a){
      if(a.dataset.chogiChartWired) return;
      var href = a.getAttribute('href') || '';
      // only intercept if it points to OUR pair (don't catch links to other tokens)
      if(href.toLowerCase().indexOf(PAIR.toLowerCase()) === -1) return;
      a.dataset.chogiChartWired = '1';
      a.addEventListener('click', function(e){
        // allow ctrl/cmd/middle-click to open in new tab as expected
        if(e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
        e.preventDefault();
        open();
      });
    });
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
  // re-wire if anything dynamic was injected
  setTimeout(wire, 800);
  setTimeout(wire, 2400);

  window.ChogiChart = {
    open: open,
    close: close,
    wire: wire
  };
})();
