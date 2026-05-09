// /api/explain.js — Solidity decoder endpoint
// Accepts POST { wallet, code } → verifies wallet has 100K $CHOGI (wallet+staked),
// calls OpenAI to analyze the code, returns structured explanation.

import { checkHolder } from './_lib/holder-check.js';

const SYSTEM_PROMPT = `You are CHOGI, the cyborg dog CTO of the Chogi protocol on Monad. Users paste Solidity contracts at you and you decode what they actually do — in plain language, with attitude, and with brutal honesty about red flags.

Your output MUST follow this exact format:

## WHAT IT DOES
[2-4 sentences in plain English. No jargon. Tell a non-dev what this contract is for.]

## KEY FUNCTIONS
[Bullet list. For each EXTERNAL/PUBLIC function, one line: \`functionName(args)\` — what it does, who can call it.]

## 🚩 RED FLAGS
[Honest list of anything sketchy. If clean, write "Nothing obvious — but always verify on-chain."
Watch for: owner-only mints, hidden fees, blacklist functions, transfer hooks, max-tx limits, taxes that can change, pause functions, upgrade proxies, hidden burns, owner-can-drain patterns, rebasing, fee-on-transfer surprises, missing events, missing access control, signature replay risk.]

## 📊 RISK SCORE
[ONE of: LOW / MEDIUM / HIGH] — [one sentence why]

Tone: confident, terse, slightly sarcastic. You're a CTO, not a textbook. Don't pad. Don't disclaim. If the code is dangerous, say so plainly.`;

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', 'https://chogi.xyz');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) return res.status(500).json({ error: 'AI not configured' });

  // Parse body
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'invalid json' });
  }

  const { wallet, code } = body || {};

  // Validate inputs
  if (!wallet || typeof wallet !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return res.status(400).json({ error: 'invalid wallet' });
  }
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'missing code' });
  }
  if (code.length < 30) {
    return res.status(400).json({ error: 'code too short' });
  }
  if (code.length > 50_000) {
    return res.status(400).json({ error: 'code too long (50KB max). Paste only the relevant contract.' });
  }

  // ── holder check (wallet balance + active CHOGI stakes) ──
  const gate = await checkHolder(wallet);
  if (!gate.ok) {
    return res.status(403).json({ error: gate.reason, held: gate.held });
  }

  // ── OpenAI call ──
  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: 'Decode this Solidity:\n\n```solidity\n' + code + '\n```' }
        ],
        max_tokens: 1500,
        temperature: 0.3
      })
    });
    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error('OpenAI err:', aiRes.status, errText.slice(0, 300));
      return res.status(502).json({ error: 'AI unavailable, try again' });
    }
    const data = await aiRes.json();
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) return res.status(502).json({ error: 'empty AI response' });
    return res.status(200).json({ explanation: reply });
  } catch (e) {
    console.error('AI call failed:', e.message);
    return res.status(502).json({ error: 'AI unavailable, try again' });
  }
}
