# Chogi Trader HUB — Pre-Deploy Audit Brief

**Repo**: `PettyMiggzy/chogi` (main branch)
**Live**: `chogi.xyz` → Vercel auto-deploys from GitHub main
**Latest commit at audit start**: `15d6844`

## What this is

A Monad memecoin trading hub built on free Monorail + nad.fun APIs. Five tabs (PRICES, NEW, TRENDING, WALLETS, TRACK), a universal token detail page with native TradingView chart and swap, a gate that requires holding 1M CHOGI to use the hub.

## Audit scope — verify EVERY data fetch shows correct data

The user has lost confidence that data is being pulled and displayed correctly. Several bugs have been found and patched, but he wants confidence that what users see matches reality on-chain / on the upstream APIs.

### Critical paths to verify

1. **LIVE ticker** (top of `/hub`)
   - Pulls 4 ecosystem tokens (CHOGI/MONSHI/RENE/PHUCK) via `/v2/token/{addr}` + meme catalog via `/v2/tokens/category/meme`
   - Verify prices match what Monorail web UI shows
   - Verify the 14-item ticker actually rotates and isn't stuck
   - Verify session %change resets per session, not stale

2. **PRICES tab** (default landing)
   - On-chain `balanceOf` calls for watchlist tokens
   - Verify prices vs Monorail
   - Verify holders count is accurate (compare with explorer)

3. **NEW tab** (launches feed from nad.fun)
   - Endpoint: `https://api.nadapp.net/order/{sort}?page=N`
   - Verify pagination works past page 1 (this was reportedly broken)
   - Verify filter chips correctly include/exclude
   - Verify watchlist (star) persists across sessions

4. **TRENDING tab** (Monorail meme catalog)
   - Each card displays MCAP / HOLDERS / DEV % / CA
   - Verify MCAP = supply × price (from Monorail's `/v2/token/{addr}`)
   - Verify DEV % is creator's current holdings / total_supply × 100
     - Calls `/profile/tokens/created/{creator}` to get all their tokens
     - Matches each token by `token_info.token_id`
     - Uses `balance_info.balance` ÷ `market_info.total_supply`
   - Verify CTO badge appears only on tokens flagged by nad.fun
   - Verify NAD.FUN ✓ vs ⚠ OFF-PAD badge correctly reflects source
   - Verify LOAD MORE button actually loads next 30 + observer auto-triggers
   - Verify CA pill copies the FULL address (not the truncated display)

5. **WALLETS / TRACK tabs** (cross-map + subject watch)
   - Pulls portfolio via Monorail `/v2/wallet/{addr}/balances`
   - Verify USD totals match Monorail's wallet page
   - Verify overlap matrix on multi-wallet compare

6. **Hub gate** (`js/hub-gate.js`)
   - Requires 1M CHOGI balance via on-chain `balanceOf` call
   - Admin wallets bypass: HUB_ADMIN_WALLETS in `js/config.js`
   - Verify bypass works for: deployer, platform, hub treasury, dev wallet
   - Verify NON-admin with <1M CHOGI is correctly blocked
   - Verify mobile (no `window.ethereum`) shows wallet picker

7. **Token detail page** (`/hub/token?addr=X`)
   - Native TradingView chart from Monorail `/tv/history`
   - Universal swap module via Monorail aggregator with App ID `1176408161625`
   - Verify quote → execute flow works
   - Verify the 1% fee actually routes to `0x4601a7f665ca13c40d2236b8b9ff1e4b87226351`

## Recent commits (chronological)

| Commit | Description |
|---|---|
| `15d6844` | LIVE ticker fix: fetch ecosystem tokens individually |
| `892a70a` | Empty-state on NEW + tab overflow + LIVE label opacity |
| `1599e52` | Trending: tappable LOAD MORE button + observer |
| `396fb40` | TRENDING max nad.fun integration (CA, dev %, CTO, source flag) |
| `5060a7b` | Whitelist dev wallet 0x233C…eC84 |
| `3dcbadc` | New banner + CA copy pill |
| `564f5ba` | Wallet modal z-index above gate |
| `2b61157` | Mobile wallet picker on /hub + /hub/token |
| `9a2b5cd` | Trending cards: bigger PFPs + mobile click + readable text |
| `876d556` | Live engine: ticker + flashes + WS toasts |
| `0150a8e` | Fix closing `</title>` tag |
| `75b5c0d` | Hub tab renames + terminal visuals |

## Known-good APIs

- Monorail token detail: `https://api.monorail.xyz/v2/token/{addr}` (CORS open, requires non-default UA on some hosts)
- Monorail meme catalog: `https://api.monorail.xyz/v2/tokens/category/meme` (returns top 500)
- Monorail wallet: `https://api.monorail.xyz/v2/wallet/{addr}/balances`
- Monorail TV history: `https://api.monorail.xyz/tv/history?...`
- nad.fun token: `https://api.nadapp.net/token/{addr}`
- nad.fun creator's tokens: `https://api.nadapp.net/profile/tokens/created/{addr}?page=1&limit=50`
- nad.fun sorted listings: `https://api.nadapp.net/order/{market_cap|creation_time|latest_trade}?page=1&limit=24`

## Known-broken / suspected issues

- **NEW launches pagination**: user reported "first page working only" — may be fixed but verify
- **LIVE ticker session %change**: starts at +0.00% for everything; only meaningful after sustained tick activity. Consider switching to a real 24h change source if Monorail exposes one.
- **CA "fakes" issue**: user wants every TRENDING card to show CA so users can verify against the legit contract. Verify this is rendering on every card.

## Specific things to check that I might have introduced

1. Any sed-substitution that used unescaped `.` regex (a previous bug ate the `<` from `</title>`)
2. Any `<a>` tag styling regressions (default link blue/underline) inside cards
3. Any `:hover` styles NOT gated behind `@media (hover: hover)` on mobile (causes iOS double-tap-to-navigate bug)
4. Any z-index conflicts with the gate overlay (which is z-index 100000)
5. Any DOM elements with `data-token-addr` but missing from the LiveEngine flash query

## Acceptance criteria for ship

- All 5 hub tabs render real data within 10s of page load on mobile
- Prices match Monorail's web UI within ±1% (rounding differences ok)
- DEV % matches a manual on-chain `balanceOf(creator) / totalSupply` calculation for at least 3 sample tokens
- Mobile wallet picker correctly deep-links on iOS Safari
- Hub gate correctly blocks non-admin wallets with <1M CHOGI
- No JS errors in console on page load
