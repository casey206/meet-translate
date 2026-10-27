// MeetTranslate — 會議記錄頁邏輯

const $ = (s, r = document) => r.querySelector(s);
const LANG_NAME = {
  'auto': '自動', 'zh-TW': '繁中', 'zh-CN': '簡中', 'zh': '中文',
  'en': '英文', 'ja': '日文', 'ko': '韓文', 'es': '西文', 'fr': '法文',
  'de': '德文', 'th': '泰文', 'vi': '越南文', 'id': '印尼文',
  'pt': '葡文', 'ar': '阿拉伯文', 'ru': '俄文', 'it': '義文'
};

let index = [];
let selectedId = null;
let session = null;
let generating = false;
let minutesLang = 'zh-TW'; // 會議記錄目前檢視的語言

const langName = (c) => (window.LANG_NAME && window.LANG_NAME[c]) || LANG_NAME[c] || c;
// 第二語言：預設用對方語言（非中文、非 auto），否則英文
function defaultAlt() {
  const s = session && session.langs && session.langs.source;
  if (s && s !== 'auto' && s.split('-')[0] !== 'zh') return s;
  return 'en';
}

// ── 工具 ──────────────────────────────────────────────────
const esc = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');
function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}
function fmtDateLong(ts) {
  const d = new Date(ts);
  return d.toLocaleString('zh-TW', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
function duration(s) {
  if (!s.endedAt) return '進行中';
  const m = Math.round((s.endedAt - s.startedAt) / 60000);
  return m < 1 ? '<1 分' : `${m} 分`;
}
function defaultTitle(s) {
  return s.title?.trim() || `會議 ${fmtDate(s.startedAt)}`;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1900);
}

// ── 載入 / 渲染清單 ───────────────────────────────────────
async function loadIndex() {
  const { mt_index = [] } = await chrome.storage.local.get('mt_index');
  index = mt_index;
  $('#sessionCount').textContent = index.length ? `${index.length} 場會議 · Archive` : '— Archive';
  renderList();
}

function renderList() {
  const list = $('#list');
  if (!index.length) {
    list.innerHTML = `<div class="empty-list">尚無會議記錄。<br>開啟 Meet/Zoom 並開始翻譯後，<br>逐字稿會自動存放於此。</div>`;
    return;
  }
  list.innerHTML = index.map(s => `
    <div class="s-card ${s.id === selectedId ? 'active' : ''}" data-id="${s.id}">
      <div class="s-date">${fmtDate(s.startedAt)}</div>
      <div class="s-name">${esc(s.title?.trim() || `會議 ${fmtDate(s.startedAt)}`)}</div>
      <div class="s-meta">
        <span class="tag">${s.count || 0} 句</span>
        <span class="tag">${s.endedAt ? Math.max(1, Math.round((s.endedAt - s.startedAt) / 60000)) + ' 分' : '進行中'}</span>
      </div>
    </div>`).join('');
  list.querySelectorAll('.s-card').forEach(el =>
    el.addEventListener('click', () => selectSession(el.dataset.id)));
}

// ── 選取一場會議 ──────────────────────────────────────────
async function selectSession(id) {
  selectedId = id;
  minutesLang = 'zh-TW';
  const data = await chrome.storage.local.get(`mt_session_${id}`);
  session = data[`mt_session_${id}`];
  renderList();
  if (!session) { $('#placeholder').style.display = 'flex'; $('#detail').style.display = 'none'; return; }
  renderDetail();
}

function renderDetail() {
  $('#placeholder').style.display = 'none';
  const d = $('#detail');
  d.style.display = 'block';
  const langs = session.langs || {};
  const pair = `${LANG_NAME[langs.source] || '自動'} → ${LANG_NAME[langs.target] || '繁中'}`;

  d.innerHTML = `
    <div class="doc-head">
      <div class="doc-eyebrow">Meeting Record</div>
      <input class="doc-title" id="docTitle" type="text" spellcheck="false" value="${escAttr(session.title || '')}" placeholder="${escAttr(defaultTitle(session))}">
      <div class="doc-meta">
        <span class="mi">🗓 ${fmtDateLong(session.startedAt)}</span>
        <span class="mi">⏱ ${duration(session)}</span>
        <span class="mi">💬 ${session.entries.length} 句</span>
        <span class="tag jade">${esc(pair)}</span>
      </div>
    </div>

    <div class="toolbar">
      <button class="btn btn-accent" id="genBtn">${session.minutes ? '↻ 重新產生' : '✦ 產生雙語會議記錄'}</button>
      <select class="select" id="altLangSel" title="第二語言" style="width:auto"></select>
      <button class="btn btn-ghost" id="copyBtn">⧉ 複製</button>
      <button class="btn btn-ghost" id="dlBtn">↓ 下載 Markdown</button>
      <span class="grow"></span>
      <button class="btn btn-ghost" id="delBtn">🗑 刪除</button>
    </div>

    <div id="minutesWrap"></div>

    <div class="transcript-head">
      <span class="eyebrow">逐字稿 Transcript</span><span class="line"></span>
    </div>
    <div id="transcript"></div>
  `;

  renderMinutes();
  renderTranscript();

  $('#genBtn').addEventListener('click', generateMinutes);
  $('#copyBtn').addEventListener('click', copyDoc);
  $('#dlBtn').addEventListener('click', downloadDoc);
  $('#delBtn').addEventListener('click', deleteSession);

  // 第二語言選單（主語言固定繁體中文）
  const altSel = $('#altLangSel');
  if (window.fillLangSelect) {
    window.fillLangSelect(altSel, { includeAuto: false });
    [...altSel.options].forEach(o => { if (o.value === 'zh-TW') o.remove(); });
    altSel.value = (session.minutesAlt && session.minutesAlt.lang) || defaultAlt();
  }
  const titleEl = $('#docTitle');
  // 改用 <input>（避免 contenteditable 與中文輸入法衝突造成重複輸入）
  titleEl.addEventListener('change', () => saveTitle(titleEl.value.trim()));
  titleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); titleEl.blur(); }
  });
}

