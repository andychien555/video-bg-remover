// ── App wiring: DOM, state, video pipeline, exporters ──────
import { hexToRgb, applyKey, analyzeResidue, toAlphaView, RESIDUE_COLOR } from './keying.js';
import { encodeAnimatedWebP, estimateWebpBytes } from './webp-anim.js';
import { extractFrames, estimateMemoryBytes } from './pipeline.js';

// ── Constants ──────────────────────────────────────────────
const FPS = 30;
// Output frame-rate presets the UI offers. Each is an integer divisor of FPS,
// so skip = FPS / preset stays a clean integer (1, 2, 3, 5, 6).
const FPS_PRESETS = [30, 15, 10, 6, 5];
// Warn before processing if the keyed-frame buffer would exceed this much RAM
// (every frame is kept in memory for preview + export). ~1.2 GB ≈ the point
// where a long/HD clip starts risking an out-of-memory tab crash.
const MEMORY_WARN_BYTES = 1.2e9;

// ── DOM references ─────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = {
  fileInput: $('fileInput'),
  dropZone: $('dropZone'),
  dropPrompt: $('dropPrompt'),
  processBtn: $('processBtn'),
  downloadBtn: $('downloadBtn'),
  pngSeqBtn: $('pngSeqBtn'),
  downloadZipBtn: $('downloadZipBtn'),
  webpBtn: $('webpBtn'),
  downloadWebpBtn: $('downloadWebpBtn'),
  prog: $('prog'),
  progWrap: $('progWrap'),
  progLabel: $('progLabel'),
  feedback: $('feedback'),
  feedbackIcon: $('feedbackIcon'),
  feedbackText: $('feedbackText'),
  srcMeta: $('srcMeta'),
  video: $('hiddenVideo'),
  srcCanvas: $('srcCanvas'),
  outCanvas: $('outCanvas'),
  workCanvas: $('workCanvas'),
  previewBar: $('previewBar'),
  playBtn: $('playBtn'),
  scrubber: $('scrubber'),
  frameLabel: $('frameLabel'),
  outLabel: $('outLabel'),
  coordHint: $('coordHint'),
  colorPicker: $('colorPicker'),
  pickBtn: $('pickBtn'),
  chromaColorRow: $('chromaColorRow'),
  spillRow: $('spillRow'),
  threshLabel: $('threshLabel'),
  seqScale: $('seqScale'),
  seqWidthInput: $('seqWidthInput'),
  seqFps: $('seqFps'),
  webpQ: $('webpQ'),
  webpAlphaQ: $('webpAlphaQ'),
  cmdBox: $('cmdBox'),
  webpEstVal: $('webpEstVal'),
  webpEstNote: $('webpEstNote'),
  alphaBadge: $('alphaBadge'),
  residueVal: $('residueVal'),
  residueToggle: $('residueToggle'),
};
const srcCtx = el.srcCanvas.getContext('2d', { willReadFrequently: true });
const outCtx = el.outCanvas.getContext('2d');
const workCtx = el.workCanvas.getContext('2d', { willReadFrequently: true });

// ── Mutable state ──────────────────────────────────────────
let mode = 'luma';
let isPicking = false;
let outputBlob = null;   // webm
let zipBlob = null;      // png sequence zip
let webpBlob = null;     // animated webp
let processedFrames = [];
let previewIdx = 0;
let isPlaying = false;
let playRafId = null;
let lastPlayTs = null;
let busy = false;          // an export is running
let estTimer = null;       // debounce handle for the size estimate
let estToken = 0;          // guards against stale async estimate results
let alphaView = false;     // ALPHA badge toggles the alpha-matte preview
let highlightOn = false;   // 殘留 switch: persistently highlight residue pixels

// ── Mode tabs ──────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    mode = tab.dataset.mode;
    el.chromaColorRow.style.display = mode === 'chroma' ? 'flex' : 'none';
    el.spillRow.style.display = mode === 'chroma' ? 'flex' : 'none';
    el.threshLabel.childNodes[0].textContent =
      mode === 'luma' ? '黑色閾值（Threshold）' : '相似度（Similarity）';
    livePreview();
  });
});

