// verify-all.js — verify deployed contracts on Monad Explorer via Sourcify
// Sourcify propagates to MonadVision + Monadscan + Socialscan with one call.
//
// Usage:
//   cd C:\Users\samah\Desktop\chogi\chogi-main
//   node contracts/verify-all.js
//
// Reads addresses from deployed-addresses.json (or override via env vars).

import fs from 'fs';
import path from 'path';
import solc from 'solc';

// Monad mainnet has its own Sourcify-compatible endpoint hosted by BlockVision.
// The public sourcify.dev server doesn't index chain 143.
const SOURCIFY = 'https://sourcify-api-monad.blockvision.org';
const CHAIN_ID = '143'; // Monad mainnet
const CONTRACTS_DIR = './contracts';

// pull addresses from deployed-addresses.json or env vars
function loadAddresses() {
  const out = {};
  const envOverrides = {
    ChogiSwapBurner:  process.env.SWAP_BURNER_ADDRESS,
    ChogiLabSubjects: process.env.NFT_ADDRESS,
    ChogiPayroll:     process.env.PAYROLL_ADDRESS,
  };
  if (fs.existsSync('./deployed-addresses.json')) {
    const j = JSON.parse(fs.readFileSync('./deployed-addresses.json', 'utf8'));
    Object.assign(out, j.contracts || {});
  }
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v) out[k] = v;
  }
  return out;
}

function compileWithMetadata(filename, sourceCode) {
  const input = {
    language: 'Solidity',
    sources: { [filename]: { content: sourceCode } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        '*': { '*': ['abi', 'evm.bytecode.object', 'metadata'] }
      },
      evmVersion: 'paris',
    }
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  if (out.errors && out.errors.some(e => e.severity === 'error')) {
    throw new Error('compile failed for ' + filename);
  }
  // pick the contract whose name matches the filename
  const contractName = filename.replace('.sol', '');
  const c = out.contracts[filename][contractName];
  if (!c) throw new Error('contract ' + contractName + ' not found in ' + filename);
  return {
    metadata: c.metadata,            // JSON string
    bytecode: '0x' + c.evm.bytecode.object,
  };
}

async function verifyOne(label, filename, address) {
  console.log(`\n[${label}] verifying ${filename} at ${address}…`);
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    console.log(`  ⚠️  no valid address — skipping`);
    return;
  }

  // 1. check if already verified
  try {
    const r = await fetch(`${SOURCIFY}/check-by-addresses?addresses=${address}&chainIds=${CHAIN_ID}`);
    const j = await r.json();
    const status = j[0] && j[0].status;
    if (status === 'perfect' || status === 'partial') {
      console.log(`  ✅ already ${status}-verified · skipping`);
      return;
    }
  } catch (e) { /* fall through to verify */ }

  // 2. compile to get metadata
  const src = fs.readFileSync(path.join(CONTRACTS_DIR, filename), 'utf8');
  const { metadata } = compileWithMetadata(filename, src);

  // 3. POST to Sourcify
  const body = {
    address,
    chain: CHAIN_ID,
    files: {
      'metadata.json': metadata,
      [filename]: src
    }
  };

  const res = await fetch(`${SOURCIFY}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (res.ok && data.result && data.result.length > 0 && data.result[0].status) {
    const status = data.result[0].status;
    if (status === 'perfect' || status === 'partial') {
      console.log(`  ✅ verified (${status})`);
      console.log(`     https://monadvision.com/address/${address}`);
      console.log(`     https://repo.sourcify.dev/contracts/${status === 'perfect' ? 'full_match' : 'partial_match'}/${CHAIN_ID}/${address}/`);
    } else {
      console.log(`  ⚠️  ${status}: ${data.result[0].message || ''}`);
    }
  } else {
    console.log(`  💥 verification failed (${res.status})`);
    console.log(`     ${JSON.stringify(data, null, 2).slice(0, 500)}`);
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log(' 🔍 CHOGI · VERIFY-ALL · Sourcify → Monad Explorer');
  console.log('═══════════════════════════════════════════════════════');

  const addrs = loadAddresses();
  if (Object.keys(addrs).length === 0) {
    throw new Error('No addresses found. Run deploy-all.js first or set SWAP_BURNER_ADDRESS / NFT_ADDRESS / PAYROLL_ADDRESS env vars.');
  }
  console.log('Addresses:');
  for (const [k, v] of Object.entries(addrs)) console.log(`  ${k.padEnd(18)} ${v}`);
  console.log('═══════════════════════════════════════════════════════');

  await verifyOne('SWAP',    'ChogiSwapBurner.sol',  addrs.ChogiSwapBurner);
  await verifyOne('NFT',     'ChogiLabSubjects.sol', addrs.ChogiLabSubjects);
  await verifyOne('PAYROLL', 'ChogiPayroll.sol',     addrs.ChogiPayroll);

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(' ✅ DONE');
  console.log(' Visit each address on https://monadvision.com to confirm.');
  console.log(' Sourcify auto-propagates to Monadscan + Socialscan too.');
  console.log('═══════════════════════════════════════════════════════');
}

main().catch((e) => {
  console.error('\n💥 verify failed:', e?.message || e);
  process.exit(1);
});
