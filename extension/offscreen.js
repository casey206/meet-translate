// MeetTranslate — Offscreen 媒體引擎
// MV3 的 service worker 無法錄音/播放音訊，所有媒體工作都集中在這個 offscreen document。
// 負責：分頁音訊擷取、麥克風擷取、VAD 斷句、語音辨識/翻譯/語音合成、把合成語音送到虛擬麥克風。

let settings = {};
let running = false;

let tabStream = null;       // 會議分頁音訊（對方說話）
let micStream = null;       // 我的麥克風
let playbackCtx = null;     // 把分頁音訊導回喇叭，讓你照常聽得到會議
let othersSeg = null;       // 對方語音斷句器
let mySeg = null;           // 我的語音斷句器

// ── 語言對照 ──────────────────────────────────────────────
const LANG_NAME = {
  'zh-TW': '繁體中文', 'zh': '中文', 'yue': '粵語',
  'en': '英文', 'ja': '日文', 'ko': '韓文',
  'es': '西班牙文', 'fr': '法文', 'de': '德文', 'it': '義大利文',
  'pt': '葡萄牙文', 'ru': '俄文', 'nl': '荷蘭文', 'pl': '波蘭文',
  'tr': '土耳其文', 'ar': '阿拉伯文', 'hi': '印地文',
  'th': '泰文', 'vi': '越南文', 'id': '印尼文', 'ms': '馬來文', 'tl': '菲律賓文',
  'uk': '烏克蘭文', 'sv': '瑞典文', 'da': '丹麥文', 'fi': '芬蘭文', 'nb': '挪威文',
  'cs': '捷克文', 'el': '希臘文', 'he': '希伯來文', 'ro': '羅馬尼亞文', 'hu': '匈牙利文'
};

// 取語言中文名（auto 回傳空字串 → 讓 Gemini 自動判斷）
function nameOf(lang) {
  if (!lang || lang === 'auto') return '';
  return LANG_NAME[lang] || lang;
}

// ── 對外送訊息（給 background → content script 顯示字幕）──
function emit(payload) {
  chrome.runtime.sendMessage({ target: 'background', ...payload }).catch(() => {});
}
function status(text, active) {
  emit({ type: 'STATUS', text, active });
}
function reportError(message) {
  emit({ type: 'ERROR', message });
}

// ── Google Gemini：辨識＋翻譯（一次完成）──────────────────
async function transcribeTranslate(blob, sourceLang, targetLang) {
  return window.gemini.audio({
    apiKey: settings.geminiKey,
    audioBlob: blob,
    sourceName: nameOf(sourceLang),
    targetName: nameOf(targetLang) || '繁體中文',
    glossary: settings.glossary
  });
}

// ── Google Gemini 語音合成 → WAV Blob ─────────────────────
async function synthesize(text) {
  return window.gemini.tts({
    apiKey: settings.geminiKey,
    text,
    voice: settings.ttsVoice || 'Kore'
  });
}

// 把合成語音播放到指定輸出裝置（虛擬麥克風 BlackHole）
let ttsQueue = Promise.resolve();
function speakToDevice(blob, deviceId) {
  // 串接成佇列，避免多句語音重疊
  ttsQueue = ttsQueue.then(() => new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    const done = () => { URL.revokeObjectURL(url); resolve(); };
    audio.onended = done;
    audio.onerror = done;
    const play = () => audio.play().catch(done);
    if (deviceId && deviceId !== 'default' && audio.setSinkId) {
      audio.setSinkId(deviceId).then(play).catch(play);
    } else {
      play();
    }
  }));
  return ttsQueue;
}

// ── 處理一段「對方說話」的音訊 ─────────────────────────────
async function handleOthers(blob) {
  try {
    const { original, translation } = await transcribeTranslate(blob, settings.sourceLang, settings.targetLang);
    if (!original || original.length < 2 || !translation) return;
    emit({ type: 'CAPTION', source: 'others', original, translation });

    // 可選：把對方的話也用語音念出來（給聽不慣字幕的人）
    if (settings.ttsForOthers) {
      const speech = await synthesize(translation);
      speakToDevice(speech, 'default'); // 念給「我」聽，走預設喇叭/耳機
    }
  } catch (err) {
    console.error('[others]', err);
    reportError(err.message);
  }
}

// ── 處理一段「我說話」的音訊 → 翻成對方語言 → 講給對方聽 ──
async function handleMine(blob) {
  try {
    // 對方語言：優先用使用者指定的 outboundLang，否則退回來源語言／英文
    const otherLang = (settings.outboundLang && settings.outboundLang !== 'auto')
      ? settings.outboundLang
      : ((settings.sourceLang && settings.sourceLang !== 'auto') ? settings.sourceLang : 'en');
    const { original, translation } = await transcribeTranslate(blob, settings.myLang, otherLang);
    if (!original || original.length < 2 || !translation) return;
    emit({ type: 'CAPTION', source: 'me', original, translation });

    // 是否要把翻譯用語音講給對方（需虛擬麥克風）。未指定時沿用 enableOutbound。
    const speak = (settings.speakToOther !== undefined) ? settings.speakToOther : settings.enableOutbound;
    if (speak) {
      const speech = await synthesize(translation);
      await speakToDevice(speech, settings.outputDeviceId);
    }
  } catch (err) {
    console.error('[mine]', err);
    reportError(err.message);
  }
}