// ── Upload ─────────────────────────────────────────────────
// click the prompt (not the whole stage) so picking color on a loaded frame still works
el.dropPrompt.addEventListener('click', () => el.fileInput.click());
el.dropZone.addEventListener('dragover', e => { e.preventDefault(); el.dropZone.classList.add('dragover'); });
el.dropZone.addEventListener('dragleave', () => el.dropZone.classList.remove('dragover'));
el.dropZone.addEventListener('drop', e => { e.preventDefault(); el.dropZone.classList.remove('dragover'); handleFile(e.dataTransfer.files[0]); });
el.fileInput.addEventListener('change', () => handleFile(el.fileInput.files[0]));

function handleFile(file) {
  if (!file || !file.type.startsWith('video/')) return;
  stopPlayback();
  stopLivePlayback();
  processedFrames = [];
  hideFeedback();
  el.progWrap.style.display = 'none';
  el.previewBar.style.display = 'none';
  outputBlob = zipBlob = webpBlob = null;
  el.downloadBtn.disabled = true;
  el.downloadZipBtn.disabled = true;
  el.downloadWebpBtn.disabled = true;
  el.webpEstVal.textContent = '—';
  el.webpEstNote.textContent = '估算中…';
  el.video.src = URL.createObjectURL(file);
  el.video.addEventListener('loadedmetadata', () => {
    const w = el.video.videoWidth, h = el.video.videoHeight;
    [el.srcCanvas, el.outCanvas, el.workCanvas].forEach(c => { c.width = w; c.height = h; });
    el.video.currentTime = 0.1;
  }, { once: true });
  el.video.addEventListener('seeked', () => {
    srcCtx.drawImage(el.video, 0, 0);
    el.dropZone.classList.add('has-media');
    configureWidthSlider(el.video.videoWidth);
    livePreview();
    // show the transport so you can preview (live-keyed) right after loading
    const n = videoFrameCount();
    el.previewBar.style.display = 'flex';
    el.scrubber.min = 0; el.scrubber.max = Math.max(1, n - 1); el.scrubber.step = 1; el.scrubber.value = 0;
    el.frameLabel.textContent = `1 / ${n}`;
    el.srcMeta.textContent = `${el.video.videoWidth}×${el.video.videoHeight} · ${el.video.duration.toFixed(2)}s · ${FPS}fps`;
    el.processBtn.disabled = false;
    el.pngSeqBtn.disabled = false;
    el.webpBtn.disabled = false;
  }, { once: true });
}

// ── Color picker ───────────────────────────────────────────
el.pickBtn.addEventListener('click', () => {
  isPicking = !isPicking;
  el.pickBtn.textContent = isPicking ? '點擊畫面...' : '從畫面取色';
  el.coordHint.textContent = isPicking ? '點擊左側畫面' : '';
});
el.srcCanvas.addEventListener('click', e => {
  if (!isPicking) return;
  const rect = el.srcCanvas.getBoundingClientRect();
  const x = Math.floor((e.clientX - rect.left) * el.srcCanvas.width / rect.width);
  const y = Math.floor((e.clientY - rect.top) * el.srcCanvas.height / rect.height);
  const px = srcCtx.getImageData(x, y, 1, 1).data;
  el.colorPicker.value =
    '#' + [px[0], px[1], px[2]].map(v => v.toString(16).padStart(2, '0')).join('');
  isPicking = false;
  el.pickBtn.textContent = '從畫面取色';
  el.coordHint.textContent = '';
  livePreview();
});
document.querySelectorAll('.preset').forEach(p => {
  p.addEventListener('click', () => {
    document.querySelectorAll('.preset').forEach(x => x.classList.remove('active'));
    p.classList.add('active');
    el.colorPicker.value = p.dataset.color;
    livePreview();
  });
});
el.colorPicker.addEventListener('input', livePreview);
['thresh', 'feather', 'shrink', 'spill', 'boost'].forEach(id => {
  const range = $(id + 'Range'), val = $(id + 'Val');
  range.addEventListener('input', () => {
    val.textContent = id === 'shrink' ? range.value : parseFloat(range.value).toFixed(2);
    livePreview();
  });
});

// ── Alpha-matte view toggle (ALPHA badge in the OUTPUT viewport) ──
if (el.alphaBadge) {
  const toggleAlpha = () => {
    alphaView = !alphaView;
    el.alphaBadge.classList.toggle('active', alphaView);
    el.alphaBadge.setAttribute('aria-pressed', String(alphaView));
    if (!isPlaying) livePreview();
  };
  el.alphaBadge.addEventListener('click', toggleAlpha);
  el.alphaBadge.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleAlpha(); }
  });
}

