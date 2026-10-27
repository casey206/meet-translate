// 共用 Google Gemini API 封裝（辨識 + 翻譯 + 語音合成 + 摘要）
// 一把 Google AI Studio 金鑰即可。給 offscreen / app / minutes 共用。
(function () {
  const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
  const TEXT_MODEL = 'gemini-3.5-flash';            // 最新穩定版：多模態音訊辨識＋翻譯＋文字
  const TTS_MODEL = 'gemini-3.1-flash-tts-preview'; // 最新語音合成
  // 即時翻譯用低思考量降低延遲（Gemini 3 預設會動態思考）
  const FAST_THINK = { thinkingLevel: 'low' };

  // ── 工具 ──────────────────────────────────────────────
  function blobToBase64(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onloadend = () => res(String(r.result).split(',')[1]);
      r.onerror = rej;
      r.readAsDataURL(blob);
    });
  }
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function stripFences(t) {
    return (t || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  }
  // 把 Gemini 回傳的 PCM（16-bit LE mono）包成可播放的 WAV
  function pcmToWav(pcm, sampleRate) {
    const dataSize = pcm.length;
    const buf = new ArrayBuffer(44 + dataSize);
    const v = new DataView(buf);
    let p = 0;
    const str = (s) => { for (let i = 0; i < s.length; i++) v.setUint8(p++, s.charCodeAt(i)); };
    const u32 = (n) => { v.setUint32(p, n, true); p += 4; };
    const u16 = (n) => { v.setUint16(p, n, true); p += 2; };
    str('RIFF'); u32(36 + dataSize); str('WAVE');
    str('fmt '); u32(16); u16(1); u16(1); u32(sampleRate); u32(sampleRate * 2); u16(2); u16(16);
    str('data'); u32(dataSize);
    new Uint8Array(buf, 44).set(pcm);
    return new Blob([buf], { type: 'audio/wav' });
  }

  // Gemini 可接受的音訊格式（webm 不在內！需轉檔）
  const SUPPORTED_AUDIO = /audio\/(wav|x-wav|mpeg|mp3|aac|ogg|flac|aiff|x-aiff)/i;
  let _decodeCtx = null;
  function decodeCtx() {
    if (!_decodeCtx) _decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
    return _decodeCtx;
  }
  // 解碼任意瀏覽器可播放的音訊 → 降為單聲道 + 重取樣 → 16-bit PCM WAV（Gemini 支援）
  async function blobToWav(blob, targetRate = 16000) {
    const audioBuf = await decodeCtx().decodeAudioData(await blob.arrayBuffer());
    const ch = audioBuf.numberOfChannels, len = audioBuf.length;
    const mono = new Float32Array(len);
    for (let c = 0; c < ch; c++) { const d = audioBuf.getChannelData(c); for (let i = 0; i < len; i++) mono[i] += d[i] / ch; }
    const srcRate = audioBuf.sampleRate;
    let out = mono, outRate = srcRate;
    if (targetRate && targetRate < srcRate) {
      const ratio = srcRate / targetRate, newLen = Math.floor(len / ratio);
      out = new Float32Array(newLen);
      for (let i = 0; i < newLen; i++) out[i] = mono[Math.floor(i * ratio)];
      outRate = targetRate;
    }
    const pcm = new Uint8Array(out.length * 2);
    const view = new DataView(pcm.buffer);
    for (let i = 0; i < out.length; i++) { const s = Math.max(-1, Math.min(1, out[i])); view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true); }
    return pcmToWav(pcm, outRate);
  }
  // 確保送進 Gemini 的是支援格式；webm 等不支援者轉成 WAV
  async function toGeminiAudio(blob) {
    if (blob.type && SUPPORTED_AUDIO.test(blob.type)) return blob;
    try { return await blobToWav(blob); }
    catch (e) { console.warn('音訊轉檔失敗，改用原始格式送出', e); return blob; }
  }

  async function callGenerate(apiKey, model, body) {
    const res = await fetch(`${BASE}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error?.message || `Gemini 請求失敗 (${res.status})`);
    }
    return res.json();
  }
  function firstText(data) {
    return (data.candidates?.[0]?.content?.parts || [])
      .map(p => p.text).filter(Boolean).join('').trim();
  }

  function glossLine(glossary) {
    return glossary ? ` 請優先採用以下關鍵詞／專有名詞對照以確保一致與精準：${glossary}。` : '';
  }

  // ── 音訊：辨識 + 翻譯（一次完成）→ {original, translation} ──
  async function audio({ apiKey, audioBlob, sourceName, targetName, glossary }) {
    const wav = await toGeminiAudio(audioBlob);
    const b64 = await blobToBase64(wav);
    const srcDesc = sourceName ? `音訊語言為${sourceName}。` : '自動判斷音訊語言。';
    const prompt = `你是專業的即時會議口譯員。${srcDesc}請先逐字轉錄這段語音，再翻譯成${targetName}，語氣自然口語、符合會議情境。${glossLine(glossary)}只輸出嚴格 JSON：{"original":"<原文逐字>","translation":"<${targetName}翻譯>"}`;
    const data = await callGenerate(apiKey, TEXT_MODEL, {
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: wav.type || 'audio/wav', data: b64 } }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', thinkingConfig: FAST_THINK }
    });
    try { const o = JSON.parse(stripFences(firstText(data))); return { original: o.original || '', translation: o.translation || '' }; }
    catch { return { original: '', translation: '' }; }
  }

  // ── 音訊檔：辨識 + 翻譯 + 分段 → {segments:[{original,translation}]} ──
  async function audioSegments({ apiKey, audioBlob, sourceName, targetName, glossary }) {
    const snd = await toGeminiAudio(audioBlob);
    const b64 = await blobToBase64(snd);
    const srcDesc = sourceName ? `音訊語言為${sourceName}。` : '自動判斷音訊語言。';
    const prompt = `你是專業的會議記錄員。${srcDesc}請逐字轉錄這段錄音並翻譯成${targetName}，依自然語句／發言切分成多段。${glossLine(glossary)}只輸出嚴格 JSON：{"segments":[{"original":"<原文>","translation":"<${targetName}翻譯>"}]}`;
    const data = await callGenerate(apiKey, TEXT_MODEL, {
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: snd.type || 'audio/wav', data: b64 } }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', thinkingConfig: FAST_THINK }
    });
    try { const o = JSON.parse(stripFences(firstText(data))); return (o.segments || []).filter(s => s.original); }
    catch { return []; }
  }

  // ── 純文字翻譯 ────────────────────────────────────────
  async function translate({ apiKey, text, targetName, sourceName, glossary }) {
    if (!text) return '';
    const srcDesc = sourceName ? `（原文語言：${sourceName}）` : '';
    const prompt = `將以下文字翻譯成${targetName}，自然口語、精準。${glossLine(glossary)}只輸出翻譯結果，不要任何解釋或引號。\n\n${srcDesc}${text}`;
    const data = await callGenerate(apiKey, TEXT_MODEL, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'text/plain', thinkingConfig: FAST_THINK }
    });
    return firstText(data);
  }

  // ── 通用生成（會議記錄摘要）────────────────────────────
  async function generate({ apiKey, system, user, maxTokens }) {
    const data = await callGenerate(apiKey, TEXT_MODEL, {
      system_instruction: system ? { parts: [{ text: system }] } : undefined,
      contents: [{ parts: [{ text: user }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: maxTokens || 2048 }
    });
    return firstText(data);
  }

  // ── 語音合成 → 可播放的 WAV Blob ──────────────────────
  async function tts({ apiKey, text, voice }) {
    const data = await callGenerate(apiKey, TTS_MODEL, {
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || 'Kore' } } }
      }
    });
    const part = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData || p.inline_data);
    const inline = part?.inlineData || part?.inline_data;
    if (!inline?.data) throw new Error('語音合成沒有回傳音訊');
    const mime = inline.mimeType || inline.mime_type || 'audio/L16;rate=24000';
    const rate = parseInt((mime.match(/rate=(\d+)/) || [])[1] || '24000', 10);
    return pcmToWav(b64ToBytes(inline.data), rate);
  }

  // ── 驗證金鑰 ──────────────────────────────────────────
  async function verifyKey(apiKey) {
    const res = await fetch(BASE, { headers: { 'x-goog-api-key': apiKey } });
    return res.ok;
  }

  window.gemini = { audio, audioSegments, translate, generate, tts, verifyKey };
})();
