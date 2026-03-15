function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function formatTime(value, fallback = '—') {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleString();
}

function renderFavicon(tab) {
  const url = tab.favIconUrl ? escapeHtml(tab.favIconUrl) : '';
  if (url) {
    return `<img class="icon" src="${url}" alt="" referrerpolicy="no-referrer" onerror="this.outerHTML='&lt;span class=\'icon fallback-icon\'&gt;🌐&lt;/span&gt;'">`;
  }
  return '<span class="icon fallback-icon">🌐</span>';
}

function renderBadges(tab) {
  const badges = [];
  if (tab.active) badges.push('<span class="badge primary">当前</span>');
  if (tab.pinned) badges.push('<span class="badge">固定</span>');
  if (tab.groupId >= 0) badges.push(`<span class="badge">分组 ${escapeHtml(tab.groupId)}</span>`);
  return badges.join('');
}

function getWindowLabel(win, index) {
  const tabs = Array.isArray(win?.tabs) ? win.tabs : [];
  return `窗口${index + 1}` + (tabs.length ? ` · ${tabs.length}` : '');
}

function getSelectedWindows(windows, selectedWindowId) {
  if (!Array.isArray(windows) || !windows.length) return [];
  if (!selectedWindowId) return [windows[0]];
  const selected = windows.find((win) => String(win.id) === String(selectedWindowId));
  return selected ? [selected] : [windows[0]];
}

function renderTopbar({ title, subtitle = '', showOpenPreview = false, menuLabel = '更多' }) {
  return `
    <section class="topbar-card">
      <div class="topbar-row">
        <div class="topbar-copy">
          <div class="topbar-title">${escapeHtml(title)}</div>
          ${subtitle ? `<div class="topbar-subtitle">${escapeHtml(subtitle)}</div>` : ''}
        </div>
        <div class="topbar-actions">
          <button id="saveCheckpointBtn" class="icon-btn primary" title="保存" aria-label="保存">
            <span class="icon-symbol">💾</span>
          </button>
          <button id="restoreLatestBtn" class="icon-btn" title="恢复" aria-label="恢复">
            <span class="icon-symbol">↺</span>
          </button>
          <details class="more-menu">
            <summary class="icon-btn" aria-label="更多操作" title="更多操作">
              <span class="icon-symbol">⋯</span>
            </summary>
            <div class="menu-panel">
              <button id="exportBtn" class="menu-item" type="button">导出</button>
              <button id="importBtn" class="menu-item" type="button">导入</button>
              <button id="refreshBtn" class="menu-item" type="button">刷新</button>
              ${showOpenPreview ? '<button id="openPreviewBtn" class="menu-item" type="button">单独页面</button>' : ''}
            </div>
          </details>
        </div>
      </div>
    </section>
  `;
}

function renderWindowSelector(windows, selectedWindowId) {
  if (!Array.isArray(windows) || !windows.length) return '';
  const selected = selectedWindowId ?? windows[0].id;
  return `
    <div class="window-switcher" role="tablist" aria-label="窗口选择">
      ${windows.map((win, index) => `
        <button
          type="button"
          class="window-pill${String(win.id) === String(selected) ? ' active' : ''}"
          data-window-id="${escapeHtml(win.id)}"
        >
          ${escapeHtml(getWindowLabel(win, index))}
        </button>
      `).join('')}
    </div>
  `;
}

function renderWindowCard(win, index) {
  const tabs = Array.isArray(win.tabs) ? [...win.tabs].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : [];
  return `
    <section class="window-card">
      <div class="window-head">
        <div>
          <div class="window-title">窗口${index + 1}</div>
          <div class="window-sub">${tabs.length} 个页签${win.state ? ` · ${escapeHtml(win.state)}` : ''}</div>
        </div>
      </div>
      <div class="tabs-wrap">
        ${tabs.map((tab) => `
          <div class="tab-card">
            ${renderFavicon(tab)}
            <div class="tab-main">
              <div class="title">${escapeHtml(tab.title || tab.url || tab.pendingUrl || '未命名标签页')}</div>
              <div class="url">${escapeHtml(tab.url || tab.pendingUrl || '')}</div>
              <div class="badges">${renderBadges(tab)}</div>
            </div>
          </div>
        `).join('') || '<div class="tab-empty">这个窗口没有可恢复的页签</div>'}
      </div>
    </section>
  `;
}

function countTabs(windows) {
  return (windows || []).reduce((sum, win) => sum + ((win.tabs || []).length), 0);
}

window.EdgeRecoveryUI = {
  escapeHtml,
  formatTime,
  renderTopbar,
  renderWindowSelector,
  renderWindowCard,
  getSelectedWindows,
  countTabs
};