// ── Params ─────────────────────────────────────────────────
function getParams() {
  return {
    mode, keyColor: hexToRgb(el.colorPicker.value),
    thresh: parseFloat($('threshRange').value),
    feather: parseFloat($('featherRange').value),
    shrink: parseInt($('shrinkRange').value),
    spill: parseFloat($('spillRange').value),
    boost: parseFloat($('boostRange').value),
  };
}
function getSeqParams() {
  const srcW = el.video.videoWidth;
  // UI picks an output width in px; downstream still works in scale (= w / srcW)
  const scale = srcW ? parseInt(el.seqScale.value) / srcW : 1;
  return {
    scale,
    skip: Math.round(FPS / FPS_PRESETS[parseInt(el.seqFps.value)]),
    quality: parseInt(el.webpQ.value),
    alphaQuality: parseInt(el.webpAlphaQ.value),
  };
}

// Configure width controls against the loaded video: cap at source width (no upscaling)
function configureWidthSlider(srcW) {
  const minW = Math.min(64, srcW);
  [el.seqScale, el.seqWidthInput].forEach(c => { c.min = minW; c.max = srcW; c.step = 2; });
  el.seqScale.value = srcW;
  el.seqWidthInput.value = srcW;   // default = original size (100%)
  updateHeightHint();
}
// derive height from the current width + source aspect ratio
function updateHeightHint() {
  const srcW = el.video.videoWidth, srcH = el.video.videoHeight;
  $('seqHeightVal').textContent = srcW
    ? Math.round(srcH * parseInt(el.seqScale.value) / srcW)
    : '—';
}
// slider moved → mirror into the number field
function syncWidthFromSlider() {
  el.seqWidthInput.value = el.seqScale.value;
  updateHeightHint();
  scheduleEstimate();
}
// typed width → clamp to [min, src], snap even, drive the slider.
// writeBack=true (on blur/enter) rewrites the field with the clamped value.
function syncWidthFromInput(writeBack) {
  const srcW = el.video.videoWidth;
  if (!srcW) return;
  let w = parseInt(el.seqWidthInput.value);
  if (isNaN(w)) { if (writeBack) { el.seqWidthInput.value = el.seqScale.value; } return; }
  const minW = parseInt(el.seqScale.min), maxW = parseInt(el.seqScale.max);
  w = Math.max(minW, Math.min(maxW, Math.round(w / 2) * 2));
  el.seqScale.value = w;
  if (writeBack) el.seqWidthInput.value = w;
  updateHeightHint();
  scheduleEstimate();
}
function livePreview() {
  if (!el.srcCanvas.width) return;
  if (processedFrames.length > 0) { paintOutput(processedFrames[previewIdx]); return; }
  paintOutput(applyKey(srcCtx.getImageData(0, 0, el.srcCanvas.width, el.srcCanvas.height), getParams()));
  scheduleEstimate(); // keying params changed the frame → re-estimate size
}

// Decorate a keyed frame for the OUTPUT viewport: measure background residue,
// optionally highlight it (殘留 switch) or switch to the alpha matte view.
// Always works on a copy so stored processedFrames are never mutated.
function paintOutput(keyed) {
  const display = new ImageData(new Uint8ClampedArray(keyed.data), keyed.width, keyed.height);
  // analyzeResidue reads original RGB, so call it before toAlphaView destroys it.
  const highlight = highlightOn && !alphaView;
  const ratio = analyzeResidue(display, mode, highlight ? RESIDUE_COLOR : null);
  if (alphaView) toAlphaView(display);
  outCtx.putImageData(display, 0, 0);
  updateResidueReadout(ratio);
}

function updateResidueReadout(ratio) {
  if (!el.residueVal) return;
  const pct = ratio * 100;
  const clean = pct < 0.05;
  el.residueVal.textContent = clean ? '0.0% 乾淨' : pct.toFixed(1) + '%';
  el.residueVal.classList.toggle('clean', clean);
  el.residueVal.classList.toggle('dirty', !clean);
}

// ── Residue highlight switch (OUTPUT viewport) ──
if (el.residueToggle) {
  el.residueToggle.addEventListener('change', () => {
    highlightOn = el.residueToggle.checked;
    if (!isPlaying) livePreview();
  });
}

