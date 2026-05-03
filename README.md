# 🧪 CHOGI · Experiment 7777

> An experiment sparked her existence. Now she's loose on Monad. 💜

The official site for **$CHOGI** — sister of Chog, mascot of mischief, born in the lab and raised by the chain.

---

## 🌐 Live

**Site:** https://chogi.xyz
**Token:** `0x5E1b1A14c8758104B8560514e94ab8320e587777`
**Buy:** [nad.fun](https://nad.fun/tokens/0x5E1b1A14c8758104B8560514e94ab8320e587777)
**Chart:** [DexScreener](https://dexscreener.com/monad/0x75c3ab752e313544f00f08fc945fce7d22ef4f0d)

**Socials**
- 𝕏 [@Chogicto](https://x.com/chogicto)
- Telegram: [t.me/chogicto](https://t.me/chogicto)

---

## 🧬 What's in this repo

```
/
├── index.html      ← main site (containment-breach narrative, live data, buy)
├── chogi.jpg       ← the official portrait
├── vercel.json     ← deploy config
└── README.md
```

Single-page static site. Zero npm dependencies. Zero backend. All live data pulled client-side from DexScreener API. Refreshes every 30 seconds.

---

## 🎨 Design system

- **Fonts:** Bungee (display), Space Grotesk (body), JetBrains Mono (code/labels)
- **Palette:**
  - `#FF1493` — hot pink (primary)
  - `#A855F7` — purple (secondary)
  - `#FCD34D` — gold (accent / promotion)
  - `#0a0118` — deep purple-black (background)
- **Vibe:** Cyberpunk lab containment breach. Glitch effects, scanlines, animated rings, declassified-document framing.

Distinct from chog.xyz on purpose — Chogi is the escaped one, not the polished mascot.

---

## 🛠 Local dev

```bash
git clone https://github.com/PettyMiggzy/chogi.git
cd chogi
# It's static HTML — open index.html in a browser, or:
python3 -m http.server 8000
# → http://localhost:8000
```

---

## 🚀 Deploy

This is a static site. To deploy on **Vercel**:

1. Connect this repo at https://vercel.com/new
2. Framework preset: **Other**
3. Build command: *leave empty*
4. Output directory: *leave empty* (root)
5. Click **Deploy**

To wire up `chogi.xyz`:
1. Buy the domain
2. In Vercel project → Settings → Domains → add `chogi.xyz`
3. Update DNS at registrar:
   - `A` record `@` → `76.76.21.21`
   - `CNAME` `www` → `cname.vercel-dns.com`
4. Vercel auto-issues SSL

---

## 🤝 Team

- **Chogi** — CTO · Containment Breacher · [@Chogicto](https://x.com/chogicto)
- **Chog** — Big brother · OG mascot · [chog.xyz](https://www.chog.xyz/)
- **King Petty** — Builder · [@miggzyonbase](https://x.com/miggzyonbase)

---

## 📜 License

MIT — do whatever you want with the code.

The Chogi character, art, and brand belong to the Chogi project.

---

*made with 💜 in the lab · monad mainnet*
