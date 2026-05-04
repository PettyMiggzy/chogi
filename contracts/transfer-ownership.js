// transfer-ownership.js
// Transfer ownership of ChogiSwapBurner + ChogiLabSubjects to the treasury wallet.
// Reads /root/.monpad-deployer-key (current owner). Calls transferOwnership() on both.

import fs from 'fs';
import { ethers } from 'ethers';

const RPC_URL  = process.env.RPC_URL?.trim() || 'https://rpc.monad.xyz';
const KEY_PATH = '/root/.monpad-deployer-key';
const NEW_OWNER = '0xB9d4B73bE18914c6d64Bee65a806648370be467f';

const SWAP_ADDR = '0x9D386e1728Ba226C4bBC792dbFb676CE798174E2';
const NFT_ADDR  = '0xF71AC6c411f278929eaE575AC16496cde9dc2665';

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

  if (!fs.existsSync(KEY_PATH)) throw new Error(`Key not found: ${KEY_PATH}`);
  let pk = fs.readFileSync(KEY_PATH, 'utf8').trim();
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

  await transferOne('SWAP', SWAP_ADDR, wallet);
  await transferOne('NFT',  NFT_ADDR,  wallet);

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(' ✅ DONE · treasury now owns both contracts');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`SwapBurner:  https://monadexplorer.com/address/${SWAP_ADDR}`);
  console.log(`LabSubjects: https://monadexplorer.com/address/${NFT_ADDR}`);
  console.log('');
}

main().catch((e) => {
  console.error('\n💥 transfer failed:', e?.message || e);
  process.exit(1);
});
