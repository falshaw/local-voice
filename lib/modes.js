// App-aware modes: the foreground window at recording start picks raw | formal | code.
// Rules are case-insensitive SUBSTRING matches only (no user regex → no ReDoS).
// First matching rule wins; nothing matches → defaultMode.

const { MODES } = require("./settings");

const MAX_RULES = 50;
const MATCH_MAX = 128;
const FIELDS = Object.freeze(["process", "title"]);

const DEFAULT_MODE_RULES = Object.freeze([
  { match: "Code", field: "process", mode: "code" },
  { match: "WindowsTerminal", field: "process", mode: "code" },
  { match: "pwsh", field: "process", mode: "code" },
  { match: "OUTLOOK", field: "process", mode: "formal" },
  { match: "thunderbird", field: "process", mode: "formal" },
  { match: "Proton Mail", field: "title", mode: "formal" },
]);

const DEFAULT_MODE_CLEANUP = Object.freeze({ raw: false, formal: true, code: false });

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function validateModeRules(rules) {
  if (!Array.isArray(rules)) throw new Error("Rules must be an array");
  if (rules.length > MAX_RULES) throw new Error(`At most ${MAX_RULES} rules`);
  return rules.map((r, i) => {
    if (!r || typeof r !== "object") throw new Error(`Rule ${i + 1}: not an object`);
    if (typeof r.match !== "string") throw new Error(`Rule ${i + 1}: match must be a string`);
    const match = r.match.trim();
    if (match.length < 1 || match.length > MATCH_MAX || CONTROL.test(match)) {
      throw new Error(`Rule ${i + 1}: match must be 1–${MATCH_MAX} printable characters`);
    }
    if (!FIELDS.includes(r.field)) throw new Error(`Rule ${i + 1}: field must be process or title`);
    if (!MODES.includes(r.mode)) throw new Error(`Rule ${i + 1}: mode must be ${MODES.join("/")}`);
    return { match, field: r.field, mode: r.mode };
  });
}

function validateModeCleanup(map) {
  if (!map || typeof map !== "object") throw new Error("Mode cleanup must be an object");
  const out = {};
  for (const m of MODES) {
    if (typeof map[m] !== "boolean") throw new Error(`Mode cleanup for ${m} must be a boolean`);
    out[m] = map[m];
  }
  return out;
}

/** `win` = { process, title } or null. */
function matchMode(rules, win, defaultMode = "raw") {
  const fallback = MODES.includes(defaultMode) ? defaultMode : "raw";
  if (!win || !Array.isArray(rules)) return fallback;
  for (const r of rules) {
    const hay = typeof win[r.field] === "string" ? win[r.field].toLowerCase() : "";
    if (hay && hay.includes(String(r.match).toLowerCase())) return r.mode;
  }
  return fallback;
}

/** Parses the PowerShell helper's JSON; anything malformed → null. */
function parseActiveWindowJson(stdout) {
  if (typeof stdout !== "string" || !stdout.trim()) return null;
  try {
    const obj = JSON.parse(stdout.trim());
    if (!obj || typeof obj !== "object") return null;
    const proc = typeof obj.process === "string" ? obj.process.slice(0, 260) : "";
    const title = typeof obj.title === "string" ? obj.title.slice(0, 512) : "";
    if (!proc && !title) return null;
    return { process: proc, title };
  } catch (_) {
    return null;
  }
}

module.exports = {
  MAX_RULES,
  MATCH_MAX,
  DEFAULT_MODE_RULES,
  DEFAULT_MODE_CLEANUP,
  validateModeRules,
  validateModeCleanup,
  matchMode,
  parseActiveWindowJson,
};
