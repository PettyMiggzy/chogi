// /api/pet-mint-permit.js
// EIP-712 permit signer for ChogiPets mints.
//
// Backend authorizes mints by signing a permit the user submits to the contract.
// Two paths:
//   1. SNAPSHOT CLAIM — wallet is in the launch snapshot of existing hatched
//      Supabase users → mintCost = 0 (free claim). Limit 1 per snapshot wallet.
//   2. STANDARD MINT — anyone else → mintCost = 100,000 $CHOGI (configurable).
//
// Permit is bound to (to, tier, generation, traitHash, mintCost, nonce, deadline)
// and signed by SIGNER_PRIVATE_KEY. Contract verifies recovery == signer addr.
//
// Endpoints:
//   POST /api/pet-mint-permit  body: { wallet, claimType?: 'snapshot' | 'standard' }
//     → returns { permit, signature }
//
// Env required:
//   SIGNER_PRIVATE_KEY            — backend signing key (NEVER share)
//   CHOGI_PETS_ADDRESS            — deployed ChogiPets contract address
//   MONAD_CHAIN_ID                — Monad mainnet chain id
//   SUPABASE_URL, SUPABASE_SERVICE_KEY — for snapshot lookup + claim tracking

import { ethers } from 'ethers';
import { isBlocked } from './blocklist.js';

// ─── Config ──────────────────────────────────────────────────────
const SIGNER_PK    = process.env.SIGNER_PRIVATE_KEY;
const PETS_ADDR    = process.env.CHOGI_PETS_ADDRESS;
const CHAIN_ID     = Number(process.env.MONAD_CHAIN_ID || 10143);
const STANDARD_COST = 100_000n * 10n ** 18n;          // 100k $CHOGI
const PERMIT_TTL_S  = 30 * 60;                         // 30 minutes
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;

// EIP-712 domain (must match the contract's DOMAIN_SEPARATOR exactly)
const DOMAIN = () => ({
  name:    'ChogiPets',
  version: '1',
  chainId: CHAIN_ID,
  verifyingContract: PETS_ADDR
});

const TYPES = {
  Mint: [
    { name: 'to',         type: 'address' },
    { name: 'tier',       type: 'uint8'   },
    { name: 'generation', type: 'uint8'   },
    { name: 'traitHash',  type: 'bytes32' },
    { name: 'mintCost',   type: 'uint256' },
    { name: 'nonce',      type: 'uint256' },
    { name: 'deadline',   type: 'uint256' }
  ]
};

// ─── Trait derivation (deterministic from wallet + nonce) ────────
function deriveTraits(wallet, nonce) {
  // Hash wallet + nonce → seed → derive tier and trait blob.
  // Replace with whatever rarity logic the team wants.
  const seed = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [wallet, nonce])
  );
  // Simple weighted tier roll (90% common, 9% uncommon, 1% rare)
  const roll = Number(BigInt(seed) % 100n);
  let tier;
  if (roll < 90)      tier = 0; // common
  else if (roll < 99) tier = 1; // uncommon
  else                 tier = 2; // rare
  return { tier, generation: 0, traitHash: seed };
}

// ─── Snapshot lookup ─────────────────────────────────────────────
// Snapshot stored in a Supabase table chogi_pet_snapshot:
//   wallet (text PRIMARY KEY · lowercase) | claimed (bool, default false)
async function snapshotEligible(wallet) {
  const lower = wallet.toLowerCase();
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/chogi_pet_snapshot?wallet=eq.${lower}&select=wallet,claimed`,
    { headers: {
        apikey: SUPABASE_KEY,
        authorization: `Bearer ${SUPABASE_KEY}`
    }}
  );
  if (!r.ok) return { eligible: false, claimed: false };
  const rows = await r.json();
  if (!rows.length) return { eligible: false, claimed: false };
  return { eligible: true, claimed: !!rows[0].claimed };
}

async function markSnapshotClaimed(wallet) {
  const lower = wallet.toLowerCase();
  await fetch(`${SUPABASE_URL}/rest/v1/chogi_pet_snapshot?wallet=eq.${lower}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify({ claimed: true, claimed_at: new Date().toISOString() })
  });
}

// ─── Handler ─────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!SIGNER_PK || !PETS_ADDR) return res.status(500).json({ error: 'signer not configured' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'invalid json' }); }

  const { wallet, claimType } = body || {};
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return res.status(400).json({ error: 'invalid wallet' });
  }
  if (isBlocked(wallet)) {
    return res.status(403).json({ error: 'wallet blocked' });
  }

  // Determine path: snapshot claim or standard mint
  let mintCost = STANDARD_COST;
  let path     = 'standard';

  if (claimType === 'snapshot') {
    const { eligible, claimed } = await snapshotEligible(wallet);
    if (!eligible) return res.status(403).json({ error: 'wallet not in snapshot' });
    if (claimed)   return res.status(409).json({ error: 'snapshot claim already used' });
    mintCost = 0n;
    path     = 'snapshot';
  }

  // Generate permit fields
  const nonce       = BigInt('0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex'));
  const deadline    = BigInt(Math.floor(Date.now() / 1000) + PERMIT_TTL_S);
  const traits      = deriveTraits(wallet, nonce);

  const permit = {
    to:         wallet,
    tier:       traits.tier,
    generation: traits.generation,
    traitHash:  traits.traitHash,
    mintCost:   mintCost.toString(),
    nonce:      nonce.toString(),
    deadline:   deadline.toString()
  };

  // Sign EIP-712
  const signer = new ethers.Wallet(SIGNER_PK);
  const signature = await signer.signTypedData(DOMAIN(), TYPES, {
    to:         permit.to,
    tier:       permit.tier,
    generation: permit.generation,
    traitHash:  permit.traitHash,
    mintCost:   BigInt(permit.mintCost),
    nonce:      BigInt(permit.nonce),
    deadline:   BigInt(permit.deadline)
  });

  // For snapshot path, mark claimed AFTER successful signing (they can still
  // fail to submit on-chain, but worst case they need to contact support to
  // reset — preferable to letting them claim multiple times).
  if (path === 'snapshot') {
    await markSnapshotClaimed(wallet);
  }

  return res.status(200).json({
    path,
    permit,
    signature,
    contract: PETS_ADDR,
    chainId:  CHAIN_ID
  });
}
