// ── App wiring: DOM, state, video pipeline, exporters ──────
import { hexToRgb, applyKey, analyzeResidue, toAlphaView, RESIDUE_COLOR } from './keying.js';
import { encodeAnimatedWebP, estimateWebpBytes } from './webp-anim.js';
import { encodeAnimatedGif, estimateGifBytes } from './gif-anim.js';
import { extractFrames, estimateMemoryBytes } from './pipeline.js';
import { encodeMov, encodeWebm, estimateWebmBytes } from './mov-encoder.js';

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
  reuploadBtn: $('reuploadBtn'),
  processBtn: $('processBtn'),
  downloadBtn: $('downloadBtn'),
  pngSeqBtn: $('pngSeqBtn'),
  downloadZipBtn: $('downloadZipBtn'),
  webpBtn: $('webpBtn'),
  downloadWebpBtn: $('downloadWebpBtn'),
  gifBtn: $('gifBtn'),
  downloadGifBtn: $('downloadGifBtn'),
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
  gifScale: $('gifScale'),
  gifWidthInput: $('gifWidthInput'),
  gifFps: $('gifFps'),
  gifTransparent: $('gifTransparent'),
  gifMatteColor: $('gifMatteColor'),
  gifMatteRow: $('gifMatteRow'),
  gifTransLabel: $('gifTransLabel'),
  gifDither: $('gifDither'),
  gifEstVal: $('gifEstVal'),
  gifEstNote: $('gifEstNote'),
  pngEstVal: $('pngEstVal'),
  pngEstNote: $('pngEstNote'),
  webmEstVal: $('webmEstVal'),
  webmEstNote: $('webmEstNote'),
  webmScale: $('webmScale'),
  webmWidthInput: $('webmWidthInput'),
  webmFps: $('webmFps'),
  webmCrf: $('webmCrf'),
  webmEstBtn: $('webmEstBtn'),
  tabSizeImage: $('tabSizeImage'),
  tabSizeGif: $('tabSizeGif'),
  tabSizeWebm: $('tabSizeWebm'),
  tabSizeMov: $('tabSizeMov'),
  movScale: $('movScale'),
  movWidthInput: $('movWidthInput'),
  movFps: $('movFps'),
  movCodec: $('movCodec'),
  movBtn: $('movBtn'),
  downloadMovBtn: $('downloadMovBtn'),
  movEstVal: $('movEstVal'),
  movEstNote: $('movEstNote'),
  alphaBadge: $('alphaBadge'),
  residueVal: $('residueVal'),
  residueToggle: $('residueToggle'),
  themeToggle: $('themeToggle'),
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
let gifBlob = null;      // animated gif
let movBlob = null;      // alpha QuickTime (.mov, via ffmpeg.wasm)
let webmEstBytes = null; // last known WebM size (sample estimate or real export)
let webmEstKey = '';     // settings fingerprint the size was computed for (stale check)
let webmEstExact = false;// true if webmEstBytes came from a real export, not a sample
let processedFrames = [];
let previewIdx = 0;
let isPlaying = false;
let playRafId = null;
let lastPlayTs = null;
let busy = false;          // an export is running
let estTimer = null;       // debounce handle for the size estimate
let estToken = 0;          // guards against stale async estimate results
let gifEstToken = 0;       // same staleness guard for the independent GIF estimate
let pngEstToken = 0;       // …and for the PNG/ZIP estimate
let alphaView = false;     // ALPHA badge toggles the alpha-matte preview
let highlightOn = false;   // 殘留 switch: persistently highlight residue pixels
let baseName = 'output';   // uploaded file's name (sans extension); used for download filenames

// ── Theme toggle ───────────────────────────────────────────
// initial data-theme is set by the inline <head> script (no-FOUC); here we
// just flip + persist the user's choice on click.
el.themeToggle.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch (e) { /* private mode: skip persist */ }
});

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
// "上傳其他影片" in the SOURCE second row (visible once a clip is loaded) → pick a
// replacement. Clear value first so re-selecting the same filename still fires `change`.
el.reuploadBtn.addEventListener('click', () => { el.fileInput.value = ''; el.fileInput.click(); });
el.dropZone.addEventListener('dragover', e => { e.preventDefault(); el.dropZone.classList.add('dragover'); });
el.dropZone.addEventListener('dragleave', () => el.dropZone.classList.remove('dragover'));
el.dropZone.addEventListener('drop', e => { e.preventDefault(); el.dropZone.classList.remove('dragover'); handleFile(e.dataTransfer.files[0]); });
el.fileInput.addEventListener('change', () => handleFile(el.fileInput.files[0]));

