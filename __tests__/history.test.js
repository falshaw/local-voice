import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { History, encodeWav16, isValidId, DEFAULT_MAX_AUDIO_BYTES } from "../lib/history.js";

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-history-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const wavs = () => fs.readdirSync(dir).filter((f) => f.endsWith(".wav")).sort();

describe("encodeWav16", () => {
  it("writes a canonical 44-byte PCM header", () => {
    const buf = encodeWav16(new Float32Array([0, 1, -1, 0.5]));
    expect(buf.length).toBe(44 + 4 * 2);
    expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buf.readUInt32LE(4)).toBe(36 + 8);
    expect(buf.toString("ascii", 8, 12)).toBe("WAVE");
    expect(buf.toString("ascii", 12, 16)).toBe("fmt ");
    expect(buf.readUInt32LE(16)).toBe(16);
    expect(buf.readUInt16LE(20)).toBe(1); // PCM
    expect(buf.readUInt16LE(22)).toBe(1); // mono
    expect(buf.readUInt32LE(24)).toBe(16000);
    expect(buf.readUInt32LE(28)).toBe(32000); // byte rate
    expect(buf.readUInt16LE(32)).toBe(2); // block align
    expect(buf.readUInt16LE(34)).toBe(16); // bits
    expect(buf.toString("ascii", 36, 40)).toBe("data");
    expect(buf.readUInt32LE(40)).toBe(8);
  });

  it("scales and clips samples to int16", () => {
    const buf = encodeWav16(new Float32Array([0, 1, -1, 0.5, 2, -2]));
    expect(buf.readInt16LE(44)).toBe(0);
    expect(buf.readInt16LE(46)).toBe(32767);
    expect(buf.readInt16LE(48)).toBe(-32768);
    expect(buf.readInt16LE(50)).toBe(16384);
    expect(buf.readInt16LE(52)).toBe(32767);
    expect(buf.readInt16LE(54)).toBe(-32768);
  });

  it("honours the sample rate argument", () => {
    const buf = encodeWav16(new Float32Array(10), 44100);
    expect(buf.readUInt32LE(24)).toBe(44100);
    expect(buf.readUInt32LE(28)).toBe(88200);
  });
});

describe("ids", () => {
  it("are 16 hex chars", () => {
    expect(isValidId("0123456789abcdef")).toBe(true);
    expect(isValidId("0123456789ABCDEF")).toBe(false);
    expect(isValidId("../../etc/passwd")).toBe(false);
    expect(isValidId("0123456789abcde")).toBe(false);
    expect(isValidId(123)).toBe(false);
  });

  it("audioPath refuses anything that is not an id", () => {
    const h = new History({ dir });
    expect(() => h.audioPath("../x")).toThrow(/Invalid/);
    expect(h.audioPath("0123456789abcdef")).toBe(path.join(dir, "0123456789abcdef.wav"));
  });
});

