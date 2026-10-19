// AudioWorklet: runs in an AudioContext created at 16 kHz, so the mic stream is
// already resampled. Posts 512-sample Float32 frames (32 ms) while "on"; on "stop"
// posts the remaining partial frame as { type: "end" }. Every message carries the
// recording generation so the page can ignore a stale "end" after a fast restart.

const FRAME = 512;

class PcmFramer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(FRAME);
    this.n = 0;
    this.on = false;
    this.gen = 0;
    this.port.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.cmd === "start") {
        this.n = 0;
        this.gen = msg.gen;
        this.on = true;
      } else if (msg.cmd === "stop") {
        this.on = false;
        const rest = this.buf.slice(0, this.n);
        this.n = 0;
        this.port.postMessage({ type: "end", gen: this.gen, samples: rest }, [rest.buffer]);
      }
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (this.on && ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === FRAME) {
          const f = this.buf.slice();
          this.port.postMessage({ type: "frame", gen: this.gen, samples: f }, [f.buffer]);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("pcm-framer", PcmFramer);
