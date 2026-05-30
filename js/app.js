// ── App wiring: DOM, state, video pipeline, exporters ──────
import { hexToRgb, applyKey } from './keying.js';
import { encodeAnimatedWebP, estimateWebpBytes } from './webp-anim.js';

// ── Constants ──────────────────────────────────────────────
const FPS = 30;
const PROGRESS_YIELD_EVERY = 10; // yield to UI thread every N frames

// ── DOM references ─────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = {
  fileInput: $('fileInput'),
  dropZone: $('dropZone'),
  processBtn: $('processBtn'),
  downloadBtn: $('downloadBtn'),
  pngSeqBtn: $('pngSeqBtn'),
  downloadZipBtn: $('downloadZipBtn'),
  webpBtn: $('webpBtn'),
  downloadWebpBtn: $('downloadWebpBtn'),
  status: $('status'),
  prog: $('prog'),
  progWrap: $('progWrap'),
  progLabel: $('progLabel'),
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
  seqSkip: $('seqSkip'),
  webpQ: $('webpQ'),
  cmdBox: $('cmdBox'),
  webpEstVal: $('webpEstVal'),
  webpEstNote: $('webpEstNote'),
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
el.dropZone.addEventListener('click', () => el.fileInput.click());
el.dropZone.addEventListener('dragover', e => { e.preventDefault(); el.dropZone.classList.add('dragover'); });
el.dropZone.addEventListener('dragleave', () => el.dropZone.classList.remove('dragover'));
el.dropZone.addEventListener('drop', e => { e.preventDefault(); el.dropZone.classList.remove('dragover'); handleFile(e.dataTransfer.files[0]); });
el.fileInput.addEventListener('change', () => handleFile(el.fileInput.files[0]));

function handleFile(file) {
  if (!file || !file.type.startsWith('video/')) return;
  stopPlayback();
  processedFrames = [];
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
    livePreview();
    el.status.textContent = `已載入（${el.video.videoWidth}×${el.video.videoHeight}，時長 ${el.video.duration.toFixed(2)}s，${FPS}fps）`;
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
  return {
    scale: parseFloat(el.seqScale.value),
    skip: parseInt(el.seqSkip.value),
    quality: parseInt(el.webpQ.value),
  };
}
function livePreview() {
  if (!el.srcCanvas.width) return;
  if (processedFrames.length > 0) { outCtx.putImageData(processedFrames[previewIdx], 0, 0); return; }
  outCtx.putImageData(applyKey(srcCtx.getImageData(0, 0, el.srcCanvas.width, el.srcCanvas.height), getParams()), 0, 0);
  scheduleEstimate(); // keying params changed the frame → re-estimate size
}

