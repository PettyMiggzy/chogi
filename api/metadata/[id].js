/* /api/metadata/[id].js
   ────────────────────────────────────────────────────────────────────
   OpenSea / Magic Eden / Poply / wallets all hit this for tokenURI.
   Reads tierOf(tokenId) from the deployed ChogiLabSubjects contract
   and returns metadata pointing to the right tier image.

   Set CHOGI_NFT_ADDRESS in Vercel env vars after you deploy the contract.
   ──────────────────────────────────────────────────────────────────── */

const RPC = 'https://attentive-magical-sanctuary.monad-mainnet.quiknode.pro/63002c717b0ee2930197c2d560150d561db9ed7f/';

const TIERS = [
  { name: 'Common',     color: '#94A3B8', clearance: 'TIER D' },
  { name: 'Uncommon',   color: '#4ADE80', clearance: 'TIER C' },
  { name: 'Rare',       color: '#22D3EE', clearance: 'TIER B' },
  { name: 'Epic',       color: '#A855F7', clearance: 'TIER A' },
  { name: 'Legendary',  color: '#FCD34D', clearance: 'OMEGA'  }
];

/* tierOf(uint256) selector = 0x53f96df2 */
function selectorTierOf() { return '0x53f96df2'; }
function pad32(hex) { return hex.toLowerCase().replace('0x','').padStart(64,'0'); }
function uintToHex(n) { return BigInt(n).toString(16); }

async function fetchTier(contract, tokenId) {
  const data = selectorTierOf() + pad32('0x' + uintToHex(tokenId));
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_call',
      params: [{ to: contract, data: data }, 'latest'],
      id: 1
    })
  });
  const j = await res.json();
  if (!j.result || j.result === '0x') return null;
  return Number(BigInt(j.result));
}

export default async function handler(req, res) {
  try {
    const { id } = req.query;
    const tokenId = parseInt(id, 10);
    if (!Number.isFinite(tokenId) || tokenId < 1) {
      res.status(400).json({ error: 'invalid token id' });
      return;
    }

    const contract = process.env.CHOGI_NFT_ADDRESS;
    let tierIdx = null;
    if (contract && /^0x[0-9a-fA-F]{40}$/.test(contract)) {
      try { tierIdx = await fetchTier(contract, tokenId); }
      catch (e) { /* fall back to default tier */ }
    }
    // pre-deploy / unverified contract: serve a placeholder tier 0
    if (tierIdx === null || tierIdx > 4) tierIdx = 0;

    const tier = TIERS[tierIdx];
    const baseUrl = (req.headers['x-forwarded-proto'] || 'https') + '://' + req.headers.host;

    const metadata = {
      name: `Chogi Lab Subject #${tokenId}`,
      description:
        'Soulbound lab subject. Minted by burning $CHOGI to the dead address. ' +
        'Each subject is a permanent record of allegiance to Experiment 7777. ' +
        'Tier: ' + tier.name + ' · Clearance: ' + tier.clearance + '.',
      image: `${baseUrl}/nft/tier-${tierIdx}.png`,
      external_url: 'https://chogi.xyz/mint',
      background_color: '0a0118',
      attributes: [
        { trait_type: 'Tier',       value: tier.name },
        { trait_type: 'Clearance',  value: tier.clearance },
        { trait_type: 'Soulbound',  value: 'Yes' },
        { trait_type: 'Lab',        value: 'Experiment 7777' },
        { trait_type: 'Subject ID', value: tokenId }
      ]
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.status(200).json(metadata);
  } catch (e) {
    res.status(500).json({ error: 'server error', detail: String(e && e.message || e) });
  }
}
