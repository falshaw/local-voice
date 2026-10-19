#!/usr/bin/env node
// Whisper STT bench (plan 8A): model × precision × device → load time, RTF, WER.
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/bench-stt.js [options]
//
//   --models small,turbo      which models (default: both)
//   --devices cpu,dml         which devices (default: both)
//   --fixtures <dir>          WAV clips + .txt references (default: scripts/fixtures)
//   --out <file.md>           write the markdown table there (stdout otherwise)
//   --load-timeout-min <n>    per-config child timeout incl. download (default 25)
//   --warm-gemma              load gemma4:31b on host Ollama first (keep_alive 15m), so
//                             the run measures the "gemma4 resident" case
//
// Fixtures (you record them; local only, never uploaded): scripts/fixtures/<lang>-<name>.wav
// 16 kHz mono 16-bit PCM preferred (other rates/stereo are converted), with the spoken
// text in scripts/fixtures/<lang>-<name>.txt. <lang> = en | de. Without fixtures the bench
// runs on a synthetic 3 s clip (silence / 440 Hz sine / silence): load time and RTF only.
//
// Each config runs in a child process (same binary), so a DirectML crash, an OOM or a
// stalled download only costs that row. Nothing leaves the machine except the model
// download from huggingface.co.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { performance } = require("perf_hooks");

const APP_DIR = path.join(__dirname, "..");
const { detectLanguage } = require(path.join(APP_DIR, "lib", "language.js"));
const { userDataDir, modelCacheDir } = require(path.join(APP_DIR, "lib", "paths.js"));
const { OLLAMA_URL, CLEANUP_MODEL, listLoaded, vramHeld } = require(path.join(APP_DIR, "lib", "ollama.js"));

const SAMPLE_RATE = 16000;

const MODELS = {
  small: {
    id: "onnx-community/whisper-small",
    label: "whisper-small",
    precisions: [
      { tag: "fp32/q4", dtype: { encoder_model: "fp32", decoder_model_merged: "q4" } },
      // whisper-small ships no q4f16 decoder (HF file list 2026-10-19) → fp16/fp16 instead.
      { tag: "fp16/fp16", dtype: { encoder_model: "fp16", decoder_model_merged: "fp16" } },
    ],
  },
  turbo: {
    id: "onnx-community/whisper-large-v3-turbo",
    label: "large-v3-turbo",
    precisions: [
      { tag: "q4/q4", dtype: { encoder_model: "q4", decoder_model_merged: "q4" } },
      { tag: "fp16/q4f16", dtype: { encoder_model: "fp16", decoder_model_merged: "q4f16" } },
    ],
  },
};

// --- args --------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    models: ["small", "turbo"],
    devices: ["cpu", "dml"],
    fixtures: path.join(__dirname, "fixtures"),
    out: null,
    loadTimeoutMin: 25,
    warmGemma: false,
    one: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--models") opts.models = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--devices") opts.devices = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--fixtures") opts.fixtures = path.resolve(next());
    else if (a === "--out") opts.out = path.resolve(next());
    else if (a === "--load-timeout-min") opts.loadTimeoutMin = Number(next()) || 25;
    else if (a === "--warm-gemma") opts.warmGemma = true;
    else if (a === "--one") opts.one = JSON.parse(next());
    else throw new Error(`Unknown argument ${a}`);
  }
  for (const m of opts.models) if (!MODELS[m]) throw new Error(`Unknown model ${m} (small|turbo)`);
  for (const d of opts.devices) if (!["cpu", "dml"].includes(d)) throw new Error(`Unknown device ${d} (cpu|dml)`);
  return opts;
}

// --- audio -------------------------------------------------------------------

function synthClip() {
  const n = 3 * SAMPLE_RATE;
  const a = new Float32Array(n);
  for (let i = SAMPLE_RATE; i < 2 * SAMPLE_RATE; i++) a[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE);
  return { name: "synthetic-3s-sine", audio: a, seconds: 3, ref: null, lang: "en" };
}

