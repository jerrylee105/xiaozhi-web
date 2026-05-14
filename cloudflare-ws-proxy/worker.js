/**
 * Cloudflare Worker — WebSocket proxy for xiaozhi
 *
 * Proxies browser WebSocket → xiaozhi server, adding auth headers.
 *
 * Usage:
 *   new WebSocket('wss://xiaozhi-ws-proxy.kdcdigibots.workers.dev/?target=WSS_URL&token=TOKEN&device_id=ID&client_id=CID')
 */

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/health') {
      return new Response('OK');
    }

    // Non-WebSocket request — show usage info
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response(JSON.stringify({
        info: 'XiaoZhi WebSocket Proxy',
        usage: 'Connect via WebSocket with query params: target, token, device_id, client_id',
      }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // Read params
    const target = url.searchParams.get('target');
    const token = url.searchParams.get('token') || '';
    const deviceId = url.searchParams.get('device_id') || '';
    const clientId = url.searchParams.get('client_id') || '';

    if (!target) {
      return new Response('Missing "target" param', { status: 400 });
    }

    try {
      // Cloudflare fetch() requires https:// not wss:// — convert protocol
      const fetchUrl = target.replace('wss://', 'https://').replace('ws://', 'http://');

      // Use Cloudflare's fetch-based WebSocket upgrade to connect upstream
      const upstreamRes = await fetch(fetchUrl, {
        headers: {
          'Upgrade': 'websocket',
          'Authorization': `Bearer ${token}`,
          'Protocol-Version': '1',
          'Device-Id': deviceId,
          'Client-Id': clientId,
        },
      });

      const upstream = upstreamRes.webSocket;
      if (!upstream) {
        return new Response(`Upstream did not return WebSocket. Status: ${upstreamRes.status}`, { status: 502 });
      }

      // Accept the upstream connection
      upstream.accept();

      // Create a WebSocketPair for the client (browser)
      const pair = new WebSocketPair();
      const [clientWs, serverWs] = [pair[0], pair[1]];
      serverWs.accept();

      // Pipe: upstream → browser
      upstream.addEventListener('message', (event) => {
        try {
          serverWs.send(event.data);
        } catch (e) {
          console.error('upstream→client error:', e);
        }
      });

      upstream.addEventListener('close', (event) => {
        try { serverWs.close(event.code || 1000, event.reason || 'upstream closed'); } catch {}
      });

      upstream.addEventListener('error', (event) => {
        console.error('upstream error:', event);
        try { serverWs.close(1011, 'upstream error'); } catch {}
      });

      // Pipe: browser → upstream
      serverWs.addEventListener('message', (event) => {
        try {
          upstream.send(event.data);
        } catch (e) {
          console.error('client→upstream error:', e);
        }
      });

      serverWs.addEventListener('close', (event) => {
        try { upstream.close(event.code || 1000, event.reason || 'client closed'); } catch {}
      });

      serverWs.addEventListener('error', (event) => {
        console.error('client error:', event);
        try { upstream.close(1011, 'client error'); } catch {}
      });

      // Return the client-side WebSocket to the browser
      return new Response(null, { status: 101, webSocket: clientWs });

    } catch (err) {
      console.error('Proxy error:', err);
      return new Response(`Proxy error: ${err.message}`, { status: 502 });
    }
  },
};
