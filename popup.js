const popupUI = window.EdgeRecoveryUI;

const topbarMount = document.getElementById('topbarMount');
const statusEl = document.getElementById('status');
const previewListEl = document.getElementById('previewList');
const importFileInput = document.getElementById('importFileInput');

let currentPreview = null;
let selectedWindowId = null;
let lastStatusText = '正在加载预览…';

function renderTopbar(preview) {
  const checkpoint = preview?.checkpoint;
  const subtitle = checkpoint ? popupUI.formatTime(checkpoint.createdAt, '未知时间') : '还没有可用 checkpoint';
  topbarMount.innerHTML = popupUI.renderTopbar({
    title: '历史记录',
    subtitle,
    showOpenPreview: true
  });
  bindTopbarActions();
}

function getButtons() {
  return {
    saveCheckpointBtn: document.getElementById('saveCheckpointBtn'),
    restoreLatestBtn: document.getElementById('restoreLatestBtn'),
    exportBtn: document.getElementById('exportBtn'),
    importBtn: document.getElementById('importBtn'),
    refreshBtn: document.getElementById('refreshBtn'),
    openPreviewBtn: document.getElementById('openPreviewBtn')
  };
}

function bindTopbarActions() {
  const { saveCheckpointBtn, restoreLatestBtn, exportBtn, importBtn, refreshBtn, openPreviewBtn } = getButtons();

  refreshBtn?.addEventListener('click', () => loadPreview());
  openPreviewBtn?.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('preview.html') }));
  importBtn?.addEventListener('click', () => importFileInput.click());

  saveCheckpointBtn?.addEventListener('click', async () => {
    await withButtonBusy(saveCheckpointBtn, '⏳', async () => {
      showStatus('正在保存 checkpoint…');
      const result = await chrome.runtime.sendMessage({ type: 'captureCheckpoint' });
      if (!result?.ok) throw new Error(result?.error || '保存 checkpoint 失败');
      selectedWindowId = null;
      await loadPreview({ successMessage: 'checkpoint 已保存。' });
    });
  });

  restoreLatestBtn?.addEventListener('click', async () => {
    await withButtonBusy(restoreLatestBtn, '⏳', async () => {
      showStatus('正在恢复最新状态…');
      const result = await chrome.runtime.sendMessage({ type: 'restoreLatestState' });
      if (!result?.ok) throw new Error(result?.error || '恢复最新状态失败');
      await loadPreview({ successMessage: '最新状态恢复完成。' });
    });
  });

  exportBtn?.addEventListener('click', async () => {
    await withButtonBusy(exportBtn, '导出中…', async () => {
      showStatus('正在导出 checkpoint…');
      const result = await chrome.runtime.sendMessage({ type: 'exportLatestCheckpoint' });
      if (!result?.ok || !result.payload) throw new Error(result?.error || '导出失败');
      downloadCheckpoint(result.payload);
      showStatus('checkpoint 已导出。');
    });
  });
}

importFileInput.addEventListener('change', handleImportFile);

function setStatusStyle(isError = false) {
  statusEl.classList.toggle('error', isError);
}

function showStatus(text, isError = false) {
  lastStatusText = text;
  statusEl.textContent = text;
  setStatusStyle(isError);
  statusEl.classList.remove('hidden');
}

function hideStatus() {
  statusEl.classList.add('hidden');
}

function bindWindowSelector() {
  previewListEl.querySelectorAll('[data-window-id]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedWindowId = button.dataset.windowId;
      renderPreview(currentPreview);
    });
  });
}

function renderPreview(preview, { successMessage = '' } = {}) {
  currentPreview = preview;
  renderTopbar(preview);

  const checkpoint = preview?.checkpoint || null;
  const windows = Array.isArray(preview?.windows) ? preview.windows : [];

  if (!checkpoint || windows.length === 0) {
    previewListEl.innerHTML = '';
    showStatus(successMessage || '还没有可预览的 checkpoint。先点一次保存。');
    return;
  }

  const selectedWindows = popupUI.getSelectedWindows(windows, selectedWindowId);
  if (!selectedWindowId && selectedWindows[0]) {
    selectedWindowId = selectedWindows[0].id;
  }

  previewListEl.innerHTML = `${popupUI.renderWindowSelector(windows, selectedWindowId)}${selectedWindows.map((win, index) => popupUI.renderWindowCard(win, index)).join('')}`;
  previewListEl.classList.remove('hidden');
  bindWindowSelector();

  if (successMessage) {
    showStatus(successMessage);
  } else if (lastStatusText && lastStatusText.includes('失败')) {
    showStatus(lastStatusText, true);
  } else {
    hideStatus();
  }
}

async function loadPreview(options = {}) {
  showStatus(options.successMessage || '正在加载预览…');
  try {
    const preview = await chrome.runtime.sendMessage({ type: 'get-latest-preview' });
    if (!preview || preview.error) {
      renderTopbar(null);
      showStatus(preview?.error || '读取预览失败', true);
      previewListEl.innerHTML = '';
      return;
    }
    renderPreview(preview, options);
  } catch (error) {
    renderTopbar(null);
    showStatus(error?.message || String(error), true);
    previewListEl.innerHTML = '';
  }
}

async function handleImportFile(event) {
  const [file] = event.target.files || [];
  if (!file) return;

  const { importBtn } = getButtons();
  await withButtonBusy(importBtn, '导入中…', async () => {
    showStatus('正在导入 checkpoint 文件…');
    const text = await file.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('导入文件不是有效的 JSON');
    }

    const result = await chrome.runtime.sendMessage({ type: 'importCheckpointFile', payload });
    if (!result?.ok) throw new Error(result?.error || '导入失败');

    selectedWindowId = null;
    await loadPreview({ successMessage: 'checkpoint 已导入。' });
  }).finally(() => {
    importFileInput.value = '';
  });
}

function downloadCheckpoint(payload) {
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const stamp = new Date(payload.checkpoint?.createdAt || payload.exportedAt || Date.now())
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .replace('Z', '');
  anchor.href = url;
  anchor.download = `checkpoint-${stamp}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function withButtonBusy(button, busyText, fn) {
  if (!button) return fn();
  button.disabled = true;
  const previousText = button.textContent;
  button.textContent = busyText;
  try {
    await fn();
  } catch (error) {
    showStatus(error?.message || String(error), true);
  } finally {
    button.disabled = false;
    button.textContent = previousText;
  }
}

document.documentElement.classList.add('page-no-scroll', 'popup-root');
document.body.classList.add('page-no-scroll', 'popup-root');
document.documentElement.style.width = '380px';
document.documentElement.style.minWidth = '380px';
document.documentElement.style.height = '600px';
document.documentElement.style.minHeight = '600px';
document.documentElement.style.maxHeight = '600px';
document.documentElement.style.overflow = 'hidden';
document.body.style.width = '380px';
document.body.style.minWidth = '380px';
document.body.style.height = '600px';
document.body.style.minHeight = '600px';
document.body.style.maxHeight = '600px';
document.body.style.overflow = 'hidden';

renderTopbar(null);
loadPreview();
