/* AudioShrink — browser-native compression via Web Audio API + lamejs
   No SharedArrayBuffer needed. Works from file:// directly. */

const BITRATES = [32, 48, 64, 96, 128];
const HINTS = [
  'Smallest file — great for voice memos & speech',
  'Very small — clear speech quality',
  'Recommended — ideal for voice & podcasts',
  'High quality — music & broadcast audio',
  'Maximum quality — full-fidelity output',
];

let selectedFile   = null;
let selectedBitrate = 64; // matches slider default index 2
let outputBlob     = null;
let outputFilename = '';

// ─── DOM refs ───
const dropZone        = document.getElementById('dropZone');
const fileInput       = document.getElementById('fileInput');
const uploadSection   = document.getElementById('uploadSection');
const configSection   = document.getElementById('configSection');
const progressSection = document.getElementById('progressSection');
const resultSection   = document.getElementById('resultSection');

const fileName    = document.getElementById('fileName');
const fileSize    = document.getElementById('fileSize');
const removeFile  = document.getElementById('removeFile');

const bitrateSlider = document.getElementById('bitrateSlider');
const bitrateLabel  = document.getElementById('bitrateLabel');
const qualityHint   = document.getElementById('qualityHint');

const compressBtn   = document.getElementById('compressBtn');
const progressFill  = document.getElementById('progressFill');
const progressLabel = document.getElementById('progressLabel');
const progressPct   = document.getElementById('progressPct');

const originalSizeEl   = document.getElementById('originalSize');
const compressedSizeEl = document.getElementById('compressedSize');
const savedPctEl       = document.getElementById('savedPct');
const downloadBtn      = document.getElementById('downloadBtn');
const compressAnother  = document.getElementById('compressAnother');

// ─── Drag & drop ───
['dragenter', 'dragover'].forEach(evt =>
  dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.add('drag-over'); })
);
['dragleave', 'drop'].forEach(evt =>
  dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.remove('drag-over'); })
);
dropZone.addEventListener('drop', e => handleFile(e.dataTransfer.files[0]));
fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));
dropZone.addEventListener('click', e => {
  if (!e.target.classList.contains('link-btn')) fileInput.click();
});

// ─── File selection ───
function handleFile(file) {
  if (!file) return;
  if (!/audio\//i.test(file.type) && !/\.(mp3|wav|aac|flac|ogg|m4a|opus|wma)$/i.test(file.name)) {
    alert('Please select an audio file (MP3, WAV, AAC, FLAC, OGG, M4A, OPUS).');
    return;
  }
  selectedFile = file;
  fileName.textContent = file.name;
  fileSize.textContent = formatBytes(file.size);
  show(configSection);
  hide(uploadSection);
}

removeFile.addEventListener('click', () => {
  selectedFile = null;
  fileInput.value = '';
  hide(configSection);
  show(uploadSection);
});

// ─── Bitrate slider ───
bitrateSlider.addEventListener('input', () => {
  const idx = parseInt(bitrateSlider.value);
  selectedBitrate = BITRATES[idx];
  bitrateLabel.textContent = `${selectedBitrate} kbps`;
  qualityHint.textContent  = HINTS[idx];
  bitrateSlider.style.setProperty('--fill', (idx / (BITRATES.length - 1)) * 100 + '%');
});
// set initial fill
bitrateSlider.style.setProperty('--fill', '50%');

// ─── Format pills — MP3 only (lamejs encodes MP3) ───
document.querySelectorAll('.pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
  });
});

// ─── Compress ───
compressBtn.addEventListener('click', startCompression);

async function startCompression() {
  if (!selectedFile) return;

  show(progressSection);
  hide(configSection);
  setProgress(0, 'Reading audio file…');

  try {
    await encodeMp3();
  } catch (err) {
    console.error(err);
    alert('Compression failed: ' + err.message);
    resetToUpload();
  }
}