function handleFile(file) {
  if (!file || !file.type.startsWith('video/')) return;
  baseName = file.name.replace(/\.[^.]+$/, '') || 'output'; // strip extension; keep original name
  stopPlayback();
  stopLivePlayback();
  processedFrames = [];
  hideFeedback();
  el.progWrap.style.display = 'none';
  el.previewBar.style.display = 'none';
  outputBlob = zipBlob = webpBlob = gifBlob = movBlob = null;
  webmEstBytes = null; webmEstKey = ''; webmEstExact = false;
  el.downloadBtn.disabled = true;
  el.downloadZipBtn.disabled = true;
  el.downloadWebpBtn.disabled = true;
  el.downloadGifBtn.disabled = true;
  el.downloadMovBtn.disabled = true;
  el.webpEstVal.textContent = '—';
  el.webpEstNote.textContent = '估算中…';
  el.gifEstVal.textContent = '—';
  el.gifEstNote.textContent = '估算中…';
  el.pngEstVal.textContent = '—';
  el.pngEstNote.textContent = '估算中…';
  el.webmEstVal.textContent = '—';
  el.webmEstNote.textContent = '估算中…';
  el.movEstVal.textContent = '—';
  el.movEstNote.textContent = '估算中…';
  el.tabSizeImage.textContent = el.tabSizeGif.textContent = el.tabSizeWebm.textContent = el.tabSizeMov.textContent = '—';
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
    el.webmEstBtn.disabled = false;
    el.pngSeqBtn.disabled = false;
    el.webpBtn.disabled = false;
    el.gifBtn.disabled = false;
    el.movBtn.disabled = false;
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
// GIF has its own independent settings (width / fps / transparency / dither),
// separate from the shared WebP + PNG block above.
function getGifParams() {
  const srcW = el.video.videoWidth;
  const scale = srcW ? parseInt(el.gifScale.value) / srcW : 1;
  const hex = el.gifMatteColor.value;
  const matte = [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  return {
    scale,
    skip: Math.round(FPS / FPS_PRESETS[parseInt(el.gifFps.value)]),
    transparent: el.gifTransparent.checked,
    matte,
    dither: el.gifDither.checked,
  };
}

// WebM has its own width / fps / CRF (compression). VP9-alpha via ffmpeg.wasm.
function getWebmParams() {
  const srcW = el.video.videoWidth;
  const scale = srcW ? parseInt(el.webmScale.value) / srcW : 1;
  return {
    scale,
    skip: Math.round(FPS / FPS_PRESETS[parseInt(el.webmFps.value)]),
    fps: FPS_PRESETS[parseInt(el.webmFps.value)],
    crf: parseInt(el.webmCrf.value),
  };
}

// MOV has its own width / fps / codec, like GIF.
function getMovParams() {
  const srcW = el.video.videoWidth;
  const scale = srcW ? parseInt(el.movScale.value) / srcW : 1;
  return {
    scale,
    skip: Math.round(FPS / FPS_PRESETS[parseInt(el.movFps.value)]),
    fps: FPS_PRESETS[parseInt(el.movFps.value)],
    codec: el.movCodec.value, // 'prores' | 'png'
  };
}

// Configure width controls against the loaded video: cap at source width (no upscaling)
function configureWidthSlider(srcW) {
  const minW = Math.min(64, srcW);
  [el.seqScale, el.seqWidthInput, el.gifScale, el.gifWidthInput,
   el.movScale, el.movWidthInput, el.webmScale, el.webmWidthInput]
    .forEach(c => { c.min = minW; c.max = srcW; c.step = 2; });
  el.seqScale.value = srcW;
  el.seqWidthInput.value = srcW;   // default = original size (100%)
  // GIF defaults a bit smaller — GIF files are big, and full-res is rarely wanted.
  const gifDefault = Math.max(minW, Math.min(srcW, Math.round(srcW / 2 / 2) * 2));
  el.gifScale.value = gifDefault;
  el.gifWidthInput.value = gifDefault;
  // MOV defaults to full size (it's the pro/editing output).
  el.movScale.value = srcW;
  el.movWidthInput.value = srcW;
  // WebM defaults to full size; CRF does the size work, not downscaling.
  el.webmScale.value = srcW;
  el.webmWidthInput.value = srcW;
  updateHeightHint();
}
// derive height from the current width + source aspect ratio
function updateHeightHint() {
  const srcW = el.video.videoWidth, srcH = el.video.videoHeight;
  $('seqHeightVal').textContent = srcW
    ? Math.round(srcH * parseInt(el.seqScale.value) / srcW)
    : '—';
  $('gifHeightVal').textContent = srcW
    ? Math.round(srcH * parseInt(el.gifScale.value) / srcW)
    : '—';
  $('movHeightVal').textContent = srcW
    ? Math.round(srcH * parseInt(el.movScale.value) / srcW)
    : '—';
  $('webmHeightVal').textContent = srcW
    ? Math.round(srcH * parseInt(el.webmScale.value) / srcW)
    : '—';
}
// slider moved → mirror into the number field (shared by WebP + GIF width rows)
function syncWidthFromSlider(slider, input) {
  input.value = slider.value;
  updateHeightHint();
  scheduleEstimate();
}
// typed width → clamp to [min, src], snap even, drive the slider.
// writeBack=true (on blur/enter) rewrites the field with the clamped value.
function syncWidthFromInput(slider, input, writeBack) {
  const srcW = el.video.videoWidth;
  if (!srcW) return;
  let w = parseInt(input.value);
  if (isNaN(w)) { if (writeBack) { input.value = slider.value; } return; }
  const minW = parseInt(slider.min), maxW = parseInt(slider.max);
  w = Math.max(minW, Math.min(maxW, Math.round(w / 2) * 2));
  slider.value = w;
  if (writeBack) input.value = w;
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

// ── Export 1: compressed transparent WebM (ffmpeg.wasm · VP9 + CRF) ─
async function runWebm() {
  const params = getWebmParams();
  el.progWrap.style.display = 'block';
  el.prog.value = 0;
  el.progLabel.textContent = 'WebM 準備中…';

  const { blob, width, height, count } = await encodeWebm(processedFrames, params, {
    onStatus: msg => { el.progLabel.textContent = msg; },
    onProgress: ratio => { el.prog.value = Math.round(ratio * 100); },
  });

  outputBlob = blob;
  el.prog.value = 100;
  showFeedback('success', `透明 WebM 完成 · VP9 CRF ${params.crf} · ${count} 幀 · ${width}×${height} · ${formatSize(blob.size)}`);
  // CRF size is content-dependent (no formula); record the REAL size as the
  // current estimate so the bar/badge show it (and stay fresh for these settings).
  webmEstBytes = blob.size; webmEstKey = webmKey().key; webmEstExact = true;
  setEstimate(el.webmEstVal, el.tabSizeWebm, '≈ ' + formatSizeMB(blob.size));
  el.downloadBtn.disabled = false;
}

el.processBtn.addEventListener('click', async () => {
  stopPlayback();
  setBusy(true);
  outputBlob = null;
  el.downloadBtn.disabled = true;
  try {
    if (!processedFrames.length) await runFrames();
    await runWebm();
  } catch (e) { reportError('WebM 錯誤：', e); }
  setBusy(false);
});
el.downloadBtn.addEventListener('click', () => { if (outputBlob) triggerDownload(outputBlob, `${baseName}-nobg.webm`); });

// Estimate the WebM size by sample-encoding a consecutive chunk (VP9 is
// inter-frame compressed, so no formula — see estimateWebmBytes). Needs keyed
// frames + the ffmpeg core (shared with MOV), hence it's an explicit action.
el.webmEstBtn.addEventListener('click', async () => {
  stopPlayback();
  setBusy(true);
  try {
    if (!processedFrames.length) await runFrames();
    const params = getWebmParams();
    el.progWrap.style.display = 'block';
    el.prog.value = 0;
    el.progLabel.textContent = 'WebM 取樣估算中…';
    const { bytes, total, sampled } = await estimateWebmBytes(processedFrames, params, {
      onStatus: msg => { el.progLabel.textContent = msg; },
      onProgress: ratio => { el.prog.value = Math.round(ratio * 100); },
    });
    webmEstBytes = bytes; webmEstKey = webmKey().key; webmEstExact = false;
    setEstimate(el.webmEstVal, el.tabSizeWebm, '≈ ' + formatSizeMB(bytes));
    showFeedback('info', `WebM 估算 ≈ ${formatSizeMB(bytes)}（取樣 ${sampled}/${total} 幀外插 · CRF ${params.crf}）`);
  } catch (e) { reportError('WebM 估算錯誤：', e); }
  setBusy(false);
});

// ── Export 1b: transparent MOV (ffmpeg.wasm) ───────────────
async function runMov() {
  const params = getMovParams();
  el.progWrap.style.display = 'block';
  el.prog.value = 0;
  el.progLabel.textContent = 'MOV 準備中…';

  const { blob, width, height, count } = await encodeMov(processedFrames, params, {
    onStatus: msg => { el.progLabel.textContent = msg; },
    onProgress: ratio => { el.prog.value = Math.round(ratio * 100); },
  });

  movBlob = blob;
  el.prog.value = 100;
  const codecName = params.codec === 'prores' ? 'ProRes 4444' : 'QuickTime Animation';
  showFeedback('success', `透明 MOV 完成 · ${codecName} · ${count} 幀 · ${width}×${height} · ${formatSize(blob.size)}`);
  // qtrle has no formula estimate, so surface the real size in its badge once known.
  if (params.codec !== 'prores') setEstimate(el.movEstVal, el.tabSizeMov, formatSizeMB(blob.size));
  el.downloadMovBtn.disabled = false;
}

el.movBtn.addEventListener('click', async () => {
  stopPlayback();
  setBusy(true);
  movBlob = null;
  el.downloadMovBtn.disabled = true;
  try {
    if (!processedFrames.length) await runFrames();
    await runMov();
  } catch (e) { reportError('MOV 錯誤：', e); }
  setBusy(false);
});
el.downloadMovBtn.addEventListener('click', () => { if (movBlob) triggerDownload(movBlob, `${baseName}-nobg.mov`); });

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
    const frameCount = Math.ceil(processedFrames.length / skip);
    showFeedback('success', `動態 WebP 完成 · ${frameCount} 幀 · ${formatSize(webpBlob.size)} · 已自動下載`);
    el.downloadWebpBtn.disabled = false;
    triggerDownload(webpBlob, `${baseName}-nobg.webp`); // fully automatic download
  } catch (e) {
    reportError('動態 WebP 錯誤：', e);
  }
  setBusy(false);
});
el.downloadWebpBtn.addEventListener('click', () => { if (webpBlob) triggerDownload(webpBlob, `${baseName}-nobg.webp`); });

