const ui = window.EdgeRecoveryUI;

const statusEl = document.getElementById('checkpointsStatus');
const listEl = document.getElementById('checkpointsList');
const summaryEl = document.getElementById('checkpointSummary');
const refreshBtn = document.getElementById('refreshCheckpointsBtn');

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
    `页签：${item.tabCount ?? 0}`,
    `事件：${item.eventCount ?? 0}`
  ];
  return parts.map((line) => `<div class="checkpoint-meta-line">${ui.escapeHtml(line)}</div>`).join('');
}

function renderList(items) {
  if (!items.length) {
    summaryEl.textContent = '没有 checkpoint';
    showStatus('还没有 checkpoint');
    return;
  }

  summaryEl.textContent = `共 ${items.length} 个 checkpoint`;
  listEl.innerHTML = items.map((item) => `
    <section class="checkpoint-item" data-checkpoint-id="${ui.escapeHtml(item.id)}">
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
  hideStatus();
  listEl.classList.remove('hidden');
  bindDeleteActions();
}

function bindDeleteActions() {
  listEl.querySelectorAll('[data-delete-id]').forEach((button) => {
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
      await loadCheckpoints('删除成功');
    });
  });
}

async function loadCheckpoints(successMessage = '') {
  showStatus(successMessage || '正在加载 checkpoint…');
  const response = await chrome.runtime.sendMessage({ type: 'listCheckpoints' });
  renderList(response?.checkpoints || []);
}

refreshBtn.addEventListener('click', () => loadCheckpoints());
loadCheckpoints();
