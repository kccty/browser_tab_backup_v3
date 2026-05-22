const DB_NAME = 'edge-session-recovery';
const DB_VERSION = 4;
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
let dbInstance = null;
let isColdStart = false;
let isReload = false;

// onStartup 在浏览器冷启动时触发
chrome.runtime.onStartup.addListener(() => {
  isColdStart = true;
});

// onInstalled 在插件安装/更新/重新加载时触发
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    isReload = true;
  }
});

// 延迟启动，给 onStartup/onInstalled 时间触发
setTimeout(() => {
  bootstrap().catch((error) => console.error('[bootstrap]', error));
}, 0);

async function bootstrap() {
  if (lifecycleReady) return;
  if (bootstrapStatePromise) return bootstrapStatePromise;
  bootstrapStatePromise = (async () => {
    await ensureDb();
    stateCache = await captureCurrentState();
    if (isColdStart || isReload) {
      await createCheckpointFromState(stateCache, isColdStart ? 'restart' : 'reload');
      isColdStart = false;
      isReload = false;
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


chrome.tabs.onCreated.addListener((tab) => {
  if (!shouldPersistTab(tab)) return;
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
  if (!shouldPersistTab(tab)) return;
  const hasCriticalChange = !!(changeInfo.url || changeInfo.title || 'pinned' in changeInfo);
  if (!hasCriticalChange) return;
  void onMutatingEvent('tab-updated', {
    tabId,
    changeInfo: {
      url: sanitizeUrl(changeInfo.url),
      title: typeof changeInfo.title === 'string' ? changeInfo.title : null,
      pinned: typeof changeInfo.pinned === 'boolean' ? changeInfo.pinned : null
    },
    tab: normalizeTab(tab)
  }, { immediate: !changeInfo.title });
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  const { windowId, tabId } = activeInfo || {};
  if (stateCache) {
    applyEventToState(stateCache, {
      type: 'tab-activated',
      payload: { windowId, tabId },
      createdAt: Date.now()
    });
  }
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
  if (stateCache) {
    applyEventToState(stateCache, {
      type: 'window-focus-changed',
      payload: { windowId },
      createdAt: Date.now()
    });
  }
});


/**
 * 直接从已有 state 创建 checkpoint（不重新抓取浏览器状态）
 */
async function createCheckpointFromState(state, reason = 'manual') {
  const checkpoint = {
    id: crypto.randomUUID(),
    reason,
    createdAt: Date.now(),
    state: finalizeState(cloneState(state))
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.type === 'getStatus') {
    void getStatus().then(sendResponse);
    return true;
  }

  if (message.type === 'getRestoreStatus') {
    sendResponse({ ok: true, restoreStatus: getRestoreStatus() });
    return false;
  }

  if (message.type === 'captureCheckpoint') {
    void createCheckpoint('manual')
      .then(async (checkpoint) => sendResponse({ ok: true, checkpoint, status: await getStatus() }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'listCheckpoints') {
    void (async () => {
      const checkpoints = await listCheckpoints();
      const activeId = await getMeta('latestCheckpointId');
      sendResponse({ checkpoints, activeCheckpointId: activeId || null });
    })();
    return true;
  }

  if (message.type === 'listEvents') {
    void listEvents(message.checkpointId)
      .then((events) => sendResponse({ ok: true, events }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'deleteCheckpoint') {
    void deleteCheckpoint(message.checkpointId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'deleteEvent') {
    void deleteEvent(message.eventId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'getCheckpointPreview') {
    void getCheckpointPreview(message.checkpointId)
      .then((preview) => sendResponse({ ok: true, preview }))
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

  if (message.type === 'exportCheckpoint') {
    void exportCheckpointById(message.checkpointId)
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
    const puts = events.map((event) => idbPut(eventStore, event));
    puts.push(idbPut(metaStore, { key: 'lastEventAt', value: events[events.length - 1].createdAt }));
    await Promise.all(puts);

    // 达到上限 → 归档为新 checkpoint + 清空事件
    const allEvents = await idbGetAll(eventStore);
    if (allEvents.length >= MAX_EVENTS) {
      await archiveAndReset(db);
    }
  });
}

/**
 * 事件达到上限时：保存当前状态为 checkpoint，清空所有事件
 */
async function archiveAndReset() {
  const freshState = await captureCurrentState();
  stateCache = freshState;

  const checkpoint = {
    id: crypto.randomUUID(),
    reason: 'auto-archive',
    createdAt: Date.now(),
    state: finalizeState(cloneState(freshState))
  };

  const db = await ensureDb();
  await withTransaction(db, [CHECKPOINT_STORE, EVENT_STORE, META_STORE], 'readwrite', async (tx) => {
    const checkpointStore = tx.objectStore(CHECKPOINT_STORE);
    const eventStore = tx.objectStore(EVENT_STORE);
    const metaStore = tx.objectStore(META_STORE);
    await idbPut(checkpointStore, checkpoint);
    await idbPut(metaStore, { key: 'latestCheckpointId', value: checkpoint.id });
    await idbPut(metaStore, { key: 'lastCheckpointAt', value: checkpoint.createdAt });
    // 清空所有事件
    const allEvents = await idbGetAll(eventStore);
    await Promise.all(allEvents.map((event) => idbDelete(eventStore, event.id)));
    await trimCheckpoints(checkpointStore, MAX_CHECKPOINTS);
  });

  console.log('[archiveAndReset] Events archived into checkpoint, event log cleared.');
}

async function trimEvents(eventStore, maxEvents) {
  const all = await idbGetAll(eventStore);
  if (all.length <= maxEvents) return;
  all.sort((a, b) => a.createdAt - b.createdAt);
  const extra = all.length - maxEvents;
  const deletes = [];
  for (let i = 0; i < extra; i += 1) {
    deletes.push(idbDelete(eventStore, all[i].id));
  }
  await Promise.all(deletes);
}

async function clearEvents(eventStore) {
  const all = await idbGetAll(eventStore);
  await Promise.all(all.map((event) => idbDelete(eventStore, event.id)));
}

async function deleteEventsForCheckpointRange(eventStore, checkpoints, checkpointId) {
  const target = checkpoints.find((item) => String(item.id) === String(checkpointId));
  if (!target) return;

  const sorted = checkpoints.slice().sort((a, b) => a.createdAt - b.createdAt);
  const next = sorted.find((item) => item.createdAt > target.createdAt);
  const allEvents = await idbGetAll(eventStore);
  const deletes = [];
  for (const event of allEvents) {
    const eventAt = Number(event?.createdAt || 0);
    if (eventAt >= target.createdAt && (!next || eventAt < next.createdAt)) {
      deletes.push(idbDelete(eventStore, event.id));
    }
  }
  await Promise.all(deletes);
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
  const deletes = [];
  for (let i = 0; i < extra; i += 1) {
    deletes.push(idbDelete(checkpointStore, all[i].id));
  }
  await Promise.all(deletes);
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
  const activeId = await getMeta('latestCheckpointId');

  if (!latest?.id && !previewState?.windows?.length) {
    return buildPreviewPayload({ checkpoint: null, state: null, source: 'empty' });
  }

  return {
    ...buildPreviewPayload({
      checkpoint: latest,
      state: previewState,
      source: latest?.id ? 'latest-state' : 'event-log'
    }),
    checkpoints,
    activeCheckpointId: activeId || null
  };
}

async function getCheckpointPreview(checkpointId) {
  await bootstrap();
  await flushEvents();
  const checkpoints = await listCheckpoints();
  const target = checkpoints.find((item) => String(item.id) === String(checkpointId));
  if (!target?.id) {
    throw new Error('checkpoint 不存在');
  }

  const full = await getCheckpointById(target.id);
  if (!full?.state) {
    throw new Error('checkpoint 数据不完整');
  }

  const state = finalizeState(cloneState(full.state));
  return {
    ...buildPreviewPayload({
      checkpoint: target,
      state,
      source: 'checkpoint'
    }),
    checkpoints
  };
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

  const latestState = await rebuildLatestState();
  if (!latestState?.windows) {
    throw new Error('最新状态不完整，无法导出');
  }

  return {
    format: 'edge-history-recovery-checkpoint',
    version: 1,
    exportedAt: Date.now(),
    checkpoint: {
      id: latest.id,
      reason: latest.reason || 'manual',
      createdAt: latest.createdAt,
      state: cloneState(latestState)
    }
  };
}

async function exportCheckpointById(checkpointId) {
  await bootstrap();
  if (!checkpointId) throw new Error('未指定 checkpoint');

  const full = await getCheckpointById(checkpointId);
  if (!full?.state) throw new Error('checkpoint 数据不完整');

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

async function listEvents(checkpointId = null) {
  await bootstrap();
  await flushEvents();
  const db = await ensureDb();
  const [events, checkpoints] = await Promise.all([
    withTransaction(db, [EVENT_STORE], 'readonly', async (tx) => idbGetAll(tx.objectStore(EVENT_STORE))),
    listCheckpoints()
  ]);

  const sortedCheckpoints = checkpoints.slice().sort((a, b) => a.createdAt - b.createdAt);
  let filtered = events.slice();

  if (checkpointId) {
    const current = sortedCheckpoints.find((item) => String(item.id) === String(checkpointId));
    if (!current) {
      throw new Error('checkpoint 不存在');
    }
    const next = sortedCheckpoints.find((item) => item.createdAt > current.createdAt);
    filtered = filtered.filter((event) => {
      const eventAt = Number(event?.createdAt || 0);
      return eventAt >= current.createdAt && (!next || eventAt < next.createdAt);
    });
  }

  return filtered
    .sort((a, b) => Number(b?.createdAt || 0) - Number(a?.createdAt || 0))
    .map((event) => summarizeEvent(event));
}

async function deleteCheckpoint(checkpointId) {
  await bootstrap();
  await flushEvents();
  const db = await ensureDb();
  const checkpoints = await listCheckpoints();
  return withTransaction(db, [CHECKPOINT_STORE, EVENT_STORE], 'readwrite', async (tx) => {
    await deleteEventsForCheckpointRange(tx.objectStore(EVENT_STORE), checkpoints, checkpointId);
    await idbDelete(tx.objectStore(CHECKPOINT_STORE), checkpointId);
    return { ok: true, checkpointId };
  });
}

async function deleteEvent(eventId) {
  const db = await ensureDb();
  return withTransaction(db, [EVENT_STORE], 'readwrite', async (tx) => {
    await idbDelete(tx.objectStore(EVENT_STORE), eventId);
    return { ok: true, eventId };
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

function summarizeEvent(event) {
  return {
    id: event.id,
    type: event.type,
    createdAt: event.createdAt,
    label: getEventLabel(event),
    detail: getEventDetail(event)
  };
}

function getEventLabel(event) {
  switch (event?.type) {
    case 'tab-created': return '新增标签页';
    case 'tab-removed': return '删除标签页';
    case 'tab-updated': return '更新标签页';
    case 'tab-activated': return '切换激活标签页';
    case 'tab-moved': return '移动标签页';
    case 'tab-attached': return '标签页移入窗口';
    case 'tab-detached': return '标签页移出窗口';
    case 'tab-replaced': return '标签页替换';
    case 'window-created': return '新增窗口';
    case 'window-removed': return '删除窗口';
    case 'window-focus-changed': return '切换窗口焦点';
    case 'restore-checkpoint': return '恢复 checkpoint';
    case 'restore-latest-state': return '恢复最新状态';
    default: return event?.type || '未知事件';
  }
}

function getEventDetail(event) {
  const payload = event?.payload || {};
  const title = payload?.tab?.title || payload?.tab?.pendingUrl || payload?.tab?.url || '';
  switch (event?.type) {
    case 'tab-created':
    case 'tab-updated':
      return title || '标签页变更';
    case 'tab-removed':
      return payload?.tabId ? `tabId: ${payload.tabId}` : '标签页已删除';
    case 'tab-activated':
      return payload?.tabId ? `tabId: ${payload.tabId}` : '激活状态变更';
    case 'tab-moved':
      return payload?.tabId ? `tabId: ${payload.tabId} → ${payload.toIndex ?? '?'}` : '标签页位置变化';
    case 'tab-attached':
      return payload?.tabId ? `tabId: ${payload.tabId} → 窗口 ${payload.newWindowId ?? '?'}` : '标签页移入窗口';
    case 'tab-detached':
      return payload?.tabId ? `tabId: ${payload.tabId} ← 窗口 ${payload.oldWindowId ?? '?'}` : '标签页移出窗口';
    case 'tab-replaced':
      return payload?.addedTabId ? `${payload.removedTabId ?? '?'} → ${payload.addedTabId}` : '标签页替换';
    case 'window-created':
    case 'window-removed':
    case 'window-focus-changed':
      return payload?.windowId ? `windowId: ${payload.windowId}` : '窗口变更';
    case 'restore-checkpoint':
      return payload?.checkpointId || '已恢复指定 checkpoint';
    default:
      return '';
  }
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

  const full = await getCheckpointById(checkpointId);
  if (!full?.state) {
    throw new Error('checkpoint 数据不完整');
  }

  const state = finalizeState(cloneState(full.state));
  if (!state?.windows?.length) {
    throw new Error('该 checkpoint 没有可恢复的窗口');
  }

  restoreInProgress = true;
  try {
    const restoredWindowIds = await materializeState(state);
    await rebuildStateCacheFromBrowser();
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

const RESTORE_BATCH_SIZE = 10; // 每批创建的标签数
const RESTORE_BATCH_DELAY_MS = 500; // 每批之间的间隔

// 恢复状态
let restoreStatus = null; // { phase, totalWindows, currentWindow, totalTabs, restoredTabs, startedAt }

function updateRestoreStatus(update) {
  restoreStatus = restoreStatus ? { ...restoreStatus, ...update } : update;
}

function clearRestoreStatus() {
  restoreStatus = null;
}

function getRestoreStatus() {
  return restoreStatus ? { ...restoreStatus } : null;
}

async function materializeState(state) {
  if (!state || !Array.isArray(state.windows)) {
    throw new Error('Invalid recoverable state');
  }

  const validWindows = state.windows.filter((win) => {
    if (win.type === 'devtools') return false;
    const tabs = (win.tabs || []).filter((t) => t?.pendingUrl || t?.url);
    return tabs.length > 0;
  });

  const totalTabs = validWindows.reduce((sum, win) => {
    return sum + (win.tabs || []).filter((t) => t?.pendingUrl || t?.url).length;
  }, 0);

  updateRestoreStatus({
    phase: 'restoring',
    totalWindows: validWindows.length,
    currentWindow: 0,
    totalTabs,
    restoredTabs: 0,
    startedAt: Date.now()
  });

  const restoredWindowIds = [];

  for (let winIdx = 0; winIdx < validWindows.length; winIdx += 1) {
    const win = validWindows[winIdx];
    const tabs = win.tabs
      .map((tab) => ({ ...tab, restoreUrl: tab?.pendingUrl || tab?.url || '' }))
      .filter((tab) => tab.restoreUrl)
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

    updateRestoreStatus({ currentWindow: winIdx + 1 });

    try {
      // 第一批：创建窗口 + 前 N 个标签
      const firstBatch = tabs.slice(0, RESTORE_BATCH_SIZE);
      const urls = firstBatch.map((tab) => tab.restoreUrl);
      const createData = { url: urls, focused: false };

      if (win.incognito) createData.incognito = true;
      const left = nullableNumber(win.left);
      const top = nullableNumber(win.top);
      const width = nullableNumber(win.width);
      const height = nullableNumber(win.height);
      if (left !== undefined) createData.left = left;
      if (top !== undefined) createData.top = top;
      if (width !== undefined) createData.width = width;
      if (height !== undefined) createData.height = height;

      const createdWindow = await chrome.windows.create(createData);
      restoredWindowIds.push(createdWindow.id);

      // 设置窗口状态
      const normalizedState = normalizeWindowStateForCreate(win.state);
      if (normalizedState && normalizedState !== 'normal') {
        await chrome.windows.update(createdWindow.id, { state: normalizedState }).catch(() => {});
      }

      updateRestoreStatus({ restoredTabs: (restoreStatus?.restoredTabs || 0) + firstBatch.length });

      // 剩余标签分批创建
      for (let i = RESTORE_BATCH_SIZE; i < tabs.length; i += RESTORE_BATCH_SIZE) {
        await delay(RESTORE_BATCH_DELAY_MS);
        const batch = tabs.slice(i, i + RESTORE_BATCH_SIZE);
        const batchPromises = batch.map((tab) =>
          chrome.tabs.create({
            windowId: createdWindow.id,
            url: tab.restoreUrl,
            active: false,
            pinned: !!tab.pinned
          }).catch((e) => console.warn('[materializeState] tab create failed:', e))
        );
        await Promise.all(batchPromises);
        updateRestoreStatus({ restoredTabs: (restoreStatus?.restoredTabs || 0) + batch.length });
      }

      // 设置第一批的 pinned 状态
      const createdTabs = (createdWindow.tabs || []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      const pinPromises = [];
      for (let i = 0; i < Math.min(createdTabs.length, firstBatch.length); i += 1) {
        if (firstBatch[i].pinned) {
          pinPromises.push(chrome.tabs.update(createdTabs[i].id, { pinned: true }).catch(() => {}));
        }
      }
      if (pinPromises.length) await Promise.all(pinPromises);

    } catch (error) {
      console.warn('[materializeState] Failed to restore window:', error);
    }
  }

  // focus 最后一个窗口
  if (restoredWindowIds.length) {
    await chrome.windows.update(restoredWindowIds[restoredWindowIds.length - 1], { focused: true }).catch(() => {});
  }

  updateRestoreStatus({ phase: 'done' });
  setTimeout(clearRestoreStatus, 10000); // 10秒后清除状态

  return restoredWindowIds;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const checkpoints = await withTransaction(db, [CHECKPOINT_STORE], 'readonly', async (tx) => idbGetAll(tx.objectStore(CHECKPOINT_STORE)));
  checkpoints.sort((a, b) => b.createdAt - a.createdAt);
  const latestCheckpoint = checkpoints[0] || null;
  if (!latestCheckpoint) {
    return null;
  }
  return rebuildStateForCheckpoint(latestCheckpoint.id, checkpoints);
}

async function rebuildStateForCheckpoint(checkpointId, checkpointsInput = null) {
  const db = await ensureDb();
  const checkpoints = checkpointsInput || await listCheckpoints();
  const target = checkpoints.find((item) => String(item.id) === String(checkpointId));
  if (!target?.id) {
    throw new Error('checkpoint 不存在');
  }

  const sortedByTime = checkpoints.slice().sort((a, b) => a.createdAt - b.createdAt);
  const next = sortedByTime.find((item) => item.createdAt > target.createdAt);
  const [full, events] = await Promise.all([
    getCheckpointById(target.id),
    withTransaction(db, [EVENT_STORE], 'readonly', async (tx) => idbGetAll(tx.objectStore(EVENT_STORE)))
  ]);

  if (!full?.state) {
    throw new Error('checkpoint 数据不完整');
  }

  const state = cloneState(full.state);
  const sortedEvents = events.slice().sort((a, b) => Number(a?.createdAt || 0) - Number(b?.createdAt || 0));
  for (const event of sortedEvents) {
    const eventAt = Number(event?.createdAt || 0);
    if (eventAt >= target.createdAt && (!next || eventAt < next.createdAt)) {
      applyEventToState(state, event);
    }
  }

  state.capturedAt = Date.now();
  refreshCounts(state);
  return finalizeState(state);
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
  if (url === 'about:blank' || url === 'about:newtab') return false;
  return !url.startsWith('chrome://') && !url.startsWith('edge://') && !url.startsWith('devtools://') && !url.startsWith('chrome-extension://') && !url.startsWith('extension://');
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
  if (dbInstance) return dbInstance;
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
    request.onsuccess = () => {
      dbInstance = request.result;
      dbInstance.onclose = () => { dbInstance = null; };
      dbInstance.onversionchange = () => { dbInstance.close(); dbInstance = null; };
      resolve(dbInstance);
    };
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

async function getMeta(key) {
  const db = await ensureDb();
  return withTransaction(db, [META_STORE], 'readonly', async (tx) => {
    const record = await idbGet(tx.objectStore(META_STORE), key);
    return record?.value ?? null;
  });
}
