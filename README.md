# Local Voice

System-wide voice dictation for Windows that runs entirely on your own machine. Press a hotkey, speak, and the transcript is typed into whatever window has focus.

Speech recognition uses OpenAI's Whisper models (ONNX builds) through `@huggingface/transformers`, running locally on the CPU or on the GPU via DirectML. Audio never leaves the computer. The only network traffic is the one-time model download from Hugging Face and, if you enable it, calls to an Ollama server on `127.0.0.1`.

## Why

Cloud dictation services send every recording to a third party. Local Voice keeps audio, transcripts and history on disk under your user profile, so it can be used for email, code, notes and anything else you would not want to upload.

## Features

- **Global hotkey** (default `F9`), in toggle mode or hold-to-talk mode (push-to-talk via a low-level keyboard hook, F1-F24 only). `Esc` cancels a recording.
- **Second hotkey** with its own language, e.g. `F9` for English and another key for German.
- **Languages:** English, German, or Auto (EN/DE detection done in the worker by comparing the decoder's language-token scores).
- **Models:** `whisper-small` (default, ~577 MB) or `whisper-large-v3-turbo` (opt-in). Device `dml` (DirectML GPU) by default with a CPU `whisper-small` standby and automatic fallback; `cpu` is also available.
- **Voice activity detection** (optional): Silero VAD trims leading/trailing silence, drops recordings with no speech, and can auto-stop after a configurable silence.
- **Personal dictionary:** whole-word and phrase replacements, optional case sensitivity and per-mode scoping.
- **App-aware modes:** the foreground window at recording start selects `raw`, `formal` or `code` via substring rules on process name or window title.
- **Optional LLM cleanup** via a local Ollama server: fixes punctuation and filler words per mode. Any failure (Ollama down, model not loaded, timeout, implausible output) falls back to the raw transcript, so cleanup never blocks a paste.
- **Auto-paste:** the text is placed on the clipboard and pasted with Ctrl+V; the previous clipboard content is restored afterwards.
- **Local history** of recent dictations (capped by count and audio size), optionally with WAV audio, with copy/re-paste from the settings window.
- **Tray icon** showing idle / recording / processing state, model and device, and quick language switching.
- **Light and dark theme** for the settings window and the overlay: follows Windows by default, or set it to light or dark (General > Appearance, or the toggle in the sidebar).

## Architecture

```
renderer (overlay)            main process                         worker threads
  mic -> AudioWorklet  --IPC-->  state machine, hotkeys, tray  --->  transcriber.js (Whisper, CPU/DML)
  16 kHz Float32 PCM             postprocess pipeline:          --->  vad-worker.js  (Silero VAD)
                                   dictionary -> [Ollama cleanup] -> dictionary
                                 clipboard + Ctrl+V paste, history
```

- `main.js` - Electron main process: tray, hotkeys, IPC, paste, history, settings window.
- `lib/` - pure, unit-tested modules (state machine, settings schema and validation, dictionary, modes, language selection, VAD maths, push-to-talk key mapping, history store) plus the two workers.
- `renderer/` - overlay window and settings UI. Context isolation is on, Node integration off; the preload exposes only named IPC channels, and every setting written from the renderer is validated against a schema. Fonts (Plus Jakarta Sans, JetBrains Mono, SIL OFL 1.1) are bundled in `renderer/fonts/`, so the UI makes no network requests.
- The Ollama URL (`http://127.0.0.1:11434`) and cleanup model are constants in `lib/ollama.js`, not settings, so a compromised renderer cannot redirect dictated text elsewhere.

All writable data (settings, history, model cache) lives in `%APPDATA%\local-voice`.

## Requirements

- Windows 10/11 x64 (paste and foreground-window lookup use PowerShell / Win32 APIs)
- Node.js 20 or newer
- Optional: a DirectML-capable GPU
- Optional: [Ollama](https://ollama.com) on `127.0.0.1:11434` with the model named in `lib/ollama.js` (`CLEANUP_MODEL`) for transcript cleanup

## Setup and run

```bash
npm install
npm start          # launches the tray app
npm run dev        # same, with --dev
```

The first `npm start` takes noticeably longer than later ones, for two downloads:

1. **Electron itself.** The `electron` package fetches its platform binary (~100 MB) the first time it runs and prints `Downloading Electron binary...`.
2. **The Whisper model.** `whisper-small` (~577 MB) is downloaded from Hugging Face into `%APPDATA%\local-voice\models`; progress is shown in the overlay. Dictation works once it finishes.

Both are cached, so later starts take a few seconds. Open **Settings...** from the tray menu to change hotkeys, language, model, device, VAD, dictionary, modes, cleanup and history.

Build a Windows installer (NSIS, x64) into `dist/`:

```bash
npm run dist
```

`npm run dist` first runs `scripts/gen-app-icon.js`, which writes `build/icon.ico` from the tray mic glyph. The icon is a generated file and is not tracked in git.

## Configuration

All configuration is done in the settings window and stored with `electron-store` in the user data directory. The allowed keys, types and defaults are defined in `lib/settings.js`. Cleanup prompts per mode are plain text files in `lib/prompts/`.

One environment variable exists for development and tests: `LOCAL_VOICE_USER_DATA`, an absolute path that replaces `%APPDATA%\local-voice`. A copy started with it gets its own settings, history, model cache and single-instance lock, so it can run next to an installed copy. Relative or empty values are ignored. Pick a different hotkey for the second copy; two apps cannot register the same one.

## Tests

```bash
npm test           # vitest
```

Unit tests in `__tests__/` cover the state machine, settings validation and migration, dictionary, modes, language selection, VAD segment trimming, push-to-talk key mapping, history, paths and the post-processing pipeline.

`scripts/bench-stt.js` benchmarks model x precision x device (load time, real-time factor, and WER when you supply your own WAV + reference text fixtures in `scripts/fixtures/`):

```bash
ELECTRON_RUN_AS_NODE=1 npx electron scripts/bench-stt.js --out bench.md
```

## License

MIT - see [LICENSE](LICENSE).