function renderMinutes() {
  const wrap = $('#minutesWrap');
  if (generating) {
    wrap.innerHTML = `<div class="report"><div class="doc-eyebrow" style="color:var(--accent)">正在產生會議記錄…</div>
      ${[90, 70, 82, 60, 88, 74].map(w => `<div class="skeleton-line" style="width:${w}%"></div>`).join('')}</div>`;
    return;
  }
  if (!session.minutes) {
    wrap.innerHTML = `<div class="report empty">
      <div class="e-ic">✦</div>
      <p>尚未產生會議記錄。<br>AI 會根據下方逐字稿，整理出繁體中文與對方語言「兩個語言版本」的摘要、討論重點、決議與待辦事項。</p>
      <button class="btn btn-accent" id="genBtn2">✦ 立即產生雙語記錄</button>
    </div>`;
    $('#genBtn2').addEventListener('click', generateMinutes);
    return;
  }
  // 雙語切換
  const alt = session.minutesAlt && session.minutesAlt.md ? session.minutesAlt : null;
  if (alt && minutesLang !== 'zh-TW' && minutesLang !== alt.lang) minutesLang = 'zh-TW';
  const body = (alt && minutesLang === alt.lang) ? alt.md : session.minutes;
  const tabs = alt ? `<div class="rep-langs">
      <button class="rl ${minutesLang === 'zh-TW' ? 'on' : ''}" data-l="zh-TW">繁體中文</button>
      <button class="rl ${minutesLang === alt.lang ? 'on' : ''}" data-l="${alt.lang}">${esc(langName(alt.lang))}</button>
    </div>` : '';
  wrap.innerHTML = `<article class="report">${tabs}${mdToHtml(body)}</article>`;
  wrap.querySelectorAll('.rl').forEach(b => b.addEventListener('click', () => { minutesLang = b.dataset.l; renderMinutes(); }));
}

