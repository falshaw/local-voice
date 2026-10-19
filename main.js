const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  clipboard,
  session,
  nativeImage,
  globalShortcut,
  screen,
} = require("electron");
const { execFile } = require("child_process");
const { Worker } = require("worker_threads");
const path = require("path");

const paths = require("./lib/paths");
// Same userData for `npm start` and the packaged "Local Voice.exe" (lib/paths.js);
// must run before anything touches userData (electron-store, history, caches).
app.setPath("userData", paths.userDataDir(app.getPath("appData")));
const MODEL_CACHE_DIR = paths.modelCacheDir(app.getPath("userData"));

const settingsLib = require("./lib/settings");
const { transition, wantsEsc } = require("./lib/state");
const dictionaryLib = require("./lib/dictionary");
const modesLib = require("./lib/modes");
const { History, encodeWav16, isValidId } = require("./lib/history");
const { postprocess } = require("./lib/pipeline");
const { cleanupText } = require("./lib/cleanup");
const ollama = require("./lib/ollama");
const { resolveJobLanguage, toWorkerLanguage } = require("./lib/language");
const vadMath = require("./lib/vad");
const { getActiveWindow } = require("./lib/active-window");
const ptt = require("./lib/ptt");
// nativeImage.createFromBuffer does NOT decode SVG — icons are pre-rasterized PNG
// (regenerate with: node scripts/gen-tray-icons.js).
const trayIcons = require("./lib/tray-icons");

const SAMPLE_RATE = vadMath.SAMPLE_RATE;
const FRAME_SAMPLES = vadMath.FRAME_SAMPLES;
const MIN_AUDIO_SAMPLES = Math.round(0.3 * SAMPLE_RATE);
const MAX_RECORDING_SAMPLES = 10 * 60 * SAMPLE_RATE; // hard stop after 10 min
const AUDIO_END_TIMEOUT_MS = 3000;
const VAD_FLUSH_TIMEOUT_MS = 2000;

// electron-store v9+ is ESM-only — load via dynamic import from this CommonJS module.
let store = null;

async function initStore() {
  const { default: Store } = await import("electron-store");

  store = new Store({
    defaults: {
      ...settingsLib.DEFAULTS,
      dictionary: [],
      modeRules: modesLib.DEFAULT_MODE_RULES.map((r) => ({ ...r })),
      modeCleanup: { ...modesLib.DEFAULT_MODE_CLEANUP },
    },
  });

  // Old model ids, free-form language strings, object hotkeys, out-of-range values.
  const patch = settingsLib.migrateSettings(store.store);
  if (Object.keys(patch).length) store.set(patch);

  // Complex values are re-validated on load; a corrupt one is reset, never trusted.
  try {
    store.set("dictionary", dictionaryLib.validateDictionary(store.get("dictionary")));
  } catch (_) {
    store.set("dictionary", []);
  }
  try {
    store.set("modeRules", modesLib.validateModeRules(store.get("modeRules")));
  } catch (_) {
    store.set("modeRules", modesLib.DEFAULT_MODE_RULES.map((r) => ({ ...r })));
  }
  try {
    store.set("modeCleanup", modesLib.validateModeCleanup(store.get("modeCleanup")));
  } catch (_) {
    store.set("modeCleanup", { ...modesLib.DEFAULT_MODE_CLEANUP });
  }
}

function publicSettings() {
  return Object.fromEntries(settingsLib.SETTING_KEYS.map((k) => [k, store.get(k)]));
}

let tray = null;
let overlayWindow = null;
let settingsWindow = null;
let whisperWorker = null;
let vadWorker = null;
let vadReady = false;
let history = null;
let pttHandle = null;

let state = "idle";
let recSeq = 0;
let rec = null; // the recording being captured
let currentJobId = null; // job whose result may still be delivered
let currentJob = null; // { id, language, mode window promise, durationMs, audio }
const notices = new Map(); // key → short text shown in the tray
const stt = { ready: false, device: "cpu", modelId: settingsLib.DEFAULTS.modelId };

