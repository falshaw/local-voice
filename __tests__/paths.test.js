import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { userDataDir, modelCacheDir, legacyCacheDir, seedModelCache } = require("../lib/paths");

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-paths-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("paths", () => {
  it("pins userData to <appData>/local-voice and the cache under it", () => {
    expect(userDataDir("C:/A")).toBe(path.join("C:/A", "local-voice"));
    expect(modelCacheDir("C:/A/local-voice")).toBe(path.join("C:/A/local-voice", "models"));
    expect(legacyCacheDir("/opt/app")).toBe(path.join("/opt/app", "node_modules", "@huggingface", "transformers", ".cache"));
  });

  it("seeds an empty target from the legacy cache", async () => {
    const from = path.join(root, "legacy");
    const to = path.join(root, "ud", "models");
    fs.mkdirSync(path.join(from, "onnx-community", "whisper-small"), { recursive: true });
    fs.writeFileSync(path.join(from, "onnx-community", "whisper-small", "config.json"), "{}");
    expect(await seedModelCache(from, to)).toBe("seeded");
    expect(fs.readFileSync(path.join(to, "onnx-community", "whisper-small", "config.json"), "utf8")).toBe("{}");
    expect(fs.existsSync(`${to}.seeding`)).toBe(false);
    // Source untouched (copy, not move).
    expect(fs.existsSync(path.join(from, "onnx-community"))).toBe(true);
  });

  it("never overwrites a non-empty target", async () => {
    const from = path.join(root, "legacy");
    const to = path.join(root, "models");
    fs.mkdirSync(from);
    fs.writeFileSync(path.join(from, "a"), "old");
    fs.mkdirSync(to);
    fs.writeFileSync(path.join(to, "b"), "mine");
    expect(await seedModelCache(from, to)).toBe("exists");
    expect(fs.readdirSync(to)).toEqual(["b"]);
  });

  it("does nothing without a source (packaged app)", async () => {
    const to = path.join(root, "models");
    expect(await seedModelCache(path.join(root, "missing"), to)).toBe("no-source");
    expect(fs.existsSync(to)).toBe(false);
  });

  it("an empty target dir is replaced by the seed", async () => {
    const from = path.join(root, "legacy");
    const to = path.join(root, "models");
    fs.mkdirSync(from);
    fs.writeFileSync(path.join(from, "a"), "x");
    fs.mkdirSync(to);
    expect(await seedModelCache(from, to)).toBe("seeded");
    expect(fs.readdirSync(to)).toEqual(["a"]);
  });
});