// ── Preview playback ───────────────────────────────────────
function showFrame(idx) {
  idx = Math.max(0, Math.min(processedFrames.length - 1, idx));
  previewIdx = idx;
  paintOutput(processedFrames[idx]);
  el.scrubber.value = idx;
  el.frameLabel.textContent = `${idx + 1} / ${processedFrames.length}`;
}
function stopPlayback() {
  if (playRafId) { cancelAnimationFrame(playRafId); playRafId = null; }
  isPlaying = false; el.playBtn.innerHTML = '&#9654;'; lastPlayTs = null;
}
function startPlayback() {
  if (!processedFrames.length) return;
  if (previewIdx >= processedFrames.length - 1) previewIdx = 0;
  isPlaying = true; el.playBtn.innerHTML = '&#9646;&#9646;';
  const msPerFrame = 1000 / FPS; lastPlayTs = null;
  function tick(ts) {
    if (!isPlaying) return;
    if (lastPlayTs === null) lastPlayTs = ts;
    if (ts - lastPlayTs >= msPerFrame) {
      lastPlayTs = ts; previewIdx++;
      if (previewIdx >= processedFrames.length) { showFrame(processedFrames.length - 1); stopPlayback(); return; }
      showFrame(previewIdx);
    }
    playRafId = requestAnimationFrame(tick);
  }
  playRafId = requestAnimationFrame(tick);
}
// ── Live preview · plays the source video and keys each frame on the fly ──
// Used before an export run (processedFrames empty); after a run we switch to
// the exact-frame playback above.
let isLivePlaying = false;
let liveRafId = null;

function videoFrameCount() {
  return Math.max(1, Math.round((el.video.duration || 0) * FPS));
}
// Draw the video's current frame into SOURCE, then key it into OUTPUT.
function liveDrawCurrent() {
  srcCtx.drawImage(el.video, 0, 0);
  livePreview();                       // key current srcCanvas → outCanvas
  const n = videoFrameCount();
  const f = Math.min(n - 1, Math.round(el.video.currentTime * FPS));
  el.scrubber.value = f;
  el.frameLabel.textContent = `${f + 1} / ${n}`;
}
function stopLivePlayback() {
  isLivePlaying = false;
  if (liveRafId != null) { cancelAnimationFrame(liveRafId); liveRafId = null; }
  if (!el.video.paused) el.video.pause();
  el.playBtn.innerHTML = '&#9654;';
}
function startLivePlayback() {
  if (!el.video.src) return;
  if (el.video.ended || el.video.currentTime >= el.video.duration - 0.05) el.video.currentTime = 0;
  isLivePlaying = true;
  el.playBtn.innerHTML = '&#9646;&#9646;';
  // Plain requestAnimationFrame loop — fires every frame regardless of whether
  // the video is composited, so it works for an offscreen video. Each tick draws
  // whatever frame the (decoding) video is currently on. The loop is NOT gated on
  // the play() promise; if the browser pauses us (e.g. a seek race), we re-issue
  // play() so playback self-heals instead of silently freezing.
  const tick = () => {
    if (!isLivePlaying) return;
    liveDrawCurrent();
    if (el.video.ended) { stopLivePlayback(); return; }
    if (el.video.paused) el.video.play().catch(() => {});
    liveRafId = requestAnimationFrame(tick);
  };
  el.video.play().catch(() => {});
  liveRafId = requestAnimationFrame(tick);
}
function seekLive(frame) {
  const t = Math.max(0, Math.min((el.video.duration || 0) - 0.001, frame / FPS));
  el.video.addEventListener('seeked', liveDrawCurrent, { once: true });
  el.video.currentTime = t;
}

// rVFC stops firing once the video ends, so reset the transport here
el.video.addEventListener('ended', () => { if (isLivePlaying) stopLivePlayback(); });

el.playBtn.addEventListener('click', () => {
  if (processedFrames.length) {        // exact-frame playback (post-export)
    isPlaying ? stopPlayback() : startPlayback();
  } else {                             // live-keyed preview (pre-export)
    isLivePlaying ? stopLivePlayback() : startLivePlayback();
  }
});
el.scrubber.addEventListener('input', () => {
  if (processedFrames.length) { stopPlayback(); showFrame(parseInt(el.scrubber.value)); }
  else { stopLivePlayback(); seekLive(parseInt(el.scrubber.value)); }
});

