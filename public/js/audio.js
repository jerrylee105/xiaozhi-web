/**
 * Audio Pipeline — Mic capture + Opus encode/decode + playback
 * Uses WebCodecs API (AudioEncoder/AudioDecoder) for native Opus support
 */

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const FRAME_DURATION_MS = 60;
const INPUT_FRAME_SIZE = INPUT_SAMPLE_RATE * FRAME_DURATION_MS / 1000; // 960

/**
 * Build OpusHead identification header (RFC 7845 §5.1).
 * Required by WebCodecs AudioDecoder for correct decoding.
 */
function buildOpusHeader(channels, sampleRate) {
  const buf = new ArrayBuffer(19);
  const view = new DataView(buf);
  const magic = [0x4F, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]; // "OpusHead"
  magic.forEach((b, i) => view.setUint8(i, b));
  view.setUint8(8, 1);           // version
  view.setUint8(9, channels);    // channel count
  view.setUint16(10, 312, true); // pre-skip (little-endian)
  view.setUint32(12, sampleRate, true); // input sample rate
  view.setInt16(16, 0, true);    // output gain
  view.setUint8(18, 0);          // channel mapping family
  return new Uint8Array(buf);
}

export class AudioPipeline {
  constructor() {
    this.stream = null;
    this.captureCtx = null;
    this.playbackCtx = null;
    this.encoder = null;
    this.decoder = null;
    this.capturing = false;

    // Callbacks
    this.onEncoded = null; // (opusData: Uint8Array) => {}

    // Capture buffer
    this._captureBuffer = new Float32Array(0);
    this._encodeTimestamp = 0;
    this._decodeTimestamp = 0;

    // Playback scheduling
    this._nextPlayTime = 0;

    // WebCodecs support
    this._hasWebCodecs = typeof AudioEncoder !== 'undefined' && typeof AudioDecoder !== 'undefined';
  }

