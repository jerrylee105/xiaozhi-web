/**
 * XiaoZhi Web Client — Main Application
 * State machine: IDLE → CONNECTING → LISTENING → SPEAKING
 */

import { DeviceManager } from './device.js';
import { OtaClient } from './ota.js';
import { ActivationManager } from './activation.js';
import { XiaozhiProtocol } from './protocol.js';
import { AudioPipeline } from './audio.js';

// ─── Configuration ───────────────────────────────
// Set this to your deployed Cloudflare Worker URL.
// If empty, will try direct connection (may fail due to missing auth headers).
const WS_PROXY_URL = 'wss://xiaozhi-ws-proxy.kdcdigibots.workers.dev/';

const DEFAULT_EMOTIONS = {
  neutral: 'neutral', happy: 'happy', sad: 'sad', angry: 'angry',
  shocked: 'shocked', surprised: 'shocked', scared: 'shocked',
};

// Emotion mapping
let EMOTIONS = { ...DEFAULT_EMOTIONS };

const savedEmotions = localStorage.getItem('xiaozhi_emotions');
if (savedEmotions) {
  try {
    EMOTIONS = { ...EMOTIONS, ...JSON.parse(savedEmotions) };
  } catch (e) {
    console.warn('Failed to parse saved emotions');
  }
}

const STATE = { IDLE: 'idle', CONNECTING: 'connecting', LISTENING: 'listening', SPEAKING: 'speaking' };

const STATE_LABELS = {
  [STATE.IDLE]: 'Đang chờ',
  [STATE.CONNECTING]: 'Đang kết nối...',
  [STATE.LISTENING]: 'Đang nghe...',
  [STATE.SPEAKING]: 'Đang nói...',
};

class App {
  constructor() {
    this.device = new DeviceManager();
    this.ota = null;
    this.protocol = new XiaozhiProtocol();
    this.audio = new AudioPipeline();
    this.state = STATE.IDLE;
    this.keepListening = false;

    this.$ = {
      app: document.getElementById('app'),
      activationView: document.getElementById('activation-view'),
      mainView: document.getElementById('main-view'),
      settingsView: document.getElementById('settings-view'),
      emotionImg: document.getElementById('emotion-img'),
      statusText: document.getElementById('status-text'),
      chatLog: document.getElementById('chat-log'),
      talkBtn: document.getElementById('talk-btn'),
      stopBtn: document.getElementById('stop-btn'),
      codeDisplay: document.getElementById('code-display'),
      activationStatus: document.getElementById('activation-status'),
      textInput: document.getElementById('text-input'),
      sendBtn: document.getElementById('send-btn'),
      debugInfo: document.getElementById('debug-info'),
      settingsBtn: document.getElementById('settings-btn'),
      closeSettingsBtn: document.getElementById('close-settings-btn'),
      saveEmojiBtn: document.getElementById('save-emoji-btn'),
      resetEmojiBtn: document.getElementById('reset-emoji-btn'),
      resetBtn: document.getElementById('reset-btn'),
      emojiSlots: {
        neutral: document.getElementById('emoji-neutral'),
        happy: document.getElementById('emoji-happy'),
        sad: document.getElementById('emoji-sad'),
        angry: document.getElementById('emoji-angry'),
        shocked: document.getElementById('emoji-shocked'),
      }
    };
  }

  async init() {
    await this.device.init();
    this.ota = new OtaClient(this.device);

    await this.audio.init();
    this.audio.onEncoded = (data) => this.protocol.sendAudio(data);

    this.protocol.onJson = (data) => this._onJson(data);
    this.protocol.onAudio = (data) => this.audio.decodeAudio(data);
    this.protocol.onOpened = () => this._onChannelOpened();
    this.protocol.onClosed = () => this._onChannelClosed();
    this.protocol.onError = (msg) => this._addChat('system', `Lỗi: ${msg}`);

    this._initSettings();
    this._bindEvents();
    this._updateDebugInfo();

    if (this.device.isActivated && this.device.websocketUrl) {
      this._showMainView();
    } else {
      await this._runActivation();
    }
  }

