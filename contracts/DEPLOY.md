# 🧪 ChogiLabSubjects · Deploy Guide

ERC-721 Burn-to-Mint NFT for $CHOGI. Self-contained — no OpenZeppelin imports needed. Deploy via Remix in ~5 minutes.

## What it does

- Holders **burn $CHOGI** to mint a Lab Subject NFT
- 5 tiers — every mint sends tokens to `0x...dead` permanently
- **Soulbound by default** (non-transferable). Owner can flip to transferable later.
- Top 3 tiers capped (777 / 77 / 7) for scarcity. Caps can be lowered (never raised).

## Tier table

| Idx | Rarity | Burn cost | Cap |
|---|---|---|---|
| 0 | COMMON    |   100K $CHOGI | unlimited |
| 1 | UNCOMMON  |   500K $CHOGI | unlimited |
| 2 | RARE      |     1M $CHOGI | 777 |
| 3 | EPIC      |     5M $CHOGI | 77 |
| 4 | LEGENDARY |    10M $CHOGI | 7 |

## Deploy via Remix (5 minutes)

1. Go to https://remix.ethereum.org
2. New file → `ChogiLabSubjects.sol`
3. Paste contents of `contracts/ChogiLabSubjects.sol` from this repo
4. **Compiler** tab → Solidity `0.8.20` → click **Compile**
5. **Deploy & Run** tab:
   - Environment: **Injected Provider — MetaMask**
   - MetaMask must be on **Monad mainnet** (chain ID `143`)
   - Contract dropdown: `ChogiLabSubjects`
   - **Deploy** (no constructor args needed)
6. Confirm in MetaMask → wait for tx → copy the deployed address
7. Paste address into `js/mint-config.js` under `CONTRACT_ADDRESS`
8. Verify on monadexplorer.com:
   - Paste the source (single file, no flattening needed)
   - Compiler 0.8.20
   - Optimizer enabled, runs 200

## Owner controls (post-deploy)

| Function | What it does |
|---|---|
| `setMintEnabled(bool)` | Pause/resume minting |
| `setSoulbound(bool)` | Flip transferability (true = non-transferable) |
| `setBaseURI(string)` | Repoint metadata server |
| `setTierCost(tier, cost)` | Adjust burn cost per tier |
| `reduceTierCap(tier, newCap)` | Tighten scarcity. Cannot raise cap. |
| `transferOwnership(addr)` | Hand over admin |

## Default config

- **Soulbound:** `true` (non-transferable, identity-focused)
- **baseURI:** `https://chogi.xyz/api/metadata/`
- **Owner:** deployer wallet
- **Mint enabled:** `true`

If you want it transferable (Magic Eden / Poply secondary market support), call `setSoulbound(false)` after deploy.

## Metadata flow

The contract returns `tokenURI(id) = baseURI + tokenId`. Default baseURI points to `https://chogi.xyz/api/metadata/`. The Vercel serverless function at `api/metadata/[id].js` reads tier from chain and returns a JSON metadata blob conformant with the OpenSea / Magic Eden spec.

If you want decentralized metadata, pin the JSON + images to IPFS via Pinata, then `setBaseURI("ipfs://CID/")`.

## Frontend → contract address wiring

Once deployed, update **one place**:
```
js/mint-config.js → CONTRACT_ADDRESS = "0xYOUR_DEPLOYED_ADDRESS"
```
Then push. The mint page at `/mint` automatically reads tier costs, caps, and minted counts directly from the contract — no other config needed.

---

# ChogiSwapBurner · Deploy Guide

Wrapper contract that sits on top of SwapRouter02. Every swap routed
through it burns a configurable % of $CHOGI to dead address atomically.

## Deploy via Remix

1. Open https://remix.ethereum.org
2. New file: `ChogiSwapBurner.sol` → paste `contracts/ChogiSwapBurner.sol`
3. Compile with Solidity `0.8.20+`
4. Deploy tab → Injected Provider · MetaMask · Monad mainnet (chain 143)
5. Deployer wallet needs MON for gas
6. Hit Deploy. No constructor args.
7. Copy the deployed address.

The constructor automatically pre-approves SwapRouter02 to spend CHOGI
held by this contract (one-time, set in constructor for gas efficiency).

## Wire it into the site

**1. Update `swap.html`**
Find this line near the top of the inline `<script>`:
```js
var BURNER = '0x0000000000000000000000000000000000000000';
```
Replace with your deployed address. Push.

**2. Verify on monadexplorer.com** (optional)
Same Remix flow as the NFT contract. Lets people read source from explorers.

## Admin functions

You're the owner. Calls:

- `setBurnBps(uint16 bps)` — adjust burn % (default 100 = 1%, max 1000 = 10%).
  E.g. `setBurnBps(50)` = 0.50%. `setBurnBps(200)` = 2.00%.
- `transferOwnership(address)` — hand admin to multisig later.
- `refreshRouterApproval()` — anyone can call. Re-approves the
  hardcoded router for CHOGI in case allowance ever runs low.

Note: there's NO admin function to redirect funds, change the router,
or pause the contract. The router address and dead address are hardcoded.
This is intentional — minimal surface area, no rug vector.

## How users interact

**Buy MON → CHOGI:**
- User clicks BUY in chogi.xyz/swap, enters MON amount
- UI quotes via QuoterV2, shows expected CHOGI minus burn skim
- User confirms → contract receives MON via `payable`
- Contract calls SwapRouter02 with WMON→CHOGI, recipient = self
- Contract skims `burnBps/10000` of received CHOGI to dead
- Contract sends rest to user
- One transaction

**Sell CHOGI → MON:**
- User clicks SELL, enters CHOGI amount
- First time: approves CHOGI for the burner contract (one-time)
- Confirms sell → contract pulls CHOGI via transferFrom
- Contract skims `burnBps/10000` from input → dead
- Contract calls SwapRouter02 with remaining CHOGI → WMON
- Contract calls `WMON.withdraw()` to unwrap
- Contract forwards native MON to user via `.call`
- One swap tx (after first-time approve)

## Public counters

- `totalBurned()` — lifetime CHOGI burned by this contract
- `burnedByWallet(address)` — per-wallet contribution
- `swapsByWallet(address)` — per-wallet swap count
- `stats()` — returns (currentBurnBps, totalBurned)

The swap UI reads `stats()` to display the live engine burn meter.

## Upgrade path (later)

If we add support for other DEX routers (Crust, etc.), deploy a v2
ChogiSwapBurner and swap the BURNER address in swap.html. Old contract
remains usable — no migration needed.
