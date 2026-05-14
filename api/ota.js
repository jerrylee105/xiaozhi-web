// Vercel Serverless Function — CORS proxy for xiaozhi OTA API
export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Device-Id, Client-Id, Activation-Version');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const targetUrl = 'https://api.tenclass.net/xiaozhi/ota/';

  try {
    const headers = {
      'Content-Type': 'application/json',
      'Accept-Language': 'zh-CN',
    };
    // Forward relevant headers
    ['device-id', 'client-id', 'activation-version', 'user-agent'].forEach(h => {
      if (req.headers[h]) headers[h.split('-').map((w,i) => i ? w[0].toUpperCase()+w.slice(1) : w.charAt(0).toUpperCase()+w.slice(1)).join('-')] = req.headers[h];
    });

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('OTA proxy error:', error);
    res.status(502).json({ error: 'Proxy request failed' });
  }
}
