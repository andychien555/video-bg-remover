// ── MOV exporter (ffmpeg.wasm) ─────────────────────────────
// Encodes the keyed frames into a QuickTime .mov that preserves the alpha
// channel — the format pro editors (Premiere / FCP / After Effects) ingest
// cleanly, unlike alpha WebM.
//
// ffmpeg.wasm is heavy (~30 MB core) and unnecessary for the other formats, so
// it is lazy-loaded from a pinned jsDelivr version only on first MOV export and
// cached thereafter. We use the SINGLE-THREAD core on purpose: the multi-thread
// build needs SharedArrayBuffer (COOP/COEP headers), which GitHub Pages can't
// set. Single-thread is slower but it's the only variant that runs on the site.

// Pinned, long-stable versions (all 0.12.x, published well over a year ago).
// NOTE: the worker chunk is named `814.ffmpeg.js` for THIS exact wrapper
// version (0.12.10). If you bump FFMPEG_VER, check the new chunk filename in
// the package's dist/umd and update the classWorkerURL below to match.
const FFMPEG_VER = '0.12.10';   // @ffmpeg/ffmpeg  (wrapper + worker)
const UTIL_VER   = '0.12.1';    // @ffmpeg/util    (toBlobURL/fetchFile)
const CORE_VER   = '0.12.6';    // @ffmpeg/core    (single-thread wasm)
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

// ffmpeg args per codec. Both keep alpha; ProRes is the pro standard (large,
// slow), qtrle (QuickTime Animation) is lossless RLE — smaller and faster.
function buildArgs(codec, fps, pattern, out) {
  const fr = String(fps);
  // frames are written f00001.png… (1-based), so tell the image2 demuxer to start at 1
  const input = ['-framerate', fr, '-start_number', '1', '-i', pattern];
  if (codec === 'prores') {
    return [...input,
            '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le',
            '-vendor', 'apl0', out];
  }
  // 'png' option → QuickTime Animation (qtrle), lossless with alpha
  return [...input, '-c:v', 'qtrle', '-pix_fmt', 'argb', out];
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
 * Encode keyed frames to an alpha .mov blob.
 * @param {ImageData[]} frames  full-res keyed frames
 * @param {{scale:number, skip:number, fps:number, codec:'prores'|'png'}} opts
 * @param {{onStatus?:(msg:string)=>void, onProgress?:(ratio:number)=>void}} hooks
 * @returns {Promise<{blob:Blob, width:number, height:number, count:number}>}
 */
export async function encodeMov(frames, opts, hooks = {}) {
  const { scale, skip, fps, codec } = opts;
  const onStatus = hooks.onStatus || (() => {});
  const onProgress = hooks.onProgress || (() => {});

  const ffmpeg = await getFFmpeg(onStatus);

  const srcW = frames[0].width, srcH = frames[0].height;
  const doScale = scale !== 1;
  // even dimensions keep encoders happy (ProRes/qtrle prefer it)
  const gW = doScale ? Math.round(srcW * scale / 2) * 2 : srcW;
  const gH = doScale ? Math.round(srcH * scale / 2) * 2 : srcH;

  const full = document.createElement('canvas');
  full.width = srcW; full.height = srcH;
  const fullCtx = full.getContext('2d');
  const scaled = document.createElement('canvas');
  scaled.width = gW; scaled.height = gH;
  const scaledCtx = scaled.getContext('2d');

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
  onStatus(codec === 'prores' ? 'ffmpeg 編碼 ProRes 4444…' : 'ffmpeg 編碼 MOV…');
  const onFf = ({ progress }) => {
    if (progress >= 0 && progress <= 1) onProgress(0.45 + progress * 0.55);
  };
  ffmpeg.on('progress', onFf);

  const out = 'out.mov';
  const pattern = `f%0${pad}d.png`;
  let blob;
  try {
    await ffmpeg.exec(buildArgs(codec, fps, pattern, out));
    const data = await ffmpeg.readFile(out);
    blob = new Blob([data.buffer], { type: 'video/quicktime' });
  } finally {
    ffmpeg.off('progress', onFf);
    // Tidy the virtual FS so repeat exports don't accumulate frames.
    try {
      for (let fi = 0; fi < indices.length; fi++) await ffmpeg.deleteFile(nameOf(fi));
      await ffmpeg.deleteFile(out);
    } catch (_) { /* best-effort cleanup */ }
  }

  if (!blob || blob.size === 0) {
    throw new Error('編碼結果為空，此瀏覽器的 ffmpeg 核心可能不支援該編碼');
  }
  onProgress(1);
  return { blob, width: gW, height: gH, count: indices.length };
}
