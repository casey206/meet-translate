// MeetTranslate — 即時翻譯主介面（Transync 風雙欄）
// 引擎直接在此頁執行：電腦聲音用 getDisplayMedia（分享分頁音訊）、麥克風用 getUserMedia，
// VAD 斷句 → Gemini 辨識+翻譯 → 雙欄即時顯示 + 語音合成 + 雙語會議記錄。

const $ = (id) => document.getElementById(id);
const EXT = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id && chrome.storage;

let running = false, timerHandle = null, startedAt = 0;
let displayStream = null, micStream = null, leftSeg = null, rightSeg = null;
let cfg = null, session = null;
let cachedKey = '', cachedGlossary = '', cachedVoice = 'Kore';

const nameOf = (c) => (!c || c === 'auto') ? '' : (window.LANG_NAME[c] || c);

// ── Toast / 計時器 ────────────────────────────────────────
let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map(n => String(n).padStart(2, '0')).join(':');
}
function startTimer() { startedAt = Date.now(); $('timer').textContent = '00:00:00'; timerHandle = setInterval(() => { $('timer').textContent = fmtClock(Date.now() - startedAt); }, 500); }
function stopTimer() { if (timerHandle) clearInterval(timerHandle); timerHandle = null; }

// ── 語言選單 ──────────────────────────────────────────────
function setupLangs(saved) {
  window.fillLangSelect($('leftSrc'), { includeAuto: true, selected: saved.sourceLang || 'auto' });
  window.fillLangSelect($('leftTgt'), { includeAuto: false, selected: saved.targetLang || 'zh-TW' });
  window.fillLangSelect($('rightSrc'), { includeAuto: false, selected: saved.myLang || 'zh-TW' });
  window.fillLangSelect($('rightTgt'), { includeAuto: false, selected: saved.outboundLang || 'en' });
}
async function saveLangSettings() {
  if (!EXT) return;
  await chrome.storage.sync.set({
    sourceLang: $('leftSrc').value, targetLang: $('leftTgt').value,
    myLang: $('rightSrc').value, outboundLang: $('rightTgt').value,
    ttsForOthers: $('leftTTS').classList.contains('on'),
    speakToOther: $('rightTTS').classList.contains('on')
  });
}
['leftSrc', 'leftTgt', 'rightSrc', 'rightTgt'].forEach(id => $(id).addEventListener('change', saveLangSettings));
$('leftTTS').addEventListener('click', () => {
  const on = $('leftTTS').classList.toggle('on');
  if (cfg) cfg.ttsForOthers = on; // 翻譯中也即時生效
  saveLangSettings();
});
$('rightTTS').addEventListener('click', () => {
  const on = $('rightTTS').classList.toggle('on');
  if (cfg) cfg.speakToOther = on;
  if (on) toast('已啟用：把我的話用語音講給對方（需在來源選 BlackHole 揚聲器）');
  saveLangSettings();
});

// ── 聲音來源面板 ──────────────────────────────────────────
$('srcToggle').addEventListener('click', (e) => { e.stopPropagation(); $('srcPanel').classList.toggle('show'); });
document.addEventListener('click', (e) => {
  if (!$('srcPanel').contains(e.target) && e.target !== $('srcToggle') && !$('srcToggle').contains(e.target))
    $('srcPanel').classList.remove('show');
});
function updateSrcLabel() {
  const parts = [];
  if ($('srcComputer').checked) parts.push('電腦聲音');
  if ($('srcMic').checked) parts.push('麥克風');
  $('srcToggle').firstChild.textContent = (parts.length ? parts.join('＋') : '聲音來源') + ' ';
}
['srcComputer', 'srcMic'].forEach(id => $(id).addEventListener('change', updateSrcLabel));

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devs = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel, def, kind) => {
    const cur = sel.value;
    sel.innerHTML = `<option value="default">${def}</option>`;
    devs.filter(d => d.kind === kind).forEach(d => {
      const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || def; sel.appendChild(o);
    });
    if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
  };
  fill($('micDeviceSel'), '預設麥克風', 'audioinput');
  fill($('outDeviceSel'), '預設揚聲器', 'audiooutput');
}