// --- Sender checks: the overlay captures audio, only the settings page may write ---

function senderUrl(event) {
  return event && event.senderFrame && typeof event.senderFrame.url === "string"
    ? event.senderFrame.url
    : "";
}
function fromPage(event, page) {
  const url = senderUrl(event);
  return url.startsWith("file://") && url.endsWith(`/renderer/${page}`);
}
function requireSettingsPage(event) {
  if (!fromPage(event, "settings.html")) throw new Error("Not allowed from this window");
}

// --- Tray ---

function createTrayIcon(state) {
  const b64 = trayIcons[state] || trayIcons.idle;
  const img = nativeImage.createFromBuffer(Buffer.from(b64, "base64"));
  // 32px source rendered into the 16px tray slot.
  return img.resize({ width: 16, height: 16 });
}

function setTrayState(s) {
  if (!tray) return;
  const key = store.get("hotkey");
  const hold = pttHandle !== null;
  const labels = {
    idle: `Voice — Ready (${key} to ${hold ? "hold" : "toggle"})`,
    recording: hold ? "Voice — Recording... (release to stop, Esc cancels)" : "Voice — Recording... (press again to stop, Esc cancels)",
    processing: "Voice — Transcribing... (Esc cancels)",
  };
  let tip = labels[s] || labels.idle;
  if (s === "idle" && notices.size) tip += ` — ${[...notices.values()].join("; ")}`;
  tray.setToolTip(tip.slice(0, 127));
  try {
    tray.setImage(createTrayIcon(s));
  } catch (_) {
    // tray still functional
  }
}

function setLanguage(lang) {
  store.set("language", settingsLib.validateSetting("language", lang));
  refreshTray();
}