// ── Export 2b: animated GIF (max compatibility, 256 colours, 1-bit alpha) ──
el.gifBtn.addEventListener('click', async () => {
  stopPlayback();
  setBusy(true);
  gifBlob = null;
  el.downloadGifBtn.disabled = true;
  try {
    if (!processedFrames.length) await runFrames();
    const { scale, skip, transparent, matte, dither } = getGifParams();
    el.progWrap.style.display = 'block';
    el.progLabel.textContent = '合成動態 GIF 中（256 色量化）…';
    gifBlob = await encodeAnimatedGif(processedFrames, {
      fps: FPS, scale, skip, transparent, matte, dither,
      onProgress: (done, total) => {
        el.prog.value = 60 + Math.round((done / total) * 40);
        el.progLabel.textContent = `編碼 GIF 影格 ${done} / ${total}`;
      },
    });
    el.prog.value = 100;
    const frameCount = Math.ceil(processedFrames.length / skip);
    const bg = transparent ? '透明' : '純色底';
    showFeedback('success', `動態 GIF 完成 · ${frameCount} 幀 · ${bg} · ${formatSize(gifBlob.size)} · 已自動下載`);
    el.downloadGifBtn.disabled = false;
    triggerDownload(gifBlob, `${baseName}-nobg.gif`); // fully automatic download
  } catch (e) {
    reportError('動態 GIF 錯誤：', e);
  }
  setBusy(false);
});
el.downloadGifBtn.addEventListener('click', () => { if (gifBlob) triggerDownload(gifBlob, `${baseName}-nobg.gif`); });

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
  showFeedback('success', `PNG 序列完成 · ${indices.length} 張 · ${gW}×${gH} · ${formatSize(zipBlob.size)}`);
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
el.downloadZipBtn.addEventListener('click', () => { if (zipBlob) triggerDownload(zipBlob, `${baseName}-frames.zip`); });

