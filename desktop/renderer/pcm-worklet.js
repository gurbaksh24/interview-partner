// Converts mic audio (already at the AudioContext's 16 kHz rate) into
// 16-bit little-endian PCM and posts it in 50 ms chunks for the STT socket.
const CHUNK_SAMPLES = 800; // 50 ms at 16 kHz

class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(CHUNK_SAMPLES);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      this.buffer[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.filled === CHUNK_SAMPLES) {
        this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]);
        this.buffer = new Int16Array(CHUNK_SAMPLES);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-worklet', PcmWorklet);
