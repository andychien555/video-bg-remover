// ── Frame extraction pipeline ──────────────────────────────
// Decodes a video into an array of keyed ImageData frames.
//
// Capture strategy: play the video and grab each presented frame via
// requestVideoFrameCallback (rVFC). This is frame-accurate (we map each
// frame's mediaTime onto a 1/fps slot) and avoids the slow, sometimes
// inaccurate per-frame `video.currentTime` seeking. Keying runs in a Web
// Worker so the main thread stays responsive.
//
// Older browsers without rVFC fall back to seek-based capture; both paths
// share the same worker for keying.

// Bytes of RAM the keyed-frame buffer will occupy. The caller uses this to
// warn before a long/HD clip OOMs the tab (each frame is w·h·4 bytes, kept
// in memory for preview + export).
export function estimateMemoryBytes(w, h, duration, fps) {
  return w * h * 4 * Math.ceil(duration * fps);
}

function seekVideo(video, t) {
  return new Promise(resolve => {
    video.addEventListener('seeked', resolve, { once: true });
    video.currentTime = t;
  });
}

// Extract + key every frame.
//   video   : the (loaded) HTMLVideoElement
//   ctx     : a 2D context sized to the video, with willReadFrequently:true
//   fps     : target frames per second
//   params  : keying params (passed straight to applyKey in the worker)
//   onProgress(done, total)        : keyed-frame counter
//   onFrameReady(imageData, index) : optional, for a live preview while processing
// Resolves to an array of keyed ImageData (≈ duration·fps frames, in order).
export async function extractFrames({ video, ctx, fps, params, onProgress, onFrameReady }) {
  const w = video.videoWidth, h = video.videoHeight;
  const totalFrames = Math.max(1, Math.ceil(video.duration * fps));
  const frames = new Array(totalFrames).fill(null);

  const worker = new Worker(new URL('./keying-worker.js', import.meta.url), { type: 'module' });

  let pending = 0;        // frames posted to the worker, not yet returned
  let processed = 0;      // frames the worker has returned
  let captureDone = false;
  let finished = false;
  let resolveAll, rejectAll;
  const done = new Promise((res, rej) => { resolveAll = res; rejectAll = rej; });

  function maybeFinish() {
    if (finished || !captureDone || pending > 0) return;
    finished = true;
    worker.terminate();
    // Forward-fill slots the source never presented (when source fps < target),
    // so the output keeps a steady `fps` cadence. Fills are shared references —
    // cheap, and safe because frames are treated as read-only downstream.
    for (let i = 1; i < frames.length; i++) if (!frames[i]) frames[i] = frames[i - 1];
    resolveAll(frames.filter(Boolean));
  }

  worker.onmessage = (e) => {
    const { index, buf, width, height } = e.data;
    const img = new ImageData(new Uint8ClampedArray(buf), width, height);
    frames[index] = img;
    pending--; processed++;
    onProgress?.(processed, totalFrames);
    onFrameReady?.(img, index);
    maybeFinish();
  };
  worker.onerror = (err) => { if (!finished) { finished = true; worker.terminate(); rejectAll(err); } };

  function keyFrame(index) {
    ctx.drawImage(video, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    pending++;
    worker.postMessage({ index, buf: img.data.buffer, width: w, height: h, params }, [img.data.buffer]);
  }

  const hasRvfc = typeof HTMLVideoElement !== 'undefined'
    && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

  try {
    if (hasRvfc) {
      video.muted = true;
      await seekVideo(video, 0);
      const seen = new Set();
      const onFrame = (_now, meta) => {
        const idx = Math.round(meta.mediaTime * fps);
        if (idx >= 0 && idx < totalFrames && !seen.has(idx)) { seen.add(idx); keyFrame(idx); }
        if (!video.ended) video.requestVideoFrameCallback(onFrame);
      };
      video.addEventListener('ended', () => { captureDone = true; maybeFinish(); }, { once: true });
      video.requestVideoFrameCallback(onFrame);
      await video.play();
    } else {
      // Fallback: per-frame seek (e.g. older Safari without rVFC).
      for (let f = 0; f < totalFrames; f++) {
        const t = Math.min(f / fps, video.duration - 0.001);
        if (t < 0) break;
        await seekVideo(video, t);
        keyFrame(f);
        if (f % 8 === 0) await new Promise(r => setTimeout(r, 0));
      }
      captureDone = true;
      maybeFinish();
    }

    const result = await done;
    return result;
  } finally {
    video.pause();
  }
}
