// MeetTranslate Popup Script

const $ = (id) => document.getElementById(id);
let isTranslating = false;
let meetTabId = null;

// 是否處於真正的擴充功能環境（預覽視窗沒有 chrome.* API）
const EXT = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id && chrome.tabs && chrome.storage;

// ── 分頁切換（純前端，永遠可用）─────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    $('tab-' + tab.dataset.tab).classList.add('active');
  });
});

function setStatus(text, type = 'idle') {
  const dot = $('statusDot');
  const box = $('statusBox');
  $('statusText').textContent = text;
  dot.className = 'live-dot';
  box.classList.remove('is-err');
  if (type === 'active') dot.classList.add('on');
  if (type === 'error') { dot.classList.add('err'); box.classList.add('is-err'); }
}

function setButtonState(translating) {
  const btn = $('mainBtn');
  isTranslating = translating;
  btn.className = translating ? 'btn btn-danger start-btn' : 'btn btn-accent start-btn';
  btn.innerHTML = translating ? '<span class="ic">⏹</span> 停止翻譯' : '<span class="ic">▶</span> 開始翻譯';
}

// ── 找到會議分頁 ──────────────────────────────────────────
async function findMeetingTab() {
  const patterns = [/meet\.google\.com/, /zoom\.us\/wc\//, /zoom\.us\/j\//];
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && patterns.some(p => p.test(active.url || ''))) return active;
  const all = await chrome.tabs.query({});
  return all.find(t => patterns.some(p => p.test(t.url || ''))) || null;
}

// ── 主按鈕 ────────────────────────────────────────────────
$('mainBtn').addEventListener('click', async () => {
  if (!EXT) { setStatus('請從工具列的擴充功能圖示開啟（非預覽視窗）', 'error'); return; }
  const btn = $('mainBtn');
  btn.disabled = true;
  try {
    if (isTranslating) {
      await chrome.runtime.sendMessage({ type: 'STOP_TRANSLATION' });
      setButtonState(false);
      setStatus('已停止翻譯', 'idle');
      meetTabId = null;
      checkLastSession();
    } else {
      const tab = await findMeetingTab();
      if (!tab) {
        setStatus('找不到 Meet 或 Zoom 會議分頁', 'error');
        btn.disabled = false; return;
      }
      const { geminiKey } = await chrome.storage.sync.get(['geminiKey']);
      if (!geminiKey) {
        setStatus('請先設定 Google Gemini API Key', 'error');
        document.querySelector('[data-tab="api"]').click();
        btn.disabled = false; return;
      }
      meetTabId = tab.id;
      setStatus('正在連接…', 'idle');
      await chrome.tabs.update(tab.id, { active: true });
      const resp = await chrome.runtime.sendMessage({ type: 'START_TRANSLATION', tabId: tab.id });
      if (resp?.success) {
        setButtonState(true);
        setStatus('翻譯中…', 'active');
      } else {
        setStatus('錯誤: ' + (resp?.error || '未知錯誤'), 'error');
        meetTabId = null;
      }
    }
  } catch (err) {
    setStatus('錯誤: ' + err.message, 'error');
  }
  btn.disabled = false;
});

// ── 設定項目（即時儲存）──────────────────────────────────
const SYNC_FIELDS = {
  sourceLang: 'value', targetLang: 'value', myLang: 'value',
  showOriginal: 'checked', enableOutbound: 'checked', ttsForOthers: 'checked',
  ttsVoice: 'value'
};

function wireField(id, prop, storageKey, transform) {
  const el = $(id);
  if (!el) return;
  el.addEventListener('change', async () => {
    if (!EXT) return;
    let v = el[prop];
    if (transform) v = transform(v);
    await chrome.storage.sync.set({ [storageKey]: v });
    chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED' });
  });
}

Object.entries(SYNC_FIELDS).forEach(([id, prop]) => wireField(id, prop, id));
wireField('micDevice', 'value', 'micDeviceId');
wireField('outputDevice', 'value', 'outputDeviceId');

// ── 按鈕：授權 / 教學 / 記錄 ──────────────────────────────
function openExtPage(path) {
  if (!EXT) { setStatus('請從擴充功能圖示開啟', 'error'); return; }
  chrome.tabs.create({ url: chrome.runtime.getURL(path) });
}
$('permBtn').addEventListener('click', () => openExtPage('mic-permission.html'));
$('guideBtn').addEventListener('click', () => {
  if (!EXT) return;
  chrome.tabs.create({ url: 'https://github.com/ExistentialAudio/BlackHole#installation-instructions' });
});
$('openAppBtn').addEventListener('click', () => openExtPage('app.html'));
$('recordsBtn').addEventListener('click', () => openExtPage('minutes.html'));
$('viewLastBtn').addEventListener('click', async () => {
  if (!EXT) return;
  const { mt_lastSession } = await chrome.storage.local.get('mt_lastSession');
  const url = mt_lastSession
    ? chrome.runtime.getURL('minutes.html') + '?id=' + mt_lastSession
    : chrome.runtime.getURL('minutes.html');
  chrome.tabs.create({ url });
});

