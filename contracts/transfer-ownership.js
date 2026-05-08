// transfer-ownership.js
// Transfer ownership of ChogiSwapBurner + ChogiLabSubjects to the treasury wallet.
// Reads /root/.monpad-deployer-key (current owner). Calls transferOwnership() on both.

import fs from 'fs';
import { ethers } from 'ethers';

const RPC_URL  = process.env.RPC_URL?.trim() || 'https://rpc.monad.xyz';
const KEY_PATH = '/root/.monpad-deployer-key';
const NEW_OWNER = '0xB9d4B73bE18914c6d64Bee65a806648370be467f';

const SWAP_ADDR    = '0x9Db6552ab771d57E108c77371c128FCc466291e9'; // ChogiSwapBurner v2 deployed 2026-05-08
const NFT_ADDR     = '0xe753780772c1EAA676accA32e6030B346faF1C0F'; // ChogiLabSubjects v2 deployed 2026-05-08
const PAYROLL_ADDR = '0x062E18beceF54077E6325B415aB74522d64D3af7'; // ChogiPayroll deployed 2026-05-08

const ABI = [
  'function owner() view returns (address)',
  'function transferOwnership(address newOwner)',
];

async function transferOne(label, addr, wallet) {
  console.log(`\n[${label}] ${addr}`);
  const c = new ethers.Contract(addr, ABI, wallet);
  const currentOwner = await c.owner();
  console.log(`  current owner: ${currentOwner}`);
  if (currentOwner.toLowerCase() === NEW_OWNER.toLowerCase()) {
    console.log(`  ✓ already owned by treasury, skipping`);
    return;
  }
  if (currentOwner.toLowerCase() !== wallet.address.toLowerCase()) {
    console.log(`  🔴 wallet (${wallet.address}) is NOT the current owner — cannot transfer`);
    return;
  }
  console.log(`  → transferring to: ${NEW_OWNER}`);
  const tx = await c.transferOwnership(NEW_OWNER);
  console.log(`  📡 tx: ${tx.hash}`);
  const rec = await tx.wait();
  if (rec.status !== 1) throw new Error(`tx reverted on ${label}`);
  console.log(`  ✅ confirmed (block ${rec.blockNumber})`);
  // verify
  const newOwner = await c.owner();
  console.log(`  verified new owner: ${newOwner}`);
}

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log(' 🔑 TRANSFER OWNERSHIP → Treasury');
  console.log('═══════════════════════════════════════════════════════');

  // Priority: DEPLOYER_PRIVATE_KEY env var → DEPLOYER_KEY_PATH env var → /root/.monpad-deployer-key
  let pk = process.env.DEPLOYER_PRIVATE_KEY?.trim();
  if (!pk) {
    const keyPath = process.env.DEPLOYER_KEY_PATH?.trim() || KEY_PATH;
    if (!fs.existsSync(keyPath)) {
      throw new Error('Set $env:DEPLOYER_PRIVATE_KEY = "0x..." or place key at ' + KEY_PATH);
    }
    pk = fs.readFileSync(keyPath, 'utf8').trim();
  }
  if (!pk.startsWith('0x')) pk = '0x' + pk;

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(pk, provider);
  const network  = await provider.getNetwork();
  if (Number(network.chainId) !== 143) throw new Error(`Wrong chain: ${network.chainId}`);

  const bal = Number(ethers.formatEther(await provider.getBalance(wallet.address)));
  console.log(`Wallet:    ${wallet.address}`);
  console.log(`Balance:   ${bal.toFixed(4)} MON`);
  console.log(`New owner: ${NEW_OWNER}`);
  console.log('═══════════════════════════════════════════════════════');

  await transferOne('SWAP',    SWAP_ADDR,    wallet);
  await transferOne('NFT',     NFT_ADDR,     wallet);
  await transferOne('PAYROLL', PAYROLL_ADDR, wallet);

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(' ✅ DONE · treasury now owns all three contracts');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`SwapBurner:   https://monadexplorer.com/address/${SWAP_ADDR}`);
  console.log(`LabSubjects:  https://monadexplorer.com/address/${NFT_ADDR}`);
  console.log(`Payroll:      https://monadexplorer.com/address/${PAYROLL_ADDR}`);
  console.log('');
}

main().catch((e) => {
  console.error('\n💥 transfer failed:', e?.message || e);
  process.exit(1);
});
