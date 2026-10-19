// Generates build/icon.ico (app exe + installer + shortcuts) from the tray mic glyph,
// in the "recording" red so it reads as the app, not the grey idle state.
// Run: node scripts/gen-app-icon.js   (sharp, already installed)
// ICO = header + directory + PNG-compressed images (Vista+ format), sizes 16–256.
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const { micSvg } = require("./mic-glyph");

const COLOR = "#ef4444";
const SIZES = [16, 24, 32, 48, 64, 128, 256];

(async () => {
  const images = [];
  for (const s of SIZES) images.push(await sharp(micSvg(COLOR, s)).png().toBuffer());
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = header.length + dir.length;
  images.forEach((img, i) => {
    const s = SIZES[i];
    const e = i * 16;
    dir.writeUInt8(s >= 256 ? 0 : s, e); // 0 means 256
    dir.writeUInt8(s >= 256 ? 0 : s, e + 1);
    dir.writeUInt8(0, e + 2); // palette
    dir.writeUInt8(0, e + 3);
    dir.writeUInt16LE(1, e + 4); // planes
    dir.writeUInt16LE(32, e + 6); // bpp
    dir.writeUInt32LE(img.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += img.length;
  });
  const out = path.join(__dirname, "..", "build", "icon.ico");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const ico = Buffer.concat([header, dir, ...images]);
  fs.writeFileSync(`${out}.tmp`, ico);
  fs.renameSync(`${out}.tmp`, out);
  console.log(`Wrote ${out} (${ico.length} bytes, ${SIZES.join("/")} px)`);
})();
