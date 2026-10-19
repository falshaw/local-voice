// Silero VAD v5 (onnx-community/silero-vad, ~2 MB, fp32) in a worker thread.
// Loaded through transformers.js so it shares the model cache and onnxruntime-node.
// Per frame: input [1, 64 context + 512] float32, state [2,1,128], sr int64 16000.
// Frames are processed strictly in order; "flush" answers after the queue drains.

const { parentPort, workerData } = require("worker_threads");

const MODEL_ID = "onnx-community/silero-vad";
const FRAME = 512;
const CONTEXT = 64;

let model = null;
let Tensor = null;
let sr = null;
let state = null;
let context = new Float32Array(CONTEXT);
let queue = Promise.resolve();

function resetState() {
  state = new Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
  context = new Float32Array(CONTEXT);
}

async function load() {
  try {
    const T = await import("@huggingface/transformers");
    T.env.allowLocalModels = true;
    if (workerData && workerData.cacheDir) T.env.cacheDir = workerData.cacheDir; // see transcriber.js
    Tensor = T.Tensor;
    model = await T.AutoModel.from_pretrained(MODEL_ID, {
      config: { model_type: "custom" },
      dtype: "fp32",
      device: "cpu",
    });
    sr = new Tensor("int64", [16000n], []);
    resetState();
    parentPort.postMessage({ type: "vad:ready" });
  } catch (err) {
    parentPort.postMessage({ type: "vad:error", data: { error: err.message } });
  }
}

async function frame(recId, seq, buf) {
  if (!model) return;
  const samples = new Float32Array(buf);
  if (samples.length !== FRAME) return;
  const input = new Float32Array(CONTEXT + FRAME);
  input.set(context, 0);
  input.set(samples, CONTEXT);
  const out = await model({ input: new Tensor("float32", input, [1, CONTEXT + FRAME]), sr, state });
  state = out.stateN;
  context = samples.slice(FRAME - CONTEXT);
  parentPort.postMessage({ type: "vad:prob", data: { recId, seq, p: out.output.data[0] } });
}

parentPort.on("message", (msg) => {
  const { type, data } = msg || {};
  switch (type) {
    case "load":
      queue = queue.then(load);
      break;
    case "reset":
      queue = queue.then(() => model && resetState());
      break;
    case "frame":
      queue = queue.then(() => frame(data.recId, data.seq, data.samples)).catch((err) => {
        parentPort.postMessage({ type: "vad:error", data: { error: err.message } });
      });
      break;
    case "flush":
      queue = queue.then(() => parentPort.postMessage({ type: "vad:flushed", data: { token: data.token } }));
      break;
  }
});
