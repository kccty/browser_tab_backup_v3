const summary = document.getElementById('summary');
const restoreLatestButton = document.getElementById('restore-latest');
const checkpointButton = document.getElementById('capture-checkpoint');
const optionsButton = document.getElementById('open-options');

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: 'getStatus' });
  const latest = status?.latestCheckpoint;
  const live = status?.liveState;

  if (!latest) {
    summary.textContent = `当前还没有检查点；实时状态约 ${live?.windowCount || 0} 个窗口、${live?.tabCount || 0} 个页签，已记录 ${status?.eventCount || 0} 条增量日志。`;
    return;
  }

  const time = new Date(latest.createdAt).toLocaleString();
  summary.textContent = `最近检查点：${time}，${latest.windowCount} 个窗口，${latest.tabCount} 个页签；实时状态约 ${live?.windowCount || 0} 个窗口、${live?.tabCount || 0} 个页签；累计 ${status?.eventCount || 0} 条日志。`;
}

restoreLatestButton.addEventListener('click', async () => {
  restoreLatestButton.disabled = true;
  restoreLatestButton.textContent = '恢复中…';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'restoreLatestState' });
    if (!result?.ok) {
      throw new Error(result?.error || '恢复最新状态失败');
    }
    await refresh();
  } catch (error) {
    summary.textContent = `恢复失败：${error.message}`;
  } finally {
    restoreLatestButton.disabled = false;
    restoreLatestButton.textContent = '恢复最新状态';
  }
});

checkpointButton.addEventListener('click', async () => {
  checkpointButton.disabled = true;
  checkpointButton.textContent = '保存中…';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'captureCheckpoint' });
    if (!result?.ok) {
      throw new Error(result?.error || '保存检查点失败');
    }
    await refresh();
  } catch (error) {
    summary.textContent = `保存失败：${error.message}`;
  } finally {
    checkpointButton.disabled = false;
    checkpointButton.textContent = '保存检查点';
  }
});

optionsButton.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

void refresh();
