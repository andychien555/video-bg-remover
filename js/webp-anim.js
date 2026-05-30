// ── Animated WebP encoder ──────────────────────────────────
// In-browser equivalent of Google's `img2webp` tool:
//   1. Encode each RGBA frame to a still WebP with alpha, using libwebp
//      compiled to WebAssembly (@jsquash/webp — the same encoder engine
//      img2webp uses). This is why alpha is reliable here, unlike ffmpeg's
//      animated-webp path.
//   2. Mux the still frames into one animated WebP container (VP8X + ANIM +
//      ANMF chunks) — implemented below per the WebP container spec.
//
// Spec: https://developers.google.com/speed/webp/docs/riff_container

import encode from '../vendor/jsquash/encode.js';

// VP8X feature flags (only the low byte of the 32-bit flags field is used).
const VP8X_ANIM_FLAG = 0x02;
const VP8X_ALPHA_FLAG = 0x10;
// ANMF flags byte: bit 1 = blending (1 = do NOT blend → overwrite, keeps each
// frame's alpha independent), bit 0 = disposal (0 = none; irrelevant for
// full-canvas frames that overwrite completely).
const ANMF_NO_BLEND = 0x02;

// ── Byte helpers ───────────────────────────────────────────
function u24le(n) { return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]; }

// Build one RIFF chunk: FourCC + uint32-LE size + payload + pad-to-even.
function buildChunk(fourCC, payload) {
  const size = payload.length;
  const pad = size & 1;
  const out = new Uint8Array(8 + size + pad);
  for (let i = 0; i < 4; i++) out[i] = fourCC.charCodeAt(i);
  out[4] = size & 0xff; out[5] = (size >> 8) & 0xff; out[6] = (size >> 16) & 0xff; out[7] = (size >>> 24) & 0xff;
  out.set(payload, 8);
  return out; // trailing pad byte is already 0
}

// Parse a still WebP file and pull out the bitstream chunks we need to embed
// inside an ANMF frame: the optional ALPH (alpha) chunk and the VP8/VP8L image
// chunk. We deliberately drop any VP8X header — the animation has its own.
function extractFrameChunks(buffer) {
  const b = new Uint8Array(buffer);
  // b[0..3]='RIFF', b[8..11]='WEBP'; chunks start at offset 12.
  let off = 12;
  const chunks = []; // raw bytes of each ALPH/VP8/VP8L chunk, in source order
  let hasAlpha = false;
  while (off + 8 <= b.length) {
    const tag = String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3]);
    const size = b[off + 4] | (b[off + 5] << 8) | (b[off + 6] << 16) | (b[off + 7] * 0x1000000);
    const pad = size & 1;
    const end = off + 8 + size + pad;
    if (tag === 'ALPH') { hasAlpha = true; chunks.push(b.subarray(off, end)); }
    else if (tag === 'VP8L') { hasAlpha = true; chunks.push(b.subarray(off, end)); } // VP8L can carry inline alpha
    else if (tag === 'VP8 ') { chunks.push(b.subarray(off, end)); }
    off = end;
  }
  return { chunks, hasAlpha };
}

function buildVP8X(w, h, hasAlpha) {
  const p = new Uint8Array(10);
  p[0] = VP8X_ANIM_FLAG | (hasAlpha ? VP8X_ALPHA_FLAG : 0);
  p.set(u24le(w - 1), 4);
  p.set(u24le(h - 1), 7);
  return buildChunk('VP8X', p);
}

function buildANIM(loops) {
  const p = new Uint8Array(6); // bytes 0..3 = background BGRA (0 = transparent)
  p[4] = loops & 0xff; p[5] = (loops >> 8) & 0xff;
  return buildChunk('ANIM', p);
}

function buildANMF(frameChunks, w, h, durationMs) {
  const total = 16 + frameChunks.reduce((s, c) => s + c.length, 0);
  const p = new Uint8Array(total);
  p.set(u24le(0), 0);       // frame X (in 2px units)
  p.set(u24le(0), 3);       // frame Y
  p.set(u24le(w - 1), 6);   // frame width minus one
  p.set(u24le(h - 1), 9);   // frame height minus one
  p.set(u24le(durationMs), 12);
  p[15] = ANMF_NO_BLEND;
  let o = 16;
  for (const c of frameChunks) { p.set(c, o); o += c.length; }
  return buildChunk('ANMF', p);
}

