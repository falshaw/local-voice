// Optional transcript cleanup on host Ollama (gemma4:31b). Off by default.
// Any failure — Ollama down, model not resident, timeout, HTTP error, output that
// fails the sanity gate — returns the RAW text. Cleanup never blocks a paste.

const fs = require("fs");
const path = require("path");
const { OLLAMA_URL, CLEANUP_MODEL, fetchJson, listLoaded, isModelLoaded } = require("./ollama");

const PROMPT_DIR = path.join(__dirname, "prompts");
const promptCache = new Map();

function loadPrompt(mode) {
  const m = mode === "formal" || mode === "code" ? mode : "raw";
  if (!promptCache.has(m)) {
    promptCache.set(m, fs.readFileSync(path.join(PROMPT_DIR, `cleanup-${m}.txt`), "utf8").trim());
  }
  return promptCache.get(m);
}

/** Output must be non-empty, 0.5–1.6× the input length and not start with "Here". */
function passesGate(input, output) {
  if (typeof output !== "string") return false;
  const out = output.trim();
  if (!out) return false;
  const ratio = out.length / Math.max(1, input.trim().length);
  if (ratio < 0.5 || ratio > 1.6) return false;
  if (/^here\b/i.test(out)) return false;
  return true;
}

function numPredict(text) {
  return Math.ceil((text.length / 4) * 1.5) + 32;
}

/**
 * Returns { text, applied, reason }. `applied` is true only when the cleaned text
 * replaced the raw one.
 */
async function cleanupText(raw, opts = {}) {
  const {
    mode = "raw",
    timeoutMs = 12000,
    onlyIfLoaded = true,
    fetchImpl = fetch,
    system = null,
  } = opts;
  const input = typeof raw === "string" ? raw.trim() : "";
  if (!input) return { text: input, applied: false, reason: "empty" };

  try {
    if (onlyIfLoaded) {
      const models = await listLoaded(fetchImpl, Math.min(1000, timeoutMs));
      if (models === null) return { text: input, applied: false, reason: "ollama-unreachable" };
      // A cold 31B load on 8 GB VRAM cannot meet any sane timeout → skip.
      if (!isModelLoaded(models)) return { text: input, applied: false, reason: "not-loaded" };
    }
    const body = await fetchJson(
      fetchImpl,
      `${OLLAMA_URL}/api/generate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: CLEANUP_MODEL,
          system: system || loadPrompt(mode),
          prompt: input,
          stream: false,
          think: false,
          keep_alive: "10m",
          options: { temperature: 0, num_predict: numPredict(input) },
        }),
      },
      timeoutMs,
    );
    const out = body && typeof body.response === "string" ? body.response.trim() : "";
    if (!passesGate(input, out)) return { text: input, applied: false, reason: "gate" };
    return { text: out, applied: true, reason: "ok" };
  } catch (err) {
    const reason = err && err.name === "AbortError" ? "timeout" : "error";
    return { text: input, applied: false, reason };
  }
}

module.exports = { cleanupText, passesGate, numPredict, loadPrompt };
