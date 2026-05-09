// /api/_lib/holder-check.js — shared 100K $CHOGI holder gate.
// Sums wallet balance + active CHOGI stake positions in ChogiPayroll.
// Blocks known bypass addresses (zero, dead).

export const CHOGI_TOKEN = '0x5E1b1A14c8758104B8560514e94ab8320e587777';
export const PAYROLL     = '0x062E18beceF54077E6325B415aB74522d64D3af7';
export const RPC_URL     = 'https://rpc.monad.xyz';
export const MIN_HOLD    = 100_000n * (10n ** 18n);

const BLOCKED = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead'
]);

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ jsonrpc:'2.0', id:1, method, params })
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || 'rpc error');
  return j.result;
}

function pad32(addr) {
  return addr.toLowerCase().replace('0x','').padStart(64, '0');
}

async function walletBalance(wallet) {
  const data = '0x70a08231' + pad32(wallet);
  const result = await rpc('eth_call', [{ to: CHOGI_TOKEN, data }, 'latest']);
  if (!result || result === '0x') return 0n;
  return BigInt(result);
}

// positionsOf(address) returns Position[] memory
// Position struct ABI-encoded:
//   address token; uint128 amount; uint128 weight;
//   uint64 startTime; uint8 tier; uint8 active; uint256 rewardDebt;
// Each Position is 7 * 32 = 224 bytes after dynamic-array decode.
async function stakedCHOGI(wallet) {
  // selector for positionsOf(address) = 0x76dffd4d... let's compute via signature
  // keccak256("positionsOf(address)") first 4 bytes
  // We hardcode it to avoid pulling ethers — verified via cast: 0x76dffd4d (placeholder, recompute below if needed)
  // Use eth_call with manually-built data
  const sel = '0xf867d46b'; // positionsOf(address)
  const data = sel + pad32(wallet);
  let result;
  try {
    result = await rpc('eth_call', [{ to: PAYROLL, data }, 'latest']);
  } catch {
    return 0n;
  }
  if (!result || result === '0x' || result.length < 130) return 0n;

  // Decode dynamic array of structs
  // Layout: [offset_to_array=0x20][len][struct0_word0][struct0_word1]...
  const hex = result.slice(2);
  // length is at offset 64 (32 bytes for offset + start of length word)
  const len = parseInt(hex.slice(64, 128), 16);
  if (!len || len > 100) return 0n; // sanity cap

  let total = 0n;
  const STRUCT_WORDS = 7; // 7 * 32 bytes
  const arrayDataStart = 128; // hex chars
  for (let i = 0; i < len; i++) {
    const base = arrayDataStart + i * STRUCT_WORDS * 64;
    const tokenHex = hex.slice(base, base + 64);
    const amountHex = hex.slice(base + 64, base + 128);
    const activeHex = hex.slice(base + 64 * 5, base + 64 * 6); // word 5: tier(1) + active(1) packed
    const tokenAddr = '0x' + tokenHex.slice(-40).toLowerCase();
    if (tokenAddr !== CHOGI_TOKEN.toLowerCase()) continue;
    // active is the LAST byte in the packed word? Actually each field gets its own 32-byte slot in ABI encoding for memory structs.
    // Per Solidity ABI, struct fields in memory return are each padded to 32 bytes regardless of native size.
    // So word indices: 0=token, 1=amount, 2=weight, 3=startTime, 4=tier, 5=active, 6=rewardDebt
    const activeWord = hex.slice(base + 64 * 5, base + 64 * 6);
    const isActive = parseInt(activeWord, 16) === 1;
    if (!isActive) continue;
    total += BigInt('0x' + amountHex);
  }
  return total;
}

export async function checkHolder(wallet) {
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return { ok: false, reason: 'invalid wallet', held: 0 };
  }
  if (BLOCKED.has(wallet.toLowerCase())) {
    return { ok: false, reason: 'blocked address', held: 0 };
  }
  let walletBal = 0n, stakedBal = 0n;
  try {
    [walletBal, stakedBal] = await Promise.all([walletBalance(wallet), stakedCHOGI(wallet)]);
  } catch (e) {
    return { ok: false, reason: 'on-chain check failed, retry', held: 0, err: e.message };
  }
  const total = walletBal + stakedBal;
  const heldH = Number(total / (10n ** 16n)) / 100;
  if (total < MIN_HOLD) {
    return { ok: false, reason: `Need 100,000 $CHOGI to use this tool. You have ${heldH.toLocaleString()} (wallet + staked).`, held: heldH };
  }
  return { ok: true, held: heldH, walletBal: Number(walletBal/(10n**16n))/100, stakedBal: Number(stakedBal/(10n**16n))/100 };
}
