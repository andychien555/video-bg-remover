// ── Animated GIF encoder ───────────────────────────────────
// In-browser GIF89a encoder, written from scratch (no external deps) to stay
// consistent with the hand-rolled WebP muxer in webp-anim.js. Pipeline per
// frame: resolve transparency → median-cut quantize to ≤256 colours → optional
// Floyd–Steinberg dither → LZW compress → emit one GIF89a frame with a local
// colour table. Frames share a Netscape loop block so the result loops forever.
//
// GIF caveat (important for a matting tool): GIF transparency is 1-bit — a pixel
// is either fully opaque or fully transparent, there is no partial alpha. So a
// feathered key edge can't stay semi-transparent here:
//   • transparent mode → alpha is hard-thresholded; soft edges become a hard
//     cut, softened a little by dithering the colour (not the alpha).
//   • matte mode       → every pixel is composited over a solid colour, so the
//     output is fully opaque but the soft edge stays smooth.
//
// Spec: https://www.w3.org/Graphics/GIF/spec-gif89a.txt

// ── LZW (GIF variant) ──────────────────────────────────────
// Variable-width codes starting at minCodeSize+1 bits, with a Clear code and an
// End-of-Information code. Returns the packed LZW byte stream (no sub-block
// framing — assembleImageData adds the 255-byte sub-blocks).
function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let dict = new Map();

  const out = [];
  let cur = 0;     // bit accumulator
  let curBits = 0; // bits currently in the accumulator
  const emit = code => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) { out.push(cur & 0xff); cur >>= 8; curBits -= 8; }
  };

  const resetDict = () => {
    dict = new Map();
    codeSize = minCodeSize + 1;
    nextCode = eoiCode + 1;
  };

  emit(clearCode);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 4096 + k; // 12-bit max → fits in a JS number key
    const code = dict.get(key);
    if (code !== undefined) {
      prefix = code;
    } else {
      emit(prefix);
      dict.set(key, nextCode);
      if (nextCode === (1 << codeSize) && codeSize < 12) codeSize++;
      nextCode++;
      if (nextCode > 4095) { emit(clearCode); resetDict(); }
      prefix = k;
    }
  }
  emit(prefix);
  emit(eoiCode);
  if (curBits > 0) out.push(cur & 0xff);
  return out;
}

// Append every element of src onto dst. Used instead of dst.push(...src) because
// spreading a frame-sized array as call arguments overflows the stack.
function appendAll(dst, src) { for (let i = 0; i < src.length; i++) dst.push(src[i]); }

// Write GIF image data into `out`: a leading minCodeSize byte, then 255-byte
// sub-blocks (each prefixed by its length), then a 0 terminator.
function writeImageData(out, lzwBytes, minCodeSize) {
  out.push(minCodeSize);
  for (let i = 0; i < lzwBytes.length; i += 255) {
    const len = Math.min(255, lzwBytes.length - i);
    out.push(len);
    for (let j = 0; j < len; j++) out.push(lzwBytes[i + j]);
  }
  out.push(0);
}

// ── Median-cut colour quantization ─────────────────────────
// Build a palette of ≤ maxColors RGB entries from a sample of opaque pixels.
// Works on a histogram of unique colours (with weights) so the box statistics
// stay cheap; boxes are split along their widest channel at the weighted median.
function medianCut(hist, maxColors) {
  // hist: Map<packedRGB, count>. Materialise into parallel arrays once.
  const colors = [];
  for (const [packed, count] of hist) {
    colors.push({ r: (packed >> 16) & 0xff, g: (packed >> 8) & 0xff, b: packed & 0xff, n: count });
  }
  if (colors.length <= maxColors) {
    return colors.map(c => [c.r, c.g, c.b]);
  }

  const boxOf = list => {
    let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
    for (const c of list) {
      if (c.r < rmin) rmin = c.r; if (c.r > rmax) rmax = c.r;
      if (c.g < gmin) gmin = c.g; if (c.g > gmax) gmax = c.g;
      if (c.b < bmin) bmin = c.b; if (c.b > bmax) bmax = c.b;
    }
    return { list, rmin, rmax, gmin, gmax, bmin, bmax,
             range: Math.max(rmax - rmin, gmax - gmin, bmax - bmin) };
  };

  let boxes = [boxOf(colors)];
  while (boxes.length < maxColors) {
    // Split the box with the widest channel that still has >1 colour.
    let target = -1, best = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].list.length > 1 && boxes[i].range > best) { best = boxes[i].range; target = i; }
    }
    if (target < 0) break; // every box is a single colour
    const box = boxes[target];
    const dr = box.rmax - box.rmin, dg = box.gmax - box.gmin, db = box.bmax - box.bmin;
    const ch = dr >= dg && dr >= db ? 'r' : dg >= db ? 'g' : 'b';
    box.list.sort((a, b) => a[ch] - b[ch]);
    // Split at the weighted median so each half holds ~half the pixels.
    const half = box.list.reduce((s, c) => s + c.n, 0) / 2;
    let acc = 0, cut = 1;
    for (; cut < box.list.length; cut++) { acc += box.list[cut - 1].n; if (acc >= half) break; }
    const left = box.list.slice(0, cut), right = box.list.slice(cut);
    boxes.splice(target, 1, boxOf(left), boxOf(right));
  }

  // Each box → its pixel-weighted average colour.
  return boxes.map(box => {
    let r = 0, g = 0, b = 0, n = 0;
    for (const c of box.list) { r += c.r * c.n; g += c.g * c.n; b += c.b * c.n; n += c.n; }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  });
}

