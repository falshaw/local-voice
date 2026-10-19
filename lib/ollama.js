// Host Ollama access. URL and model are CONSTANTS on purpose: neither is a setting,
// so a compromised renderer cannot redirect dictated text off the laptop.

const OLLAMA_URL = "http://127.0.0.1:11434";
const CLEANUP_MODEL = "gemma4:31b";
const VRAM_LIMIT_BYTES = 5.5 * 1024 ** 3;

async function fetchJson(fetchImpl, url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** GET /api/ps → models array, or null when Ollama is unreachable. */
async function listLoaded(fetchImpl = fetch, timeoutMs = 800) {
  try {
    const body = await fetchJson(fetchImpl, `${OLLAMA_URL}/api/ps`, { method: "GET" }, timeoutMs);
    return Array.isArray(body && body.models) ? body.models : [];
  } catch (_) {
    return null;
  }
}

function isModelLoaded(models, model = CLEANUP_MODEL) {
  return Array.isArray(models) && models.some((m) => m && (m.name === model || m.model === model));
}

/** Total VRAM held by resident Ollama models (bytes). */
function vramHeld(models) {
  if (!Array.isArray(models)) return 0;
  return models.reduce((sum, m) => sum + (Number(m && m.size_vram) || 0), 0);
}

/** True when Ollama holds so much VRAM that Whisper should run on the CPU. */
function gpuBusy(models, limit = VRAM_LIMIT_BYTES) {
  return vramHeld(models) > limit;
}

module.exports = {
  OLLAMA_URL,
  CLEANUP_MODEL,
  VRAM_LIMIT_BYTES,
  fetchJson,
  listLoaded,
  isModelLoaded,
  vramHeld,
  gpuBusy,
};
