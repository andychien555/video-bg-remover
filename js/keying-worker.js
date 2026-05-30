// ── Keying Web Worker ──────────────────────────────────────
// Runs applyKey() off the main thread so frame-by-frame processing never
// blocks the UI. Frames arrive as transferred ArrayBuffers (zero-copy) and
// the keyed result is transferred straight back.
//
// Loaded as a module worker: new Worker(url, { type: 'module' }).
import { applyKey } from './keying.js';

self.onmessage = (e) => {
  const { index, buf, width, height, params } = e.data;
  const img = new ImageData(new Uint8ClampedArray(buf), width, height);
  const res = applyKey(img, params);
  // Hand the result buffer back to the main thread without copying.
  self.postMessage(
    { index, buf: res.data.buffer, width, height },
    [res.data.buffer]
  );
};
