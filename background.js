const DB_NAME = 'edge-session-recovery';
const DB_VERSION = 3;
const CHECKPOINT_STORE = 'checkpoints';
const EVENT_STORE = 'events';
const META_STORE = 'meta';
const MAX_EVENTS = 12000;
const MAX_CHECKPOINTS = 60;
const EVENT_FLUSH_DEBOUNCE_MS = 80;

let pendingEvents = [];
let flushTimer = null;
let flushInFlight = null;
let lifecycleReady = false;
let stateCache = null;
let bootstrapStatePromise = null;
let restoreInProgress = false;

bootstrap().catch((error) => console.error('[bootstrap]', error));

async function bootstrap() {
  if (bootstrapStatePromise) return bootstrapStatePromise;
  bootstrapStatePromise = (async () => {
    await ensureDb();
    stateCache = await rebuildLatestState();
    if (!stateCache) {
      stateCache = await captureCurrentState();
    }
    await setMeta('bootAt', Date.now());
    lifecycleReady = true;
  })();
  try {
    await bootstrapStatePromise;
  } finally {
    bootstrapStatePromise = null;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void bootstrap();
});

chrome.runtime.onStartup.addListener(() => {
  void bootstrap();
});

chrome.tabs.onCreated.addListener((tab) => {
  void onMutatingEvent('tab-created', { tab: normalizeTab(tab) }, { immediate: true });
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  void onMutatingEvent('tab-removed', {
    tabId,
    windowId: removeInfo?.windowId ?? null,
    isWindowClosing: !!removeInfo?.isWindowClosing
  }, { immediate: true });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const hasCriticalChange = !!(changeInfo.url || 'pinned' in changeInfo);
  if (!hasCriticalChange) {
    return;
  }
  void onMutatingEvent('tab-updated', {
    tabId,
    changeInfo: {
      url: sanitizeUrl(changeInfo.url),
      pinned: typeof changeInfo.pinned === 'boolean' ? changeInfo.pinned : null
    },
    tab: normalizeTab(tab)
  }, { immediate: true });
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  void onMutatingEvent('tab-activated', activeInfo, { immediate: true });
});

chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
  void onMutatingEvent('tab-moved', { tabId, ...moveInfo }, { immediate: true });
});

chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
  void onMutatingEvent('tab-attached', { tabId, ...attachInfo }, { immediate: true });
});

chrome.tabs.onDetached.addListener((tabId, detachInfo) => {
  void onMutatingEvent('tab-detached', { tabId, ...detachInfo }, { immediate: true });
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  void onMutatingEvent('tab-replaced', { addedTabId, removedTabId }, { immediate: true });
});

chrome.windows.onCreated.addListener((window) => {
  void onMutatingEvent('window-created', { window: normalizeWindow(window) }, { immediate: true });
});

