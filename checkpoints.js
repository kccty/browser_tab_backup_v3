const ui = window.EdgeRecoveryUI;

const statusEl = document.getElementById('checkpointsStatus');
const listEl = document.getElementById('checkpointsList');
const summaryEl = document.getElementById('checkpointSummary');
const refreshBtn = document.getElementById('refreshCheckpointsBtn');

let selectedCheckpointId = null;
let currentCheckpoints = [];

function showStatus(message) {
  statusEl.textContent = message;
  statusEl.classList.remove('hidden');
}

function hideStatus() {
  statusEl.classList.add('hidden');
}

function formatMeta(item) {
  const parts = [
    `创建时间：${ui.formatTime(item.createdAt, '—')}`,
    `来源：${item.reason || 'unknown'}`,
    `窗口：${item.windowCount ?? 0}`,
    `页签：${item.tabCount ?? 0}`
  ];
  return parts.map((line) => `<div class="checkpoint-meta-line">${ui.escapeHtml(line)}</div>`).join('');
}

function renderPreviewWindows(preview) {
  const previewListEl = document.getElementById('previewSideList');
  const previewSubtitleEl = document.getElementById('previewSubtitle');
  if (!previewListEl || !previewSubtitleEl) return;

  const windows = Array.isArray(preview?.windows) ? preview.windows : [];
  const windowCount = windows.length;
  const tabCount = windows.reduce((sum, win) => sum + (Array.isArray(win.tabs) ? win.tabs.length : 0), 0);
  previewSubtitleEl.textContent = `${windowCount} 窗口，${tabCount} 标签`;

  if (!windows.length) {
    previewListEl.innerHTML = '<div class="event-empty">当前没有可显示的标签</div>';
    return;
  }

  previewListEl.innerHTML = windows.map((win, index) => {
    const tabs = Array.isArray(win.tabs) ? win.tabs : [];
    return `
      <section class="preview-window-card">
        <div class="preview-window-title">${ui.escapeHtml(ui.getWindowLabel(win, index))}</div>
        <div class="preview-window-meta">${tabs.length} 个标签</div>
        <div class="preview-window-tabs">
          ${tabs.map((tab) => `
            <div class="preview-side-tab">
              <span class="preview-side-tab-title">${ui.escapeHtml(tab.title || tab.url || '未命名标签页')}</span>
              <span class="preview-side-tab-url">${ui.escapeHtml(tab.url || '')}</span>
            </div>
          `).join('')}
        </div>
      </section>
    `;
  }).join('');
}

function renderShell(items) {
  listEl.innerHTML = `
    <div class="checkpoints-layout checkpoints-layout-triple">
      <div class="checkpoint-list-column" id="checkpointListColumn"></div>
      <aside class="events-panel" id="eventsPanel">
        <div class="events-panel-header">
          <div>
            <div class="events-panel-title">增量事件</div>
            <div class="events-panel-subtitle" id="eventsSubtitle">选择一个 checkpoint 查看对应增量</div>
          </div>
        </div>
        <div class="event-list" id="eventList">${selectedCheckpointId ? '正在加载增量事件…' : '请选择左侧 checkpoint'}</div>
      </aside>
      <aside class="events-panel preview-side-panel" id="previewSidePanel">
        <div class="events-panel-header">
          <div>
            <div class="events-panel-title">标签预览</div>
            <div class="events-panel-subtitle" id="previewSubtitle">当前 checkpoint + 增量后的标签列表</div>
          </div>
        </div>
        <div class="preview-side-list" id="previewSideList">${selectedCheckpointId ? '正在加载标签预览…' : '请选择左侧 checkpoint'}</div>
      </aside>
    </div>
  `;

  const column = document.getElementById('checkpointListColumn');
  column.innerHTML = items.map((item) => `
    <section class="checkpoint-item ${selectedCheckpointId === item.id ? 'active' : ''}" data-checkpoint-id="${ui.escapeHtml(item.id)}">
      <div class="checkpoint-item-head">
        <div>
          <div class="checkpoint-item-title">${ui.escapeHtml(item.id)}</div>
          <div class="checkpoint-item-time">${ui.escapeHtml(ui.formatTime(item.createdAt, '—'))}</div>
        </div>
        <button class="menu-item checkpoint-export-btn" type="button" data-export-id="${ui.escapeHtml(item.id)}">导出</button>
        <button class="menu-item checkpoint-restore-btn" type="button" data-restore-id="${ui.escapeHtml(item.id)}">恢复</button>
        <button class="menu-item danger checkpoint-delete-btn" type="button" data-delete-id="${ui.escapeHtml(item.id)}">删除</button>
      </div>
      <div class="checkpoint-meta-block">
        ${formatMeta(item)}
      </div>
    </section>
  `).join('');

  bindCheckpointActions(items);
}