// ── Sequence option labels (shared WebP + PNG) ─────────────
el.seqScale.addEventListener('input', () => syncWidthFromSlider(el.seqScale, el.seqWidthInput));
el.seqWidthInput.addEventListener('input', () => syncWidthFromInput(el.seqScale, el.seqWidthInput, false));
el.seqWidthInput.addEventListener('change', () => syncWidthFromInput(el.seqScale, el.seqWidthInput, true));
el.seqFps.addEventListener('input', e => { $('seqFpsVal').textContent = FPS_PRESETS[parseInt(e.target.value)] + 'fps'; scheduleEstimate(); });
el.webpQ.addEventListener('input', e => { $('webpQVal').textContent = e.target.value; scheduleEstimate(); });
el.webpAlphaQ.addEventListener('input', e => { $('webpAlphaQVal').textContent = e.target.value; scheduleEstimate(); });

// ── GIF option labels (independent settings) ───────────────
el.gifScale.addEventListener('input', () => syncWidthFromSlider(el.gifScale, el.gifWidthInput));
el.gifWidthInput.addEventListener('input', () => syncWidthFromInput(el.gifScale, el.gifWidthInput, false));
el.gifWidthInput.addEventListener('change', () => syncWidthFromInput(el.gifScale, el.gifWidthInput, true));
el.gifFps.addEventListener('input', e => { $('gifFpsVal').textContent = FPS_PRESETS[parseInt(e.target.value)] + 'fps'; scheduleEstimate(); });
el.gifDither.addEventListener('change', scheduleEstimate);
el.gifMatteColor.addEventListener('input', scheduleEstimate);
el.gifTransparent.addEventListener('change', () => {
  // Toggle the matte-colour row + relabel, then re-estimate (transparency
  // changes both quality and size).
  const transparent = el.gifTransparent.checked;
  el.gifMatteRow.style.display = transparent ? 'none' : 'flex';
  el.gifTransLabel.textContent = transparent ? '透明背景' : '純色底';
  scheduleEstimate();
});

