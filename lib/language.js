// Language selection for a dictation job.
//
// transformers.js 4.3 does NOT auto-detect: `language: null` silently falls back to
// English (modeling_whisper.js "TODO: Implement language detection"). So "auto" is
// done here: the worker runs one decoder step after <|startoftranscript|> and
// compares the logits of the candidate language tokens (EN vs DE only).

const CANDIDATES = Object.freeze(["en", "de"]);

/**
 * The language a job runs with: the hotkey's own language when it has one
 * (hotkey2 → hotkey2Language), else the global setting. Returns "en" | "de" | "auto".
 */
function resolveJobLanguage(hotkeyLanguage, settingLanguage) {
  const pick = hotkeyLanguage || settingLanguage;
  return pick === "de" || pick === "auto" ? pick : "en";
}

/** Value sent to the worker: null means "detect". */
function toWorkerLanguage(lang) {
  return lang === "auto" ? null : lang === "de" ? "de" : "en";
}

/** Picks the highest-scoring candidate; ties and missing scores fall back to "en". */
function pickLanguage(scores, candidates = CANDIDATES) {
  let best = "en";
  let bestScore = -Infinity;
  for (const lang of candidates) {
    const s = scores ? scores[lang] : undefined;
    if (typeof s === "number" && Number.isFinite(s) && s > bestScore) {
      best = lang;
      bestScore = s;
    }
  }
  return best;
}

/**
 * EN vs DE from one decoder step after <|startoftranscript|>. Verified against
 * @huggingface/transformers 4.3.1 (src/models/whisper/modeling_whisper.js
 * `_retrieve_init_tokens`): `language: null` only logs "No language specified -
 * defaulting to English" and forces <|en|>, so detection has to happen here.
 *
 * @param {{Tensor: Function}} T the transformers module (Tensor class)
 * @param {object} pipe an automatic-speech-recognition pipeline (processor + model)
 * @param {Float32Array} audio 16 kHz mono samples
 */
async function detectLanguage(T, pipe, audio, candidates = CANDIDATES) {
  const gc = pipe && pipe.model && pipe.model.generation_config;
  const lang2id = gc && gc.lang_to_id;
  if (!lang2id || typeof gc.decoder_start_token_id !== "number") return "en";
  const feats = await pipe.processor(audio);
  const out = await pipe.model({
    input_features: feats.input_features,
    decoder_input_ids: new T.Tensor("int64", new BigInt64Array([BigInt(gc.decoder_start_token_id)]), [1, 1]),
  });
  const logits = out.logits.data;
  const scores = {};
  for (const lang of candidates) {
    const id = lang2id[`<|${lang}|>`];
    if (typeof id === "number") scores[lang] = Number(logits[id]);
  }
  return pickLanguage(scores, candidates);
}

module.exports = { CANDIDATES, resolveJobLanguage, toWorkerLanguage, pickLanguage, detectLanguage };