// ── 語音合成播放（依序、可指定輸出裝置）──────────────────
let ttsQueue = Promise.resolve();
function playToDevice(blob, deviceId) {
  ttsQueue = ttsQueue.then(() => new Promise((res) => {
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    const done = () => { URL.revokeObjectURL(url); res(); };
    a.onended = done; a.onerror = done;
    const play = () => a.play().catch(done);
    if (deviceId && deviceId !== 'default' && a.setSinkId) a.setSinkId(deviceId).then(play).catch(play);
    else play();
  }));
  return ttsQueue;
}

// ── VAD 斷句器 ────────────────────────────────────────────
function pickMime() {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find(t => MediaRecorder.isTypeSupported(t)) || '';
}
class Segmenter {
  constructor(stream, onSegment, opts = {}) {
    this.stream = stream; this.onSegment = onSegment;
    this.silenceHold = opts.silenceHold ?? 700; this.maxLen = opts.maxLen ?? 12000;
    this.minLen = opts.minLen ?? 350; this.threshold = opts.threshold ?? 0.012;
    this.onLevel = opts.onLevel;
    this.recording = false; this.chunks = []; this.recStart = 0; this.lastVoice = 0; this.timer = null;
  }
  start() {
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser(); this.analyser.fftSize = 512;
    this.buf = new Float32Array(this.analyser.fftSize);
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    src.connect(this.analyser);
    this.mime = pickMime();
    this.timer = setInterval(() => this.tick(), 50);
  }
  tick() {
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0; for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sum / this.buf.length), now = performance.now();
    if (this.onLevel) { this.analyser.getByteFrequencyData(this.freq); this.onLevel(this.freq, rms > this.threshold); }
    if (rms > this.threshold) { this.lastVoice = now; if (!this.recording) this.startRec(); }
    if (this.recording) {
      const dur = now - this.recStart, silent = now - this.lastVoice;
      if (dur >= this.maxLen || (silent >= this.silenceHold && dur >= this.minLen)) this.stopRec();
    }
  }
  startRec() {
    this.chunks = [];
    try { this.recorder = this.mime ? new MediaRecorder(this.stream, { mimeType: this.mime }) : new MediaRecorder(this.stream); }
    catch { this.recorder = new MediaRecorder(this.stream); }
    this.recorder.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.recorder.onstop = () => {
      const dur = performance.now() - this.recStart;
      const blob = new Blob(this.chunks, { type: this.recorder.mimeType }); this.chunks = [];
      if (dur >= this.minLen && blob.size > 1200) this.onSegment(blob);
    };
    this.recorder.start(); this.recording = true; this.recStart = performance.now();
  }
  stopRec() { this.recording = false; if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.stopRec(); if (this.ctx) this.ctx.close().catch(() => {}); this.ctx = null; }
}

// ── 即時音波 VU 表 + 收音狀態 ─────────────────────────────
const VU_N = 22;
const vuEls = { others: [], me: [] };
const paneProc = { others: 0, me: 0 };
function buildVu() {
  [['others', 'leftVu'], ['me', 'rightVu']].forEach(([s, id]) => {
    const c = $(id); if (!c) return; c.innerHTML = ''; vuEls[s] = [];
    for (let i = 0; i < VU_N; i++) { const b = document.createElement('i'); c.appendChild(b); vuEls[s].push(b); }
  });
}
function resetVu(s) { (vuEls[s] || []).forEach(b => b.style.height = '8%'); }
function updateVu(side, freq, speaking) {
  const bars = vuEls[side]; if (!bars.length) return;
  const usable = Math.floor(freq.length * 0.55), per = Math.max(1, Math.floor(usable / bars.length));
  for (let i = 0; i < bars.length; i++) {
    let sum = 0; for (let j = 0; j < per; j++) sum += freq[i * per + j] || 0;
    const v = (sum / per) / 255;
    bars[i].style.height = Math.max(8, Math.min(100, v * 180)) + '%';
  }
  setPaneStatus(side, speaking ? 'voice' : 'listen');
}
function setPaneStatus(side, mode) {
  const el = side === 'others' ? $('leftStatus') : $('rightStatus');
  let cls = '', txt = '';
  if (paneProc[side] > 0) { cls = 'proc'; txt = '辨識中…'; }
  else if (mode === 'voice') { cls = 'voice'; txt = '偵測到聲音'; }
  else if (mode === 'listen') { cls = 'listen'; txt = '收音中'; }
  else { cls = ''; txt = '待機'; }
  el.className = 'cap-status' + (cls ? ' ' + cls : '');
  el.innerHTML = `<span class="d"></span>${txt}`;
}

