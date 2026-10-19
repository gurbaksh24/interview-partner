// Mic -> 16 kHz PCM -> AssemblyAI streaming STT, using a short-lived token from our backend.
class MicTranscriber {
  constructor(backendUrl) {
    this.backendUrl = backendUrl;
    this.ws = null;
    this.ctx = null;
    this.stream = null;
    this.turns = new Map(); // turn_order -> latest transcript for that turn
  }

  get active() {
    return this.ws !== null;
  }

  /** onText(fullText) is called whenever the running transcript changes. */
  async start(onText, onError) {
    const res = await fetch(`${this.backendUrl}/api/stt-token`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `Speech-to-text unavailable (${res.status})`);
    }
    const { ws_url: wsUrl, sample_rate: sampleRate } = await res.json();

    this.turns.clear();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new AudioContext({ sampleRate });
    await this.ctx.audioWorklet.addModule('pcm-worklet.js');
    const source = this.ctx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(this.ctx, 'pcm-worklet');

    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    node.port.onmessage = (e) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(e.data);
    };
    source.connect(node);

    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === 'Turn') {
        this.turns.set(msg.turn_order, msg.transcript || '');
        onText(this.text());
      } else if (msg.type === 'Error' || msg.error) {
        onError(new Error(msg.error || 'Speech-to-text error'));
      }
    };
    ws.onerror = () => onError(new Error('Speech-to-text connection failed'));
    ws.onclose = (e) => {
      if (this.ws === ws && e.code !== 1000) onError(new Error(`Speech-to-text closed (${e.code}) ${e.reason || ''}`));
    };
  }

  text() {
    return [...this.turns.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, t]) => t.trim())
      .filter(Boolean)
      .join(' ');
  }

  /** Stops the mic and waits briefly for the final transcript. Returns the full text. */
  async stop() {
    const ws = this.ws;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) await this.ctx.close().catch(() => {});
    this.stream = null;
    this.ctx = null;

    if (ws && ws.readyState === WebSocket.OPEN) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        ws.addEventListener('message', (e) => {
          try {
            if (JSON.parse(e.data).type === 'Termination') {
              clearTimeout(timer);
              resolve();
            }
          } catch {
            /* ignore */
          }
        });
        ws.send(JSON.stringify({ type: 'Terminate' }));
      });
    }
    this.ws = null;
    if (ws) ws.close(1000);
    return this.text();
  }
}
window.MicTranscriber = MicTranscriber;