function refreshTray() {
  if (!tray) return;
  const lang = store.get("language");
  const statusItems = [
    { label: `STT: ${stt.modelId.replace("onnx-community/", "")} on ${stt.device.toUpperCase()}${stt.ready ? "" : " (loading)"}`, enabled: false },
    ...[...notices.values()].map((n) => ({ label: n, enabled: false })),
  ];
  const menu = Menu.buildFromTemplate([
    { label: "Voice Dictation", enabled: false },
    ...statusItems,
    { type: "separator" },
    { label: "Settings…", click: openSettingsWindow },
    { type: "separator" },
    { label: "English", type: "radio", checked: lang === "en", click: () => setLanguage("en") },
    { label: "Deutsch", type: "radio", checked: lang === "de", click: () => setLanguage("de") },
    { label: "Auto (EN/DE)", type: "radio", checked: lang === "auto", click: () => setLanguage("auto") },
    { type: "separator" },
    {
      label: "Show Overlay",
      type: "checkbox",
      checked: store.get("showOverlay"),
      click: (item) => store.set("showOverlay", item.checked),
    },
    {
      label: "Auto-Paste",
      type: "checkbox",
      checked: store.get("autoPaste"),
      click: (item) => store.set("autoPaste", item.checked),
    },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  setTrayState(state);
}

function createTray() {
  tray = new Tray(createTrayIcon("idle"));
  refreshTray();
  tray.on("click", () => {
    if (overlayWindow && overlayWindow.isVisible()) {
      overlayWindow.hide();
    } else {
      showOverlay();
    }
  });
}

function setNotice(key, text) {
  if (text) notices.set(key, text);
  else notices.delete(key);
  refreshTray();
}

// --- State machine ---

let escRegistered = false;

function updateEsc() {
  const want = wantsEsc(state);
  if (want && !escRegistered) {
    escRegistered = globalShortcut.register("Escape", () => dispatch("esc"));
  } else if (!want && escRegistered) {
    globalShortcut.unregister("Escape");
    escRegistered = false;
  }
}

function sendOverlay(channel, ...args) {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send(channel, ...args);
}

function dispatch(event, payload = {}) {
  const { state: next, action } = transition(state, event);
  state = next;
  switch (action) {
    case "start":
      beginRecording(payload.hotkeyLanguage || null);
      break;
    case "stop":
      sendOverlay("recording:stop");
      if (rec) {
        rec.stopTimer = setTimeout(() => {
          if (state === "processing" && rec) {
            rec = null;
            dispatch("empty");
          }
        }, AUDIO_END_TIMEOUT_MS);
      }
      break;
    case "cancel":
      if (rec && rec.stopTimer) clearTimeout(rec.stopTimer);
      rec = null;
      sendOverlay("recording:cancel");
      hideOverlay();
      break;
    case "drop":
      currentJobId = null;
      currentJob = null;
      rec = null;
      sendOverlay("recording:cancel");
      hideOverlay();
      break;
    case "reset":
      if (rec && rec.stopTimer) clearTimeout(rec.stopTimer);
      rec = null;
      currentJobId = null;
      currentJob = null;
      hideOverlay();
      break;
    default:
      break;
  }
  updateEsc();
  setTrayState(state);
}

function beginRecording(hotkeyLanguage) {
  recSeq += 1;
  rec = {
    id: recSeq,
    frames: [],
    samples: 0,
    probs: [],
    vad: vadReady && store.get("vadEnabled"),
    language: resolveJobLanguage(hotkeyLanguage, store.get("language")),
    windowPromise: store.get("modesEnabled") ? getActiveWindow() : Promise.resolve(null),
    stopTimer: null,
  };
  if (rec.vad) vadWorker.postMessage({ type: "reset" });
  showOverlay();
  sendOverlay("recording:start");
}

function concatAudio(frames, tail) {
  const total = frames.reduce((n, f) => n + f.length, 0) + (tail ? tail.length : 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const f of frames) {
    out.set(f, off);
    off += f.length;
  }
  if (tail) out.set(tail, off);
  return out;
}

let flushSeq = 0;
const flushWaiters = new Map();

function vadFlush() {
  if (!vadWorker || !vadReady) return Promise.resolve(false);
  flushSeq += 1;
  const token = flushSeq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      flushWaiters.delete(token);
      resolve(false);
    }, VAD_FLUSH_TIMEOUT_MS);
    flushWaiters.set(token, () => {
      clearTimeout(timer);
      resolve(true);
    });
    vadWorker.postMessage({ type: "flush", data: { token } });
  });
}

async function finishRecording(r, tail) {
  if (r.stopTimer) clearTimeout(r.stopTimer);
  let audio = concatAudio(r.frames, tail);
  r.frames = [];
  if (audio.length < MIN_AUDIO_SAMPLES) return dispatch("empty");

  if (r.vad) {
    const flushed = await vadFlush();
    if (state !== "processing") return; // Esc while flushing
    const complete = flushed && r.probs.length >= Math.floor(audio.length / FRAME_SAMPLES) &&
      !r.probs.slice(0, Math.floor(audio.length / FRAME_SAMPLES)).includes(undefined);
    if (complete) {
      const seg = vadMath.trimSegments(r.probs, { totalSamples: audio.length });
      if (!seg) return dispatch("empty"); // no speech → no Whisper hallucination
      audio = audio.slice(seg.start, seg.end);
    }
  }

  let forceCpu = false;
  if (stt.device === "dml") {
    const models = await ollama.listLoaded(fetch, 700);
    forceCpu = ollama.gpuBusy(models);
    if (state !== "processing") return;
  }

  if (!whisperWorker || !stt.ready) {
    sendOverlay("transcription:error", "Model not loaded yet");
    return dispatch("error");
  }

  currentJobId = r.id;
  currentJob = {
    id: r.id,
    windowPromise: r.windowPromise,
    durationMs: Math.round((audio.length / SAMPLE_RATE) * 1000),
    audio: store.get("historyEnabled") && store.get("historyKeepAudio") ? audio.slice() : null,
  };
  const copy = audio.slice();
  whisperWorker.postMessage(
    {
      type: "transcribe",
      data: { jobId: r.id, audioBuffer: copy.buffer, language: toWorkerLanguage(r.language), forceCpu },
    },
    [copy.buffer],
  );
}

