#!/usr/bin/env node
// flip-soulbound.js — flip ChogiLabSubjects from soulbound to transferable
// Reads deployer key from /root/.monpad-deployer-key (same convention as deploy-all.js)
// Run: node contracts/flip-soulbound.js [true|false]
//   default false (transferable)

import 'dotenv/config';
import fs from 'fs';
import { ethers } from 'ethers';

const KEY_PATH = '/root/.monpad-deployer-key';
const NFT_CONTRACT = '0xe753780772c1EAA676accA32e6030B346faF1C0F'; // ChogiLabSubjects v2 deployed 2026-05-08
const RPC = process.env.MONAD_RPC || 'https://rpc.monad.xyz';

// CLI arg: pass "true" to lock back to soulbound, otherwise unlocks
const target = (process.argv[2] || 'false').toLowerCase();
const setTo = target === 'true';

const ABI = [
  'function setSoulbound(bool v) external',
  'function soulbound() view returns (bool)',
  'function owner() view returns (address)',
];

async function main() {
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

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(pk, provider);
  const c = new ethers.Contract(NFT_CONTRACT, ABI, wallet);

  console.log('NFT contract :', NFT_CONTRACT);
  console.log('Deployer     :', wallet.address);

  const [currentOwner, currentBound] = await Promise.all([c.owner(), c.soulbound()]);
  console.log('Contract owner :', currentOwner);
  console.log('Currently soulbound:', currentBound);
  console.log('Target soulbound  :', setTo);

  if (currentOwner.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(`Wallet is not contract owner. Expected ${currentOwner}, got ${wallet.address}`);
  }
  if (currentBound === setTo) {
    console.log('Already in target state. Nothing to do.');
    return;
  }

  console.log('\nSending tx...');
  const tx = await c.setSoulbound(setTo);
  console.log('tx hash:', tx.hash);
  console.log('https://monadexplorer.com/tx/' + tx.hash);

  const r = await tx.wait();
  console.log(`\n✓ Confirmed in block ${r.blockNumber}`);

  const after = await c.soulbound();
  console.log('Soulbound is now:', after);
  console.log(after
    ? '\nNFTs are LOCKED. Cannot be transferred or sold.'
    : '\nNFTs are TRANSFERABLE. Holders can list on Magic Eden / Poply / etc.');
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
