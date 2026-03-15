const list = document.getElementById('snapshot-list');
const template = document.getElementById('snapshot-template');
const refreshButton = document.getElementById('refresh');
const restoreLatestButton = document.getElementById('restore-latest');
const captureCheckpointButton = document.getElementById('capture-checkpoint');

async function loadCheckpoints() {
  list.innerHTML = '<p>加载中…</p>';
  const response = await chrome.runtime.sendMessage({ type: 'listCheckpoints' });
  const checkpoints = response?.checkpoints || [];

  if (!checkpoints.length) {
    list.innerHTML = '<p>当前还没有检查点，你仍然可以尝试“恢复最新状态”。</p>';
    return;
  }

  list.innerHTML = '';
  for (const checkpoint of checkpoints) {
    const node = template.content.firstElementChild.cloneNode(true);
    node.querySelector('.title').textContent = new Date(checkpoint.createdAt).toLocaleString();
    node.querySelector('.meta').textContent = `${checkpoint.windowCount} 个窗口 · ${checkpoint.tabCount} 个页签 · 原因：${checkpoint.reason}`;
    node.querySelector('.restore').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = '恢复中…';
      const result = await chrome.runtime.sendMessage({ type: 'restoreCheckpoint', checkpointId: checkpoint.id });
      if (!result?.ok) {
        alert(`恢复失败：${result?.error || '未知错误'}`);
      } else {
        alert('按检查点恢复完成。');
      }
      button.disabled = false;
      button.textContent = '恢复该检查点';
    });
    list.appendChild(node);
  }
}

captureCheckpointButton.addEventListener('click', async () => {
  captureCheckpointButton.disabled = true;
  captureCheckpointButton.textContent = '保存中…';
  const result = await chrome.runtime.sendMessage({ type: 'captureCheckpoint' });
  if (!result?.ok) {
    alert(`保存失败：${result?.error || '未知错误'}`);
  } else {
    alert('checkpoint 已保存。');
    await loadCheckpoints();
  }
  captureCheckpointButton.disabled = false;
  captureCheckpointButton.textContent = '手动保存 checkpoint';
});

restoreLatestButton.addEventListener('click', async () => {
  restoreLatestButton.disabled = true;
  restoreLatestButton.textContent = '恢复中…';
  const result = await chrome.runtime.sendMessage({ type: 'restoreLatestState' });
  if (!result?.ok) {
    alert(`恢复失败：${result?.error || '未知错误'}`);
  } else {
    alert('按最新状态恢复完成。');
  }
  restoreLatestButton.disabled = false;
  restoreLatestButton.textContent = '恢复最新状态';
});

refreshButton.addEventListener('click', () => {
  void loadCheckpoints();
});

void loadCheckpoints();
