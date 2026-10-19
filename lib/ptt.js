// Push-to-talk (hold the hotkey) via uiohook-napi — a low-level keyboard hook that
// sees keydown AND keyup, which Electron's globalShortcut cannot. Lazy-required only
// when hotkeyMode === "hold"; if it fails to load or start, the caller keeps the
// globalShortcut toggle and shows "Hold unavailable — toggle".
//
// Limits: no keys from elevated windows; Windows drops the hook if the main thread
// stalls > 1 s; AV may flag low-level hooks.

// uiohook keycodes (uiohook-napi 1.5.5 UiohookKey) — F-keys only, on purpose.
const FKEYS = Object.freeze({
  F1: 0x003b, F2: 0x003c, F3: 0x003d, F4: 0x003e, F5: 0x003f, F6: 0x0040,
  F7: 0x0041, F8: 0x0042, F9: 0x0043, F10: 0x0044, F11: 0x0057, F12: 0x0058,
  F13: 0x005b, F14: 0x005c, F15: 0x005d, F16: 0x0063, F17: 0x0064, F18: 0x0065,
  F19: 0x0066, F20: 0x0067, F21: 0x0068, F22: 0x0069, F23: 0x006a, F24: 0x006b,
});

const MODIFIERS = Object.freeze({
  ctrl: "ctrl", control: "ctrl", commandorcontrol: "ctrl", cmdorctrl: "ctrl",
  alt: "alt", option: "alt",
  shift: "shift",
  super: "meta", meta: "meta", cmd: "meta", command: "meta",
});

/**
 * Electron accelerator → { keycode, ctrl, alt, shift, meta }. Only F1–F24 plus
 * modifiers are accepted; anything else throws.
 */
function accelToKey(accel) {
  if (typeof accel !== "string" || !accel.trim()) throw new Error("Empty accelerator");
  const parts = accel.split("+").map((p) => p.trim()).filter(Boolean);
  const out = { keycode: null, ctrl: false, alt: false, shift: false, meta: false };
  for (const p of parts) {
    const mod = MODIFIERS[p.toLowerCase()];
    if (mod) {
      out[mod] = true;
      continue;
    }
    const key = p.toUpperCase();
    if (out.keycode !== null || !Object.prototype.hasOwnProperty.call(FKEYS, key)) {
      throw new Error(`Push-to-talk supports F1–F24 (+ modifiers) only, got "${accel}"`);
    }
    out.keycode = FKEYS[key];
  }
  if (out.keycode === null) throw new Error(`No F-key in "${accel}"`);
  return out;
}

/**
 * Hold state machine. keydown (auto-repeat ignored, modifiers must match) → onDown;
 * keyup of the main key → onUp. Returns { keydown(e), keyup(e), isHeld() }.
 */
function createHoldController(key, { onDown, onUp }) {
  let held = false;
  return {
    keydown(e) {
      if (!e || e.keycode !== key.keycode || held) return;
      if (!!e.ctrlKey !== key.ctrl || !!e.altKey !== key.alt || !!e.shiftKey !== key.shift || !!e.metaKey !== key.meta) {
        return;
      }
      held = true;
      onDown();
    },
    keyup(e) {
      if (!e || e.keycode !== key.keycode || !held) return;
      held = false;
      onUp();
    },
    isHeld: () => held,
  };
}

/**
 * Starts the hook. Throws when uiohook cannot be loaded or started.
 * `loader` is injectable for tests. Returns { stop() }.
 */
function startPtt(accel, handlers, loader = () => require("uiohook-napi")) {
  const key = accelToKey(accel);
  const { uIOhook } = loader();
  const ctl = createHoldController(key, handlers);
  const down = (e) => ctl.keydown(e);
  const up = (e) => ctl.keyup(e);
  uIOhook.on("keydown", down);
  uIOhook.on("keyup", up);
  try {
    uIOhook.start();
  } catch (err) {
    uIOhook.off("keydown", down);
    uIOhook.off("keyup", up);
    throw err;
  }
  return {
    stop() {
      uIOhook.off("keydown", down);
      uIOhook.off("keyup", up);
      try {
        uIOhook.stop();
      } catch (_) {
        // already stopped
      }
    },
  };
}

module.exports = { FKEYS, accelToKey, createHoldController, startPtt };
