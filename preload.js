// IPC bridge shared by the overlay (renderer/index.html) and the settings window
// (renderer/settings.html). Arguments are shape-checked here AND re-validated in
// main.js; main additionally refuses writes that do not come from settings.html.

const { contextBridge, ipcRenderer } = require("electron");

const FRAME_BYTES = 512 * 4;
const ID_RE = /^[a-f0-9]{16}$/;

function fail(msg) {
  return Promise.reject(new Error(msg));
}
function isBuffer(b, maxBytes, exact) {
  // toString check, not instanceof: values crossing the contextBridge come from another realm.
  return Object.prototype.toString.call(b) === "[object ArrayBuffer]" && (exact ? b.byteLength === maxBytes : b.byteLength <= maxBytes && b.byteLength % 4 === 0);
}
function isId(id) {
  return typeof id === "string" && ID_RE.test(id);
}
function on(channel, callback, map = (...a) => a) {
  if (typeof callback !== "function") return;
  ipcRenderer.on(channel, (_e, ...args) => callback(...map(...args)));
}

contextBridge.exposeInMainWorld("voice", {
  // Events from main process
  onRecordingStart: (cb) => on("recording:start", cb, () => []),
  onRecordingStop: (cb) => on("recording:stop", cb, () => []),
  onRecordingCancel: (cb) => on("recording:cancel", cb, () => []),
  onModelProgress: (cb) => on("model:progress", cb, (p) => [Number(p) || 0]),
  onModelReady: (cb) => on("model:ready", cb, () => []),
  onTranscriptionDone: (cb) => on("transcription:done", cb, (t) => [String(t || "")]),
  onTranscriptionError: (cb) => on("transcription:error", cb, (e) => [String(e || "")]),

  // Audio capture: 512-sample Float32 frames, then the tail (< 512 samples).
  sendFrame: (ab) => {
    if (isBuffer(ab, FRAME_BYTES, true)) ipcRenderer.send("audio:frame", ab);
  },
  sendAudioEnd: (ab) => {
    ipcRenderer.send("audio:end", isBuffer(ab, FRAME_BYTES, false) ? ab : new ArrayBuffer(0));
  },
  sendEmpty: () => ipcRenderer.send("audio:empty"),

  // Settings + status
  getSettings: () => ipcRenderer.invoke("settings:get"),
  getSettingsSchema: () => ipcRenderer.invoke("settings:schema"),
  setSetting: (key, value) => {
    if (typeof key !== "string" || key.length > 64) return fail("Invalid setting key");
    if (!["string", "boolean", "number"].includes(typeof value)) return fail("Invalid setting value");
    return ipcRenderer.invoke("settings:set", key, value);
  },
  getStatus: () => ipcRenderer.invoke("status:get"),

  // Dictionary
  getDictionary: () => ipcRenderer.invoke("dictionary:get"),
  setDictionary: (entries) => {
    if (!Array.isArray(entries) || entries.length > 500) return fail("Dictionary must be an array of ≤ 500 entries");
    return ipcRenderer.invoke("dictionary:set", entries);
  },

  // App-aware modes
  getModes: () => ipcRenderer.invoke("modes:get"),
  setModes: (payload) => {
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.rules) || payload.rules.length > 50) {
      return fail("Invalid mode rules");
    }
    return ipcRenderer.invoke("modes:set", { rules: payload.rules, cleanup: payload.cleanup });
  },

  // History
  listHistory: () => ipcRenderer.invoke("history:list"),
  copyHistory: (id) => (isId(id) ? ipcRenderer.invoke("history:copy", id) : fail("Invalid id")),
  pasteHistory: (id) => (isId(id) ? ipcRenderer.invoke("history:paste", id) : fail("Invalid id")),
  deleteHistory: (id) => (isId(id) ? ipcRenderer.invoke("history:delete", id) : fail("Invalid id")),
  clearHistory: () => ipcRenderer.invoke("history:clear"),
  getHistoryAudio: (id) => (isId(id) ? ipcRenderer.invoke("history:audio", id) : fail("Invalid id")),
});
