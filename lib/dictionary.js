// Personal dictionary: whole-word / phrase replacements applied to the transcript.
//
// - Whole word: a match may not touch a letter, digit or underscore on either side
//   (Unicode-aware, so "Straße" and "Müller" behave like any other word).
// - Phrases are allowed; whitespace inside a phrase matches any run of spaces.
// - Longer `from` values win (one regex alternation, longest first, single pass —
//   a replacement is never re-scanned by another entry inside the same pass).
// - If `to` contains an uppercase letter it is inserted verbatim; otherwise its case
//   mirrors the matched text (ALL CAPS or Capitalised).
// - `caseSensitive: true` entries only match the exact spelling of `from`.
// - `modes: []` (or missing) = every mode; otherwise only the listed modes.

const { MODES } = require("./settings");

const MAX_ENTRIES = 500;
const FROM_MAX = 64;
const TO_MAX = 256;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const WORD = "[\\p{L}\\p{N}_]";

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normSpace(s) {
  return s.replace(/\s+/g, " ");
}

/** Validates and normalises a dictionary array. Throws on any bad entry. */
function validateDictionary(entries) {
  if (!Array.isArray(entries)) throw new Error("Dictionary must be an array");
  if (entries.length > MAX_ENTRIES) throw new Error(`Dictionary is limited to ${MAX_ENTRIES} entries`);
  return entries.map((e, i) => {
    if (!e || typeof e !== "object" || Array.isArray(e)) throw new Error(`Entry ${i + 1}: not an object`);
    if (typeof e.from !== "string" || typeof e.to !== "string") {
      throw new Error(`Entry ${i + 1}: from/to must be strings`);
    }
    const from = normSpace(e.from.trim());
    const to = e.to.trim();
    if (from.length < 1 || from.length > FROM_MAX) throw new Error(`Entry ${i + 1}: "from" must be 1–${FROM_MAX} characters`);
    if (to.length > TO_MAX) throw new Error(`Entry ${i + 1}: "to" must be at most ${TO_MAX} characters`);
    if (CONTROL.test(from) || CONTROL.test(to)) throw new Error(`Entry ${i + 1}: control characters are not allowed`);
    if (e.caseSensitive !== undefined && typeof e.caseSensitive !== "boolean") {
      throw new Error(`Entry ${i + 1}: caseSensitive must be a boolean`);
    }
    let modes = [];
    if (e.modes !== undefined) {
      if (!Array.isArray(e.modes) || e.modes.some((m) => !MODES.includes(m))) {
        throw new Error(`Entry ${i + 1}: modes must be a list of ${MODES.join("/")}`);
      }
      modes = [...new Set(e.modes)];
    }
    return { from, to, caseSensitive: e.caseSensitive === true, modes };
  });
}

/** Builds the matcher for one mode. Returns null when nothing applies. */
function compile(entries, mode) {
  const list = (entries || [])
    .filter((e) => !mode || !e.modes || e.modes.length === 0 || e.modes.includes(mode))
    .slice()
    .sort((a, b) => b.from.length - a.from.length);
  if (list.length === 0) return null;
  const alternation = list
    .map((e) => escapeRegex(e.from).replace(/ /g, "\\s+"))
    .join("|");
  const re = new RegExp(`(?<!${WORD})(?:${alternation})(?!${WORD})`, "giu");
  const byLower = new Map();
  for (const e of list) {
    const key = e.from.toLocaleLowerCase();
    if (!byLower.has(key)) byLower.set(key, []);
    byLower.get(key).push(e);
  }
  return { re, byLower };
}

function mirrorCase(match, to) {
  if (/\p{Lu}/u.test(to)) return to;
  const letters = match.replace(/[^\p{L}]/gu, "");
  if (letters.length > 1 && letters === letters.toLocaleUpperCase() && letters !== letters.toLocaleLowerCase()) {
    return to.toLocaleUpperCase();
  }
  const first = match.match(/\p{L}/u);
  if (first && first[0] !== first[0].toLocaleLowerCase()) {
    return to.charAt(0).toLocaleUpperCase() + to.slice(1);
  }
  return to;
}

/**
 * True when `to` already sits in the text spanning the match — i.e. an earlier pass
 * expanded "vpn" → "vpn tunnel" and this pass sees the "vpn" inside it. Without this
 * the pipeline's second pass (after LLM cleanup) would grow it to "vpn tunnel tunnel".
 */
function alreadyExpanded(text, offset, matchLen, to) {
  if (to.length <= matchLen) return false;
  const want = to.toLocaleLowerCase();
  const lo = Math.max(0, offset + matchLen - to.length);
  const hi = Math.min(offset, text.length - to.length);
  for (let i = lo; i <= hi; i++) {
    if (text.slice(i, i + to.length).toLocaleLowerCase() === want) return true;
  }
  return false;
}

/** Applies a compiled dictionary to `text`. Idempotent: apply(apply(t)) === apply(t). */
function apply(text, compiled) {
  if (!compiled || typeof text !== "string" || !text) return text;
  compiled.re.lastIndex = 0;
  return text.replace(compiled.re, (match, offset) => {
    const norm = normSpace(match);
    const candidates = compiled.byLower.get(norm.toLocaleLowerCase()) || [];
    const exact = candidates.find((e) => e.caseSensitive && e.from === norm);
    if (exact) return alreadyExpanded(text, offset, match.length, exact.to) ? match : exact.to;
    const loose = candidates.find((e) => !e.caseSensitive);
    if (loose) return alreadyExpanded(text, offset, match.length, loose.to) ? match : mirrorCase(match, loose.to);
    return match;
  });
}

module.exports = { MAX_ENTRIES, FROM_MAX, TO_MAX, validateDictionary, compile, apply, mirrorCase };
