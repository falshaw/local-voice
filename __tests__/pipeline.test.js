import { describe, it, expect, vi } from "vitest";
import { postprocess } from "../lib/pipeline.js";

const dict = [
  { from: "pan", to: "Palo Alto", modes: [] },
  { from: "vpn", to: "vpn tunnel", modes: [] },
  { from: "ssh", to: "SSH", modes: ["code"] },
];

describe("postprocess", () => {
  it("trims and applies the dictionary without cleanup", async () => {
    expect(await postprocess("  the pan box and ssh  ", { mode: "raw", dictionary: dict })).toEqual({
      text: "the Palo Alto box and ssh",
      cleaned: false,
    });
    expect(await postprocess("the pan box and ssh", { mode: "code", dictionary: dict })).toEqual({
      text: "the Palo Alto box and SSH",
      cleaned: false,
    });
  });

  it("dictionaryEnabled=false leaves the words alone", async () => {
    expect((await postprocess("pan", { dictionary: dict, dictionaryEnabled: false })).text).toBe("pan");
  });

  it("empty input short-circuits", async () => {
    const cleanup = vi.fn();
    expect(await postprocess("   ", { dictionary: dict, cleanup })).toEqual({ text: "", cleaned: false });
    expect(await postprocess(null, { cleanup })).toEqual({ text: "", cleaned: false });
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("runs dictionary → cleanup → dictionary, so the LLM cannot undo a term", async () => {
    // The LLM "corrects" the term back to the spoken word; the second pass restores it.
    const cleanup = vi.fn(async (t) => ({ text: t.replace("Palo Alto", "PAN") + ".", applied: true }));
    const r = await postprocess("um the pan box", { dictionary: dict, cleanup });
    expect(cleanup).toHaveBeenCalledWith("um the Palo Alto box");
    expect(r).toEqual({ text: "um the Palo Alto box.", cleaned: true });
  });

  it("the second dictionary pass is idempotent", async () => {
    const cleanup = vi.fn(async (t) => ({ text: t, applied: true }));
    const r = await postprocess("the vpn", { dictionary: dict, cleanup });
    expect(r.text).toBe("the vpn tunnel");
  });

  it("cleanup not applied / empty / throwing → raw stays, cleaned=false", async () => {
    expect(await postprocess("pan", { dictionary: dict, cleanup: async () => ({ text: "x", applied: false }) })).toEqual({
      text: "Palo Alto",
      cleaned: false,
    });
    expect(await postprocess("pan", { dictionary: dict, cleanup: async () => ({ text: "   ", applied: true }) })).toEqual({
      text: "Palo Alto",
      cleaned: false,
    });
    expect(await postprocess("pan", { dictionary: dict, cleanup: async () => null })).toEqual({ text: "Palo Alto", cleaned: false });
    expect(
      await postprocess("pan", {
        dictionary: dict,
        cleanup: async () => {
          throw new Error("ollama down");
        },
      }),
    ).toEqual({ text: "Palo Alto", cleaned: false });
  });
});
