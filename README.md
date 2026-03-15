# Edge Session Recovery

一个为 Microsoft Edge 设计的 MV3 扩展，用于在浏览器异常关闭、系统重启或常规重开后恢复之前的窗口与页签。

当前版本采用：

- **增量日志持续记录**
- **检查点（checkpoint）手动触发**
- **支持按“最新状态”恢复：检查点 + 日志回放**

## 设计目标

- 以事件 hook 为主，而不是高频全量扫描
- 高性能、低额外开销
- 准实时记录会话变化
- 在手动 checkpoint 之外，尽可能利用事件日志恢复到更晚状态

## 核心架构

### 1. 增量日志
后台通过这些浏览器事件持续记录变化：

- `tabs.onCreated`
- `tabs.onRemoved`
- `tabs.onUpdated`
- `tabs.onActivated`
- `tabs.onMoved`
- `tabs.onAttached`
- `tabs.onDetached`
- `tabs.onReplaced`
- `windows.onCreated`
- `windows.onRemoved`
- `windows.onFocusChanged`

这些事件会写入 IndexedDB 的事件日志表。

### 2. 手动检查点
用户在扩展弹窗里点击“保存检查点”时：

- 先 flush 已缓存的增量事件
- 然后把当前内存态/最新状态保存为一个 checkpoint

### 3. 恢复策略
支持两种恢复：

#### A. 按检查点恢复
直接恢复用户手动保存的某个 checkpoint。

#### B. 恢复最新状态
流程如下：

1. 读取最近 checkpoint
2. 读取该 checkpoint 之后的事件日志
3. 在内存中回放这些事件
4. 生成“最新状态”
5. 按这个最新状态重建窗口与页签

如果没有 checkpoint，就尝试从事件日志直接重建可恢复状态。

## 当前实现特点

- 已经具备基本的事件回放恢复能力
- service worker 启动时会尝试从 checkpoint + 日志重建内存态
- popup 和 options 页面都支持“恢复最新状态”

## 现实边界

即使这样，也**不能承诺理论上的 100% 永不丢失**。例如：

- 浏览器或系统被瞬间强杀
- IndexedDB 尚未来得及完成最后一批写入
- 特殊内部页面无法恢复
- 无痕窗口恢复受权限限制
- 纯事件日志在极端边界下可能缺少足够上下文

但从工程上，它已经比简单定时全量扫、或者只靠手动 checkpoint，要更接近“准实时恢复”。

## 安装方法

1. 打开 `edge://extensions/`
2. 开启开发人员模式
3. 点击“加载解压缩的扩展”
4. 选择当前目录

## 使用方法

### 保存恢复点
点击扩展图标 → `保存检查点`

### 恢复最新状态
点击扩展图标 → `恢复最新状态`

或在恢复管理页点击同名按钮。

### 按历史 checkpoint 恢复
进入 `恢复管理` 页面，选择一个 checkpoint 点击恢复。

## 当前目录文件

- `manifest.json`
- `background.js`
- `popup.html`
- `popup.js`
- `popup.css`
- `options.html`
- `options.js`
- `options.css`
- `validate.js`

## 建议验证流程

### 验证 1：checkpoint 恢复
1. 加载扩展
2. 打开多个窗口与页签
3. 点击“保存检查点”
4. 关闭部分标签/新增部分标签
5. 在恢复管理中按 checkpoint 恢复

### 验证 2：最新状态恢复
1. 加载扩展
2. 打开多个窗口与页签
3. 保存一次 checkpoint
4. 然后继续增删改窗口/标签
5. 重开浏览器后点击“恢复最新状态”
6. 检查是否比 checkpoint 更接近关闭前状态

## 后续仍可增强方向

- 给窗口/标签建立更稳定的逻辑 ID，而不是依赖运行时 tabId/windowId
- 日志压缩与自动 checkpoint 合并
- 恢复前预览
- 导出/导入 checkpoint
- 更细粒度 patch 与更强的异常恢复
# browser_tab_backup_v3
