/* /js/tool-shared.js — shared gate + render logic for all Chogi Tool pages */
(function(global){
  'use strict';

  var CHOGI_TOKEN = '0x5E1b1A14c8758104B8560514e94ab8320e587777';
  var RPC_URL    = 'https://rpc.monad.xyz';
  var MIN_HOLD   = 100000;

  function pad(addr){ return addr.toLowerCase().replace('0x','').padStart(64,'0'); }

  async function fetchBalance(addr){
    try {
      var data = '0x70a08231' + pad(addr);
      var res = await fetch(RPC_URL, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'eth_call', params:[{to:CHOGI_TOKEN, data}, 'latest'] })
      });
      var j = await res.json();
      if (!j.result || j.result === '0x') return 0;
      return Number(BigInt(j.result) / (10n ** 16n)) / 100;
    } catch(e){
      console.error('bal err', e);
      return 0;
    }
  }

  function escapeHtml(s){
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function renderMarkdown(md){
    var lines = String(md).split('\n');
    var html = '';
    var inList = false;
    for (var i = 0; i < lines.length; i++){
      var line = lines[i];
      if (/^##\s/.test(line)){
        if (inList){ html += '</ul>'; inList = false; }
        html += '<h2>' + escapeHtml(line.replace(/^##\s/, '')) + '</h2>';
        continue;
      }
      if (/^\s*[-*]\s/.test(line)){
        if (!inList){ html += '<ul>'; inList = true; }
        var item = line.replace(/^\s*[-*]\s/, '');
        item = escapeHtml(item)
          .replace(/`([^`]+)`/g, '<code>$1</code>')
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        html += '<li>' + item + '</li>';
        continue;
      }
      if (inList){ html += '</ul>'; inList = false; }
      if (line.trim() === ''){ html += '<br>'; continue; }
      var p = escapeHtml(line)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      html += '<p>' + p + '</p>';
    }
    if (inList) html += '</ul>';
    return html;
  }

  // Gate manager — wires up the standard gate-banner and optional ready callbacks.
  // Element IDs expected: gateBanner, gateDot, gateLabel, connectBtn
  function setupGate(opts){
    opts = opts || {};
    var $ = function(id){ return document.getElementById(id); };
    var account = null;
    var balance = 0;
    var canUse = false;

    function setState(state){
      var dot = $('gateDot'), label = $('gateLabel'), btn = $('connectBtn');
      if (!dot || !label || !btn) return;
      dot.classList.remove('ok','bad');
      if (state === 'connect'){
        label.innerHTML = '<span class="gate-text">CONNECT WALLET TO CHECK ACCESS</span>';
        btn.style.display = 'inline-block';
        btn.textContent = 'CONNECT';
        canUse = false;
      } else if (state === 'checking'){
        label.innerHTML = '<span class="gate-text">CHECKING $CHOGI BALANCE…</span>';
        btn.style.display = 'none';
        canUse = false;
      } else if (state === 'ok'){
        dot.classList.add('ok');
        label.innerHTML = '<span class="gate-text">UNLOCKED · </span><span class="gate-bal">' + balance.toLocaleString() + ' $CHOGI</span>';
        btn.style.display = 'inline-block';
        btn.textContent = 'SWITCH';
        canUse = true;
      } else if (state === 'short'){
        dot.classList.add('bad');
        var need = MIN_HOLD - balance;
        label.innerHTML = '<span class="gate-text">NEED ' + need.toLocaleString() + ' MORE · YOU HOLD </span><span class="gate-bal">' + balance.toLocaleString() + '</span>';
        btn.style.display = 'inline-block';
        btn.textContent = 'SWITCH';
        canUse = false;
      }
      if (typeof opts.onChange === 'function') opts.onChange({ canUse: canUse, account: account, balance: balance });
    }

    async function checkAccess(addr){
      if (!addr){ setState('connect'); return; }
      account = addr;
      setState('checking');
      balance = await fetchBalance(addr);
      setState(balance >= MIN_HOLD ? 'ok' : 'short');
    }

    async function tryConnect(){
      if (!global.ethereum){
        if (global.ChogiWallet) global.ChogiWallet.requireWallet();
        else alert('Install MetaMask or another wallet.');
        return;
      }
      try {
        var accs = await global.ethereum.request({ method:'eth_requestAccounts' });
        if (accs && accs[0]) checkAccess(accs[0]);
      } catch(e){ console.error('connect failed', e); }
    }

    function init(){
      var btn = $('connectBtn');
      if (btn) btn.addEventListener('click', tryConnect);

      global.addEventListener('chogi:connected', function(e){
        if (e && e.detail && e.detail.account) checkAccess(e.detail.account);
      });
      global.addEventListener('chogi:disconnected', function(){
        account = null; balance = 0; setState('connect');
      });

      // Boot — pick up an existing connection
      if (global.ChogiConnect && global.ChogiConnect.isConnected && global.ChogiConnect.isConnected()){
        checkAccess(global.ChogiConnect.getAccount());
      } else if (global.ethereum){
        global.ethereum.request({ method:'eth_accounts' }).then(function(accs){
          if (accs && accs[0]) checkAccess(accs[0]);
          else setState('connect');
        }).catch(function(){ setState('connect'); });
      } else {
        setState('connect');
      }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else setTimeout(init, 200);

    return {
      getAccount: function(){ return account; },
      getBalance: function(){ return balance; },
      canUse:     function(){ return canUse; }
    };
  }

  global.ChogiTool = {
    setupGate: setupGate,
    renderMarkdown: renderMarkdown,
    escapeHtml: escapeHtml,
    fetchBalance: fetchBalance,
    MIN_HOLD: MIN_HOLD,
    CHOGI_TOKEN: CHOGI_TOKEN,
    RPC_URL: RPC_URL
  };
})(window);
