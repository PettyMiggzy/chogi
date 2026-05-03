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