function bindCheckpointActions(items) {
  const column = document.getElementById('checkpointListColumn');
  column?.querySelectorAll('[data-checkpoint-id]').forEach((itemEl) => {
    itemEl.addEventListener('click', async (event) => {
      if (event.target.closest('[data-delete-id]') || event.target.closest('[data-export-id]') || event.target.closest('[data-restore-id]')) return;
      selectedCheckpointId = itemEl.dataset.checkpointId || null;
      renderShell(items);
      await Promise.all([
        loadEvents(selectedCheckpointId),
        loadPreview(selectedCheckpointId)
      ]);
    });
  });

  column?.querySelectorAll('[data-export-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      const checkpointId = button.dataset.exportId;
      if (!checkpointId) return;
      button.disabled = true;
      button.textContent = '导出中…';
      const response = await chrome.runtime.sendMessage({ type: 'exportCheckpoint', checkpointId });
      if (!response?.ok || !response.payload) {
        button.disabled = false;
        button.textContent = '导出';
        window.alert(response?.error || '导出失败');
        return;
      }
      downloadCheckpoint(response.payload);
      button.disabled = false;
      button.textContent = '导出';
    });
  });

  column?.querySelectorAll('[data-restore-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      const checkpointId = button.dataset.restoreId;
      if (!checkpointId) return;
      const confirmed = window.confirm(`确定恢复该 checkpoint？`);
      if (!confirmed) return;
      button.disabled = true;
      button.textContent = '恢复中…';
      const response = await chrome.runtime.sendMessage({ type: 'restoreCheckpoint', checkpointId });
      if (!response?.ok) {
        button.disabled = false;
        button.textContent = '恢复';
        window.alert(response?.error || '恢复失败');
        return;
      }
      window.alert('恢复完成。');
      button.disabled = false;
      button.textContent = '恢复';
    });
  });

  column?.querySelectorAll('[data-delete-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      const checkpointId = button.dataset.deleteId;
      if (!checkpointId) return;
      const confirmed = window.confirm(`确定删除 checkpoint 及其对应增量事件？\n\n${checkpointId}`);
      if (!confirmed) return;
      button.disabled = true;
      const response = await chrome.runtime.sendMessage({ type: 'deleteCheckpoint', checkpointId });
      if (!response?.ok) {
        button.disabled = false;
        window.alert(response?.error || '删除失败');
        return;
      }
      if (selectedCheckpointId === checkpointId) {
        selectedCheckpointId = null;
      }
      await loadCheckpoints('checkpoint 已删除。');
    });
  });
}

function renderEvents(events) {
  const subtitleEl = document.getElementById('eventsSubtitle');
  const eventListEl = document.getElementById('eventList');
  if (!subtitleEl || !eventListEl) return;

  subtitleEl.textContent = selectedCheckpointId ? `共 ${events.length} 条增量事件` : '选择一个 checkpoint 查看对应增量';

  if (!selectedCheckpointId) {
    eventListEl.innerHTML = '请选择左侧 checkpoint';
    return;
  }

  if (!events.length) {
    eventListEl.innerHTML = '<div class="event-empty">这个 checkpoint 没有可视化增量事件</div>';
    return;
  }

  eventListEl.innerHTML = events.map((event) => `
    <section class="event-item" data-event-id="${ui.escapeHtml(event.id)}">
      <div class="event-item-head">
        <div>
          <div class="event-item-title">${ui.escapeHtml(event.label || event.type || '事件')}</div>
          <div class="event-item-time">${ui.escapeHtml(ui.formatTime(event.createdAt, '—'))}</div>
        </div>
        <button class="menu-item danger event-delete-btn" type="button" data-event-id="${ui.escapeHtml(event.id)}">删除</button>
      </div>
      <div class="event-item-detail">${ui.escapeHtml(event.detail || '—')}</div>
    </section>
  `).join('');

  bindEventDeleteActions();
}

