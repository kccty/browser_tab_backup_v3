const previewUI = window.EdgeRecoveryUI;

const subtitleEl = document.getElementById('subtitle');
const panelEl = document.getElementById('panel');
const refreshBtn = document.getElementById('refreshBtn');
const saveCheckpointBtn = document.getElementById('saveCheckpointBtn');
const restoreLatestBtn = document.getElementById('restoreLatestBtn');
const openPopupBtn = document.getElementById('openPopupBtn');

let currentPreview = null;
let selectedWindowId = null;
let lastMessage = '';

refreshBtn.addEventListener('click', () => loadPreview());
saveCheckpointBtn.addEventListener('click', async () => {
  saveCheckpointBtn.disabled = true;
  const previousText = saveCheckpointBtn.textContent;
  saveCheckpointBtn.textContent = '保存中…';
  renderMessage('正在保存 checkpoint…');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'captureCheckpoint' });
    if (!result?.ok) {
      throw new Error(result?.error || '保存 checkpoint 失败');
    }
    selectedWindowId = null;
    await loadPreview({ successMessage: 'checkpoint 已保存，预览已刷新。' });
  } catch (error) {
    renderMessage(error?.message || String(error), true);
  } finally {
    saveCheckpointBtn.disabled = false;
    saveCheckpointBtn.textContent = previousText;
  }
});

restoreLatestBtn.addEventListener('click', async () => {
  restoreLatestBtn.disabled = true;
  const previousText = restoreLatestBtn.textContent;
  restoreLatestBtn.textContent = '恢复中…';
  renderMessage('正在恢复最新状态…');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'restoreLatestState' });
    if (!result?.ok) {
      throw new Error(result?.error || '恢复最新状态失败');
    }
    await loadPreview({ successMessage: '最新状态恢复完成。' });
  } catch (error) {
    renderMessage(error?.message || String(error), true);
  } finally {
    restoreLatestBtn.disabled = false;
    restoreLatestBtn.textContent = previousText;
  }
});

openPopupBtn.addEventListener('click', () => {
  window.close();
});

function bindWindowSelector() {
  const select = document.getElementById('windowSelect');
  if (!select) return;
  select.addEventListener('change', (event) => {
    selectedWindowId = event.target.value;
    renderPreview(currentPreview);
  });
}

function bindInlineActions() {
  const saveBtn = document.getElementById('inlineSaveCheckpointBtn');
  const restoreBtn = document.getElementById('inlineRestoreLatestBtn');
  const openPreviewBtn = document.getElementById('inlineOpenPreviewBtn');

  if (saveBtn) saveBtn.addEventListener('click', () => saveCheckpointBtn.click());
  if (restoreBtn) restoreBtn.addEventListener('click', () => restoreLatestBtn.click());
  if (openPreviewBtn) openPreviewBtn.remove();
}

function renderMessage(text, isError = false) {
  lastMessage = text;
  const status = `<div class="${isError ? 'error' : 'loading'}">${previewUI.escapeHtml(text)}</div>`;
  const messageEl = document.getElementById('panelMessage');
  if (messageEl) {
    messageEl.outerHTML = `<div id="panelMessage">${status}</div>`;
    return;
  }
  panelEl.insertAdjacentHTML('afterbegin', `<div id="panelMessage">${status}</div>`);
}

function clearMessage() {
  const messageEl = document.getElementById('panelMessage');
  if (messageEl) messageEl.remove();
}

function renderPreview(preview, { successMessage = '' } = {}) {
  currentPreview = preview;
  const checkpoint = preview?.checkpoint || null;
  const state = preview?.state || null;
  const windows = Array.isArray(preview?.windows) ? preview.windows : [];

  subtitleEl.textContent = checkpoint
    ? `快照时间：${previewUI.formatTime(checkpoint.createdAt, '未知时间')} · 共 ${windows.length} 个窗口`
    : '没有可用快照';

  if (!checkpoint || windows.length === 0) {
    panelEl.innerHTML = '<div class="empty">还没有可预览的快照。先手动保存一次 checkpoint。</div>';
    if (successMessage) renderMessage(successMessage);
    return;
  }

  const selectedWindows = previewUI.getSelectedWindows(windows, selectedWindowId);
  if (!selectedWindowId && selectedWindows[0]) {
    selectedWindowId = selectedWindows[0].id;
  }
  const selectedTabCount = previewUI.countTabs(selectedWindows);

  panelEl.innerHTML = `
    ${previewUI.renderToolbar({ showOpenPreview: false })}
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
    ${selectedWindows.map((win, index) => previewUI.renderWindowCard(win, index)).join('')}
  `;

  bindWindowSelector();
  bindInlineActions();

  if (successMessage) {
    renderMessage(successMessage);
  } else if (lastMessage && lastMessage.includes('失败')) {
    renderMessage(lastMessage, true);
  } else {
    clearMessage();
  }
}

async function loadPreview(options = {}) {
  renderMessage(options.successMessage || '正在加载预览…');
  try {
    const preview = await chrome.runtime.sendMessage({ type: 'get-latest-preview' });
    if (!preview || preview.error) {
      panelEl.innerHTML = `<div class="error">${previewUI.escapeHtml(preview?.error || '读取预览失败')}</div>`;
      return;
    }
    renderPreview(preview, options);
  } catch (error) {
    panelEl.innerHTML = `<div class="error">${previewUI.escapeHtml(error?.message || String(error))}</div>`;
  }
}

loadPreview();
