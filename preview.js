const previewUI = window.EdgeRecoveryUI;

const subtitleEl = document.getElementById('subtitle');
const panelEl = document.getElementById('panel');
const refreshBtn = document.getElementById('refreshBtn');
const openOptionsBtn = document.getElementById('openOptionsBtn');

let currentPreview = null;
let selectedWindowId = null;

refreshBtn.addEventListener('click', () => loadPreview());
openOptionsBtn.addEventListener('click', async () => {
  if (chrome.runtime.openOptionsPage) {
    await chrome.runtime.openOptionsPage();
  }
});

function bindWindowSelector(windows) {
  const select = document.getElementById('windowSelect');
  if (!select) return;
  select.addEventListener('change', (event) => {
    selectedWindowId = event.target.value;
    renderPreview(currentPreview);
  });
}

function renderPreview(preview) {
  currentPreview = preview;
  const checkpoint = preview?.checkpoint || null;
  const state = preview?.state || null;
  const windows = Array.isArray(preview?.windows) ? preview.windows : [];

  subtitleEl.textContent = checkpoint
    ? `快照时间：${previewUI.formatTime(checkpoint.createdAt, '未知时间')} · 共 ${windows.length} 个窗口`
    : '没有可用快照';

  if (!checkpoint || windows.length === 0) {
    panelEl.innerHTML = '<div class="empty">还没有可预览的快照。先手动保存一次 checkpoint。</div>';
    return;
  }

  const selectedWindows = previewUI.getSelectedWindows(windows, selectedWindowId);
  if (!selectedWindowId && selectedWindows[0]) {
    selectedWindowId = selectedWindows[0].id;
  }
  const selectedTabCount = previewUI.countTabs(selectedWindows);

  panelEl.innerHTML = `
    <div class="meta">
      <div>快照 ID：${previewUI.escapeHtml(checkpoint.id || '未知')}</div>
      <div>记录时间：${previewUI.escapeHtml(previewUI.formatTime(checkpoint.createdAt, '未知时间'))}</div>
      <div>来源：${previewUI.escapeHtml(preview?.source || 'checkpoint')}</div>
    </div>
    ${previewUI.renderWindowSelector(windows, selectedWindowId)}
    <div class="meta">
      <div>窗口总数：${state?.windowCount ?? windows.length}</div>
      <div>页签总数：${state?.tabCount ?? previewUI.countTabs(windows)}</div>
      <div>当前预览窗口：${selectedWindows.length}</div>
      <div>当前预览页签：${selectedTabCount}</div>
    </div>
    ${selectedWindows.map(previewUI.renderWindowCard).join('')}
  `;

  bindWindowSelector(windows);
}

async function loadPreview() {
  panelEl.innerHTML = '<div class="loading">正在加载预览…</div>';
  try {
    const preview = await chrome.runtime.sendMessage({ type: 'get-latest-preview' });
    if (!preview || preview.error) {
      panelEl.innerHTML = `<div class="error">${previewUI.escapeHtml(preview?.error || '读取预览失败')}</div>`;
      return;
    }
    renderPreview(preview);
  } catch (error) {
    panelEl.innerHTML = `<div class="error">${previewUI.escapeHtml(error?.message || String(error))}</div>`;
  }
}

loadPreview();