async function deliverResult(data) {
  if (data.jobId !== currentJobId || !currentJob) return; // cancelled / stale
  const job = currentJob;
  const raw = data.text || "";
  let mode = store.get("defaultMode");
  if (store.get("modesEnabled")) {
    const win = await job.windowPromise.catch(() => null);
    mode = modesLib.matchMode(store.get("modeRules"), win, store.get("defaultMode"));
  }
  const modeCleanup = store.get("modeCleanup") || {};
  const wantCleanup =
    store.get("cleanupEnabled") && (!store.get("modesEnabled") || modeCleanup[mode] === true);
  const { text } = await postprocess(raw, {
    mode,
    dictionary: store.get("dictionary"),
    dictionaryEnabled: store.get("dictionaryEnabled"),
    cleanup: wantCleanup
      ? (t) =>
          cleanupText(t, {
            mode,
            timeoutMs: store.get("cleanupTimeoutMs"),
            onlyIfLoaded: store.get("cleanupOnlyIfLoaded"),
          })
      : null,
  });
  if (data.jobId !== currentJobId) return; // Esc during cleanup
  currentJobId = null;
  currentJob = null;
  dispatch("result");
  sendOverlay("transcription:done", text);
  hideOverlay();
  if (!text) return;
  pasteText(text).catch((e) => console.error("Paste failed:", e.message));
  if (store.get("historyEnabled") && history) {
    try {
      history.add(
        { text, raw, lang: data.language, mode, durationMs: job.durationMs },
        job.audio ? encodeWav16(job.audio, SAMPLE_RATE) : null,
      );
    } catch (e) {
      console.error("History write failed:", e.message);
    }
  }
}

// --- Whisper Worker Thread ---

function startWhisperWorker() {
  stt.ready = false;
  stt.modelId = store.get("modelId");
  stt.device = store.get("sttDevice");
  setNotice("stt", null);
  whisperWorker = new Worker(path.join(__dirname, "lib", "transcriber.js"), {
    workerData: { cacheDir: MODEL_CACHE_DIR },
  });

  whisperWorker.on("message", (msg) => {
    const { type, data } = msg || {};
    switch (type) {
      case "model:progress":
        if (tray) tray.setToolTip(`Voice — Loading model... ${Math.round(data.progress)}%`);
        sendOverlay("model:progress", data.progress);
        break;
      case "model:ready":
        stt.ready = true;
        stt.device = data.device;
        stt.modelId = data.modelId;
        refreshTray();
        sendOverlay("model:ready");
        break;
      case "stt:fallback":
        console.error("STT fallback:", data.reason);
        stt.device = "cpu";
        stt.modelId = "onnx-community/whisper-small";
        setNotice("stt", "GPU unavailable — CPU whisper-small");
        break;
      case "stt:warning":
        console.error("STT warning:", data.reason);
        break;
      case "transcription:result":
        deliverResult(data).catch((e) => {
          console.error("Delivery failed:", e.message);
          if (data.jobId === currentJobId) dispatch("error");
        });
        break;
      case "transcription:error":
        console.error("Transcription error:", data.error);
        if (data.jobId === undefined) {
          setNotice("stt", "Model load failed");
          sendOverlay("transcription:error", data.error);
        } else if (data.jobId === currentJobId) {
          sendOverlay("transcription:error", data.error);
          dispatch("error");
        }
        break;
    }
  });

  whisperWorker.on("error", (err) => {
    console.error("Worker error:", err);
    if (state === "processing") dispatch("error");
  });

  whisperWorker.postMessage({
    type: "load:model",
    data: { modelId: store.get("modelId"), device: store.get("sttDevice") },
  });
}