describe("History", () => {
  it("needs a directory", () => {
    expect(() => new History({})).toThrow(/directory/);
    expect(DEFAULT_MAX_AUDIO_BYTES).toBe(100 * 1024 * 1024);
  });

  it("adds entries newest first and persists them", () => {
    const h = new History({ dir, max: 10 }).load();
    const a = h.add({ text: "one", raw: "one um", lang: "en", mode: "raw", durationMs: 1200 });
    const b = h.add({ text: "zwei", raw: "zwei", lang: "de", mode: "formal", durationMs: "900" });
    expect(isValidId(a.id)).toBe(true);
    expect(a).toMatchObject({ text: "one", raw: "one um", lang: "en", mode: "raw", durationMs: 1200, audio: false, audioBytes: 0 });
    expect(b.durationMs).toBe(900);
    expect(h.list().map((e) => e.text)).toEqual(["zwei", "one"]);
    expect(h.get(a.id).text).toBe("one");
    expect(h.get("0000000000000000")).toBeNull();
    // list() returns copies
    h.list()[0].text = "mutated";
    expect(h.get(b.id).text).toBe("zwei");

    const again = new History({ dir, max: 10 }).load();
    expect(again.list().map((e) => e.id)).toEqual([b.id, a.id]);
  });

  it("loads an empty history from a missing or corrupt index", () => {
    expect(new History({ dir }).load().list()).toEqual([]);
    fs.writeFileSync(path.join(dir, "index.json"), "{not json");
    expect(new History({ dir }).load().list()).toEqual([]);
    fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify([{ id: "bad id", text: "x" }, { id: "0123456789abcdef", text: "ok" }]));
    expect(new History({ dir }).load().list().map((e) => e.text)).toEqual(["ok"]);
  });

  it("stores the WAV next to the index and reads it back", () => {
    const h = new History({ dir, max: 10 }).load();
    const wav = encodeWav16(new Float32Array(1600));
    const e = h.add({ text: "with audio" }, wav);
    expect(e.audio).toBe(true);
    expect(e.audioBytes).toBe(wav.length);
    expect(wavs()).toEqual([`${e.id}.wav`]);
    expect(h.readAudio(e.id).equals(wav)).toBe(true);
    const silent = h.add({ text: "no audio" }, null);
    expect(h.readAudio(silent.id)).toBeNull();
    expect(h.readAudio("0000000000000000")).toBeNull();
  });

  it("prune keeps the newest N entries and deletes their dropped WAVs", () => {
    const h = new History({ dir, max: 3 }).load();
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(h.add({ text: `t${i}` }, encodeWav16(new Float32Array(160))).id);
    expect(h.list().map((e) => e.text)).toEqual(["t4", "t3", "t2"]);
    expect(wavs()).toEqual(ids.slice(2).map((id) => `${id}.wav`).sort());
    h.setMax(1);
    expect(h.list().map((e) => e.text)).toEqual(["t4"]);
    expect(wavs()).toEqual([`${ids[4]}.wav`]);
  });

  it("prune removes orphan WAVs the index does not know", () => {
    const h = new History({ dir, max: 5 }).load();
    const kept = h.add({ text: "kept" }, encodeWav16(new Float32Array(160)));
    fs.writeFileSync(path.join(dir, "ffffffffffffffff.wav"), "orphan");
    fs.writeFileSync(path.join(dir, "junk.wav"), "orphan");
    fs.writeFileSync(path.join(dir, "notes.txt"), "left alone");
    h.prune();
    expect(wavs()).toEqual([`${kept.id}.wav`]);
    expect(fs.existsSync(path.join(dir, "notes.txt"))).toBe(true);
  });

  it("prune strips audio from older entries beyond the audio budget", () => {
    const wav = encodeWav16(new Float32Array(1000)); // 2044 bytes
    const h = new History({ dir, max: 10, maxAudioBytes: wav.length * 2 }).load();
    const a = h.add({ text: "a" }, wav);
    const b = h.add({ text: "b" }, wav);
    const c = h.add({ text: "c" }, wav);
    expect(h.get(c.id).audio).toBe(true);
    expect(h.get(b.id).audio).toBe(true);
    expect(h.get(a.id)).toMatchObject({ audio: false, audioBytes: 0 });
    expect(wavs()).toEqual([`${b.id}.wav`, `${c.id}.wav`].sort());
  });

  it("delete removes the entry and its WAV; clear empties everything", () => {
    const h = new History({ dir, max: 10 }).load();
    const a = h.add({ text: "a" }, encodeWav16(new Float32Array(160)));
    const b = h.add({ text: "b" }, encodeWav16(new Float32Array(160)));
    expect(h.delete(a.id)).toBe(true);
    expect(h.delete(a.id)).toBe(false);
    expect(h.list().map((e) => e.id)).toEqual([b.id]);
    expect(wavs()).toEqual([`${b.id}.wav`]);
    fs.writeFileSync(path.join(dir, "eeeeeeeeeeeeeeee.wav"), "orphan");
    h.clear();
    expect(h.list()).toEqual([]);
    expect(wavs()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"))).toEqual([]);
  });

  it("never leaves a half-written index (tmp + rename)", () => {
    const h = new History({ dir, max: 10 }).load();
    h.add({ text: "x" });
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
