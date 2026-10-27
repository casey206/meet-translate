// 共用語言清單（給 popup / app 使用）
// 語言代碼（繁中用 zh-TW；Gemini 以語言中文名理解）
window.LANGS = [
  { code: 'auto',  name: '自動偵測' },
  { code: 'zh-TW', name: '繁體中文' },
  { code: 'zh',    name: '中文（普通話）' },
  { code: 'yue',   name: '粵語' },
  { code: 'en',    name: '英文' },
  { code: 'ja',    name: '日文' },
  { code: 'ko',    name: '韓文' },
  { code: 'es',    name: '西班牙文' },
  { code: 'fr',    name: '法文' },
  { code: 'de',    name: '德文' },
  { code: 'it',    name: '義大利文' },
  { code: 'pt',    name: '葡萄牙文' },
  { code: 'ru',    name: '俄文' },
  { code: 'nl',    name: '荷蘭文' },
  { code: 'pl',    name: '波蘭文' },
  { code: 'tr',    name: '土耳其文' },
  { code: 'ar',    name: '阿拉伯文' },
  { code: 'hi',    name: '印地文' },
  { code: 'th',    name: '泰文' },
  { code: 'vi',    name: '越南文' },
  { code: 'id',    name: '印尼文' },
  { code: 'ms',    name: '馬來文' },
  { code: 'tl',    name: '菲律賓文' },
  { code: 'uk',    name: '烏克蘭文' },
  { code: 'sv',    name: '瑞典文' },
  { code: 'da',    name: '丹麥文' },
  { code: 'fi',    name: '芬蘭文' },
  { code: 'nb',    name: '挪威文' },
  { code: 'cs',    name: '捷克文' },
  { code: 'el',    name: '希臘文' },
  { code: 'he',    name: '希伯來文' },
  { code: 'ro',    name: '羅馬尼亞文' },
  { code: 'hu',    name: '匈牙利文' }
];

window.LANG_NAME = Object.fromEntries(window.LANGS.map(l => [l.code, l.name]));

// 填入 <select>；opts: { includeAuto, selected }
window.fillLangSelect = function (sel, opts = {}) {
  if (!sel) return;
  sel.innerHTML = '';
  window.LANGS.forEach(l => {
    if (l.code === 'auto' && !opts.includeAuto) return;
    const o = document.createElement('option');
    o.value = l.code; o.textContent = l.name;
    sel.appendChild(o);
  });
  if (opts.selected) sel.value = opts.selected;
};
