import { describe, it, expect } from "vitest";
import {
  SCHEMA,
  SETTING_KEYS,
  SETTING_TYPES,
  DEFAULTS,
  MODEL_IDS,
  LANGUAGES,
  MODES,
  THEMES,
  validateSetting,
  migrateLanguage,
  migrateSettings,
} from "../lib/settings.js";

const EXPECTED_KEYS = [
  "autoPaste",
  "cleanupEnabled",
  "cleanupOnlyIfLoaded",
  "cleanupTimeoutMs",
  "defaultMode",
  "dictionaryEnabled",
  "historyEnabled",
  "historyKeepAudio",
  "historyMax",
  "hotkey",
  "hotkey2",
  "hotkey2Language",
  "hotkeyMode",
  "language",
  "modelId",
  "modesEnabled",
  "showOverlay",
  "sttDevice",
  "theme",
  "vadAutoStop",
  "vadEnabled",
  "vadSilenceMs",
];

describe("settings schema", () => {
  it("exposes exactly the 22 store keys", () => {
    expect([...SETTING_KEYS].sort()).toEqual(EXPECTED_KEYS);
    expect(Object.keys(SETTING_TYPES).sort()).toEqual(EXPECTED_KEYS);
    expect(Object.keys(DEFAULTS).sort()).toEqual(EXPECTED_KEYS);
  });

  it("has the planned types and defaults", () => {
    expect(SETTING_TYPES.hotkey).toBe("string");
    expect(SETTING_TYPES.hotkey2).toBe("string?");
    expect(SETTING_TYPES.language).toBe("enum");
    expect(SETTING_TYPES.historyMax).toBe("int");
    expect(SETTING_TYPES.autoPaste).toBe("boolean");
    expect(DEFAULTS).toMatchObject({
      hotkey: "F9",
      hotkey2: "",
      hotkey2Language: "de",
      hotkeyMode: "toggle",
      modelId: "onnx-community/whisper-small",
      sttDevice: "dml", // bench 2026-10-19: RTF 0.12 vs 0.44–0.83 on CPU

      language: "en",
      autoPaste: true,
      showOverlay: true,
      dictionaryEnabled: true,
      historyEnabled: true,
      historyMax: 50,
      historyKeepAudio: false,
      cleanupEnabled: false,
      cleanupTimeoutMs: 12000,
      cleanupOnlyIfLoaded: true,
      vadEnabled: false,
      vadAutoStop: false,
      vadSilenceMs: 2000,
      modesEnabled: false,
      defaultMode: "raw",
      theme: "system",
    });
    expect(THEMES).toEqual(["system", "light", "dark"]);
    expect(LANGUAGES).toEqual(["en", "de", "auto"]);
    expect(MODES).toEqual(["raw", "formal", "code"]);
    expect(MODEL_IDS).toEqual(["onnx-community/whisper-small", "onnx-community/whisper-large-v3-turbo"]);
    expect(SCHEMA.historyMax).toMatchObject({ min: 1, max: 200 });
    expect(SCHEMA.cleanupTimeoutMs).toMatchObject({ min: 2000, max: 30000 });
    expect(SCHEMA.vadSilenceMs).toMatchObject({ min: 800, max: 10000 });
  });

  it("is frozen", () => {
    expect(Object.isFrozen(SCHEMA)).toBe(true);
    expect(Object.isFrozen(DEFAULTS)).toBe(true);
  });
});

