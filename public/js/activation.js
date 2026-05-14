/**
 * Device Activation Flow
 * Port of py-xiaozhi's DeviceActivator — handles verification code display + polling
 */

export class ActivationManager {
  constructor(device, otaClient, ui) {
    this.device = device;
    this.ota = otaClient;
    this.ui = ui; // UI callbacks
    this._cancelled = false;
  }

  /** Run full activation flow. Returns true if activated. */
  async run() {
    this._cancelled = false;

    // 1. Fetch OTA config
    this.ui.onStatus('Đang kết nối server...');
    let otaData;
    try {
      otaData = await this.ota.fetchConfig();
    } catch (err) {
      this.ui.onError(`Không kết nối được server: ${err.message}`);
      return false;
    }

    // 2. Check if already activated (no activation data in response)
    if (!otaData.activation) {
      console.log('[Activation] Device already activated');
      this.device.setActivated(true);
      return true;
    }

    // 3. Show verification code
    const { challenge, code, message } = otaData.activation;
    if (!challenge || !code) {
      this.ui.onError('Server không trả về mã kích hoạt');
      return false;
    }

    this.ui.onCode(code, message || 'Vui lòng nhập mã kích hoạt trên xiaozhi.me');

    // 4. Poll activation endpoint
    const MAX_RETRIES = 60;
    const INTERVAL = 5000;

    for (let attempt = 1; attempt <= MAX_RETRIES && !this._cancelled; attempt++) {
      this.ui.onStatus(`Đang chờ kích hoạt... (${attempt}/${MAX_RETRIES})`);

      try {
        const result = await this.ota.activate(challenge);

        if (result.status === 200) {
          console.log('[Activation] Success!');
          this.device.setActivated(true);
          this.ui.onStatus('Kích hoạt thành công!');
          return true;
        }

        if (result.status === 202) {
          // Waiting for user to enter code
          console.log('[Activation] Waiting for user input...');
        } else {
          console.warn('[Activation] Unexpected status:', result.status, result.data);
        }
      } catch (err) {
        console.warn('[Activation] Request error:', err.message);
      }

      await this._sleep(INTERVAL);
    }

    if (this._cancelled) {
      this.ui.onStatus('Kích hoạt đã bị hủy');
    } else {
      this.ui.onError('Kích hoạt thất bại — hết thời gian chờ');
    }
    return false;
  }

  cancel() {
    this._cancelled = true;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