// ── MOV option labels (independent settings; no live estimate — size is
// only known after the ffmpeg encode) ─────────────────────
el.movScale.addEventListener('input', () => { el.movWidthInput.value = el.movScale.value; updateHeightHint(); scheduleEstimate(); });
el.movWidthInput.addEventListener('input', () => syncMovWidthFromInput(false));
el.movWidthInput.addEventListener('change', () => syncMovWidthFromInput(true));
el.movFps.addEventListener('input', e => { $('movFpsVal').textContent = FPS_PRESETS[parseInt(e.target.value)] + 'fps'; scheduleEstimate(); });
el.movCodec.addEventListener('change', scheduleEstimate);
function syncMovWidthFromInput(writeBack) {
  const srcW = el.video.videoWidth;
  if (!srcW) return;
  let w = parseInt(el.movWidthInput.value);
  if (isNaN(w)) { if (writeBack) el.movWidthInput.value = el.movScale.value; return; }
  const minW = parseInt(el.movScale.min), maxW = parseInt(el.movScale.max);
  w = Math.max(minW, Math.min(maxW, Math.round(w / 2) * 2));
  el.movScale.value = w;
  if (writeBack) el.movWidthInput.value = w;
  updateHeightHint();
  scheduleEstimate();
}

// ── WebM option labels (VP9 + CRF; no live formula — CRF size is only known
// after the ffmpeg encode, like qtrle) ────────────────────
el.webmScale.addEventListener('input', () => { el.webmWidthInput.value = el.webmScale.value; updateHeightHint(); scheduleEstimate(); });
el.webmWidthInput.addEventListener('input', () => syncWebmWidthFromInput(false));
el.webmWidthInput.addEventListener('change', () => syncWebmWidthFromInput(true));
el.webmFps.addEventListener('input', e => { $('webmFpsVal').textContent = FPS_PRESETS[parseInt(e.target.value)] + 'fps'; scheduleEstimate(); });
el.webmCrf.addEventListener('input', e => {
  const crf = parseInt(e.target.value);
  $('webmCrfVal').textContent = crf;
  // hint which way the trade-off leans at the current value
  $('webmCrfHint').textContent = crf <= 26 ? '較清晰' : crf >= 38 ? '更小' : '較小';
  scheduleEstimate();
});
function syncWebmWidthFromInput(writeBack) {
  const srcW = el.video.videoWidth;
  if (!srcW) return;
  let w = parseInt(el.webmWidthInput.value);
  if (isNaN(w)) { if (writeBack) el.webmWidthInput.value = el.webmScale.value; return; }
  const minW = parseInt(el.webmScale.min), maxW = parseInt(el.webmScale.max);
  w = Math.max(minW, Math.min(maxW, Math.round(w / 2) * 2));
  el.webmScale.value = w;
  if (writeBack) el.webmWidthInput.value = w;
  updateHeightHint();
  scheduleEstimate();
}

