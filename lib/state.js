// Dictation state machine: idle → recording → processing → idle.
//
// transition(state, event) → { state, action } where action is what main.js must do:
//   "start"   begin a recording (new job id)
//   "stop"    stop the recording; audio goes to Whisper
//   "cancel"  stop the recording and discard the audio (Esc)
//   "drop"    forget the running job; its late result is ignored (Esc while processing —
//             Whisper cannot be aborted mid-inference)
//   "deliver" paste the result
//   "reset"   back to idle with nothing to deliver (empty audio / error)
//   null      ignore the event
//
// Events: "hotkey" (toggle press), "holdDown"/"holdUp" (push-to-talk), "esc",
// "autoStop" (VAD silence), "result", "empty", "error".

const STATES = Object.freeze(["idle", "recording", "processing"]);

function transition(state, event) {
  switch (state) {
    case "idle":
      if (event === "hotkey" || event === "holdDown") return { state: "recording", action: "start" };
      return { state, action: null };
    case "recording":
      if (event === "hotkey" || event === "holdUp" || event === "autoStop") {
        return { state: "processing", action: "stop" };
      }
      if (event === "esc") return { state: "idle", action: "cancel" };
      if (event === "empty" || event === "error") return { state: "idle", action: "reset" };
      return { state, action: null };
    case "processing":
      if (event === "result") return { state: "idle", action: "deliver" };
      if (event === "esc") return { state: "idle", action: "drop" };
      if (event === "empty" || event === "error") return { state: "idle", action: "reset" };
      // A hotkey press while Whisper is still busy is ignored (no overlapping jobs).
      return { state, action: null };
    default:
      return { state: "idle", action: "reset" };
  }
}

/** Esc is only registered while there is something to cancel. */
function wantsEsc(state) {
  return state === "recording" || state === "processing";
}

module.exports = { STATES, transition, wantsEsc };
