const popupUI = window.EdgeRecoveryUI;

const subtitleEl = document.getElementById('subtitle');
const statusEl = document.getElementById('status');
const previewListEl = document.getElementById('previewList');
const snapshotTimeEl = document.getElementById('snapshotTime');
const windowCountEl = document.getElementById('windowCount');
const tabCountEl = document.getElementById('tabCount');

const saveCheckpointBtn = document.getElementById('saveCheckpointBtn');
const restoreLatestBtn = document.getElementById('restoreLatestBtn');
const refreshBtn = document.getElementById('refreshBtn');
const openPreviewBtn = document.getElementById('openPreviewBtn');

let currentPreview = null;
let selectedWindowId = null;
let lastStatusText = '正在加载预览…';

refreshBtn.addEventListener('click', () => loadPreview());
openPreviewBtn.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('preview.html') }));

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

restoreLatestBtn.addEventListener('click', async () => {
  restoreLatestBtn.disabled = true;
  const previousText = restoreLatestBtn.textContent;
  restoreLatestBtn.textContent = '恢复中…';
  showStatus('正在恢复最新状态…');

  try {
    const result = await chrome.runtime.sendMessage({ type: 'restoreLatestState' });
    if (!result?.ok) {
      throw new Error(result?.error || '恢复最新状态失败');
    }
    await loadPreview({ successMessage: '最新状态恢复完成。' });
  } catch (error) {
    showStatus(error?.message || String(error));
  } finally {
    restoreLatestBtn.disabled = false;
    restoreLatestBtn.textContent = previousText;
  }
});

function setSummary(checkpoint, allWindows, selectedWindows) {
  snapshotTimeEl.textContent = popupUI.formatTime(checkpoint?.createdAt, '—');
  windowCountEl.textContent = String(selectedWindows.length || allWindows.length);
  tabCountEl.textContent = String(popupUI.countTabs(selectedWindows.length ? selectedWindows : allWindows));
}

function showStatus(text) {
  lastStatusText = text;
  statusEl.textContent = text;
  statusEl.classList.remove('hidden');
}

function hideStatus() {
  statusEl.classList.add('hidden');
}

function bindWindowSelector() {
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
    setSummary(checkpoint, [], []);
    previewListEl.innerHTML = '';
    showStatus(successMessage || '还没有可预览的快照。先手动保存一次 checkpoint。');
    return;
  }

  const selectedWindows = popupUI.getSelectedWindows(windows, selectedWindowId);
  if (!selectedWindowId && selectedWindows[0]) {
    selectedWindowId = selectedWindows[0].id;
  }

  setSummary(checkpoint, windows, selectedWindows);
  previewListEl.innerHTML = `${popupUI.renderToolbar({ showOpenPreview: true })}${popupUI.renderWindowSelector(windows, selectedWindowId)}${selectedWindows.map((win, index) => popupUI.renderWindowCard(win, index)).join('')}`;
  previewListEl.classList.remove('hidden');
  bindWindowSelector();
  bindInlineActions();

  if (successMessage) {
    showStatus(successMessage);
  } else if (lastStatusText && lastStatusText.includes('失败')) {
    showStatus(lastStatusText);
  } else {
    hideStatus();
  }
}

function bindInlineActions() {
  const saveBtn = document.getElementById('inlineSaveCheckpointBtn');
  const restoreBtn = document.getElementById('inlineRestoreLatestBtn');
  const openPreviewInlineBtn = document.getElementById('inlineOpenPreviewBtn');

  if (saveBtn) {
    saveBtn.addEventListener('click', () => saveCheckpointBtn.click());
  }
  if (restoreBtn) {
    restoreBtn.addEventListener('click', () => restoreLatestBtn.click());
  }
  if (openPreviewInlineBtn) {
    openPreviewInlineBtn.addEventListener('click', () => openPreviewBtn.click());
  }
}

async function loadPreview(options = {}) {
  showStatus(options.successMessage || '正在加载预览…');
  try {
    const preview = await chrome.runtime.sendMessage({ type: 'get-latest-preview' });
    if (!preview || preview.error) {
      showStatus(preview?.error || '读取预览失败');
      previewListEl.innerHTML = '';
      return;
    }
    renderPreview(preview, options);
  } catch (error) {
    showStatus(error?.message || String(error));
    previewListEl.innerHTML = '';
  }
}

loadPreview();
