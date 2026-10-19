// Regenerate lib/tray-icons.js — rasterizes the mic SVG to base64 PNG per state.
// nativeImage.createFromBuffer cannot decode SVG, so the tray needs real PNG bytes.
// Run: node scripts/gen-tray-icons.js   (requires sharp, already a transitive dep)
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const { micSvg } = require("./mic-glyph");

const colors = { idle: "#9ca3af", recording: "#ef4444", processing: "#d4a843" };
const size = 32; // 2x for crisp hiDPI tray rendering

const svg = (color) => micSvg(color, size);

(async () => {
  const out = {};
  for (const [state, color] of Object.entries(colors)) {
    out[state] = (await sharp(svg(color)).png().toBuffer()).toString("base64");
  }
  const body =
    "// Auto-generated PNG tray icons (mic glyph, 32x32) for idle/recording/processing.\n" +
    "// Regenerate with: node scripts/gen-tray-icons.js\n" +
    "// PNG (not SVG) because nativeImage.createFromBuffer does not decode SVG.\n" +
    "module.exports = {\n" +
    Object.entries(out)
      .map(([k, v]) => `  ${k}: "${v}",`)
      .join("\n") +
    "\n};\n";
  fs.writeFileSync(path.join(__dirname, "..", "lib", "tray-icons.js"), body);
  console.log("Wrote lib/tray-icons.js");
})();
