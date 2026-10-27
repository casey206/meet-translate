// MeetTranslate — Background Service Worker（協調者）
// 不直接碰音訊（MV3 service worker 不支援媒體 API），
// 改為：取得分頁擷取的 streamId → 建立 offscreen document → 轉發指令與字幕結果。

let isTranslating = false;
let activeTabId = null;
let currentSessionId = null;
let writeQueue = Promise.resolve(); // 序列化 storage 寫入，避免逐字稿覆寫

const SETTING_KEYS = [
  'geminiKey',
  'sourceLang', 'targetLang', 'myLang', 'outboundLang',
  'showOriginal', 'enableOutbound', 'ttsForOthers', 'glossary',
  'ttsVoice', 'micDeviceId', 'outputDeviceId'
];

const DEFAULTS = {
  sourceLang: 'auto', targetLang: 'zh-TW', myLang: 'zh-TW', outboundLang: 'en',
  showOriginal: true, enableOutbound: false, ttsForOthers: false, glossary: '',
  ttsVoice: 'Kore',
  micDeviceId: 'default', outputDeviceId: 'default'
};

// 廣播事件給 app 主介面
function broadcastApp(kind, payload) {
  chrome.runtime.sendMessage({ type: 'APP_EVENT', kind, ...payload }).catch(() => {});
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get(SETTING_KEYS);
  return { ...DEFAULTS, ...stored };
}

// ── Offscreen document 生命週期 ───────────────────────────
async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument?.();
  if (has) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: '擷取會議分頁與麥克風音訊，進行即時語音辨識、翻譯與語音合成播放。'
  });
}
async function closeOffscreen() {
  if (await chrome.offscreen.hasDocument?.()) {
    await chrome.offscreen.closeDocument();
  }
}

function sendToOffscreen(message) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...message });
}

// ── 會議記錄：逐字稿累積 ──────────────────────────────────
// 索引 mt_index = [{ id, title, startedAt, endedAt, count }]
// 每場完整資料存於 mt_session_<id> = { id, title, startedAt, endedAt, langs, entries:[], minutes }
async function createSession(meta) {
  const id = String(Date.now());
  currentSessionId = id;
  const session = {
    id, title: '', startedAt: Date.now(), endedAt: null,
    langs: meta.langs || {}, entries: [], minutes: null
  };
  await chrome.storage.local.set({ [`mt_session_${id}`]: session });
  const { mt_index = [] } = await chrome.storage.local.get('mt_index');
  mt_index.unshift({ id, title: '', startedAt: session.startedAt, endedAt: null, count: 0 });
  await chrome.storage.local.set({ mt_index });
  return id;
}

function appendEntry(entry) {
  if (!currentSessionId) return;
  const id = currentSessionId;
  writeQueue = writeQueue.then(async () => {
    const key = `mt_session_${id}`;
    const data = await chrome.storage.local.get([key, 'mt_index']);
    const session = data[key];
    if (!session) return;
    session.entries.push(entry);
    const update = { [key]: session };
    const idx = (data.mt_index || []).find(s => s.id === id);
    if (idx) { idx.count = session.entries.length; update.mt_index = data.mt_index; }
    await chrome.storage.local.set(update);
  }).catch(() => {});
}

async function finalizeSession() {
  if (!currentSessionId) return;
  const id = currentSessionId;
  currentSessionId = null;
  await writeQueue; // 確保最後一筆已寫入
  const key = `mt_session_${id}`;
  const data = await chrome.storage.local.get([key, 'mt_index']);
  const session = data[key];
  if (!session) return;
  // 沒有任何內容就丟棄這場
  if (!session.entries.length) {
    const idx = (data.mt_index || []).filter(s => s.id !== id);
    await chrome.storage.local.remove(key);
    await chrome.storage.local.set({ mt_index: idx });
    return;
  }
  session.endedAt = Date.now();
  const update = { [key]: session };
  const meta = (data.mt_index || []).find(s => s.id === id);
  if (meta) { meta.endedAt = session.endedAt; meta.count = session.entries.length; update.mt_index = data.mt_index; }
  await chrome.storage.local.set(update);
  await chrome.storage.local.set({ mt_lastSession: id }); // 供 popup 顯示「查看本次記錄」
}

// ── 開始翻譯 ──────────────────────────────────────────────
async function startTranslation({ tabId, micOnly, captureMic, speakToOther }) {
  if (isTranslating) return;

  const settings = await loadSettings();
  if (!settings.geminiKey) throw new Error('請先在「API」分頁設定 Google Gemini API Key');

  // 取得分頁音訊擷取 streamId（麥克風模式不需要）
  let streamId = null;
  if (!micOnly && tabId != null) {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  }

  await ensureOffscreen();
  const resp = await sendToOffscreen({
    type: 'START',
    settings: { ...settings, streamId, micOnly: !!micOnly, captureMic: !!captureMic, speakToOther }
  });
  if (!resp?.ok) throw new Error(resp?.error || '啟動失敗');

  isTranslating = true;
  activeTabId = (!micOnly && tabId != null) ? tabId : null;
  await createSession({ langs: { source: settings.sourceLang, target: settings.targetLang, mine: settings.myLang } });
  if (activeTabId) notifyTab(activeTabId, { type: 'TRANSLATION_STARTED' });
}

// ── 停止翻譯 ──────────────────────────────────────────────
async function stopTranslation() {
  if (!isTranslating) return;
  isTranslating = false;
  try { await sendToOffscreen({ type: 'STOP' }); } catch {}
  await closeOffscreen();
  await finalizeSession();
  if (activeTabId) notifyTab(activeTabId, { type: 'TRANSLATION_STOPPED' });
  activeTabId = null;
}

function notifyTab(tabId, message) {
  if (tabId) chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

// ── 訊息路由 ──────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 來自 popup 的控制指令
  if (msg.type === 'START_TRANSLATION') {
    startTranslation({ tabId: msg.tabId, micOnly: msg.micOnly, captureMic: msg.captureMic, speakToOther: msg.speakToOther })
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (msg.type === 'STOP_TRANSLATION') {
    stopTranslation()
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (msg.type === 'GET_STATUS') {
    sendResponse({ isTranslating, activeTabId });
    return true;
  }
  if (msg.type === 'SETTINGS_UPDATED') {
    loadSettings().then(s => sendToOffscreen({ type: 'UPDATE_SETTINGS', settings: s }).catch(() => {}));
    sendResponse({ success: true });
    return true;
  }

  // 來自 offscreen 的結果 → 轉給會議分頁的字幕浮層
  if (msg.target === 'background') {
    if (msg.type === 'CAPTION') {
      notifyTab(activeTabId, { type: 'TRANSLATION_RESULT', ...msg });
      broadcastApp('CAPTION', { data: { source: msg.source, original: msg.original, translation: msg.translation } });
      appendEntry({ t: Date.now(), source: msg.source, original: msg.original, translation: msg.translation });
    } else if (msg.type === 'STATUS') {
      notifyTab(activeTabId, { type: 'STATUS', text: msg.text, active: msg.active });
      broadcastApp('STATUS', { text: msg.text, active: msg.active });
    } else if (msg.type === 'ERROR') {
      notifyTab(activeTabId, { type: 'ERROR', message: msg.message });
      broadcastApp('ERROR', { message: msg.message });
    }
  }
});

// 分頁關閉時自動停止
chrome.tabs.onRemoved.addListener((tabId) => {
  if (isTranslating && tabId === activeTabId) stopTranslation();
});