chrome.windows.onRemoved.addListener((windowId) => {
  void onMutatingEvent('window-removed', { windowId }, { immediate: true });
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  void onMutatingEvent('window-focus-changed', { windowId }, { immediate: true });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.type === 'getStatus') {
    void getStatus().then(sendResponse);
    return true;
  }

  if (message.type === 'captureCheckpoint') {
    void createCheckpoint('manual')
      .then(async (checkpoint) => sendResponse({ ok: true, checkpoint, status: await getStatus() }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'listCheckpoints') {
    void listCheckpoints().then((checkpoints) => sendResponse({ checkpoints }));
    return true;
  }

  if (message.type === 'deleteCheckpoint') {
    void deleteCheckpoint(message.checkpointId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'restoreCheckpoint') {
    void restoreCheckpoint(message.checkpointId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'restoreLatestState') {
    void restoreLatestState()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'get-latest-preview') {
    void getLatestPreview()
      .then((preview) => sendResponse(preview))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message.type === 'exportLatestCheckpoint') {
    void exportLatestCheckpoint()
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'importCheckpointFile') {
    void importCheckpointFile(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

async function onMutatingEvent(type, payload, { immediate = false } = {}) {
  await bootstrap();

  if (restoreInProgress && type !== 'restore-checkpoint' && type !== 'restore-latest-state') {
    return;
  }

  const event = {
    id: crypto.randomUUID(),
    type,
    payload,
    createdAt: Date.now()
  };

  pendingEvents.push(event);
  applyEventToState(stateCache, event);
  refreshCounts(stateCache);

  if (immediate) {
    await flushEvents();
    return;
  }

  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushEvents();
  }, EVENT_FLUSH_DEBOUNCE_MS);
}

async function flushEvents() {
  if (!pendingEvents.length) return;
  if (flushInFlight) return flushInFlight;

  const batch = pendingEvents.splice(0, pendingEvents.length);
  flushInFlight = persistEvents(batch);

  try {
    await flushInFlight;
  } finally {
    flushInFlight = null;
    if (pendingEvents.length) {
      void flushEvents();
    }
  }
}

async function persistEvents(events) {
  const db = await ensureDb();
  await withTransaction(db, [EVENT_STORE, META_STORE], 'readwrite', async (tx) => {
    const eventStore = tx.objectStore(EVENT_STORE);
    const metaStore = tx.objectStore(META_STORE);
    for (const event of events) {
      await idbPut(eventStore, event);
    }
    await idbPut(metaStore, { key: 'lastEventAt', value: events[events.length - 1].createdAt });
    await trimEvents(eventStore, MAX_EVENTS);
  });
}

async function trimEvents(eventStore, maxEvents) {
  const all = await idbGetAll(eventStore);
  if (all.length <= maxEvents) return;
  all.sort((a, b) => a.createdAt - b.createdAt);
  const extra = all.length - maxEvents;
  for (let i = 0; i < extra; i += 1) {
    await idbDelete(eventStore, all[i].id);
  }
}

async function createCheckpoint(reason = 'manual') {
  await bootstrap();
  await flushEvents();
  await rebuildStateCacheFromBrowser();

  const checkpoint = {
    id: crypto.randomUUID(),
    reason,
    createdAt: Date.now(),
    state: cloneState(stateCache)
  };

  const db = await ensureDb();
  await withTransaction(db, [CHECKPOINT_STORE, META_STORE], 'readwrite', async (tx) => {
    const checkpointStore = tx.objectStore(CHECKPOINT_STORE);
    const metaStore = tx.objectStore(META_STORE);
    await idbPut(checkpointStore, checkpoint);
    await idbPut(metaStore, { key: 'latestCheckpointId', value: checkpoint.id });
    await idbPut(metaStore, { key: 'lastCheckpointAt', value: checkpoint.createdAt });
    await trimCheckpoints(checkpointStore, MAX_CHECKPOINTS);
  });

  return summarizeCheckpoint(checkpoint);
}

async function trimCheckpoints(checkpointStore, maxCheckpoints) {
  const all = await idbGetAll(checkpointStore);
  if (all.length <= maxCheckpoints) return;
  all.sort((a, b) => a.createdAt - b.createdAt);
  const extra = all.length - maxCheckpoints;
  for (let i = 0; i < extra; i += 1) {
    await idbDelete(checkpointStore, all[i].id);
  }
}

function clonePreviewTab(tab = {}) {
  return {
    id: tab.id ?? null,
    index: typeof tab.index === 'number' ? tab.index : 0,
    title: tab.title || tab.pendingUrl || tab.url || '未命名标签页',
    url: tab.url || tab.pendingUrl || '',
    pendingUrl: tab.pendingUrl || '',
    favIconUrl: tab.favIconUrl || '',
    active: Boolean(tab.active),
    pinned: Boolean(tab.pinned),
    groupId: typeof tab.groupId === 'number' ? tab.groupId : -1
  };
}

function clonePreviewWindow(win = {}) {
  return {
    id: win.id ?? null,
    type: win.type || 'normal',
    state: win.state || 'normal',
    focused: Boolean(win.focused),
    tabs: Array.isArray(win.tabs) ? win.tabs.map(clonePreviewTab).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : []
  };
}

function buildPreviewPayload({ checkpoint, state, source = 'checkpoint' } = {}) {
  const windows = Array.isArray(state?.windows) ? state.windows.map(clonePreviewWindow) : [];
  return {
    source,
    checkpoint: checkpoint || null,
    state: state ? summarizeState(state) : null,
    windows
  };
}

async function getLatestPreview() {
  await bootstrap();
  await flushEvents();

  const checkpoints = await listCheckpoints();
  const latest = checkpoints[0] || null;
  const previewState = await rebuildLatestState();

  if (!latest?.id && !previewState?.windows?.length) {
    return buildPreviewPayload({ checkpoint: null, state: null, source: 'empty' });
  }

  return buildPreviewPayload({
    checkpoint: latest,
    state: previewState,
    source: latest?.id ? 'latest-state' : 'event-log'
  });
}

async function getStatus() {
  await bootstrap();
  await flushEvents();
  const [checkpoints, eventCount] = await Promise.all([listCheckpoints(), countEvents()]);
  const latest = checkpoints[0] || null;
  return {
    ready: lifecycleReady,
    latestCheckpoint: latest,
    checkpointCount: checkpoints.length,
    eventCount,
    liveState: stateCache ? summarizeState(stateCache) : null
  };
}

async function exportLatestCheckpoint() {
  await bootstrap();
  await flushEvents();

  const checkpoints = await listCheckpoints();
  const latest = checkpoints[0] || null;
  if (!latest?.id) {
    throw new Error('没有可导出的 checkpoint');
  }

  const full = await getCheckpointById(latest.id);
  if (!full?.state) {
    throw new Error('checkpoint 数据不完整，无法导出');
  }

  return {
    format: 'edge-history-recovery-checkpoint',
    version: 1,
    exportedAt: Date.now(),
    checkpoint: {
      id: full.id,
      reason: full.reason || 'manual',
      createdAt: full.createdAt,
      state: cloneState(full.state)
    }
  };
}

async function importCheckpointFile(payload) {
  await bootstrap();

  if (!payload || payload.format !== 'edge-history-recovery-checkpoint' || payload.version !== 1) {
    throw new Error('导入文件格式不正确');
  }

  const imported = payload.checkpoint;
  if (!imported?.state || !Array.isArray(imported.state.windows)) {
    throw new Error('导入文件缺少有效 checkpoint 数据');
  }

  const checkpoint = {
    id: crypto.randomUUID(),
    reason: imported.reason || 'imported',
    createdAt: Date.now(),
    state: finalizeState(cloneState(imported.state))
  };

  const db = await ensureDb();
  await withTransaction(db, [CHECKPOINT_STORE, META_STORE], 'readwrite', async (tx) => {
    const checkpointStore = tx.objectStore(CHECKPOINT_STORE);
    const metaStore = tx.objectStore(META_STORE);
    await idbPut(checkpointStore, checkpoint);
    await idbPut(metaStore, { key: 'latestCheckpointId', value: checkpoint.id });
    await idbPut(metaStore, { key: 'lastCheckpointAt', value: checkpoint.createdAt });
    await trimCheckpoints(checkpointStore, MAX_CHECKPOINTS);
  });

  return summarizeCheckpoint(checkpoint);
}

async function countEvents() {
  const db = await ensureDb();
  const events = await withTransaction(db, [EVENT_STORE], 'readonly', async (tx) => idbGetAll(tx.objectStore(EVENT_STORE)));
  return events.length;
}

async function listCheckpoints() {
  const db = await ensureDb();
  const items = await withTransaction(db, [CHECKPOINT_STORE], 'readonly', async (tx) => idbGetAll(tx.objectStore(CHECKPOINT_STORE)));
  return items
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((item) => summarizeCheckpoint(item, { includeState: false }));
}

async function deleteCheckpoint(checkpointId) {
  const db = await ensureDb();
  return withTransaction(db, [CHECKPOINT_STORE], 'readwrite', async (tx) => {
    await idbDelete(tx.objectStore(CHECKPOINT_STORE), checkpointId);
    return { ok: true, checkpointId };
  });
}

async function getCheckpointById(checkpointId) {
  const db = await ensureDb();
  return withTransaction(db, [CHECKPOINT_STORE], 'readonly', async (tx) => idbGet(tx.objectStore(CHECKPOINT_STORE), checkpointId));
}

function summarizeCheckpoint(item, { includeState = false } = {}) {
  if (!item) return null;

  const summary = {
    id: item.id,
    reason: item.reason,
    createdAt: item.createdAt,
    windowCount: item.state?.windowCount || 0,
    tabCount: item.state?.tabCount || 0
  };

  if (includeState) {
    summary.state = cloneState(item.state);
  }

  return summary;
}

function summarizeState(state) {
  return {
    capturedAt: state.capturedAt,
    windowCount: state.windowCount,
    tabCount: state.tabCount
  };
}

async function restoreCheckpoint(checkpointId) {
  await bootstrap();
  await flushEvents();
  const db = await ensureDb();
  const checkpoint = await withTransaction(db, [CHECKPOINT_STORE], 'readonly', async (tx) => idbGet(tx.objectStore(CHECKPOINT_STORE), checkpointId));
  if (!checkpoint) throw new Error('Checkpoint not found');

  restoreInProgress = true;
  try {
    const restoredWindowIds = await materializeState(checkpoint.state);
    await rebuildStateCacheFromBrowser();
    await onMutatingEvent('restore-checkpoint', { checkpointId, restoredWindowIds }, { immediate: true });
    return {
      restoredWindowIds,
      restoredFrom: checkpointId,
      mode: 'checkpoint',
      state: summarizeState(stateCache)
    };
  } finally {
    restoreInProgress = false;
  }
}

async function restoreLatestState() {
  await bootstrap();
  await flushEvents();
  const latestState = await rebuildLatestState();
  if (!latestState || !latestState.windows.length) {
    throw new Error('No recoverable state found');
  }

  restoreInProgress = true;
  try {
    const restoredWindowIds = await materializeState(latestState);
    await rebuildStateCacheFromBrowser();
    await onMutatingEvent('restore-latest-state', { restoredWindowIds }, { immediate: true });
    return {
      restoredWindowIds,
      restoredFrom: 'latest-state',
      mode: 'checkpoint+event-log',
      state: summarizeState(stateCache)
    };
  } finally {
    restoreInProgress = false;
  }
}

async function materializeState(state) {
  if (!state || !Array.isArray(state.windows)) {
    throw new Error('Invalid recoverable state');
  }

  const restoredWindowIds = [];

  for (const win of state.windows) {
    const tabs = Array.isArray(win?.tabs)
      ? win.tabs
          .map((tab) => ({ ...tab, restoreUrl: tab?.pendingUrl || tab?.url || '' }))
          .filter((tab) => tab.restoreUrl)
          .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      : [];

    if (!tabs.length) continue;

    const firstTab = tabs[0];
    const createData = {
      url: firstTab.restoreUrl,
      focused: !!win.focused,
      incognito: !!win.incognito
    };

    const left = nullableNumber(win.left);
    const top = nullableNumber(win.top);
    const width = nullableNumber(win.width);
    const height = nullableNumber(win.height);
    if (left !== undefined) createData.left = left;
    if (top !== undefined) createData.top = top;
    if (width !== undefined) createData.width = width;
    if (height !== undefined) createData.height = height;

    const createdWindow = await chrome.windows.create(createData);

    const normalizedState = normalizeWindowStateForCreate(win.state);
    if (normalizedState && normalizedState !== 'normal') {
      await chrome.windows.update(createdWindow.id, { state: normalizedState });
    }
    restoredWindowIds.push(createdWindow.id);

    let createdTabs = Array.isArray(createdWindow.tabs) ? [...createdWindow.tabs] : [];
    let baseTab = createdTabs[0] || null;

    for (let i = 1; i < tabs.length; i += 1) {
      const createdTab = await chrome.tabs.create({
        windowId: createdWindow.id,
        url: tabs[i].restoreUrl,
        active: false,
        pinned: false,
        index: i
      });
      createdTabs.push(createdTab);
    }

    createdTabs = createdTabs.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

    for (let i = 0; i < Math.min(createdTabs.length, tabs.length); i += 1) {
      const targetTab = tabs[i];
      await chrome.tabs.update(createdTabs[i].id, {
        pinned: !!targetTab.pinned,
        active: !!targetTab.active
      });
    }

    if (!tabs.some((tab) => tab.active) && baseTab) {
      await chrome.tabs.update(baseTab.id, { active: true });
    }
  }

  return restoredWindowIds;
}

async function rebuildStateCacheFromBrowser() {
  stateCache = await captureCurrentState();
  return stateCache;
}

async function captureCurrentState() {
  const windows = await chrome.windows.getAll({ populate: true });
  const normalized = windows
    .filter((win) => Array.isArray(win.tabs) && win.tabs.length > 0)
    .map((win) => ({
      id: win.id,
      focused: !!win.focused,
      incognito: !!win.incognito,
      type: win.type,
      state: win.state,
      top: win.top ?? null,
      left: win.left ?? null,
      width: win.width ?? null,
      height: win.height ?? null,
      tabs: (win.tabs || []).filter(shouldPersistTab).map(normalizeTab).sort((a, b) => a.index - b.index)
    }));

  return finalizeState(await enrichStateFavicons({
    capturedAt: Date.now(),
    windows: normalized
  }));
}

async function rebuildLatestState() {
  const db = await ensureDb();
  const [checkpoints, events] = await Promise.all([
    withTransaction(db, [CHECKPOINT_STORE], 'readonly', async (tx) => idbGetAll(tx.objectStore(CHECKPOINT_STORE))),
    withTransaction(db, [EVENT_STORE], 'readonly', async (tx) => idbGetAll(tx.objectStore(EVENT_STORE)))
  ]);

  checkpoints.sort((a, b) => b.createdAt - a.createdAt);
  events.sort((a, b) => a.createdAt - b.createdAt);

  const latestCheckpoint = checkpoints[0] || null;
  const checkpointState = latestCheckpoint ? cloneState(latestCheckpoint.state) : makeEmptyState();
  const replayStart = latestCheckpoint ? latestCheckpoint.createdAt : 0;

  for (const event of events) {
    if (event.createdAt >= replayStart) {
      applyEventToState(checkpointState, event);
    }
  }

  checkpointState.capturedAt = Date.now();
  refreshCounts(checkpointState);
  return checkpointState.windows.length ? checkpointState : latestCheckpoint ? checkpointState : null;
}

function applyEventToState(state, event) {
  if (!state || !event) return;

  switch (event.type) {
    case 'window-created': {
      const win = event.payload?.window;
      if (!win) break;
      upsertWindow(state, { ...win, tabs: [] });
      break;
    }
    case 'window-removed': {
      const windowId = event.payload?.windowId;
      state.windows = state.windows.filter((win) => win.id !== windowId);
      break;
    }
    case 'window-focus-changed': {
      const targetId = event.payload?.windowId;
      state.windows.forEach((win) => {
        win.focused = win.id === targetId;
      });
      break;
    }
    case 'tab-created': {
      const tab = event.payload?.tab;
      if (!tab || !shouldPersistTab(tab)) break;
      const win = ensureWindow(state, tab.windowId);
      upsertTab(win, tab);
      break;
    }
    case 'tab-updated': {
      const tab = event.payload?.tab;
      if (!tab || !shouldPersistTab(tab)) break;
      const win = ensureWindow(state, tab.windowId);
      upsertTab(win, tab);
      break;
    }
    case 'tab-removed': {
      const windowId = event.payload?.windowId;
      const tabId = event.payload?.tabId;
      const win = findWindow(state, windowId);
      if (win) {
        win.tabs = win.tabs.filter((tab) => tab.id !== tabId);
      }
      break;
    }
    case 'tab-activated': {
      const { windowId, tabId } = event.payload || {};
      const win = findWindow(state, windowId);
      if (win) {
        win.tabs.forEach((tab) => {
          tab.active = tab.id === tabId;
        });
      }
      break;
    }
    case 'tab-moved': {
      const { windowId, tabId, toIndex } = event.payload || {};
      const win = findWindow(state, windowId);
      if (win) {
        const tab = win.tabs.find((item) => item.id === tabId);
        if (tab) {
          tab.index = toIndex;
          sortTabs(win);
        }
      }
      break;
    }
    case 'tab-attached': {
      const { tabId, newWindowId, newPosition } = event.payload || {};
      const tab = detachTabFromAnyWindow(state, tabId);
      if (tab) {
        tab.windowId = newWindowId;
        tab.index = newPosition ?? tab.index;
        upsertTab(ensureWindow(state, newWindowId), tab);
      }
      break;
    }
    case 'tab-detached': {
      const { tabId, oldWindowId } = event.payload || {};
      const win = findWindow(state, oldWindowId);
      if (win) {
        win.tabs = win.tabs.filter((tab) => tab.id !== tabId);
      }
      break;
    }
    case 'tab-replaced': {
      const { addedTabId, removedTabId } = event.payload || {};
      for (const win of state.windows) {
        const tab = win.tabs.find((item) => item.id === removedTabId);
        if (tab) {
          tab.id = addedTabId;
          break;
        }
      }
      break;
    }
    case 'restore-checkpoint':
    case 'restore-latest-state': {
      break;
    }
    default:
      break;
  }

  state.windows = state.windows.filter((win) => win.tabs.length > 0 || win.type === 'normal');
  state.capturedAt = event.createdAt || Date.now();
  refreshCounts(state);
}

function makeEmptyState() {
  return {
    capturedAt: Date.now(),
    windowCount: 0,
    tabCount: 0,
    windows: []
  };
}

function finalizeState(partial) {
  const state = {
    capturedAt: partial.capturedAt || Date.now(),
    windows: (partial.windows || []).map((win) => ({
      ...win,
      tabs: (win.tabs || []).slice().sort((a, b) => a.index - b.index)
    }))
  };
  refreshCounts(state);
  return state;
}

function refreshCounts(state) {
  state.windowCount = state.windows.length;
  state.tabCount = state.windows.reduce((sum, win) => sum + win.tabs.length, 0);
  state.windows.forEach(sortTabs);
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function ensureWindow(state, windowId) {
  let win = findWindow(state, windowId);
  if (!win) {
    win = {
      id: windowId ?? crypto.randomUUID(),
      focused: false,
      incognito: false,
      type: 'normal',
      state: 'normal',
      top: null,
      left: null,
      width: null,
      height: null,
      tabs: []
    };
    state.windows.push(win);
  }
  return win;
}

function upsertWindow(state, windowLike) {
  const existing = findWindow(state, windowLike.id);
  if (!existing) {
    state.windows.push({
      id: windowLike.id,
      focused: !!windowLike.focused,
      incognito: !!windowLike.incognito,
      type: windowLike.type || 'normal',
      state: windowLike.state || 'normal',
      top: windowLike.top ?? null,
      left: windowLike.left ?? null,
      width: windowLike.width ?? null,
      height: windowLike.height ?? null,
      tabs: (windowLike.tabs || []).slice()
    });
    return;
  }

  existing.focused = !!windowLike.focused;
  existing.incognito = !!windowLike.incognito;
  existing.type = windowLike.type || existing.type;
  existing.state = windowLike.state || existing.state;
  existing.top = windowLike.top ?? existing.top;
  existing.left = windowLike.left ?? existing.left;
  existing.width = windowLike.width ?? existing.width;
  existing.height = windowLike.height ?? existing.height;
}

function findWindow(state, windowId) {
  return state.windows.find((win) => win.id === windowId);
}

function upsertTab(windowState, tab) {
  const existing = windowState.tabs.find((item) => item.id === tab.id);
  if (!existing) {
    windowState.tabs.push({ ...tab });
    sortTabs(windowState);
    return;
  }
  Object.assign(existing, tab);
  sortTabs(windowState);
}

function detachTabFromAnyWindow(state, tabId) {
  for (const win of state.windows) {
    const index = win.tabs.findIndex((tab) => tab.id === tabId);
    if (index >= 0) {
      const [tab] = win.tabs.splice(index, 1);
      return tab;
    }
  }
  return null;
}

function sortTabs(windowState) {
  windowState.tabs.sort((a, b) => a.index - b.index);
}

function shouldPersistTab(tab) {
  const url = tab?.pendingUrl || tab?.url || '';
  if (!url) return false;
  return !url.startsWith('chrome://') && !url.startsWith('edge://') && !url.startsWith('devtools://');
}

function normalizeTab(tab) {
  if (!tab) return null;
  return {
    id: tab.id ?? null,
    windowId: tab.windowId ?? null,
    index: tab.index ?? 0,
    pinned: !!tab.pinned,
    active: !!tab.active,
    highlighted: !!tab.highlighted,
    discarded: !!tab.discarded,
    autoDiscardable: !!tab.autoDiscardable,
    groupId: tab.groupId ?? -1,
    openerTabId: tab.openerTabId ?? null,
    title: tab.title || '',
    url: sanitizeUrl(tab.url),
    pendingUrl: sanitizeUrl(tab.pendingUrl),
    favIconUrl: sanitizeUrl(tab.favIconUrl),
    status: tab.status || 'unknown'
  };
}

async function enrichStateFavicons(state) {
  if (!state?.windows?.length) return state;
  await Promise.all(state.windows.map(async (win) => {
    await Promise.all((win.tabs || []).map(async (tab) => {
      if (!tab?.id) return;
      try {
        const liveTab = await chrome.tabs.get(tab.id);
        tab.favIconUrl = sanitizeUrl(liveTab?.favIconUrl) || tab.favIconUrl || '';
      } catch {
        tab.favIconUrl = tab.favIconUrl || '';
      }
    }));
  }));
  return state;
}

function normalizeWindow(window) {
  if (!window) return null;
  return {
    id: window.id ?? null,
    focused: !!window.focused,
    incognito: !!window.incognito,
    type: window.type || 'normal',
    state: window.state || 'normal',
    top: window.top ?? null,
    left: window.left ?? null,
    width: window.width ?? null,
    height: window.height ?? null
  };
}

function sanitizeUrl(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeWindowStateForCreate(state) {
  if (state === 'minimized' || state === 'maximized' || state === 'fullscreen') {
    return state;
  }
  return 'normal';
}

function nullableNumber(value) {
  return typeof value === 'number' ? value : undefined;
}

async function ensureDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CHECKPOINT_STORE)) {
        const checkpoints = db.createObjectStore(CHECKPOINT_STORE, { keyPath: 'id' });
        checkpoints.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(EVENT_STORE)) {
        const events = db.createObjectStore(EVENT_STORE, { keyPath: 'id' });
        events.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withTransaction(db, storeNames, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    let settled = false;

    const done = (method, value) => {
      if (!settled) {
        settled = true;
        method(value);
      }
    };

    Promise.resolve()
      .then(() => fn(tx))
      .then((value) => {
        tx.oncomplete = () => done(resolve, value);
        tx.onerror = () => done(reject, tx.error);
        tx.onabort = () => done(reject, tx.error || new Error('Transaction aborted'));
      })
      .catch((error) => done(reject, error));
  });
}

function idbPut(store, value) {
  return new Promise((resolve, reject) => {
    const request = store.put(value);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbGet(store, key) {
  return new Promise((resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbGetAll(store) {
  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function idbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const request = store.delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function setMeta(key, value) {
  return ensureDb().then((db) => withTransaction(db, [META_STORE], 'readwrite', async (tx) => {
    await idbPut(tx.objectStore(META_STORE), { key, value });
  }));
}
