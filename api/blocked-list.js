// /api/blocked-list.js
// Public endpoint — returns the wallet blocklist as JSON for the /banned page
// to render the public containment registry. Read-only, no auth required.

import { getPublicList } from './blocklist.js';

export default function handler(req, res) {
  // Cache 5 minutes at the edge — list changes rarely
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({
    count:   getPublicList().length,
    wallets: getPublicList()
  });
}
