// Settings the renderer may write through `settings:set`. Anything else is
// rejected — the IPC channel used to `store.set(key, value)` unfiltered, so a
// compromised renderer could have written arbitrary keys into the store file.
//
// Complex values (dictionary, mode rules, history) are NOT settings: they have
// their own validated IPC channels (dictionary:*, modes:*, history:*).

const STRING_MAX = 64;

const MODEL_IDS = Object.freeze([
  "onnx-community/whisper-small",
  "onnx-community/whisper-large-v3-turbo",
]);
const LANGUAGES = Object.freeze(["en", "de", "auto"]);
const MODES = Object.freeze(["raw", "formal", "code"]);

// type: "string" (1–64 chars), "string?" (0–64 chars, empty = off), "boolean",
// "enum" (one of `values`), "int" (integer in [min, max]).
const SCHEMA = Object.freeze({
  hotkey: { type: "string", default: "F9" },
  hotkey2: { type: "string?", default: "" },
  hotkey2Language: { type: "enum", values: LANGUAGES, default: "de" },
  hotkeyMode: { type: "enum", values: ["toggle", "hold"], default: "toggle" },
  modelId: { type: "enum", values: MODEL_IDS, default: MODEL_IDS[0] },
  // dml = DirectML GPU with CPU whisper-small standby + automatic fallback. Default
  // per scripts/bench-stt.js: ~4–7× faster
  // than CPU, identical transcripts, 0 failures in 12 DML runs.
  sttDevice: { type: "enum", values: ["cpu", "dml"], default: "dml" },
  language: { type: "enum", values: LANGUAGES, default: "en" },
  autoPaste: { type: "boolean", default: true },
  showOverlay: { type: "boolean", default: true },
  dictionaryEnabled: { type: "boolean", default: true },
  historyEnabled: { type: "boolean", default: true },
  historyMax: { type: "int", min: 1, max: 200, default: 50 },
  historyKeepAudio: { type: "boolean", default: false },
  cleanupEnabled: { type: "boolean", default: false },
  cleanupTimeoutMs: { type: "int", min: 2000, max: 30000, default: 12000 },
  cleanupOnlyIfLoaded: { type: "boolean", default: true },
  vadEnabled: { type: "boolean", default: false },
  vadAutoStop: { type: "boolean", default: false },
  vadSilenceMs: { type: "int", min: 800, max: 10000, default: 2000 },
  modesEnabled: { type: "boolean", default: false },
  defaultMode: { type: "enum", values: MODES, default: "raw" },
});

const SETTING_TYPES = Object.freeze(
  Object.fromEntries(Object.entries(SCHEMA).map(([k, s]) => [k, s.type])),
);
const SETTING_KEYS = Object.freeze(Object.keys(SCHEMA));
const DEFAULTS = Object.freeze(
  Object.fromEntries(Object.entries(SCHEMA).map(([k, s]) => [k, s.default])),
);

/**
 * Throws when `key` is not an allowed setting or `value` has the wrong shape.
 * Returns the value to store (strings trimmed).
 */
function validateSetting(key, value) {
  if (typeof key !== "string" || !Object.prototype.hasOwnProperty.call(SCHEMA, key)) {
    throw new Error(`Unknown setting: ${String(key)}`);
  }
  const spec = SCHEMA[key];
  switch (spec.type) {
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`Setting ${key} must be a boolean`);
      return value;
    case "int":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new Error(`Setting ${key} must be an integer`);
      }
      if (value < spec.min || value > spec.max) {
        throw new Error(`Setting ${key} must be ${spec.min}–${spec.max}`);
      }
      return value;
    case "enum":
      if (typeof value !== "string" || !spec.values.includes(value)) {
        throw new Error(`Setting ${key} must be one of: ${spec.values.join(", ")}`);
      }
      return value;
    case "string":
    case "string?": {
      if (typeof value !== "string") throw new Error(`Setting ${key} must be a string`);
      const trimmed = value.trim();
      const min = spec.type === "string" ? 1 : 0;
      if (trimmed.length < min || trimmed.length > STRING_MAX) {
        throw new Error(`Setting ${key} must be ${min}–${STRING_MAX} characters`);
      }
      return trimmed;
    }
    default:
      throw new Error(`Setting ${key} has no type`);
  }
}

/** Maps an old free-form language value onto the en|de|auto enum. */
function migrateLanguage(value) {
  if (typeof value !== "string") return "en";
  const v = value.trim().toLowerCase();
  if (v === "de" || v === "german" || v === "deutsch") return "de";
  if (v === "auto") return "auto";
  return "en";
}

/**
 * Returns the patch that brings a stored settings object onto the current schema:
 * old model ids, free-form language strings, an object-shaped hotkey and any
 * value that no longer validates are reset (language mapped, others to default).
 */
function migrateSettings(current) {
  const patch = {};
  const src = current && typeof current === "object" ? current : {};
  if (src.language !== undefined && !LANGUAGES.includes(src.language)) {
    patch.language = migrateLanguage(src.language);
  }
  for (const key of SETTING_KEYS) {
    if (key === "language" || src[key] === undefined) continue;
    try {
      const clean = validateSetting(key, src[key]);
      if (clean !== src[key]) patch[key] = clean;
    } catch (_) {
      patch[key] = DEFAULTS[key];
    }
  }
  return patch;
}

module.exports = {
  SCHEMA,
  SETTING_KEYS,
  SETTING_TYPES,
  DEFAULTS,
  STRING_MAX,
  MODEL_IDS,
  LANGUAGES,
  MODES,
  validateSetting,
  migrateLanguage,
  migrateSettings,
};
