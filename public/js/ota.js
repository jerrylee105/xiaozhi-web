/**
 * OTA Config Fetcher
 * Port of py-xiaozhi's Ota class — fetches WebSocket URL + activation data from server
 */

const APP_VERSION = '2.0.0';
const BOARD_TYPE = 'bread-compact-wifi';
const APP_NAME = 'py-xiaozhi';

export class OtaClient {
  constructor(device) {
    this.device = device;
  }

  /** Fetch config from OTA server. Returns { websocket, activation, ... } */
  async fetchConfig() {
    const headers = {
      'Content-Type': 'application/json',
      'Device-Id': this.device.deviceId,
      'Client-Id': this.device.clientId,
      'Activation-Version': APP_VERSION,
    };

    const deviceName = `Digibot_${this.device.serialNumber.slice(-4)}`;

    const payload = {
      application: {
        version: APP_VERSION,
        elf_sha256: this.device.hmacKey || 'unknown',
      },
      board: {
        type: BOARD_TYPE,
        name: deviceName,
        ip: '127.0.0.1',
        mac: this.device.deviceId,
      },
    };

    // Try direct first, fall back to proxy if CORS blocks
    let response;
    try {
      response = await fetch('https://api.tenclass.net/xiaozhi/ota/', {
        method: 'POST', headers, body: JSON.stringify(payload),
      });
    } catch {
      console.log('[OTA] Direct request failed (CORS?), using proxy...');
      response = await fetch('/api/ota', {
        method: 'POST', headers, body: JSON.stringify(payload),
      });
    }

    if (!response.ok) {
      throw new Error(`OTA server error: HTTP ${response.status}`);
    }

    const data = await response.json();
    console.log('[OTA] Config received:', data);

    // Update device with WebSocket config
    if (data.websocket) {
      this.device.setWebSocketConfig(data.websocket.url, data.websocket.token || 'test-token');
    }

    return data;
  }

  /** Post activation challenge response */
  async activate(challenge) {
    const hmac = await this.device.generateHmac(challenge);

    const headers = {
      'Content-Type': 'application/json',
      'Activation-Version': '2',
      'Device-Id': this.device.deviceId,
      'Client-Id': this.device.clientId,
    };

    const payload = {
      Payload: {
        algorithm: 'hmac-sha256',
        serial_number: this.device.serialNumber,
        challenge,
        hmac,
      },
    };

    let response;
    try {
      response = await fetch('https://api.tenclass.net/xiaozhi/ota/activate', {
        method: 'POST', headers, body: JSON.stringify(payload),
      });
    } catch {
      response = await fetch('/api/activate', {
        method: 'POST', headers, body: JSON.stringify(payload),
      });
    }

    return { status: response.status, data: await response.json() };
  }
}