// ── Frame extraction (shared by every exporter) ────────────
// Plays the video and keys every frame in a Web Worker (see pipeline.js) — no
// per-frame seeking, no main-thread keying. Throws '__cancelled__' if the user
// declines the high-memory warning.
async function runFrames() {
  const p = getParams();
  const w = el.video.videoWidth, h = el.video.videoHeight;
  const duration = el.video.duration, totalFrames = Math.ceil(duration * FPS);

  const estBytes = estimateMemoryBytes(w, h, duration, FPS);
  if (estBytes > MEMORY_WARN_BYTES) {
    const gb = (estBytes / 1e9).toFixed(1);
    const ok = confirm(
      `此影片約 ${totalFrames} 幀（${w}×${h}），去背後預估佔用 ~${gb}GB 記憶體，` +
      `可能導致分頁崩潰。\n\n建議先調低「縮放」或縮短影片。仍要繼續嗎？`
    );
    if (!ok) throw new Error('__cancelled__');
  }

  processedFrames = [];
  el.progWrap.style.display = 'block'; el.prog.value = 0;
  el.progLabel.textContent = '逐幀處理中（播放抓幀 + Worker 去背）…';

  let lastPreview = 0;
  processedFrames = await extractFrames({
    video: el.video,
    ctx: workCtx,
    fps: FPS,
    params: p,
    onProgress: (done, total) => {
      const pct = Math.round((done / total) * 60);
      el.prog.value = pct;
      el.progLabel.textContent = `去背 ${done} / ${total}（${pct}%）`;
    },
    onFrameReady: (img, idx) => {
      // Throttled live preview so the user sees keying happen.
      if (idx - lastPreview >= 5) { lastPreview = idx; paintOutput(img); }
    },
  });

  el.prog.value = 60;
  el.previewBar.style.display = 'flex';
  el.scrubber.max = processedFrames.length - 1;
  showFrame(0);
  el.outLabel.textContent = '去背結果 — 可預覽';
  scheduleEstimate(); // now have real keyed frames → tighter estimate
}

// ── Export 1: transparent WebM (MediaRecorder) ─────────────
async function runProcess() {
  await runFrames();

  el.prog.value = 60;
  el.progLabel.textContent = '第二步：以精確 30fps 泵入 MediaRecorder…';
  await new Promise(r => setTimeout(r, 30));

  const stream = el.workCanvas.captureStream(FPS);
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9' : 'video/webm';
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 10_000_000 });
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  const recordDone = new Promise(resolve => { recorder.onstop = resolve; });
  recorder.start();

  const msPerFrame = 1000 / FPS;
  for (let f = 0; f < processedFrames.length; f++) {
    const startT = performance.now();
    workCtx.putImageData(processedFrames[f], 0, 0);
    const wait = Math.max(0, msPerFrame - (performance.now() - startT));
    await new Promise(r => setTimeout(r, wait));
    const pct = 60 + Math.round((f / processedFrames.length) * 39);
    el.prog.value = pct;
    el.progLabel.textContent = `錄製中 ${f + 1} / ${processedFrames.length}（${pct}%）`;
  }

  recorder.stop();
  await recordDone;

  outputBlob = new Blob(chunks, { type: 'video/webm' });
  el.prog.value = 100;
  showFeedback('success', `透明 WebM 完成 · ${processedFrames.length} 幀 @ ${FPS}fps`);
  el.downloadBtn.disabled = false;
}

el.processBtn.addEventListener('click', async () => {
  stopPlayback();
  setBusy(true);
  outputBlob = null;
  try { await runProcess(); }
  catch (e) { reportError('錯誤：', e); }
  setBusy(false);
});
el.downloadBtn.addEventListener('click', () => { if (outputBlob) triggerDownload(outputBlob, 'removed-bg.webm'); });

