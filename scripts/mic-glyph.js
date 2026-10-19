// The mic glyph shared by the tray icons (scripts/gen-tray-icons.js) and the
// app/installer icon (scripts/gen-app-icon.js). 16-unit viewBox, any pixel size.
function micSvg(color, size) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16">` +
      `<circle cx="8" cy="8" r="6" fill="${color}"/>` +
      `<circle cx="8" cy="5" r="2" fill="#fff"/>` +
      `<rect x="6.5" y="5" width="3" height="4" rx="1" fill="#fff"/>` +
      `<rect x="7.25" y="9.5" width="1.5" height="1.5" fill="#fff"/>` +
      `<rect x="6" y="10.5" width="4" height="1" rx="0.5" fill="#fff"/>` +
      `</svg>`,
  );
}

module.exports = { micSvg };
