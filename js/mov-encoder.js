// ── ffmpeg.wasm exporters (MOV + compressed WebM) ──────────
// Encodes the keyed frames into formats that preserve the alpha channel:
//   • encodeMov  — QuickTime .mov (ProRes 4444 / qtrle) for pro editors
//                  (Premiere / FCP / After Effects), which ingest alpha cleanly.
//   • encodeWebm — VP9-alpha .webm with constant-quality CRF, the smallest
//                  alpha output for the web (Chrome / Firefox / Edge).
//
// ffmpeg.wasm is heavy (~30 MB core) and unnecessary for the other formats, so
// it is lazy-loaded from a pinned jsDelivr version only on first MOV/WebM export
// and cached thereafter (both exporters share one loaded instance). We use the
// SINGLE-THREAD core on purpose: the multi-thread build needs SharedArrayBuffer
// (COOP/COEP headers), which GitHub Pages can't set. Single-thread is slower but
// it's the only variant that runs on the site.

// Pinned, long-stable versions (all 0.12.x, published well over a year ago).
// NOTE: the worker chunk is named `814.ffmpeg.js` for THIS exact wrapper
// version (0.12.10). If you bump FFMPEG_VER, check the new chunk filename in
// the package's dist/umd and update the classWorkerURL below to match.
const FFMPEG_VER = '0.12.10';   // @ffmpeg/ffmpeg  (wrapper + worker)
const UTIL_VER   = '0.12.1';    // @ffmpeg/util    (toBlobURL/fetchFile)
const CORE_VER   = '0.12.6';    // @ffmpeg/core    (single-thread wasm; ships libvpx → VP9)
const CDN = 'https://cdn.jsdelivr.net/npm';

let ffmpegPromise = null; // memoised loaded instance

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.crossOrigin = 'anonymous';
    s.onload = resolve;
    s.onerror = () => reject(new Error('ffmpeg 載入失敗：' + src));
    document.head.appendChild(s);
  });
}

