const popupUI = window.EdgeRecoveryUI;

const subtitleEl = document.getElementById('subtitle');
const statusEl = document.getElementById('status');
const previewListEl = document.getElementById('previewList');
const snapshotTimeEl = document.getElementById('snapshotTime');
const windowCountEl = document.getElementById('windowCount');
const tabCountEl = document.getElementById('tabCount');

const saveCheckpointBtn = document.getElementById('saveCheckpointBtn');
const refreshBtn = document.getElementById('refreshBtn');
const openPreviewBtn = document.getElementById('openPreviewBtn');
const openOptionsBtn = document.getElementById('openOptionsBtn');

let currentPreview = null;
let selectedWindowId = null;

refreshBtn.addEventListener('click', () => loadPreview());
openPreviewBtn.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('preview.html') }));
openOptionsBtn.addEventListener('click', async () => {
  if (chrome.runtime.openOptionsPage) {
    await chrome.runtime.openOptionsPage();
  }
});

saveCheckpointBtn.addEventListener('click', async () => {
  saveCheckpointBtn.disabled = true;
  const previousText = saveCheckpointBtn.textContent;
  saveCheckpointBtn.textContent = '保存中…';
  showStatus('正在保存 checkpoint…');

  try {
    const result = await chrome.runtime.sendMessage({ type: 'captureCheckpoint' });
    if (!result?.ok) {
      throw new Error(result?.error || '保存 checkpoint 失败');
    }
    selectedWindowId = null;
    await loadPreview({ successMessage: 'checkpoint 已保存，预览已刷新。' });
  } catch (error) {
    showStatus(error?.message || String(error));
  } finally {
    saveCheckpointBtn.disabled = false;
    saveCheckpointBtn.textContent = previousText;
  }
});

function setSummary(checkpoint, windows) {
  snapshotTimeEl.textContent = popupUI.formatTime(checkpoint?.createdAt, '—');
  windowCountEl.textContent = String(windows.length);
  tabCountEl.textContent = String(popupUI.countTabs(windows));
}

function showStatus(text) {
  statusEl.textContent = text;
  statusEl.classList.remove('hidden');
  previewListEl.classList.add('hidden');
}

function bindWindowSelector(windows) {
  const select = document.getElementById('windowSelect');
  if (!select) return;
  select.addEventListener('change', (event) => {
    selectedWindowId = event.target.value;
    renderPreview(currentPreview);
  });
}

function renderPreview(preview, { successMessage = '' } = {}) {
  currentPreview = preview;
  const checkpoint = preview?.checkpoint || null;
  const windows = Array.isArray(preview?.windows) ? preview.windows : [];

  subtitleEl.textContent = checkpoint
    ? `快照时间：${popupUI.formatTime(checkpoint.createdAt, '未知时间')} · 共 ${windows.length} 个窗口`
    : '没有可用快照';

  if (!checkpoint || windows.length === 0) {
    setSummary(checkpoint, []);
    showStatus(successMessage || '还没有可预览的快照。先手动保存一次 checkpoint。');
    return;
  }

  const selectedWindows = popupUI.getSelectedWindows(windows, selectedWindowId);
  if (!selectedWindowId && selectedWindows[0]) {
    selectedWindowId = selectedWindows[0].id;
  }

  setSummary(checkpoint, selectedWindows);
  previewListEl.innerHTML = `${popupUI.renderWindowSelector(windows, selectedWindowId)}${selectedWindows.map(popupUI.renderWindowCard).join('')}`;
  previewListEl.classList.remove('hidden');
  statusEl.classList.add('hidden');
  bindWindowSelector(windows);

  if (successMessage) {
    statusEl.textContent = successMessage;
  }
}

async function loadPreview(options = {}) {
  showStatus(options.successMessage || '正在加载预览…');
  try {
    const preview = await chrome.runtime.sendMessage({ type: 'get-latest-preview' });
    if (!preview || preview.error) {
      showStatus(preview?.error || '读取预览失败');
      return;
    }
    renderPreview(preview, options);
  } catch (error) {
    showStatus(error?.message || String(error));
  }
}

loadPreview();