// ── Export format tabs (WebP/PNG · GIF · WebM · MOV) ───────
// Each tab reveals only its settings group; estimates keep running for all
// formats in the background, so the size badges + each panel stay current.
const exportTabs = document.querySelectorAll('.etab');
const fmtPanels = document.querySelectorAll('.fmt-panel');
exportTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const fmt = tab.dataset.fmt;
    exportTabs.forEach(t => {
      const on = t === tab;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
    });
    fmtPanels.forEach(p => { p.hidden = p.dataset.fmt !== fmt; });
  });
});

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
  el.webmEstBtn.disabled = running;
  el.pngSeqBtn.disabled = running;
  el.webpBtn.disabled = running;
  el.gifBtn.disabled = running;
  el.movBtn.disabled = running;
  if (running) {
    el.downloadBtn.disabled = true;
    el.downloadZipBtn.disabled = true;
    el.downloadWebpBtn.disabled = true;
    el.downloadGifBtn.disabled = true;
    el.downloadMovBtn.disabled = true;
  } else {
    el.downloadBtn.disabled = !outputBlob;
    el.downloadZipBtn.disabled = !zipBlob;
    el.downloadWebpBtn.disabled = !webpBlob;
    el.downloadGifBtn.disabled = !gifBlob;
    el.downloadMovBtn.disabled = !movBlob;
    scheduleEstimate(); // refresh estimate once the worker frees up
  }
}

// ── Live size estimates (WebP + GIF, each format its own line) ─────
function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

// Estimates + tab badges always read in MB (no KB) so the unit never flips
// between formats; tiny outputs floor to a "< 0.01 MB" hint instead of KB.
function formatSizeMB(bytes) {
  const mb = bytes / 1024 / 1024;
  if (mb > 0 && mb < 0.01) return '< 0.01 MB';
  return mb.toFixed(2) + ' MB';
}

// Debounced — slider drags fire rapidly; only estimate once they settle. Both
// formats re-estimate together, since each can be tuned independently.
function scheduleEstimate() {
  if (estTimer) clearTimeout(estTimer);
  estTimer = setTimeout(updateEstimates, 220);
}

// Pick the shared representative frames + the source frame total. After a real
// run we sample the keyed frames (tight estimate); before, the live preview frame.
function getSampleFrames() {
  if (processedFrames.length) {
    const mid = processedFrames.length >> 1, last = processedFrames.length - 1;
    return { frames: [...new Set([0, mid, last])].map(i => processedFrames[i]), sourceTotal: processedFrames.length };
  }
  const keyed = applyKey(srcCtx.getImageData(0, 0, el.srcCanvas.width, el.srcCanvas.height), getParams());
  return { frames: [keyed], sourceTotal: Math.ceil(el.video.duration * FPS) };
}

function updateEstimates() {
  if (busy) return;                       // don't compete with a running export
  if (!el.srcCanvas.width) {
    for (const v of [el.webpEstVal, el.gifEstVal, el.pngEstVal, el.webmEstVal, el.movEstVal,
                     el.tabSizeImage, el.tabSizeGif, el.tabSizeWebm, el.tabSizeMov]) v.textContent = '—';
    return;
  }
  const { frames, sourceTotal } = getSampleFrames();
  const sampled = processedFrames.length > 0;
  updateWebpEstimate(frames, sourceTotal, sampled);   // → WebP bar + image tab badge
  updatePngEstimate(frames, sourceTotal, sampled);    // → PNG/ZIP bar
  updateGifEstimate(frames, sourceTotal, sampled);    // → GIF bar + GIF tab badge
  updateWebmEstimate(sourceTotal);                    // → WebM bar + WebM tab badge (post-encode size)
  updateMovEstimate(sourceTotal);                     // → MOV bar + MOV tab badge (ProRes formula)
}