// ── Export 2: animated WebP (the headline feature) ─────────
el.webpBtn.addEventListener('click', async () => {
  stopPlayback();
  setBusy(true);
  webpBlob = null;
  el.downloadWebpBtn.disabled = true;
  el.cmdBox.style.display = 'none';
  try {
    if (!processedFrames.length) await runFrames();
    const { scale, skip, quality, alphaQuality } = getSeqParams();
    el.progWrap.style.display = 'block';
    el.progLabel.textContent = '合成動態 WebP 中（libwebp WASM）…';
    webpBlob = await encodeAnimatedWebP(processedFrames, {
      fps: FPS, quality, scale, skip, alphaQuality,
      onProgress: (done, total) => {
        el.prog.value = 60 + Math.round((done / total) * 40);
        el.progLabel.textContent = `編碼 WebP 影格 ${done} / ${total}`;
      },
    });
    el.prog.value = 100;
    const sizeMB = (webpBlob.size / 1024 / 1024).toFixed(2);
    const frameCount = Math.ceil(processedFrames.length / skip);
    showFeedback('success', `動態 WebP 完成 · ${frameCount} 幀 · ${sizeMB}MB · 已自動下載`);
    el.downloadWebpBtn.disabled = false;
    triggerDownload(webpBlob, 'anim.webp'); // fully automatic download
  } catch (e) {
    reportError('動態 WebP 錯誤：', e);
  }
  setBusy(false);
});
el.downloadWebpBtn.addEventListener('click', () => { if (webpBlob) triggerDownload(webpBlob, 'anim.webp'); });

// ── Export 3: PNG sequence (ZIP) + reference img2webp command ──
function buildImg2webpCmd(skip, quality) {
  const durationMs = Math.round((skip / FPS) * 1000);
  return `img2webp -loop 0 -q ${quality} -d ${durationMs} frame_*.png -o anim.webp`;
}

async function exportPngSequence(frames) {
  const { scale, skip, quality } = getSeqParams();
  const gW = Math.round(frames[0].width * scale);
  const gH = Math.round(frames[0].height * scale);

  el.progWrap.style.display = 'block';
  el.prog.value = 0;
  el.progLabel.textContent = 'PNG 序列匯出中…';
  el.cmdBox.style.display = 'none';

  const zip = new JSZip();
  const scaled = document.createElement('canvas');
  scaled.width = gW; scaled.height = gH;
  const scaledCtx = scaled.getContext('2d');
  const full = document.createElement('canvas');
  full.width = frames[0].width; full.height = frames[0].height;
  const fullCtx = full.getContext('2d');

  const indices = [];
  for (let i = 0; i < frames.length; i += skip) indices.push(i);
  const pad = String(indices.length).length;

  for (let fi = 0; fi < indices.length; fi++) {
    fullCtx.putImageData(frames[indices[fi]], 0, 0);
    if (scale !== 1) {
      scaledCtx.clearRect(0, 0, gW, gH);
      scaledCtx.drawImage(full, 0, 0, gW, gH);
    }
    const srcCanvasEl = scale !== 1 ? scaled : full;
    const blob = await new Promise(r => srcCanvasEl.toBlob(r, 'image/png'));
    const name = `frame_${String(fi + 1).padStart(pad, '0')}.png`;
    zip.file(name, blob);
    el.prog.value = Math.round((fi / indices.length) * 70);
    el.progLabel.textContent = `產生 PNG ${fi + 1} / ${indices.length}`;
    if (fi % 5 === 0) await new Promise(r => setTimeout(r, 0));
  }

  el.progLabel.textContent = '壓縮 ZIP 中...';
  zipBlob = await zip.generateAsync(
    { type: 'blob', compression: 'STORE' }, // PNG already compressed; STORE is faster
    meta => { el.prog.value = 70 + Math.round(meta.percent * 0.3); }
  );

  el.prog.value = 100;
  const zipMB = (zipBlob.size / 1024 / 1024).toFixed(1);
  showFeedback('success', `PNG 序列完成 · ${indices.length} 張 · ${gW}×${gH} · ${zipMB}MB`);
  el.downloadZipBtn.disabled = false;

  el.cmdBox.textContent = '$ ' + buildImg2webpCmd(skip, quality);
  el.cmdBox.style.display = 'block';
}

el.pngSeqBtn.addEventListener('click', async () => {
  stopPlayback();
  setBusy(true);
  zipBlob = null;
  try {
    if (!processedFrames.length) await runFrames();
    await exportPngSequence(processedFrames);
  } catch (e) { reportError('PNG 序列錯誤：', e); }
  setBusy(false);
});
el.downloadZipBtn.addEventListener('click', () => { if (zipBlob) triggerDownload(zipBlob, 'frames.zip'); });