function restartWhisperWorker() {
  if (state === "processing") dispatch("error");
  if (whisperWorker) {
    whisperWorker.removeAllListeners();
    whisperWorker.terminate().catch(() => {});
    whisperWorker = null;
  }
  startWhisperWorker();
  refreshTray();
}

// --- VAD Worker Thread (only while vadEnabled) ---

function startVadWorker() {
  if (vadWorker) return;
  vadReady = false;
  vadWorker = new Worker(path.join(__dirname, "lib", "vad-worker.js"), {
    workerData: { cacheDir: MODEL_CACHE_DIR },
  });
  vadWorker.on("message", (msg) => {
    const { type, data } = msg || {};
    switch (type) {
      case "vad:ready":
        vadReady = true;
        setNotice("vad", null);
        break;
      case "vad:error":
        console.error("VAD error:", data.error);
        vadReady = false;
        setNotice("vad", "VAD unavailable");
        break;
      case "vad:prob":
        if (rec && rec.id === data.recId) {
          rec.probs[data.seq] = data.p;
          if (
            state === "recording" &&
            store.get("vadAutoStop") &&
            vadMath.shouldAutoStop(rec.probs, { silenceMs: store.get("vadSilenceMs") })
          ) {
            dispatch("autoStop");
          }
        }
        break;
      case "vad:flushed": {
        const done = flushWaiters.get(data.token);
        if (done) {
          flushWaiters.delete(data.token);
          done();
        }
        break;
      }
    }
  });
  vadWorker.on("error", (err) => {
    console.error("VAD worker error:", err);
    vadReady = false;
    setNotice("vad", "VAD unavailable");
  });
  vadWorker.postMessage({ type: "load" });
}

function stopVadWorker() {
  if (!vadWorker) return;
  vadWorker.removeAllListeners();
  vadWorker.terminate().catch(() => {});
  vadWorker = null;
  vadReady = false;
  setNotice("vad", null);
}

// --- Windows ---

function createOverlayWindow() {
  overlayWindow = new BrowserWindow({
    width: 320,
    height: 180,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The AudioWorklet must keep running while the overlay is hidden.
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });

  overlayWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  lockNavigation(overlayWindow);

  // Position bottom-right of primary display
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  overlayWindow.setPosition(width - 340, height - 200);

  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });
}

function lockNavigation(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
}

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 820,
    height: 640,
    minWidth: 600,
    minHeight: 420,
    title: "Voice — Settings",
    autoHideMenuBar: true,
    backgroundColor: "#0b0a1a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, "renderer", "settings.html"));
  lockNavigation(settingsWindow);
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

function setupPermissions() {
  // Microphone only, and only for the overlay.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === "media" && !!overlayWindow && wc === overlayWindow.webContents);
  });
  session.defaultSession.setPermissionCheckHandler(
    (wc, permission) => permission === "media" && !!overlayWindow && wc === overlayWindow.webContents,
  );
}

function showOverlay() {
  if (!store.get("showOverlay")) return;
  if (!overlayWindow) createOverlayWindow();
  overlayWindow.showInactive();
}

function hideOverlay() {
  if (overlayWindow) overlayWindow.hide();
}

// --- Text Injection ---

// With auto-paste on, the clipboard is only the transport: whatever the user had
// copied before is put back ~500 ms after the Ctrl+V has been sent. With
// auto-paste off the clipboard IS the delivery, so it is left holding the text.
const CLIPBOARD_RESTORE_MS = 500;

// Electron 44 moved clipboard to the W3C Clipboard API: readText/writeText are async.
async function pasteText(text) {
  if (!text || !text.trim()) return;

  const dictated = text.trim();
  const previous = await clipboard.readText().catch(() => "");
  await clipboard.writeText(dictated);

  if (store.get("autoPaste")) {
    setTimeout(() => {
      execFile(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^v")',
        ],
        { windowsHide: true },
        (err) => {
          if (err) {
            // Leave the text on the clipboard so a manual Ctrl+V still works.
            console.error("Paste failed:", err.message);
            return;
          }
          setTimeout(async () => {
            // Only restore if nothing else has written the clipboard meanwhile,
            // and only when there was text to restore (never clobber an image).
            try {
              if (previous && (await clipboard.readText()) === dictated) {
                await clipboard.writeText(previous);
              }
            } catch (e) {
              console.error("Clipboard restore failed:", e.message);
            }
          }, CLIPBOARD_RESTORE_MS);
        },
      );
    }, 100);
  }
}

