// Whisper transcription — runs in Node.js worker_threads.
// Uses @huggingface/transformers (onnxruntime-node) for local inference.
//
// Sessions (lib/stt-config.js sessionPlan):
//   primary  = settings modelId on settings sttDevice (cpu | dml)
//   fallback = CPU whisper-small, loaded only when the primary is on the GPU. Used
//              when main says the GPU is busy (Ollama VRAM > 5.5 GB) and after any
//              DirectML init or inference error (the GPU is then abandoned for the
//              rest of the session and main is told via "stt:fallback").

const { parentPort, workerData } = require("worker_threads");
const { sessionPlan, modelOptions, FALLBACK_MODEL } = require("./stt-config");
const { detectLanguage } = require("./language");

let T = null;
let primary = null; // { pipe, device, modelId }
let fallback = null;
let fallbackPromise = null;

async function transformers() {
  if (!T) {
    T = await import("@huggingface/transformers");
    T.env.allowLocalModels = true;
    // main passes <userData>/models: the default cache sits inside node_modules,
    // which is read-only app.asar in the packaged build.
    if (workerData && workerData.cacheDir) T.env.cacheDir = workerData.cacheDir;
  }
  return T;
}

async function build(opts, reportProgress) {
  const { pipeline } = await transformers();
  const pipe = await pipeline("automatic-speech-recognition", opts.modelId, {
    dtype: opts.dtype,
    device: opts.device,
    progress_callback: reportProgress
      ? (p) => {
          if (p.status === "progress" && p.progress) {
            parentPort.postMessage({ type: "model:progress", data: { progress: p.progress } });
          }
        }
      : undefined,
  });
  return { pipe, device: opts.device, modelId: opts.modelId };
}

function loadFallback() {
  if (fallback) return Promise.resolve(fallback);
  if (!fallbackPromise) {
    fallbackPromise = build(modelOptions(FALLBACK_MODEL, "cpu"), false)
      .then((s) => {
        fallback = s;
        return s;
      })
      .catch((err) => {
        fallbackPromise = null;
        throw err;
      });
  }
  return fallbackPromise;
}

async function loadModels({ modelId, device }) {
  const plan = sessionPlan(modelId, device);
  parentPort.postMessage({ type: "model:progress", data: { progress: 5 } });
  try {
    primary = await build(plan.primary, true);
  } catch (err) {
    if (plan.primary.device === "cpu") {
      parentPort.postMessage({
        type: "transcription:error",
        data: { error: `Model load failed: ${err.message}` },
      });
      return;
    }
    parentPort.postMessage({
      type: "stt:fallback",
      data: { reason: `${plan.primary.device} init failed: ${err.message}` },
    });
    try {
      primary = await loadFallback();
    } catch (err2) {
      parentPort.postMessage({
        type: "transcription:error",
        data: { error: `Model load failed: ${err2.message}` },
      });
      return;
    }
  }
  parentPort.postMessage({
    type: "model:ready",
    data: { device: primary.device, modelId: primary.modelId },
  });
  // GPU primary → keep CPU whisper-small warm as standby.
  if (plan.fallback && primary.device !== "cpu") {
    loadFallback().catch((err) => {
      parentPort.postMessage({
        type: "stt:warning",
        data: { reason: `CPU standby load failed: ${err.message}` },
      });
    });
  }
}

/** EN vs DE from one decoder step after <|startoftranscript|> (lib/language.js). */
async function detectJobLanguage(session, audio) {
  return detectLanguage(await transformers(), session.pipe, audio);
}

async function runJob(session, audio, language) {
  const lang = language || (await detectJobLanguage(session, audio));
  const result = await session.pipe(audio, {
    language: lang,
    task: "transcribe", // never "translate": DE stays DE
    chunk_length_s: 30,
    stride_length_s: 5,
  });
  return { text: (result.text || "").trim(), language: lang };
}

async function transcribe({ jobId, audio, language, forceCpu }) {
  if (!primary) {
    parentPort.postMessage({
      type: "transcription:error",
      data: { jobId, error: "Model not loaded" },
    });
    return;
  }
  let session = primary;
  if (forceCpu && primary.device !== "cpu") {
    try {
      session = await loadFallback();
    } catch (_) {
      session = primary;
    }
  }
  try {
    const r = await runJob(session, audio, language);
    parentPort.postMessage({
      type: "transcription:result",
      data: { jobId, text: r.text, language: r.language, device: session.device },
    });
  } catch (err) {
    if (session.device !== "cpu") {
      // DML failed mid-inference (OOM, unsupported op): drop the GPU, retry on CPU.
      parentPort.postMessage({
        type: "stt:fallback",
        data: { reason: `${session.device} inference failed: ${err.message}` },
      });
      try {
        primary = await loadFallback();
        const r = await runJob(primary, audio, language);
        parentPort.postMessage({
          type: "transcription:result",
          data: { jobId, text: r.text, language: r.language, device: "cpu" },
        });
        return;
      } catch (err2) {
        err = err2;
      }
    }
    parentPort.postMessage({
      type: "transcription:error",
      data: { jobId, error: `Transcription failed: ${err.message}` },
    });
  }
}

// Jobs run one at a time, in order.
let queue = Promise.resolve();

parentPort.on("message", (msg) => {
  const { type, data } = msg || {};
  switch (type) {
    case "load:model":
      queue = queue.then(() => loadModels(data)).catch(() => {});
      break;
    case "transcribe":
      queue = queue
        .then(() =>
          transcribe({
            jobId: data.jobId,
            audio: new Float32Array(data.audioBuffer),
            language: data.language,
            forceCpu: data.forceCpu === true,
          }),
        )
        .catch(() => {});
      break;
  }
});