/** Minimal RIFF/WAVE reader: PCM 16-bit (any channels/rate) → 16 kHz mono Float32. */
function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV");
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt ") {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = buf.subarray(body, Math.min(buf.length, body + size));
    }
    pos = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("WAV without fmt/data chunk");
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`unsupported WAV (format ${fmt.format}, ${fmt.bits}-bit); need PCM 16-bit`);
  const frames = Math.floor(data.length / (2 * fmt.channels));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < fmt.channels; c++) s += data.readInt16LE((i * fmt.channels + c) * 2);
    mono[i] = s / fmt.channels / 32768;
  }
  if (fmt.rate === SAMPLE_RATE) return mono;
  const out = new Float32Array(Math.round((frames * SAMPLE_RATE) / fmt.rate));
  const step = fmt.rate / SAMPLE_RATE;
  for (let i = 0; i < out.length; i++) {
    const x = i * step;
    const j = Math.floor(x);
    const t = x - j;
    out[i] = (mono[j] || 0) * (1 - t) + (mono[j + 1] || 0) * t;
  }
  return out;
}

function loadClips(dir) {
  const clips = [synthClip()];
  const notes = [];
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    notes.push(`fixture folder created (empty): ${dir}`);
    return { clips, notes };
  }
  const files = fs.readdirSync(dir).filter((f) => /\.wav$/i.test(f)).sort();
  for (const f of files) {
    const name = f.replace(/\.wav$/i, "");
    const m = /^(en|de)[-_]/i.exec(name);
    const refPath = path.join(dir, `${name}.txt`);
    try {
      const audio = readWav(path.join(dir, f));
      clips.push({
        name,
        audio,
        seconds: audio.length / SAMPLE_RATE,
        ref: fs.existsSync(refPath) ? fs.readFileSync(refPath, "utf8").trim() : null,
        lang: m ? m[1].toLowerCase() : "en",
      });
      if (!fs.existsSync(refPath)) notes.push(`${f}: no ${name}.txt reference → RTF only`);
    } catch (e) {
      notes.push(`${f}: skipped (${e.message})`);
    }
  }
  if (files.length === 0) notes.push("no fixture clips: RTF from the synthetic clip only, no WER");
  return { clips, notes };
}

// --- WER ---------------------------------------------------------------------

function words(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function wer(ref, hyp) {
  const r = words(ref);
  const h = words(hyp);
  const d = Array.from({ length: r.length + 1 }, (_, i) => {
    const row = new Array(h.length + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    }
  }
  return d[r.length][h.length] / Math.max(1, r.length);
}

// --- Ollama state ------------------------------------------------------------

async function ollamaState() {
  const models = await listLoaded(fetch, 1500);
  if (models === null) return "Ollama down";
  if (!models.length) return "Ollama idle";
  const gib = (vramHeld(models) / 1024 ** 3).toFixed(1);
  return `${models.map((m) => m.name || m.model).join("+")} resident (${gib} GiB VRAM)`;
}

async function warmGemma() {
  process.stderr.write(`warming ${CLEANUP_MODEL} on ${OLLAMA_URL} ...\n`);
  const t0 = performance.now();
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: CLEANUP_MODEL, prompt: "hi", stream: false, think: false, keep_alive: "15m", options: { num_predict: 1 } }),
  });
  if (!res.ok) throw new Error(`warm-gemma HTTP ${res.status}`);
  await res.json();
  process.stderr.write(`gemma4 resident after ${((performance.now() - t0) / 1000).toFixed(0)} s\n`);
}

// --- one config (child process) ---------------------------------------------

