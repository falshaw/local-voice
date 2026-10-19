import { describe, it, expect } from "vitest";
import {
  SAMPLE_RATE,
  FRAME_SAMPLES,
  FRAME_MS,
  SPEECH_THRESHOLD,
  SILENCE_THRESHOLD,
  trimSegments,
  shouldAutoStop,
} from "../lib/vad.js";

function probs(spec) {
  // spec = [[count, p], ...]
  const out = [];
  for (const [n, p] of spec) for (let i = 0; i < n; i++) out.push(p);
  return out;
}

describe("constants", () => {
  it("are Silero v5 at 16 kHz / 512 samples", () => {
    expect(SAMPLE_RATE).toBe(16000);
    expect(FRAME_SAMPLES).toBe(512);
    expect(FRAME_MS).toBe(32);
    expect(SPEECH_THRESHOLD).toBe(0.5);
    expect(SILENCE_THRESHOLD).toBe(0.35);
  });
});

describe("trimSegments", () => {
  it("keeps [firstSpeech − 200 ms, lastSpeech + 300 ms]", () => {
    // 40 frames, speech on frames 10..20
    const p = probs([[10, 0.01], [11, 0.9], [19, 0.02]]);
    expect(trimSegments(p)).toEqual({ start: 10 * 512 - 3200, end: 21 * 512 + 4800 });
  });

  it("clamps to the recording", () => {
    const p = probs([[6, 0.9], [4, 0.0]]);
    expect(trimSegments(p)).toEqual({ start: 0, end: 10 * 512 });
    // totalSamples (incl. the tail) may be larger than the framed part
    expect(trimSegments(p, { totalSamples: 10 * 512 + 100 })).toEqual({ start: 0, end: 10 * 512 + 100 });
  });

  it("a 3 s silence fixture gives null (no Whisper hallucination)", () => {
    const silence = probs([[Math.ceil(3 * 16000 / 512), 0.01]]);
    expect(silence.length).toBe(94);
    expect(trimSegments(silence)).toBeNull();
    expect(trimSegments([])).toBeNull();
  });

  it("a lone speech frame is noise, not speech", () => {
    expect(trimSegments(probs([[20, 0.0], [1, 0.99], [20, 0.0]]))).toBeNull();
    expect(trimSegments(probs([[20, 0.0], [2, 0.99], [20, 0.0]]))).not.toBeNull();
    expect(trimSegments(probs([[20, 0.0], [1, 0.99], [20, 0.0]]), { minSpeechFrames: 1 })).toEqual({
      start: 20 * 512 - 3200,
      end: 21 * 512 + 4800,
    });
  });

  it("uses the threshold given", () => {
    const p = probs([[5, 0.4], [5, 0.0]]);
    expect(trimSegments(p)).toBeNull();
    // end = 5*512 + 4800 = 7360, clamped to the 10-frame recording (5120)
    expect(trimSegments(p, { threshold: 0.3 })).toEqual({ start: 0, end: 10 * 512 });
    expect(trimSegments(p, { threshold: 0.3, totalSamples: 20 * 512 })).toEqual({ start: 0, end: 5 * 512 + 4800 });
  });

  it("ignores sparse holes (frames whose probability never arrived)", () => {
    const p = [];
    p[5] = 0.9;
    p[6] = 0.9;
    p.length = 10;
    // start = 5*512 − 3200 < 0 → 0; end = 7*512 + 4800 = 8384 → clamped to 5120
    expect(trimSegments(p)).toEqual({ start: 0, end: 10 * 512 });
    expect(trimSegments(p, { totalSamples: 30 * 512 })).toEqual({ start: 0, end: 7 * 512 + 4800 });
  });
});

describe("shouldAutoStop", () => {
  const SILENT_2S = Math.ceil(2000 / 32); // 63 frames

  it("never fires before speech has been heard", () => {
    expect(shouldAutoStop(probs([[200, 0.0]]))).toBe(false);
    expect(shouldAutoStop([])).toBe(false);
  });

  it("fires once the silence after the last voiced frame reaches silenceMs", () => {
    expect(shouldAutoStop(probs([[10, 0.9], [SILENT_2S, 0.0]]))).toBe(true);
    expect(shouldAutoStop(probs([[10, 0.9], [SILENT_2S - 1, 0.0]]))).toBe(false);
    expect(shouldAutoStop(probs([[10, 0.9], [SILENT_2S - 1, 0.0]]), { silenceMs: 1000 })).toBe(true);
  });

  it("frames between 0.35 and 0.5 keep the speaker 'voiced'", () => {
    expect(shouldAutoStop(probs([[10, 0.9], [40, 0.4], [30, 0.0]]))).toBe(false);
    expect(shouldAutoStop(probs([[10, 0.9], [40, 0.3], [30, 0.0]]))).toBe(true);
  });

  it("new speech resets the silence counter", () => {
    expect(shouldAutoStop(probs([[10, 0.9], [SILENT_2S, 0.0], [1, 0.9]]))).toBe(false);
  });
});