// ── Sequence option labels ─────────────────────────────────
el.seqScale.addEventListener('input', syncWidthFromSlider);
el.seqWidthInput.addEventListener('input', () => syncWidthFromInput(false));
el.seqWidthInput.addEventListener('change', () => syncWidthFromInput(true));
el.seqFps.addEventListener('input', e => { $('seqFpsVal').textContent = FPS_PRESETS[parseInt(e.target.value)] + 'fps'; scheduleEstimate(); });
el.webpQ.addEventListener('input', e => { $('webpQVal').textContent = e.target.value; scheduleEstimate(); });
el.webpAlphaQ.addEventListener('input', e => { $('webpAlphaQVal').textContent = e.target.value; scheduleEstimate(); });

// ── Shared helpers ─────────────────────────────────────────
// The single feedback zone (replaces the old footer). `state` drives hue + glyph:
// 'success' (green ✓) · 'error' (red ✕) · 'info' (neutral). Showing it also
// collapses the progress bar, so the panel only ever has one active readout.
const FEEDBACK_GLYPH = { success: '✓', error: '✕', info: 'i' };
function showFeedback(state, text) {
  el.progWrap.style.display = 'none';
  el.feedback.className = 'feedback show is-' + state;
  el.feedbackIcon.textContent = FEEDBACK_GLYPH[state] || 'i';
  el.feedbackText.textContent = text;
}
// Reset feedback before a new run.
function hideFeedback() {
  el.feedback.classList.remove('show');
}

// Surface an export failure, but treat the high-memory cancel as a calm "已取消".
function reportError(prefix, e) {
  if (e && e.message === '__cancelled__') { showFeedback('info', '已取消'); return; }
  showFeedback('error', prefix + e.message);
  console.error(e);
}

function triggerDownload(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

// Disable every action button while one export is running.
function setBusy(running) {
  busy = running;
  if (running) hideFeedback(); // drop any prior feedback when a new run starts
  el.processBtn.disabled = running;
  el.pngSeqBtn.disabled = running;
  el.webpBtn.disabled = running;
  if (running) {
    el.downloadBtn.disabled = true;
    el.downloadZipBtn.disabled = true;
    el.downloadWebpBtn.disabled = true;
  } else {
    el.downloadBtn.disabled = !outputBlob;
    el.downloadZipBtn.disabled = !zipBlob;
    el.downloadWebpBtn.disabled = !webpBlob;
    scheduleEstimate(); // refresh estimate once the worker frees up
  }
}

// ── Live animated-WebP size estimate ───────────────────────
function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

// Debounced — slider drags fire rapidly; only estimate once they settle.
function scheduleEstimate() {
  if (estTimer) clearTimeout(estTimer);
  estTimer = setTimeout(updateEstimate, 220);
}

async function updateEstimate() {
  if (busy) return;                       // don't compete with a running export
  if (!el.srcCanvas.width) { el.webpEstVal.textContent = '—'; return; }
  const token = ++estToken;               // newest request wins
  const { scale, skip, quality, alphaQuality } = getSeqParams();

  // Pick representative frames + how many frames the real export will have.
  let sampleFrames, outputFrameCount;
  if (processedFrames.length) {
    const mid = processedFrames.length >> 1, last = processedFrames.length - 1;
    sampleFrames = [...new Set([0, mid, last])].map(i => processedFrames[i]);
    outputFrameCount = Math.ceil(processedFrames.length / skip);
  } else {
    // Pre-processing: estimate from the current keyed preview frame.
    const keyed = applyKey(srcCtx.getImageData(0, 0, el.srcCanvas.width, el.srcCanvas.height), getParams());
    sampleFrames = [keyed];
    const totalFrames = Math.ceil(el.video.duration * FPS);
    outputFrameCount = Math.max(1, Math.ceil(totalFrames / skip));
  }

  el.webpEstVal.classList.add('is-stale');
  el.webpEstNote.textContent = '估算中…';
  try {
    const { bytes, frameCount } = await estimateWebpBytes(sampleFrames, { quality, scale, alphaQuality }, outputFrameCount);
    if (token !== estToken) return;       // superseded by a newer request
    el.webpEstVal.textContent = '≈ ' + formatSize(bytes);
    el.webpEstVal.classList.remove('is-stale');
    el.webpEstNote.textContent = `${frameCount} 幀 · ${processedFrames.length ? '已去背取樣' : '預估'}`;
  } catch (e) {
    if (token !== estToken) return;
    el.webpEstNote.textContent = '估算失敗';
    console.error(e);
  }
}
