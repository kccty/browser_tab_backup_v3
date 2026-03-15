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
  if (tab.active) badges.push('<span class="badge">当前激活</span>');
  if (tab.pinned) badges.push('<span class="badge">已固定</span>');
  if (tab.groupId >= 0) badges.push(`<span class="badge">分组 ${escapeHtml(tab.groupId)}</span>`);
  return badges.join('');
}

function getWindowLabel(win, index) {
  const tabs = Array.isArray(win?.tabs) ? win.tabs : [];
  return `窗口 ${index + 1} · ${tabs.length} 个页签`;
}

function getSelectedWindows(windows, selectedWindowId) {
  if (!Array.isArray(windows) || !windows.length) return [];
  if (!selectedWindowId) return [windows[0]];
  const selected = windows.find((win) => String(win.id) === String(selectedWindowId));
  return selected ? [selected] : [windows[0]];
}

function renderToolbar({ showOpenPreview = false } = {}) {
  return `
    <div class="inline-toolbar">
      <button id="inlineSaveCheckpointBtn">保存 checkpoint</button>
      <button id="inlineRestoreLatestBtn" class="secondary">恢复最新状态</button>
      ${showOpenPreview ? '<button id="inlineOpenPreviewBtn" class="secondary">单独页面</button>' : ''}
    </div>
  `;
}

function renderWindowSelector(windows, selectedWindowId) {
  if (!Array.isArray(windows) || !windows.length) return '';
  const selected = selectedWindowId ?? windows[0].id;
  return `
    <div class="window-selector">
      <label class="selector-label" for="windowSelect">预览窗口</label>
      <select id="windowSelect" class="window-select">
        ${windows.map((win, index) => `
          <option value="${escapeHtml(win.id)}" ${String(win.id) === String(selected) ? 'selected' : ''}>
            ${escapeHtml(getWindowLabel(win, index))}
          </option>
        `).join('')}
      </select>
    </div>
  `;
}

function renderWindowCard(win, index) {
  const tabs = Array.isArray(win.tabs) ? [...win.tabs].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : [];
  return `
    <section class="window">
      <div class="window-head">
        <div class="window-title">窗口 ${index + 1}</div>
        <div class="window-sub">${tabs.length} 个页签${win.state ? ` · 状态 ${escapeHtml(win.state)}` : ''}${win.type ? ` · 类型 ${escapeHtml(win.type)}` : ''}</div>
      </div>
      ${tabs.map((tab) => `
        <div class="tab">
          ${renderFavicon(tab)}
          <div>
            <div class="title">${escapeHtml(tab.title || tab.url || tab.pendingUrl || '未命名标签页')}</div>
            <div class="url">${escapeHtml(tab.url || tab.pendingUrl || '')}</div>
            <div class="badges">${renderBadges(tab)}</div>
          </div>
        </div>
      `).join('') || '<div class="tab-empty">这个窗口没有可恢复的页签</div>'}
    </section>
  `;
}

function countTabs(windows) {
  return (windows || []).reduce((sum, win) => sum + ((win.tabs || []).length), 0);
}

window.EdgeRecoveryUI = {
  escapeHtml,
  formatTime,
  renderToolbar,
  renderWindowSelector,
  renderWindowCard,
  getSelectedWindows,
  countTabs
};
