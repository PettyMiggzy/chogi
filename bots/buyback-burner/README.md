# CHOGI BUYBACK BURNER 🔥

PM2 bot that drains your Monorail fee wallet into $CHOGI buybacks +
burns on a 10-minute cadence.

## What it does, in order

1. Read all token balances of the treasury wallet via Monorail's
   `/v2/wallet/{addr}/balances`.
2. For every non-MON, non-CHOGI token worth more than `DUST_USD_FLOOR`,
   build a `/v4/quote` to swap it → MON, sign, broadcast.
3. After sweeps complete, top up `OPS_RESERVE_MON` and check if there's
   enough excess MON to fire a burn (`BURN_THRESHOLD_MON`).
4. If yes, quote MON → CHOGI via Monorail, sign, broadcast.
5. Transfer the **entire** CHOGI balance of the treasury (bought +
   directly-received) to `0x000000000000000000000000000000000000dEaD`.
6. Append the burn event to `burn-stats.json` for the dashboard to read.

## Deploy on the droplet (138.68.248.211)

```bash
ssh root@138.68.248.211

# Clone (or pull) the repo, then:
mkdir -p /root/chogi-bots
cd /root/chogi-bots
git clone https://github.com/PettyMiggzy/chogi.git temp || (cd temp && git pull)
cp -r temp/bots/buyback-burner ./
cd buyback-burner

# Install deps
npm install --production

# Configure env
cp .env.example .env
nano .env        # Keep ARMED=false at first. Leave PRIVATE_KEY blank.

# First test — DRY RUN
npm run dry
# Watch logs scroll. Verify the snapshot, the "sweep" intents, the
# "MON → CHOGI buyback quote" line. Should make sense.
# Hit Ctrl+C after 1-2 ticks (each is 10 min).

# When ready to go live:
# 1. Stop dry run
# 2. Edit .env: set PRIVATE_KEY=0x... and ARMED=true
# 3. Verify wallet address matches TREASURY_ADDR
# 4. Fund wallet with ~10 MON for gas (gas is the only thing it can lose)
# 5. Launch under PM2:

pm2 start ecosystem.config.cjs
pm2 save
pm2 logs chogi-buyback-burner
```

## Files written during operation

- `burn-stats.json` — aggregated lifetime burned amount, last burn tx, etc.
- `burn-log.jsonl` — append-only event log, one JSON per line.
- `/var/log/chogi-buyback-burner.{out,err}.log` — PM2 stdout/stderr.

## Safety notes

- **Dry-run by default.** `ARMED=false` is the safe default. Bot will
  log every action it WOULD take but sign nothing.
- **Single-purpose wallet.** Only put a hot key on the droplet if the
  wallet's job is exclusively receiving fees + autoburn. Don't put a
  cold treasury key here. If the droplet is compromised, all fees in
  the wallet at that moment are at risk.
- **Sweep wallets manually if it accumulates.** If for some reason
  burns aren't firing (e.g. low MON balance never hitting threshold),
  the wallet's content can be swept off-bot anytime.
- **Slippage tolerance is 3% by default.** Aggressive for a hot bot but
  reasonable given how thin some long-tail tokens are. Tune via
  `SLIPPAGE_BPS` env var.

## Public stats endpoint (optional)

If you want `chogi.xyz/burn` to show lifetime burned, set up a tiny
nginx static block pointing at `burn-stats.json`:

```nginx
location /burn-stats.json {
  alias /root/chogi-bots/buyback-burner/burn-stats.json;
  add_header Access-Control-Allow-Origin *;
  add_header Cache-Control "public, max-age=60";
}
```

Then the hub can `fetch('https://api.monpad.net/burn-stats.json')`
(or wherever your nginx serves) and display the counter.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "Monorail: no valid routes found" on a fee token | Long-tail token has zero liquidity | Skip — bot logs and moves on |
| Swap reverts on-chain | Slippage too tight for a thin pool | Raise SLIPPAGE_BPS (try 500 = 5%) |
| Burn fires but stats unchanged | File permissions | `chmod 644 burn-stats.json` |
| `PRIVATE_KEY wallet != TREASURY_ADDR` error | Wrong key or wrong address | Fix one to match the other |

## Next-level (later)

- Replace bot with `ChogiBurnVault` contract — trustless flywheel,
  anyone can call `burn()`, no hot key on a droplet.
- Slack/Telegram webhook on every burn for marketing pings.
- Public `/burn` dashboard with live counter + recent burn feed.
