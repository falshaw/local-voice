// Whisper model/device options (pure). Default = whisper-small (encoder fp32 + decoder
// q4, ~577 MB cached) on DirectML, chosen with scripts/bench-stt.js;
// CPU whisper-small stays the standby.

const FALLBACK_MODEL = "onnx-community/whisper-small";

const DTYPES = Object.freeze({
  "onnx-community/whisper-small": {
    // Benched 2026-10-19: fp32/q4 and fp16/fp16 equal on DML (RTF ~0.12); fp32/q4 kept
    // so CPU and GPU share one cached file set. whisper-small has no q4f16 decoder.
    cpu: { encoder_model: "fp32", decoder_model_merged: "q4" },
    dml: { encoder_model: "fp32", decoder_model_merged: "q4" },
  },
  "onnx-community/whisper-large-v3-turbo": {
    // First use downloads ~1–1.6 GB. Not benchmarked yet: opt-in only.
    cpu: { encoder_model: "q4", decoder_model_merged: "q4" },
    dml: { encoder_model: "fp16", decoder_model_merged: "q4" },
  },
});

/** pipeline() options for a model on a device ("cpu" | "dml"). Unknown model → whisper-small. */
function modelOptions(modelId, device) {
  const id = Object.prototype.hasOwnProperty.call(DTYPES, modelId) ? modelId : FALLBACK_MODEL;
  const dev = device === "dml" ? "dml" : "cpu";
  return { modelId: id, device: dev, dtype: { ...DTYPES[id][dev] } };
}

/**
 * Sessions the worker keeps: the primary one, plus CPU whisper-small as a standby
 * whenever the primary is on the GPU (VRAM busy / DML failure fallback).
 */
function sessionPlan(modelId, device) {
  const primary = modelOptions(modelId, device);
  const fallback = primary.device === "cpu" ? null : modelOptions(FALLBACK_MODEL, "cpu");
  return { primary, fallback };
}

/**
 * Releases ONNX sessions before a reload. Each distinct session is disposed once
 * (after a GPU fallback the primary IS the standby); a failing dispose is ignored so
 * the next load still runs. Returns the number of sessions disposed.
 *
 * Why not just terminate the worker: worker.terminate() on a thread that holds a
 * DirectML session takes the whole Electron process down (2026-10-20: switching
 * Device or Whisper model in Settings closed the app).
 */
async function disposeSessions(sessions) {
  const unique = [...new Set((sessions || []).filter(Boolean))];
  let disposed = 0;
  for (const s of unique) {
    try {
      if (s.pipe && typeof s.pipe.dispose === "function") {
        await s.pipe.dispose();
        disposed += 1;
      }
    } catch (_) {
      // a session that will not dispose must not block the reload
    }
  }
  return disposed;
}

module.exports = { FALLBACK_MODEL, DTYPES, modelOptions, sessionPlan, disposeSessions };