// --- Global Hotkeys (toggle) + Esc + push-to-talk ---

let registeredHotkeys = [];

/**
 * Registers hotkey (+ optional hotkey2 with its own language). Returns the list of
 * accelerators that failed. In hold mode the primary key stays registered so it is
 * swallowed (never reaches the foreground app) and works as the toggle fallback,
 * but its callback is a no-op while the uiohook hold is live.
 */
function setupGlobalHotkeys() {
  for (const a of registeredHotkeys) globalShortcut.unregister(a);
  registeredHotkeys = [];
  const entries = [{ accel: store.get("hotkey"), language: null, primary: true }];
  const second = store.get("hotkey2");
  if (second && second !== store.get("hotkey")) {
    entries.push({ accel: second, language: store.get("hotkey2Language"), primary: false });
  }
  const failed = [];
  for (const entry of entries) {
    let ok = false;
    try {
      ok = globalShortcut.register(entry.accel, () => {
        if (entry.primary && pttHandle) return;
        dispatch("hotkey", { hotkeyLanguage: entry.language });
      });
    } catch (_) {
      ok = false;
    }
    if (ok) registeredHotkeys.push(entry.accel);
    else {
      console.error(`Failed to register hotkey: ${entry.accel}`);
      failed.push(entry.accel);
    }
  }
  return failed;
}

function setupPtt() {
  if (pttHandle) {
    pttHandle.stop();
    pttHandle = null;
  }
  setNotice("ptt", null);
  if (store.get("hotkeyMode") !== "hold") return;
  try {
    pttHandle = ptt.startPtt(store.get("hotkey"), {
      onDown: () => dispatch("holdDown"),
      onUp: () => dispatch("holdUp"),
    });
  } catch (err) {
    console.error("Push-to-talk unavailable:", err.message);
    pttHandle = null;
    setNotice("ptt", "Hold unavailable — toggle");
  }
  refreshTray();
}

// --- IPC ---

function toFloat32(raw, maxBytes) {
  let ab;
  if (raw instanceof ArrayBuffer) ab = raw;
  else if (raw && raw.buffer instanceof ArrayBuffer && typeof raw.byteLength === "number") {
    // Electron IPC may deliver a Buffer/typed array; copy out the exact bytes.
    ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  } else return null;
  if (ab.byteLength % 4 !== 0 || ab.byteLength > maxBytes) return null;
  return new Float32Array(ab);
}

function applySettingSideEffects(key, previous) {
  switch (key) {
    case "hotkey":
    case "hotkey2":
    case "hotkey2Language": {
      const failed = setupGlobalHotkeys();
      if (failed.length) {
        store.set(key, previous);
        setupGlobalHotkeys();
        if (key === "hotkey") setupPtt();
        throw new Error(`Hotkey ${failed.join(", ")} could not be registered`);
      }
      if (key === "hotkey") setupPtt();
      break;
    }
    case "hotkeyMode":
      setupPtt();
      break;
    case "modelId":
    case "sttDevice":
      restartWhisperWorker();
      break;
    case "vadEnabled":
      if (store.get("vadEnabled")) startVadWorker();
      else stopVadWorker();
      break;
    case "historyMax":
      if (history) history.setMax(store.get("historyMax"));
      break;
    case "language":
    case "showOverlay":
    case "autoPaste":
      refreshTray();
      break;
    default:
      break;
  }
}

