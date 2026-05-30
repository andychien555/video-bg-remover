// ── Chroma / luma keying ───────────────────────────────────
// Pure image-processing functions. No DOM access — operates on ImageData only.

export const LUMA_R = 0.299, LUMA_G = 0.587, LUMA_B = 0.114; // ITU-R BT.601 luma weights
export const FEATHER_EPSILON = 0.001; // avoid divide-by-zero in feather range

export function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

export function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return [h, s, l];
}

// Morphological erosion of the alpha matte — shrinks the subject edge by `r` px
// to eat away residual background fringe. Implemented as a SEPARABLE min-filter
// (horizontal pass then vertical pass): O(w·h·r) instead of the naive O(w·h·r²).
// The structuring element is a (2r+1) square; for de-fringing 1–3 px this is
// visually indistinguishable from a disc and markedly faster. Out-of-bounds
// neighbours are clamped (the old code forced edge pixels to 0, which ate
// subjects that touched the frame border).
export function erodeAlpha(am, w, h, r) {
  if (r <= 0) return am;
  const tmp = new Float32Array(am.length);
  // Horizontal pass.
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = x - r < 0 ? 0 : x - r, x1 = x + r >= w ? w - 1 : x + r;
      let mv = am[row + x];
      for (let nx = x0; nx <= x1; nx++) { const v = am[row + nx]; if (v < mv) { mv = v; if (mv === 0) break; } }
      tmp[row + x] = mv;
    }
  }
  // Vertical pass.
  const res = new Float32Array(am.length);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const y0 = y - r < 0 ? 0 : y - r, y1 = y + r >= h ? h - 1 : y + r;
      let mv = tmp[y * w + x];
      for (let ny = y0; ny <= y1; ny++) { const v = tmp[ny * w + x]; if (v < mv) { mv = v; if (mv === 0) break; } }
      res[y * w + x] = mv;
    }
  }
  return res;
}

// Apply the key to one frame. `p` is the param object from getParams().
// Returns a new ImageData with premultiplied-friendly straight alpha.
export function applyKey(imageData, p) {
  const { mode, thresh, feather, shrink, spill, boost, keyColor } = p;
  const data = imageData.data, w = imageData.width, h = imageData.height, n = w * h;
  const out = new Uint8ClampedArray(data), am = new Float32Array(n);
  const lo = thresh - feather, hi = thresh + feather, rng = feather * 2 + FEATHER_EPSILON;
  if (mode === 'luma') {
    for (let i = 0; i < n; i++) {
      const b = i * 4, l = (data[b] * LUMA_R + data[b + 1] * LUMA_G + data[b + 2] * LUMA_B) / 255;
      am[i] = l < lo ? 0 : l > hi ? 1 : (l - lo) / rng;
    }
  } else {
    // Distance in the YCbCr chroma plane (Cb,Cr). This is luminance-independent,
    // so it stays stable for low-saturation pixels where HSL hue jitters and
    // causes frame-to-frame flicker — and it needs no per-pixel allocation.
    const [kr, kg, kb] = keyColor;
    const kCb = -0.168736 * kr - 0.331264 * kg + 0.5 * kb;
    const kCr = 0.5 * kr - 0.418688 * kg - 0.081312 * kb;
    for (let i = 0; i < n; i++) {
      const b = i * 4, r = data[b] / 255, g = data[b + 1] / 255, bl = data[b + 2] / 255;
      const dcb = (-0.168736 * r - 0.331264 * g + 0.5 * bl) - kCb;
      const dcr = (0.5 * r - 0.418688 * g - 0.081312 * bl) - kCr;
      const d = Math.sqrt(dcb * dcb + dcr * dcr);
      am[i] = d < lo ? 0 : d > hi ? 1 : (d - lo) / rng;
    }
  }
  const ea = erodeAlpha(am, w, h, shrink);
  for (let i = 0; i < w * h; i++) {
    const b = i * 4; let a = ea[i], r = data[b] / 255, g = data[b + 1] / 255, bl = data[b + 2] / 255;
    if (a > 0 && a < 1 && boost !== 1.0) { r = Math.min(1, r * boost); g = Math.min(1, g * boost); bl = Math.min(1, bl * boost); }
    if (mode === 'chroma' && a < 1 && spill > 0) {
      const [kr, kg, kb] = keyColor;
      if (kg > kr && kg > kb) { const ex = g - Math.max(r, bl); if (ex > 0) g = Math.max(0, g - ex * spill * (1 - a)); }
      else if (kb > kr && kb > kg) { const ex = bl - Math.max(r, g); if (ex > 0) bl = Math.max(0, bl - ex * spill * (1 - a)); }
    }
    out[b] = Math.round(r * 255); out[b + 1] = Math.round(g * 255); out[b + 2] = Math.round(bl * 255); out[b + 3] = Math.round(a * 255);
  }
  return new ImageData(out, w, h);
}

// ── Preview aids: residue readout + alpha-matte view ───────
// Visual helpers so the user can tell when the background is *truly* transparent
// (no lingering dark/key-colour pixels) — the raw keyed preview on a dark
// checkerboard makes faint residue almost invisible.

// Luma (0-1) below this, while still visible, counts as "dark background residue"
// in luma mode. ~0.25 catches the dark halo/fringe without flagging the subject.
export const RESIDUE_LUMA = 0.25;
// Screaming magenta — high contrast against both dark residue and blue/green subjects.
export const RESIDUE_COLOR = { r: 255, g: 43, b: 214 };

// Count pixels that are still visible (alpha > 0) yet still look like background:
//   luma mode   → dark pixels (luma ≤ RESIDUE_LUMA)
//   chroma mode → soft/partial-alpha edge pixels (0 < alpha < 255), i.e. key-colour spill
// Keying only zeroes alpha (RGB stays original on transparent pixels), so the keyed
// frame can be classified directly. Pass `paintColor` to tint residue in place for the
// drag-time highlight. Returns the residue ratio (0-1) of the whole frame.
export function analyzeResidue(imageData, mode, paintColor) {
  const data = imageData.data;
  const total = data.length / 4;
  if (total === 0) return 0;
  let residue = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0) continue; // fully transparent → already clean
    let isBg;
    if (mode === 'chroma') {
      isBg = a < 255; // partial-alpha spill/fringe band
    } else {
      const l = (data[i] * LUMA_R + data[i + 1] * LUMA_G + data[i + 2] * LUMA_B) / 255;
      isBg = l <= RESIDUE_LUMA;
    }
    if (isBg) {
      residue++;
      if (paintColor) {
        data[i] = paintColor.r; data[i + 1] = paintColor.g; data[i + 2] = paintColor.b; data[i + 3] = 255;
      }
    }
  }
  return residue / total;
}

// Render the alpha channel as an opaque grayscale matte (white = opaque,
// pure black = fully transparent). Gamma 0.45 lifts low alphas so near-invisible
// residue (e.g. alpha 20) reads clearly, while true alpha 0 stays pure black —
// giving a precise "is it actually transparent?" check. Mutates in place.
export function toAlphaView(imageData) {
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const v = Math.round(255 * Math.pow(data[i + 3] / 255, 0.45));
    data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
  }
}