// Load (once) the UMD ffmpeg wrapper + util, then boot the single-thread core
// via blob URLs. onStatus reports the (slow) first-time download/boot phase.
async function getFFmpeg(onStatus) {
  if (ffmpegPromise) return ffmpegPromise;
  ffmpegPromise = (async () => {
    onStatus && onStatus('首次使用：下載 ffmpeg 編碼器（約 30MB，僅這一次）…');
    if (!window.FFmpegWASM) await loadScript(`${CDN}/@ffmpeg/ffmpeg@${FFMPEG_VER}/dist/umd/ffmpeg.js`);
    if (!window.FFmpegUtil) await loadScript(`${CDN}/@ffmpeg/util@${UTIL_VER}/dist/umd/index.js`);
    const { FFmpeg } = window.FFmpegWASM;
    const { toBlobURL } = window.FFmpegUtil;
    const ffmpeg = new FFmpeg();
    const wrap = `${CDN}/@ffmpeg/ffmpeg@${FFMPEG_VER}/dist/umd`;
    // ESM core on purpose: @ffmpeg/ffmpeg's worker is a *module* worker, so it
    // pulls the core via dynamic import() — the UMD core has no ESM default and
    // fails. The worker chunk + core are turned into same-origin blob URLs so
    // the cross-origin Worker (loaded from the CDN) isn't blocked by the browser.
    const base = `${CDN}/@ffmpeg/core@${CORE_VER}/dist/esm`;
    onStatus && onStatus('初始化 ffmpeg 核心…');
    await ffmpeg.load({
      classWorkerURL: await toBlobURL(`${wrap}/814.ffmpeg.js`, 'text/javascript'),
      coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    return ffmpeg;
  })();
  // Reset the cache on failure so the next click retries from scratch.
  ffmpegPromise.catch(() => { ffmpegPromise = null; });
  return ffmpegPromise;
}

// ── ffmpeg arg builders (all keep alpha) ───────────────────
// MOV: ProRes 4444 is the pro standard (large, slow); qtrle (QuickTime
// Animation) is lossless RLE — smaller and faster.
function buildMovArgs(codec, fps, pattern, out) {
  const input = ['-framerate', String(fps), '-start_number', '1', '-i', pattern];
  if (codec === 'prores') {
    return [...input,
            '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le',
            '-vendor', 'apl0', out];
  }
  // 'png' option → QuickTime Animation (qtrle), lossless with alpha
  return [...input, '-c:v', 'qtrle', '-pix_fmt', 'argb', out];
}

// WebM: VP9 with an alpha plane (yuva420p), constant-quality mode. `-b:v 0`
// disables the target bitrate so `-crf` alone drives quality/size (higher CRF →
// smaller, blurrier). `-auto-alt-ref 0` is REQUIRED — alt-ref frames corrupt the
// alpha plane. `-row-mt 1` speeds up encode; `-an` drops the (absent) audio.
function buildWebmArgs(crf, fps, pattern, out) {
  return ['-framerate', String(fps), '-start_number', '1', '-i', pattern,
          '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p',
          '-b:v', '0', '-crf', String(crf),
          '-row-mt', '1', '-auto-alt-ref', '0', '-an', out];
}

// Render one ImageData to a (optionally scaled) PNG blob via an offscreen canvas.
async function frameToPng(imgData, full, fullCtx, scaled, scaledCtx, gW, gH, doScale) {
  fullCtx.putImageData(imgData, 0, 0);
  if (doScale) {
    scaledCtx.clearRect(0, 0, gW, gH);
    scaledCtx.drawImage(full, 0, 0, gW, gH);
  }
  const canvasEl = doScale ? scaled : full;
  return new Promise(r => canvasEl.toBlob(r, 'image/png'));
}

/**
 * Shared encode path: rasterise the selected frames into ffmpeg's virtual FS
 * (phase 1, 0–45%), run ffmpeg (phase 2, 45–100%), then clean up the FS.
 * @param {ImageData[]} frames  full-res keyed frames
 * @param {{scale:number, skip:number}} opts
 * @param {{onStatus?:Function, onProgress?:Function}} hooks
 * @param {{outName:string, mime:string, encLabel:string, buildArgs:(pattern:string,out:string)=>string[]}} spec
 * @returns {Promise<{blob:Blob, width:number, height:number, count:number}>}
 */
async function encodeFrames(frames, opts, hooks, spec) {
  const { scale, skip } = opts;
  const onStatus = hooks.onStatus || (() => {});
  const onProgress = hooks.onProgress || (() => {});

  const ffmpeg = await getFFmpeg(onStatus);

  const srcW = frames[0].width, srcH = frames[0].height;
  const doScale = scale !== 1;
  // even dimensions keep the encoders happy (VP9/ProRes/qtrle all prefer it)
  const gW = doScale ? Math.round(srcW * scale / 2) * 2 : srcW;
  const gH = doScale ? Math.round(srcH * scale / 2) * 2 : srcH;

  const full = document.createElement('canvas');
  full.width = srcW; full.height = srcH;
  const fullCtx = full.getContext('2d');
  const scaled = document.createElement('canvas');
  scaled.width = gW; scaled.height = gH;
  const scaledCtx = scaled.getContext('2d');
  // high-quality resampling on downscale (closest the canvas gets to Lanczos)
  scaledCtx.imageSmoothingEnabled = true;
  scaledCtx.imageSmoothingQuality = 'high';

  const indices = [];
  for (let i = 0; i < frames.length; i += skip) indices.push(i);
  const pad = String(indices.length).length;
  const nameOf = n => `f${String(n + 1).padStart(pad, '0')}.png`;

  // Phase 1 (0–45%): rasterise frames into ffmpeg's virtual FS.
  for (let fi = 0; fi < indices.length; fi++) {
    const blob = await frameToPng(frames[indices[fi]], full, fullCtx, scaled, scaledCtx, gW, gH, doScale);
    const buf = new Uint8Array(await blob.arrayBuffer());
    await ffmpeg.writeFile(nameOf(fi), buf);
    onProgress((fi / indices.length) * 0.45);
    onStatus(`準備幀 ${fi + 1} / ${indices.length}`);
    if (fi % 5 === 0) await new Promise(r => setTimeout(r, 0));
  }

  // Phase 2 (45–100%): run ffmpeg; map its progress event into the tail range.
  onStatus(spec.encLabel);
  const onFf = ({ progress }) => {
    if (progress >= 0 && progress <= 1) onProgress(0.45 + progress * 0.55);
  };
  ffmpeg.on('progress', onFf);

  const pattern = `f%0${pad}d.png`;
  let blob;
  try {
    await ffmpeg.exec(spec.buildArgs(pattern, spec.outName));
    const data = await ffmpeg.readFile(spec.outName);
    blob = new Blob([data.buffer], { type: spec.mime });
  } finally {
    ffmpeg.off('progress', onFf);
    // Tidy the virtual FS so repeat exports don't accumulate frames.
    try {
      for (let fi = 0; fi < indices.length; fi++) await ffmpeg.deleteFile(nameOf(fi));
      await ffmpeg.deleteFile(spec.outName);
    } catch (_) { /* best-effort cleanup */ }
  }

  if (!blob || blob.size === 0) {
    throw new Error('編碼結果為空，此瀏覽器的 ffmpeg 核心可能不支援該編碼');
  }
  onProgress(1);
  return { blob, width: gW, height: gH, count: indices.length };
}

/**
 * Encode keyed frames to an alpha .mov blob.
 * @param {ImageData[]} frames  full-res keyed frames
 * @param {{scale:number, skip:number, fps:number, codec:'prores'|'png'}} opts
 * @param {{onStatus?:(msg:string)=>void, onProgress?:(ratio:number)=>void}} hooks
 * @returns {Promise<{blob:Blob, width:number, height:number, count:number}>}
 */
export function encodeMov(frames, opts, hooks = {}) {
  return encodeFrames(frames, opts, hooks, {
    outName: 'out.mov',
    mime: 'video/quicktime',
    encLabel: opts.codec === 'prores' ? 'ffmpeg 編碼 ProRes 4444…' : 'ffmpeg 編碼 MOV…',
    buildArgs: (pattern, out) => buildMovArgs(opts.codec, opts.fps, pattern, out),
  });
}

/**
 * Encode keyed frames to a compressed alpha .webm blob (VP9, constant-quality).
 * @param {ImageData[]} frames  full-res keyed frames
 * @param {{scale:number, skip:number, fps:number, crf:number}} opts
 * @param {{onStatus?:(msg:string)=>void, onProgress?:(ratio:number)=>void}} hooks
 * @returns {Promise<{blob:Blob, width:number, height:number, count:number}>}
 */
export function encodeWebm(frames, opts, hooks = {}) {
  return encodeFrames(frames, opts, hooks, {
    outName: 'out.webm',
    mime: 'video/webm',
    encLabel: `ffmpeg 編碼 VP9 WebM（CRF ${opts.crf}）…`,
    buildArgs: (pattern, out) => buildWebmArgs(opts.crf, opts.fps, pattern, out),
  });
}

/**
 * Estimate the full WebM size by really encoding a CONSECUTIVE chunk and
 * extrapolating by output-frame count. VP9 is inter-frame compressed, so (unlike
 * the WebP muxer) a spread-out sample would wildly overestimate — we must encode
 * a contiguous run of the actual output cadence to capture temporal compression.
 * Taken from the middle of the clip (avoids any intro fade). A short sample is
 * slightly keyframe-heavy, so it errs on the safe side (a touch high).
 * @param {ImageData[]} frames  full-res keyed frames
 * @param {{scale:number, skip:number, fps:number, crf:number}} opts
 * @param {{onStatus?:Function, onProgress?:Function}} hooks
 * @param {number} sampleOut  max output frames to encode for the sample
 * @returns {Promise<{bytes:number, total:number, sampled:number}>}
 */
export async function estimateWebmBytes(frames, opts, hooks = {}, sampleOut = 24) {
  const { scale, skip, fps, crf } = opts;
  const outIdx = [];
  for (let i = 0; i < frames.length; i += skip) outIdx.push(i);
  const total = outIdx.length;
  if (total === 0) return { bytes: 0, total: 0, sampled: 0 };

  const win = Math.min(sampleOut, total);
  const start = Math.max(0, Math.floor((total - win) / 2)); // centre window
  const sub = outIdx.slice(start, start + win).map(i => frames[i]);

  // Encode the pre-selected consecutive output frames as their own clip (skip:1).
  const { blob } = await encodeWebm(sub, { scale, skip: 1, fps, crf }, hooks);
  const bytes = Math.round(blob.size * total / win);
  return { bytes, total, sampled: win };
}