async function runOne(cfg, opts) {
  const { clips } = loadClips(opts.fixtures);
  const row = { ...cfg, loadMs: null, coldMs: null, rtfSynthetic: null, rtfFixtures: null, werEn: null, werDe: null, detect: null, error: null, texts: [] };
  const T = await import("@huggingface/transformers");
  T.env.allowLocalModels = true;
  // Same cache as the app (lib/paths.js), so the bench reuses its downloads.
  if (process.env.APPDATA) T.env.cacheDir = modelCacheDir(userDataDir(process.env.APPDATA));
  const t0 = performance.now();
  const pipe = await T.pipeline("automatic-speech-recognition", cfg.model, { dtype: cfg.dtype, device: cfg.device });
  row.loadMs = Math.round(performance.now() - t0);
  const synth = clips[0];
  const genOpts = (lang) => ({ language: lang, task: "transcribe", chunk_length_s: 30, stride_length_s: 5 });
  const t1 = performance.now();
  await pipe(synth.audio, genOpts("en"));
  row.coldMs = Math.round(performance.now() - t1);
  const t2 = performance.now();
  const s = await pipe(synth.audio, genOpts("en"));
  row.rtfSynthetic = +((performance.now() - t2) / 1000 / synth.seconds).toFixed(3);
  row.texts.push({ name: synth.name, text: s.text });
  const wers = { en: [], de: [] };
  let fixSecs = 0;
  let fixMs = 0;
  for (const clip of clips.slice(1)) {
    const t = performance.now();
    const out = await pipe(clip.audio, genOpts(clip.lang));
    fixMs += performance.now() - t;
    fixSecs += clip.seconds;
    const w = clip.ref ? wer(clip.ref, out.text) : null;
    if (w !== null) wers[clip.lang].push(w);
    row.texts.push({ name: clip.name, text: out.text, wer: w });
  }
  if (fixSecs > 0) row.rtfFixtures = +(fixMs / 1000 / fixSecs).toFixed(3);
  const mean = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3) : null);
  row.werEn = mean(wers.en);
  row.werDe = mean(wers.de);
  // EN/DE detection on every fixture clip (expected = the clip's name prefix); on the
  // synthetic sine only, it just proves the step runs on this session.
  try {
    const probes = clips.length > 1 ? clips.slice(1) : [synth];
    const parts = [];
    for (const probe of probes) {
      const t3 = performance.now();
      const lang = await detectLanguage(T, pipe, probe.audio);
      const ok = clips.length > 1 ? (lang === probe.lang ? "ok" : `WRONG, expected ${probe.lang}`) : "sine";
      parts.push(`${probe.name}→${lang} ${ok} ${Math.round(performance.now() - t3)} ms`);
    }
    row.detect = parts.join("; ");
  } catch (e) {
    row.detect = `ERROR ${e.message}`;
  }
  if (typeof pipe.dispose === "function") await pipe.dispose();
  return row;
}

function runChild(cfg, opts) {
  return new Promise((resolve) => {
    const args = [__filename, "--one", JSON.stringify(cfg), "--fixtures", opts.fixtures];
    const child = spawn(process.execPath, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ...cfg, error: `timeout after ${opts.loadTimeoutMin} min (download or load)` });
    }, opts.loadTimeoutMin * 60 * 1000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => {
      err += d;
      process.stderr.write(d);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = out.split(/\r?\n/).find((l) => l.startsWith("RESULT "));
      if (line) {
        try {
          return resolve(JSON.parse(line.slice(7)));
        } catch (_) {
          // fall through
        }
      }
      const tail = (err.trim().split(/\r?\n/).filter(Boolean).pop() || "").slice(0, 160);
      resolve({ ...cfg, error: `exit ${code}: ${tail || "no output"}` });
    });
  });
}

// --- table -------------------------------------------------------------------