// Nearest palette entry to (r,g,b), squared-Euclidean. Cached per exact colour.
function nearestIndex(palette, r, g, b, cache) {
  const key = (r << 16) | (g << 8) | b;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const dr = r - p[0], dg = g - p[1], db = b - p[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = i; if (d === 0) break; }
  }
  cache.set(key, best);
  return best;
}

// ── Per-frame quantization ─────────────────────────────────
// Turn one RGBA frame into { indices, palette, transparentIndex }.
//   • transparent mode: pixels with alpha < alphaThreshold map to a reserved
//     transparent index; the rest are quantized by RGB.
//   • matte mode: every pixel is composited over `matte` first → fully opaque.
function quantizeFrame(rgba, w, h, opts) {
  const { transparent, matte, dither, alphaThreshold } = opts;
  const n = w * h;
  // Working RGB buffer (matte-composited if needed) + an opacity mask.
  const rgb = new Uint8Array(n * 3);
  const opaque = new Uint8Array(n); // 1 = drawn, 0 = transparent (transparent mode only)
  const [mr, mg, mb] = matte;
  for (let i = 0; i < n; i++) {
    const s = i * 4, a = rgba[s + 3];
    if (transparent) {
      if (a < alphaThreshold) { opaque[i] = 0; continue; }
      opaque[i] = 1;
      rgb[i * 3] = rgba[s]; rgb[i * 3 + 1] = rgba[s + 1]; rgb[i * 3 + 2] = rgba[s + 2];
    } else {
      // composite src over matte by alpha
      const af = a / 255, ia = 1 - af;
      opaque[i] = 1;
      rgb[i * 3]     = Math.round(rgba[s]     * af + mr * ia);
      rgb[i * 3 + 1] = Math.round(rgba[s + 1] * af + mg * ia);
      rgb[i * 3 + 2] = Math.round(rgba[s + 2] * af + mb * ia);
    }
  }

  // Histogram over opaque pixels (sampled for speed on large frames). The stride
  // keeps palette construction near-constant-time; every pixel is still mapped.
  const hist = new Map();
  const stride = Math.max(1, Math.floor(n / 65536));
  for (let i = 0; i < n; i += stride) {
    if (!opaque[i]) continue;
    const packed = (rgb[i * 3] << 16) | (rgb[i * 3 + 1] << 8) | rgb[i * 3 + 2];
    hist.set(packed, (hist.get(packed) || 0) + 1);
  }

  const maxColors = transparent ? 255 : 256; // reserve one slot for transparency
  let palette = hist.size ? medianCut(hist, maxColors) : [[0, 0, 0]];

  // Reserve the transparent slot as the last entry (a flat colour; never shown).
  let transparentIndex = -1;
  if (transparent) { transparentIndex = palette.length; palette = [...palette, [0, 0, 0]]; }

  const indices = new Uint8Array(n);
  const cache = new Map();
  if (dither) {
    // Floyd–Steinberg over a float copy of the RGB plane.
    const buf = Float32Array.from(rgb);
    const push = (idx, er, eg, eb, f) => {
      buf[idx] += er * f; buf[idx + 1] += eg * f; buf[idx + 2] += eb * f;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, t = i * 3;
        if (transparent && !opaque[i]) { indices[i] = transparentIndex; continue; }
        const r = Math.max(0, Math.min(255, buf[t]   | 0));
        const g = Math.max(0, Math.min(255, buf[t + 1] | 0));
        const b = Math.max(0, Math.min(255, buf[t + 2] | 0));
        const pi = nearestIndex(palette, r, g, b, cache);
        indices[i] = pi;
        const p = palette[pi];
        const er = r - p[0], eg = g - p[1], eb = b - p[2];
        // Diffuse only into opaque neighbours (don't bleed colour into holes).
        if (x + 1 < w && (!transparent || opaque[i + 1])) push(t + 3, er, eg, eb, 7 / 16);
        if (y + 1 < h) {
          const d = t + w * 3;
          if (x > 0 && (!transparent || opaque[i + w - 1])) push(d - 3, er, eg, eb, 3 / 16);
          if (!transparent || opaque[i + w]) push(d, er, eg, eb, 5 / 16);
          if (x + 1 < w && (!transparent || opaque[i + w + 1])) push(d + 3, er, eg, eb, 1 / 16);
        }
      }
    }
  } else {
    for (let i = 0; i < n; i++) {
      if (transparent && !opaque[i]) { indices[i] = transparentIndex; continue; }
      indices[i] = nearestIndex(palette, rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], cache);
    }
  }

  return { indices, palette, transparentIndex };
}