function assembleRIFF(chunks) {
  const bodyLen = 4 + chunks.reduce((s, c) => s + c.length, 0); // 'WEBP' + chunks
  const out = new Uint8Array(8 + bodyLen);
  out.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
  out[4] = bodyLen & 0xff; out[5] = (bodyLen >> 8) & 0xff; out[6] = (bodyLen >> 16) & 0xff; out[7] = (bodyLen >>> 24) & 0xff;
  out.set([0x57, 0x45, 0x42, 0x50], 8); // 'WEBP'
  let o = 12;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// Downscale one ImageData using a 2D canvas. Returns the original when scale===1.
function scaleFrame(imageData, gW, gH, fullCanvas, fullCtx, scaledCanvas, scaledCtx) {
  fullCtx.putImageData(imageData, 0, 0);
  scaledCtx.clearRect(0, 0, gW, gH);
  scaledCtx.drawImage(fullCanvas, 0, 0, gW, gH);
  return scaledCtx.getImageData(0, 0, gW, gH);
}

/**
 * Encode an array of ImageData frames into one animated WebP blob.
 * @param {ImageData[]} frames
 * @param {object} opts
 * @param {number} opts.fps        source frame rate (for per-frame duration)
 * @param {number} opts.quality    0–100 (lossy); ignored when lossless>0
 * @param {number} [opts.scale=1]  output scale factor
 * @param {number} [opts.skip=1]   keep every Nth frame
 * @param {number} [opts.lossless=0] 0 = lossy, 1 = lossless (bigger, exact)
 * @param {(done:number,total:number)=>void} [opts.onProgress]
 * @returns {Promise<Blob>}
 */
export async function encodeAnimatedWebP(frames, opts) {
  const { fps, quality, scale = 1, skip = 1, lossless = 0, onProgress } = opts;
  if (!frames.length) throw new Error('沒有可轉換的影格');

  const srcW = frames[0].width, srcH = frames[0].height;
  const gW = Math.max(1, Math.round(srcW * scale));
  const gH = Math.max(1, Math.round(srcH * scale));
  const needScale = scale !== 1;
  const durationMs = Math.max(1, Math.round((1000 * skip) / fps));

  const indices = [];
  for (let i = 0; i < frames.length; i += skip) indices.push(i);

  // Reusable canvases for optional downscaling.
  let fullCanvas, fullCtx, scaledCanvas, scaledCtx;
  if (needScale) {
    fullCanvas = document.createElement('canvas');
    fullCanvas.width = srcW; fullCanvas.height = srcH;
    fullCtx = fullCanvas.getContext('2d');
    scaledCanvas = document.createElement('canvas');
    scaledCanvas.width = gW; scaledCanvas.height = gH;
    scaledCtx = scaledCanvas.getContext('2d', { willReadFrequently: true });
  }

  const encodeOpts = { quality, lossless, method: 4, exact: 0, alpha_quality: 100 };
  const anmfChunks = [];
  let anyAlpha = false;

  for (let k = 0; k < indices.length; k++) {
    const img = needScale
      ? scaleFrame(frames[indices[k]], gW, gH, fullCanvas, fullCtx, scaledCanvas, scaledCtx)
      : frames[indices[k]];
    const stillWebp = await encode({ data: img.data, width: img.width, height: img.height }, encodeOpts);
    const { chunks, hasAlpha } = extractFrameChunks(stillWebp);
    if (hasAlpha) anyAlpha = true;
    anmfChunks.push(buildANMF(chunks, gW, gH, durationMs));
    onProgress?.(k + 1, indices.length);
    if (k % 3 === 0) await new Promise(r => setTimeout(r, 0)); // yield to UI
  }

  const file = assembleRIFF([
    buildVP8X(gW, gH, anyAlpha),
    buildANIM(0), // 0 = loop forever
    ...anmfChunks,
  ]);
  return new Blob([file], { type: 'image/webp' });
}