// ── 處理一段語音 ──────────────────────────────────────────
async function processSegment(blob, source) {
  if (!cfg) return;
  paneProc[source]++; setPaneStatus(source, 'proc');
  try {
    const isMe = source === 'me';
    const srcLang = isMe ? cfg.rightSrc : cfg.leftSrc;
    const tgtLang = isMe ? cfg.outboundLang : cfg.leftTgt;
    const { original, translation } = await window.gemini.audio({
      apiKey: cfg.apiKey, audioBlob: blob,
      sourceName: nameOf(srcLang), targetName: nameOf(tgtLang) || (isMe ? '英文' : '繁體中文'),
      glossary: cfg.glossary
    });
    if (!original || original.length < 2 || !translation) return;
    addLine(source, original, translation);
    appendEntry(source, original, translation);
    // 語音合成獨立 try/catch：TTS 失敗不應被誤報成翻譯失敗
    try {
      if (isMe && cfg.speakToOther) playToDevice(await window.gemini.tts({ apiKey: cfg.apiKey, text: translation, voice: cfg.voice }), cfg.outDevice);
      else if (!isMe && cfg.ttsForOthers) playToDevice(await window.gemini.tts({ apiKey: cfg.apiKey, text: translation, voice: cfg.voice }), 'default');
    } catch (e) { console.warn('TTS 失敗', e); toast('語音合成失敗（翻譯文字已顯示）'); }
  } catch (err) { toast('翻譯錯誤：' + err.message); }
  finally { paneProc[source] = Math.max(0, paneProc[source] - 1); setPaneStatus(source, running ? 'listen' : 'idle'); }
}

// ── 字幕渲染 ──────────────────────────────────────────────
function clearEmpty() { $('leftStream').querySelector('.empty-pane')?.remove(); $('rightStream').querySelector('.empty-pane')?.remove(); }
function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function addLine(source, original, translation) {
  clearEmpty();
  const me = source === 'me', stream = me ? $('rightStream') : $('leftStream');
  const time = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const el = document.createElement('div'); el.className = 'line';
  el.innerHTML = `<div class="meta">${time}</div><div class="tr">${esc(translation)}</div><div class="og">${esc(original)}</div>`;
  stream.appendChild(el); stream.scrollTop = stream.scrollHeight;
}

// ── 會議記錄（雙語）儲存 ──────────────────────────────────
function createSession() {
  session = { id: String(Date.now()), title: '', startedAt: Date.now(), endedAt: null,
    langs: { source: $('leftSrc').value, target: $('leftTgt').value, mine: $('rightSrc').value }, entries: [], minutes: null };
}
// 寫入序列化 + 去抖：避免左右兩欄並行寫入互相覆蓋、也避免每句都重寫整份
let persistQueue = Promise.resolve();
let persistTimer = null;
async function persistSession() {
  if (!session || !EXT) return;
  await chrome.storage.local.set({ [`mt_session_${session.id}`]: session });
  const { mt_index = [] } = await chrome.storage.local.get('mt_index');
  let m = mt_index.find(s => s.id === session.id);
  if (!m) { m = { id: session.id, title: session.title, startedAt: session.startedAt, endedAt: session.endedAt, count: 0 }; mt_index.unshift(m); }
  m.count = session.entries.length; m.endedAt = session.endedAt; m.title = session.title;
  await chrome.storage.local.set({ mt_index });
}
function flushPersist() { persistQueue = persistQueue.then(persistSession).catch(() => {}); return persistQueue; }
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; flushPersist(); }, 1500);
}
function appendEntry(source, original, translation) {
  if (!session) return;
  session.entries.push({ t: Date.now(), source, original, translation });
  schedulePersist();
}
async function finalizeSession() {
  if (!session) return;
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  if (!session.entries.length) { if (EXT) await chrome.storage.local.remove(`mt_session_${session.id}`); session = null; return; }
  session.endedAt = Date.now();
  await flushPersist();
  if (EXT) await chrome.storage.local.set({ mt_lastSession: session.id });
  session = null;
}

