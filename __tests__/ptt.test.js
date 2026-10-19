import { describe, it, expect, vi } from "vitest";
import { FKEYS, accelToKey, createHoldController, startPtt } from "../lib/ptt.js";

describe("accelToKey", () => {
  it("maps F1–F24 to the uiohook keycodes", () => {
    expect(Object.keys(FKEYS)).toHaveLength(24);
    expect(accelToKey("F9")).toEqual({ keycode: 0x43, ctrl: false, alt: false, shift: false, meta: false });
    expect(accelToKey("f1").keycode).toBe(0x3b);
    expect(accelToKey("F12").keycode).toBe(0x58);
    expect(accelToKey("F13").keycode).toBe(0x5b);
    expect(accelToKey("F24").keycode).toBe(0x6b);
  });

  it("understands Electron modifier spellings", () => {
    expect(accelToKey("Ctrl+Shift+F10")).toEqual({ keycode: 0x44, ctrl: true, alt: false, shift: true, meta: false });
    expect(accelToKey("CommandOrControl+F1").ctrl).toBe(true);
    expect(accelToKey("CmdOrCtrl+F1").ctrl).toBe(true);
    expect(accelToKey("Control+F1").ctrl).toBe(true);
    expect(accelToKey("Alt+F2").alt).toBe(true);
    expect(accelToKey("Option+F2").alt).toBe(true);
    expect(accelToKey("Super+F2").meta).toBe(true);
    expect(accelToKey(" Shift + F3 ").shift).toBe(true);
  });

  it("rejects everything that is not an F-key (+ modifiers)", () => {
    expect(() => accelToKey("A")).toThrow(/F1–F24/);
    expect(() => accelToKey("Ctrl+A")).toThrow(/F1–F24/);
    expect(() => accelToKey("Ctrl+Space")).toThrow(/F1–F24/);
    expect(() => accelToKey("F25")).toThrow(/F1–F24/);
    expect(() => accelToKey("F9+F10")).toThrow(/F1–F24/);
    expect(() => accelToKey("Ctrl")).toThrow(/No F-key/);
    expect(() => accelToKey("")).toThrow(/Empty/);
    expect(() => accelToKey(null)).toThrow(/Empty/);
  });
});

function evt(keycode, mods = {}) {
  return { keycode, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods };
}

describe("hold state machine", () => {
  it("keydown starts once (auto-repeat ignored), keyup stops", () => {
    const onDown = vi.fn();
    const onUp = vi.fn();
    const ctl = createHoldController(accelToKey("F9"), { onDown, onUp });
    expect(ctl.isHeld()).toBe(false);
    ctl.keydown(evt(0x43));
    ctl.keydown(evt(0x43));
    ctl.keydown(evt(0x43));
    expect(onDown).toHaveBeenCalledTimes(1);
    expect(ctl.isHeld()).toBe(true);
    ctl.keyup(evt(0x43));
    expect(onUp).toHaveBeenCalledTimes(1);
    expect(ctl.isHeld()).toBe(false);
    ctl.keyup(evt(0x43));
    expect(onUp).toHaveBeenCalledTimes(1);
  });

  it("ignores other keys and keyup without a prior keydown", () => {
    const onDown = vi.fn();
    const onUp = vi.fn();
    const ctl = createHoldController(accelToKey("F9"), { onDown, onUp });
    ctl.keydown(evt(0x44));
    ctl.keyup(evt(0x43));
    ctl.keydown(null);
    expect(onDown).not.toHaveBeenCalled();
    expect(onUp).not.toHaveBeenCalled();
  });

  it("modifiers must match exactly on keydown", () => {
    const onDown = vi.fn();
    const onUp = vi.fn();
    const ctl = createHoldController(accelToKey("Ctrl+F9"), { onDown, onUp });
    ctl.keydown(evt(0x43));
    expect(onDown).not.toHaveBeenCalled();
    ctl.keydown(evt(0x43, { ctrlKey: true, shiftKey: true }));
    expect(onDown).not.toHaveBeenCalled();
    ctl.keydown(evt(0x43, { ctrlKey: true }));
    expect(onDown).toHaveBeenCalledTimes(1);
    // Releasing Ctrl before F9 must still end the hold.
    ctl.keyup(evt(0x43));
    expect(onUp).toHaveBeenCalledTimes(1);
  });

  it("a plain hotkey ignores a press with extra modifiers", () => {
    const onDown = vi.fn();
    const ctl = createHoldController(accelToKey("F9"), { onDown, onUp: () => {} });
    ctl.keydown(evt(0x43, { altKey: true }));
    expect(onDown).not.toHaveBeenCalled();
  });
});

