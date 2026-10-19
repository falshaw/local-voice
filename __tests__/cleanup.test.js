import { describe, it, expect, vi } from "vitest";
import { cleanupText, passesGate, numPredict, loadPrompt } from "../lib/cleanup.js";
import { OLLAMA_URL, CLEANUP_MODEL, listLoaded, isModelLoaded, vramHeld, gpuBusy, VRAM_LIMIT_BYTES } from "../lib/ollama.js";

const INPUT = "um so the firewall change is uh scheduled for monday at nine";
const CLEAN = "So the firewall change is scheduled for Monday at nine.";

function res(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** fetch mock: `ps` and `gen` are responses or functions (url, init) → response. */
function mockFetch({ ps = res(200, { models: [{ name: "gemma4:31b" }] }), gen = res(200, { response: CLEAN }) } = {}) {
  const calls = [];
  const f = vi.fn(async (url, init) => {
    calls.push({ url, init });
    const pick = url.endsWith("/api/ps") ? ps : url.endsWith("/api/generate") ? gen : res(404, {});
    const r = typeof pick === "function" ? pick(url, init) : pick;
    if (r instanceof Error) throw r;
    return r;
  });
  f.calls = calls;
  return f;
}

describe("constants", () => {
  it("model and URL are hard-coded to the laptop", () => {
    expect(OLLAMA_URL).toBe("http://127.0.0.1:11434");
    expect(CLEANUP_MODEL).toBe("gemma4:31b");
    expect(VRAM_LIMIT_BYTES).toBe(5.5 * 1024 ** 3);
  });
});

describe("cleanupText success", () => {
  it("sends the planned request and applies the cleaned text", async () => {
    const fetchImpl = mockFetch();
    const r = await cleanupText(INPUT, { mode: "formal", timeoutMs: 5000, fetchImpl });
    expect(r).toEqual({ text: CLEAN, applied: true, reason: "ok" });
    expect(fetchImpl.calls.map((c) => c.url)).toEqual([`${OLLAMA_URL}/api/ps`, `${OLLAMA_URL}/api/generate`]);
    const gen = fetchImpl.calls[1].init;
    expect(gen.method).toBe("POST");
    expect(gen.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(gen.body);
    expect(body).toMatchObject({
      model: "gemma4:31b",
      prompt: INPUT,
      stream: false,
      think: false,
      keep_alive: "10m",
      options: { temperature: 0, num_predict: numPredict(INPUT) },
    });
    expect(body.system).toBe(loadPrompt("formal"));
  });

  it("skips /api/ps when onlyIfLoaded is false", async () => {
    const fetchImpl = mockFetch();
    const r = await cleanupText(INPUT, { onlyIfLoaded: false, fetchImpl });
    expect(r.applied).toBe(true);
    expect(fetchImpl.calls.map((c) => c.url)).toEqual([`${OLLAMA_URL}/api/generate`]);
  });

  it("uses a caller-supplied system prompt verbatim", async () => {
    const fetchImpl = mockFetch();
    await cleanupText(INPUT, { onlyIfLoaded: false, fetchImpl, system: "custom" });
    expect(JSON.parse(fetchImpl.calls[0].init.body).system).toBe("custom");
  });

  it("empty input is returned as-is without any request", async () => {
    const fetchImpl = mockFetch();
    expect(await cleanupText("   ", { fetchImpl })).toEqual({ text: "", applied: false, reason: "empty" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("cleanupText failure modes keep the raw text", () => {
  it("timeout → raw (AbortController)", async () => {
    const gen = (url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    const fetchImpl = mockFetch({ gen });
    const r = await cleanupText(INPUT, { timeoutMs: 50, fetchImpl });
    expect(r).toEqual({ text: INPUT, applied: false, reason: "timeout" });
  });

  it("HTTP 500 → raw", async () => {
    const fetchImpl = mockFetch({ gen: res(500, { error: "boom" }) });
    expect(await cleanupText(INPUT, { fetchImpl })).toEqual({ text: INPUT, applied: false, reason: "error" });
  });

  it("network error → raw", async () => {
    const fetchImpl = mockFetch({ gen: () => new Error("ECONNREFUSED") });
    expect(await cleanupText(INPUT, { fetchImpl })).toEqual({ text: INPUT, applied: false, reason: "error" });
  });

  it("gate rejects empty, chatty and badly sized output", async () => {
    for (const bad of ["", "Here is the cleaned text: " + CLEAN, "ok", CLEAN.repeat(3)]) {
      const fetchImpl = mockFetch({ gen: res(200, { response: bad }) });
      expect(await cleanupText(INPUT, { fetchImpl })).toEqual({ text: INPUT, applied: false, reason: "gate" });
    }
    const fetchImpl = mockFetch({ gen: res(200, { nope: true }) });
    expect(await cleanupText(INPUT, { fetchImpl })).toEqual({ text: INPUT, applied: false, reason: "gate" });
  });

  it("gemma4 not resident → raw, no generate call (cold-load guard)", async () => {
    const fetchImpl = mockFetch({ ps: res(200, { models: [{ name: "qwen2.5vl:7b" }] }) });
    expect(await cleanupText(INPUT, { fetchImpl })).toEqual({ text: INPUT, applied: false, reason: "not-loaded" });
    expect(fetchImpl.calls).toHaveLength(1);
    const empty = mockFetch({ ps: res(200, { models: [] }) });
    expect((await cleanupText(INPUT, { fetchImpl: empty })).reason).toBe("not-loaded");
  });

  it("Ollama unreachable → raw, no generate call", async () => {
    const fetchImpl = mockFetch({ ps: () => new Error("ECONNREFUSED") });
    expect(await cleanupText(INPUT, { fetchImpl })).toEqual({ text: INPUT, applied: false, reason: "ollama-unreachable" });
    expect(fetchImpl.calls).toHaveLength(1);
  });
});

describe("passesGate", () => {
  it("0.5–1.6× the input, non-empty, not starting with Here", () => {
    expect(passesGate("1234567890", "12345")).toBe(true);
    expect(passesGate("1234567890", "1234")).toBe(false);
    expect(passesGate("1234567890", "1234567890123456")).toBe(true);
    expect(passesGate("1234567890", "12345678901234567")).toBe(false);
    expect(passesGate("abc", "")).toBe(false);
    expect(passesGate("abc", "   ")).toBe(false);
    expect(passesGate("abc", null)).toBe(false);
    expect(passesGate("hello world", "Here you go")).toBe(false);
    expect(passesGate("hello world", "here: hi")).toBe(false);
    expect(passesGate("hello world", "Hereford")).toBe(true);
  });
});

describe("numPredict", () => {
  it("≈ 1.5× the input tokens + 32", () => {
    expect(numPredict("")).toBe(32);
    expect(numPredict("x".repeat(400))).toBe(182);
    expect(numPredict("hello world um this is a test")).toBe(43);
  });
});

describe("prompts", () => {
  it("one file per mode, unknown mode → raw, each demands the text only and no translation", () => {
    const raw = loadPrompt("raw");
    const formal = loadPrompt("formal");
    const code = loadPrompt("code");
    expect(loadPrompt("bogus")).toBe(raw);
    expect(loadPrompt(undefined)).toBe(raw);
    for (const p of [raw, formal, code]) {
      expect(p).toMatch(/Do not translate/);
      expect(p).toMatch(/cleaned text only/);
    }
    expect(new Set([raw, formal, code]).size).toBe(3);
  });
});

describe("ollama helpers", () => {
  it("listLoaded returns the models array or null when unreachable", async () => {
    expect(await listLoaded(mockFetch(), 100)).toEqual([{ name: "gemma4:31b" }]);
    expect(await listLoaded(mockFetch({ ps: res(200, {}) }), 100)).toEqual([]);
    expect(await listLoaded(mockFetch({ ps: () => new Error("down") }), 100)).toBeNull();
    expect(await listLoaded(mockFetch({ ps: res(503, {}) }), 100)).toBeNull();
  });

  it("isModelLoaded matches name or model", () => {
    expect(isModelLoaded([{ name: "gemma4:31b" }])).toBe(true);
    expect(isModelLoaded([{ model: "gemma4:31b" }])).toBe(true);
    expect(isModelLoaded([{ name: "gemma4:latest" }])).toBe(false);
    expect(isModelLoaded(null)).toBe(false);
    expect(isModelLoaded([{ name: "x" }], "x")).toBe(true);
  });

  it("gpuBusy above 5.5 GB of resident VRAM", () => {
    const gib = 1024 ** 3;
    expect(vramHeld([{ size_vram: 2 * gib }, { size_vram: 3 * gib }])).toBe(5 * gib);
    expect(vramHeld(null)).toBe(0);
    expect(gpuBusy([{ size_vram: 5.5 * gib }])).toBe(false);
    expect(gpuBusy([{ size_vram: 5.5 * gib + 1 }])).toBe(true);
    expect(gpuBusy([{ size_vram: 7 * gib }])).toBe(true);
    expect(gpuBusy([])).toBe(false);
    expect(gpuBusy([{ size_vram: 2 * gib }], 1 * gib)).toBe(true);
  });
});
