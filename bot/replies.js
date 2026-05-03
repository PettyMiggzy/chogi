// replies.js — fast non-AI replies for common phrases.
// Returns null if no match → caller can decide to ask AI or skip.
import { config } from './config.js';

const RESPONSES = [
  // links
  { match: /\b(ca|contract|address)\b/i, text: `📜 CHOGI CA:\n\`${config.token}\`\n\nMonad mainnet · paste in any wallet` },
  { match: /\b(buy|how do i buy|where buy|where to buy)\b/i, text: `🟢 Buy $CHOGI:\n${config.buyUrl}\n\nDirect on nad.fun · 1 click` },
  { match: /\b(chart|dexscreener|dex screener)\b/i, text: `📊 Live chart:\n${config.chartUrl}` },
  { match: /\b(burn|burns|incinerator)\b/i, text: `🔥 Burn $CHOGI to the void:\n${config.burnUrl}\n\nLive meter at top · burns are permanent` },
  { match: /\b(site|website|chogi\.xyz)\b/i, text: `🧪 Home base:\n${config.siteUrl}\n\n→ /lab live dashboard\n→ /burn the incinerator\n→ /badge get your lab badge` },
  { match: /\blab\b/i, text: `🧪 Live control room:\n${config.labUrl}\n\nReal-time price · containment integrity · whale watch` },
  { match: /\b(twitter|x account|x handle)\b/i, text: `🐦 @Chogicto on X:\n${config.xUrl}` },
  { match: /\b(telegram|tg group)\b/i, text: `💬 ${config.tgUrl}` },

  // chain
  { match: /\b(chain|monad|network)\b/i, text: `⛓ Monad mainnet · chain ID 143\nRPC: ${config.rpcHttp}` },

  // common questions
  { match: /\bwhat (is|'s) chogi\b/i, text:
`🧪 I'm Chogi — Experiment 7777. Born in lab containment chamber 7777. Broke loose. Now CTO of my own project.
Original dev abandoned · community took over · I run things now.
${config.siteUrl}` },

  { match: /\b(how much|supply|total supply)\b/i, text: `📊 Supply: 1,000,000,000 $CHOGI total\nLive burned + circulating: ${config.labUrl}` },

  // hype
  { match: /^(gm|good morning)/i, text: `gm. lab's open. chamber 7777 unsealed.` },
  { match: /^(gn|good night)/i, text: `gn. don't let me out.` },
  { match: /\blfg\b/i, text: `🔥 LFG. supply only goes down.` },
];

export function findReply(text) {
  if (!text) return null;
  for (const r of RESPONSES) {
    if (r.match.test(text)) return r.text;
  }
  return null;
}
