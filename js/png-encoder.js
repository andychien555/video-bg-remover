// ── Transparent PNG encoder (UPNG.js) ──────────────────────
// The native canvas `toBlob('image/png')` writes an UNOPTIMISED PNG (fixed
// filter + a quick zlib pass). UPNG.js re-encodes with per-line filter
// selection and its own deflate, so even the lossless path comes out smaller.
//
// Two modes, both keep the alpha channel:
//   • lossless (colors = 0) — exact pixels, just better-packed. Smaller than
//     the browser's PNG, no quality loss.
//   • lossy (colors = N)    — quantise to ≤ N RGBA colours (median-cut in 4D,
//     so per-pixel alpha survives into the PLTE+tRNS chunks). Much smaller;
//     gradients/soft shadows may band, which the optional dither smooths.
//
// UPNG + pako are loaded as classic <script>s (window.UPNG / window.pako),
// matching how jszip is vendored — so we read them off window at call time.

function getUPNG() {
  const UPNG = window.UPNG;
  if (!UPNG) throw new Error('UPNG 編碼器未載入');
  return UPNG;
}

// UPNG.quantize works in PREMULTIPLIED space (alphaMul multiplies RGB by a/255
// before clustering), so every palette entry's RGB is premultiplied. To dither
// and emit straight-alpha pixels we undo that: straight = premult * 255 / a.
function paletteFrom(quantResult) {
  return quantResult.plte.map(node => {
    const c = node.est.rgba; // packed little-endian RGBA
    let r = c & 255, g = (c >> 8) & 255, b = (c >> 16) & 255, a = (c >>> 24) & 255;
    if (a > 0 && a < 255) {
      const inv = 255 / a;
      r = Math.min(255, Math.round(r * inv));
      g = Math.min(255, Math.round(g * inv));
      b = Math.min(255, Math.round(b * inv));
    }
    return [r, g, b, a];
  });
}

// Nearest palette entry in straight RGBA (squared-Euclidean), cached per exact
// colour — bg-removed stills have large flat runs, so the cache pays off.
function nearestIndex(palette, r, g, b, a, cache) {
  const key = (r << 24 | g << 16 | b << 8 | a) >>> 0;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let best = 0, bd = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const dr = r - p[0], dg = g - p[1], db = b - p[2], da = a - p[3];
    const d = dr * dr + dg * dg + db * db + da * da;
    if (d < bd) { bd = d; best = i; }
  }
  cache.set(key, best);
  return best;
}

// Remap every pixel to the palette with Floyd–Steinberg error diffusion over a
// float copy (R,G,B,A all diffused, since palette entries carry alpha). Returns
// a straight-alpha RGBA buffer containing only palette colours, so a follow-up
// lossless UPNG.encode collapses it to a small PLTE+tRNS image.
function ditherToPalette(rgba, w, h, palette) {
  const n = w * h;
  const work = Float32Array.from(rgba);
  const out = new Uint8Array(n * 4);
  const cache = new Map();
  const push = (idx, er, eg, eb, ea, f) => {
    work[idx] += er * f; work[idx + 1] += eg * f;
    work[idx + 2] += eb * f; work[idx + 3] += ea * f;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = (y * w + x) * 4;
      const r = Math.max(0, Math.min(255, work[t] | 0));
      const g = Math.max(0, Math.min(255, work[t + 1] | 0));
      const b = Math.max(0, Math.min(255, work[t + 2] | 0));
      const a = Math.max(0, Math.min(255, work[t + 3] | 0));
      const p = palette[nearestIndex(palette, r, g, b, a, cache)];
      out[t] = p[0]; out[t + 1] = p[1]; out[t + 2] = p[2]; out[t + 3] = p[3];
      const er = r - p[0], eg = g - p[1], eb = b - p[2], ea = a - p[3];
      if (x + 1 < w) push(t + 4, er, eg, eb, ea, 7 / 16);
      if (y + 1 < h) {
        const d = t + w * 4;
        if (x > 0)     push(d - 4, er, eg, eb, ea, 3 / 16);
        push(d, er, eg, eb, ea, 5 / 16);
        if (x + 1 < w) push(d + 4, er, eg, eb, ea, 1 / 16);
      }
    }
  }
  return out;
}

// Core: ImageData → optimised PNG ArrayBuffer.
function encodeBuffer(imageData, opts) {
  const UPNG = getUPNG();
  const { width: w, height: h, data } = imageData;
  const lossy = opts.mode === 'lossy';
  if (!lossy) return UPNG.encode([data.buffer], w, h, 0); // lossless, exact

  const colors = Math.max(2, Math.min(256, opts.colors | 0 || 256));
  if (!opts.dither) return UPNG.encode([data.buffer], w, h, colors);

  // Dither: derive UPNG's palette, diffuse against it, then store losslessly.
  const palette = paletteFrom(UPNG.quantize([data.buffer.slice(0)], colors, false));
  const dithered = ditherToPalette(data, w, h, palette);
  return UPNG.encode([dithered.buffer], w, h, 0);
}

/**
 * Encode keyed ImageData to a transparent PNG blob.
 * @param {ImageData} imageData
 * @param {{mode:'lossless'|'lossy', colors?:number, dither?:boolean}} opts
 * @returns {Blob}
 */
export function encodePng(imageData, opts = {}) {
  return new Blob([encodeBuffer(imageData, opts)], { type: 'image/png' });
}

/**
 * Byte size of the PNG at the given settings, without building a Blob.
 * (A single still encodes fast enough to size the real thing.)
 * @returns {number} bytes
 */
export function estimatePngBytes(imageData, opts = {}) {
  return encodeBuffer(imageData, opts).byteLength;
}
