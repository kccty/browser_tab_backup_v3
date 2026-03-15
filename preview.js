const subtitleEl = document.getElementById('subtitle');
const panelEl = document.getElementById('panel');
const refreshBtn = document.getElementById('refreshBtn');
const openOptionsBtn = document.getElementById('openOptionsBtn');

refreshBtn.addEventListener('click', () => loadPreview());
openOptionsBtn.addEventListener('click', async () => {
  if (chrome.runtime.openOptionsPage) {
    await chrome.runtime.openOptionsPage();
  }
});

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function formatTime(value) {
  if (!value) return '未知时间';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知时间';
  return date.toLocaleString();
}

function tabBadges(tab) {
  const badges = [];
  if (tab.active) badges.push('<span class="badge">当前激活</span>');
  if (tab.pinned) badges.push('<span class="badge">已固定</span>');
  if (tab.groupId >= 0) badges.push(`<span class="badge">分组 ${tab.groupId}</span>`);
  return badges.join('');
}

function renderFavicon(tab) {
  const url = tab.favIconUrl ? escapeHtml(tab.favIconUrl) : '';
  if (url) {
    return `<img class="icon" src="${url}" alt="" referrerpolicy="no-referrer" onerror="this.outerHTML='<span class=\\'icon fallback-icon\\'>🌐</span>'">`;
  }
  return '<span class="icon fallback-icon">🌐</span>';
}

function renderWindow(win, index) {
  const tabs = Array.isArray(win.tabs) ? [...win.tabs].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : [];
  return `
    <section class="window">
      <div class="window-head">
        <div>
          <div class="window-title">窗口 ${index + 1}</div>
          <div class="window-sub">${tabs.length} 个页签${win.state ? ` · 状态 ${escapeHtml(win.state)}` : ''}${win.type ? ` · 类型 ${escapeHtml(win.type)}` : ''}</div>
        </div>
      </div>
      <div class="tabs">
        ${tabs.map((tab) => `
          <div class="tab">
            ${renderFavicon(tab)}
            <div>
              <div class="title">${escapeHtml(tab.title || tab.url || '未命名标签页')}</div>
              <div class="url">${escapeHtml(tab.url || tab.pendingUrl || '')}</div>
              <div class="badge-row">${tabBadges(tab)}</div>
            </div>
          </div>
        `).join('') || '<div class="empty">这个窗口没有可恢复的页签</div>'}
      </div>
    </section>
  `;
}

function renderPreview(preview) {
  const checkpoint = preview?.checkpoint || null;
  const windows = Array.isArray(preview?.windows) ? preview.windows : [];
  subtitleEl.textContent = checkpoint
    ? `快照时间：${formatTime(checkpoint.createdAt)} · 共 ${windows.length} 个窗口`
    : '没有可用快照';

  if (!checkpoint || windows.length === 0) {
    panelEl.innerHTML = '<div class="empty">还没有可预览的快照。先让插件记录一次浏览器状态。</div>';
    return;
  }

  const totalTabs = windows.reduce((sum, win) => sum + ((win.tabs || []).length), 0);
  panelEl.innerHTML = `
    <div class="meta">
      <div>快照 ID：${escapeHtml(checkpoint.id || '未知')}</div>
      <div>记录时间：${escapeHtml(formatTime(checkpoint.createdAt))}</div>
      <div>窗口：${windows.length}</div>
      <div>页签：${totalTabs}</div>
    </div>
    ${windows.map(renderWindow).join('')}
  `;
}

async function loadPreview() {
  panelEl.innerHTML = '<div class="loading">正在加载预览…</div>';
  try {
    const preview = await chrome.runtime.sendMessage({ type: 'get-latest-preview' });
    if (!preview || preview.error) {
      panelEl.innerHTML = `<div class="error">${escapeHtml(preview?.error || '读取预览失败')}</div>`;
      return;
    }
    renderPreview(preview);
  } catch (error) {
    panelEl.innerHTML = `<div class="error">${escapeHtml(error?.message || String(error))}</div>`;
  }
}

loadPreview();