async function encodeMp3() {
  // 1. Decode audio to raw PCM via Web Audio API
  setProgress(5, 'Decoding audio…');
  const arrayBuffer  = await selectedFile.arrayBuffer();
  const audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const audioBuffer  = await audioContext.decodeAudioData(arrayBuffer);
  await audioContext.close();

  const numChannels = Math.min(audioBuffer.numberOfChannels, 2);
  const sampleRate  = audioBuffer.sampleRate;
  const leftPCM     = audioBuffer.getChannelData(0);
  const rightPCM    = numChannels > 1 ? audioBuffer.getChannelData(1) : audioBuffer.getChannelData(0);

  // 2. Pick a bitrate that guarantees the output is smaller than input
  const durationSecs = audioBuffer.duration;
  // Expected output bytes for a given bitrate
  const expectedBytes = kbps => (kbps * 1000 * durationSecs) / 8;

  // Rates where output will be meaningfully smaller (at least 15% reduction)
  const compressibleRates = BITRATES.filter(b => expectedBytes(b) < selectedFile.size * 0.85);

  let targetBitrate;
  if (compressibleRates.length === 0) {
    // File is already tiny/maximally compressed — use lowest bitrate as best effort
    targetBitrate = BITRATES[0];
  } else if (compressibleRates.includes(selectedBitrate)) {
    targetBitrate = selectedBitrate;
  } else {
    // User's selected bitrate is too high — use the best rate that still compresses
    targetBitrate = compressibleRates[compressibleRates.length - 1];
  }

  // Sync slider UI if we auto-corrected
  if (targetBitrate !== selectedBitrate) {
    const newIdx = BITRATES.indexOf(targetBitrate);
    bitrateSlider.value = newIdx;
    bitrateLabel.textContent = `${targetBitrate} kbps`;
    qualityHint.textContent  = HINTS[newIdx];
    bitrateSlider.style.setProperty('--fill', (newIdx / (BITRATES.length - 1)) * 100 + '%');
  }

  const inputKbps = Math.round((selectedFile.size * 8) / (durationSecs * 1000));
  setProgress(15, `Encoding at ${targetBitrate} kbps (original ~${inputKbps} kbps)…`);

  // 3. Encode PCM → MP3 with lamejs (runs synchronously in chunks)
  const encoder  = new lamejs.Mp3Encoder(numChannels, sampleRate, targetBitrate);
  const mp3Parts = [];
  const CHUNK    = 1152; // lamejs requirement
  const total    = leftPCM.length;

  for (let offset = 0; offset < total; offset += CHUNK) {
    const end   = Math.min(offset + CHUNK, total);
    const left  = floatTo16Bit(leftPCM.subarray(offset, end));
    const right = floatTo16Bit(rightPCM.subarray(offset, end));

    const chunk = numChannels === 2
      ? encoder.encodeBuffer(left, right)
      : encoder.encodeBuffer(left);

    if (chunk.length) mp3Parts.push(chunk);

    // yield to UI every ~50k samples so progress bar updates
    if (offset % 50000 < CHUNK) {
      const pct = 15 + Math.round((offset / total) * 80);
      setProgress(pct, `Encoding… ${pct}%`);
      await yieldToUI();
    }
  }

  const flushed = encoder.flush();
  if (flushed.length) mp3Parts.push(flushed);

  setProgress(98, 'Finalising…');
  await yieldToUI();

  outputBlob = new Blob(mp3Parts, { type: 'audio/mpeg' });
  const base  = selectedFile.name.replace(/\.[^.]+$/, '');
  outputFilename = `${base}_${targetBitrate}kbps.mp3`;

  setProgress(100, 'Done!');
  showResult();
}