// ── Preview playback ───────────────────────────────────────
function showFrame(idx) {
  idx = Math.max(0, Math.min(processedFrames.length - 1, idx));
  previewIdx = idx;
  outCtx.putImageData(processedFrames[idx], 0, 0);
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
el.playBtn.addEventListener('click', () => { if (!processedFrames.length) return; isPlaying ? stopPlayback() : startPlayback(); });
el.scrubber.addEventListener('input', () => { stopPlayback(); showFrame(parseInt(el.scrubber.value)); });

// ── Frame extraction (shared by every exporter) ────────────
async function seekTo(t) {
  return new Promise(r => { el.video.addEventListener('seeked', r, { once: true }); el.video.currentTime = t; });
}

async function runFrames() {
  const p = getParams();
  const w = el.video.videoWidth, h = el.video.videoHeight;
  const duration = el.video.duration, totalFrames = Math.ceil(duration * FPS);

  processedFrames = [];
  el.progWrap.style.display = 'block'; el.prog.value = 0;
  el.status.textContent = '逐幀處理中...';

  for (let f = 0; f < totalFrames; f++) {
    const t = f / FPS;
    if (t >= duration) break;
    await seekTo(Math.min(t, duration - 0.001));
    workCtx.drawImage(el.video, 0, 0);
    const keyed = applyKey(workCtx.getImageData(0, 0, w, h), p);
    processedFrames.push(keyed);
    if (f % 5 === 0) outCtx.putImageData(keyed, 0, 0);
    const pct = Math.round((f / totalFrames) * 60);
    el.prog.value = pct;
    el.progLabel.textContent = `逐幀處理 ${f + 1} / ${totalFrames}（${pct}%）`;
    if (f % PROGRESS_YIELD_EVERY === 0) await new Promise(r => setTimeout(r, 0));
  }

  el.previewBar.style.display = 'flex';
  el.scrubber.max = processedFrames.length - 1;
  showFrame(0);
  el.outLabel.textContent = '去背結果 — 可預覽';
  scheduleEstimate(); // now have real keyed frames → tighter estimate
}

// ── Export 1: transparent WebM (MediaRecorder) ─────────────
async function runProcess() {
  await runFrames();

  el.status.textContent = '第二步：錄製輸出中...';
  el.prog.value = 60;
  el.progLabel.textContent = '以精確 30fps 泵入 MediaRecorder...';
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
  el.progLabel.textContent = `完成！${processedFrames.length} 幀 @ ${FPS}fps`;
  el.status.textContent = `完成！${processedFrames.length} 幀 @ ${FPS}fps`;
  el.downloadBtn.disabled = false;
}

el.processBtn.addEventListener('click', async () => {
  stopPlayback();
  setBusy(true);
  outputBlob = null;
  try { await runProcess(); }
  catch (e) { el.status.textContent = '錯誤：' + e.message; console.error(e); }
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
    const { scale, skip, quality } = getSeqParams();
    el.progWrap.style.display = 'block';
    el.status.textContent = '合成動態 WebP 中（libwebp WASM）...';
    webpBlob = await encodeAnimatedWebP(processedFrames, {
      fps: FPS, quality, scale, skip,
      onProgress: (done, total) => {
        el.prog.value = 60 + Math.round((done / total) * 40);
        el.progLabel.textContent = `編碼 WebP 影格 ${done} / ${total}`;
      },
    });
    el.prog.value = 100;
    const sizeMB = (webpBlob.size / 1024 / 1024).toFixed(2);
    const frameCount = Math.ceil(processedFrames.length / skip);
    el.progLabel.textContent = `完成！${frameCount} 幀動態 WebP，${sizeMB}MB`;
    el.status.textContent = `動態 WebP 完成！${sizeMB}MB（已自動下載）`;
    el.downloadWebpBtn.disabled = false;
    triggerDownload(webpBlob, 'anim.webp'); // fully automatic download
  } catch (e) {
    el.status.textContent = '動態 WebP 錯誤：' + e.message; console.error(e);
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
  el.status.textContent = 'PNG 序列匯出中...';
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
  el.progLabel.textContent = `完成！${indices.length} 張 PNG，${gW}×${gH}，${(zipBlob.size / 1024 / 1024).toFixed(1)}MB`;
  el.status.textContent = `PNG 序列完成！${(zipBlob.size / 1024 / 1024).toFixed(1)}MB`;
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
  } catch (e) { el.status.textContent = 'PNG 序列錯誤：' + e.message; console.error(e); }
  setBusy(false);
});
el.downloadZipBtn.addEventListener('click', () => { if (zipBlob) triggerDownload(zipBlob, 'frames.zip'); });

// ── Sequence option labels ─────────────────────────────────
el.seqScale.addEventListener('input', e => { $('seqScaleVal').textContent = Math.round(e.target.value * 100) + '%'; scheduleEstimate(); });
el.seqSkip.addEventListener('input', e => { $('seqSkipVal').textContent = e.target.value + '幀'; scheduleEstimate(); });
el.webpQ.addEventListener('input', e => { $('webpQVal').textContent = e.target.value; scheduleEstimate(); });

// ── Shared helpers ─────────────────────────────────────────
function triggerDownload(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

// Disable every action button while one export is running.
function setBusy(running) {
  busy = running;
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
  const { scale, skip, quality } = getSeqParams();

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
    const { bytes, frameCount } = await estimateWebpBytes(sampleFrames, { quality, scale }, outputFrameCount);
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
