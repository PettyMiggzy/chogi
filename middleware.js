// /middleware.js — Vercel Edge Middleware
// Runs at the edge BEFORE any page or API. Returns 403 to flagged IPs.
//
// HOW IPs GET CAPTURED:
//   When a blocked wallet connects, /js/blocklist.js POSTs to
//   /api/log-blocked-attempt which writes their IP + wallet + timestamp
//   to the Supabase table chogi_blocked_attempts.
//
// HOW IPs GET PERMANENTLY BLOCKED:
//   1. Check the captures at:
//      https://supabase.com/dashboard/project/cuqhqcmrgpdjlhyqztnc/editor
//      table: chogi_blocked_attempts
//   2. Copy the offending IP into the BLOCKED_IPS array below
//   3. Commit + push. New deploy = IP blocked from every page.
//
// LIMITATIONS (so you're not surprised):
//   - Only catches them when they visit chogi.xyz with a blocked wallet
//   - VPN / mobile data / new browser = 30-second bypass
//   - Doesn't stop them dumping on-chain (that's a different system)

export const config = {
  // Skip static assets + the log endpoint (otherwise IPs can't even self-report)
  matcher: '/((?!api/log-blocked-attempt|_next|_vercel|favicon|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|webm|mp4|mp3|wav|woff2?|css|js|map|json)$).*)',
};

// ─── BLOCKED IPs ────────────────────────────────────────────────────────────
// Populate after capturing IPs from chogi_blocked_attempts in Supabase.
const BLOCKED_IPS = new Set([
  // 'x.x.x.x',  // KILLA — captured YYYY-MM-DD
]);

// ─── HELPERS ────────────────────────────────────────────────────────────────
function getRequestIp(request) {
  // Vercel sets these in priority order
  const cfip = request.headers.get('cf-connecting-ip');
  if (cfip) return cfip.trim();
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const xri = request.headers.get('x-real-ip');
  if (xri) return xri.trim();
  // Vercel-specific
  return request.ip || 'unknown';
}

// ─── BANNED PAGE HTML (returned inline so even blocked clients see a styled page) ───
const BANNED_HTML = `<!DOCTYPE html><html><head><title>ACCESS REVOKED</title>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{margin:0;background:#0a0118;color:#FFE9F4;font-family:ui-monospace,monospace;
  display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;text-align:center}
.box{max-width:480px;border:2px solid #ff1e50;background:rgba(15,2,8,0.85);padding:36px 24px;border-radius:12px;
  box-shadow:0 0 60px rgba(255,30,80,0.3)}
h1{font-family:Bungee,Impact,sans-serif;color:#ff1e50;font-size:32px;letter-spacing:0.04em;margin:0 0 14px;
  text-shadow:0 0 20px rgba(255,30,80,0.6)}
.stamp{display:inline-block;font-size:10px;letter-spacing:0.32em;color:#ff1e50;border:1.5px solid #ff1e50;
  padding:5px 14px;margin-bottom:16px}
p{font-size:13px;color:rgba(255,233,244,0.75);line-height:1.6;margin:8px 0}
.ip{font-size:11px;color:rgba(255,233,244,0.5);margin-top:18px;padding:10px;background:rgba(0,0,0,0.4);
  border-left:2px solid #ff1e50;border-radius:4px;text-align:left}
</style></head><body><div class="box">
<div class="stamp">▲ ACCESS REVOKED</div>
<h1>NETWORK BANNED</h1>
<p>Your network address has been blocked from accessing chogi.xyz.</p>
<p>This block was triggered by activity associated with a flagged wallet.</p>
<div class="ip">▌ LAB 7777 · IP-LEVEL CONTAINMENT · ENFORCED AT EDGE</div>
</div></body></html>`;

// ─── MIDDLEWARE ─────────────────────────────────────────────────────────────
export default function middleware(request) {
  const ip = getRequestIp(request);

  if (BLOCKED_IPS.has(ip)) {
    return new Response(BANNED_HTML, {
      status: 403,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Lab-Block': 'ip-flagged',
        'Cache-Control': 'no-store',
      },
    });
  }

  // Allow the request through normally — middleware returns nothing
  return undefined;
}
