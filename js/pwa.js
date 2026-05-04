/* Chogi PWA registration + install prompt
   - Registers service worker
   - Captures beforeinstallprompt for Android/desktop Chrome
   - Shows iOS-specific "Add to Home Screen" tip when on iOS Safari
   - Floating install button bottom-right that disappears once installed */
(function () {
  /* register SW */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').then(function (reg) {
        // listen for new SW available, prompt reload
        reg.addEventListener('updatefound', function () {
          var sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', function () {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              // new version ready — silent update on next nav
              sw.postMessage('SKIP_WAITING');
            }
          });
        });
      }).catch(function (e) { console.warn('[chogi-pwa] SW reg failed', e); });
    });
  }

  /* install prompt machinery */
  var deferredPrompt = null;
  var isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;
  var isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) && !window.MSStream;
  var dismissedKey = 'chogi-install-dismissed';
  var dismissed = (function () {
    try { return localStorage.getItem(dismissedKey) === '1'; } catch (e) { return false; }
  })();

  if (isStandalone || dismissed) return;

  /* button + iOS sheet */
  function injectStyles() {
    if (document.getElementById('chogi-install-style')) return;
    var s = document.createElement('style');
    s.id = 'chogi-install-style';
    s.textContent =
      '#chogi-install-btn{' +
        'position:fixed;bottom:calc(18px + env(safe-area-inset-bottom,0px));right:18px;z-index:9999;' +
        'display:none;align-items:center;gap:8px;' +
        'padding:11px 16px;' +
        'background:linear-gradient(135deg,#FF1493,#A855F7);' +
        'color:#fff;border:none;border-radius:30px;' +
        'font-family:Bungee,system-ui,sans-serif;font-size:11px;letter-spacing:2px;' +
        'box-shadow:0 6px 24px rgba(255,20,147,.45),0 0 0 2px rgba(255,255,255,.08) inset;' +
        'cursor:pointer;animation:chogiInstallPulse 2.4s infinite;' +
      '}' +
      '#chogi-install-btn:hover{transform:translateY(-2px);}' +
      '#chogi-install-btn .x{margin-left:4px;opacity:.65;font-size:14px;line-height:1;}' +
      '@keyframes chogiInstallPulse{' +
        '0%,100%{box-shadow:0 6px 24px rgba(255,20,147,.45),0 0 0 0 rgba(255,20,147,.4);}' +
        '50%{box-shadow:0 6px 24px rgba(255,20,147,.55),0 0 0 10px rgba(255,20,147,0);}' +
      '}' +
      '#chogi-ios-sheet{' +
        'position:fixed;left:14px;right:14px;bottom:18px;z-index:9999;' +
        'display:none;padding:18px 20px;' +
        'background:linear-gradient(180deg,rgba(10,1,24,.96),rgba(20,2,40,.96));' +
        'border:1.5px solid rgba(255,20,147,.4);border-radius:16px;' +
        'backdrop-filter:blur(14px);' +
        'box-shadow:0 12px 40px rgba(0,0,0,.6),0 0 30px rgba(255,20,147,.18);' +
        'color:#FFE9F4;font-family:Bungee,system-ui,sans-serif;' +
      '}' +
      '#chogi-ios-sheet .ttl{font-size:13px;letter-spacing:2.5px;color:#FF1493;margin-bottom:8px;}' +
      '#chogi-ios-sheet .body{font-family:"Space Grotesk",system-ui,sans-serif;font-size:13px;line-height:1.5;color:#FFE9F4;letter-spacing:.4px;}' +
      '#chogi-ios-sheet .body b{color:#FCD34D;}' +
      '#chogi-ios-sheet .row{display:flex;justify-content:space-between;align-items:center;margin-top:12px;gap:10px;}' +
      '#chogi-ios-sheet .close{' +
        'background:rgba(255,255,255,.06);color:#fff;border:1px solid rgba(255,255,255,.18);' +
        'border-radius:8px;padding:8px 14px;font-family:Bungee,sans-serif;font-size:10px;letter-spacing:2px;cursor:pointer;' +
      '}';
    document.head.appendChild(s);
  }

  function showAndroidBtn() {
    injectStyles();
    var existing = document.getElementById('chogi-install-btn');
    if (existing) { existing.style.display = 'inline-flex'; return; }
    var btn = document.createElement('button');
    btn.id = 'chogi-install-btn';
    btn.innerHTML = '🧪 INSTALL APP <span class="x" title="dismiss">×</span>';
    btn.addEventListener('click', function (e) {
      // dismiss if the X was tapped
      if (e.target && e.target.classList && e.target.classList.contains('x')) {
        e.stopPropagation();
        try { localStorage.setItem(dismissedKey, '1'); } catch (err) {}
        btn.remove();
        return;
      }
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function () {
        deferredPrompt = null;
        btn.remove();
      });
    });
    document.body.appendChild(btn);
    btn.style.display = 'inline-flex';
  }

  function showIOSSheet() {
    injectStyles();
    if (document.getElementById('chogi-ios-sheet')) return;
    var sheet = document.createElement('div');
    sheet.id = 'chogi-ios-sheet';
    sheet.innerHTML =
      '<div class="ttl">🧪 INSTALL CHOGI APP</div>' +
      '<div class="body">' +
        'Tap the <b>Share</b> icon below, then choose ' +
        '<b>"Add to Home Screen"</b> to install Chogi as an app on your iPhone.' +
      '</div>' +
      '<div class="row">' +
        '<div style="font-size:24px;">📲</div>' +
        '<button class="close" type="button">DISMISS</button>' +
      '</div>';
    document.body.appendChild(sheet);
    sheet.style.display = 'block';
    sheet.querySelector('.close').addEventListener('click', function () {
      try { localStorage.setItem(dismissedKey, '1'); } catch (err) {}
      sheet.remove();
    });
    // auto-hide after 12s if user ignores
    setTimeout(function () { if (sheet && sheet.parentNode) sheet.remove(); }, 12000);
  }

  /* Android / desktop Chrome — capture install prompt */
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    showAndroidBtn();
  });

  /* iOS Safari has no beforeinstallprompt; show manual instructions on first visit */
  if (isIOS) {
    // delay so it doesn't fight first paint
    setTimeout(showIOSSheet, 2500);
  }

  /* clear button once installed */
  window.addEventListener('appinstalled', function () {
    var btn = document.getElementById('chogi-install-btn');
    if (btn) btn.remove();
    var sheet = document.getElementById('chogi-ios-sheet');
    if (sheet) sheet.remove();
  });
})();
