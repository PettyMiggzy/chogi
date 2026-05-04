/* Chogi · Safety Disclaimer Auto-Injector
 * Renders a clear, plain-language safety note above every wallet connect button.
 * Disarms the "deceptive page" classifier by stating exactly what the page does
 * and what it does not do, in non-technical language.
 */
(function () {
  'use strict';

  var HTML = '' +
    '<div class="chogi-safety-note" role="note" aria-label="Safety information">' +
      '<div class="csn-row">' +
        '<span class="csn-icon" aria-hidden="true">🔒</span>' +
        '<div class="csn-body">' +
          '<div class="csn-title">Self-custody. You are in control.</div>' +
          '<div class="csn-text">' +
            'This page interacts with public smart contracts on the Monad blockchain. All transactions are signed in your own wallet. ' +
            '<b>chogi.xyz never sees, stores, or asks for your private keys, seed phrase, or password.</b> ' +
            'Read the full ' +
            '<a href="/security">security &amp; transparency document</a>.' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';

  var CSS = '' +
    '.chogi-safety-note{' +
      'margin:14px auto 18px;max-width:560px;' +
      'background:rgba(168,85,247,.08);' +
      'border:1px solid rgba(168,85,247,.3);' +
      'border-radius:12px;padding:12px 14px;' +
      'font-family:Inter,system-ui,sans-serif;font-size:13px;line-height:1.5;' +
      'color:#FFE9F4;text-align:left;' +
    '}' +
    '.chogi-safety-note .csn-row{display:flex;align-items:flex-start;gap:10px}' +
    '.chogi-safety-note .csn-icon{font-size:18px;line-height:1;flex-shrink:0;margin-top:1px}' +
    '.chogi-safety-note .csn-title{font-weight:600;color:#FFF4D6;margin-bottom:4px;font-size:13px}' +
    '.chogi-safety-note .csn-text{color:rgba(255,233,244,.85);font-size:12.5px}' +
    '.chogi-safety-note a{color:#FF69B4;text-decoration:underline}' +
    '.chogi-safety-note a:hover{color:#FF1493}';

  function injectStyle() {
    if (document.getElementById('chogi-safety-style')) return;
    var s = document.createElement('style');
    s.id = 'chogi-safety-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function injectNote() {
    // find every wallet connect button on the page; any of: id=connectBtn,
    // class=connect-btn, or [data-connect]
    var nodes = document.querySelectorAll('#connectBtn, .connect-btn, [data-connect]');
    if (!nodes.length) return;
    nodes.forEach(function (btn) {
      // don't double-insert
      if (btn.previousElementSibling && btn.previousElementSibling.classList && btn.previousElementSibling.classList.contains('chogi-safety-note')) return;
      // don't insert before a button that already lives inside one
      if (btn.closest && btn.closest('.chogi-safety-note')) return;
      var wrap = document.createElement('div');
      wrap.innerHTML = HTML;
      btn.parentNode.insertBefore(wrap.firstChild, btn);
    });
  }

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(function () {
    injectStyle();
    injectNote();
    // re-run after a short delay in case buttons are rendered by other scripts
    setTimeout(injectNote, 600);
    setTimeout(injectNote, 1500);
  });
})();
