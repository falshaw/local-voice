// Post-processing between Whisper's result and the paste:
//   dictionary → (optional LLM cleanup) → dictionary again
// The second dictionary pass is idempotent and stops the LLM from undoing terms.

const dictionary = require("./dictionary");

/**
 * @param {string} raw Whisper output
 * @param {{mode?: string, dictionary?: Array, dictionaryEnabled?: boolean,
 *          cleanup?: null | ((text: string) => Promise<{text: string, applied: boolean}>)}} opts
 * @returns {Promise<{text: string, cleaned: boolean}>}
 */
async function postprocess(raw, opts = {}) {
  const { mode = "raw", dictionary: entries = [], dictionaryEnabled = true, cleanup = null } = opts;
  let text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { text: "", cleaned: false };

  const compiled = dictionaryEnabled ? dictionary.compile(entries, mode) : null;
  text = dictionary.apply(text, compiled);

  let cleaned = false;
  if (cleanup) {
    try {
      const r = await cleanup(text);
      if (r && r.applied && typeof r.text === "string" && r.text.trim()) {
        text = r.text.trim();
        cleaned = true;
      }
    } catch (_) {
      // raw text stays
    }
    if (cleaned) text = dictionary.apply(text, compiled);
  }
  return { text, cleaned };
}

module.exports = { postprocess };