function bindEventDeleteActions() {
  document.querySelectorAll('.event-delete-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      const eventId = button.dataset.eventId;
      if (!eventId) return;
      const confirmed = window.confirm(`确定删除这条增量事件？\n\n${eventId}`);
      if (!confirmed) return;
      button.disabled = true;
      const response = await chrome.runtime.sendMessage({ type: 'deleteEvent', eventId });
      if (!response?.ok) {
        button.disabled = false;
        window.alert(response?.error || '删除失败');
        return;
      }
      await Promise.all([
        loadEvents(selectedCheckpointId, '增量事件已删除。'),
        loadPreview(selectedCheckpointId)
      ]);
    });
  });
}

async function loadEvents(checkpointId, statusMessage = '') {
  const subtitleEl = document.getElementById('eventsSubtitle');
  const eventListEl = document.getElementById('eventList');
  if (subtitleEl) subtitleEl.textContent = statusMessage || '正在加载增量事件…';
  if (eventListEl) eventListEl.innerHTML = '正在加载增量事件…';
  if (!checkpointId) {
    renderEvents([]);
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({ type: 'listEvents', checkpointId });
    if (!response?.ok) {
      if (subtitleEl) subtitleEl.textContent = '读取增量事件失败';
      if (eventListEl) eventListEl.innerHTML = ui.escapeHtml(response?.error || '读取失败');
      return;
    }
    renderEvents(response.events || []);
  } catch (error) {
    if (subtitleEl) subtitleEl.textContent = '读取增量事件失败';
    if (eventListEl) eventListEl.innerHTML = ui.escapeHtml(error?.message || String(error) || '读取失败');
  }
}

async function loadPreview(checkpointId) {
  const previewListEl = document.getElementById('previewSideList');
  const previewSubtitleEl = document.getElementById('previewSubtitle');
  if (!previewListEl || !previewSubtitleEl) return;
  if (!checkpointId) {
    previewSubtitleEl.textContent = '当前 checkpoint + 增量后的标签列表';
    previewListEl.innerHTML = '请选择左侧 checkpoint';
    return;
  }
  previewSubtitleEl.textContent = '正在加载标签预览…';
  previewListEl.innerHTML = '正在加载标签预览…';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'getCheckpointPreview', checkpointId });
    renderPreviewWindows(response?.preview || response);
  } catch (error) {
    previewSubtitleEl.textContent = '读取标签预览失败';
    previewListEl.innerHTML = ui.escapeHtml(error?.message || String(error) || '读取失败');
  }
}

function renderList(items) {
  currentCheckpoints = items.slice();
  summaryEl.textContent = items.length ? `共 ${items.length} 个 checkpoint` : '没有 checkpoint';
  hideStatus();
  listEl.classList.remove('hidden');

  if (!items.length) {
    selectedCheckpointId = null;
    listEl.innerHTML = `
      <div class="checkpoints-layout checkpoints-layout-triple">
        <div class="checkpoint-list-column">
          <div class="event-empty">还没有 checkpoint</div>
        </div>
        <aside class="events-panel">
          <div class="events-panel-header"><div><div class="events-panel-title">增量事件</div><div class="events-panel-subtitle">选择一个 checkpoint 查看对应增量</div></div></div>
          <div class="event-list"><div class="event-empty">暂无可显示的增量事件</div></div>
        </aside>
        <aside class="events-panel preview-side-panel">
          <div class="events-panel-header"><div><div class="events-panel-title">标签预览</div><div class="events-panel-subtitle">当前 checkpoint + 增量后的标签列表</div></div></div>
          <div class="preview-side-list"><div class="event-empty">暂无可显示的标签预览</div></div>
        </aside>
      </div>
    `;
    return;
  }

  if (!selectedCheckpointId || !items.some((item) => item.id === selectedCheckpointId)) {
    selectedCheckpointId = items[0]?.id || null;
  }

  renderShell(items);
  void Promise.all([
    loadEvents(selectedCheckpointId),
    loadPreview(selectedCheckpointId)
  ]);
}

async function loadCheckpoints(successMessage = '') {
  showStatus(successMessage || '正在加载 checkpoint…');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'listCheckpoints' });
    renderList(response?.checkpoints || []);
  } catch (error) {
    summaryEl.textContent = '读取失败';
    showStatus(`读取 checkpoint 失败：${error?.message || error}`);
  }
}

refreshBtn.addEventListener('click', () => loadCheckpoints());
loadCheckpoints();

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
