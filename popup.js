const popupUI = window.EdgeRecoveryUI;

const topbarMount = document.getElementById('topbarMount');
const statusEl = document.getElementById('status');
const previewListEl = document.getElementById('previewList');
const importFileInput = document.getElementById('importFileInput');

let currentPreview = null;
let selectedWindowId = null;
let selectedCheckpointId = null;
let lastStatusText = '正在加载预览…';

function renderTopbar(preview) {
  const checkpoint = preview?.checkpoint;
  const checkpoints = Array.isArray(preview?.checkpoints) ? preview.checkpoints : [];
  const effectiveCheckpointId = checkpoint?.id || selectedCheckpointId || checkpoints[0]?.id || '';
  const subtitle = checkpoint
    ? `${checkpoint.windowCount ?? 0} 窗口，${checkpoint.tabCount ?? 0} 标签`
    : '还没有可用 checkpoint';
  topbarMount.innerHTML = popupUI.renderTopbar({
    title: '历史记录',
    subtitle,
    checkpoints,
    currentCheckpointId: effectiveCheckpointId,
    showOpenPreview: false
  });
  bindTopbarActions();
}

function getButtons() {
  return {
    deleteCheckpointBtn: document.getElementById('deleteCheckpointBtn'),
    checkpointSelect: document.getElementById('checkpointSelect'),
    saveCheckpointBtn: document.getElementById('saveCheckpointBtn'),
    restoreLatestBtn: document.getElementById('restoreLatestBtn'),
    exportBtn: document.getElementById('exportBtn'),
    importBtn: document.getElementById('importBtn'),
    refreshBtn: document.getElementById('refreshBtn'),
    checkpointManagerBtn: document.getElementById('checkpointManagerBtn')
  };
}

function bindTopbarActions() {
  const { deleteCheckpointBtn, checkpointSelect, saveCheckpointBtn, restoreLatestBtn, exportBtn, importBtn, refreshBtn, checkpointManagerBtn } = getButtons();

  refreshBtn?.addEventListener('click', () => loadPreview({ checkpointId: selectedCheckpointId }));
  importBtn?.addEventListener('click', () => importFileInput.click());
  checkpointManagerBtn?.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('checkpoints.html') }));
  checkpointSelect?.addEventListener('change', async () => {
    selectedCheckpointId = checkpointSelect.value || null;
    selectedWindowId = null;
    await loadPreview({ checkpointId: selectedCheckpointId });
  });
  deleteCheckpointBtn?.addEventListener('click', async () => {
    const checkpointId = currentPreview?.checkpoint?.id;
    if (!checkpointId) return;
    const confirmed = window.confirm(`确定删除当前 checkpoint？\n\n${checkpointId}`);
    if (!confirmed) return;
    await withButtonBusy(deleteCheckpointBtn, '', async () => {
      showStatus('正在删除 checkpoint…');
      const result = await chrome.runtime.sendMessage({ type: 'deleteCheckpoint', checkpointId });
      if (!result?.ok) throw new Error(result?.error || '删除 checkpoint 失败');
      selectedCheckpointId = null;
      selectedWindowId = null;
      await loadPreview({ successMessage: 'checkpoint 已删除。' });
    });
  });

  saveCheckpointBtn?.addEventListener('click', async () => {
    await withButtonBusy(saveCheckpointBtn, '⏳', async () => {
      showStatus('正在保存 checkpoint…');
      const result = await chrome.runtime.sendMessage({ type: 'captureCheckpoint' });
      if (!result?.ok) throw new Error(result?.error || '保存 checkpoint 失败');
      selectedCheckpointId = result?.checkpoint?.id || null;
      selectedWindowId = null;
      await loadPreview({ checkpointId: selectedCheckpointId, successMessage: 'checkpoint 已保存。' });
    });
  });

  restoreLatestBtn?.addEventListener('click', async () => {
    await withButtonBusy(restoreLatestBtn, '✘', async () => {
      const checkpointId = currentPreview?.checkpoint?.id || selectedCheckpointId;
      if (!checkpointId) throw new Error('当前没有可恢复的 checkpoint');
      showStatus('正在恢复当前 checkpoint…');
      startRestoreStatusPolling();
      const result = await chrome.runtime.sendMessage({ type: 'restoreCheckpoint', checkpointId });
      if (!result?.ok) throw new Error(result?.error || '恢复 checkpoint 失败');
      selectedWindowId = null;
      await loadPreview({ checkpointId, successMessage: '当前 checkpoint 已恢复。' });
    });
  });

  exportBtn?.addEventListener('click', async () => {
    await withButtonBusy(exportBtn, '导出中…', async () => {
      const checkpointId = currentPreview?.checkpoint?.id || selectedCheckpointId;
      showStatus('正在导出 checkpoint…');
      const message = checkpointId
        ? { type: 'exportCheckpoint', checkpointId }
        : { type: 'exportLatestCheckpoint' };
      const result = await chrome.runtime.sendMessage(message);
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

function bindFaviconFallbacks() {
  previewListEl.querySelectorAll('img.favicon-img').forEach((img) => {
    img.addEventListener('error', () => {
      const fallback = document.createElement('span');
      fallback.className = 'icon fallback-icon';
      fallback.textContent = '🌐';
      img.replaceWith(fallback);
    }, { once: true });
  });
}

function renderPreview(preview, { successMessage = '' } = {}) {
  currentPreview = preview;
  selectedCheckpointId = preview?.checkpoint?.id || selectedCheckpointId || null;
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
  bindFaviconFallbacks();

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
    const message = options.checkpointId
      ? { type: 'getCheckpointPreview', checkpointId: options.checkpointId }
      : { type: 'get-latest-preview' };
    const response = await chrome.runtime.sendMessage(message);
    const preview = response?.preview || response;
    if (!preview || preview.error || response?.ok === false) {
      renderTopbar(null);
      showStatus(response?.error || preview?.error || '读取预览失败', true);
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

// 恢复进度轮询
let restorePollingTimer = null;

function startRestoreStatusPolling() {
  stopRestoreStatusPolling();
  restorePollingTimer = setInterval(pollRestoreStatus, 500);
}

function stopRestoreStatusPolling() {
  if (restorePollingTimer) {
    clearInterval(restorePollingTimer);
    restorePollingTimer = null;
  }
}

async function pollRestoreStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'getRestoreStatus' });
    const status = response?.restoreStatus;
    if (!status) {
      stopRestoreStatusPolling();
      return;
    }
    if (status.phase === 'restoring') {
      showStatus(`恢复中… 窗口 ${status.currentWindow}/${status.totalWindows}，标签 ${status.restoredTabs}/${status.totalTabs}`);
    } else if (status.phase === 'done') {
      showStatus(`恢复完成！共 ${status.totalWindows} 个窗口，${status.totalTabs} 个标签`);
      stopRestoreStatusPolling();
    }
  } catch {
    stopRestoreStatusPolling();
  }
}

// 打开 popup 时检查是否有正在进行的恢复
void pollRestoreStatus();
