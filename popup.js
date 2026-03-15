const statusEl = document.getElementById('status');
const previewListEl = document.getElementById('previewList');
const snapshotTimeEl = document.getElementById('snapshotTime');
const windowCountEl = document.getElementById('windowCount');
const tabCountEl = document.getElementById('tabCount');

const refreshBtn = document.getElementById('refreshBtn');
const openPreviewBtn = document.getElementById('openPreviewBtn');
const openOptionsBtn = document.getElementById('openOptionsBtn');

refreshBtn.addEventListener('click', () => loadPreview());
openPreviewBtn.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('preview.html') }));
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
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function renderFavicon(tab) {
  const url = tab.favIconUrl ? escapeHtml(tab.favIconUrl) : '';
  if (url) {
    return `<img class="icon" src="${url}" alt="" referrerpolicy="no-referrer" onerror="this.outerHTML='<span class=\\'icon fallback-icon\\'>🌐</span>'">`;
  }
  return '<span class="icon fallback-icon">🌐</span>';
}

function renderBadges(tab) {
  const badges = [];
  if (tab.active) badges.push('<span class="badge">当前激活</span>');
  if (tab.pinned) badges.push('<span class="badge">已固定</span>');
  return badges.join('');
}

function renderWindow(win, index) {
  const tabs = Array.isArray(win.tabs) ? [...win.tabs].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : [];
  return `
    <section class="window">
      <div class="window-head">
        <div class="window-title">窗口 ${index + 1}</div>
        <div class="window-sub">${tabs.length} 个页签</div>
      </div>
      ${tabs.map((tab) => `
        <div class="tab">
          ${renderFavicon(tab)}
          <div>
            <div class="title">${escapeHtml(tab.title || tab.url || '未命名标签页')}</div>
            <div class="url">${escapeHtml(tab.url || tab.pendingUrl || '')}</div>
            <div class="badges">${renderBadges(tab)}</div>
          </div>
        </div>
      `).join('')}
    </section>
  `;
}

function setSummary(checkpoint, windows) {
  const tabCount = windows.reduce((sum, win) => sum + ((win.tabs || []).length), 0);
  snapshotTimeEl.textContent = formatTime(checkpoint?.createdAt);
  windowCountEl.textContent = String(windows.length);
  tabCountEl.textContent = String(tabCount);
}

function showStatus(text) {
  statusEl.textContent = text;
  statusEl.classList.remove('hidden');
  previewListEl.classList.add('hidden');
}

function showPreview(checkpoint, windows) {
  setSummary(checkpoint, windows);
  if (!checkpoint || windows.length === 0) {
    showStatus('还没有可预览的快照。先让插件记录一次浏览器状态。');
    return;
  }
  previewListEl.innerHTML = windows.map(renderWindow).join('');
  previewListEl.classList.remove('hidden');
  statusEl.classList.add('hidden');
}

async function loadPreview() {
  showStatus('正在加载预览…');
  try {
    const preview = await chrome.runtime.sendMessage({ type: 'get-latest-preview' });
    if (!preview || preview.error) {
      showStatus(preview?.error || '读取预览失败');
      return;
    }
    const checkpoint = preview.checkpoint || null;
    const windows = Array.isArray(preview.windows) ? preview.windows : [];
    showPreview(checkpoint, windows);
  } catch (error) {
    showStatus(error?.message || String(error));
  }
}

loadPreview();