function setupIPC() {
  // Audio capture (overlay only): 512-sample Float32 frames while recording.
  ipcMain.on("audio:frame", (event, raw) => {
    // Frames still in flight when "stop" was sent arrive in "processing"; they are
    // kept until audio:end closes the recording (rec → null).
    if (!fromPage(event, "index.html") || !rec) return;
    if (state !== "recording" && state !== "processing") return;
    const f = toFloat32(raw, FRAME_SAMPLES * 4);
    if (!f || f.length !== FRAME_SAMPLES) return;
    const seq = rec.frames.length;
    rec.frames.push(f);
    rec.samples += f.length;
    if (rec.vad && vadWorker) {
      const copy = f.slice();
      vadWorker.postMessage({ type: "frame", data: { recId: rec.id, seq, samples: copy.buffer } }, [copy.buffer]);
    }
    if (state === "recording" && rec.samples >= MAX_RECORDING_SAMPLES) dispatch("autoStop");
  });

  // End of a recording: the last partial frame (< 512 samples, may be empty).
  ipcMain.on("audio:end", (event, raw) => {
    if (!fromPage(event, "index.html") || state !== "processing" || !rec) return;
    const r = rec;
    rec = null;
    const tail = toFloat32(raw, FRAME_SAMPLES * 4) || null;
    finishRecording(r, tail).catch((e) => {
      console.error("Recording finish failed:", e.message);
      dispatch("error");
    });
  });

  // Renderer reports empty/failed recording (e.g. no microphone).
  ipcMain.on("audio:empty", (event) => {
    if (!fromPage(event, "index.html")) return;
    dispatch("empty");
  });

  ipcMain.handle("settings:get", () => publicSettings());
  // Read-only: the settings page renders its form from the real schema (types,
  // enum values, int ranges) instead of a duplicated key list.
  ipcMain.handle("settings:schema", () =>
    Object.fromEntries(
      settingsLib.SETTING_KEYS.map((k) => {
        const s = settingsLib.SCHEMA[k];
        return [k, { type: s.type, ...(s.values ? { values: [...s.values] } : {}), ...(s.type === "int" ? { min: s.min, max: s.max } : {}) }];
      }),
    ),
  );
  // Allowlisted keys + per-key type checks (lib/settings.js); anything else throws
  // back to the renderer. Hotkey changes are rolled back if registration fails.
  ipcMain.handle("settings:set", (event, key, value) => {
    requireSettingsPage(event);
    const clean = settingsLib.validateSetting(key, value);
    const previous = store.get(key);
    if (clean === previous) return publicSettings();
    if (key === "hotkey2" && clean && clean === store.get("hotkey")) {
      throw new Error("Second hotkey must differ from the main hotkey");
    }
    if (key === "hotkey" && clean === store.get("hotkey2")) {
      throw new Error("Main hotkey must differ from the second hotkey");
    }
    if (key === "hotkeyMode" && clean === "hold") ptt.accelToKey(store.get("hotkey"));
    if (key === "hotkey" && store.get("hotkeyMode") === "hold") ptt.accelToKey(clean);
    store.set(key, clean);
    applySettingSideEffects(key, previous);
    return publicSettings();
  });

  ipcMain.handle("status:get", () => ({
    state,
    stt: { ...stt },
    vad: { enabled: store.get("vadEnabled"), ready: vadReady },
    pushToTalk: pttHandle !== null,
    notices: [...notices.values()],
  }));

  ipcMain.handle("dictionary:get", (event) => {
    requireSettingsPage(event);
    return store.get("dictionary");
  });
  ipcMain.handle("dictionary:set", (event, entries) => {
    requireSettingsPage(event);
    const clean = dictionaryLib.validateDictionary(entries);
    store.set("dictionary", clean);
    return clean;
  });

  ipcMain.handle("modes:get", (event) => {
    requireSettingsPage(event);
    return {
      rules: store.get("modeRules"),
      cleanup: store.get("modeCleanup"),
      defaults: { rules: modesLib.DEFAULT_MODE_RULES, cleanup: modesLib.DEFAULT_MODE_CLEANUP },
    };
  });
  ipcMain.handle("modes:set", (event, payload) => {
    requireSettingsPage(event);
    if (!payload || typeof payload !== "object") throw new Error("Invalid payload");
    const rules = modesLib.validateModeRules(payload.rules);
    const cleanup = modesLib.validateModeCleanup(payload.cleanup);
    store.set("modeRules", rules);
    store.set("modeCleanup", cleanup);
    return { rules, cleanup };
  });

  ipcMain.handle("history:list", (event) => {
    requireSettingsPage(event);
    return history ? history.list() : [];
  });
  ipcMain.handle("history:copy", async (event, id) => {
    requireSettingsPage(event);
    const e = isValidId(id) && history ? history.get(id) : null;
    if (!e) throw new Error("No such entry");
    await clipboard.writeText(e.text);
    return true;
  });
  ipcMain.handle("history:paste", async (event, id) => {
    requireSettingsPage(event);
    const e = isValidId(id) && history ? history.get(id) : null;
    if (!e) throw new Error("No such entry");
    if (!store.get("autoPaste")) {
      await clipboard.writeText(e.text);
      return { pasted: false, copied: true };
    }
    // Hide so focus returns to the previous window, then paste there.
    if (settingsWindow) settingsWindow.hide();
    await new Promise((r) => setTimeout(r, 150));
    await pasteText(e.text);
    setTimeout(() => {
      if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.showInactive();
    }, 1200);
    return { pasted: true, copied: false };
  });
  ipcMain.handle("history:delete", (event, id) => {
    requireSettingsPage(event);
    if (!isValidId(id) || !history) throw new Error("Invalid id");
    return history.delete(id);
  });
  ipcMain.handle("history:clear", (event) => {
    requireSettingsPage(event);
    if (history) history.clear();
    return true;
  });
  ipcMain.handle("history:audio", (event, id) => {
    requireSettingsPage(event);
    if (!isValidId(id) || !history) throw new Error("Invalid id");
    const buf = history.readAudio(id);
    if (!buf) return null;
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });
}