function floatTo16Bit(floatArray) {
  const out = new Int16Array(floatArray.length);
  for (let i = 0; i < floatArray.length; i++) {
    const s = Math.max(-1, Math.min(1, floatArray[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function yieldToUI() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// ─── Result ───
function showResult() {
  hide(progressSection);
  show(resultSection);

  originalSizeEl.textContent   = formatBytes(selectedFile.size);
  compressedSizeEl.textContent = formatBytes(outputBlob.size);

  const saved = ((selectedFile.size - outputBlob.size) / selectedFile.size) * 100;
  savedPctEl.textContent = saved > 0
    ? `−${Math.round(saved)}%`
    : `+${Math.abs(Math.round(saved))}% (already compressed)`;
  savedPctEl.className = 'stat-value ' + (saved > 0 ? 'purple' : '');
}

// ─── Download ───
downloadBtn.addEventListener('click', () => {
  const url = URL.createObjectURL(outputBlob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = outputFilename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

// ─── Reset ───
compressAnother.addEventListener('click', resetToUpload);

function resetToUpload() {
  selectedFile   = null;
  outputBlob     = null;
  outputFilename = '';
  fileInput.value = '';
  hide(resultSection);
  hide(progressSection);
  hide(configSection);
  show(uploadSection);
}

// ════════════════════════════════════════════════
//  IMAGE COMPRESSOR
// ════════════════════════════════════════════════

const DIM_PRESETS  = [0, 2048, 1280, 800, 480]; // 0 = original
const DIM_HINTS    = ['Keep original dimensions', 'Max 2048px — web display', 'Max 1280px — social media', 'Max 800px — thumbnails', 'Max 480px — smallest'];

let imgFile       = null;
let imgFormat     = 'jpeg';
let imgQuality    = 0.80;
let imgMaxDim     = 0;
let imgOutputBlob = null;
let imgOutputName = '';

const imageCard        = document.getElementById('imageCard');
const imgUploadSection = document.getElementById('imgUploadSection');
const imgConfigSection = document.getElementById('imgConfigSection');
const imgResultSection = document.getElementById('imgResultSection');

const imgDropZone    = document.getElementById('imgDropZone');
const imgFileInput   = document.getElementById('imgFileInput');
const imgFileName    = document.getElementById('imgFileName');
const imgFileSizeEl  = document.getElementById('imgFileSize');
const imgRemoveFile  = document.getElementById('imgRemoveFile');

const imgPreviewBefore = document.getElementById('imgPreviewBefore');
const imgPreviewAfter  = document.getElementById('imgPreviewAfter');
const imgResultBefore  = document.getElementById('imgResultBefore');
const imgResultAfter   = document.getElementById('imgResultAfter');
const imgResultBeforeLabel = document.getElementById('imgResultBeforeLabel');
const imgResultAfterLabel  = document.getElementById('imgResultAfterLabel');

const imgQualitySlider = document.getElementById('imgQualitySlider');
const imgQualityLabel  = document.getElementById('imgQualityLabel');
const imgQualityHint   = document.getElementById('imgQualityHint');
const imgDimSlider     = document.getElementById('imgDimSlider');
const imgDimLabel      = document.getElementById('imgDimLabel');
const imgDimHint       = document.getElementById('imgDimHint');
const imgCompressBtn   = document.getElementById('imgCompressBtn');

const imgOriginalSizeEl   = document.getElementById('imgOriginalSize');
const imgCompressedSizeEl = document.getElementById('imgCompressedSize');
const imgSavedPctEl       = document.getElementById('imgSavedPct');
const imgDownloadBtn      = document.getElementById('imgDownloadBtn');
const imgCompressAnother  = document.getElementById('imgCompressAnother');

// ─── Tab switcher ───
document.getElementById('tabAudio').addEventListener('click', () => {
  document.getElementById('tabAudio').classList.add('active');
  document.getElementById('tabImage').classList.remove('active');
  show(document.getElementById('mainCard'));
  hide(imageCard);
});
document.getElementById('tabImage').addEventListener('click', () => {
  document.getElementById('tabImage').classList.add('active');
  document.getElementById('tabAudio').classList.remove('active');
  hide(document.getElementById('mainCard'));
  show(imageCard);
});

// ─── Image drag & drop ───
['dragenter', 'dragover'].forEach(evt =>
  imgDropZone.addEventListener(evt, e => { e.preventDefault(); imgDropZone.classList.add('drag-over'); })
);
['dragleave', 'drop'].forEach(evt =>
  imgDropZone.addEventListener(evt, e => { e.preventDefault(); imgDropZone.classList.remove('drag-over'); })
);
imgDropZone.addEventListener('drop', e => handleImgFile(e.dataTransfer.files[0]));
imgFileInput.addEventListener('change', () => handleImgFile(imgFileInput.files[0]));
imgDropZone.addEventListener('click', e => {
  if (!e.target.classList.contains('link-btn')) imgFileInput.click();
});

function handleImgFile(file) {
  if (!file) return;
  if (!/image\//i.test(file.type)) { alert('Please select an image file.'); return; }
  imgFile = file;
  imgFileName.textContent = file.name;
  imgFileSizeEl.textContent = formatBytes(file.size);

  const url = URL.createObjectURL(file);
  imgPreviewBefore.src = url;
  imgResultBefore.src  = url;

  show(imgConfigSection);
  hide(imgUploadSection);
  updateImgPreview();
}

imgRemoveFile.addEventListener('click', () => {
  imgFile = null;
  imgFileInput.value = '';
  hide(imgConfigSection);
  show(imgUploadSection);
});

// ─── Format pills ───
document.querySelectorAll('.pill-pink').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('.pill-pink').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    imgFormat = pill.dataset.format;
    updateImgPreview();
  });
});

// ─── Quality slider ───
imgQualitySlider.addEventListener('input', () => {
  imgQuality = parseInt(imgQualitySlider.value) / 100;
  imgQualityLabel.textContent = `${imgQualitySlider.value}%`;
  const pct = ((parseInt(imgQualitySlider.value) - 10) / 85) * 100;
  imgQualitySlider.style.setProperty('--fill', pct + '%');
  const q = parseInt(imgQualitySlider.value);
  imgQualityHint.textContent = q <= 30 ? 'Smallest file — some quality loss visible'
    : q <= 60 ? 'Good compression — slight quality reduction'
    : q <= 80 ? 'Great quality — recommended for most images'
    : 'Near-lossless — minimal compression';
  updateImgPreview();
});
imgQualitySlider.style.setProperty('--fill', '82%');

// ─── Dimension slider ───
imgDimSlider.addEventListener('input', () => {
  const idx = parseInt(imgDimSlider.value);
  imgMaxDim = DIM_PRESETS[idx];
  imgDimLabel.textContent = idx === 0 ? 'Original' : `${imgMaxDim}px`;
  imgDimHint.textContent  = DIM_HINTS[idx];
  const pct = (idx / 4) * 100;
  imgDimSlider.style.setProperty('--fill', pct + '%');
  updateImgPreview();
});

// ─── Live preview (debounced) ───
let previewTimer = null;
function updateImgPreview() {
  if (!imgFile) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const blob = await compressImageToBlob(imgFile, imgFormat, imgQuality, imgMaxDim);
    if (imgPreviewAfter.src && imgPreviewAfter.src.startsWith('blob:')) {
      URL.revokeObjectURL(imgPreviewAfter.src);
    }
    imgPreviewAfter.src = URL.createObjectURL(blob);
  }, 300);
}

// ─── Compress ───
imgCompressBtn.addEventListener('click', async () => {
  if (!imgFile) return;
  imgCompressBtn.disabled = true;
  imgCompressBtn.textContent = 'Compressing…';
  try {
    imgOutputBlob = await compressImageToBlob(imgFile, imgFormat, imgQuality, imgMaxDim);
    const base    = imgFile.name.replace(/\.[^.]+$/, '');
    const ext     = imgFormat === 'jpeg' ? 'jpg' : imgFormat;
    imgOutputName = `${base}_compressed.${ext}`;

    imgResultAfter.src = URL.createObjectURL(imgOutputBlob);
    imgResultBeforeLabel.textContent = formatBytes(imgFile.size);
    imgResultAfterLabel.textContent  = formatBytes(imgOutputBlob.size);

    imgOriginalSizeEl.textContent   = formatBytes(imgFile.size);
    imgCompressedSizeEl.textContent = formatBytes(imgOutputBlob.size);

    const saved = ((imgFile.size - imgOutputBlob.size) / imgFile.size) * 100;
    imgSavedPctEl.textContent = saved > 0
      ? `−${Math.round(saved)}%`
      : `+${Math.abs(Math.round(saved))}%`;
    imgSavedPctEl.className = 'stat-value ' + (saved > 0 ? 'purple' : '');

    hide(imgConfigSection);
    show(imgResultSection);
  } finally {
    imgCompressBtn.disabled = false;
    imgCompressBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M10 3v14M3 10l7 7 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Compress Image`;
  }
});

async function compressImageToBlob(file, format, quality, maxDim) {
  // Draw image onto canvas (with optional resize)
  const img = await loadImage(file);
  let { width, height } = img;

  if (maxDim > 0 && (width > maxDim || height > maxDim)) {
    if (width >= height) { height = Math.round(height * maxDim / width); width = maxDim; }
    else                 { width = Math.round(width * maxDim / height); height = maxDim; }
  }

  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (format === 'jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height); }
  ctx.drawImage(img, 0, 0, width, height);

  // For PNG: browser encoder is often worse than original — try WebP first (keeps transparency),
  // fall back to JPEG only if image has no alpha channel.
  if (format === 'png') {
    // Try WebP lossy — much smaller, full transparency support
    const webpBlob = await tryQualityLoop(canvas, 'image/webp', quality, file.size);
    if (webpBlob && webpBlob.size < file.size * 0.85) {
      setImgFormatUI('webp');
      imgOutputName = imgOutputName.replace(/\.[^.]+$/, '.webp');
      return webpBlob;
    }
    // Try lossless PNG encode (might work if original was unoptimised)
    const pngBlob = await canvasToBlob(canvas, 'image/png', undefined);
    if (pngBlob.size < file.size * 0.85) return pngBlob;

    // Last resort: JPEG (no transparency)
    const jpegBlob = await tryQualityLoop(canvas, 'image/jpeg', quality, file.size);
    if (jpegBlob && jpegBlob.size < file.size * 0.85) {
      setImgFormatUI('jpeg');
      imgOutputName = imgOutputName.replace(/\.[^.]+$/, '.jpg');
      return jpegBlob;
    }
    // Return smallest we found
    return [webpBlob, pngBlob, jpegBlob]
      .filter(Boolean)
      .sort((a, b) => a.size - b.size)[0];
  }

  // JPEG / WebP — step quality down until meaningfully smaller
  const mime = format === 'jpeg' ? 'image/jpeg' : 'image/webp';
  const blob = await tryQualityLoop(canvas, mime, quality, file.size);
  return blob;
}

async function tryQualityLoop(canvas, mime, startQuality, inputSize) {
  let q = startQuality;
  let blob;
  do {
    blob = await canvasToBlob(canvas, mime, q);
    if (blob.size < inputSize * 0.85) break;
    q = Math.round((q - 0.08) * 100) / 100;
  } while (q >= 0.08);

  // Sync quality slider if auto-adjusted
  const usedPct = Math.round(q * 100);
  if (usedPct !== Math.round(startQuality * 100)) {
    imgQualitySlider.value = Math.max(10, usedPct);
    imgQualityLabel.textContent = `${Math.max(10, usedPct)}%`;
    imgQuality = q;
  }
  return blob;
}

function setImgFormatUI(format) {
  imgFormat = format;
  document.querySelectorAll('.pill-pink').forEach(p => {
    p.classList.toggle('active', p.dataset.format === format);
  });
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = reject;
    img.src = url;
  });
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), mime, quality)
  );
}

// ─── Download image ───
imgDownloadBtn.addEventListener('click', () => {
  const url = URL.createObjectURL(imgOutputBlob);
  const a   = document.createElement('a');
  a.href = url; a.download = imgOutputName; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

// ─── Reset image ───
imgCompressAnother.addEventListener('click', () => {
  imgFile = null; imgOutputBlob = null; imgFileInput.value = '';
  imgPreviewBefore.src = ''; imgPreviewAfter.src = '';
  hide(imgResultSection);
  show(imgUploadSection);
});

// ─── Helpers ───
function setProgress(pct, label) {
  progressFill.style.width  = pct + '%';
  progressPct.textContent   = pct + '%';
  progressLabel.textContent = label;
}

function formatBytes(b) {
  if (b < 1024)    return b + ' B';
  if (b < 1024**2) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024**2).toFixed(2) + ' MB';
}

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

// ─── Load lamejs from CDN (pure JS, no SharedArrayBuffer needed) ───
(function () {
  const s    = document.createElement('script');
  s.src      = 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js';
  s.onerror  = () => {
    const s2  = document.createElement('script');
    s2.src    = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';
    document.head.appendChild(s2);
  };
  document.head.appendChild(s);
})();
