// Vercel serverless function — telemetry relay.
// Flow:
//   UNO Q                  Vercel                  Dashboard
//   ─────                  ──────                  ─────────
//   POST /api/telemetry ──▶ [memory] ◀── GET /api/telemetry
//
// State lives in a module-level variable — persists as long as the
// serverless function instance stays warm. For a live demo with traffic
// every second from both sides, the instance stays warm the entire time.

let latestTelemetry = null;
let latestTimestamp = 0;

export default async function handler(req, res) {
  // CORS — UNO Q is on a different origin from Vercel
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // ───────── POST — UNO Q pushes latest state ─────────
  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string'
        ? JSON.parse(req.body)
        : (req.body || {});

      // Basic validation — must have at least some expected keys
      if (typeof body !== 'object') {
        return res.status(400).json({ error: 'Body must be JSON object' });
      }

      latestTelemetry = body;
      latestTimestamp = Date.now();
      return res.status(200).json({
        ok: true,
        receivedAt: latestTimestamp,
      });
    } catch (e) {
      return res.status(400).json({
        error: 'Invalid JSON',
        details: e?.message || String(e),
      });
    }
  }

  // ───────── GET — Dashboard polls ─────────
  if (req.method === 'GET') {
    if (!latestTelemetry) {
      return res.status(200).json({
        hasData: false,
        message: 'No telemetry received yet. UNO Q may not be running.',
      });
    }
    const ageMs = Date.now() - latestTimestamp;
    return res.status(200).json({
      hasData: true,
      stale: ageMs > 5000,    // >5s old == stale
      ageMs,
      timestamp: latestTimestamp,
      telemetry: latestTelemetry,
    });
  }

  return res.status(405).json({ error: 'Method not allowed. Use GET or POST.' });
}