// ProRes 4444 has a near-constant data rate (~330 Mbps at 1920×1080·30fps ≈
// 5.5 bits/pixel/frame including alpha), so size ≈ pixels × frames × bpp — no
// ffmpeg load needed. qtrle is lossless RLE and wildly content-dependent, so we
// don't guess: its real size is shown after encoding instead.
const PRORES_4444_BPP = 5.5; // bits per pixel per frame (alpha-inclusive estimate)
function updateMovEstimate(sourceTotal) {
  const srcW = el.video.videoWidth, srcH = el.video.videoHeight;
  if (!srcW) { setEstimate(el.movEstVal, el.tabSizeMov, '—'); return; }
  const { scale, skip, codec } = getMovParams();
  const gW = Math.round(srcW * scale / 2) * 2, gH = Math.round(srcH * scale / 2) * 2;
  const frameCount = Math.max(1, Math.ceil(sourceTotal / skip));
  if (codec === 'prores') {
    const bytes = Math.round(gW * gH * frameCount * PRORES_4444_BPP / 8);
    setEstimate(el.movEstVal, el.tabSizeMov, '≈ ' + formatSizeMB(bytes));
    el.movEstNote.textContent = `${frameCount} 幀 · ${gW}×${gH} · ProRes 概估`;
  } else {
    // qtrle: keep the real size if we already encoded, else dash + hint.
    if (!movBlob) setEstimate(el.movEstVal, el.tabSizeMov, '—');
    el.movEstNote.textContent = `${frameCount} 幀 · qtrle 依畫面內容而定，編碼後顯示`;
  }
}

// Toggle the stale style on an estimate value + its tab badge together.
function markStale(valEl, badgeEl) {
  valEl.classList.add('is-stale');
  if (badgeEl) badgeEl.classList.add('is-stale');
}
function setEstimate(valEl, badgeEl, text) {
  valEl.textContent = text;
  valEl.classList.remove('is-stale');
  if (badgeEl) { badgeEl.textContent = text; badgeEl.classList.remove('is-stale'); }
}

async function updateWebpEstimate(sampleFrames, sourceTotal, sampled) {
  const token = ++estToken;               // newest request wins
  const { scale, skip, quality, alphaQuality } = getSeqParams();
  const outputFrameCount = Math.max(1, Math.ceil(sourceTotal / skip));
  markStale(el.webpEstVal, el.tabSizeImage);    // image tab badge tracks the WebP size
  el.webpEstNote.textContent = '估算中…';
  try {
    const { bytes, frameCount } = await estimateWebpBytes(sampleFrames, { quality, scale, alphaQuality }, outputFrameCount);
    if (token !== estToken) return;       // superseded by a newer request
    setEstimate(el.webpEstVal, el.tabSizeImage, '≈ ' + formatSizeMB(bytes));
    el.webpEstNote.textContent = `${frameCount} 幀 · ${sampled ? '已去背取樣' : '預估'}`;
  } catch (e) {
    if (token !== estToken) return;
    el.webpEstNote.textContent = '估算失敗';
    console.error(e);
  }
}

async function updatePngEstimate(sampleFrames, sourceTotal, sampled) {
  const token = ++pngEstToken;
  const { scale, skip } = getSeqParams();  // PNG shares width/fps; quality is lossless-irrelevant
  const outputFrameCount = Math.max(1, Math.ceil(sourceTotal / skip));
  el.pngEstVal.classList.add('is-stale');
  el.pngEstNote.textContent = '估算中…';
  try {
    const { bytes, frameCount } = await estimatePngZipBytes(sampleFrames, scale, outputFrameCount);
    if (token !== pngEstToken) return;
    el.pngEstVal.textContent = '≈ ' + formatSizeMB(bytes);
    el.pngEstVal.classList.remove('is-stale');
    el.pngEstNote.textContent = `${frameCount} 張 · ${sampled ? '已去背取樣' : '預估'}`;
  } catch (e) {
    if (token !== pngEstToken) return;
    el.pngEstNote.textContent = '估算失敗';
    console.error(e);
  }
}

