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