// ── 開始 / 停止 ───────────────────────────────────────────
function setRunning(on) {
  running = on;
  const b = $('playBtn'); b.classList.toggle('stop', on); b.textContent = on ? '⏹' : '▶';
  $('srcToggle').disabled = on; $('srcComputer').disabled = on; $('srcMic').disabled = on;
}

$('playBtn').addEventListener('click', async () => {
  if (!EXT) { toast('請從擴充功能載入後開啟此頁'); return; }
  if (running) { stopEngine(); toast('已停止 · 可至「📁 會議記錄」檢視雙語逐字稿'); return; }

  const wantComputer = $('srcComputer').checked, wantMic = $('srcMic').checked;
  if (!wantComputer && !wantMic) { toast('請至少選一種聲音來源（電腦聲音 / 麥克風）'); return; }
  if (!cachedKey) { toast('請先在擴充功能彈窗的「API」分頁設定 Gemini 金鑰'); $('srcPanel').classList.remove('show'); return; }
  $('srcPanel').classList.remove('show');

  // 先取得媒體（需使用者手勢，盡量不要在前面 await）
  try {
    if (wantComputer) {
      displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      if (!displayStream.getAudioTracks().length) {
        toast('沒有取得分頁音訊：請在分享視窗選「Chrome 分頁」並開啟「一併分享分頁音訊」');
        stopEngine(); return;
      }
    }
    if (wantMic) {
      const dev = $('micDeviceSel').value;
      micStream = await navigator.mediaDevices.getUserMedia({ audio: dev && dev !== 'default' ? { deviceId: { exact: dev } } : true });
    }
  } catch (err) { toast('啟動失敗：' + err.message); stopEngine(); return; }

  await saveLangSettings();
  cfg = {
    apiKey: cachedKey, glossary: cachedGlossary, voice: cachedVoice,
    leftSrc: $('leftSrc').value, leftTgt: $('leftTgt').value,
    rightSrc: $('rightSrc').value, outboundLang: $('rightTgt').value,
    speakToOther: $('rightTTS').classList.contains('on'), ttsForOthers: $('leftTTS').classList.contains('on'),
    outDevice: $('outDeviceSel').value
  };

  if (displayStream) {
    leftSeg = new Segmenter(new MediaStream(displayStream.getAudioTracks()), (b) => processSegment(b, 'others'),
      { silenceHold: 650, onLevel: (f, sp) => updateVu('others', f, sp) });
    leftSeg.start();
    setPaneStatus('others', 'listen');
    displayStream.getVideoTracks().forEach(t => t.addEventListener('ended', () => { if (running) stopEngine(); }));
    displayStream.getAudioTracks()[0]?.addEventListener('ended', () => { if (running) stopEngine(); });
  }
  if (micStream) {
    rightSeg = new Segmenter(micStream, (b) => processSegment(b, 'me'),
      { silenceHold: 750, onLevel: (f, sp) => updateVu('me', f, sp) });
    rightSeg.start();
    setPaneStatus('me', 'listen');
    refreshDevices();
  }

  createSession(); clearEmpty(); setRunning(true); startTimer();
  toast('翻譯中… 有收到聲音時對應欄位的音波會跳動');
});

