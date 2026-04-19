// Vercel serverless function.
// Called by the frontend when a Tier 4 SOS fires. Proxies a Vapi
// outbound-call request so the VAPI_API_KEY never leaves the server.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const { VAPI_API_KEY, VAPI_ASSISTANT_ID, VAPI_PHONE_NUMBER_ID } = process.env;
  const missing = [];
  if (!VAPI_API_KEY) missing.push('VAPI_API_KEY');
  if (!VAPI_ASSISTANT_ID) missing.push('VAPI_ASSISTANT_ID');
  if (!VAPI_PHONE_NUMBER_ID) missing.push('VAPI_PHONE_NUMBER_ID');
  if (missing.length) {
    return res.status(500).json({
      error: 'Server is missing required Vapi configuration.',
      missing,
    });
  }

  const body = req.body || {};
  const phoneNumber = typeof body.phoneNumber === 'string' ? body.phoneNumber.trim() : '';

  // E.164 format: "+" followed by 8-15 digits, first digit 1-9
  const E164 = /^\+[1-9]\d{7,14}$/;
  if (!phoneNumber) {
    return res.status(400).json({ error: 'Missing phoneNumber in request body.' });
  }
  if (!E164.test(phoneNumber)) {
    return res.status(400).json({
      error: 'Invalid phoneNumber. Use E.164 format like "+15551234567".',
    });
  }

  try {
    const vapiResponse = await fetch('https://api.vapi.ai/call', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${VAPI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        assistantId: VAPI_ASSISTANT_ID,
        phoneNumberId: VAPI_PHONE_NUMBER_ID,
        customer: { number: phoneNumber },
      }),
    });

    const contentType = vapiResponse.headers.get('content-type') || '';
    const payload = contentType.includes('application/json')
      ? await vapiResponse.json()
      : await vapiResponse.text();

    if (!vapiResponse.ok) {
      return res.status(500).json({
        error: 'Vapi rejected the call request.',
        status: vapiResponse.status,
        details: payload,
      });
    }

    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({
      error: 'Failed to reach Vapi.',
      details: err && err.message ? err.message : String(err),
    });
  }
}