function fakeHook({ startThrows = false } = {}) {
  const listeners = { keydown: [], keyup: [] };
  const uIOhook = {
    on: vi.fn((ev, fn) => listeners[ev].push(fn)),
    off: vi.fn((ev, fn) => {
      listeners[ev] = listeners[ev].filter((f) => f !== fn);
    }),
    start: vi.fn(() => {
      if (startThrows) throw new Error("hook refused");
    }),
    stop: vi.fn(),
    emit: (ev, e) => listeners[ev].forEach((f) => f(e)),
  };
  return { uIOhook, listeners };
}

describe("startPtt", () => {
  it("wires the hook and drives the handlers; stop() unwires it", () => {
    const { uIOhook, listeners } = fakeHook();
    const onDown = vi.fn();
    const onUp = vi.fn();
    const handle = startPtt("F9", { onDown, onUp }, () => ({ uIOhook }));
    expect(uIOhook.start).toHaveBeenCalledTimes(1);
    uIOhook.emit("keydown", evt(0x43));
    uIOhook.emit("keydown", evt(0x43));
    uIOhook.emit("keyup", evt(0x43));
    expect(onDown).toHaveBeenCalledTimes(1);
    expect(onUp).toHaveBeenCalledTimes(1);
    handle.stop();
    expect(uIOhook.stop).toHaveBeenCalledTimes(1);
    expect(listeners.keydown).toHaveLength(0);
    expect(listeners.keyup).toHaveLength(0);
    uIOhook.emit("keydown", evt(0x43));
    expect(onDown).toHaveBeenCalledTimes(1);
  });

  it("throws and unwires when the hook cannot start", () => {
    const { uIOhook, listeners } = fakeHook({ startThrows: true });
    expect(() => startPtt("F9", { onDown() {}, onUp() {} }, () => ({ uIOhook }))).toThrow(/hook refused/);
    expect(listeners.keydown).toHaveLength(0);
    expect(listeners.keyup).toHaveLength(0);
  });

  it("throws when the module cannot be loaded, before touching anything", () => {
    expect(() =>
      startPtt("F9", { onDown() {}, onUp() {} }, () => {
        throw new Error("Cannot find module 'uiohook-napi'");
      }),
    ).toThrow(/Cannot find module/);
  });

  it("rejects a non-F-key accelerator before loading the hook", () => {
    const loader = vi.fn();
    expect(() => startPtt("Ctrl+V", { onDown() {}, onUp() {} }, loader)).toThrow(/F1–F24/);
    expect(loader).not.toHaveBeenCalled();
  });

  it("the real uiohook-napi module exposes the expected API", async () => {
    const mod = await import("uiohook-napi");
    expect(typeof mod.uIOhook.on).toBe("function");
    expect(typeof mod.uIOhook.start).toBe("function");
    expect(typeof mod.uIOhook.stop).toBe("function");
    expect(mod.UiohookKey.F9).toBe(FKEYS.F9);
    expect(mod.UiohookKey.F1).toBe(FKEYS.F1);
    expect(mod.UiohookKey.F12).toBe(FKEYS.F12);
    expect(mod.UiohookKey.F13).toBe(FKEYS.F13);
    expect(mod.UiohookKey.F24).toBe(FKEYS.F24);
  });
});
