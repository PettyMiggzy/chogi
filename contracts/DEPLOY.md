# Chogi Lab Subjects · Deploy Guide

Burn-to-Mint NFT contract for $CHOGI. Soulbound by default. 5 tiers.

## What you're deploying

`contracts/ChogiLabSubjects.sol` — single-file ERC-721 with no external imports. No constructor args. Compiles clean on Solidity `^0.8.20`.

## Deploy via Remix (5-minute path)

1. Open https://remix.ethereum.org
2. Create a new file: `ChogiLabSubjects.sol`
3. Paste in the contents of `contracts/ChogiLabSubjects.sol`
4. **Compile tab** → Compiler `0.8.20` or higher → Compile
5. **Deploy tab** → Environment: **Injected Provider - MetaMask**
6. Make sure your wallet is on **Monad mainnet (chain 143)**. RPC `https://rpc.monad.xyz`
7. Make sure the deployer wallet has some MON for gas
8. Hit **Deploy**. Confirm the tx.
9. Copy the deployed contract address from the Deployed Contracts panel.

## Wire it into the site

After deploy, do these three things:

**1. Update `mint.html`**
Replace the placeholder address near the top of the inline `<script>`:
```js
var NFT_CONTRACT = '0x0000000000000000000000000000000000000000';
```
with your real address.

**2. Set Vercel env var** (for the metadata API)
- Vercel dashboard → chogi project → Settings → Environment Variables
- Add: `CHOGI_NFT_ADDRESS` = `0xYOUR_DEPLOYED_ADDRESS`
- Redeploy (or push a new commit).

**3. Verify the contract on monadexplorer.com** (optional but bullish)
Use Remix's "Verify Contract" plugin or Sourcify. Lets people read the
source from chain explorers and inspect tier costs / ownership / etc.

## Verify it works

After mint.html and the env var are updated:

1. Go to chogi.xyz/mint
2. Connect wallet
3. Pick a tier (try Common — 100K CHOGI)
4. Click APPROVE → confirm
5. Click MINT → confirm
6. After ~5–10 seconds, see the success message
7. Open `0xYOUR_NFT_ADDRESS/1` on monadexplorer — your token #1 is there
8. Check your wallet (MetaMask, Rabby) — the NFT should appear as a collectible

## Admin functions you have

You're the contract owner. From Remix or any EVM tool you can call:

- `setMintEnabled(bool)` — pause/resume minting
- `setSoulbound(bool)` — flip transferable on/off (start soulbound, can open later)
- `setTierCost(uint8 tier, uint256 cost)` — adjust burn cost per tier (in wei, 1e18 = 1 CHOGI)
- `setBaseURI(string)` — change metadata server (if migrating off chogi.xyz)
- `transferOwnership(address)` — hand admin to a multisig later

## Tier reference

| Tier | Index | Burn |
|---|---|---|
| COMMON     | 0 | 100,000   |
| UNCOMMON   | 1 | 500,000   |
| RARE       | 2 | 1,000,000 |
| EPIC       | 3 | 5,000,000 |
| LEGENDARY  | 4 | 10,000,000 |

All burns go straight to `0x000000000000000000000000000000000000dEaD`.

## Marketplace listing

Once the contract is deployed and a few NFTs are minted, the collection
will auto-appear on:

- **monadexplorer.com** (NFT view)
- **Magic Eden** (Monad section, if their indexer picks it up)
- **Poply**
- Your wallet (MetaMask, Rabby, Phantom EVM)

While it's soulbound (default), users can view but not list/sell. That's
the point — it's identity, not inventory.

To list a manual collection page on Magic Eden / Poply, submit through
their creator portals with the contract address + 1024×1024 banner +
description.

## Costs

- **Deploy gas:** ~3M gas (one-time, ~$1 worth of MON)
- **User mint gas:** ~150K gas per mint (~$0.05 worth of MON, plus the
  CHOGI burn cost)
- **You pay nothing per mint** — costs are on the minter

## Soulbound vs transferable

Right now the contract is soulbound. Effects:
- Users can mint freely, but cannot transfer / sell / list
- Magic Eden, Poply etc. will show the NFT but block listing
- This is genuinely novel and pushes "identity over speculation"

To make it transferable later: call `setSoulbound(false)`.
You can flip back if needed (within the same wallet that owns the contract).
