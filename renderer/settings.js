// Settings window (renderer/settings.html). CSP is script-src 'self' / style-src 'self':
// no inline scripts, no inline styles. Every read and write goes through window.voice
// (preload.js); values are checked here first and re-validated in main.js, which also
// refuses writes that do not come from this page.

const api = window.voice;
const $ = (id) => document.getElementById(id);

const MODES = ["raw", "formal", "code"];
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const ID_RE = /^[a-f0-9]{16}$/;

// --- Small helpers -----------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, className, onClick) {
  const b = el("button", className, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

let toastTimer = null;
function toast(msg, isError = false) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("error", isError);
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), isError ? 7000 : 2500);
}

/** Strips Electron's "Error invoking remote method 'x': Error: " wrapper. */
function errMsg(e) {
  const m = e && e.message ? e.message : String(e);
  return m.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

// --- Tabs --------------------------------------------------------------------

const tabButtons = Array.from(document.querySelectorAll('nav [role="tab"]'));

function showTab(name) {
  for (const b of tabButtons) {
    const on = b.dataset.tab === name;
    b.setAttribute("aria-selected", String(on));
    $(`tab-${b.dataset.tab}`).classList.toggle("hidden", !on);
  }
  if (name === "history") loadHistory();
}

for (const b of tabButtons) b.addEventListener("click", () => showTab(b.dataset.tab));

// --- General tab: rendered from the real schema (settings:schema) ------------

const LANG_LABELS = { en: "English", de: "Deutsch", auto: "Auto (EN / DE)" };

const GENERAL = [
  {
    legend: "Hotkeys",
    fields: [
      { key: "hotkey", label: "Hotkey", note: "Electron accelerator, e.g. F9 or Ctrl+Shift+F9. Hold mode needs an F-key." },
      {
        key: "hotkeyMode",
        label: "Hotkey mode",
        labels: { toggle: "Toggle — press to start, press again to stop", hold: "Hold — push-to-talk (uiohook)" },
      },
      { key: "hotkey2", label: "Second hotkey", note: "Empty = off. Dictates in the language below (e.g. F8 for German)." },
      { key: "hotkey2Language", label: "Second hotkey language", radio: true, labels: LANG_LABELS },
    ],
  },
  {
    legend: "Language and model",
    fields: [
      { key: "language", label: "Language", radio: true, labels: LANG_LABELS, note: "Auto is weak on clips under 2 s; task stays transcribe, German is never translated." },
      {
        key: "modelId",
        label: "Whisper model",
        labels: {
          "onnx-community/whisper-small": "whisper-small (cached, ~577 MB)",
          "onnx-community/whisper-large-v3-turbo": "whisper-large-v3-turbo (downloads ~1.6 GB on first use)",
        },
      },
      { key: "sttDevice", label: "Device", labels: { cpu: "CPU", dml: "GPU — DirectML, CPU whisper-small as standby" } },
    ],
  },
  {
    legend: "Output",
    fields: [
      { key: "autoPaste", label: "Auto-paste (Ctrl+V)", note: "Off = the text is only put on the clipboard." },
      { key: "showOverlay", label: "Show overlay" },
      { key: "dictionaryEnabled", label: "Apply dictionary" },
    ],
  },
  {
    legend: "Cleanup — Ollama gemma4:31b on 127.0.0.1 (model and URL are fixed)",
    fields: [
      { key: "cleanupEnabled", label: "Clean up transcripts", note: "With modes on, only the modes ticked under Modes are cleaned." },
      { key: "cleanupTimeoutMs", label: "Timeout (ms)" },
      { key: "cleanupOnlyIfLoaded", label: "Skip when gemma4 is not resident", note: "A cold 31B load cannot meet any timeout; the raw text is pasted instead." },
    ],
  },
  {
    legend: "Voice activity detection (Silero)",
    fields: [
      { key: "vadEnabled", label: "Enable VAD", note: "Trims silence around speech; silent recordings are dropped instead of hallucinated." },
      { key: "vadAutoStop", label: "Stop automatically after silence" },
      { key: "vadSilenceMs", label: "Silence before auto-stop (ms)" },
    ],
  },
  {
    legend: "History",
    fields: [
      { key: "historyEnabled", label: "Keep history" },
      { key: "historyMax", label: "Entries to keep" },
      { key: "historyKeepAudio", label: "Keep audio (WAV, ~32 KB/s)" },
    ],
  },
  {
    legend: "App-aware modes",
    fields: [
      { key: "modesEnabled", label: "Pick the mode from the foreground window", note: "Rules under Modes. Window titles are read at recording start and never stored." },
      { key: "defaultMode", label: "Default mode", labels: { raw: "raw", formal: "formal", code: "code" } },
    ],
  },
];

let schema = {};
let settings = {};
const controls = new Map(); // key → { set(value) }

/** Client-side check mirroring lib/settings.js; main.js re-validates. */
function checkValue(key, value) {
  const spec = schema[key];
  if (!spec) throw new Error(`Unknown setting ${key}`);
  switch (spec.type) {
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`${key} must be on or off`);
      return value;
    case "int":
      if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${key} must be a whole number`);
      if (value < spec.min || value > spec.max) throw new Error(`${key} must be ${spec.min}–${spec.max}`);
      return value;
    case "enum":
      if (!spec.values.includes(value)) throw new Error(`${key} must be one of ${spec.values.join(", ")}`);
      return value;
    case "string":
    case "string?": {
      if (typeof value !== "string") throw new Error(`${key} must be text`);
      const v = value.trim();
      const min = spec.type === "string" ? 1 : 0;
      if (v.length < min || v.length > 64) throw new Error(`${key} must be ${min}–64 characters`);
      return v;
    }
    default:
      throw new Error(`${key} has no type`);
  }
}

async function commit(key, value, label) {
  try {
    const clean = checkValue(key, value);
    settings = await api.setSetting(key, clean);
    toast(`${label} saved`);
  } catch (e) {
    toast(errMsg(e), true);
  }
  // Main may have rolled back (hotkey failed to register) — mirror what it holds.
  for (const [k, c] of controls) c.set(settings[k]);
}

function buildControl(field, spec) {
  const key = field.key;
  const id = `s-${key}`;
  if (spec.type === "boolean") {
    const input = el("input");
    input.type = "checkbox";
    input.id = id;
    input.addEventListener("change", () => commit(key, input.checked, field.label));
    controls.set(key, { set: (v) => (input.checked = v === true) });
    return input;
  }
  if (spec.type === "int") {
    const input = el("input");
    input.type = "number";
    input.id = id;
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = "1";
    input.addEventListener("change", () => commit(key, Number(input.value), field.label));
    controls.set(key, { set: (v) => (input.value = v === undefined ? "" : String(v)) });
    return input;
  }
  if (spec.type === "enum" && field.radio) {
    const group = el("div", "radios");
    const inputs = [];
    for (const v of spec.values) {
      const lab = el("label");
      const input = el("input");
      input.type = "radio";
      input.name = key;
      input.value = v;
      if (!inputs.length) input.id = id;
      input.addEventListener("change", () => input.checked && commit(key, v, field.label));
      inputs.push(input);
      lab.append(input, ` ${(field.labels && field.labels[v]) || v}`);
      group.append(lab);
    }
    controls.set(key, { set: (val) => inputs.forEach((i) => (i.checked = i.value === val)) });
    return group;
  }
  if (spec.type === "enum") {
    const select = el("select");
    select.id = id;
    for (const v of spec.values) {
      const opt = el("option", null, (field.labels && field.labels[v]) || v);
      opt.value = v;
      select.append(opt);
    }
    select.addEventListener("change", () => commit(key, select.value, field.label));
    controls.set(key, { set: (v) => (select.value = v) });
    return select;
  }
  const input = el("input");
  input.type = "text";
  input.id = id;
  input.maxLength = 64;
  input.spellcheck = false;
  input.addEventListener("change", () => commit(key, input.value, field.label));
  controls.set(key, { set: (v) => (input.value = v === undefined ? "" : String(v)) });
  return input;
}

function renderGeneral() {
  const form = $("general-form");
  form.replaceChildren();
  form.addEventListener("submit", (e) => e.preventDefault());
  for (const group of GENERAL) {
    const fs = el("fieldset");
    fs.append(el("legend", null, group.legend));
    for (const field of group.fields) {
      const spec = schema[field.key];
      if (!spec) continue;
      const row = el("div", "row");
      const label = el("label", null, field.label);
      label.htmlFor = `s-${field.key}`;
      row.append(label, buildControl(field, spec));
      if (field.note) row.append(el("div", "note", field.note));
      fs.append(row);
    }
    form.append(fs);
  }
  // Any schema key the layout above does not know still gets a plain row.
  const known = new Set(GENERAL.flatMap((g) => g.fields.map((f) => f.key)));
  const rest = Object.keys(schema).filter((k) => !known.has(k));
  if (rest.length) {
    const fs = el("fieldset");
    fs.append(el("legend", null, "Other"));
    for (const key of rest) {
      const row = el("div", "row");
      const label = el("label", null, key);
      label.htmlFor = `s-${key}`;
      row.append(label, buildControl({ key, label: key }, schema[key]));
      fs.append(row);
    }
    form.append(fs);
  }
  for (const [k, c] of controls) c.set(settings[k]);
}

// --- Status line -------------------------------------------------------------

async function refreshStatus() {
  try {
    const s = await api.getStatus();
    const model = String(s.stt.modelId || "").replace("onnx-community/", "");
    const parts = [
      `STT: ${model} on ${String(s.stt.device || "cpu").toUpperCase()}${s.stt.ready ? "" : " (loading)"}`,
      `VAD: ${s.vad.enabled ? (s.vad.ready ? "on" : "loading") : "off"}`,
      `Hold: ${s.pushToTalk ? "on" : "off"}`,
      `State: ${s.state}`,
      ...(s.notices || []),
    ];
    $("status").textContent = parts.join(" · ");
  } catch (e) {
    $("status").textContent = errMsg(e);
  }
}

// --- Dictionary tab ----------------------------------------------------------

function textCell(value, maxLength, placeholder) {
  const td = el("td");
  const input = el("input");
  input.type = "text";
  input.maxLength = maxLength;
  input.spellcheck = false;
  input.placeholder = placeholder;
  input.value = value;
  td.append(input);
  return td;
}

function checkCell(checked, title) {
  const td = el("td");
  const input = el("input");
  input.type = "checkbox";
  input.checked = checked;
  if (title) input.title = title;
  td.append(input);
  return td;
}

function dictRow(entry = {}) {
  const tr = el("tr");
  tr.append(textCell(entry.from || "", 64, "spoken word or phrase"));
  tr.append(textCell(entry.to || "", 256, "typed replacement"));
  tr.append(checkCell(entry.caseSensitive === true, "Match exact spelling only"));
  const modes = Array.isArray(entry.modes) ? entry.modes : [];
  for (const m of MODES) tr.append(checkCell(modes.includes(m), `Only in ${m} mode`));
  const td = el("td");
  td.append(button("Delete", "danger", () => tr.remove()));
  tr.append(td);
  return tr;
}

function renderDictionary(entries) {
  const body = $("dict-table").querySelector("tbody");
  body.replaceChildren(...entries.map(dictRow));
}

/** Reads the table back into entries; throws on the first bad row. */
function collectDictionary() {
  const rows = Array.from($("dict-table").querySelectorAll("tbody tr"));
  if (rows.length > 500) throw new Error("At most 500 entries");
  return rows.map((tr, i) => {
    const inputs = tr.querySelectorAll("input");
    const from = inputs[0].value.trim().replace(/\s+/g, " ");
    const to = inputs[1].value.trim();
    if (from.length < 1 || from.length > 64) throw new Error(`Row ${i + 1}: "Spoken" must be 1–64 characters`);
    if (to.length > 256) throw new Error(`Row ${i + 1}: "Typed" must be at most 256 characters`);
    if (CONTROL_RE.test(from) || CONTROL_RE.test(to)) throw new Error(`Row ${i + 1}: control characters are not allowed`);
    const modes = MODES.filter((_, k) => inputs[3 + k].checked);
    return { from, to, caseSensitive: inputs[2].checked, modes };
  });
}

async function loadDictionary() {
  try {
    renderDictionary(await api.getDictionary());
  } catch (e) {
    toast(errMsg(e), true);
  }
}

async function saveDictionary() {
  try {
    const entries = collectDictionary();
    renderDictionary(await api.setDictionary(entries));
    toast(`Dictionary saved (${entries.length} entries)`);
  } catch (e) {
    toast(errMsg(e), true);
  }
}

function importDictionary(file) {
  if (!file) return;
  file
    .text()
    .then((text) => {
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new Error("JSON must be an array of {from, to, caseSensitive, modes}");
      if (data.length > 500) throw new Error("At most 500 entries");
      const entries = data.map((e, i) => {
        if (!e || typeof e !== "object" || typeof e.from !== "string" || typeof e.to !== "string") {
          throw new Error(`Entry ${i + 1}: needs string "from" and "to"`);
        }
        return {
          from: e.from,
          to: e.to,
          caseSensitive: e.caseSensitive === true,
          modes: Array.isArray(e.modes) ? e.modes.filter((m) => MODES.includes(m)) : [],
        };
      });
      renderDictionary(entries);
      toast(`Imported ${entries.length} entries — click Save to keep them`);
    })
    .catch((e) => toast(`Import failed: ${errMsg(e)}`, true));
}

function exportDictionary() {
  let entries;
  try {
    entries = collectDictionary();
  } catch (e) {
    toast(errMsg(e), true);
    return;
  }
  const blob = new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = el("a");
  a.href = url;
  a.download = "voice-dictionary.json";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

$("dict-add").addEventListener("click", () => {
  const tr = dictRow();
  $("dict-table").querySelector("tbody").append(tr);
  tr.querySelector("input").focus();
});
$("dict-save").addEventListener("click", saveDictionary);
$("dict-export").addEventListener("click", exportDictionary);
$("dict-import").addEventListener("change", (e) => {
  importDictionary(e.target.files && e.target.files[0]);
  e.target.value = "";
});

// --- Modes tab ---------------------------------------------------------------

function selectCell(values, value) {
  const td = el("td");
  const select = el("select");
  for (const v of values) {
    const opt = el("option", null, v);
    opt.value = v;
    select.append(opt);
  }
  select.value = value;
  td.append(select);
  return td;
}

function ruleRow(rule = {}) {
  const tr = el("tr");
  tr.append(textCell(rule.match || "", 128, "text to look for"));
  tr.append(selectCell(["process", "title"], rule.field === "title" ? "title" : "process"));
  tr.append(selectCell(MODES, MODES.includes(rule.mode) ? rule.mode : "raw"));
  const td = el("td");
  td.append(button("Delete", "danger", () => tr.remove()));
  tr.append(td);
  return tr;
}

function renderModes({ rules, cleanup }) {
  $("rules-table").querySelector("tbody").replaceChildren(...rules.map(ruleRow));
  for (const m of MODES) $(`mc-${m}`).checked = cleanup && cleanup[m] === true;
}

function collectModes() {
  const rows = Array.from($("rules-table").querySelectorAll("tbody tr"));
  if (rows.length > 50) throw new Error("At most 50 rules");
  const rules = rows.map((tr, i) => {
    const match = tr.querySelector("input").value.trim();
    if (match.length < 1 || match.length > 128) throw new Error(`Rule ${i + 1}: text must be 1–128 characters`);
    if (CONTROL_RE.test(match)) throw new Error(`Rule ${i + 1}: control characters are not allowed`);
    const selects = tr.querySelectorAll("select");
    return { match, field: selects[0].value, mode: selects[1].value };
  });
  const cleanup = Object.fromEntries(MODES.map((m) => [m, $(`mc-${m}`).checked]));
  return { rules, cleanup };
}

let modeDefaults = null;

async function loadModes() {
  try {
    const r = await api.getModes();
    modeDefaults = r.defaults;
    renderModes(r);
  } catch (e) {
    toast(errMsg(e), true);
  }
}

async function saveModes(payload) {
  try {
    renderModes(await api.setModes(payload));
    toast(`Modes saved (${payload.rules.length} rules)`);
  } catch (e) {
    toast(errMsg(e), true);
  }
}

$("rules-add").addEventListener("click", () => {
  const tr = ruleRow();
  $("rules-table").querySelector("tbody").append(tr);
  tr.querySelector("input").focus();
});
$("rules-save").addEventListener("click", () => {
  try {
    saveModes(collectModes());
  } catch (e) {
    toast(errMsg(e), true);
  }
});
$("rules-defaults").addEventListener("click", () => {
  if (!modeDefaults) return;
  saveModes({ rules: modeDefaults.rules.map((r) => ({ ...r })), cleanup: { ...modeDefaults.cleanup } });
});

// --- History tab -------------------------------------------------------------

const audioEl = $("history-audio");
let audioUrl = null;
let playingButton = null;

function stopAudio() {
  audioEl.pause();
  audioEl.removeAttribute("src");
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = null;
  if (playingButton) playingButton.textContent = "▶";
  playingButton = null;
}
audioEl.addEventListener("ended", stopAudio);
audioEl.addEventListener("error", () => {
  toast("Could not play this recording", true);
  stopAudio();
});

async function playEntry(id, btn) {
  if (playingButton === btn) {
    stopAudio();
    return;
  }
  stopAudio();
  try {
    const ab = await api.getHistoryAudio(id);
    if (!ab || !ab.byteLength) {
      toast("No audio kept for this entry", true);
      return;
    }
    // Blob URL only — never file:// (CSP media-src 'self' blob:).
    audioUrl = URL.createObjectURL(new Blob([ab], { type: "audio/wav" }));
    audioEl.src = audioUrl;
    playingButton = btn;
    btn.textContent = "■";
    await audioEl.play();
  } catch (e) {
    toast(errMsg(e), true);
    stopAudio();
  }
}

function fmtMeta(e) {
  const when = new Date(e.ts).toLocaleString();
  const secs = ((Number(e.durationMs) || 0) / 1000).toFixed(1);
  const parts = [when, e.lang || "?", e.mode || "raw", `${secs} s`];
  if (e.raw && e.raw !== e.text) parts.push("cleaned");
  if (e.audio) parts.push("audio");
  return parts.join(" · ");
}

function historyItem(e) {
  const li = el("li");
  const meta = el("div", "meta", fmtMeta(e));
  if (e.raw && e.raw !== e.text) meta.title = `Raw transcript:\n${e.raw}`;
  li.append(meta, el("div", "text", e.text));
  const buttons = el("div", "buttons");
  buttons.append(
    button("Copy", null, async () => {
      try {
        await api.copyHistory(e.id);
        toast("Copied to the clipboard");
      } catch (err) {
        toast(errMsg(err), true);
      }
    }),
    button("Re-paste", "primary", async () => {
      try {
        const r = await api.pasteHistory(e.id);
        toast(r && r.pasted ? "Pasted into the previous window" : "Auto-paste is off — copied to the clipboard");
      } catch (err) {
        toast(errMsg(err), true);
      }
    }),
  );
  if (e.audio) {
    const play = button("▶", null, () => playEntry(e.id, play));
    play.title = "Play the recording";
    buttons.append(play);
  }
  buttons.append(
    button("Delete", "danger", async () => {
      try {
        await api.deleteHistory(e.id);
        if (playingButton && li.contains(playingButton)) stopAudio();
        li.remove();
        if (!$("history-list").children.length) renderHistory([]);
      } catch (err) {
        toast(errMsg(err), true);
      }
    }),
  );
  li.append(buttons);
  return li;
}

function renderHistory(entries) {
  const list = $("history-list");
  if (!entries.length) {
    const li = el("li", "meta", "No dictations yet.");
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(...entries.filter((e) => e && ID_RE.test(e.id)).map(historyItem));
}

async function loadHistory() {
  stopAudio();
  try {
    renderHistory(await api.listHistory());
  } catch (e) {
    toast(errMsg(e), true);
  }
}

let clearArmed = null;
$("history-refresh").addEventListener("click", loadHistory);
$("history-clear").addEventListener("click", async () => {
  const btn = $("history-clear");
  if (!clearArmed) {
    btn.textContent = "Really clear everything?";
    clearArmed = setTimeout(() => {
      btn.textContent = "Clear history";
      clearArmed = null;
    }, 4000);
    return;
  }
  clearTimeout(clearArmed);
  clearArmed = null;
  btn.textContent = "Clear history";
  try {
    await api.clearHistory();
    stopAudio();
    renderHistory([]);
    toast("History cleared");
  } catch (e) {
    toast(errMsg(e), true);
  }
});

// --- Boot --------------------------------------------------------------------

async function boot() {
  try {
    [schema, settings] = await Promise.all([api.getSettingsSchema(), api.getSettings()]);
    renderGeneral();
  } catch (e) {
    toast(`Settings unavailable: ${errMsg(e)}`, true);
  }
  await Promise.all([loadDictionary(), loadModes()]);
  refreshStatus();
  setInterval(refreshStatus, 3000);
}

boot();