  // ─── Settings ──────────────────────────────────
  
  _initSettings() {
    // Populate emoji slots with current mapping
    for (const [key, slot] of Object.entries(this.$.emojiSlots)) {
      if (EMOTIONS[key]) {
        slot.dataset.mapped = EMOTIONS[key];
        slot.innerHTML = `<img src="assets/emojis/${EMOTIONS[key]}.gif" alt="${EMOTIONS[key]}">`;
      }
    }
    this._bindDragEvents();
  }

  _bindDragEvents() {
    // Draggables in the pool
    const draggables = document.querySelectorAll('.emoji-draggable');
    draggables.forEach(draggable => {
      draggable.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', draggable.dataset.name);
        e.dataTransfer.effectAllowed = 'copy';
      });
    });

    // Drop slots
    const slots = Object.values(this.$.emojiSlots);
    slots.forEach(slot => {
      slot.addEventListener('dragover', (e) => {
        e.preventDefault(); // Necessary to allow dropping
        e.dataTransfer.dropEffect = 'copy';
        slot.classList.add('drag-over');
      });

      slot.addEventListener('dragleave', (e) => {
        slot.classList.remove('drag-over');
      });

      slot.addEventListener('drop', (e) => {
        e.preventDefault();
        slot.classList.remove('drag-over');
        const emojiName = e.dataTransfer.getData('text/plain');
        if (emojiName) {
          slot.dataset.mapped = emojiName;
          slot.innerHTML = `<img src="assets/emojis/${emojiName}.gif" alt="${emojiName}">`;
        }
      });
    });
  }

  _toggleSettings() {
    if (this.$.settingsView.classList.contains('hidden')) {
      this.$.settingsView.classList.remove('hidden');
      this.$.mainView.classList.add('hidden');
    } else {
      this.$.settingsView.classList.add('hidden');
      this.$.mainView.classList.remove('hidden');
    }
  }

  _resetEmojiMapping() {
    if (confirm('Khôi phục biểu cảm về mặc định?')) {
      EMOTIONS = { ...DEFAULT_EMOTIONS };
      localStorage.removeItem('xiaozhi_emotions');
      this._initSettings();
      alert('Đã khôi phục!');
    }
  }

  _saveEmojiMapping() {
    const newMapping = {};
    for (const [key, slot] of Object.entries(this.$.emojiSlots)) {
      if (slot.dataset.mapped) {
        newMapping[key] = slot.dataset.mapped;
      }
    }
    EMOTIONS = { ...EMOTIONS, ...newMapping };
    localStorage.setItem('xiaozhi_emotions', JSON.stringify(newMapping));
    alert('Đã lưu thiết lập biểu cảm!');
  }

  // ─── Activation ────────────────────────────────

  async _runActivation() {
    this.$.activationView.classList.remove('hidden');
    this.$.mainView.classList.add('hidden');

    const activation = new ActivationManager(this.device, this.ota, {
      onStatus: (msg) => { this.$.activationStatus.textContent = msg; },
      onCode: (code, msg) => {
        this.$.codeDisplay.textContent = code.split('').join(' ');
        this.$.activationStatus.textContent = msg;
      },
      onError: (msg) => { this.$.activationStatus.textContent = `❌ ${msg}`; },
    });

    const success = await activation.run();
    if (success) {
      try { await this.ota.fetchConfig(); } catch {}
      this._updateDebugInfo();
      this._showMainView();
    }
  }

  _showMainView() {
    this.$.activationView.classList.add('hidden');
    this.$.mainView.classList.remove('hidden');
    this._setState(STATE.IDLE);
    this._setEmotion('neutral');

    if (!WS_PROXY_URL) {
      this._addChat('system', '⚠️ Chưa cấu hình WS proxy. Kết nối có thể thất bại.');
      this._addChat('system', 'Xem hướng dẫn deploy Cloudflare Worker trong README.');
    }
  }

  // ─── State Machine ─────────────────────────────

  _setState(newState) {
    this.state = newState;
    const labels = {
      [STATE.IDLE]: 'Đang chờ',
      [STATE.CONNECTING]: 'Đang kết nối...',
      [STATE.LISTENING]: '🎤 Đang nghe...',
      [STATE.SPEAKING]: '🔊 Đang nói...',
    };
    this.$.statusText.textContent = labels[newState] || newState;
    this.$.talkBtn.disabled = newState === STATE.CONNECTING;
    this.$.stopBtn.disabled = newState === STATE.IDLE;
    this.$.statusText.className = `status-text status-${newState}`;
  }

  _setEmotion(name) {
    const mapped = EMOTIONS[name] || 'neutral';
    this.$.emotionImg.src = `assets/emojis/${mapped}.gif`;
    this.$.emotionImg.alt = mapped;
  }

  // ─── Protocol Actions ──────────────────────────

  async _ensureConnected() {
    if (this.protocol.isOpen) return true;

    this._setState(STATE.CONNECTING);

    // Re-fetch OTA config for fresh WS URL
    this._addChat('system', 'Đang lấy cấu hình...');
    try {
      await this.ota.fetchConfig();
      this._updateDebugInfo();
    } catch (err) {
      this._addChat('system', `Lỗi OTA: ${err.message}`);
    }

    const url = this.device.websocketUrl;
    const token = this.device.websocketToken;

    if (!url) {
      this._addChat('system', '❌ Chưa có WebSocket URL. Cần kích hoạt lại.');
      this._setState(STATE.IDLE);
      return false;
    }

    let ok = false;

    if (WS_PROXY_URL) {
      // Use Cloudflare Worker proxy (recommended)
      this._addChat('system', 'Kết nối qua proxy...');
      ok = await this.protocol.connectViaProxy(
        WS_PROXY_URL, url, token, this.device.deviceId, this.device.clientId
      );
    } else {
      // Try direct connection (will likely fail due to missing auth headers)
      this._addChat('system', 'Kết nối trực tiếp (không có proxy)...');
      ok = await this.protocol.connectDirect(url, token, this.device.deviceId, this.device.clientId);
    }

    if (!ok) {
      this._addChat('system', '❌ Không kết nối được. Cần deploy WS proxy (Cloudflare Worker).');
      this._setState(STATE.IDLE);
      return false;
    }

    this._addChat('system', '✅ Đã kết nối!');
    return true;
  }

  async _startManualListening() {
    if (!(await this._ensureConnected())) return;
    this.keepListening = false;
    if (this.state === STATE.SPEAKING) {
      this.protocol.abortSpeaking();
      this.audio.clearPlaybackQueue();
    }
    await this.audio.startCapture();
    this.protocol.startListening('manual');
    this._setState(STATE.LISTENING);
  }

  _stopManualListening() {
    if (this.state !== STATE.LISTENING) return;
    this.audio.stopCapture();
    this.protocol.stopListening();
    this._setState(STATE.IDLE);
  }

  async _startAutoConversation() {
    if (!(await this._ensureConnected())) return;
    this.keepListening = true;
    await this.audio.startCapture();
    this.protocol.startListening('auto');
    this._setState(STATE.LISTENING);
  }

  _stopConversation() {
    this.keepListening = false;
    this.audio.stopCapture();
    this.audio.clearPlaybackQueue();
    if (this.protocol.isOpen) this.protocol.abortSpeaking();
    this._setState(STATE.IDLE);
  }

  async _sendText(text) {
    if (!text.trim()) return;
    if (!(await this._ensureConnected())) return;
    if (this.state === STATE.SPEAKING) {
      this.audio.clearPlaybackQueue();
      this.protocol.abortSpeaking();
    }
    // Don't add chat here — server echoes text back as 'stt'
    this.protocol.sendWakeWord(text);
    this.$.textInput.value = '';
  }

  // ─── Protocol Callbacks ────────────────────────

  _onChannelOpened() {
    console.log('[App] Channel opened');
    this._addChat('system', '🟢 Kênh audio đã mở');
  }

  _onChannelClosed() {
    console.log('[App] Channel closed');
    this.audio.stopCapture();
    this._setState(STATE.IDLE);
    this._addChat('system', '🔴 Kết nối đã đóng');
  }

  _onJson(data) {
    const type = data.type;

    if (type === 'tts') {
      if (data.state === 'start') this._setState(STATE.SPEAKING);
      else if (data.state === 'stop') {
        if (this.keepListening) {
          this._setState(STATE.LISTENING);
          this.protocol.startListening('auto');
        } else {
          this._setState(STATE.IDLE);
        }
      }
      if (data.text) this._addChat('ai', data.text);
    }

    if (type === 'stt' && data.text) this._addChat('user', data.text);
    if (type === 'llm' && data.emotion) this._setEmotion(data.emotion);
  }

  // ─── UI Helpers ────────────────────────────────

  _addChat(role, text) {
    const el = document.createElement('div');
    el.className = `chat-msg chat-${role}`;
    const label = role === 'ai' ? 'AI' : role === 'user' ? 'Bạn' : '⚙️';
    el.innerHTML = `<span class="chat-label">${label}:</span> ${text}`;
    this.$.chatLog.appendChild(el);
    this.$.chatLog.scrollTop = this.$.chatLog.scrollHeight;
    while (this.$.chatLog.children.length > 50) {
      this.$.chatLog.removeChild(this.$.chatLog.firstChild);
    }
  }

  _updateDebugInfo() {
    if (!this.$.debugInfo) return;
    const d = this.device.data;
    this.$.debugInfo.textContent = [
      `SN: ${d?.serial_number || '—'}`,
      `Device: ${d?.device_id || '—'}`,
      `Activated: ${d?.activation_status}`,
      `WS: ${d?.websocket_url || '—'}`,
      `Proxy: ${WS_PROXY_URL || 'NOT SET'}`,
    ].join('\n');
  }

  _resetDevice() {
    if (confirm('Xóa toàn bộ dữ liệu thiết bị và kích hoạt lại?')) {
      this.device.reset();
      location.reload();
    }
  }

  _bindEvents() {
    // Talk button — press and hold
    this.$.talkBtn.addEventListener('mousedown', () => this._startManualListening());
    this.$.talkBtn.addEventListener('mouseup', () => this._stopManualListening());
    this.$.talkBtn.addEventListener('mouseleave', () => {
      if (this.state === STATE.LISTENING && !this.keepListening) this._stopManualListening();
    });
    this.$.talkBtn.addEventListener('touchstart', (e) => { e.preventDefault(); this._startManualListening(); });
    this.$.talkBtn.addEventListener('touchend', (e) => { e.preventDefault(); this._stopManualListening(); });

    this.$.stopBtn.addEventListener('click', () => this._stopConversation());

    this.$.sendBtn.addEventListener('click', () => this._sendText(this.$.textInput.value));
    this.$.textInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._sendText(this.$.textInput.value);
    });

    // Settings
    this.$.settingsBtn.addEventListener('click', () => this._toggleSettings());
    this.$.closeSettingsBtn.addEventListener('click', () => this._toggleSettings());
    this.$.saveEmojiBtn.addEventListener('click', () => this._saveEmojiMapping());
    this.$.resetEmojiBtn.addEventListener('click', () => this._resetEmojiMapping());

    // Reset button
    this.$.resetBtn?.addEventListener('click', () => this._resetDevice());
  }
}

// ─── Boot ────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const app = new App();
  try {
    await app.init();
  } catch (err) {
    console.error('App init failed:', err);
    document.getElementById('status-text').textContent = `Lỗi: ${err.message}`;
  }
});