// ── GIF89a container assembly ──────────────────────────────
function u16le(n) { return [n & 0xff, (n >> 8) & 0xff]; }

// Pad a palette to the next power-of-two table size (2..256) and flatten to RGB.
function buildColorTable(palette) {
  let size = 2;
  while (size < palette.length) size <<= 1;
  const bytes = new Uint8Array(size * 3);
  for (let i = 0; i < palette.length; i++) {
    bytes[i * 3] = palette[i][0]; bytes[i * 3 + 1] = palette[i][1]; bytes[i * 3 + 2] = palette[i][2];
  }
  // log2(size) - 1 → the 3-bit "size of local color table" field
  return { bytes, sizeField: Math.log2(size) - 1, minCodeSize: Math.max(2, Math.log2(size)) };
}

// Write a Graphic Control Extension into `out`: per-frame delay + transparency.
function writeGCE(out, delayCs, transparentIndex) {
  const hasT = transparentIndex >= 0 ? 1 : 0;
  // packed: disposal method 2 (restore to background) << 2, transparency flag bit 0.
  const packed = (2 << 2) | hasT;
  out.push(0x21, 0xF9, 0x04, packed, ...u16le(delayCs), hasT ? transparentIndex : 0, 0x00);
}

// Write one full frame (GCE + Image Descriptor + local colour table + image
// data) into `out`. Returns the number of bytes written (used by the estimator).
function writeFrame(out, quant, w, h, delayCs) {
  const start = out.length;
  const { bytes, sizeField, minCodeSize } = buildColorTable(quant.palette);
  const lzw = lzwEncode(quant.indices, minCodeSize);
  writeGCE(out, delayCs, quant.transparentIndex);
  // Image Descriptor: separator, x, y, w, h, packed (local table flag + size).
  out.push(0x2C, ...u16le(0), ...u16le(0), ...u16le(w), ...u16le(h), 0x80 | sizeField);
  appendAll(out, bytes);
  writeImageData(out, lzw, minCodeSize);
  return out.length - start;
}

function buildHeader(w, h) {
  return [
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // "GIF89a"
    ...u16le(w), ...u16le(h),
    0x70, // packed: no global colour table, colour resolution bits set
    0x00, // background colour index
    0x00, // pixel aspect ratio
  ];
}

// Netscape 2.0 application extension → loop forever (0).
const NETSCAPE_LOOP = [
  0x21, 0xFF, 0x0B,
  0x4E, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2E, 0x30, // "NETSCAPE2.0"
  0x03, 0x01, 0x00, 0x00, 0x00,
];

// Downscale one ImageData via a 2D canvas (mirrors webp-anim's scaleFrame).
function scaleFrame(imageData, gW, gH, fullCanvas, fullCtx, scaledCanvas, scaledCtx) {
  fullCtx.putImageData(imageData, 0, 0);
  scaledCtx.clearRect(0, 0, gW, gH);
  scaledCtx.drawImage(fullCanvas, 0, 0, gW, gH);
  return scaledCtx.getImageData(0, 0, gW, gH);
}

/**
 * Encode an array of ImageData frames into one animated GIF blob.
 * @param {ImageData[]} frames
 * @param {object} opts
 * @param {number} opts.fps               source frame rate (for per-frame delay)
 * @param {number} [opts.scale=1]         output scale factor
 * @param {number} [opts.skip=1]          keep every Nth frame
 * @param {boolean} [opts.transparent=true] 1-bit transparency vs. matte composite
 * @param {[number,number,number]} [opts.matte=[255,255,255]] matte colour when not transparent
 * @param {boolean} [opts.dither=true]    Floyd–Steinberg dithering
 * @param {number} [opts.alphaThreshold=128] alpha ≥ this is opaque (transparent mode)
 * @param {(done:number,total:number)=>void} [opts.onProgress]
 * @returns {Promise<Blob>}
 */
