// 一次性麥克風授權頁。授權後列出可用裝置，並把裝置清單存進 storage 供 popup 使用。

const $ = (id) => document.getElementById(id);

$('grant').addEventListener('click', async () => {
  const status = $('status');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // 立即釋放，我們只是要取得授權與裝置標籤
    stream.getTracks().forEach(t => t.stop());

    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter(d => d.kind === 'audioinput')
      .map(d => ({ deviceId: d.deviceId, label: d.label || '未命名麥克風' }));
    const outputs = devices.filter(d => d.kind === 'audiooutput')
      .map(d => ({ deviceId: d.deviceId, label: d.label || '未命名輸出' }));

    await chrome.storage.local.set({ audioInputs: inputs, audioOutputs: outputs, micGranted: true });

    status.className = 'status ok';
    status.textContent = '✓ 已授權！可以關閉此分頁，回到擴充功能設定選擇裝置。';

    renderDevices(inputs, outputs);
  } catch (err) {
    status.className = 'status err';
    status.textContent = '授權失敗：' + err.message + '（請在網址列左側允許麥克風）';
  }
});

function renderDevices(inputs, outputs) {
  const el = $('devices');
  const fmt = (arr) => arr.map(d => '・' + d.label).join('<br>');
  const hasBlackHole = outputs.some(d => /blackhole|virtual|vb-?cable|loopback/i.test(d.label));
  el.innerHTML = `
    <b>偵測到的麥克風：</b><br>${fmt(inputs) || '（無）'}<br><br>
    <b>偵測到的音訊輸出：</b><br>${fmt(outputs) || '（無）'}<br><br>
    ${hasBlackHole
      ? '<span style="color:#0ea672;font-weight:600">✓ 偵測到虛擬音訊裝置，雙向語音可用。</span>'
      : '<span style="color:#c2750a;font-weight:600">⚠ 未偵測到 BlackHole 等虛擬音訊裝置。若要把語音講給對方聽，請先依 SETUP.md 安裝。</span>'}
  `;
}

// 載入時若已授權，直接顯示裝置
(async () => {
  const { micGranted, audioInputs, audioOutputs } = await chrome.storage.local.get(['micGranted', 'audioInputs', 'audioOutputs']);
  if (micGranted && audioInputs) {
    $('status').className = 'status ok';
    $('status').textContent = '✓ 已授權。重新整理裝置清單請再次點擊按鈕。';
    renderDevices(audioInputs, audioOutputs || []);
  }
})();
