// Overlay: microphone capture + UI state.
// Capture = AudioContext at 16 kHz → AudioWorklet (pcm-worklet.js) → 512-sample
// Float32 frames streamed to main ("audio:frame"), then the tail ("audio:end").
// Main runs VAD on the frames and hands the joined audio to Whisper.

let audioStream = null;
let audioCtx = null;
let framer = null;
let gen = 0; // current recording generation
let capturing = false; // frames of `gen` are forwarded
let cancelled = false;
let readyLabel = "Ready — Press F9";

const statusText = document.getElementById("status-text");
const downloadContainer = document.getElementById("download-container");
const downloadFill = document.getElementById("download-fill");
const downloadText = document.getElementById("download-text");
const resultText = document.getElementById("result-text");

async function ensureAudio() {
  if (!audioStream) {
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
  }
  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: 16000 });
    await audioCtx.audioWorklet.addModule("pcm-worklet.js");
    const source = audioCtx.createMediaStreamSource(audioStream);
    framer = new AudioWorkletNode(audioCtx, "pcm-framer", { numberOfOutputs: 1 });
    framer.port.onmessage = onFramerMessage;
    source.connect(framer);
    // Outputs silence; the connection keeps the node in the rendered graph.
    framer.connect(audioCtx.destination);
  }
  if (audioCtx.state !== "running") await audioCtx.resume();
}

function onFramerMessage(e) {
  const msg = e.data;
  if (!msg || msg.gen !== gen) return; // stale message from an earlier recording
  if (msg.type === "frame" && capturing && !cancelled) {
    window.voice.sendFrame(msg.samples.buffer);
  } else if (msg.type === "end") {
    capturing = false;
    if (!cancelled) window.voice.sendAudioEnd(msg.samples.buffer);
    if (audioCtx) audioCtx.suspend().catch(() => {});
  }
}

async function startRecording() {
  gen += 1;
  const myGen = gen;
  cancelled = false;
  try {
    await ensureAudio();
    if (myGen !== gen || cancelled) return;
    capturing = true;
    framer.port.postMessage({ cmd: "start", gen: myGen });
  } catch (err) {
    console.error("Mic access failed:", err);
    capturing = false;
    window.voice.sendEmpty();
  }
}

function stopRecording() {
  if (!framer || !capturing) {
    if (!cancelled) window.voice.sendEmpty();
    cancelled = true; // a start still waiting on the mic must not begin capturing
    return;
  }
  framer.port.postMessage({ cmd: "stop" });
}

function cancelRecording() {
  cancelled = true;
  if (framer && capturing) framer.port.postMessage({ cmd: "stop" });
}

// --- Event Handlers ---

window.voice.onRecordingStart(() => {
  document.body.className = "recording";
  statusText.textContent = "Listening... (Esc cancels)";
  resultText.classList.add("hidden");
  startRecording();
});

window.voice.onRecordingStop(() => {
  document.body.className = "processing";
  statusText.textContent = "Transcribing...";
  stopRecording();
});

window.voice.onRecordingCancel(() => {
  cancelRecording();
  document.body.className = "";
  statusText.textContent = "Cancelled";
  setTimeout(() => {
    statusText.textContent = readyLabel;
  }, 1200);
});

window.voice.onModelProgress((progress) => {
  downloadContainer.classList.remove("hidden");
  downloadFill.style.width = `${progress}%`;
  downloadText.textContent = `Downloading model... ${Math.round(progress)}%`;
});

window.voice.onModelReady(() => {
  downloadContainer.classList.add("hidden");
  statusText.textContent = readyLabel;
});

window.voice.onTranscriptionDone((text) => {
  document.body.className = "";
  statusText.textContent = readyLabel;
  if (text) {
    resultText.textContent = text;
    resultText.classList.remove("hidden");
    setTimeout(() => resultText.classList.add("hidden"), 3000);
  }
});

window.voice.onTranscriptionError((error) => {
  document.body.className = "";
  statusText.textContent = "Error — try again";
  console.error("Transcription error:", error);
  setTimeout(() => {
    statusText.textContent = readyLabel;
  }, 2000);
});

window.voice
  .getSettings()
  .then((s) => {
    readyLabel = `Ready — ${s.hotkeyMode === "hold" ? "Hold" : "Press"} ${s.hotkey}`;
  })
  .catch(() => {});

// Show loading state on startup
statusText.textContent = "Loading model...";
downloadContainer.classList.remove("hidden");