// 顯示「上一場會議」提示
async function checkLastSession() {
  if (!EXT) return;
  try {
    const { mt_lastSession } = await chrome.storage.local.get('mt_lastSession');
    if (!mt_lastSession) return;
    const s = (await chrome.storage.local.get(`mt_session_${mt_lastSession}`))[`mt_session_${mt_lastSession}`];
    if (!s) return;
    const mins = s.endedAt ? Math.max(1, Math.round((s.endedAt - s.startedAt) / 60000)) : 0;
    $('recallMeta').textContent = `${s.entries.length} 句 · 約 ${mins} 分鐘`;
    $('recall').classList.add('show');
  } catch {}
}

// ── 儲存 API Key ──────────────────────────────────────────
$('saveApiBtn').addEventListener('click', async () => {
  if (!EXT) { setStatus('請從擴充功能圖示開啟', 'error'); return; }
  const geminiKey = $('geminiKey').value.trim();
  if (!geminiKey || geminiKey.startsWith('••••')) { setStatus('請輸入 Gemini API Key', 'error'); return; }
  await chrome.storage.sync.set({ geminiKey });
  const btn = $('saveApiBtn');
  btn.textContent = '✓ 已儲存';
  setTimeout(() => { btn.textContent = '儲存 API Key'; }, 2000);
  setStatus('API Key 已設定，可以開始翻譯', 'idle');
});

$('geminiKey').addEventListener('focus', function () { if (this.value.startsWith('••••')) this.value = ''; });

// ── 載入裝置清單 ──────────────────────────────────────────
async function populateDevices() {
  const { audioInputs, audioOutputs, micGranted } = await chrome.storage.local.get(['audioInputs', 'audioOutputs', 'micGranted']);
  const { micDeviceId, outputDeviceId } = await chrome.storage.sync.get(['micDeviceId', 'outputDeviceId']);
  const micSel = $('micDevice'), outSel = $('outputDevice');
  micSel.innerHTML = '<option value="default">預設</option>';
  outSel.innerHTML = '<option value="default">預設（喇叭）</option>';
  (audioInputs || []).forEach(d => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label; micSel.appendChild(o); });
  (audioOutputs || []).forEach(d => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label; outSel.appendChild(o); });
  if (micDeviceId) micSel.value = micDeviceId;
  if (outputDeviceId) outSel.value = outputDeviceId;
  return micGranted;
}

// ── 載入已儲存設定 ────────────────────────────────────────
async function loadSavedSettings() {
  if (!EXT) {
    setStatus('預覽模式：請載入擴充功能後從圖示開啟', 'error');
    return;
  }
  try {
    const r = await chrome.storage.sync.get([
      'geminiKey', 'sourceLang', 'targetLang', 'myLang',
      'showOriginal', 'enableOutbound', 'ttsForOthers', 'ttsVoice'
    ]);
    if (r.geminiKey) $('geminiKey').value = '••••' + r.geminiKey.slice(-4);
    if (r.sourceLang) $('sourceLang').value = r.sourceLang;
    if (r.targetLang) $('targetLang').value = r.targetLang;
    if (r.myLang) $('myLang').value = r.myLang;
    if (r.showOriginal !== undefined) $('showOriginal').checked = r.showOriginal;
    if (r.enableOutbound !== undefined) $('enableOutbound').checked = r.enableOutbound;
    if (r.ttsForOthers !== undefined) $('ttsForOthers').checked = r.ttsForOthers;
    if (r.ttsVoice) $('ttsVoice').value = r.ttsVoice;

    const micGranted = await populateDevices();

    if (!r.geminiKey) {
      setStatus('請先至「API」分頁設定 Gemini API Key', 'error');
    } else {
      const st = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
      if (st?.isTranslating) { setButtonState(true); setStatus('翻譯中…', 'active'); }
      else if (!micGranted) setStatus('提示：請到「雙向語音」分頁授權麥克風', 'idle');
      else setStatus('就緒，開啟 Meet/Zoom 後點擊開始', 'idle');
    }
  } catch (err) {
    setStatus('載入設定失敗：' + err.message, 'error');
  }
}

// 語言選單與 chrome 環境無關，永遠先填入（之後若有儲存值再覆蓋）
if (window.fillLangSelect) {
  window.fillLangSelect($('sourceLang'), { includeAuto: true, selected: 'auto' });
  window.fillLangSelect($('targetLang'), { includeAuto: false, selected: 'zh-TW' });
  window.fillLangSelect($('myLang'), { includeAuto: false, selected: 'zh-TW' });
}

loadSavedSettings();
checkLastSession();
