// whitelist-tokens.js — add stake-tokens to ChogiPayroll's whitelist
//
// Usage (PowerShell):
//   $env:DEPLOYER_PRIVATE_KEY = "0x..."   # must be the Payroll owner
//   node contracts/whitelist-tokens.js
//
// Edit TOKENS below to control which assets become stakeable.
// `weightPerWei` is in CHOGI-equivalent units per 1 wei of the token.
//   1e18 = 1:1 with CHOGI (1 token unit = 1 weight unit)
//   2e18 = 1 token unit counts as 2 weight units (preferred over CHOGI)
//   5e17 = 1 token unit counts as 0.5 weight units (less than CHOGI)
//
// IMPORTANT: every staker pays the 10K $CHOGI fee regardless of which
// token they're staking. The fee always flows in $CHOGI to the pool.
// What changes per-token is only the WEIGHT (your share of the pool).

import fs from 'fs';
import { ethers } from 'ethers';

const RPC_URL  = process.env.RPC_URL?.trim() || process.env.MONAD_RPC || 'https://rpc.monad.xyz';
const KEY_PATH = '/root/.monpad-deployer-key';

// ─── EDIT THIS LIST ────────────────────────────────────────────────
// Each entry: { addr, weight, label }
//   - addr:   ERC-20 contract on Monad mainnet
//   - weight: 18-decimal "weightPerWei" — see notes above
//   - label:  human-readable name for log output
//
// Strategy A (recommended) — sister memecoins at 1:1
const TOKENS = [
  {
    label:  'CHOG',
    addr:   '0x350035555E10d9AfAF1566AaebfCeD5BA6C27777',
    weight: '1000000000000000000', // 1e18 = 1:1 with CHOGI
  },
  // ── Strategy B example: WMON at ~rough USD parity ──
  // Uncomment if you want to enable WMON staking. Set the weight
  // based on roughly how many $CHOGI = 1 MON at deploy time.
  // E.g. if 1 MON = 200,000 $CHOGI, weight = 200000n * 1e18.
  // {
  //   label:  'WMON',
  //   addr:   '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A',
  //   weight: '200000000000000000000000', // 200,000 weight per WMON
  // },
];
// ────────────────────────────────────────────────────────────────────

const PAYROLL_ABI = [
  'function whitelistAsset(address token, uint128 weightPerWei)',
  'function delistAsset(address token)',
  'function assets(address) view returns (bool accepted, uint128 weightPerWei, uint256 totalDeposited, uint256 strandedFees)',
  'function owner() view returns (address)',
];
const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

function loadAddresses() {
  const env = {
    PAYROLL: process.env.PAYROLL_ADDRESS,
  };
  if (env.PAYROLL) return env.PAYROLL;
  if (fs.existsSync('./deployed-addresses.json')) {
    const j = JSON.parse(fs.readFileSync('./deployed-addresses.json', 'utf8'));
    return j.contracts && j.contracts.ChogiPayroll;
  }
  return null;
}

function loadKey() {
  let pk = process.env.DEPLOYER_PRIVATE_KEY?.trim();
  if (!pk) {
    const keyPath = process.env.DEPLOYER_KEY_PATH?.trim() || KEY_PATH;
    if (!fs.existsSync(keyPath)) {
      throw new Error('Set $env:DEPLOYER_PRIVATE_KEY = "0x..." or place key at ' + KEY_PATH);
    }
    pk = fs.readFileSync(keyPath, 'utf8').trim();
  }
  if (!pk.startsWith('0x')) pk = '0x' + pk;
  return pk;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log(' 🪙 CHOGI · WHITELIST-TOKENS · ChogiPayroll');
  console.log('═══════════════════════════════════════════════════════');

  const payrollAddr = loadAddresses();
  if (!payrollAddr) throw new Error('No Payroll address. Run deploy-all.js first or set $env:PAYROLL_ADDRESS');

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(loadKey(), provider);
  const payroll  = new ethers.Contract(payrollAddr, PAYROLL_ABI, wallet);

  const network = await provider.getNetwork();
  if (Number(network.chainId) !== 143) throw new Error(`Wrong chain: ${network.chainId}`);
  const owner = await payroll.owner();
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(`Wallet ${wallet.address} is NOT the Payroll owner (${owner})`);
  }

  const bal = Number(ethers.formatEther(await provider.getBalance(wallet.address)));
  console.log(`Payroll:  ${payrollAddr}`);
  console.log(`Wallet:   ${wallet.address}`);
  console.log(`Balance:  ${bal.toFixed(4)} MON`);
  console.log(`Tokens:   ${TOKENS.length} to process`);
  console.log('═══════════════════════════════════════════════════════');

  if (TOKENS.length === 0) {
    console.log('\n(no tokens in TOKENS array — edit this script to add some)');
    return;
  }

  let added = 0, skipped = 0, failed = 0;

  for (const t of TOKENS) {
    console.log(`\n[${t.label}] ${t.addr}`);
    if (!/^0x[a-fA-F0-9]{40}$/.test(t.addr)) {
      console.log('  🔴 invalid address — skipping');
      failed++; continue;
    }

    // detect token symbol/decimals (sanity check it's a real ERC-20)
    try {
      const erc20 = new ethers.Contract(t.addr, ERC20_ABI, provider);
      const sym = await erc20.symbol();
      const dec = Number(await erc20.decimals());
      console.log(`  symbol: ${sym} · decimals: ${dec}`);
      if (sym.toUpperCase() !== t.label.toUpperCase()) {
        console.log(`  ⚠️  on-chain symbol "${sym}" doesn't match label "${t.label}" — proceeding anyway`);
      }
    } catch (e) {
      console.log(`  ⚠️  couldn't read token metadata: ${e.shortMessage || e.message}`);
    }

    // already accepted at the desired weight?
    const cur = await payroll.assets(t.addr);
    if (cur.accepted && cur.weightPerWei.toString() === t.weight) {
      console.log(`  ✅ already whitelisted at weight ${t.weight} — skipping`);
      skipped++; continue;
    }

    if (cur.accepted) {
      console.log(`  ↻ updating weight: ${cur.weightPerWei.toString()} → ${t.weight}`);
    } else {
      console.log(`  + adding new asset at weight ${t.weight}`);
    }

    try {
      const tx = await payroll.whitelistAsset(t.addr, t.weight);
      console.log(`  📡 tx: ${tx.hash}`);
      const rec = await tx.wait();
      if (rec.status !== 1) throw new Error('reverted');
      console.log(`  ✅ confirmed (block ${rec.blockNumber})`);
      added++;
    } catch (e) {
      console.log(`  💥 failed: ${e.shortMessage || e.message}`);
      failed++;
    }
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(` ✅ DONE · added/updated: ${added} · already-set: ${skipped} · failed: ${failed}`);
  console.log('═══════════════════════════════════════════════════════');
  console.log(`\nVerify: https://monadvision.com/address/${payrollAddr}#assets`);
  console.log('Frontend dropdown auto-refreshes once you reload /payroll.');
}

main().catch((e) => {
  console.error('\n💥 whitelist failed:', e?.message || e);
  process.exit(1);
});
