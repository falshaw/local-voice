import { describe, it, expect, vi } from "vitest";

// ---- Tray icon state → color mapping (extracted from main.js) ----

function getTrayColor(state) {
  const colors = {
    idle: "#9ca3af",
    recording: "#ef4444",
    processing: "#d4a843",
  };
  return colors[state] || colors.idle;
}

describe("Tray icon colors", () => {
  it("returns gray for idle state", () => {
    expect(getTrayColor("idle")).toBe("#9ca3af");
  });

  it("returns red for recording state", () => {
    expect(getTrayColor("recording")).toBe("#ef4444");
  });

  it("returns gold for processing state", () => {
    expect(getTrayColor("processing")).toBe("#d4a843");
  });

  it("falls back to idle color for unknown state", () => {
    expect(getTrayColor("unknown")).toBe("#9ca3af");
    expect(getTrayColor(undefined)).toBe("#9ca3af");
  });
});

// ---- Tray tooltip labels (extracted from main.js) ----

function getTrayLabel(state) {
  const labels = {
    idle: "Voice — Ready (F9 to toggle)",
    recording: "Voice — Recording... (press again to stop)",
    processing: "Voice — Transcribing...",
  };
  return labels[state] || labels.idle;
}

describe("Tray tooltip labels", () => {
  it("returns correct label for each state", () => {
    expect(getTrayLabel("idle")).toContain("Ready");
    expect(getTrayLabel("recording")).toContain("Recording");
    expect(getTrayLabel("processing")).toContain("Transcribing");
  });

  it("falls back to idle label for unknown state", () => {
    expect(getTrayLabel("bogus")).toContain("Ready");
  });
});

// ---- Settings defaults validation ----

const SETTINGS_DEFAULTS = {
  hotkey: "F9",
  modelId: "onnx-community/whisper-small",
  language: "en",
  autoPaste: true,
  showOverlay: true,
};

describe("Settings defaults", () => {
  it("has F9 as default hotkey", () => {
    expect(SETTINGS_DEFAULTS.hotkey).toBe("F9");
  });

  it("uses onnx-community/whisper-small model", () => {
    expect(SETTINGS_DEFAULTS.modelId).toBe("onnx-community/whisper-small");
  });

  it("defaults to English", () => {
    expect(SETTINGS_DEFAULTS.language).toBe("en");
  });

  it("enables auto-paste by default", () => {
    expect(SETTINGS_DEFAULTS.autoPaste).toBe(true);
  });

  it("shows overlay by default", () => {
    expect(SETTINGS_DEFAULTS.showOverlay).toBe(true);
  });
});

// ---- settings:set allowlist (lib/settings.js, used by main.js) ----

import { SETTING_KEYS, validateSetting } from "../lib/settings.js";

describe("validateSetting", () => {
  it("still carries the original five store keys (full 22-key contract: settings.test.js)", () => {
    expect(SETTING_KEYS).toHaveLength(22);
    for (const k of ["autoPaste", "hotkey", "language", "modelId", "showOverlay"]) {
      expect(SETTING_KEYS).toContain(k);
    }
  });

  it("accepts well-formed values and trims strings", () => {
    expect(validateSetting("hotkey", " F10 ")).toBe("F10");
    expect(validateSetting("modelId", "onnx-community/whisper-small")).toBe("onnx-community/whisper-small");
    expect(validateSetting("language", "de")).toBe("de");
    expect(validateSetting("autoPaste", false)).toBe(false);
    expect(validateSetting("showOverlay", true)).toBe(true);
  });

  it("rejects unknown keys, including prototype names", () => {
    expect(() => validateSetting("apiKey", "x")).toThrow(/Unknown setting/);
    expect(() => validateSetting("__proto__", {})).toThrow(/Unknown setting/);
    expect(() => validateSetting("constructor", "x")).toThrow(/Unknown setting/);
    expect(() => validateSetting(undefined, "x")).toThrow(/Unknown setting/);
  });

  it("rejects wrong types, empty and over-long strings", () => {
    expect(() => validateSetting("autoPaste", "true")).toThrow(/boolean/);
    expect(() => validateSetting("hotkey", true)).toThrow(/string/);
    expect(() => validateSetting("hotkey", "   ")).toThrow(/1–64/);
    expect(() => validateSetting("hotkey", "x".repeat(65))).toThrow(/1–64/);
    expect(validateSetting("hotkey", "x".repeat(64))).toHaveLength(64);
    // language is the en|de|auto enum since 2026-10-18, no longer a free string
    expect(() => validateSetting("language", "x".repeat(64))).toThrow(/one of: en, de, auto/);
    expect(() => validateSetting("language", "english")).toThrow(/one of/);
  });
});

// ---- Model migration logic ----

function shouldMigrateModel(currentModelId) {
  return (
    currentModelId === "Xenova/whisper-base" ||
    currentModelId === "Xenova/whisper-small"
  );
}

describe("Model migration", () => {
  it("migrates Xenova/whisper-base to new repo", () => {
    expect(shouldMigrateModel("Xenova/whisper-base")).toBe(true);
  });

  it("migrates Xenova/whisper-small to new repo", () => {
    expect(shouldMigrateModel("Xenova/whisper-small")).toBe(true);
  });

  it("does not migrate already-correct model", () => {
    expect(shouldMigrateModel("onnx-community/whisper-small")).toBe(false);
  });

  it("does not migrate unknown model", () => {
    expect(shouldMigrateModel("custom/my-model")).toBe(false);
  });
});

// ---- Audio buffer conversion (IPC handling) ----

describe("Audio buffer conversion", () => {
  it("handles ArrayBuffer input directly", () => {
    const ab = new ArrayBuffer(16);
    const result = ab instanceof ArrayBuffer ? ab : null;
    expect(result).toBe(ab);
  });

  it("converts Buffer-like object to ArrayBuffer", () => {
    const buf = Buffer.from([1, 2, 3, 4]);
    const ab = buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    );
    expect(ab).toBeInstanceOf(ArrayBuffer);
    expect(ab.byteLength).toBe(4);
  });

  it("preserves data through conversion", () => {
    const original = new Float32Array([1.0, 2.0, 3.0]);
    const buf = Buffer.from(original.buffer);
    const ab = buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    );
    const restored = new Float32Array(ab);
    expect(restored[0]).toBe(1.0);
    expect(restored[1]).toBe(2.0);
    expect(restored[2]).toBe(3.0);
  });
});
