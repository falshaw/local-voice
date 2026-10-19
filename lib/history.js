// Local dictation history: <userData>/history/index.json + optional <id>.wav files.
// Capped by entry count (historyMax) and by total audio size; pruning deletes the
// WAVs of dropped entries and any orphan WAV in the folder. Plaintext, same trust
// level as config.json — never leaves the machine.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const INDEX_FILE = "index.json";
const DEFAULT_MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const ID_RE = /^[a-f0-9]{16}$/;

/** 16-bit PCM mono WAV from Float32 samples. */
function encodeWav16(samples, sampleRate = 16000) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] || 0));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return buf;
}

function isValidId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

class History {
  constructor({ dir, max = 50, maxAudioBytes = DEFAULT_MAX_AUDIO_BYTES } = {}) {
    if (!dir) throw new Error("History needs a directory");
    this.dir = dir;
    this.max = max;
    this.maxAudioBytes = maxAudioBytes;
    this.entries = [];
    this.loaded = false;
  }

  _indexPath() {
    return path.join(this.dir, INDEX_FILE);
  }

  audioPath(id) {
    if (!isValidId(id)) throw new Error("Invalid history id");
    return path.join(this.dir, `${id}.wav`);
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    try {
      const data = JSON.parse(fs.readFileSync(this._indexPath(), "utf8"));
      this.entries = Array.isArray(data) ? data.filter((e) => e && isValidId(e.id)) : [];
    } catch (_) {
      this.entries = [];
    }
    this.loaded = true;
    return this;
  }

  _ensure() {
    if (!this.loaded) this.load();
  }

  _save() {
    const tmp = `${this._indexPath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.entries));
    fs.renameSync(tmp, this._indexPath());
  }

  /** Newest first. */
  list() {
    this._ensure();
    return this.entries.map((e) => ({ ...e }));
  }

  get(id) {
    this._ensure();
    return this.entries.find((e) => e.id === id) || null;
  }

  /** `entry` = { text, raw, lang, mode, durationMs }; `wav` = Buffer or null. */
  add(entry, wav = null) {
    this._ensure();
    const id = crypto.randomBytes(8).toString("hex");
    const record = {
      id,
      ts: Date.now(),
      text: String(entry.text || ""),
      raw: String(entry.raw || ""),
      lang: entry.lang || null,
      mode: entry.mode || null,
      durationMs: Number(entry.durationMs) || 0,
      audio: false,
      audioBytes: 0,
    };
    if (wav && wav.length) {
      fs.writeFileSync(this.audioPath(id), wav);
      record.audio = true;
      record.audioBytes = wav.length;
    }
    this.entries.unshift(record);
    this.prune();
    return record;
  }

  setMax(max) {
    this.max = max;
    this.prune();
  }

  /** Enforces the entry cap and the audio-size cap, then removes orphan WAVs. */
  prune() {
    this._ensure();
    const dropped = this.entries.splice(Math.max(0, this.max));
    for (const e of dropped) this._unlinkAudio(e);
    // Audio budget: keep the newest WAVs, strip audio from older entries.
    let audioTotal = 0;
    for (const e of this.entries) {
      if (!e.audio) continue;
      audioTotal += e.audioBytes || 0;
      if (audioTotal > this.maxAudioBytes) {
        this._unlinkAudio(e);
        e.audio = false;
        e.audioBytes = 0;
      }
    }
    this._removeOrphans();
    this._save();
  }

  delete(id) {
    this._ensure();
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx < 0) return false;
    const [e] = this.entries.splice(idx, 1);
    this._unlinkAudio(e);
    this._save();
    return true;
  }

  clear() {
    this._ensure();
    for (const e of this.entries) this._unlinkAudio(e);
    this.entries = [];
    this._removeOrphans();
    this._save();
  }

  readAudio(id) {
    const e = this.get(id);
    if (!e || !e.audio) return null;
    try {
      return fs.readFileSync(this.audioPath(id));
    } catch (_) {
      return null;
    }
  }

  _unlinkAudio(e) {
    if (!e || !isValidId(e.id)) return;
    try {
      fs.unlinkSync(this.audioPath(e.id));
    } catch (_) {
      // already gone
    }
  }

  _removeOrphans() {
    const keep = new Set(this.entries.filter((e) => e.audio).map((e) => `${e.id}.wav`));
    let files = [];
    try {
      files = fs.readdirSync(this.dir);
    } catch (_) {
      return;
    }
    for (const f of files) {
      if (f.endsWith(".wav") && !keep.has(f)) {
        try {
          fs.unlinkSync(path.join(this.dir, f));
        } catch (_) {
          // ignore
        }
      }
    }
  }
}

module.exports = { History, encodeWav16, isValidId, DEFAULT_MAX_AUDIO_BYTES };
