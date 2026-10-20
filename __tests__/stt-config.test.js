import { describe, it, expect } from "vitest";
import { FALLBACK_MODEL, DTYPES, modelOptions, sessionPlan, disposeSessions } from "../lib/stt-config.js";
import { MODEL_IDS } from "../lib/settings.js";

describe("stt-config", () => {
  it("covers exactly the model ids the settings enum allows", () => {
    expect(Object.keys(DTYPES).sort()).toEqual([...MODEL_IDS].sort());
    expect(FALLBACK_MODEL).toBe("onnx-community/whisper-small");
  });

  it("whisper-small on CPU stays encoder fp32 + decoder q4 (the cached files)", () => {
    expect(modelOptions("onnx-community/whisper-small", "cpu")).toEqual({
      modelId: "onnx-community/whisper-small",
      device: "cpu",
      dtype: { encoder_model: "fp32", decoder_model_merged: "q4" },
    });
  });

  it("unknown model or device falls back to whisper-small / cpu", () => {
    expect(modelOptions("Xenova/whisper-base", "cpu").modelId).toBe(FALLBACK_MODEL);
    expect(modelOptions("onnx-community/whisper-small", "cuda").device).toBe("cpu");
    expect(modelOptions(undefined, undefined)).toMatchObject({ modelId: FALLBACK_MODEL, device: "cpu" });
    expect(modelOptions("__proto__", "cpu").modelId).toBe(FALLBACK_MODEL);
  });

  it("returns a copy of the dtype map", () => {
    const a = modelOptions(FALLBACK_MODEL, "cpu");
    a.dtype.encoder_model = "q4";
    expect(modelOptions(FALLBACK_MODEL, "cpu").dtype.encoder_model).toBe("fp32");
  });

  it("sessionPlan keeps a CPU whisper-small standby only for a GPU primary", () => {
    expect(sessionPlan(FALLBACK_MODEL, "cpu")).toEqual({ primary: modelOptions(FALLBACK_MODEL, "cpu"), fallback: null });
    const gpu = sessionPlan("onnx-community/whisper-large-v3-turbo", "dml");
    expect(gpu.primary).toMatchObject({ modelId: "onnx-community/whisper-large-v3-turbo", device: "dml" });
    expect(gpu.fallback).toEqual(modelOptions(FALLBACK_MODEL, "cpu"));
  });
});

describe("disposeSessions (reload without terminating the worker)", () => {
  const session = (log, fail = false) => ({
    pipe: {
      dispose: async () => {
        log.push("d");
        if (fail) throw new Error("boom");
      },
    },
  });

  it("disposes each distinct session once (primary may be the standby)", async () => {
    const log = [];
    const a = session(log);
    const b = session(log);
    expect(await disposeSessions([a, b, a, null, undefined])).toBe(2);
    expect(log).toEqual(["d", "d"]);
  });

  it("keeps going when one dispose throws, and tolerates odd input", async () => {
    const log = [];
    expect(await disposeSessions([session(log, true), session(log)])).toBe(1);
    expect(log).toEqual(["d", "d"]);
    expect(await disposeSessions(null)).toBe(0);
    expect(await disposeSessions([{ pipe: {} }, {}])).toBe(0);
  });
});
