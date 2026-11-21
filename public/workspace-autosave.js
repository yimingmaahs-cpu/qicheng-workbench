// Each report has its own pending save and recovery copy. Recovery copies stay on this browser.
const prefix = (globalThis.cloudPrefix || '') + 'workbench-workspace-v1:';
const contents = workspace => ({ draft: workspace.draft, answers: workspace.answers || {}, edits: workspace.edits || {} });
const same = (a, b) => JSON.stringify(contents(a)) === JSON.stringify(contents(b));
const clone = value => structuredClone(value);
const workspaceOf = report => clone({ version: 0, answers: {}, edits: {}, draft: report.sourceText, applied: [], style: 'concise', ...report.workspace, optimizedItems: report.workspace?.optimizedItems || report.expert.optimizedItems });

export function createWorkspaceAutosave({ saved, changed }) {
  const entries = new Map();
  // Duplicated windows inherit sessionStorage: use it only to find a previous copy, never as a live writer identity.
  const tabId = crypto.randomUUID();
  let previousTabId;
  try { previousTabId = sessionStorage.getItem(prefix + 'tab'); sessionStorage.setItem(prefix + 'tab', tabId); } catch { /* The latest recovery copy remains discoverable. */ }
  const notify = entry => changed(entry);
  function persist(entry) {
    try {
      localStorage.setItem(entry.key, JSON.stringify({ resumeId: entry.resumeId, reportId: entry.reportId, base: entry.base, workspace: entry.workspace, updatedAt: Date.now() }));
      entry.backupError = false;
    } catch { entry.backupError = true; }
  }
  function removeRecovery(entry) {
    try {
      localStorage.removeItem(entry.key);
      if (entry.recoveryKey && localStorage.getItem(entry.recoveryKey) === entry.recoveryRecord) localStorage.removeItem(entry.recoveryKey);
    } catch { /* Server copy has already been confirmed. */ }
    entry.recoveryKey = null;
  }
  async function request(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { 'X-Workbench': '1', 'Content-Type': 'application/json' } }).catch(() => { throw new Error('暂时无法连接服务器，请检查网络后重试保存。'); });
    const result = await response.json().catch(() => { throw new Error('后台响应异常，请重试保存。'); });
    if (!response.ok) throw Object.assign(new Error(result.error || '保存失败，请重试。'), { status: response.status });
    return result;
  }
  function get(resumeId, report) {
    if (entries.has(report.id)) return entries.get(report.id);
    const base = workspaceOf(report), reportPrefix = `${prefix}${resumeId}:${report.id}:`, key = reportPrefix + tabId;
    const entry = { resumeId, reportId: report.id, key, base, workspace: clone(base), dirty: false, status: 'saved', serial: 0, timer: null, pending: null, conflict: null, backupError: false };
    try {
      const candidates = Object.keys(localStorage).filter(key => key.startsWith(reportPrefix)).map(key => {
        try { return { key, record: JSON.parse(localStorage.getItem(key)) }; } catch { return null; }
      }).filter(item => item?.record?.resumeId === resumeId && item.record.reportId === report.id && typeof item.record.workspace?.draft === 'string' && Number.isInteger(item.record.base?.version));
      const recovery = candidates.find(item => item.key === reportPrefix + previousTabId) || candidates.sort((a, b) => b.record.updatedAt - a.record.updatedAt)[0];
      if (recovery && !same(recovery.record.workspace, base)) {
        entry.base = recovery.record.base; entry.workspace = recovery.record.workspace; entry.recoveryKey = recovery.key; entry.recoveryRecord = localStorage.getItem(recovery.key); entry.dirty = true;
        if (entry.base.version !== base.version) { entry.status = 'conflict'; entry.conflict = { remote: base }; }
        else entry.status = 'recovered';
      } else if (recovery) localStorage.removeItem(recovery.key);
    } catch { entry.backupError = true; }
    entries.set(report.id, entry);
    if (entry.dirty) persist(entry);
    return entry;
  }
  function touch(entry) {
    entry.serial++; entry.dirty = true; entry.downloadedBackup = false; persist(entry); clearTimeout(entry.timer);
    if (!['conflict', 'error', 'recovered'].includes(entry.status)) {
      entry.status = entry.pending ? 'saving' : 'pending';
      entry.timer = setTimeout(() => { void save(entry).catch(() => {}); }, 900);
    }
    notify(entry);
  }
  async function save(entry) {
    clearTimeout(entry.timer);
    if (entry.pending) { await entry.pending; if (entry.dirty) return save(entry); return; }
    if (!entry.dirty) return;
    if (entry.conflict) throw new Error('草稿存在版本冲突，请先查看双方内容并选择如何处理。');
    entry.status = 'saving'; notify(entry);
    const snapshot = clone(entry.workspace), serial = entry.serial;
    entry.pending = (async () => {
      try {
        const result = await request(`/api/resumes/${entry.resumeId}/workspace`, { method: 'PATCH', body: JSON.stringify({ reportId: entry.reportId, workspaceVersion: entry.base.version, ...contents(snapshot) }) });
        saved(result.resume);
        const report = result.resume.reports.find(report => report.id === entry.reportId), remote = workspaceOf(report);
        entry.base = remote;
        if (entry.serial === serial) { entry.workspace = clone(remote); entry.dirty = false; entry.status = 'saved'; removeRecovery(entry); }
        else { entry.workspace = { ...clone(remote), ...contents(entry.workspace) }; entry.status = 'pending'; persist(entry); }
      } catch (error) {
        clearTimeout(entry.timer);
        entry.status = 'error'; entry.error = error.message;
        if (error.status === 409) {
          try {
            const result = await request('/api/state'), resume = result.resumes.find(resume => resume.id === entry.resumeId), report = resume?.reports.find(report => report.id === entry.reportId);
            if (report) {
              const remote = workspaceOf(report);
              if (remote.version !== entry.base.version) { entry.conflict = { remote }; entry.status = 'conflict'; saved(resume); }
            }
          } catch { /* Keep the local copy and offer an explicit retry. */ }
        }
        persist(entry); throw error;
      } finally { entry.pending = null; notify(entry); }
    })();
    await entry.pending;
    if (entry.dirty) return save(entry);
  }
  function conflictBackup(entry) { return { resumeId: entry.resumeId, reportId: entry.reportId, savedAt: new Date().toISOString(), base: clone(entry.base), local: clone(entry.workspace), server: clone(entry.conflict.remote) }; }
  function latestBackup(entry) {
    try {
      const key = Object.keys(localStorage).filter(key => key.startsWith(`${prefix}conflict:${entry.resumeId}:${entry.reportId}:`)).sort().at(-1);
      return key ? JSON.parse(localStorage.getItem(key)) : null;
    } catch { return null; }
  }
  async function resolve(entry, choice) {
    if (!entry.conflict) return;
    try { localStorage.setItem(`${prefix}conflict:${entry.resumeId}:${entry.reportId}:${Date.now()}`, JSON.stringify(conflictBackup(entry))); }
    catch { if (!entry.downloadedBackup) throw new Error('浏览器无法保存双方备份，请先导出双方备份，再选择版本。'); }
    const remote = entry.conflict.remote, local = entry.workspace;
    // Edited suggestions belong to a particular generated comparison; never attach old indices to new suggestions.
    const suggestionsChanged = JSON.stringify(entry.base.optimizedItems) !== JSON.stringify(remote.optimizedItems);
    entry.base = clone(remote); entry.conflict = null; entry.downloadedBackup = false;
    entry.workspace = choice === 'server' ? clone(remote) : { ...clone(remote), ...contents(local), edits: suggestionsChanged ? clone(remote.edits) : clone(local.edits || {}) };
    entry.serial++; entry.dirty = choice !== 'server'; entry.status = entry.dirty ? 'pending' : 'saved';
    if (entry.dirty) { persist(entry); await save(entry); } else removeRecovery(entry);
    notify(entry);
  }
  function reset(reportId) { const entry = entries.get(reportId); if (entry) { clearTimeout(entry.timer); if (!entry.dirty) removeRecovery(entry); entries.delete(reportId); } }
  function clear() { for (const entry of entries.values()) { clearTimeout(entry.timer); if (entry.dirty) persist(entry); } entries.clear(); }
  function status(entry) {
    const labels = { saved: `已保存 · 草稿版本 ${entry.workspace.version}`, pending: '等待自动保存…', saving: '正在保存…（可继续输入）', recovered: '已恢复上次未保存内容，请核对后点击保存', conflict: '版本冲突：本地内容已保留，请查看双方内容', error: `保存失败：${entry.error || '请重试'} · 点击保存重试` };
    return labels[entry.status] + (entry.backupError ? ' · 浏览器恢复备份不可用，请保持页面打开并保存' : entry.dirty ? ' · 恢复副本已保存在此浏览器' : '');
  }
  return { get, touch, save, resolve, reset, clear, status, conflictBackup, latestBackup };
}