// ── VAD 斷句器：偵測「說話 → 停頓」後切出一段完整語音 ────
class Segmenter {
  constructor(stream, onSegment, opts = {}) {
    this.stream = stream;
    this.onSegment = onSegment;
    this.silenceHold = opts.silenceHold ?? 700;   // 停頓多久算一句結束 (ms)
    this.maxLen = opts.maxLen ?? 12000;           // 單句最長強制切斷 (ms)
    this.minLen = opts.minLen ?? 350;             // 太短的片段（雜音）丟棄 (ms)
    this.threshold = opts.threshold ?? 0.012;     // 音量門檻（RMS）
    this.recorder = null;
    this.chunks = [];
    this.recording = false;
    this.recStart = 0;
    this.lastVoice = 0;
    this.timer = null;
  }

  start() {
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.buf = new Float32Array(this.analyser.fftSize);
    src.connect(this.analyser);

    this.mime = pickMime();
    this.timer = setInterval(() => this.tick(), 50);
  }

  tick() {
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sum / this.buf.length);
    const now = performance.now();

    if (rms > this.threshold) {
      this.lastVoice = now;
      if (!this.recording) this.startRec();
    }
    if (this.recording) {
      const dur = now - this.recStart;
      const silent = now - this.lastVoice;
      if (dur >= this.maxLen || (silent >= this.silenceHold && dur >= this.minLen)) {
        this.stopRec();
      }
    }
  }

  startRec() {
    this.chunks = [];
    try {
      this.recorder = this.mime
        ? new MediaRecorder(this.stream, { mimeType: this.mime })
        : new MediaRecorder(this.stream);
    } catch {
      this.recorder = new MediaRecorder(this.stream);
    }
    this.recorder.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.recorder.onstop = () => {
      const dur = performance.now() - this.recStart;
      const blob = new Blob(this.chunks, { type: this.recorder.mimeType });
      this.chunks = [];
      if (dur >= this.minLen && blob.size > 1200) this.onSegment(blob);
    };
    this.recorder.start();
    this.recording = true;
    this.recStart = performance.now();
  }

  stopRec() {
    this.recording = false;
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopRec();
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null;
  }
}

function pickMime() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

// ── 啟動 / 停止 ────────────────────────────────────────────
async function start(opts) {
  if (running) return;
  settings = opts;

  // 1) 會議分頁音訊（對方說話）— 麥克風模式沒有 streamId 則略過
  if (settings.streamId) {
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: settings.streamId
        }
      }
    });

    // 擷取分頁音訊會讓原本的聲音靜音，這裡導回喇叭讓你照常聽會議
    playbackCtx = new AudioContext();
    playbackCtx.createMediaStreamSource(tabStream).connect(playbackCtx.destination);

    othersSeg = new Segmenter(tabStream, handleOthers, { silenceHold: 650 });
    othersSeg.start();
  }

  // 2) 我的麥克風（雙向語音 / 純麥克風 / 主介面強制收音）
  if (settings.enableOutbound || settings.micOnly || settings.captureMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: settings.micDeviceId && settings.micDeviceId !== 'default'
          ? { deviceId: { exact: settings.micDeviceId } }
          : true
      });
      mySeg = new Segmenter(micStream, handleMine, { silenceHold: 750 });
      mySeg.start();
    } catch (err) {
      reportError('無法取得麥克風，請先到設定頁授權麥克風權限：' + err.message);
    }
  }

  running = true;
  status('翻譯中…', true);
}

function stop() {
  running = false;
  if (othersSeg) { othersSeg.stop(); othersSeg = null; }
  if (mySeg) { mySeg.stop(); mySeg = null; }
  if (tabStream) { tabStream.getTracks().forEach(t => t.stop()); tabStream = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  if (playbackCtx) { playbackCtx.close().catch(() => {}); playbackCtx = null; }
  status('已停止', false);
}

// ── 接收 background 指令 ───────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  if (msg.type === 'START') {
    start(msg.settings)
      .then(() => sendResponse({ ok: true }))
      .catch(err => { reportError(err.message); sendResponse({ ok: false, error: err.message }); });
    return true;
  }
  if (msg.type === 'STOP') {
    stop();
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'UPDATE_SETTINGS') {
    settings = { ...settings, ...msg.settings };
    sendResponse({ ok: true });
    return true;
  }
});