function renderTranscript() {
  const t = $('#transcript');
  if (!session.entries.length) { t.innerHTML = `<p class="note" style="color:var(--paper-faint)">無逐字稿內容。</p>`; return; }
  t.innerHTML = session.entries.map(e => {
    const me = e.source === 'me';
    const primary = me ? e.original : e.translation;
    const sub = me ? e.translation : e.original;
    return `<div class="turn ${me ? 'me' : 'them'}">
      <div class="time">${fmtTime(e.t)}</div>
      <div class="bubble">
        <div class="who">${me ? '我 · 對外' : '對方'}</div>
        <div class="main-text">${esc(primary)}</div>
        ${sub ? `<div class="sub-text">${esc(sub)}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

// ── 產生 AI 會議記錄 ──────────────────────────────────────
async function generateMinutes() {
  if (generating || !session) return;
  const { geminiKey } = await chrome.storage.sync.get(['geminiKey']);
  if (!geminiKey) { toast('請先在擴充功能設定 Google Gemini API Key'); return; }
  const altLang = ($('#altLangSel') && $('#altLangSel').value) || defaultAlt();

  generating = true; renderMinutes();
  try {
    const transcript = session.entries.map(e => {
      const who = e.source === 'me' ? '我' : '對方';
      const text = e.source === 'me' ? e.original : e.translation;
      return `${who}：${text}`;
    }).join('\n');

    const sys = '你是專業的會議記錄員，能用多種語言把雜亂的口語逐字稿整理成清楚、可執行的會議記錄。';
    const promptFor = (lang) => `以下是一場會議的逐字稿（雙語，「我」與「對方」為兩方發言）。請「全程以${lang}」撰寫一份結構清楚的會議記錄，使用 Markdown，包含下列段落（段落標題也請翻成${lang}；某段落若無內容可省略）：會議摘要（3–5 句）、討論重點（條列）、決議事項、待辦事項（盡量標明負責人與期限）、後續追蹤。只輸出 Markdown，不要任何前言或結語。\n\n──── 逐字稿 ────\n${transcript}`;

    // 主語言：繁體中文
    session.minutes = await window.gemini.generate({ apiKey: geminiKey, maxTokens: 2048, system: sys, user: promptFor('繁體中文') });
    // 第二語言
    const altMd = await window.gemini.generate({ apiKey: geminiKey, maxTokens: 2048, system: sys, user: promptFor(langName(altLang)) });
    session.minutesAlt = { lang: altLang, md: altMd };
    session.minutesAt = Date.now();

    await chrome.storage.local.set({ [`mt_session_${session.id}`]: session });
    generating = false; minutesLang = 'zh-TW';
    renderDetail();
    toast('雙語會議記錄已產生 ✓');
  } catch (err) {
    generating = false; renderMinutes();
    toast('錯誤：' + err.message);
  }
}

// ── 標題 / 匯出 / 刪除 ────────────────────────────────────
async function saveTitle(title) {
  if (!session) return;
  session.title = title;
  await chrome.storage.local.set({ [`mt_session_${session.id}`]: session });
  // 重新讀取索引再改，避免覆寫到其他場次的最新計數
  const { mt_index = [] } = await chrome.storage.local.get('mt_index');
  const meta = mt_index.find(s => s.id === session.id);
  if (meta) { meta.title = title; await chrome.storage.local.set({ mt_index }); }
  index = mt_index;
  renderList();
}

function buildMarkdown() {
  let md = `# ${defaultTitle(session)}\n\n`;
  md += `- 時間：${fmtDateLong(session.startedAt)}\n`;
  md += `- 時長：${duration(session)}\n`;
  md += `- 句數：${session.entries.length}\n\n`;
  if (session.minutes) {
    md += `# 會議記錄（繁體中文）\n\n${session.minutes}\n\n`;
    if (session.minutesAlt && session.minutesAlt.md) {
      md += `\n# 會議記錄（${langName(session.minutesAlt.lang)}）\n\n${session.minutesAlt.md}\n\n`;
    }
    md += `---\n\n`;
  }
  md += `## 完整逐字稿（雙語）\n\n`;
  session.entries.forEach(e => {
    const who = e.source === 'me' ? '我' : '對方';
    const primary = e.source === 'me' ? e.original : e.translation;
    const sub = e.source === 'me' ? e.translation : e.original;
    md += `**[${fmtTime(e.t)}] ${who}**：${primary}\n`;
    if (sub) md += `> ${sub}\n`;
    md += `\n`;
  });
  return md;
}

async function copyDoc() {
  try { await navigator.clipboard.writeText(buildMarkdown()); toast('已複製到剪貼簿 ✓'); }
  catch { toast('複製失敗'); }
}

function downloadDoc() {
  const blob = new Blob([buildMarkdown()], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safe = defaultTitle(session).replace(/[\\/:*?"<>|]/g, '_');
  a.href = url; a.download = `${safe}.md`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast('已下載 Markdown ✓');
}

async function deleteSession() {
  if (!session) return;
  if (!confirm('確定刪除這場會議記錄？此動作無法復原。')) return;
  const id = session.id;
  await chrome.storage.local.remove(`mt_session_${id}`);
  index = index.filter(s => s.id !== id);
  await chrome.storage.local.set({ mt_index: index });
  const { mt_lastSession } = await chrome.storage.local.get('mt_lastSession');
  if (mt_lastSession === id) await chrome.storage.local.remove('mt_lastSession');
  selectedId = null; session = null;
  $('#sessionCount').textContent = index.length ? `${index.length} 場會議 · Archive` : '— Archive';
  renderList();
  $('#detail').style.display = 'none';
  $('#placeholder').style.display = 'flex';
  toast('已刪除');
}

// ── 極簡 Markdown 渲染 ────────────────────────────────────
function inline(s) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}
function mdToHtml(md) {
  const lines = md.split('\n');
  let html = '', inUl = false;
  const closeUl = () => { if (inUl) { html += '</ul>'; inUl = false; } };
  for (let raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { closeUl(); continue; }
    let m;
    if ((m = line.match(/^###\s+(.*)/))) { closeUl(); html += `<h3>${inline(m[1])}</h3>`; }
    else if ((m = line.match(/^##\s+(.*)/))) { closeUl(); html += `<h2>${inline(m[1])}</h2>`; }
    else if ((m = line.match(/^#\s+(.*)/))) { closeUl(); html += `<h2>${inline(m[1])}</h2>`; }
    else if ((m = line.match(/^\s*[-*]\s+(.*)/))) { if (!inUl) { html += '<ul>'; inUl = true; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = line.match(/^\s*\d+\.\s+(.*)/))) { if (!inUl) { html += '<ul>'; inUl = true; } html += `<li>${inline(m[1])}</li>`; }
    else { closeUl(); html += `<p>${inline(line)}</p>`; }
  }
  closeUl();
  return html;
}

// ── 啟動 ──────────────────────────────────────────────────
(async function init() {
  await loadIndex();
  const wantId = new URLSearchParams(location.search).get('id');
  if (wantId && index.some(s => s.id === wantId)) selectSession(wantId);
  else if (index.length) selectSession(index[0].id);
})();
