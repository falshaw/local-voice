// Voice-activity maths (pure). The Silero model itself runs in lib/vad-worker.js.
//
// Frames are 512 samples at 16 kHz (32 ms), one speech probability per frame.

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 512;
const FRAME_MS = (FRAME_SAMPLES / SAMPLE_RATE) * 1000; // 32
const SPEECH_THRESHOLD = 0.5;
const SILENCE_THRESHOLD = 0.35;

/**
 * Sample range to keep: [firstSpeech − padStartMs, lastSpeech + padEndMs], clamped
 * to the recording. Returns null when there is no speech at all (fewer than
 * `minSpeechFrames` frames ≥ threshold), so the job is dropped as empty instead of
 * letting Whisper hallucinate on silence.
 */
function trimSegments(probs, opts = {}) {
  const {
    threshold = SPEECH_THRESHOLD,
    padStartMs = 200,
    padEndMs = 300,
    frameSamples = FRAME_SAMPLES,
    sampleRate = SAMPLE_RATE,
    totalSamples = probs.length * frameSamples,
    minSpeechFrames = 2,
  } = opts;
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = 0; i < probs.length; i++) {
    if (probs[i] >= threshold) {
      if (first < 0) first = i;
      last = i;
      count++;
    }
  }
  if (count < minSpeechFrames) return null;
  const padStart = Math.round((padStartMs / 1000) * sampleRate);
  const padEnd = Math.round((padEndMs / 1000) * sampleRate);
  const start = Math.max(0, first * frameSamples - padStart);
  const end = Math.min(totalSamples, (last + 1) * frameSamples + padEnd);
  if (end <= start) return null;
  return { start, end };
}

/**
 * Auto-stop: true once speech has been heard and every frame since the last voiced
 * frame (p ≥ silenceThreshold) adds up to at least `silenceMs`.
 */
function shouldAutoStop(probs, opts = {}) {
  const {
    silenceMs = 2000,
    speechThreshold = SPEECH_THRESHOLD,
    silenceThreshold = SILENCE_THRESHOLD,
    frameMs = FRAME_MS,
  } = opts;
  let heard = false;
  let lastVoiced = -1;
  for (let i = 0; i < probs.length; i++) {
    if (probs[i] >= speechThreshold) heard = true;
    if (heard && probs[i] >= silenceThreshold) lastVoiced = i;
  }
  if (!heard) return false;
  return (probs.length - 1 - lastVoiced) * frameMs >= silenceMs;
}

module.exports = {
  SAMPLE_RATE,
  FRAME_SAMPLES,
  FRAME_MS,
  SPEECH_THRESHOLD,
  SILENCE_THRESHOLD,
  trimSegments,
  shouldAutoStop,
};