describe("validateSetting", () => {
  it("rejects unknown keys, including prototype names", () => {
    expect(() => validateSetting("apiKey", "x")).toThrow(/Unknown setting/);
    expect(() => validateSetting("__proto__", {})).toThrow(/Unknown setting/);
    expect(() => validateSetting("constructor", "x")).toThrow(/Unknown setting/);
    expect(() => validateSetting("toString", "x")).toThrow(/Unknown setting/);
    expect(() => validateSetting(undefined, "x")).toThrow(/Unknown setting/);
    expect(() => validateSetting("dictionary", [])).toThrow(/Unknown setting/);
    expect(() => validateSetting("modeRules", [])).toThrow(/Unknown setting/);
  });

  it("string: trims, 1–64 chars", () => {
    expect(validateSetting("hotkey", " F10 ")).toBe("F10");
    expect(() => validateSetting("hotkey", "   ")).toThrow(/1–64/);
    expect(() => validateSetting("hotkey", "x".repeat(65))).toThrow(/1–64/);
    expect(validateSetting("hotkey", "x".repeat(64))).toHaveLength(64);
    expect(() => validateSetting("hotkey", true)).toThrow(/string/);
  });

  it("string?: empty allowed (= off), still capped at 64", () => {
    expect(validateSetting("hotkey2", "")).toBe("");
    expect(validateSetting("hotkey2", "   ")).toBe("");
    expect(validateSetting("hotkey2", " F8 ")).toBe("F8");
    expect(() => validateSetting("hotkey2", "x".repeat(65))).toThrow(/0–64/);
    expect(() => validateSetting("hotkey2", null)).toThrow(/string/);
  });

  it("enum: only listed values, exact case", () => {
    expect(validateSetting("language", "de")).toBe("de");
    expect(validateSetting("language", "auto")).toBe("auto");
    expect(() => validateSetting("language", "english")).toThrow(/one of: en, de, auto/);
    expect(() => validateSetting("language", "DE")).toThrow(/one of/);
    expect(() => validateSetting("language", "x".repeat(65))).toThrow(/one of/);
    expect(() => validateSetting("language", 1)).toThrow(/one of/);
    expect(validateSetting("hotkeyMode", "hold")).toBe("hold");
    expect(() => validateSetting("hotkeyMode", "push")).toThrow(/one of/);
    expect(validateSetting("sttDevice", "dml")).toBe("dml");
    expect(() => validateSetting("sttDevice", "cuda")).toThrow(/one of/);
    expect(validateSetting("modelId", "onnx-community/whisper-large-v3-turbo")).toBe(
      "onnx-community/whisper-large-v3-turbo",
    );
    expect(() => validateSetting("modelId", "Xenova/whisper-small")).toThrow(/one of/);
    expect(validateSetting("defaultMode", "code")).toBe("code");
  });

  it("int: integer within [min, max]", () => {
    expect(validateSetting("historyMax", 1)).toBe(1);
    expect(validateSetting("historyMax", 200)).toBe(200);
    expect(() => validateSetting("historyMax", 0)).toThrow(/1–200/);
    expect(() => validateSetting("historyMax", 201)).toThrow(/1–200/);
    expect(() => validateSetting("historyMax", 1.5)).toThrow(/integer/);
    expect(() => validateSetting("historyMax", "5")).toThrow(/integer/);
    expect(() => validateSetting("historyMax", NaN)).toThrow(/integer/);
    expect(() => validateSetting("cleanupTimeoutMs", 1999)).toThrow(/2000–30000/);
    expect(validateSetting("cleanupTimeoutMs", 30000)).toBe(30000);
    expect(() => validateSetting("vadSilenceMs", 10001)).toThrow(/800–10000/);
  });

  it("boolean: strictly boolean", () => {
    expect(validateSetting("autoPaste", false)).toBe(false);
    expect(() => validateSetting("autoPaste", "true")).toThrow(/boolean/);
    expect(() => validateSetting("cleanupEnabled", 1)).toThrow(/boolean/);
  });
});

describe("migrateLanguage", () => {
  it("maps old free-form values onto en|de|auto", () => {
    expect(migrateLanguage("de")).toBe("de");
    expect(migrateLanguage("German")).toBe("de");
    expect(migrateLanguage(" Deutsch ")).toBe("de");
    expect(migrateLanguage("AUTO")).toBe("auto");
    expect(migrateLanguage("en")).toBe("en");
    expect(migrateLanguage("english")).toBe("en");
    expect(migrateLanguage("fr")).toBe("en");
    expect(migrateLanguage(undefined)).toBe("en");
    expect(migrateLanguage({ code: "de" })).toBe("en");
  });
});

describe("migrateSettings", () => {
  it("returns an empty patch for a current store", () => {
    expect(migrateSettings({ ...DEFAULTS })).toEqual({});
    expect(migrateSettings(null)).toEqual({});
    expect(migrateSettings(undefined)).toEqual({});
  });

  it("maps an old language string, leaves a valid one alone", () => {
    expect(migrateSettings({ language: "english" })).toEqual({ language: "en" });
    expect(migrateSettings({ language: "German" })).toEqual({ language: "de" });
    expect(migrateSettings({ language: "de" })).toEqual({});
  });

  it("resets old model ids and out-of-range values to defaults", () => {
    expect(migrateSettings({ modelId: "Xenova/whisper-small" })).toEqual({
      modelId: "onnx-community/whisper-small",
    });
    expect(migrateSettings({ modelId: "Xenova/whisper-base" })).toEqual({
      modelId: "onnx-community/whisper-small",
    });
    expect(migrateSettings({ historyMax: 999 })).toEqual({ historyMax: 50 });
    expect(migrateSettings({ cleanupTimeoutMs: "12000" })).toEqual({ cleanupTimeoutMs: 12000 });
    expect(migrateSettings({ hotkey: { key: "F9" } })).toEqual({ hotkey: "F9" });
    expect(migrateSettings({ autoPaste: "yes" })).toEqual({ autoPaste: true });
  });

  it("normalises values that validate after cleanup and ignores unknown keys", () => {
    expect(migrateSettings({ hotkey: " F10 " })).toEqual({ hotkey: "F10" });
    expect(migrateSettings({ dictionary: [{ from: "a", to: "b" }], somethingElse: 1 })).toEqual({});
  });
});
