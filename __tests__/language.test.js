import { describe, it, expect } from "vitest";
import {
  CANDIDATES,
  resolveJobLanguage,
  toWorkerLanguage,
  pickLanguage,
  detectLanguage,
} from "../lib/language.js";

describe("hotkey → language map", () => {
  it("uses the hotkey's own language when it has one (hotkey2 → hotkey2Language)", () => {
    expect(resolveJobLanguage("de", "en")).toBe("de");
    expect(resolveJobLanguage("en", "de")).toBe("en");
    expect(resolveJobLanguage("auto", "en")).toBe("auto");
  });

  it("falls back to the global setting for the primary hotkey", () => {
    expect(resolveJobLanguage(null, "en")).toBe("en");
    expect(resolveJobLanguage(null, "de")).toBe("de");
    expect(resolveJobLanguage(null, "auto")).toBe("auto");
    expect(resolveJobLanguage(undefined, "de")).toBe("de");
  });

  it("anything unknown is English", () => {
    expect(resolveJobLanguage(null, "klingon")).toBe("en");
    expect(resolveJobLanguage("fr", "de")).toBe("en");
    expect(resolveJobLanguage(null, undefined)).toBe("en");
  });

  it("auto is sent to the worker as null (= detect), never as a string", () => {
    expect(toWorkerLanguage("auto")).toBeNull();
    expect(toWorkerLanguage("de")).toBe("de");
    expect(toWorkerLanguage("en")).toBe("en");
    expect(toWorkerLanguage(undefined)).toBe("en");
  });
});

describe("pickLanguage", () => {
  it("only knows EN and DE", () => {
    expect(CANDIDATES).toEqual(["en", "de"]);
  });

  it("picks the highest score, ties and junk go to en", () => {
    expect(pickLanguage({ en: 1.0, de: 2.5 })).toBe("de");
    expect(pickLanguage({ en: 3.0, de: 2.5 })).toBe("en");
    expect(pickLanguage({ en: 2.0, de: 2.0 })).toBe("en");
    expect(pickLanguage({ de: 5 })).toBe("de");
    expect(pickLanguage({ de: NaN, en: -Infinity })).toBe("en");
    expect(pickLanguage({})).toBe("en");
    expect(pickLanguage(null)).toBe("en");
    expect(pickLanguage({ fr: 99, de: 1 })).toBe("de");
  });

  it("respects a custom candidate list", () => {
    expect(pickLanguage({ fr: 9, de: 1 }, ["fr", "de"])).toBe("fr");
  });
});

// transformers.js 4.3.1 does NOT detect: `language: null` → "<|en|>" with a warning
// (src/models/whisper/modeling_whisper.js "TODO: Implement language detection").
// detectLanguage runs one decoder step after <|startoftranscript|> and compares the
// logits of <|en|> and <|de|>.
function fakePipe({ en, de, lang2id = { "<|en|>": 3, "<|de|>": 5 }, start = 7 } = {}) {
  const calls = { processor: [], model: [] };
  const logits = new Float32Array(10);
  logits[3] = en;
  logits[5] = de;
  const model = async (inputs) => {
    calls.model.push(inputs);
    return { logits: { data: logits, dims: [1, 1, 10] } };
  };
  model.generation_config = { lang_to_id: lang2id, decoder_start_token_id: start };
  const pipe = {
    processor: async (audio) => {
      calls.processor.push(audio);
      return { input_features: "FEATS" };
    },
    model,
  };
  return { pipe, calls };
}

class FakeTensor {
  constructor(type, data, dims) {
    this.type = type;
    this.data = data;
    this.dims = dims;
  }
}
const T = { Tensor: FakeTensor };

describe("detectLanguage", () => {
  it("returns de when the <|de|> logit is higher", async () => {
    const { pipe, calls } = fakePipe({ en: 1, de: 4 });
    const audio = new Float32Array(16000);
    expect(await detectLanguage(T, pipe, audio)).toBe("de");
    expect(calls.processor[0]).toBe(audio);
    const inputs = calls.model[0];
    expect(inputs.input_features).toBe("FEATS");
    expect(inputs.decoder_input_ids).toBeInstanceOf(FakeTensor);
    expect(inputs.decoder_input_ids.type).toBe("int64");
    expect(inputs.decoder_input_ids.dims).toEqual([1, 1]);
    expect(Array.from(inputs.decoder_input_ids.data)).toEqual([7n]);
  });

  it("returns en when the <|en|> logit is higher", async () => {
    const { pipe } = fakePipe({ en: 4, de: 1 });
    expect(await detectLanguage(T, pipe, new Float32Array(16000))).toBe("en");
  });

  it("falls back to en without touching the model when the config lacks lang_to_id", async () => {
    const { pipe, calls } = fakePipe({ en: 1, de: 4, lang2id: null });
    expect(await detectLanguage(T, pipe, new Float32Array(16000))).toBe("en");
    expect(calls.model).toHaveLength(0);
  });

  it("ignores a candidate missing from lang_to_id", async () => {
    const { pipe } = fakePipe({ en: 1, de: 4, lang2id: { "<|en|>": 3 } });
    expect(await detectLanguage(T, pipe, new Float32Array(16000))).toBe("en");
  });
});
