// deploy-all.js
// Compile + deploy both Chogi contracts (ChogiSwapBurner + ChogiLabSubjects)
// directly to Monad mainnet using a private key on disk.
//
// Usage:
//   cd /root/ChogiBuyBot
//   wget -q -O deploy-all.js https://raw.githubusercontent.com/PettyMiggzy/chogi/main/contracts/deploy-all.js
//   wget -q -O contracts/ChogiSwapBurner.sol https://raw.githubusercontent.com/PettyMiggzy/chogi/main/contracts/ChogiSwapBurner.sol
//   wget -q -O contracts/ChogiLabSubjects.sol https://raw.githubusercontent.com/PettyMiggzy/chogi/main/contracts/ChogiLabSubjects.sol
//   npm i -D solc
//   node deploy-all.js
//
// Reads /root/.monpad-deployer-key automatically. Writes addresses to
// deployed-addresses.json so we can patch swap.html / mint.html with them.

import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import solc from 'solc';

const RPC_URL = process.env.RPC_URL?.trim() || 'https://rpc.monad.xyz';
const KEY_PATH = '/root/.monpad-deployer-key';
const CONTRACTS_DIR = './contracts';
const OUT_FILE = './deployed-addresses.json';

function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function ts() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

function compile(filename, sourceCode) {
  console.log(`  ⚙  compiling ${filename}…`);
  const input = {
    language: 'Solidity',
    sources: { [filename]: { content: sourceCode } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        '*': { '*': ['abi', 'evm.bytecode.object'] }
      },
      evmVersion: 'paris',
    }
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  if (out.errors) {
    const fatal = out.errors.filter(e => e.severity === 'error');
    out.errors.forEach(e => console.log('  ' + (e.severity === 'error' ? '🔴' : '⚠️') + ' ' + e.formattedMessage.trim().split('\n')[0]));
    if (fatal.length) throw new Error(`Compile failed in ${filename}`);
  }
  const contractName = Object.keys(out.contracts[filename])[0];
  const c = out.contracts[filename][contractName];
  if (!c.evm.bytecode.object) throw new Error(`No bytecode for ${contractName}`);
  console.log(`  ✓ ${contractName} compiled (${(c.evm.bytecode.object.length/2/1024).toFixed(1)} KB)`);
  return { name: contractName, abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

async function deployOne(wallet, artifact, label) {
  console.log(`\n[${label}] deploying ${artifact.name}…`);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);

  // estimate gas, add 20% headroom
  const deployTx = await factory.getDeployTransaction();
  const est = await wallet.provider.estimateGas({ ...deployTx, from: wallet.address });
  const gasLimit = (est * 120n) / 100n;
  console.log(`  est gas: ${est} · using: ${gasLimit}`);

  const contract = await factory.deploy({ gasLimit });
  const tx = contract.deploymentTransaction();
  console.log(`  📡 tx: ${tx.hash}`);
  console.log(`  ⏳ waiting for confirmation…`);
  await contract.waitForDeployment();
  const addr = await contract.getAddress();
  console.log(`  ✅ ${artifact.name} deployed at: ${addr}`);
  console.log(`     https://monadexplorer.com/address/${addr}`);
  return addr;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log(' 🧪 CHOGI · DEPLOY-ALL · Monad mainnet');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`Time:    ${ts()}`);
  console.log(`RPC:     ${RPC_URL}`);

  // ─── load key ─────────────────────────────────────────────
  // Priority: DEPLOYER_PRIVATE_KEY env var → DEPLOYER_KEY_PATH env var → /root/.monpad-deployer-key
  let pk = process.env.DEPLOYER_PRIVATE_KEY?.trim();
  if (!pk) {
    const keyPath = process.env.DEPLOYER_KEY_PATH?.trim() || KEY_PATH;
    if (!fs.existsSync(keyPath)) {
      throw new Error(
        'No deployer key found.\n' +
        '  Option A: set $env:DEPLOYER_PRIVATE_KEY = "0x..." (PowerShell)\n' +
        '  Option B: set DEPLOYER_KEY_PATH to a file containing the key\n' +
        '  Option C: place the key at ' + KEY_PATH
      );
    }
    pk = fs.readFileSync(keyPath, 'utf8').trim();
  }
  if (!pk.startsWith('0x')) pk = '0x' + pk;
  if (pk.length !== 66) throw new Error(`Bad private key length: ${pk.length} (expected 66 incl. 0x)`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(pk, provider);

  // sanity
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== 143) {
    throw new Error(`Wrong chain: got ${network.chainId}, expected 143 (Monad mainnet)`);
  }
  const balance = await provider.getBalance(wallet.address);
  const balMon  = Number(ethers.formatEther(balance));

  console.log(`Chain:   Monad mainnet (143)  ✓`);
  console.log(`Wallet:  ${wallet.address}`);
  console.log(`Balance: ${balMon.toFixed(4)} MON`);
  if (balMon < 0.5) {
    throw new Error(`Need at least 0.5 MON for both deploys, have ${balMon.toFixed(4)}`);
  }
  console.log('═══════════════════════════════════════════════════════');

  // ─── compile all contracts ────────────────────────────────
  console.log('\n[1/4] compiling contracts');
  const swapSrc  = fs.readFileSync(path.join(CONTRACTS_DIR, 'ChogiSwapBurner.sol'),  'utf8');
  const nftSrc   = fs.readFileSync(path.join(CONTRACTS_DIR, 'ChogiLabSubjects.sol'), 'utf8');
  const payrollSrc = fs.readFileSync(path.join(CONTRACTS_DIR, 'ChogiPayroll.sol'),       'utf8');
  const swapArt  = compile('ChogiSwapBurner.sol',  swapSrc);
  const nftArt   = compile('ChogiLabSubjects.sol', nftSrc);
  const payrollArt = compile('ChogiPayroll.sol',       payrollSrc);

  // ─── deploy ChogiSwapBurner ───────────────────────────────
  console.log('\n[2/4] deploying ChogiSwapBurner');
  const swapAddr = await deployOne(wallet, swapArt, 'SWAP');

  // ─── deploy ChogiLabSubjects ──────────────────────────────
  console.log('\n[3/4] deploying ChogiLabSubjects');
  const nftAddr = await deployOne(wallet, nftArt, 'NFT');

  // ─── deploy ChogiPayroll (staking) ──────────────────────────
  console.log('\n[4/4] deploying ChogiPayroll');
  const payrollAddr = await deployOne(wallet, payrollArt, 'PAYROLL');

  // ─── post-deploy wiring ───────────────────────────────────
  console.log('\n🔗 wiring:');
  try {
    const payroll = new ethers.Contract(payrollAddr, payrollArt.abi, wallet);
    const setSwap = await payroll.setSwapBurner(swapAddr);
    console.log(`  payroll.setSwapBurner(${swapAddr}) -> ${setSwap.hash}`);
    await setSwap.wait();
    const setNft = await payroll.setLabSubjectsNft(nftAddr);
    console.log(`  payroll.setLabSubjectsNft(${nftAddr}) -> ${setNft.hash}`);
    await setNft.wait();

    const burner = new ethers.Contract(swapAddr, swapArt.abi, wallet);
    // route 50 bps (0.50%) of the 1% burn fee to the payroll; remaining 50 bps still burns
    const setPayroll = await burner.setPayroll(payrollAddr, 50);
    console.log(`  burner.setPayroll(${payrollAddr}, 50) -> ${setPayroll.hash}`);
    await setPayroll.wait();
  } catch (e) {
    console.warn(`  ⚠️ wiring failed: ${e?.shortMessage || e?.message || e}`);
    console.warn('     run admin txs manually after deploy');
  }

  // ─── save addresses ───────────────────────────────────────
  const result = {
    deployedAt: ts(),
    chain: 'monad-mainnet',
    chainId: 143,
    deployer: wallet.address,
    contracts: {
      ChogiSwapBurner:  swapAddr,
      ChogiLabSubjects: nftAddr,
      ChogiPayroll:       payrollAddr,
    }
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2));
  console.log(`\n📝 saved to ${OUT_FILE}\n`);

  console.log('═══════════════════════════════════════════════════════');
  console.log(' ✅ ALL CONTRACTS DEPLOYED');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`ChogiSwapBurner:  ${swapAddr}`);
  console.log(`ChogiLabSubjects: ${nftAddr}`);
  console.log(`ChogiPayroll:       ${payrollAddr}`);
  console.log('═══════════════════════════════════════════════════════');
  console.log('\nNext steps:');
  console.log('  1. Paste addresses into /js/config.js (PAYROLL_ADDRESS + SWAP_BURNER_ADDRESS)');
  console.log('  2. Set Vercel env CHOGI_NFT_ADDRESS to the NFT address above');
  console.log('  3. Verify all three contracts on Monad explorer');
  console.log('');
}

main().catch((e) => {
  console.error('\n💥 deploy failed:', e?.message || e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