  async init() {
    this.playbackCtx = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });

    if (this._hasWebCodecs) {
      await this._initWebCodecs();
    } else {
      console.warn('[Audio] WebCodecs not available — need Chrome 94+');
    }

    console.log('[Audio] Initialized, WebCodecs:', this._hasWebCodecs);
  }

  async _initWebCodecs() {
    // Check encoder support
    const encoderSupport = await AudioEncoder.isConfigSupported({
      codec: 'opus', sampleRate: INPUT_SAMPLE_RATE, numberOfChannels: 1, bitrate: 24000,
    });

    if (!encoderSupport.supported) {
      console.warn('[Audio] Opus encoder not supported');
      this._hasWebCodecs = false;
      return;
    }

    // Encoder: mic PCM → Opus frames
    this.encoder = new AudioEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        if (this.onEncoded) this.onEncoded(data);
      },
      error: (e) => console.error('[Audio] Encoder error:', e),
    });

    this.encoder.configure({
      codec: 'opus',
      sampleRate: INPUT_SAMPLE_RATE,
      numberOfChannels: 1,
      bitrate: 24000,
      opus: {
        application: 'voip',
        frameDuration: FRAME_DURATION_MS * 1000, // microseconds
        complexity: 5,
      },
    });

    // Decoder: Opus frames from server → PCM
    const opusHeader = buildOpusHeader(1, OUTPUT_SAMPLE_RATE);

    this.decoder = new AudioDecoder({
      output: (audioData) => this._schedulePlayback(audioData),
      error: (e) => console.error('[Audio] Decoder error:', e),
    });

    this.decoder.configure({
      codec: 'opus',
      sampleRate: OUTPUT_SAMPLE_RATE,
      numberOfChannels: 1,
      description: opusHeader, // Required for correct sample rate
    });
  }

  async startCapture() {
    if (this.capturing) return;

    try {
      if (!this.stream) {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: INPUT_SAMPLE_RATE,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      }

      if (!this.captureCtx) {
        this.captureCtx = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
      } else if (this.captureCtx.state === 'suspended') {
        await this.captureCtx.resume();
      }

      // Re-create nodes if needed
      if (!this._captureSource) {
        this._captureSource = this.captureCtx.createMediaStreamSource(this.stream);
      }
      if (!this._captureProcessor) {
        this._captureProcessor = this.captureCtx.createScriptProcessor(4096, 1, 1);
        this._captureProcessor.onaudioprocess = (e) => {
          if (!this.capturing) return;
          this._processCapturedAudio(e.inputBuffer.getChannelData(0));
        };
      }

      this._captureSource.connect(this._captureProcessor);
      this._captureProcessor.connect(this.captureCtx.destination);
      
      this.capturing = true;
      this._captureBuffer = new Float32Array(0);
      console.log('[Audio] Capture started/resumed');
    } catch (err) {
      console.error('[Audio] Mic error:', err);
      throw new Error('Không thể truy cập microphone.');
    }
  }

  stopCapture() {
    this.capturing = false;
    
    // We KEEP the stream alive to prevent 1-2 second delays from getUserMedia on the next turn.
    // This fixes the issue where the user says a short word ("hello") but the mic hasn't started yet.
    
    // Disconnect nodes to stop processing audio
    if (this._captureSource) {
      try { this._captureSource.disconnect(); } catch (e) {}
    }
    if (this._captureProcessor) {
      try { this._captureProcessor.disconnect(); } catch (e) {}
    }
    
    this._captureBuffer = new Float32Array(0);
  }

  _processCapturedAudio(samples) {
    const newBuf = new Float32Array(this._captureBuffer.length + samples.length);
    newBuf.set(this._captureBuffer);
    newBuf.set(samples, this._captureBuffer.length);
    this._captureBuffer = newBuf;

    while (this._captureBuffer.length >= INPUT_FRAME_SIZE) {
      const frame = this._captureBuffer.slice(0, INPUT_FRAME_SIZE);
      this._captureBuffer = this._captureBuffer.slice(INPUT_FRAME_SIZE);
      this._encodeFrame(frame);
    }
  }

  _encodeFrame(pcm) {
    if (!this._hasWebCodecs || !this.encoder) return;
    try {
      const audioData = new AudioData({
        format: 'f32', sampleRate: INPUT_SAMPLE_RATE,
        numberOfChannels: 1, numberOfFrames: pcm.length,
        timestamp: this._encodeTimestamp, data: pcm,
      });
      this._encodeTimestamp += (pcm.length / INPUT_SAMPLE_RATE) * 1_000_000;
      this.encoder.encode(audioData);
      audioData.close();
    } catch (err) {
      console.error('[Audio] Encode error:', err);
    }
  }

  /** Decode incoming Opus frame from server */
  decodeAudio(opusData) {
    if (!this._hasWebCodecs || !this.decoder) return;

    try {
      // Resume playback context (browser autoplay policy)
      if (this.playbackCtx.state === 'suspended') this.playbackCtx.resume();

      const chunk = new EncodedAudioChunk({
        type: 'key',
        timestamp: this._decodeTimestamp,
        data: opusData,
      });
      this._decodeTimestamp += FRAME_DURATION_MS * 1000;
      this.decoder.decode(chunk);
    } catch (err) {
      console.error('[Audio] Decode error:', err);
    }
  }

  /**
   * Schedule decoded audio for gapless playback.
   * Uses AudioContext.currentTime for precise scheduling instead of onended callbacks.
   */
  _schedulePlayback(audioData) {
    const pcm = new Float32Array(audioData.numberOfFrames);
    audioData.copyTo(pcm, { planeIndex: 0 });
    const actualSampleRate = audioData.sampleRate;
    audioData.close();

    // WebCodecs Opus decoder might output 48000Hz despite being configured for 24000Hz.
    // We MUST use the actual sampleRate from audioData to create the buffer,
    // otherwise it will play at the wrong speed and pitch.
    const buffer = this.playbackCtx.createBuffer(1, pcm.length, actualSampleRate);
    buffer.getChannelData(0).set(pcm);

    const source = this.playbackCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.playbackCtx.destination);

    const now = this.playbackCtx.currentTime;
    const startTime = Math.max(now, this._nextPlayTime);
    source.start(startTime);

    // Schedule next frame right after this one ends (gapless)
    this._nextPlayTime = startTime + buffer.duration;
  }

  clearPlaybackQueue() {
    this._decodeTimestamp = 0;
    this._nextPlayTime = 0;
    // Reset decoder to flush any pending frames
    if (this.decoder && this.decoder.state === 'configured') {
      try { this.decoder.reset(); } catch {}
      const opusHeader = buildOpusHeader(1, OUTPUT_SAMPLE_RATE);
      this.decoder.configure({
        codec: 'opus', sampleRate: OUTPUT_SAMPLE_RATE,
        numberOfChannels: 1, description: opusHeader,
      });
    }
  }

  dispose() {
    this.stopCapture();
    this.clearPlaybackQueue();
    if (this.encoder) { try { this.encoder.close(); } catch {} }
    if (this.decoder) { try { this.decoder.close(); } catch {} }
    if (this.playbackCtx) { this.playbackCtx.close().catch(() => {}); }
  }
}
