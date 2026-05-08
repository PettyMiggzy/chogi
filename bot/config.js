// config.js
export const config = {
  // Monad mainnet $CHOGI
  token:    '0x5E1b1A14c8758104B8560514e94ab8320e587777',
  pair:     '0x75C3Ab752e313544f00F08fC945FCe7d22EF4F0D', // CHOGI/WMON 1% on Capricorn
  pool:     '0x75C3Ab752e313544f00F08fC945FCe7d22EF4F0D',
  wmon:     '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A',
  dead:     '0x000000000000000000000000000000000000dEaD',

  // Public links
  buyUrl:   'https://nad.fun/tokens/0x5E1b1A14c8758104B8560514e94ab8320e587777',
  siteUrl:  'https://chogi.xyz',
  labUrl:   'https://chogi.xyz/lab',
  burnUrl:  'https://chogi.xyz/burn',
  chartUrl: 'https://dexscreener.com/monad/0x75c3ab752e313544f00f08fc945fce7d22ef4f0d',
  xUrl:     'https://x.com/chogicto',
  tgUrl:    'https://t.me/chogicto',

  // Chain
  chainId:  143,
  rpcHttp:  process.env.MONAD_RPC || 'https://rpc.monad.xyz',
  explorer: 'https://monadexplorer.com',
};
