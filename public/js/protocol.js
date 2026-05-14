/**
 * WebSocket Protocol
 * Port of py-xiaozhi's WebsocketProtocol
 *
 * Browser WebSocket can't send custom HTTP headers, so we use a
 * Cloudflare Worker proxy that adds headers on the server side.
 *
 * Set WS_PROXY_URL in main.js to your deployed worker URL.
 */

const FRAME_DURATION = 60;
const INPUT_SAMPLE_RATE = 16000;
const CHANNELS = 1;

export class XiaozhiProtocol {
  constructor() {
    this.ws = null;
    this.sessionId = '';
    this.connected = false;
    this._isClosing = false;
    this._deviceId = '';
    this._clientId = '';
    this._token = '';

    // Callbacks
    this.onJson = null;
    this.onAudio = null;
    this.onOpened = null;
    this.onClosed = null;
    this.onError = null;
  }

  /**
   * Connect via Cloudflare Worker proxy (recommended).
   * The proxy adds auth headers that browser WS API can't send.
   */
  async connectViaProxy(proxyUrl, targetWsUrl, token, deviceId, clientId) {
    this._deviceId = deviceId;
    this._clientId = clientId;
    this._token = token;

    const wsUrl = new URL(proxyUrl);
    wsUrl.searchParams.set('target', targetWsUrl);
    wsUrl.searchParams.set('token', token);
    wsUrl.searchParams.set('device_id', deviceId);
    wsUrl.searchParams.set('client_id', clientId);

    console.log('[WS] Connecting via proxy:', wsUrl.toString());
    return this._doConnect(wsUrl.toString());
  }

  /**
   * Connect directly (works only if server accepts connections without auth headers).
   */
  async connectDirect(url, token, deviceId, clientId) {
    this._deviceId = deviceId;
    this._clientId = clientId;
    this._token = token;

    // Try with query params
    const wsUrl = new URL(url);
    wsUrl.searchParams.set('token', token);
    wsUrl.searchParams.set('device_id', deviceId);
    wsUrl.searchParams.set('client_id', clientId);

    console.log('[WS] Connecting directly:', wsUrl.toString());
    return this._doConnect(wsUrl.toString());
  }

  _doConnect(urlString) {
    if (this._isClosing) return Promise.resolve(false);

    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(urlString);
        this.ws.binaryType = 'arraybuffer';

        let helloTimeout = null;
        let resolved = false;

        const finish = (ok) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(helloTimeout);
          resolve(ok);
        };

        this.ws.onopen = () => {
          console.log('[WS] Connected, sending hello...');
          this._sendHello();
          helloTimeout = setTimeout(() => {
            console.error('[WS] Hello timeout');
            finish(false);
            try { this.ws.close(); } catch {}
          }, 10000);
        };

        this.ws.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) {
            if (this.onAudio) this.onAudio(new Uint8Array(event.data));
          } else {
            try {
              const data = JSON.parse(event.data);
              console.log('[WS] JSON:', data.type);

              if (data.type === 'hello' && !resolved) {
                this.sessionId = data.session_id || '';
                this.connected = true;
                console.log('[WS] Hello OK, session:', this.sessionId);
                if (this.onOpened) this.onOpened();
                finish(true);
                return;
              }

              if (this.onJson) this.onJson(data);
            } catch (e) {
              console.error('[WS] Parse error:', e);
            }
          }
        };

        this.ws.onclose = (event) => {
          console.log('[WS] Closed:', event.code, event.reason);
          this.connected = false;
          finish(false);
          if (this.onClosed) this.onClosed();
        };

        this.ws.onerror = () => {
          console.error('[WS] Connection error');
          if (this.onError) this.onError('WebSocket error');
        };
      } catch (err) {
        console.error('[WS] Failed:', err);
        resolve(false);
      }
    });
  }

  _sendHello() {
    const hello = {
      type: 'hello',
      version: 1,
      features: { mcp: false },
      transport: 'websocket',
      audio_params: {
        format: 'opus',
        sample_rate: INPUT_SAMPLE_RATE,
        channels: CHANNELS,
        frame_duration: FRAME_DURATION,
      },
    };
    this.ws.send(JSON.stringify(hello));
    console.log('[WS] Sent hello');
  }

  sendAudio(opusData) {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(opusData);
  }

  sendJson(data) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    data.session_id = this.sessionId;
    this.ws.send(JSON.stringify(data));
    console.log('[WS] Sent:', data.type);
  }

  startListening(mode = 'manual') { this.sendJson({ type: 'listen', state: 'start', mode }); }
  stopListening() { this.sendJson({ type: 'listen', state: 'stop' }); }
  abortSpeaking() { this.sendJson({ type: 'abort' }); }
  sendWakeWord(text) { this.sendJson({ type: 'listen', state: 'detect', text }); }

  close() {
    this._isClosing = true;
    this.connected = false;
    if (this.ws) { try { this.ws.close(1000); } catch {} this.ws = null; }
    this._isClosing = false;
  }

  get isOpen() {
    return this.connected && this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}
