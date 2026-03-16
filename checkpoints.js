const ui = window.EdgeRecoveryUI;

const statusEl = document.getElementById('checkpointsStatus');
const listEl = document.getElementById('checkpointsList');
const summaryEl = document.getElementById('checkpointSummary');
const refreshBtn = document.getElementById('refreshCheckpointsBtn');

let selectedCheckpointId = null;

function showStatus(message) {
  statusEl.textContent = message;
  statusEl.classList.remove('hidden');
  listEl.classList.add('hidden');
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

function renderShell(items) {
  listEl.innerHTML = `
    <div class="checkpoints-layout">
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
      if (event.target.closest('[data-delete-id]')) return;
      selectedCheckpointId = itemEl.dataset.checkpointId || null;
      renderShell(items);
      await loadEvents(selectedCheckpointId);
    });
  });

  column?.querySelectorAll('[data-delete-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      const checkpointId = button.dataset.deleteId;
      if (!checkpointId) return;
      const confirmed = window.confirm(`确定删除 checkpoint？\n\n${checkpointId}`);
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
      await loadEvents(selectedCheckpointId, '增量事件已删除。');
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

function renderList(items) {
  summaryEl.textContent = items.length ? `共 ${items.length} 个 checkpoint` : '没有 checkpoint';
  hideStatus();
  listEl.classList.remove('hidden');

  if (!items.length) {
    selectedCheckpointId = null;
    listEl.innerHTML = `
      <div class="checkpoints-layout">
        <div class="checkpoint-list-column">
          <div class="event-empty">还没有 checkpoint</div>
        </div>
        <aside class="events-panel" id="eventsPanel">
          <div class="events-panel-header">
            <div>
              <div class="events-panel-title">增量事件</div>
              <div class="events-panel-subtitle" id="eventsSubtitle">选择一个 checkpoint 查看对应增量</div>
            </div>
          </div>
          <div class="event-list" id="eventList"><div class="event-empty">暂无可显示的增量事件</div></div>
        </aside>
      </div>
    `;
    return;
  }

  if (!selectedCheckpointId || !items.some((item) => item.id === selectedCheckpointId)) {
    selectedCheckpointId = items[0]?.id || null;
  }

  renderShell(items);
  void loadEvents(selectedCheckpointId);
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