async function updateGifEstimate(sampleFrames, sourceTotal, sampled) {
  const token = ++gifEstToken;
  const { scale, skip, transparent, matte, dither } = getGifParams();
  const outputFrameCount = Math.max(1, Math.ceil(sourceTotal / skip));
  markStale(el.gifEstVal, el.tabSizeGif);
  el.gifEstNote.textContent = '估算中…';
  try {
    const { bytes, frameCount } = await estimateGifBytes(sampleFrames, { scale, transparent, matte, dither }, outputFrameCount);
    if (token !== gifEstToken) return;
    setEstimate(el.gifEstVal, el.tabSizeGif, '≈ ' + formatSizeMB(bytes));
    el.gifEstNote.textContent = `${frameCount} 幀 · ${sampled ? '已去背取樣' : '預估'}`;
  } catch (e) {
    if (token !== gifEstToken) return;
    el.gifEstNote.textContent = '估算失敗';
    console.error(e);
  }
}

// Fingerprint the settings that affect WebM size (used to tell a fresh estimate
// from a stale one after the user tweaks width / fps / CRF).
function webmKey() {
  const srcW = el.video.videoWidth, srcH = el.video.videoHeight;
  const { scale, skip, crf } = getWebmParams();
  const gW = Math.round(srcW * scale / 2) * 2, gH = Math.round(srcH * scale / 2) * 2;
  return { key: `${gW}x${gH}|${skip}|${crf}`, gW, gH, crf };
}

// WebM is VP9 with constant-quality CRF: size is wildly content-dependent (no
// reliable formula, just like qtrle), so there's no live formula. We show the
// last sample-encode/real size, greyed out if the settings changed since.
function updateWebmEstimate(sourceTotal) {
  const srcW = el.video.videoWidth;
  if (!srcW) { setEstimate(el.webmEstVal, el.tabSizeWebm, '—'); return; }
  const { key, gW, gH, crf } = webmKey();
  const { skip } = getWebmParams();
  const frameCount = Math.max(1, Math.ceil(sourceTotal / skip));

  if (webmEstBytes == null) {                 // never estimated yet
    setEstimate(el.webmEstVal, el.tabSizeWebm, '—');
    el.webmEstNote.textContent = `${frameCount} 幀 · ${gW}×${gH} · CRF ${crf} · 點「估算大小」`;
    return;
  }
  const text = '≈ ' + formatSizeMB(webmEstBytes);
  if (key === webmEstKey) {                    // estimate matches current settings
    setEstimate(el.webmEstVal, el.tabSizeWebm, text);
    el.webmEstNote.textContent = webmEstExact
      ? `${frameCount} 幀 · ${gW}×${gH} · 實際大小`
      : `${frameCount} 幀 · ${gW}×${gH} · CRF ${crf} · 取樣估算`;
  } else {                                     // settings changed → grey it out
    el.webmEstVal.textContent = text;
    el.tabSizeWebm.textContent = text;
    markStale(el.webmEstVal, el.tabSizeWebm);
    el.webmEstNote.textContent = '設定已變，點「估算大小」更新';
  }
}

// Estimate the PNG-sequence ZIP size: encode a few representative frames to PNG
// at the chosen width, average, and extrapolate. The ZIP uses STORE (no extra
// compression), so total ≈ (avgPng + per-file overhead) × frames + EOCD.
async function estimatePngZipBytes(sampleFrames, scale, outputFrameCount) {
  if (!sampleFrames.length || outputFrameCount <= 0) return { bytes: 0, frameCount: 0 };
  const srcW = sampleFrames[0].width, srcH = sampleFrames[0].height;
  const gW = Math.max(1, Math.round(srcW * scale)), gH = Math.max(1, Math.round(srcH * scale));
  const out = document.createElement('canvas'); out.width = gW; out.height = gH;
  const outCtx2 = out.getContext('2d');
  const full = document.createElement('canvas'); full.width = srcW; full.height = srcH;
  const fullCtx2 = full.getContext('2d');
  let sum = 0;
  for (const f of sampleFrames) {
    fullCtx2.putImageData(f, 0, 0);
    outCtx2.clearRect(0, 0, gW, gH);
    outCtx2.drawImage(full, 0, 0, gW, gH);
    const blob = await new Promise(r => out.toBlob(r, 'image/png'));
    sum += blob.size;
  }
  const perFrame = sum / sampleFrames.length;
  const ZIP_PER_FILE = 76; // local header (~30) + central-directory entry (~46), STORE
  const bytes = Math.round((perFrame + ZIP_PER_FILE) * outputFrameCount + 22); // + EOCD record
  return { bytes, frameCount: outputFrameCount };
}
