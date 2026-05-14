/**
 * Device Identity Manager
 * Port of py-xiaozhi's DeviceFingerprint + efuse.json → localStorage
 */

const STORAGE_KEY = 'xiaozhi_device';

function generateUUID() {
  return crypto.randomUUID();
}

function generateRandomMac() {
  const hex = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  return `${hex()}:${hex()}:${hex()}:${hex()}:${hex()}:${hex()}`;
}

async function sha256(message) {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(key, message) {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export class DeviceManager {
  constructor() {
    this.data = null;
  }

  /** Load or create device identity */
  async init() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        this.data = JSON.parse(stored);
        console.log('[Device] Loaded identity:', this.data.serial_number);
        return;
      } catch { /* corrupted, recreate */ }
    }
    await this._createIdentity();
  }

  async _createIdentity() {
    const mac = generateRandomMac();
    const macClean = mac.replace(/:/g, '');
    const macHash = (await sha256(macClean)).substring(0, 8).toUpperCase();
    const serial_number = `SN-${macHash}-${macClean}`;

    const hostname = 'xiaozhi-web';
    const hmac_key = await sha256(`${hostname}||${mac}||${generateUUID()}`);

    this.data = {
      mac_address: mac,
      serial_number,
      hmac_key,
      device_id: mac,
      client_id: generateUUID(),
      activation_status: false,
      websocket_url: null,
      websocket_token: null,
    };

    this._save();
    console.log('[Device] Created new identity:', serial_number);
  }

  _save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
  }

  get serialNumber() { return this.data.serial_number; }
  get hmacKey() { return this.data.hmac_key; }
  get deviceId() { return this.data.device_id; }
  get clientId() { return this.data.client_id; }
  get isActivated() { return this.data.activation_status; }
  get websocketUrl() { return this.data.websocket_url; }
  get websocketToken() { return this.data.websocket_token; }

  setActivated(status) {
    this.data.activation_status = status;
    this._save();
  }

  setWebSocketConfig(url, token) {
    this.data.websocket_url = url;
    this.data.websocket_token = token;
    this._save();
  }

  async generateHmac(challenge) {
    return hmacSha256(this.data.hmac_key, challenge);
  }

  /** Reset identity (for debugging) */
  reset() {
    localStorage.removeItem(STORAGE_KEY);
    this.data = null;
  }
}