const fmt = (v, unit = "") => (v === null || v === undefined ? "—" : `${v}${unit}`);
const pct = (v) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)} %`);

function table(rows, state) {
  const lines = [
    "| Model | Precision (enc/dec) | Device | Ollama | Load s | Cold first run s | RTF synthetic 3 s | RTF fixtures | WER EN | WER DE | EN/DE detect | Note |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.label} | ${r.tag} | ${r.device} | ${state} | ${fmt(r.loadMs == null ? null : (r.loadMs / 1000).toFixed(1))} | ${fmt(
        r.coldMs == null ? null : (r.coldMs / 1000).toFixed(2),
      )} | ${fmt(r.rtfSynthetic)} | ${fmt(r.rtfFixtures)} | ${pct(r.werEn)} | ${pct(r.werDe)} | ${fmt(r.detect)} | ${r.error ? `FAILED: ${r.error}` : "ok"} |`,
    );
  }
  return lines.join("\n");
}

// --- main --------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.one) {
    try {
      const row = await runOne(opts.one, opts);
      process.stdout.write(`RESULT ${JSON.stringify(row)}\n`);
    } catch (e) {
      process.stdout.write(`RESULT ${JSON.stringify({ ...opts.one, error: String(e && e.message ? e.message : e).slice(0, 300) })}\n`);
      process.exitCode = 1;
    }
    return;
  }

  const { clips, notes } = loadClips(opts.fixtures);
  if (opts.warmGemma) await warmGemma();
  const state = await ollamaState();
  const runtime = `${process.versions.electron ? `Electron ${process.versions.electron} (node mode)` : `Node ${process.versions.node}`}, onnxruntime-node ${require(path.join(APP_DIR, "node_modules", "onnxruntime-node", "package.json")).version}, transformers ${require(path.join(APP_DIR, "node_modules", "@huggingface", "transformers", "package.json")).version}`;
  process.stderr.write(`bench-stt: ${runtime}\nOllama: ${state}\nclips: ${clips.map((c) => `${c.name} (${c.seconds.toFixed(1)} s)`).join(", ")}\n`);

  const rows = [];
  for (const m of opts.models) {
    for (const p of MODELS[m].precisions) {
      for (const device of opts.devices) {
        const cfg = { model: MODELS[m].id, label: MODELS[m].label, tag: p.tag, dtype: p.dtype, device };
        process.stderr.write(`\n=== ${cfg.label} ${cfg.tag} on ${device} ===\n`);
        const row = await runChild(cfg, opts);
        process.stderr.write(`→ ${row.error ? `FAILED ${row.error}` : `load ${row.loadMs} ms, RTF ${row.rtfSynthetic}`}\n`);
        rows.push(row);
      }
    }
  }

  const md = [
    `# STT bench — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    "",
    `Runtime: ${runtime}. Ollama: ${state}.`,
    `Clips: ${clips.map((c) => `${c.name} (${c.seconds.toFixed(1)} s${c.ref ? ", ref" : ""})`).join(", ")}.`,
    ...(notes.length ? ["", "Notes:", ...notes.map((n) => `- ${n}`)] : []),
    "",
    table(rows, state),
    "",
    "RTF = inference seconds ÷ audio seconds (lower is better; < 1 = faster than real time). Load = pipeline() incl. any download.",
    "",
    "## Transcripts",
    "",
    ...rows.flatMap((r) =>
      r.texts && r.texts.length
        ? [`### ${r.label} ${r.tag} ${r.device}`, ...r.texts.map((t) => `- ${t.name}: ${JSON.stringify(t.text)}${t.wer !== null && t.wer !== undefined ? ` (WER ${pct(t.wer)})` : ""}`), ""]
        : [],
    ),
  ].join("\n");

  if (opts.out) {
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    const tmp = `${opts.out}.tmp`;
    fs.writeFileSync(tmp, md);
    fs.renameSync(tmp, opts.out);
    process.stderr.write(`\nwrote ${opts.out} (${Buffer.byteLength(md)} bytes)\n`);
  }
  process.stdout.write(`${md}\n`);
}

main().catch((e) => {
  process.stderr.write(`bench-stt failed: ${e.stack || e.message}\n`);
  process.exit(1);
});
