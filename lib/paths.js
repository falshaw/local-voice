// Writable locations. Nothing the app writes may live next to the code: in the
// packaged build that is app.asar (read-only). Everything goes under userData.
//
// userData is pinned to %APPDATA%\local-voice for both `npm start` and the packaged
// "Local Voice.exe" (Electron would otherwise derive it from productName and the
// installed app would start with no settings, history or models).

const fs = require("fs");
const path = require("path");

const USER_DATA_DIRNAME = "local-voice";
const MODEL_CACHE_DIRNAME = "models";

function userDataDir(appDataDir) {
  return path.join(appDataDir, USER_DATA_DIRNAME);
}

/** transformers.js cache (env.cacheDir) — Whisper + Silero VAD downloads land here. */
function modelCacheDir(userData) {
  return path.join(userData, MODEL_CACHE_DIRNAME);
}

/** The cache transformers.js used before 2026-10-19 (inside node_modules, dev only). */
function legacyCacheDir(appDir) {
  return path.join(appDir, "node_modules", "@huggingface", "transformers", ".cache");
}

function hasEntries(dir) {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch (_) {
    return false;
  }
}

/**
 * Copies the legacy node_modules cache into the userData cache once, so the
 * ~577 MB Whisper download is not repeated. Only when the target is empty and the
 * source exists; copies into `<target>.seeding` first and renames, so a crash
 * mid-copy never leaves a half cache that looks complete.
 * Returns "seeded" | "exists" | "no-source".
 */
async function seedModelCache(fromDir, toDir, fsp = fs.promises) {
  if (hasEntries(toDir)) return "exists";
  if (!hasEntries(fromDir)) return "no-source";
  const tmp = `${toDir}.seeding`;
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(toDir), { recursive: true });
  await fsp.cp(fromDir, tmp, { recursive: true });
  await fsp.rm(toDir, { recursive: true, force: true }); // an empty dir, if any
  await fsp.rename(tmp, toDir);
  return "seeded";
}

module.exports = {
  USER_DATA_DIRNAME,
  MODEL_CACHE_DIRNAME,
  userDataDir,
  modelCacheDir,
  legacyCacheDir,
  seedModelCache,
};