// --- App Lifecycle ---

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason && reason.message ? reason.message : reason);
});

// One instance only (2026-10-19): a second launch — a Start Menu click while the tray
// app already runs, or a restart while the old process is still quitting — fought the
// first over F9 ("Failed to register hotkey: F9"). The second launch now just opens
// the running app's settings window and exits.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => openSettingsWindow());
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  await initStore();
  history = new History({
    dir: path.join(app.getPath("userData"), "history"),
    max: store.get("historyMax"),
  }).load();
  setupPermissions();
  createOverlayWindow();
  createTray();
  if (setupGlobalHotkeys().length) setNotice("hotkey", `Hotkey ${store.get("hotkey")} not registered`);
  setupPtt();
  setupIPC();
  // One-time copy of the pre-2026-10-19 node_modules model cache (dev checkout only;
  // the packaged app has none) so Whisper is not downloaded again.
  try {
    const seeded = await paths.seedModelCache(paths.legacyCacheDir(__dirname), MODEL_CACHE_DIR);
    if (seeded === "seeded") console.log(`Model cache copied to ${MODEL_CACHE_DIR}`);
  } catch (e) {
    console.error("Model cache seed failed (models will download):", e.message);
  }
  startWhisperWorker();
  if (store.get("vadEnabled")) startVadWorker();
  // `electron . --settings` opens the settings window at launch (smoke tests; the
  // tray item "Settings…" is the normal way in).
  if (process.argv.includes("--settings")) openSettingsWindow();
});

app.on("window-all-closed", (e) => {
  // Tray app — don't quit on window close
  e.preventDefault?.();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (pttHandle) {
    pttHandle.stop();
    pttHandle = null;
  }
  if (whisperWorker) {
    whisperWorker.terminate();
    whisperWorker = null;
  }
  stopVadWorker();
});