export async function encodeAnimatedGif(frames, opts) {
  const {
    fps, scale = 1, skip = 1, transparent = true,
    matte = [255, 255, 255], dither = true, alphaThreshold = 128, onProgress,
  } = opts;
  if (!frames.length) throw new Error('沒有可轉換的影格');

  const srcW = frames[0].width, srcH = frames[0].height;
  const gW = Math.max(1, Math.round(srcW * scale));
  const gH = Math.max(1, Math.round(srcH * scale));
  const needScale = scale !== 1;
  const delayCs = Math.max(1, Math.round((100 * skip) / fps)); // GIF delay is in 1/100 s

  let fullCanvas, fullCtx, scaledCanvas, scaledCtx;
  if (needScale) {
    fullCanvas = document.createElement('canvas');
    fullCanvas.width = srcW; fullCanvas.height = srcH;
    fullCtx = fullCanvas.getContext('2d');
    scaledCanvas = document.createElement('canvas');
    scaledCanvas.width = gW; scaledCanvas.height = gH;
    scaledCtx = scaledCanvas.getContext('2d', { willReadFrequently: true });
  }

  const indices = [];
  for (let i = 0; i < frames.length; i += skip) indices.push(i);

  const qOpts = { transparent, matte, dither, alphaThreshold };
  const bytes = [...buildHeader(gW, gH), ...NETSCAPE_LOOP];
  for (let k = 0; k < indices.length; k++) {
    const img = needScale
      ? scaleFrame(frames[indices[k]], gW, gH, fullCanvas, fullCtx, scaledCanvas, scaledCtx)
      : frames[indices[k]];
    const quant = quantizeFrame(img.data, img.width, img.height, qOpts);
    writeFrame(bytes, quant, gW, gH, delayCs);
    onProgress?.(k + 1, indices.length);
    if (k % 2 === 0) await new Promise(r => setTimeout(r, 0)); // yield to UI
  }
  bytes.push(0x3B); // trailer
  return new Blob([new Uint8Array(bytes)], { type: 'image/gif' });
}

// ── Live size estimate ─────────────────────────────────────
// Header (13) + Netscape loop (19) + trailer (1).
const GIF_CONTAINER_OVERHEAD = 33;

/**
 * Estimate the final animated-GIF size without encoding every frame: encode a
 * few representative frames at the chosen settings and extrapolate
 * total ≈ overhead + avgFrameSize × outputFrameCount.
 *
 * @param {ImageData[]} sampleFrames
 * @param {object} opts                same shape as encodeAnimatedGif opts
 * @param {number} outputFrameCount    how many frames the real export will have
 * @returns {Promise<{bytes:number, perFrame:number, frameCount:number}>}
 */
export async function estimateGifBytes(sampleFrames, opts, outputFrameCount) {
  const { scale = 1, transparent = true, matte = [255, 255, 255], dither = true, alphaThreshold = 128 } = opts;
  if (!sampleFrames.length || outputFrameCount <= 0) return { bytes: 0, perFrame: 0, frameCount: 0 };

  const srcW = sampleFrames[0].width, srcH = sampleFrames[0].height;
  const gW = Math.max(1, Math.round(srcW * scale));
  const gH = Math.max(1, Math.round(srcH * scale));
  const needScale = scale !== 1;

  let fullCanvas, fullCtx, scaledCanvas, scaledCtx;
  if (needScale) {
    fullCanvas = document.createElement('canvas');
    fullCanvas.width = srcW; fullCanvas.height = srcH;
    fullCtx = fullCanvas.getContext('2d');
    scaledCanvas = document.createElement('canvas');
    scaledCanvas.width = gW; scaledCanvas.height = gH;
    scaledCtx = scaledCanvas.getContext('2d', { willReadFrequently: true });
  }

  const qOpts = { transparent, matte, dither, alphaThreshold };
  let sum = 0;
  for (const f of sampleFrames) {
    const img = needScale
      ? scaleFrame(f, gW, gH, fullCanvas, fullCtx, scaledCanvas, scaledCtx)
      : f;
    const quant = quantizeFrame(img.data, img.width, img.height, qOpts);
    sum += writeFrame([], quant, gW, gH, 10); // delay doesn't affect byte size
  }
  const perFrame = sum / sampleFrames.length;
  const bytes = Math.round(GIF_CONTAINER_OVERHEAD + perFrame * outputFrameCount);
  return { bytes, perFrame: Math.round(perFrame), frameCount: outputFrameCount };
}
