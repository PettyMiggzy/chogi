// /contracts/deploy-pets-boost.js
// One-shot deploy script for the new Chogi Pet + Boost ecosystem.
//
// Deploys (in order):
//   1. ChogiNftBoost      — boost distributor (no constructor args)
//   2. ChogiPets          — Pet NFT (signer + royaltyReceiver)
//   3. ChogiLabSubjectsV2 — Lab Subjects redeploy with royalty (royaltyReceiver)
//
// Then wires:
//   - ChogiPets.setNftBoost(boost)              → mint slice routes to pool
//   - ChogiNftBoost.addBoostNft(pets, true)     → bondable
//   - ChogiNftBoost.addBoostNft(labSubjectsV2, false)
//   - ChogiNftBoost.addBoostNft(LAB_V1_ADDR, false)  // grandfather v1 holders if any
//   - ChogiNftBoost.setTrustedMinter(pets, true)
//   - ChogiNftBoost.setTrustedMinter(labSubjectsV2, true)
//
// Usage:
//   PRIVATE_KEY=0x... node deploy-pets-boost.js
//
// Requires: ethers v6, solc compiled bytecode at ./build/ (run compile step first).

import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';

// ─── Config ──────────────────────────────────────────────────────
const RPC_URL          = process.env.RPC_URL          || 'https://testnet-rpc.monad.xyz';
const PRIVATE_KEY      = process.env.PRIVATE_KEY;
const SIGNER_ADDR      = process.env.SIGNER_ADDR      || process.env.PERMIT_SIGNER;
const ROYALTY_RECEIVER = process.env.ROYALTY_RECEIVER || '0x1646d1eE4A1EcAFefA7cF365234080B0db51EB4e';
const LAB_V1_ADDR      = process.env.LAB_V1_ADDR      || '0xe753780772c1EAA676accA32e6030B346faF1C0F';

if (!PRIVATE_KEY) throw new Error('Set PRIVATE_KEY env');
if (!SIGNER_ADDR)  throw new Error('Set SIGNER_ADDR (backend EIP-712 signer wallet)');

// ─── Helpers ─────────────────────────────────────────────────────
function loadArtifact(name) {
  const buildDir = path.join(process.cwd(), 'build');
  const abi  = JSON.parse(fs.readFileSync(path.join(buildDir, `${name}.abi.json`), 'utf8'));
  const bin  = fs.readFileSync(path.join(buildDir, `${name}.bin`),  'utf8').trim();
  return { abi, bytecode: '0x' + bin.replace(/^0x/, '') };
}

async function deploy(wallet, name, args = []) {
  const { abi, bytecode } = loadArtifact(name);
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  console.log(`→ deploying ${name}${args.length ? ' with ' + JSON.stringify(args) : ''}…`);
  const c = await factory.deploy(...args);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log(`  ✓ ${name} @ ${addr}`);
  return c;
}

async function tx(label, promise) {
  const t = await promise;
  console.log(`  → ${label} (tx ${t.hash})`);
  await t.wait();
  console.log(`  ✓ ${label}`);
}

// ─── Main ────────────────────────────────────────────────────────
async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log(`Deployer: ${wallet.address}`);
  console.log(`Network:  chainId ${(await provider.getNetwork()).chainId}`);
  console.log(`Royalty:  ${ROYALTY_RECEIVER}`);
  console.log(`Signer:   ${SIGNER_ADDR}`);
  console.log();

  // 1. NftBoost
  const boost = await deploy(wallet, 'ChogiNftBoost');
  const boostAddr = await boost.getAddress();

  // 2. Pets
  const pets = await deploy(wallet, 'ChogiPets', [SIGNER_ADDR, ROYALTY_RECEIVER]);
  const petsAddr = await pets.getAddress();

  // 3. LabSubjects v2
  const lab = await deploy(wallet, 'ChogiLabSubjectsV2', [ROYALTY_RECEIVER]);
  const labAddr = await lab.getAddress();

  console.log();
  console.log('Wiring contracts…');

  // Pets → NftBoost
  await tx('Pets.setNftBoost(boost)', pets.setNftBoost(boostAddr));

  // Boost: register all NFT collections
  await tx('Boost.addBoostNft(Pets, bondable=true)',  boost.addBoostNft(petsAddr, true));
  await tx('Boost.addBoostNft(LabV2, bondable=false)', boost.addBoostNft(labAddr, false));
  if (LAB_V1_ADDR && LAB_V1_ADDR !== ethers.ZeroAddress) {
    await tx('Boost.addBoostNft(LabV1, bondable=false)', boost.addBoostNft(LAB_V1_ADDR, false));
  }

  // Boost: trust Pet contract to fund pool from mint
  await tx('Boost.setTrustedMinter(Pets, true)', boost.setTrustedMinter(petsAddr, true));

  console.log();
  console.log('═══════════════════════════════════════════════════════');
  console.log('DEPLOY COMPLETE');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`ChogiNftBoost:      ${boostAddr}`);
  console.log(`ChogiPets:          ${petsAddr}`);
  console.log(`ChogiLabSubjectsV2: ${labAddr}`);
  console.log();
  console.log('Save these addresses + verify on MonadScan.');
  console.log('Update site env / shared.js to point at the new addresses.');
}

main().catch(err => { console.error(err); process.exit(1); });