function stopEngine() {
  if (leftSeg) { leftSeg.stop(); leftSeg = null; }
  if (rightSeg) { rightSeg.stop(); rightSeg = null; }
  if (displayStream) { displayStream.getTracks().forEach(t => t.stop()); displayStream = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  ['others', 'me'].forEach(s => { paneProc[s] = 0; resetVu(s); setPaneStatus(s, 'idle'); });
  finalizeSession(); setRunning(false); stopTimer(); cfg = null;
}

// 關閉分頁時若仍在翻譯，盡力收尾並存檔
window.addEventListener('beforeunload', () => { if (running) stopEngine(); });

// ── 關鍵詞 ────────────────────────────────────────────────
$('kwBtn').addEventListener('click', () => { $('kwInput').value = cachedGlossary || ''; $('kwScrim').classList.add('show'); });
$('kwCancel').addEventListener('click', () => $('kwScrim').classList.remove('show'));
$('kwScrim').addEventListener('click', (e) => { if (e.target === $('kwScrim')) $('kwScrim').classList.remove('show'); });
$('kwSave').addEventListener('click', async () => {
  const v = $('kwInput').value.trim();
  cachedGlossary = v;
  if (EXT) await chrome.storage.sync.set({ glossary: v });
  $('kwScrim').classList.remove('show'); $('kwBtn').classList.toggle('on', !!v); toast('關鍵詞已儲存');
});

// ── 會議記錄入口 ──────────────────────────────────────────
$('recordsBtn').addEventListener('click', () => { if (EXT) chrome.tabs.create({ url: chrome.runtime.getURL('minutes.html') }); });

// ── 音訊檔翻譯（整檔）──────────────────────────────────────
$('fileBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !EXT) return;
  if (running) { toast('請先停止即時翻譯，再匯入音訊檔'); e.target.value = ''; return; }
  if (!cachedKey) { toast('請先設定 Gemini API Key'); e.target.value = ''; return; }
  const srcLang = $('leftSrc').value, tgtLang = $('leftTgt').value;
  clearEmpty(); $('timer').textContent = '辨識中…'; toast('上傳並辨識中（檔案越長越久）…');
  try {
    const segs = await window.gemini.audioSegments({ apiKey: cachedKey, audioBlob: file, sourceName: nameOf(srcLang), targetName: nameOf(tgtLang) || '繁體中文', glossary: cachedGlossary });
    if (!segs.length) { toast('未辨識到語音內容'); $('timer').textContent = '00:00:00'; return; }
    const base = Date.now();
    const entries = segs.map((s, i) => ({ t: base + i * 4000, source: 'others', original: s.original, translation: s.translation }));
    entries.forEach(en => addLine('others', en.original, en.translation));
    $('timer').textContent = '00:00:00';
    const id = await saveFileSession(file.name.replace(/\.[^.]+$/, ''), entries, { source: srcLang, target: tgtLang });
    toast('完成！已存成會議記錄');
    if (confirm('音訊檔翻譯完成，是否開啟雙語會議記錄？')) chrome.tabs.create({ url: chrome.runtime.getURL('minutes.html') + '?id=' + id });
  } catch (err) { toast('處理失敗：' + err.message); $('timer').textContent = '00:00:00'; }
  finally { e.target.value = ''; }
});
async function saveFileSession(name, entries, langs) {
  const id = String(Date.now());
  const s = { id, title: name, startedAt: Date.now(), endedAt: Date.now(), langs, entries, minutes: null };
  await chrome.storage.local.set({ [`mt_session_${id}`]: s });
  const { mt_index = [] } = await chrome.storage.local.get('mt_index');
  mt_index.unshift({ id, title: name, startedAt: s.startedAt, endedAt: s.endedAt, count: entries.length });
  await chrome.storage.local.set({ mt_index, mt_lastSession: id });
  return id;
}

// ── 初始化 ────────────────────────────────────────────────
(async function init() {
  let saved = {};
  if (EXT) {
    saved = await chrome.storage.sync.get(['geminiKey', 'sourceLang', 'targetLang', 'myLang', 'outboundLang', 'ttsForOthers', 'speakToOther', 'glossary', 'ttsVoice']);
    cachedKey = saved.geminiKey || ''; cachedGlossary = saved.glossary || ''; cachedVoice = saved.ttsVoice || 'Kore';
    // TTS 預設關閉：每次開啟頁面都從 off 起始，需要時再手動打開
    $('leftTTS').classList.remove('on');
    $('rightTTS').classList.remove('on');
    if (saved.glossary) $('kwBtn').classList.add('on');
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'sync') return;
      if (ch.geminiKey) cachedKey = ch.geminiKey.newValue || '';
      if (ch.glossary) cachedGlossary = ch.glossary.newValue || '';
      if (ch.ttsVoice) cachedVoice = ch.ttsVoice.newValue || 'Kore';
    });
    refreshDevices();
  } else {
    toast('預覽模式：載入擴充功能後從圖示開啟可即時翻譯');
  }
  setupLangs(saved);
  updateSrcLabel();
  buildVu();
})();
