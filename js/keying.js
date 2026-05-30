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
// to eat away residual background fringe.
export function erodeAlpha(am, w, h, r) {
  if (r === 0) return am;
  const res = new Float32Array(am.length), r2 = r * r;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const idx = y * w + x;
    if (am[idx] === 0) { res[idx] = 0; continue; }
    let mv = am[idx];
    outer: for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) { mv = 0; break outer; }
      const v = am[ny * w + nx]; if (v < mv) { mv = v; if (mv === 0) break outer; }
    }
    res[idx] = mv;
  }
  return res;
}

// Apply the key to one frame. `p` is the param object from getParams().
// Returns a new ImageData with premultiplied-friendly straight alpha.
export function applyKey(imageData, p) {
  const { mode, thresh, feather, shrink, spill, boost, keyColor } = p;
  const data = imageData.data, w = imageData.width, h = imageData.height;
  const out = new Uint8ClampedArray(data), am = new Float32Array(w * h);
  const lo = thresh - feather, hi = thresh + feather, rng = feather * 2 + FEATHER_EPSILON;
  if (mode === 'luma') {
    for (let i = 0; i < w * h; i++) {
      const b = i * 4, l = (data[b] * LUMA_R + data[b + 1] * LUMA_G + data[b + 2] * LUMA_B) / 255;
      am[i] = l < lo ? 0 : l > hi ? 1 : (l - lo) / rng;
    }
  } else {
    const [kr, kg, kb] = keyColor, [kh, ks, kl] = rgbToHsl(kr, kg, kb);
    for (let i = 0; i < w * h; i++) {
      const b = i * 4, [ph, ps, pl] = rgbToHsl(data[b] / 255, data[b + 1] / 255, data[b + 2] / 255);
      let dh = Math.abs(ph - kh); if (dh > 0.5) dh = 1 - dh;
      const d = Math.sqrt(dh * dh * 4 + (ps - ks) * (ps - ks) + (pl - kl) * (pl - kl) * 0.5);
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
