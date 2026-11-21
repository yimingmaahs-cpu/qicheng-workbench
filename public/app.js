import { createPrivateUI, qqMailSetupGuide } from '/private-ui.js';
import { createJobGrid, createApplicationBoard, preference, savePreference } from '/recruitment-ui.js';
import { createWorkspaceAutosave } from '/workspace-autosave.js';
const $ = s => document.querySelector(s);

// Keep navigation preferences separate for the personal app and each v3 workspace.
function setupSidebar() {
  const sidebar = document.querySelector('#workspace-sidebar');
  const toggle = document.querySelector('#sidebar-toggle');
  if (!sidebar || !toggle) return;
  const key = (window.cloudPrefix || 'personal:') + 'sidebar-collapsed';
  const apply = (collapsed, save = false) => {
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? '展开侧边栏' : '收起侧边栏');
    toggle.title = collapsed ? '展开侧边栏' : '收起侧边栏';
    if (save) { try { localStorage.setItem(key, String(collapsed)); } catch {} }
    // Let existing table/preview resize listeners adapt without rebuilding the view.
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  };
  let collapsed = false;
  try { collapsed = localStorage.getItem(key) === 'true'; } catch {}
  apply(collapsed);
  toggle.addEventListener('click', () => apply(!document.body.classList.contains('sidebar-collapsed'), true));
  sidebar.querySelectorAll('.nav-item').forEach(item => {
    const label = item.querySelector('.nav-label')?.textContent.trim();
    if (label) { item.title = label; item.setAttribute('aria-label', label); }
  });
  sidebar.addEventListener('click', event => {
    if (event.target.closest('.review-nav-group') && document.body.classList.contains('sidebar-collapsed')) apply(false, true);
  }, true);
}
setupSidebar();

const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const e = escapeHTML;
// Internal fact IDs belong in stored references, not in reader-facing explanations.
function reviewExplanation(value) {
  return String(value ?? '').replace(/(?<![\w-])`?f-[a-f0-9]{16}(?![\w-])`?(?:[\s,，、]+`?f-[a-f0-9]{16}(?![\w-])`?)*[ \t]*/gi, '相关材料');
}

const icons = {
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 .2l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.2l-3 3a5 5 0 0 0 7 7l2-2"/>',
  settings: '<path d="m9 3-1 3-3 1-2 3 2 2-1 3 2 3 3-1 3 2 3-2 3 1 2-3-1-3 2-2-2-3-3-1-1-3z"/><circle cx="12" cy="11" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5zM20 2v4M18 4h4"/>',
  check: '<path d="m5 12 4 4L19 6"/>', arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>', back: '<path d="M19 12H5m5-5-5 5 5 5"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  download: '<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>', trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  edit: '<path d="m16 3 5 5-12 12-6 1 1-6zM14 5l5 5"/>', close: '<path d="m6 6 12 12M6 18 18 6"/>',
  note: '<path d="M4 3h16v14l-5 4H4zM14 21v-5h6M8 8h8M8 12h5"/>',
  external: '<path d="M14 3h7v7M21 3l-11 11M10 3H3v18h18v-7"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.file}</svg>`;
let state = { resumes: [], jobs: [], applications: [], settings: {}, source: {} };
let view = 'sources', selectedId = null, selectedReportId = null, dirty = false, analyzing = false;
let analysisMode = preference('workbench-analysis-mode', ''), toastTimer, activeAnalysis = null;
let reviewInput = { resumeId: '', company: '', title: '', description: '', keywords: '' }, reviewDirty = false;
let pendingMutations = 0;
let reportTab = 'diagnosis', workspaceDirty = false, settingsDirty = false;
let reviewsExpanded = false, lastReview = null;
let targetedPreview = null;
const workspaceAutosave = createWorkspaceAutosave({ saved: replaceResume, changed: updateWorkspaceStatus });
const reportTabs = { diagnosis: '整体诊断', match: '岗位匹配', followup: '经历追问', optimize: '修改对照', draft: '简历定稿', interview: '面试准备' };
const names = { catalog:'发现岗位', admin:'发布岗位库', account:'本地设置', runtime:'运行与备份', resumes: '我的简历', document: '简历原文', reviews: '简历评审', detail: '评审报告', sources: '我的来源', jobs: '岗位库', applications: '投递跟踪', mail: '邮箱追踪', settings: '分析设置' };
const cloud = createPrivateUI({api,e,modal,toast,refresh,render,go,canLeave,getState:()=>state,getView:()=>view,onModelSaved:()=>{settingsDirty=false;}});
const fmtDate = value => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtSize = bytes => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function api(url, options = {}) {
  const writing = options.method && options.method !== 'GET';
  if (writing) { pendingMutations++; $('#main').inert = true; $('#modal').inert = true; }
  try {
  const response = await fetch(url, { ...options, headers: { 'X-Workbench': '1', ...(typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...options.headers } }).catch(()=>{throw new Error('暂时无法连接本地工作台，请确认启动程序仍在运行。');});
  let data;
  try { data = await response.json(); } catch { throw new Error('工作台服务响应异常，请确认服务仍在运行。'); }
  if (!response.ok) throw new Error(data.error || '操作失败，请重试。');
  return data;
  } finally {
    if (writing && --pendingMutations === 0) { $('#main').inert = false; $('#modal').inert = false; }
  }
}
async function refresh(options) { state = await api('/api/state', options); }
function replaceResume(resume) { state.resumes = [resume, ...state.resumes.filter(r => r.id !== resume.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
function toast(message, error = false) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').className = `show${error ? ' error' : ''}`; toastTimer = setTimeout(() => $('#toast').className = '', 5000); }
function selectedAnalysisMode() { return ['local', 'ai'].includes(analysisMode) ? analysisMode : state.settings.hasKey && state.settings.baseUrl && state.settings.model ? 'ai' : 'local'; }
function analysisButtonLabel() { return selectedAnalysisMode() === 'local' ? '运行本地基础检查' : reviewInput.description?.trim() ? '按 JD 进行 AI 评审与改写' : '进行 AI 通用评审与改写'; }
function analysisStatusHTML() { return `<p id="analysis-status" class="report-notice" role="status" aria-live="polite" ${activeAnalysis ? '' : 'hidden'}>${e(activeAnalysis?.message || '')}</p>`; }
const pendingReviewKey = 'workbench-pending-review:' + (window.cloudPrefix || '');
function clearPendingReview() {
  try { sessionStorage.removeItem(pendingReviewKey); } catch { /* Storage availability must not interrupt a server task. */ }
}
async function waitReviewJob(job) {
  if (activeAnalysis) activeAnalysis.background = true;
  let failures = 0;
  for (;;) {
    let status;
    try { status = await api(`/api/resumes/${job.resumeId}/analysis-status`, { signal: AbortSignal.timeout(10000) }); failures = 0; }
    catch (error) {
      if (++failures >= 3) throw new Error('暂时无法读取后台进度。任务可能仍在运行，刷新页面可重新连接；不要重复发起评审。');
      await new Promise(resolve => setTimeout(resolve, 1000)); continue;
    }
    if (status.operationId !== job.operationId) {
      await refresh({ signal: AbortSignal.timeout(10000) });
      clearPendingReview();
      throw new Error('后台任务已变化或服务已重启。已完成节点保存在评审记录中，可打开记录继续。');
    }
    if (!status.running) {
      await refresh({ signal: AbortSignal.timeout(10000) });
      clearPendingReview();
      if (status.error) throw new Error(status.error);
      const resume = state.resumes.find(r => r.id === job.resumeId);
      if (!resume) throw new Error('简历已不存在。');
      return { resume };
    }
    const element = $('#analysis-status');
    if (element) { element.hidden = false; element.textContent = `已用时 ${Math.max(0, Math.floor((Date.now() - Date.parse(status.startedAt)) / 1000))} 秒 · ${status.message}`; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
async function reviewRequest(id, endpoint, payload) {
  const result = await api(`/api/resumes/${id}/${endpoint}`, { method: 'POST', body: JSON.stringify({ ...payload, background: Boolean(state.capabilities?.reviewBackground) }) });
  if (!result.background) return result;
  const job = { ...result, endpoint, reportId: payload.reportId };
  try { sessionStorage.setItem(pendingReviewKey, JSON.stringify(job)); }
  catch { toast('浏览器暂时无法保存恢复标记。评审仍在后台进行，请保持此页打开；结果会保存在评审记录中。', true); }
  if (endpoint === 'analyze') { reviewDirty = false; history.replaceState(null, '', `#reviews/${id}`); }
  pendingMutations++; $('#main').inert = true;
  try { return await waitReviewJob(job); }
  finally { if (--pendingMutations === 0) $('#main').inert = false; }
}
function startAnalysisStatus(resumeId) {
  const operation = { resumeId, message: state.capabilities?.jdTargetedReview ? '请求已提交，等待后台返回当前阶段…' : 'AI 请求处理中，正在等待结果…', timer: null, controller: new AbortController() };
  activeAnalysis = operation;
  const show = () => { const element = $('#analysis-status'); if (element) { element.hidden = false; element.textContent = operation.message; element.dataset.stage = operation.stage || ''; } };
  show();
  async function poll() {
    if (activeAnalysis !== operation) return;
    try {
      const status = await api(`/api/resumes/${resumeId}/analysis-status`, { signal: operation.controller.signal });
      if (activeAnalysis !== operation) return;
      operation.stage = status.stage || '';
      operation.message = status.running ? status.message || '后台正在处理…' : '后台处理已结束，正在接收结果…';
      show();
      if (!status.running) return;
    } catch { if (activeAnalysis !== operation) return; operation.message = '暂时无法读取处理阶段，正在等待本次请求结果…'; show(); }
    operation.timer = setTimeout(poll, 2000);
  }
  if (state.capabilities?.jdTargetedReview && !state.capabilities?.reviewBackground) operation.timer = setTimeout(poll, 2000);
  return () => { clearTimeout(operation.timer); operation.controller.abort(); if (activeAnalysis === operation) { activeAnalysis = null; const element = $('#analysis-status'); if (element) { element.hidden = true; element.textContent = ''; } } };
}
function modal(title, content) {
  const dialog = $('#modal');
  dialog.innerHTML = `<div class="modal-head"><h2 id="modal-title">${e(title)}</h2><button class="icon-btn" data-action="close-modal" aria-label="关闭">${icon('close')}</button></div><div class="modal-body">${content}</div>`;
  if (!dialog.open) dialog.showModal();
  fitResumePreviews();
}
async function confirmAction(title, message, label = '确认') {
  modal(title, `<p>${e(message)}</p><div class="form-actions"><button class="btn" data-action="close-modal">取消</button><button class="btn primary" id="confirm-action">${e(label)}</button></div>`);
  return new Promise(resolve => {
    $('#confirm-action').onclick = () => { $('#modal').onclose = null; $('#modal').close(); resolve(true); };
    $('#modal').onclose = () => { $('#modal').onclose = null; resolve(false); };
  });
}
async function canLeave() {
  if (pendingMutations) { toast('正在保存或提取文字，请稍候。'); return false; }
  if (analyzing) { toast('正在分析，请等待完成后再切换页面。'); return false; }
  if (workspaceDirty) { try { await saveWorkspace(); } catch (error) { toast(error.message, true); return false; } }
  if ((dirty || workspaceDirty || settingsDirty || reviewDirty) && !await confirmAction('还没有保存修改', '离开会丢失本次尚未保存的文字、草稿、JD 或模型设置。你也可以取消，完成当前操作后再离开。', '放弃修改并离开')) return false;
  dirty = false; workspaceDirty = false; settingsDirty = false; reviewDirty = false; workspaceAutosave.clear(); return true;
}
async function go(next, id = null, reportId = null) {
  if (!await canLeave()) return false;
  if (['runtime','sources','jobs','applications','mail'].includes(next)) { try { await refresh(); } catch(error) { toast(error.message,true); return false; } }
  if(['runtime','settings'].includes(next))next='account';
  view = next; selectedId = id; selectedReportId = reportId; reportTab = 'diagnosis';
  if (next === 'reviews' || next === 'detail') reviewsExpanded = true;
  if (next === 'reviews') reviewInput = { resumeId: id || '', company: '', title: '', description: '', keywords: '' };
  history.replaceState(null, '', `#${next}${id ? `/${id}` : ''}${reportId ? `/${reportId}` : ''}`);
  render(); window.scrollTo({ top: 0 }); return true;
}
function toggleReviewNav() {
  reviewsExpanded = !reviewsExpanded;
  updateNav();
}
async function openReviewCenter() {
  if (view === 'reviews') toggleReviewNav();
  else await go('reviews');
}
function heading(title, description, actions = '') { return `<div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div><div class="actions">${actions}</div></div>`; }
function button(label, action, kind = '', ico = '', extra = '') { return `<button type="button" class="btn ${kind}" data-action="${action}" ${extra}>${ico ? icon(ico) : ''}${label}</button>`; }
function updateNav() {
  $('#breadcrumb').textContent = names[view];
  $('#nav-resumes').textContent = state.resumes.length;
  document.querySelectorAll('[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === (view === 'detail' ? 'reviews' : view === 'document' ? 'resumes' : view)));
  if (view === 'detail' && currentReport()) lastReview = { resumeId: selectedId, reportId: currentReport().id };
  const activeReport = state.resumes.find(r => r.id === lastReview?.resumeId)?.reports.find(r => r.id === lastReview?.reportId);
  $('#review-nav-toggle').classList.toggle('active', ['reviews', 'detail'].includes(view));
  $('#review-nav-toggle').setAttribute('aria-expanded', String(reviewsExpanded));
  $('#review-nav-disclosure').setAttribute('aria-expanded', String(reviewsExpanded));
  $('#review-nav-disclosure').setAttribute('aria-label', `${reviewsExpanded ? '收起' : '展开'}简历评审流程`);
  $('#review-nav-disclosure').classList.toggle('active', ['reviews', 'detail'].includes(view));
  $('#review-subnav').hidden = !reviewsExpanded;
  $('#review-subnav').innerHTML = Object.entries(reportTabs).map(([key, label], i) => `<button class="subnav-item ${view === 'detail' && reportTab === key ? 'active' : ''}" data-action="report-tab" data-tab="${key}" ${!activeReport || (key !== 'diagnosis' && !activeReport.expert) ? 'disabled' : ''} ${view === 'detail' && reportTab === key ? 'aria-current="step"' : ''}><span>${i + 1}</span>${label}</button>`).join('') + (!activeReport ? '<p class="subnav-hint">开始评审或打开历史报告后，可切换流程。</p>' : '');
  document.querySelectorAll('[data-icon]').forEach(el => el.innerHTML = icon(el.dataset.icon));
}
function render() {
  jobGrid?.destroy(); jobGrid = null; destroyBoard?.(); destroyBoard = null;
  updateNav();
  if (['detail', 'document'].includes(view) && !state.resumes.some(r => r.id === selectedId)) { view = 'resumes'; updateNav(); }
  if(['sources','account'].includes(view)){void cloud.render(view);return;}
  $('#main').innerHTML = ({ runtime:runtimeView, resumes: resumesView, document: documentView, reviews: reviewsView, detail: detailView, sources: sourcesView, jobs: jobsView, applications: applicationsView, mail: mailView, settings: settingsView })[view]();
  fitResumePreviews();
  if (view === 'resumes') setupDrop();
  if (view === 'mail') void loadMail().catch(error=>toast(error.message,true));
  if (view === 'jobs') setupJobTable();
  if (view === 'applications' && applicationSearch.box!=='trash') setupApplicationCalendar();
  if (view === 'applications' && applicationView === 'board' && applicationSearch.box!=='trash') setupApplicationBoard();
  if (view === 'document') {
    $('#resume-text').addEventListener('input', () => { dirty = $('#resume-text').value !== state.resumes.find(r => r.id === selectedId).text; $('#edit-status').textContent = dirty ? '有未保存的修改' : '已保存'; $('#save-text').disabled = !dirty; });
  }
}

function resumesView() {
  const reviewed = state.resumes.filter(r => r.reports.some(a => a.revision === r.revision)).length;
  return heading('我的简历', '整理你的经历，为下一次机会做好准备。', button('粘贴文字', 'paste', '', 'note') + button('上传简历', 'upload', 'primary', 'plus')) +
    `<div class="stats"><div class="stat"><div><div class="stat-label">简历文件</div><div class="stat-number">${state.resumes.length}<small>份简历，独立保存</small></div></div><div class="stat-icon">${icon('file')}</div></div><div class="stat"><div><div class="stat-label">已完成评审</div><div class="stat-number">${reviewed}<small>份最新版本</small></div></div><div class="stat-icon">${icon('check')}</div></div><div class="stat"><div><div class="stat-label">投递记录</div><div class="stat-number">${(state.applications || []).length}<small>条申请，持续跟进</small></div></div><div class="stat-icon">${icon('target')}</div></div></div>
    <div class="workspace-grid"><section class="panel"><div class="panel-head"><h2>简历资料库</h2><span class="meta">你的求职，从这里开始</span></div><div class="panel-body"><div class="upload-area" id="drop-zone"><div class="upload-icon">${icon('upload')}</div><h3>将简历拖到这里，或选择文件</h3><p>支持 PDF、Word（.docx）、TXT、Markdown · 最大 10 MB</p>${button('选择简历文件', 'upload', '', 'plus')}<input type="hidden" id="upload-marker"></div><div class="upload-foot">${icon('lock')}原始文件与评审报告保存在本机</div><div class="library-head"><strong>全部简历</strong><span>${state.resumes.length ? `${state.resumes.length} 份文件` : '等待你的第一份简历'}</span></div>${state.resumes.length ? state.resumes.map(fileRow).join('') : '<div class="empty-list"><strong>这里还没有简历</strong>上传已有简历，或粘贴文字，开始一次有依据的评审。</div>'}</div></section>
    <aside class="right-stack"><section class="panel accent-panel"><h2>${icon('spark')}让经历更有说服力</h2><p>从原文出发，找出可以改进的地方。</p><div class="steps"><div class="step"><span class="step-num">1</span><div><strong>导入并核对原文</strong><p>自动提取文字，支持手动校对</p></div></div><div class="step"><span class="step-num">2</span><div><strong>查看具体修改建议</strong><p>检查完整度、表达与成果证据</p></div></div><div class="step"><span class="step-num">3</span><div><strong>围绕你的方向优化</strong><p>在简历评审中粘贴本次岗位 JD</p></div></div></div></section><section class="panel tip-card"><h3>${icon('target')}按具体岗位优化</h3><p>从岗位库选择目标职位，将 JD 带入简历评审，再用定向简历投递并跟进。</p><button class="text-link" data-view="jobs">查看岗位库 ${icon('arrow')}</button></section><section class="panel tip-card"><h3>${icon('lock')}选择适合你的分析方式</h3><p>基础检查无需联网。需要深入分析时，可在设置中连接你自己的 AI 模型。</p><button class="text-link" data-view="settings">分析设置 ${icon('arrow')}</button></section></aside></div>`;
}
function fileRow(r) {
  const current = r.reports.some(a => a.revision === r.revision);
  return `<div class="file-row"><span class="file-symbol">${e(r.ext.toUpperCase())}</span><div class="file-info"><button class="file-title" data-action="open-resume" data-id="${r.id}" title="${e(r.name)}">${e(r.name)}</button><small>${fmtDate(r.createdAt)} · ${fmtSize(r.size)}${r.pages ? ` · ${r.pages} 页` : ''}</small></div><span class="badge ${current ? '' : 'neutral'}">${current ? '已评审' : r.reports.length ? '待重新评审' : '待评审'}</span><div class="actions">${button('发起评审', 'start-review', 'small', '', `data-id="${r.id}"`)}<button class="icon-btn" data-action="delete-resume" data-id="${r.id}" aria-label="删除 ${e(r.name)}">${icon('trash')}</button></div></div>`;
}
function documentView() {
  const r = state.resumes.find(r => r.id === selectedId);
  return heading('简历原文', '核对和维护这份简历，原始文件始终保留。', button('返回简历库', 'back', '', 'back') + button('用这份简历评审', 'start-review', 'primary', 'spark', `data-id="${r.id}"`)) + `<section class="panel"><div class="panel-head"><div class="document-meta"><span class="file-symbol">${e(r.ext.toUpperCase())}</span><div><h2>${e(r.name)}</h2><span class="meta">${r.text.length.toLocaleString()} 字符 · 文字版本 ${r.revision}</span></div></div><a class="icon-btn" href="/api/resumes/${r.id}/original" title="下载上传时的原始文件" aria-label="下载原始文件">${icon('download')}</a></div><textarea class="editor" id="resume-text" aria-label="简历原文" maxlength="120000" spellcheck="false" ${analyzing ? 'disabled' : ''}>${e(r.text)}</textarea><div class="editor-footer">${['pdf', 'docx'].includes(r.ext) ? button('重新提取文字', 'reextract', 'small', 'file', analyzing ? 'disabled' : '') : ''}<span id="edit-status">已保存 · 修改仅影响分析文字，原文件保留</span><button class="btn small" id="save-text" data-action="save-text" disabled>${icon('check')}保存修改</button></div></section>`;
}
function reviewsView() {
  const historyItems = state.resumes.flatMap(resume => resume.reports.map(report => ({ resume, report }))).sort((a, b) => b.report.createdAt.localeCompare(a.report.createdAt));
  const input = reviewInput, mode = selectedAnalysisMode();
  return heading('简历评审', '一份简历，可以针对不同公司和岗位分别评审。') + `<div class="review-start-grid"><section class="panel"><div class="panel-head"><h2>${icon('spark')} 发起新的评审</h2><span class="badge neutral">本次岗位独立保存</span></div><form id="review-form" class="review-form"><div class="field"><label for="review-resume">选择要分析的简历</label><select id="review-resume" name="resumeId" required><option value="">请选择一份简历</option>${state.resumes.map(r => `<option value="${r.id}" ${input.resumeId === r.id ? 'selected' : ''}>${e(r.name)} · 文字版本 ${r.revision}</option>`).join('')}</select>${state.resumes.length ? '' : '<small>还没有简历，请先到“我的简历”上传或粘贴文字。</small>'}</div><div class="field-row"><div class="field"><label for="review-company">公司名称（选填）</label><input id="review-company" name="company" maxlength="120" value="${e(input.company)}" placeholder="本次申请的公司"></div><div class="field"><label for="review-title">岗位名称（选填）</label><input id="review-title" name="title" maxlength="80" value="${e(input.title)}" placeholder="本次申请的职位"></div></div><div class="field"><label for="review-jd">粘贴本次岗位 JD</label><textarea id="review-jd" name="description" class="jd-editor" maxlength="10000" placeholder="粘贴这家公司的岗位职责、任职要求等完整 JD…">${e(input.description)}</textarea><small>JD 只用于本次评审，随报告保存。留空可进行通用简历评审。</small></div><div class="field"><label for="review-keywords">本次关注关键词（选填）</label><input id="review-keywords" name="keywords" maxlength="500" value="${e(input.keywords)}" placeholder="可从 JD 中挑选，用逗号分隔"><small>基础检查会查找这些词；AI 评审会结合完整 JD 分析。</small></div><div class="field"><label for="analysis-mode">分析方式</label><select id="analysis-mode" name="mode"><option value="local" ${mode === 'local' ? 'selected' : ''}>本地基础检查（不做 JD 语义改写）</option><option value="ai" ${mode === 'ai' ? 'selected' : ''}>AI 深度评审与改写</option></select></div><div id="analysis-disclosure">${analysisDisclosure()}</div>${analysisStatusHTML()}<button id="analysis-submit" type="submit" class="btn primary" ${analyzing || !state.resumes.length ? 'disabled' : ''}>${analyzing ? '<span class="spinner"></span>正在分析，请稍候…' : icon('spark') + analysisButtonLabel()}</button></form></section></div><section class="panel reviews-history"><div class="panel-head"><h2>评审记录</h2><span class="meta">${historyItems.length} 份报告</span></div><div class="panel-body">${historyItems.map(({ resume, report }) => `<article class="review-history-row"><div><strong>${e(report.target?.company ? report.target.company + ' · ' : '')}${e(report.target?.title || '通用简历评审')}</strong><p>${e(resume.name)} · v${report.revision} · ${fmtDate(report.createdAt)}</p><span class="badge neutral">${report.engine === 'ai' ? 'AI 深度评审' : '本地基础检查'}</span>${report.revision !== resume.revision ? ' <span class="badge amber">原文已更新</span>' : ''}</div><div class="actions">${report.expert ? button(report.workspace ? '查看已保存草稿' : '查看草稿', 'open-draft', 'small', 'file', `data-id="${resume.id}" data-report="${report.id}"`) : ''}${button('查看报告', 'open-report', 'small', 'arrow', `data-id="${resume.id}" data-report="${report.id}"`)}</div></article>`).join('') || '<div class="empty-list">还没有评审记录。选择简历并粘贴 JD，开始第一次评审。</div>'}</div></section>`;
}
function detailView() {
  const r = state.resumes.find(r => r.id === selectedId), report = currentReport();
  if (!report) return heading('评审报告', '这份简历尚未生成报告。', button('发起评审', 'start-review', 'primary', 'spark', `data-id="${r.id}"`));
  const target = report.target;
  return heading('评审报告', `${e(target?.company ? target.company + ' · ' : '')}${e(target?.title || '通用简历评审')} · ${e(r.name)}`, button('发起新评审', 'start-review', 'primary', 'plus', `data-id="${r.id}"`)) + `${reviewSummaryHTML(report)}<section class="panel review-materials"><span class="muted">材料快照 · v${report.revision} · ${fmtDate(report.createdAt)}</span><details class="source-jd"><summary>简历原文</summary><p class="preserve">${e(report.sourceText)}</p></details>${target?.description ? `<details class="source-jd"><summary>本次岗位 JD</summary><p class="preserve">${e(target.description)}</p></details>` : '<span class="muted">通用评审 · 未提供 JD</span>'}${button('查看最新简历原文', 'open-resume', 'small', 'file', `data-id="${r.id}"`)}</section><section class="panel review-result">${renderReport(report, r)}</section>`;
}
function analysisDisclosure() {
  if (selectedAnalysisMode() === 'local') return '<div class="callout">本地基础检查不调用 AI，只检查常见信息、手填关键词并提供通用表达模板，不做 JD 语义分析或定向改写。需要针对岗位改写时，请选择 AI 深度评审与改写。</div><br>';
  let host = ''; try { host = new URL(state.settings.baseUrl).host; } catch {}
  return `<div class="callout">${host && state.settings.model ? `开始分析会将简历文字和本次公司、岗位 JD 发送至 <strong>${e(host)}</strong>（${e(state.settings.model)}）。${state.settings.redact ? '常见手机号、邮箱和身份证号会先隐藏，其他经历内容仍会发送。' : '当前未启用联系方式隐藏。'}` : '请先在“分析设置”中配置模型地址和名称，再进行 AI 评审。'}<br>AI 会先诊断岗位要求与简历证据，再生成修改建议；核对后逐条采纳到独立草稿。未采纳前草稿保留原文。</div><br>`;
}
function currentReport() {
  const r = state.resumes.find(r => r.id === selectedId);
  return r?.reports.find(a => a.id === selectedReportId) || r?.reports[0];
}
function working(report) {
  const entry = workspaceAutosave.get(selectedId, report);
  workspaceDirty = entry.dirty;
  return entry.workspace;
}
function reviewSummaryHTML(report) {
  const w = report.expert ? working(report) : report.workspace || {}, items = w.optimizedItems || report.expert?.optimizedItems || [];
  const process = report.reviewProcess;
  const stages = (process?.stages || []).map(stage => ({ jd: '拆解岗位 JD', facts: '整理经历事实', audit: '独立核查', repair: '修正建议', audit_repair: '复核修正', diagnosis: report.target?.description ? 'JD 与简历证据诊断' : '简历经历证据诊断', rewrite: '生成修改对照' })[stage]).filter(Boolean);
  const mode = report.engine === 'ai' ? `AI 深度评审${report.model ? ' · ' + report.model : ''}` : `初始评审：本地基础检查${w.optimization?.engine === 'ai' ? '' : ' · 未进行 JD 语义改写'}`;
  return `<section class="panel review-summary" aria-label="本次评审状态"><strong>${e(mode)}</strong><p>${report.target?.description ? '已提供本次 JD' : '通用评审 · 未提供 JD'} · ${items.length} 项改写建议 · ${(w.applied || []).length} 项已采纳</p>${stages.length ? `<p>已完成：${e(stages.join(' → '))}${Number.isFinite(process.durationMs) ? ` · 实际用时 ${(process.durationMs / 1000).toFixed(1)} 秒` : ''}</p>` : ''}${report.engine === 'ai' && report.expert?.engine === 'local' ? '<p class="risk-note">这份旧报告的扩展流程使用本地辅助模板；可发起新的 AI 评审核对岗位要求。</p>' : ''}${w.optimization?.engine === 'ai' ? `<p>当前修改建议：AI ${w.optimization.targeted ? '岗位定向' : '通用'}改写 · ${e(w.optimization.model || '已配置模型')}${w.optimization.generatedAt ? ' · ' + e(fmtDate(w.optimization.generatedAt)) : ''}</p>` : ''}</section>`;
}
function requirementEvidence(item) {
  if (!item.jdRequirement && !item.jdEvidence) return '';
  return `<div class="jd-evidence"><strong>对应岗位要求：${e(item.jdRequirement || '未注明')}</strong>${item.jdEvidence ? `<p>JD 原文：${e(item.jdEvidence)}</p>` : ''}</div>`;
}
function canPreviewTargeted(report) {
  return state.capabilities?.targetedDraftPreview && (report.target?.description || report.expert?.structure?.version === 1) && ((report.engine === 'ai' && report.expert?.engine === 'ai' && report.reviewProcess?.version >= 2) || working(report).optimization?.engine === 'ai');
}
async function showTargetedPreview() {
  const report = currentReport(), resumeId = selectedId;
  if (!report || !canPreviewTargeted(report)) return;
  pendingMutations++; $('#main').inert = true; $('#modal').inert = true;
  try {
    await saveWorkspace();
    const w = working(currentReport());
    const preview = await api(`/api/resumes/${resumeId}/targeted-draft?reportId=${report.id}&workspaceVersion=${w.version}`);
    targetedPreview = { ...preview, resumeId };
    modal('完整定向稿 · ' + preview.targetTitle, `<div id="targeted-preview"><p>基于本次报告原文与已保存的修改建议，已合入 <strong>${preview.appliedCount} / ${preview.totalCount}</strong> 项修改。原简历与现有手动草稿保持独立。</p>${preview.appliedCount ? '<p>请核对完整表达与事实。另存为新简历后，可以继续编辑并用于投递。</p>' : '<div class="callout">暂无可合入的有效修改。下方仍为报告原文，请返回修改对照处理后再另存。</div>'}${preview.skipped.length ? `<details open><summary>有 ${preview.skipped.length} 项未合入</summary><ul>${preview.skipped.map(item => `<li>第 ${item.index + 1} 项：${e(reviewExplanation(item.reason))}</li>`).join('')}</ul></details>` : ''}<div class="form-actions">${button('返回修改对照', 'targeted-return')}${button('导出定向稿 TXT', 'targeted-export', '', 'download', preview.appliedCount ? '' : 'disabled')}${button('另存定向版简历', 'targeted-copy', 'primary', 'plus', preview.appliedCount ? '' : 'disabled')}</div><div class="resume-preview">${resumePaper(preview.draft)}</div></div>`);
  } finally { if (--pendingMutations === 0) { $('#main').inert = false; $('#modal').inert = false; } }
}
async function targetedAction(action) {
  if (action === 'targeted-preview') { await showTargetedPreview(); return; }
  const preview = targetedPreview;
  if (!preview) return;
  if (action === 'targeted-return') { $('#modal').close(); reportTab = 'optimize'; history.replaceState(null, '', `#detail/${selectedId}/${currentReport().id}/optimize`); render(); return; }
  if (action === 'targeted-export') {
    if (!preview.appliedCount) return;
    const url = URL.createObjectURL(new Blob([preview.draft], { type: 'text/plain;charset=utf-8' })), link = document.createElement('a');
    link.href = url; link.download = preview.filename; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); return;
  }
  if (action === 'targeted-copy') {
    const result = await api(`/api/resumes/${preview.resumeId}/targeted-copy`, { method: 'POST', body: JSON.stringify({ reportId: preview.reportId, reportRevision: preview.reportRevision, workspaceVersion: preview.workspaceVersion }) });
    replaceResume(result.resume); $('#modal').close(); await go('document', result.resume.id); toast(result.duplicate ? '已有相同内容的简历，已打开。' : '定向版已另存，原文和原草稿均保留。');
  }
}
function reviewNeedsUpdate(report) {
  if (report.reviewProcess?.version !== 3) return false;
  const saved = report.reviewProcess.evaluatedAnswers || {}, answers = working(report).answers || {};
  return [...new Set([...Object.keys(saved), ...Object.keys(answers)])].some(k => (saved[k] || '').trim() !== (answers[k] || '').trim());
}
function workflowNotice(report) {
  const flow = report.pendingReview ? { ...report.reviewProcess, ...report.pendingReview, status: 'partial', failedStage: 'resume', error: '本轮尚未完成，已完成节点已保存；若后台已停止，可继续评审' } : report.reviewProcess;
  if (flow?.version !== 3) return '';
  const names = { resume:'后台评审', jd:'岗位拆解', facts:'事实整理', diagnosis:'诊断评分', rewrite:'修改对照', audit:'独立核查', repair:'修正建议', audit_repair:'复核' };
  const stale = reviewNeedsUpdate(report), failed = flow.failedStage, withheld = report.expert?.withheldItems?.length || 0;
  return `<div class="review-workflow-status"><span>${flow.status === 'completed' ? '评审已完成' : '评审部分完成'} · ${e(flow.stages.map(s => names[s] || s).join(' → '))}</span>${stale ? '<p class="risk-note">补充回答已变化，当前诊断与分数仍基于上次材料。</p>' : ''}${failed ? `<p class="risk-note">${e(names[failed] || failed)}未完成：${e(flow.error.replace(/[。；;\s]+$/, ""))}。已完成节点已保存，可继续执行。</p>` : ''}${report.expert?.diagnosticWarnings?.length ? '<p class="muted">已保留有效岗位匹配结论；部分辅助建议的引用无效，未采用。</p>' : ''}${withheld ? `<p class="risk-note">${withheld} 项修改尚未通过核查，未自动采纳。</p>` : ''}${stale || failed || withheld ? button((failed || withheld) && !stale ? '继续未完成的评审' : '更新诊断、评分与改写', 'expert-generate', 'small', 'spark') : ''}</div>`;
}
function matchScoreHTML(report) {
  const score = report.targetFit?.score;
  if (!score) return `<p class="muted">${report.reviewProcess?.version === 3 ? '完整 JD 的证据诊断尚未完成，暂不评分。' : '这份报告未包含匹配评分。使用 AI 重新评审完整 JD 后可查看。'}</p>`;
  const support = { direct:'直接证据', transferable:'可迁移证据', weak:'弱线索', none:'材料未说明' };
  const eligibility = { supported:'材料支持满足', conflict:'材料明确冲突', unknown:'材料未说明', not_applicable:'不适用' };
  return `<section class="match-score" aria-label="简历与JD匹配度"><div class="match-score-top"><div><span class="section-label">简历与 JD 匹配度 · 材料证据</span><div class="match-score-number">${e(score.score)}<small> / 100</small></div></div><div><p>证据覆盖 ${e(score.coverage)}% · ${score.unknowns.length} 项材料未说明</p><p class="muted">${score.includesAnswers ? '评分包含本次补充回答；回答不一定已写入草稿。' : '基于分析时的简历原文。'}${reviewNeedsUpdate(report) ? ' 补充回答已变化，需更新评分。' : ''}</p></div></div>${score.conflicts.length ? `<p class="risk-note"><strong>有 ${score.conflicts.length} 项明确冲突，请先核对：</strong>${e(score.items.filter(i => i.conflict).map(i => `${i.text}${i.necessity === 'mandatory' ? '（明确必须）' : ''}`).join('；'))}。总分不抵消这些条件。</p>` : ''}<div class="match-score-dimensions">${score.dimensions.map(d => `<div><span>${e(d.label)}</span><strong>${e(d.earned)} / ${e(d.weight)}</strong><div class="match-score-track"><i style="width:${Number(d.score)}%"></i></div><small>${d.unknown ? d.unknown + ' 项未说明' : '已有材料可核对'}</small></div>`).join('')}</div><p class="muted">${e(score.note)}</p><details><summary>查看评分依据与计算方式</summary><p>${e(score.formula)}</p><p class="muted">未说明部分涉及约 ${e(score.unknownPoints)} 分权重，暂不计入已获分；不等于实际不具备能力。相同材料仍可能受模型证据判断差异影响，规则版本 ${e(score.rubric)}。</p><div class="table-scroll"><table class="review-table"><thead><tr><th>岗位要求</th><th>证据 / 资格状态</th><th>得分 / 权重</th><th>依据</th></tr></thead><tbody>${score.items.map(i => `<tr><th>${e(i.text)}</th><td>${e(i.kind === 'hard' ? eligibility[i.eligibility] : i.conflict ? '材料明确冲突' : support[i.support])}</td><td>${e(i.earned)} / ${e(i.weight)}</td><td>${e(reviewExplanation(i.reason))}</td></tr>`).join('')}</tbody></table></div></details></section>`;
}
function withheldHTML(report) {
  const items = report.expert.withheldItems || [];
  if (!items.length) return '';
  return `<details class="withheld-items"><summary>${items.length} 项修改未通过核查，未纳入可采纳建议</summary>${items.map(i => `<article><p class="preserve">原文：${e(i.before)}</p><p class="risk-note">${e(i.riskWarning)}</p></article>`).join('')}</details>`;
}
function targetFitHTML(report) {
  if (!report.target) return '';
  const fit = report.targetFit || {}, semantic = fit.mode === 'semantic';
  const local = report.engine !== 'ai';
  const note = local || semantic || fit.mode === 'general' ? fit.note || '' : '这份旧 AI 报告的岗位分析请在“岗位匹配”中查看；新的评审会显示逐项 JD 依据。';
  return `<div class="target-fit"><strong>评审方向：${e(report.target.title)}</strong><p>${e(note)}</p>${semantic || local ? `${fit.matched?.length ? `<p>${semantic ? '已有简历证据' : '已找到关键词'}：${e(fit.matched.join('、'))}</p>` : ''}${fit.missing?.length ? `<p>${semantic ? '证据待补充' : '未找到关键词'}：${e(fit.missing.join('、'))}</p>` : ''}` : ''}</div>`;
}
function updateWorkspaceStatus(entry) {
  if (view !== 'detail' || currentReport()?.id !== entry.reportId) return;
  workspaceDirty = entry.dirty;
  if ($('#workspace-status')) $('#workspace-status').textContent = workspaceAutosave.status(entry);
  if ($('#workspace-conflict-trigger')) $('#workspace-conflict-trigger').hidden = !entry.conflict;
}
function workspaceSaveControls(report) {
  const entry = workspaceAutosave.get(selectedId, report);
  return `<div class="workspace-save"><span id="workspace-status" role="status" aria-live="polite">${e(workspaceAutosave.status(entry))}</span><div class="actions">${button('查看双方内容', 'workspace-conflict', 'small', '', `id="workspace-conflict-trigger" ${entry.conflict ? '' : 'hidden'}`)}${workspaceAutosave.latestBackup(entry) ? button('导出最近冲突备份', 'workspace-backup', 'small', 'download') : ''}${reportTab !== 'draft' ? button('查看草稿', 'report-tab', 'small', 'file', 'data-tab="draft"') : ''}${button('保存回答与草稿', 'expert-save', 'small', 'check')}</div></div>`;
}
function renderReport(report, resume) {
  if (!report.expert) return renderDiagnosisReport(report, resume);
  const w = working(report), answered = Object.values(w.answers).filter(x => x.trim()).length;
  return `<div class="flow-header"><div class="flow-meta"><span>${e(reportTabs[reportTab])}</span><small>${answered} 项回答 · ${(w.applied || []).length} 项已采纳</small></div></div>${workflowNotice(report)}${analysisStatusHTML()}${reportTab === 'diagnosis' ? renderDiagnosisReport(report, resume) + workspaceSaveControls(report) : renderExpertPanel(report, resume)}`;
}
function fitResumePreviews() {
  document.querySelectorAll('.resume-preview').forEach(frame => {
    const paper = frame.querySelector('.resume-paper');
    if (!paper || !frame.clientWidth) return;
    const style = getComputedStyle(frame);
    const width = frame.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    paper.style.zoom = String(Math.min(1, width / 794));
  });
}
window.addEventListener('resize', fitResumePreviews);
function resumePaper(text) {
  const sourceLines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const sectionNames = [
    ['个人信息|基本信息|联系方式', 'Personal information'], ['教育背景|教育经历|Education', 'Educational background'],
    ['工作经历|工作经验|Work Experience|Experience', 'Work experience'], ['实习经历|实习经验', 'Internship experience'],
    ['项目经历|项目经验|Projects', 'Project experience'], ['校园经历|社团经历', 'Campus experience'],
    ['科研经历|研究经历|学术经历', 'Research experience'], ['实践经历|社会实践', 'Practical experience'],
    ['个人能力|专业技能|个人技能|技能清单|技能专长|技能与能力|技能特长|技能|Skills', 'Skills'],
    ['资格证书|持有证书|Certifications', 'Certificate'], ['荣誉奖项|奖项荣誉|获奖情况|获奖经历|荣誉|Awards', 'Honors and awards'],
    ['荣誉技能|荣誉与技能|荣誉及技能', 'Honors and skills'],
    ['论文|论文成果|论文与成果|论文发表|Publications', 'Publications'], ['竞赛经历', 'Competition experience'],
    ['自我评价', 'Self-evaluation'], ['个人简介|个人优势|Summary', 'Profile'], ['兴趣爱好', 'Interests'], ['求职意向', 'Career objective'],
  ];
  const inline = value => e(value).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/^(项目描述|项目职责|项目成果|项目背景|主要职责|获得荣誉|语言技能|个人优势|主修课程)([:：])/, '<strong class="resume-inline-label">$1$2</strong>');
  const cleanLine = value => value.trim().replace(/^#{1,6}\s*/, '').replace(/^\*\*(.+)\*\*$/, '$1');
  const fields = ['姓名', '性别', '籍贯', '出生年月', '出生日期', '年龄', '电话', '手机号码', '手机', '邮箱', '电子邮箱', '毕业院校', '毕业学校', '学历', '专业', '现居', '居住地', '现住址', '地址', '政治面貌', '爱好'];
  const fieldPattern = fields.join('|'), field = new RegExp(`^(?:${fieldPattern})\\s*[:：]`);
  const fieldLabels = new RegExp(`(${fields.map(name => [...name].join('[ \\t]*')).join('|')})[ \\t]*([:：])`, 'g');
  const normalizeFields = value => value.replace(fieldLabels, (_, label) => label.replace(/[ \t]/g, '') + '：');
  const chineseSections = sectionNames.flatMap(([names]) => names.split('|')).filter(name => /^[\p{Script=Han}]+$/u.test(name)).sort((a, b) => b.length - a.length);
  const trailingSection = new RegExp(`^(.+?)(${chineseSections.map(name => [...name].join('[ \\t]*')).join('|')})[ \\t]*$`);
  // PDF columns sometimes append a letter-spaced heading to the preceding line.
  // Only split a suffix with layout clues, never an ordinary mention in prose.
  const lines = sourceLines.flatMap(raw => {
    if (chineseSections.includes(cleanLine(raw).replace(/[ \t:：]/g, ''))) return [raw];
    const match = raw.match(trailingSection);
    if (match && ((match[2].match(/[ \t]+/g) || []).length >= 2 || /[ \t]{2,}$/.test(match[1]) || /@[^\s]+\s*$/.test(match[1]))) return [match[1].trimEnd(), match[2]];
    return [raw];
  });
  const dateRange = /\d{4}(?:[.\/-]\d{1,2}|年\d{1,2}[月日])?\s*(?:[-—–~～至]|到)\s*(?:\d{4}(?:[.\/-]\d{1,2}|年\d{1,2}[月日])?|至今|现在|present)/i;
  const groups = [], personal = [], intro = { title: '', english: '', items: [] };
  let current = intro, first = true, objective = '', separated = false;
  for (const raw of lines) {
    const line = raw.trim(), clean = cleanLine(line), compact = clean.replace(/[ \t:：]/g, '').toLowerCase();
    if (!line) { separated = true; continue; }
    if (/^(?:个人简历|简历|PERSONAL RESUME|RESUME)$/i.test(clean)) continue;
    const section = sectionNames.find(([names, english]) => names.split('|').some(name => compact === name.replace(/ /g, '').toLowerCase() || compact === (name + english).replace(/ /g, '').toLowerCase()));
    if (section || /^#{1,2}[^#]/.test(line) && !first) {
      const sectionTitle = section?.[0].split('|').find(name => compact === name.replace(/ /g, '').toLowerCase() || compact === (name + section[1]).replace(/ /g, '').toLowerCase());
      current = { title: sectionTitle || clean, english: section?.[1] || '', items: [] };
      groups.push(current); first = false; separated = true; continue;
    }
    if (/^求职意向\s*[:：]/.test(clean) && !objective) { objective = clean; continue; }
    const inPersonal = current === intro || current.english === 'Personal information' || (!intro.items.length && groups.every(group => !group.items.length));
    const spacedName = /^[\p{Script=Han}][ \t]+[\p{Script=Han}](?:[ \t]*[\p{Script=Han}]){0,2}$/u.test(clean);
    if (inPersonal && !personal.some(value => /^姓名[:：]/.test(value)) && ((first && /^(?:[\p{Script=Han}·]{2,8}|[A-Za-z]+(?:[ .'-][A-Za-z]+){1,4})$/u.test(clean)) || spacedName)) {
      personal.unshift(`姓名：${spacedName ? clean.replace(/[ \t]/g, '') : clean}`); first = false; continue;
    }
    first = false;
    const normalized = inPersonal ? normalizeFields(clean) : clean;
    if (inPersonal && field.test(normalized)) {
      // Consume each complete label so 电子邮箱 is not split again at 邮箱.
      const starts = [...normalized.matchAll(new RegExp(`(?:${fieldPattern})[:：]`, 'g'))].map(match => match.index);
      personal.push(...starts.map((start, i) => normalized.slice(start, starts[i + 1]).replace(/^[ \t|｜·]+|[ \t|｜·]+$/g, '')).filter(Boolean));
      separated = true; continue;
    }
    const labeledProse = /^(?:项目背景|项目描述|项目职责|项目成果|主要职责|获得荣誉|语言技能|个人优势|主修课程)\s*[:：]/.test(clean);
    const bullet = line.match(/^(?:([-*])\s+|([•·□▪▫■●◦\uF0A7])\s*|(\d{1,2}[.、)）])\s*)(.+)$/), date = !labeledProse && clean.length < 200 && !/[。；;]/.test(clean) ? clean.match(dateRange) : null;
    const type = bullet ? 'bullet' : !labeledProse && (date || /^(?:\*\*.+\*\*|#{3,6}[^#].*)$/.test(line)) ? 'entry' : 'text';
    const value = bullet ? bullet[4] : line;
    const previous = current.items.at(-1);
    // Reflow only an unfinished prose line. Explicit paragraphs, labels, headings,
    // dated entries and separate bullet points stay separate; saved text is untouched.
    if (!separated && type === 'text' && previous && ['text', 'bullet'].includes(previous.type) && (previous.type === 'bullet' || previous.text.length >= 16) && !/[。！？.!?；;：:]$/.test(previous.text) && !/^[^:：]{1,12}[:：]/.test(clean)) {
      const space = /[\p{Script=Han}]$/u.test(previous.text) && /^[\p{Script=Han}，。；、]/u.test(value) ? '' : ' ';
      previous.text += space + value;
    } else current.items.push({ type, text: value, marker: bullet?.[3] || '•' });
    separated = false;
  }
  const heading = (title, english) => `<h2><span>${e(title)}</span>${english ? `<small>${e(english)}</small>` : ''}</h2>`;
  const renderItems = (items, section = '') => items.map((item, index) => {
    const value = cleanLine(item.text), date = value.match(dateRange);
    // A bold institution/role followed by a standalone date is one entry header.
    const next = items[index + 1], nextValue = next ? cleanLine(next.text) : '', nextDate = nextValue.match(dateRange);
    if (item.type === 'entry' && !date && nextDate?.[0] === nextValue) {
      item = { ...item, text: nextValue + ' | ' + value }; next.type = 'consumed';
    }
    if (item.type === 'consumed') return '';
    if (item.type === 'entry') {
      const clean = cleanLine(item.text), range = clean.match(dateRange);
      const remaining = range ? (clean.slice(0, range.index) + clean.slice(range.index + range[0].length)).replace(/\(\s*\)|（\s*）/g, '').replace(/^[\s|｜·]+|[\s|｜·]+$/g, '') : clean;
      let parts = remaining.split(/\s*[|｜]\s*|\s+·\s+|\s+\/\s*|\s{2,}/).filter(Boolean);
      if (parts.length === 1 && ['Educational background', 'Campus experience', 'Internship experience', 'Work experience'].includes(section)) {
        const columns = remaining.match(/^(.+)\s+([^\s]*(?:本科|硕士|博士|学士|专科|实习生|干部|部长|助理|成员|专员|经理|主席|干事))$/);
        if (columns) parts = [columns[1], columns[2]];
      }
      if (range && parts.length) return `<div class="resume-entry-row"><span class="resume-entry-date">${e(range[0])}</span><strong>${inline(parts[0])}</strong>${parts.length > 1 ? `<strong class="resume-entry-role">${inline(parts.slice(1).join(' · '))}</strong>` : ''}</div>`;
      return `<p class="resume-entry">${inline(cleanLine(item.text))}</p>`;
    }
    if (item.type === 'bullet') return `<p class="resume-bullet${item.marker !== '•' ? ' resume-numbered' : ''}"><span class="resume-bullet-mark" aria-hidden="true">${e(item.marker)}</span><span>${inline(item.text)}</span></p>`;
    return `<p>${inline(item.text)}</p>`;
  }).join('');
  const personalGroups = groups.filter(group => group.english === 'Personal information');
  const personalHTML = personal.length || personalGroups.length ? `<section class="resume-section resume-personal">${heading('个人信息', 'Personal information')}<div class="resume-info-grid">${personal.map(value => `<p>${inline(value)}</p>`).join('')}</div>${personalGroups.map(group => renderItems(group.items)).join('')}</section>` : '';
  const html = `<header class="resume-masthead"><p class="resume-lead">个人简历</p>${objective ? `<p class="resume-objective">${e(objective)}</p>` : ''}<span class="resume-english-title">PERSONAL RESUME</span></header>${personalHTML}${renderItems(intro.items)}${groups.filter(group => group.english !== 'Personal information').map(group => `<section class="resume-section">${heading(group.title, group.english)}${renderItems(group.items, group.english)}</section>`).join('')}`;
  return `<article class="resume-paper" aria-label="简历排版预览">${String(text || '').trim() ? html : '<p class="resume-empty">尚未填写草稿。</p>'}</article>`;
}
function structuredDraftNotice(report, workspace) {
  const structure = report.expert?.structure;
  let message;
  if (state.capabilities?.structuredResume !== 5) message = '当前后台未加载最新简历优化规则。请退出并重新启动工作台，再刷新页面；只刷新页面不会更新后台。';
  else if (!structure) message = '这份报告尚未按三段式重组。生成后，每段项目、实习等经历会统一为项目背景、项目职责、项目成果。';
  else if (structure.readyCount !== structure.experienceCount) message = '三段式改写尚未完成，当前保留已有内容。' + (report.reviewProcess?.error ? `原因：${report.reviewProcess.error}` : '部分经历未通过核查，请继续生成或补充事实。');
  else if (!structure.experienceCount) message = '未识别到可重组的经历。请核对原文中的项目经历、实习经历等章节与经历标题。';
  else if (workspace.generatedDraftHash) message = `已生成 ${structure.readyCount} 段三段式经历。请核对事实；手动修改的内容需本人确认。`;
  else message = '三段式改写已通过核查，当前保留你的手动草稿。可在“查看完整定向稿”中查看新稿并另存，或逐项采纳修改。';
  if (structure?.experienceCount > 0 && structure.readyCount === structure.experienceCount && report.reviewProcess?.failedStage === 'diagnosis') message += ' 岗位诊断尚未完成，暂不提供匹配评分；不影响已核查的三段式正文。';
  return `<div class="callout structured-draft-status"><p>${e(message)}</p>${button(structure ? '重新生成三段式简历' : '生成三段式简历', 'expert-generate', 'primary', 'spark')}<p class="muted meta">${aiDestinationDisclosure()}</p></div>`;
}
function renderExpertPanel(report, resume) {
  const expert = report.expert, w = working(report), jd = expert.jdAnalysis;
  const items = w.optimizedItems || expert.optimizedItems;
  const showingAIRewrite = reportTab === 'optimize' && w.optimization?.engine === 'ai';
  const panelMode = showingAIRewrite ? 'AI 改写建议' : expert.engine === 'ai' ? 'AI 扩展分析' : '本地辅助流程';
  const panelNote = showingAIRewrite ? `当前建议由 ${w.optimization.model || '已配置模型'} 生成${w.optimization.targeted ? '，对应本报告的岗位 JD' : ''}，核对后逐条采纳。` : expert.note;
  const bulletList = values => values.length ? `<ul class="strength-list">${values.map(x => `<li>${e(x)}</li>`).join('')}</ul>` : '<p class="muted">暂无可用内容。</p>';
  let content = '';
  if (reportTab === 'match') {
    content = `${matchScoreHTML(report)}<h3>目标岗位 · ${e(report.target?.title || '通用评审')}</h3>${report.target?.description ? `<details class="source-jd"><summary>查看分析时的岗位描述</summary><p class="preserve">${e(report.target.description)}</p></details>` : '<div class="callout">尚未提供具体 JD。请发起新评审，并粘贴本次公司的岗位 JD。</div>'}<div class="jd-summary-grid"><div><div class="section-label">主要职责</div>${bulletList(jd.responsibilities)}</div><div><div class="section-label">明确要求</div>${bulletList(jd.hardRequirements)}</div></div>${jd.keywords.length ? `<div class="tags">${jd.keywords.map(k => `<span class="badge neutral">${e(k)}</span>`).join('')}</div>` : ''}<div class="section-label">岗位要求与简历证据</div>${expert.matchItems.length ? `<div class="table-scroll" tabindex="0" role="region" aria-label="岗位要求与简历证据"><table class="review-table match-table"><thead><tr><th scope="col">岗位要求</th><th scope="col">简历证据</th><th scope="col">证据情况</th><th scope="col">改进建议</th></tr></thead><tbody>${expert.matchItems.map(m => `<tr><th scope="row">${e(m.jdRequirement)}${m.jdEvidence ? `<p class="jd-evidence">JD 原文：${e(m.jdEvidence)}</p>` : ''}</th><td class="preserve">${e(m.resumeEvidence || '未找到可核验的原文引用')}</td><td><span class="badge ${m.resumeEvidence && !['conflict', 'unknown'].includes(m.eligibility) ? '' : 'amber'}">${m.eligibility === 'conflict' ? '材料明确冲突' : m.eligibility === 'unknown' ? '材料未说明' : m.eligibility === 'supported' ? '资格有证据支持' : expert.engine === 'local' ? (m.resumeEvidence ? '出现关键词' : '未出现') : ({ strong: '较强证据', medium: '部分证据', weak: '证据较弱', none: '缺少证据' })[m.evidenceStrength]}</span></td><td class="preserve">${e(reviewExplanation(m.optimizationSuggestion))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">未生成匹配项。本地模式可在本次评审填写关注关键词，AI 模式会结合具体 JD 分析。</p>'}`;
  } else if (reportTab === 'followup') {
    content = `<h3>把真实经历补充完整</h3><p class="muted">回答会随报告保存在本机。保存后，可在“修改对照”中更新诊断、匹配评分和改写。没有或不确定可如实说明，也可跳过。</p>${expert.followUpQuestions.map((q, i) => `<article class="question-card"><span class="eyebrow">追问 ${i + 1}</span><h3>${e(q.question)}</h3><p class="muted">${e(q.purpose)}</p>${requirementEvidence(q)}<div class="field"><label for="answer-${i}">你的回答</label><textarea id="answer-${i}" data-answer="${e(q.id)}" maxlength="3000" placeholder="写清背景、自己的行动、方法、结果与依据；不确定的事实可以说明。">${e(w.answers[q.id] || '')}</textarea></div></article>`).join('') || '<p class="muted">这份报告未产生追问。</p>'}`;
  } else if (reportTab === 'optimize') {
    content = `<h3>逐条比较，再决定采纳</h3><p class="muted">可以直接编辑表格中的建议。含待补充内容时，点击“补充后采纳”填写真实信息；采纳后在“简历定稿”查看。</p><div class="optimize-toolbar"><div class="field"><label for="optimize-style">改写风格</label><select id="optimize-style"><option value="concise" ${w.style === 'concise' ? 'selected' : ''}>简洁清晰</option><option value="evidence" ${w.style === 'evidence' ? 'selected' : ''}>突出行动与证据</option><option value="restrained" ${w.style === 'restrained' ? 'selected' : ''}>克制表达、降低夸张</option></select></div>${button(report.reviewProcess?.version === 3 ? '更新诊断、评分与改写' : '结合回答生成 AI 改写', 'expert-generate', '', 'spark')}</div><p class="muted meta">${aiDestinationDisclosure()}</p>${withheldHTML(report)}${items.length ? `<div class="table-scroll" tabindex="0" role="region" aria-label="修改对照汇总"><table class="review-table optimize-table"><thead><tr><th scope="col">修改前</th><th scope="col">建议表达（可编辑）</th><th scope="col">修改理由与核实事项</th><th scope="col">采纳状态</th></tr></thead><tbody>${items.map((item, i) => `<tr><td class="preserve">${e(item.before)}</td><td><div class="field"><label class="sr-only" for="rewrite-${i}">第 ${i + 1} 项建议表达</label><textarea id="rewrite-${i}" data-rewrite="${i}" maxlength="5000" aria-describedby="adoption-${i}">${e(w.edits?.[i] ?? item.after)}</textarea></div></td><td>${requirementEvidence(item)}<p class="preserve">${e(reviewExplanation(item.reason))}</p><p class="risk-note">${e(item.riskWarning || '请本人核对事实、数字和责任归属。')}</p></td><td id="adoption-${i}" aria-live="polite">${adoptionCell(item, i, w)}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty-list">${e(w.optimization?.noRewriteReason || expert.noRewriteReason || '暂无改写项。可以直接编辑定稿，或结合补充回答生成 AI 改写。')}</div>`}`;
  } else if (reportTab === 'draft') {
    const gaps = items.filter(item => item.missingFields?.length);
    content = `${structuredDraftNotice(report, w)}${gaps.length ? `<div class="callout">有 ${gaps.length} 段经历仍需补充真实信息：${e([...new Set(gaps.flatMap(item => item.missingFields))].join('、'))}。相应标签暂时留空，可在文字版中补充后再导出。</div>` : ''}${w.generatedDraftHash ? '<p class="muted">已按完整经历整理为三段式，并合入通过核查的修改；请核对后使用。</p>' : ''}${w.draft === report.sourceText && !(w.applied || []).length ? `<div class="callout draft-unapplied">当前显示的是分析时的原文，尚未完成三段式重组。请点击上方“生成三段式简历”。${button('查看修改对照', 'report-tab', 'small', 'edit', 'data-tab="optimize"')}</div>` : ''}<div class="draft-toolbar"><div><h3>${w.draft === report.sourceText && !w.applied?.length ? '原文预览（尚未生成优化稿）' : '简历预览'}</h3><p class="muted">A4 纵向 · 黑白经典</p></div><div class="actions">${button('打印 / 另存 PDF', 'print-draft', '', 'file')}${button('导出草稿 TXT', 'expert-export', '', 'download')}${button('另存为新简历', 'expert-copy', 'primary', 'plus')}</div></div><div class="resume-preview" id="resume-preview">${resumePaper(w.draft)}</div><details class="draft-text-panel"><summary>编辑文字版</summary><div class="field"><label for="expert-draft">优化草稿（修改后实时更新排版预览）</label><textarea id="expert-draft" class="draft-editor" maxlength="120000">${e(w.draft)}</textarea></div></details><div class="draft-comparison"><details><summary>对照分析时的原文 · v${report.revision}</summary><pre>${e(report.sourceText)}</pre></details></div>`;

  } else if (reportTab === 'interview') {
    content = `<h3>把写进简历的经历讲清楚</h3><p class="muted">根据最终选定的草稿和本人事实生成；编辑草稿后应重新生成。</p>${report.reviewProcess?.version === 3 ? button(expert.interviewPrep.length ? '重新生成面试准备' : '生成面试准备', 'expert-interview', '', 'spark') + `<p class="muted meta">${aiDestinationDisclosure()}</p>` : ''}${expert.interviewPrep.length ? `<div class="table-scroll" tabindex="0" role="region" aria-label="面试准备汇总"><table class="review-table interview-table"><thead><tr><th scope="col">面试问题</th><th scope="col">回答思路</th><th scope="col">建议准备的材料</th></tr></thead><tbody>${expert.interviewPrep.map((q, i) => `<tr><th scope="row"><span class="table-index">${i + 1}</span>${e(q.question)}</th><td class="preserve">${e(q.approach)}</td><td>${bulletList(q.evidence)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">这份报告未生成面试准备内容。</p>'}`;
  }
  return `<div class="report expert-panel">${reportTab === 'draft' ? '' : `<div class="report-top"><span class="badge">${e(panelMode)}</span><span class="meta muted">${fmtDate(report.createdAt)}</span></div><p class="report-notice">${e(panelNote)}</p>`}${report.revision !== resume.revision ? '<div class="callout">这是旧文字版本的报告与独立草稿。重新分析可基于最新原文生成新报告。</div>' : ''}${['optimize', 'draft'].includes(reportTab) && canPreviewTargeted(report) ? `<div class="callout">查看已合入修改的完整优化稿，核对后可另存为独立简历。手动草稿不会被替换。${button('查看完整定向稿', 'targeted-preview', 'primary', 'file')}</div>` : ''}${content}${workspaceSaveControls(report)}<div class="report-actions">${button('导出完整报告', 'export-report', 'small', 'download')}</div><details class="report-history"><summary>报告历史（${resume.reports.length} 次）</summary>${resume.reports.map(a => `<div class="history-row"><span>${fmtDate(a.createdAt)} · v${a.revision} · ${a.engine === 'ai' ? 'AI' : '基础'}</span><button type="button" class="text-link" data-action="view-report" data-report="${a.id}">查看</button></div>`).join('')}</details></div>`;
}
function pendingPlaceholders(text) {
  return [...new Set(String(text).match(/\[(?:待补充|实际|真实|具体|可验证)[^\]]*\]/g) || [])];
}
function fillPlaceholders(text, values) {
  const tokens = pendingPlaceholders(text);
  if (tokens.length !== values.length || values.some(value => !value.trim())) throw new Error('请填写每一项真实信息；不适用的内容可取消后在建议表达中修改。');
  const replacements = new Map(tokens.map((token, i) => [token, values[i].trim()]));
  const result = text.replace(/\[(?:待补充|实际|真实|具体|可验证)[^\]]*\]/g, token => replacements.get(token));
  if (pendingPlaceholders(result).length) throw new Error('补充内容仍含占位符，请改为已核实的事实。');
  if (result.length > 5000) throw new Error('补充后的建议不能超过 5000 字。');
  return result;
}
function adoptionCell(item, index, workspace) {
  const after = workspace.edits?.[index] ?? item.after;
  const applied = (workspace.applied || []).some(change => change.before === item.before && workspace.draft.includes(change.after));
  const tokens = pendingPlaceholders(after);
  const same = after.trim() === item.before.trim();
  const disabled = !item.verified || applied || same || !after.trim();
  const auditNote = item.auditStatus === 'pass' ? after !== item.after ? '用户修改，未重新核查；本人确认后可采纳。' : '独立核查通过，仍请本人核对事实。' : '请核对事实后采纳。';
  const note = applied ? '已保存到本报告草稿，可在简历定稿中查看。' : !item.verified ? '原文或岗位要求依据未通过核对，请在定稿中手动编辑。' : same ? '与原文相同，无需采纳。' : !after.trim() ? '请填写建议表达。' : tokens.length ? `还有 ${tokens.length} 项待补充：${tokens.join('、')}` : auditNote;
  return `<p class="adoption-note ${tokens.length && !applied ? 'risk-note' : ''}">${e(note)}</p>${button(applied ? '已采纳' : tokens.length ? '补充后采纳' : '采纳到草稿', 'expert-apply', 'small', 'check', `data-index="${index}" ${disabled ? 'disabled' : ''}`)}`;
}
function placeholderDialog(report, index, after) {
  const tokens = pendingPlaceholders(after);
  modal('补充真实信息后采纳', `<form id="placeholder-form" data-report="${report.id}" data-index="${index}"><p>建议中还有未填写的内容。填写你能确认的事实后再采纳；不适用的部分，请取消并在表格中修改整句。</p>${tokens.map((token, i) => `<div class="field"><label for="placeholder-${i}">${e(token.slice(1, -1))}</label><textarea id="placeholder-${i}" name="${i}" required maxlength="3000" placeholder="只填写真实信息，不确定时不要编造"></textarea></div>`).join('')}<div class="inline-error" role="alert"></div><div class="form-actions">${button('返回修改整句', 'close-modal')}<button type="submit" class="btn primary">填写完成并采纳</button></div></form>`);
}
function aiDestinationDisclosure() {
  let host = ''; try { host = new URL(state.settings.baseUrl).host; } catch {}
  return host && state.settings.model ? `点击生成会将本报告原文、岗位描述和已保存的补充回答发送至 ${e(host)}（${e(state.settings.model)}）。${state.settings.redact !== false ? '常见联系方式会先隐藏。' : '当前未隐藏联系方式。'}` : 'AI 改写需要先在分析设置中配置模型。当前可手动填写模板、采纳和导出。';
}
async function saveWorkspace() {
  const report = currentReport();
  if (report?.expert) await workspaceAutosave.save(workspaceAutosave.get(selectedId, report));
}
function workspaceConflictDialog() {
  const report = currentReport(), entry = workspaceAutosave.get(selectedId, report);
  if (!entry.conflict) return;
  const local = entry.workspace, remote = entry.conflict.remote;
  const suggestionsChanged = JSON.stringify(entry.base.optimizedItems) !== JSON.stringify(remote.optimizedItems);
  const compare = (label, left, right) => `<section class="workspace-comparison"><h3>${e(label)}</h3><div class="field-row"><div class="field"><label>本地内容</label><textarea readonly aria-label="${e(label)} · 本地内容">${e(left)}</textarea></div><div class="field"><label>服务器版本 ${remote.version}</label><textarea readonly aria-label="${e(label)} · 服务器内容">${e(right)}</textarea></div></div></section>`;
  const answerRows = report.expert.followUpQuestions.filter(q => (local.answers[q.id] || '') !== (remote.answers[q.id] || '')).map(q => compare(q.question, local.answers[q.id] || '', remote.answers[q.id] || '')).join('');
  const editIndices = [...new Set([...Object.keys(local.edits || {}), ...Object.keys(remote.edits || {})])];
  const editRows = editIndices.filter(i => local.edits?.[i] !== remote.edits?.[i]).map(i => compare(`第 ${Number(i) + 1} 项建议编辑`, local.edits?.[i] || '', remote.edits?.[i] || '')).join('');
  modal('核对草稿版本冲突', `<div id="workspace-conflict"><p>另一窗口或上次保存已更新这份报告。双方内容均保留在这里；可以返回当前草稿手动整理，再决定保存哪个版本。</p><p>选择版本前，会在此浏览器保留双方备份；也可以导出 JSON 文件自行保存。</p>${suggestionsChanged ? '<div class="callout">服务器的修改建议已重新生成。保存本地版本时，只采用本地草稿和回答，修改建议采用服务器新版；旧建议编辑仍保留在双方备份中。</div>' : ''}${compare('简历草稿', local.draft, remote.draft)}${answerRows}${editRows}<div class="inline-error" role="alert"></div><div class="form-actions">${button('导出双方备份', 'workspace-backup')}${button('返回草稿继续整理', 'close-modal')}${button('使用服务器版本', 'workspace-use-server')}${button(suggestionsChanged ? '保存本地草稿与回答' : '保留本地版本并保存', 'workspace-use-local', 'primary')}</div></div>`);
}
async function workspaceAction(action) {
  const report = currentReport(); if (!report?.expert) return;
  const entry = workspaceAutosave.get(selectedId, report);
  if (action === 'workspace-backup') {
    const backup = entry.conflict ? workspaceAutosave.conflictBackup(entry) : workspaceAutosave.latestBackup(entry);
    if (!backup) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `草稿冲突备份-${report.id}.json`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); entry.downloadedBackup = true; return;
  }
  if (!entry.conflict) return;
  if (action === 'workspace-conflict') { workspaceConflictDialog(); return; }
  if (!['workspace-use-server', 'workspace-use-local'].includes(action)) return;
  pendingMutations++; $('#main').inert = true; $('#modal').inert = true;
  try {
    await workspaceAutosave.resolve(entry, action === 'workspace-use-server' ? 'server' : 'local');
    $('#modal').close(); render(); toast('已采用所选版本，双方内容备份保留在此浏览器。');
  } catch (error) { if (entry.conflict) workspaceConflictDialog(); $('#workspace-conflict .inline-error').textContent = error.message; }
  finally { if (--pendingMutations === 0) { $('#main').inert = false; $('#modal').inert = false; } }
}
async function expertAction(action, element) {
  if (dirty) { toast('请先保存左侧原文修改，再操作优化草稿。'); return; }
  const report = currentReport(), id = selectedId;
  if (!report?.expert) return;
  if (action === 'expert-generate' && state.capabilities?.structuredResume !== 5) { toast('当前后台尚未加载最新简历优化规则，请退出并重新启动工作台，再刷新页面。未发起旧流程。', true); return; }
  const index = Number(element.dataset.index), style = $('#optimize-style')?.value || working(report).style;
  if (['expert-generate', 'expert-interview'].includes(action) && (state.settings.enabled === false || state.local?.model?.enabled === false)) { toast('AI 已关闭，请先在本地设置中启用 AI。', true); return; }
  if (['expert-generate', 'expert-interview'].includes(action) && (!state.settings.baseUrl || !state.settings.model)) { toast('请先配置 AI 模型；已填写的内容可以先保存。', true); return; }
  if (action === 'expert-apply') { const w = working(report), item = (w.optimizedItems || report.expert.optimizedItems)[index]; const after = w.edits?.[index] ?? item?.after ?? ''; if (pendingPlaceholders(after).length) { placeholderDialog(report, index, after); return; } }
  pendingMutations++; $('#main').inert = true; $('#modal').inert = true;
  try { await saveWorkspace(); }
  finally { if (--pendingMutations === 0) { $('#main').inert = false; $('#modal').inert = false; } }
  const w = working(currentReport());
  if (action === 'expert-save') { render(); toast('回答与草稿已保存。'); return; }
  if (action === 'expert-export') { const link = document.createElement('a'); link.href = `/api/resumes/${id}/draft?id=${report.id}`; document.body.append(link); link.click(); link.remove(); render(); return; }
  const endpoint = { 'expert-apply': 'apply', 'expert-generate': 'optimize', 'expert-copy': 'copy', 'expert-interview': 'interview' }[action];
  if (!endpoint) return;
  const payload = { reportId: report.id, workspaceVersion: w.version, style };
  if (endpoint === 'apply') { payload.index = index; payload.after = w.edits?.[index] ?? (w.optimizedItems || report.expert.optimizedItems)[index]?.after; }
  toast(endpoint === 'optimize' ? '正在结合补充回答生成改写…' : '正在保存…');
  const stopStatus = ['optimize', 'interview'].includes(endpoint) ? startAnalysisStatus(id) : () => {};
  let result;
  try { result = ['optimize', 'interview'].includes(endpoint) ? await reviewRequest(id, endpoint, payload) : await api(`/api/resumes/${id}/${endpoint}`, { method: 'POST', body: JSON.stringify(payload) }); }
  finally { stopStatus(); }
  replaceResume(result.resume); workspaceAutosave.reset(report.id);
  if (endpoint === 'copy') { await go('document', result.resume.id); toast(result.duplicate ? '已有相同内容的简历，已打开。' : '已另存为新简历，原简历保留。'); }
  else { render(); toast(endpoint === 'apply' ? '已采纳到独立草稿，可在“简历定稿”中查看。' : endpoint === 'interview' ? '面试准备已保存。' : '评审结果已保存，请查看当前完成状态并核对修改。'); }
}
function renderDiagnosisReport(report, resume) {
  const changed = report.revision !== resume.revision;
  return `<div class="report"><div class="report-top"><span class="badge">${report.engine === 'ai' ? 'AI 深度评审' : '本地基础检查'}</span><span class="meta muted">${fmtDate(report.createdAt)}</span></div>${changed ? '<div class="callout">这份报告基于旧文字版本，请重新分析以匹配最新内容。</div>' : ''}<p class="report-summary">${e(reviewExplanation(report.summary))}</p><div class="checks">${report.checks.map(c => `<span class="check-chip ${c.present ? '' : 'missing'}">${c.present ? '✓' : '○'} ${e(c.label)}</span>`).join('')}</div><div class="section-label">${icon('check')}值得保留</div><ul class="strength-list">${report.strengths.map(s => `<li>${e(s)}</li>`).join('')}</ul>${targetFitHTML(report)}<div class="section-label">${icon('edit')}修改建议 <span class="badge neutral">${report.suggestions.length}</span></div>${report.suggestions.length ? `<div class="table-scroll" tabindex="0" role="region" aria-label="诊断修改建议汇总"><table class="review-table diagnosis-table"><thead><tr><th scope="col">优先级 / 修改点</th><th scope="col">原文依据</th><th scope="col">修改意见</th><th scope="col">表达参考</th></tr></thead><tbody>${report.suggestions.map(s => `<tr><th scope="row"><span class="priority ${s.priority !== 'high' ? 'medium' : ''}">${s.priority === 'high' ? '优先修改' : s.priority === 'low' ? '可选优化' : '建议优化'}</span><p>${e(s.title)}</p></th><td class="preserve">${e(s.evidence || '未提供原文引用')}</td><td class="preserve">${e(reviewExplanation(s.advice))}</td><td class="preserve">${e(s.rewrite || '—')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">本次未产生进一步建议，可补充具体岗位描述后再次分析。</p>'}<p class="report-notice">${report.engine === 'ai' ? `模型：${e(report.model)} · ` : ''}文字版本 ${report.revision} · 报告不代表录用概率，未检查原文件视觉排版。</p><div class="report-actions">${button('导出报告', 'export-report', 'small', 'download')}${button('导出当前文字', 'export-text', 'small', 'note')}</div>${resume.reports.length > 1 ? `<details class="report-history"><summary>历史报告（最近 ${resume.reports.length} 次）</summary>${resume.reports.map(a => `<div class="history-row"><span>${fmtDate(a.createdAt)} · v${a.revision} · ${a.engine === 'ai' ? 'AI' : '基础'}</span><button class="text-link" data-action="view-report" data-report="${a.id}">查看</button></div>`).join('')}</details>` : ''}</div>`;
}
let jobSearch = { q: '', archived: '' }, applicationSearch = { q: '', status: '', due: '' }, sourcePreview = [];
const recruitmentForms = '<div class="inline-error" role="alert"></div><div class="form-actions">' + button('取消', 'close-modal') + '<button type="submit" class="btn primary">保存</button></div>';
function isWechatContactLink(value) {
  try {
    const url=new URL(value);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return false;
    // Verified shared contact shortlink; don't classify every WeChat article or short URL.
    return (url.hostname==='hm.wshotoai.cn' && url.pathname==='/d/usak76') ||
      (url.hostname==='hm.weshineai.cn' && url.pathname==='/wx-app/index.html' && new URLSearchParams(url.hash.split('?')[1]).get('type')==='staff');
  } catch {return false;}
}
function officialRecruitmentSearch(job={}) {
  const company=(job.company||job.announcement||job.title||'').trim().slice(0,160);
  return company ? 'https://www.bing.com/search?q='+encodeURIComponent(company+' 校园招聘 官方网站') : '';
}
function platformSourceForURL(value) {
  try {
    const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port)return null;
    const key=u.hostname==='www.zhipin.com'&&u.pathname.startsWith('/job_detail/')?'boss':(['www.zhaopin.com','jobs.zhaopin.com','xiaoyuan.zhaopin.com'].includes(u.hostname)&&(/jobdetail|\.html?$|\/job\//i.test(u.pathname)))?'zhilian':(u.hostname==='jobs.51job.com'&&/^\/[^/]+\/\d+\.html$/.test(u.pathname))||(u.hostname==='we.51job.com'&&u.pathname.startsWith('/pc/jobdetail'))?'51job':'';
    return key&&(state.jobSources||[]).find(s=>s.platform===key);
  }catch{return null;}
}
const sourceLink = (url, label = '打开原岗位', job={}) => !url ? '<span class="muted">未提供投递链接</span>' : isWechatContactLink(url)
  ? button('微信联系入口','job-wechat-link','small','','data-url="'+e(url)+'" data-company="'+e(job.company||job.announcement||job.title||'')+'"')
  : state.capabilities?.platformJobOpen && platformSourceForURL(url)?.platform === 'boss' ? button(label||'查看并投递','source-open-job','small','external',`data-id="${e(platformSourceForURL(url).id)}" data-url="${e(url)}"`)
  : `<a class="btn small" href="${e(url)}" target="_blank" rel="noopener noreferrer" title="在当前浏览器新标签页打开，使用当前浏览器的登录状态">${icon('external')}${e(label)}</a>`;
const currentAnnouncement = job => (state.announcements||[]).find(a=>a.id===job.announcementId) || {title:job.announcement||job.title,url:job.announcementUrl};
function jobLinkCell(job) {
  const url=currentAnnouncement(job).url||(job.announcementId?'':job.url)||'';
  const search=officialRecruitmentSearch(job);
  const original=!url ? '未提供' : isWechatContactLink(url)
    ? sourceLink(url,'',job)+'<small class="muted link-domain">需手机微信 · 非招聘公告</small>'
    : state.capabilities?.platformJobOpen && platformSourceForURL(url) ? sourceLink(url,'查看并投递',job)
    : `<a class="job-announcement-link" href="${e(url)}" target="_blank" rel="noopener noreferrer">查看公告 ↗</a><small class="muted link-domain">${e(new URL(url).hostname)}</small>`;
  return original+(search?`<div class="link-domain"><a class="job-announcement-link" href="${e(search)}" target="_blank" rel="noopener noreferrer" title="搜索官方招聘网站">查找官方招聘 ↗</a></div>`:'');
}
const terminalStatus = status => ['offer', 'rejected', 'withdrawn'].includes(status);
const applicationDue = app => !terminalStatus(app.status) && app.nextActionAt && new Date(app.nextActionAt) <= new Date();
const dateTimeField = value => { if (!value) return ''; const d = new Date(value); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
function recruitmentUnavailable() { return !state.capabilities?.recruitment ? '<div class="callout">新版岗位功能需要重启工作台服务后使用。现有简历功能不受影响。</div>' : ''; }
let wechatCandidates = [], wechatInboxStatus = 'imported';
function wechatCard(source) {
  const s=(state.wechat?.sources || []).find(x=>x.id===source.id) || source;
  return `<section class="panel source-card"><div class="source-top"><h2>${e(s.name)}</h2><span class="badge ${s.lastError?'amber':'neutral'}">${s.running?'正在采集':s.enabled?'每日自动采集':'已暂停'}</span></div><p>每天 ${e(s.dailyTime)}（北京时间） · 每批最多 ${s.limit} 条消息</p><p class="muted">岗位：${e(s.keyword || '不限')} · 地点：${e(s.location || '不限')}</p><p>${e(s.lastResult)}</p>${s.warning?`<p class="risk-note">${e(s.warning)}</p>`:''}${wechatCoverageHTML(s)}<small class="muted">上次检查：${s.lastCheckedAt?e(new Date(s.lastCheckedAt).toLocaleString('zh-CN')):'尚未采集'}<br>下次采集：${s.nextRunAt?e(new Date(s.nextRunAt).toLocaleString('zh-CN')):'已暂停'}</small><div class="actions">${button(s.lastError?'重试采集':s.lastCoverage?.hasMore?'继续补读':'立即采集','wechat-pull','small primary','download',`data-id="${s.id}" ${s.running?'disabled':''}`)}${button('配置 / 暂停','wechat-edit','small','settings',`data-id="${s.id}"`)}${button('查看消息','wechat-inbox','small','file')}</div></section>`;
}
function wechatDialog(source = {}) {
  modal(source.id?'配置微信群采集':'添加微信群',`<form id="wechat-source-form" data-id="${source.id || ''}" data-revision="${source.revision || 1}"><p>只读取指定群的消息。已授权的本地数据库采集不占用微信窗口；请保持工作台运行，并让微信及时同步消息。新增群须先初始化本地授权；未启用数据库的界面采集仍需桌面解锁。</p><div class="field"><label for="wechat-group">微信群完整名称</label><input id="wechat-group" name="group" required maxlength="100" value="${e(source.group)}" placeholder="与微信内显示的名称一致"></div><div class="field-row"><div class="field"><label for="wechat-time">每日时间（北京时间）</label><input id="wechat-time" name="dailyTime" type="time" required value="${e(source.dailyTime || '09:00')}"></div><div class="field"><label for="wechat-limit">每批最多读取消息条数</label><input id="wechat-limit" name="limit" type="number" min="20" max="2000" required value="${source.limit || 500}"></div></div><div class="field"><label for="wechat-keyword">岗位关键词（选填）</label><input id="wechat-keyword" name="keyword" maxlength="300" value="${e(source.keyword)}" placeholder="多个词用逗号分隔，匹配任一词；留空不限"></div><div class="field"><label for="wechat-location">地点关键词（选填）</label><input id="wechat-location" name="location" maxlength="200" value="${e(source.location)}" placeholder="多个地点用逗号分隔，留空不限"></div><div class="field"><label for="wechat-exclude">排除关键词（选填）</label><input id="wechat-exclude" name="exclude" maxlength="300" value="${e(source.exclude)}"></div><div class="field"><label><input name="enabled" type="checkbox" ${source.enabled!==false?'checked':''}>每天自动采集并筛选去重</label></div><p class="report-notice">新来源从明天开始自动采集，可先点击“立即采集”。错过当日时间会在服务恢复后补采；失败后每 30 分钟重试，当天最多 3 次。只保存招聘候选原文，不发送给 AI。招聘消息直接入库，自动识别公司和岗位；未识别出的字段可留空，之后在岗位库编辑或删除；图片、语音、文件和合并转发首版不识别。</p>${recruitmentForms}</form>`);
}
async function wechatInbox(status = 'imported') {
  wechatInboxStatus=status;
  const result=await api('/api/wechat/candidates?status='+status); wechatCandidates=result.candidates;
  modal('微信群招聘消息',`<div class="actions">${Object.entries({imported:'已入库',ignored:'已忽略'}).map(([key,label])=>button(label,'wechat-inbox',status===key?'small primary':'small','',`data-status="${key}"`)).join('')}</div><p>共 ${result.total} 条，显示最近 ${result.candidates.length} 条。相同内容的跨群转发、重复采集不会重复入库。</p><div class="import-preview">${result.candidates.map(c=>`<article class="wechat-message"><strong>${e(c.draft.title || '岗位未注明')} · ${e(c.draft.company || '公司未识别')}</strong><p class="muted">${e(c.group)} · 消息时间：${e(c.sentAt || '未提供')}<br>首次采集：${e(fmtDate(c.firstSeenAt))}</p><details><summary>查看招聘原文</summary><p class="preserve job-description">${e(c.text)}</p></details><div class="actions">${c.status==='pending'?button('核对后入库','wechat-review','small primary','edit',`data-id="${c.id}"`)+button('忽略','wechat-ignore','small subtle','',`data-id="${c.id}"`):c.status==='ignored'?button('恢复并入库','wechat-restore','small','',`data-id="${c.id}"`):button('查看岗位','job-detail','small','',`data-id="${c.jobId}"`)}</div></article>`).join('') || '<p class="empty-list">这里暂时没有消息。</p>'}</div><div class="form-actions">${button('关闭','close-modal')}</div>`);
}
async function wechatAction(action, element) {
  if(!state.wechat) throw new Error('请重启工作台服务以启用微信群采集。');
  const id=element.dataset.id;
  if(action==='wechat-new' || action==='wechat-edit') {wechatDialog((state.wechat.sources || []).find(s=>s.id===id));return;}
  if(action==='wechat-refresh') {await refresh();render();toast('来源状态已更新。');return;}
  if(action==='wechat-reset-cursor') {
    const {source}=await api(`/api/wechat/sources/${id}/status`);
    if(!await confirmAction('重建增量读取起点','这会清除旧的读取位置。下一次从最近一批消息建立新起点，更早尚未采到的消息可能遗漏；已入库、忽略和删除的记录均保留。','确认重建起点'))return;
    await api(`/api/wechat/sources/${id}/reset-cursor`,{method:'POST',body:JSON.stringify({revision:source.revision,confirmed:true})});
    await refresh();render();toast('旧读取位置已清除，请点击立即采集建立新起点。');return;
  }
  if(action==='wechat-check') {
    const result=await api('/api/wechat/check',{method:'POST'}),installed='组件已安装：'+result.library+' '+result.version;
      if(result.interfaceReadable===false)modal('微信采集环境检查',`<p>${e(installed)}</p><p class="risk-note">${e(result.message)}</p><div class="form-actions">${button('录入岗位 / 粘贴 JD','job-new','primary')}${button('关闭','close-modal')}</div>`);
    else toast(installed+'；'+(result.message||'微信兼容性请通过“立即采集”验证。'));
    return;
  }
  if(action==='wechat-jobs') { $('#modal').close(); await go('jobs'); return; }
  if(action==='wechat-inbox') {await wechatInbox(element.dataset.status || 'imported');return;}
  if(action==='wechat-review') {
    const candidate=wechatCandidates.find(c=>c.id===id); if(!candidate)throw new Error('请重新打开消息列表。');
    jobDialog(candidate.draft);$('#job-form').dataset.wechatCandidate=id;$('#modal-title').textContent='核对群消息并入库';return;
  }
  if(action==='wechat-ignore' || action==='wechat-restore') {
    await api(`/api/wechat/candidates/${id}/${action==='wechat-ignore'?'ignore':'restore'}`,{method:'POST'});await refresh();render();await wechatInbox(wechatInboxStatus);return;
  }
  if(action==='wechat-pull') {
    const {source}=await api(`/api/wechat/sources/${id}/status`);
    const guidance=source.readerMode==='database'?'正在只读采集本机已同步消息，不占用微信窗口。':source.readerMode==='uia'?'正在通过微信界面采集，请保持桌面解锁，期间不要操作微信。':'正在检查读取方式；数据库采集不占用微信窗口，界面采集需保持桌面解锁。';
    modal('采集微信群消息',`<p>${e(guidance)}</p><p id="wechat-progress" role="status">正在读取指定群，最多等待 3 分钟…</p>`);
    let polling=false;
    const timer=setInterval(async()=>{if(polling)return;polling=true;try {const {source:s}=await api(`/api/wechat/sources/${id}/status`);if($('#wechat-progress'))$('#wechat-progress').textContent=s.lastResult;}catch{}finally{polling=false;}},2500);
    try {
      const result=await api(`/api/wechat/sources/${id}/pull`,{method:'POST'});await refresh();render();
      modal('微信群采集完成',`<p>${e(result.source.lastResult)}</p>${wechatCoverageHTML(result.source)}${result.source.warning?`<p class="risk-note">${e(result.source.warning)}</p>`:''}<div class="form-actions">${result.source.lastCoverage?.hasMore?button('继续补读','wechat-pull','primary','download',`data-id="${id}"`):''}${button('查看岗位库','wechat-jobs','primary')}${button('关闭','close-modal')}</div>`);
    } catch(error) {await refresh();render();modal('本次采集未完成',`<p class="risk-note">${e(error.message)}</p><div class="form-actions">${button('关闭','close-modal')}</div>`);}
    finally {clearInterval(timer);}
  }
}

function sourcesView() {
  return heading('岗位来源', '按条件采集岗位：网站预览入库，微信自动入库。', button('录入岗位 / 粘贴 JD', 'job-new', '', 'plus') + button('添加来源', 'source-new', '', 'link') + button('添加微信群', 'wechat-new', 'primary', 'plus')) + recruitmentUnavailable() + `<div class="callout">BOSS直聘、智联招聘、前程无忧和 Offer 情报局使用本机独立 Edge 登录窗口，登录状态保存在此电脑；采集结果先预览，确认后写入本机岗位库。公开岗位页 / JSON 来源也可直接拉取。采集不会提交申请。</div><div class="actions wechat-tools">${button('微信群采集记录','wechat-inbox','','file')}${button('检查采集组件','wechat-check','subtle')}${button('刷新状态','wechat-refresh','subtle')}</div><div class="source-grid">${(state.jobSources || []).map(source => source.type==='wechat' ? wechatCard(source) : `<section class="panel source-card"><div class="source-top"><h2>${e(source.name)}</h2><span class="badge neutral">${source.lastCheckedAt ? '已检查' : '待检查'}</span></div><p class="source-url">${e(source.url)}</p><p>${e(source.lastResult)}</p>${source.lastCheckedAt ? `<small class="muted">上次拉取 ${e(new Date(source.lastCheckedAt).toLocaleString('zh-CN'))}</small>` : ''}<div class="actions">${sourceLink(source.url, '打开来源')}${source.platform || isOfferURL(source.url) ? button('登录采集窗口', 'source-login', 'small', 'external', `data-id="${source.id}"`) : ''}${button('拉取并预览', 'source-pull', 'small primary', 'download', `data-id="${source.id}"`)}${source.platform ? '' : button('编辑来源', 'source-edit', 'small subtle', 'edit', `data-id="${source.id}"`)}</div></section>`).join('')}</div><details class="panel import-help"><summary>支持哪些数据与筛选条件？</summary><p>平台来源可按专业、岗位名称、行业、地点、校招/社招筛选；岗位名称和专业组合为搜索关键词，行业及招聘类型按平台返回字段筛选。平台字段覆盖有限，未返回分类信息的岗位不会命中招聘类型条件。</p><p>默认最多 20 条，最多 200 条。日期条件只匹配来源明确提供的更新时间。相同公司、岗位和地点会跨平台去重。Offer 情报局按所选表格读取；公开来源支持 JobPosting 结构化数据和 JSON 岗位数组。</p></details>`;
}
const isOfferURL = value => { try { const u=new URL(value); return u.hostname==='offerqingbaoju.cn' && u.pathname==='/info-summary' && u.protocol==='https:'; } catch { return false; } };
let jobGrid = null, destroyBoard = null;
let selectedJobFilter = '';
let pendingHeaderFilters = null;
const jobKinds = { '':'全部信息', announcement:'招聘公告', position:'具体职位' };
const recruitmentLabel = job => ({campus:'校招 / 应届',social:'社招'}[job.recruitmentType] || '未注明');
const employmentLabel = job => ({fulltime:'全职',internship:'实习'}[job.employmentType] || '未注明');
const jobRequirementsHTML = job => `<p>招聘类型：${e(recruitmentLabel(job))} · 工作性质：${e(employmentLabel(job))} · 薪资：${e(job.salary || '未注明')} · 工作年限：${e(job.experience || '未注明')}</p>${job.jobTags?`<p class="muted">岗位标签：${e(job.jobTags)}</p>`:''}`;
const jobColumnNames = { employmentType:'工作性质', recruitmentType:'招聘类型', salary:'薪资', experience:'工作年限', sourceName:'数据来源', announcement:'公告 / 职位', location:'工作地点', announcementUrl:'公告链接', appliedPosition:'投递岗位', progress:'求职进展', operation:'操作' };
const jobSourceLabel = job => {
  const sourceName=String(job.sourceName||'').trim();
  // An explicit Offer origin takes precedence over legacy chat-type flags.
  if(/^Offer\s*情报局(?:\s*[·・-]|$)/i.test(sourceName))return 'Offer 情报局';
  return job.sourceType==='wechat'||/^微信群(?:\s*·|$)/.test(sourceName)?'微信':sourceName||'未注明';
};
const isAnnouncement = job => (state.announcements || []).some(item=>item.id===job.id);
function jobFilterControls() {
  return `<details class="job-more"><summary class="btn">更多</summary><div class="job-more-panel">
    <div class="field"><label for="job-kind-filter">信息类型</label><select id="job-kind-filter" name="kind" form="job-filter-form">${Object.entries(jobKinds).map(([key,label])=>`<option value="${key}" ${key===(jobSearch.kind||'')?'selected':''}>${label}</option>`).join('')}</select></div>
    <div class="field"><label for="saved-job-filter">常用筛选</label><select id="saved-job-filter"><option value="">选择已保存的组合</option>${(state.savedJobFilters||[]).map(item=>`<option value="${item.id}" ${selectedJobFilter===item.id?'selected':''}>${e(item.name)}</option>`).join('')}</select></div>
    <div class="actions">${button('应用组合','job-filter-load','small')}${button('保存当前筛选','job-filter-save','small')}${button('删除组合','job-filter-delete','small subtle')}</div>
    <div class="job-more-actions">${button('导出筛选结果','job-export','','download')}${button('录入招聘公告','job-announcement-new','','plus')}${button('恢复默认布局','job-reset-layout','subtle')}</div>
  </div></details>`;
}
function updateJobFilterSummary(count) {
  const summary=$('#job-filter-summary'); if(!summary || !jobGrid)return;
  const filters=jobGrid.getHeaderFilters().map(item=>`${jobColumnNames[item.field]||item.field}：${Array.isArray(item.value)?(item.value.length?item.value.map(v=>v||'（空白）').join('、'):'未选任何值'):item.value}`);
  const range={'':'未归档',yes:'已归档',all:'全部岗位',deleted:'回收站'}[jobSearch.archived||''];
  const clear=$('[data-action="job-clear-filters"]');if(clear)clear.hidden=!(filters.length||jobSearch.q||jobSearch.kind);
  summary.title=filters.join('；');
  summary.textContent=`找到 ${typeof count==='number'?count:jobGrid.getDataCount('active')} 条 · 全库 ${(state.jobs||[]).length} 条 · ${[range,jobSearch.kind?jobKinds[jobSearch.kind]:'',jobSearch.q?'搜索：'+jobSearch.q:'',filters.length?'已筛选 '+filters.length+' 列':''].filter(Boolean).join(' · ')}`;
}
let applicationView = preference('workbench-application-view', 'board') === 'list' ? 'list' : 'board';
let applicationCalendarMonth = '', applicationCalendarSelected = '';
function filteredJobs() {
  return (state.jobs || []).filter(j => {
    if (jobSearch.archived === 'deleted' ? !j.deletedAt : j.deletedAt) return false;
    if (!['all', 'deleted'].includes(jobSearch.archived) && (jobSearch.archived === 'yes' ? !j.archived : j.archived)) return false;
    if (jobSearch.kind === 'announcement' && !isAnnouncement(j)) return false;
    if (jobSearch.kind === 'position' && (j.recordType!=='position' || isAnnouncement(j))) return false;
    return [j.title, currentAnnouncement(j).title, j.announcement, j.company, j.location, j.sourceName, j.description, j.appliedPosition].join(' ').toLowerCase().includes((jobSearch.q || '').toLowerCase());
  });
}
function jobsView() {
  return heading('岗位库', '点击表头筛选图标，勾选要看的内容。', button('录入岗位 / 粘贴 JD','job-new','primary','plus')) + `<section class="panel jobs-panel"><div class="job-toolbar"><form id="job-filter-form" class="job-search-form"><input id="job-search" name="q" type="search" aria-label="搜索岗位、公告、公司、来源或投递岗位" placeholder="搜索岗位、公司或关键词" value="${e(jobSearch.q)}"><button type="submit" class="btn">搜索</button><select id="job-archive-filter" name="archived" aria-label="岗位范围">${Object.entries({'':'未归档',yes:'已归档',all:'全部岗位',deleted:'回收站（'+(state.jobs||[]).filter(j=>j.deletedAt).length+'）'}).map(([k,v])=>`<option value="${k}" ${jobSearch.archived===k?'selected':''}>${v}</option>`).join('')}</select></form>${jobFilterControls()}</div><div class="job-results"><span id="job-filter-summary" role="status"></span>${button('清除筛选','job-clear-filters','small subtle','','hidden')}</div><div class="panel-body"><div id="job-scroll-top" class="job-scroll-top" tabindex="0" role="region" aria-label="岗位表格横向滚动条"><div></div></div><div id="job-grid" aria-label="岗位列表"></div></div></section>`;
}
function updateJobSelection(){
  const count=jobGrid?.getSelectedData().length||0,label=$('#job-selection-count');if(label)label.textContent='已选 '+count+' 条';
  const toolbar=$('.job-batch-tools');if(toolbar)toolbar.hidden=!count;
  document.querySelectorAll('[data-action^="job-batch-"]').forEach(el=>{el.disabled=!count||count>1000||!state.capabilities?.jobBatchTrash;});
}
function setupJobTable() {
  const headerFilters=pendingHeaderFilters;pendingHeaderFilters=null;
  $('#job-grid').insertAdjacentHTML('beforebegin',`<div class="job-batch-tools" hidden><strong id="job-selection-count" role="status">已选 0 条</strong>${button('全选筛选结果','job-select-all','small')}${button('取消选择','job-select-none','small')}${jobSearch.archived==='deleted'?button('批量恢复','job-batch-restore','small primary','','disabled')+button('彻底删除所选','job-batch-purge','small danger','','disabled'):button('批量删除','job-batch-trash','small','','disabled')}<span class="muted">每次最多 1000 条</span></div>`);
  if(!state.capabilities?.jobBatchTrash)$('#job-grid').insertAdjacentHTML('beforebegin','<p class="callout">后台尚未加载岗位批量回收站功能，请重启新版后台后使用。</p>');
  const statuses = state.applicationStatuses || {};
  const rows = filteredJobs().map(j => {
    const app = [...(state.applications || []),...(state.deletedApplications||[])].find(a=>a.jobId===j.id);
    return { ...j, recruitmentType:recruitmentLabel(j), employmentType:employmentLabel(j), salary:j.salary||'未注明', experience:j.experience||'未注明', sourceName: jobSourceLabel(j), batch: j.batch || j.category || '未注明', announcement: [currentAnnouncement(j).title || '微信招聘信息',j.company,j.title].filter(Boolean).join(' · '), companyType: j.companyType || '未注明', industry: j.industry || '未注明', location: j.location || '未注明', announcementUrl: currentAnnouncement(j).url || (j.announcementId?'':j.url) || '', progress: app?.deletedAt ? '投递已删除' : app ? statuses[app.status] : isAnnouncement(j) ? '待整理职位' : '待投递', operation: j.deletedAt ? '可恢复' : [app ? '已有投递记录' : isAnnouncement(j) ? '查看职位' : '可准备投递', j.archived ? '已归档' : ''].filter(Boolean).join(' · '), job: j, app };
  });
  jobGrid = createJobGrid(rows, [
    { title:'数据来源', field:'sourceName', width:130, tooltip:(_event,cell)=>e(cell.getData().job.sourceName||'未注明') },
    { title:'招聘公告', field:'announcement', width:300, formatter:cell=> { const j=cell.getData().job; return `<strong>${e(j.recordType==='position'?j.title:j.announcement || j.title)}</strong> <span class="badge neutral">${isAnnouncement(j)?'招聘公告':j.recordType==='position'?'具体职位':'待分类'}</span><p>${e(j.company || '公司未识别')}${isAnnouncement(j)?' · '+e(j.title||'岗位未注明'):''}</p>${j.announcementId?`<p class="muted">所属公告：${e(currentAnnouncement(j).title)}</p>`:''}<small class="muted">${j.sourceUpdatedAt?'更新：'+e(j.sourceUpdatedAt)+' · ':''}入库：${e(new Date(j.createdAt).toLocaleDateString('zh-CN'))}</small>`; } },
    { title:'工作地点', field:'location', width:140 },
    { title:'招聘类型', field:'recruitmentType', width:135 },
    { title:'工作性质', field:'employmentType', width:120 },
    { title:'薪资', field:'salary', width:145 },
    { title:'工作年限', field:'experience', width:140 },
    { title:'公告链接', field:'announcementUrl', width:150, formatter:cell=>jobLinkCell(cell.getRow().getData().job) },
    { title:'投递岗位', field:'appliedPosition', width:170, formatter:cell=> { const j=cell.getData().job; return `${j.deletedAt?`<div class="job-applied-position preserve">${e(j.appliedPosition || '')}</div>`:button(e(j.appliedPosition || '填写投递岗位'),'job-applied-position','small subtle job-position-edit','',`data-id="${j.id}" aria-label="编辑${e(j.company || j.title || '此记录')}的投递岗位" ${state.capabilities?.appliedPosition?'':'disabled title="后台尚未加载投递岗位功能"'}`)}`; } },
    { title:'求职进展', field:'progress', width:140, headerFilterParams:{values:['待投递',...Object.values(statuses),'待整理职位','投递已删除']}, formatter:cell=> { const {job:j,app:a}=cell.getData(); return `<select class="progress-tag" data-job-progress="${j.id}" data-revision="${a?.revision || 0}" aria-label="${e(j.company)}求职进展" ${j.deletedAt || a?.deletedAt || (isAnnouncement(j)&&!a)?'disabled':''}><option value="" ${!a||a.deletedAt?'selected':''} disabled>${a?.deletedAt?'投递已删除':isAnnouncement(j)?'待整理职位':'待投递'}</option>${Object.entries(statuses).map(([key,label])=>`<option value="${key}" ${!a?.deletedAt&&a?.status===key?'selected':''}>${e(label)}</option>`).join('')}</select>`; } },
    { title:'操作', field:'operation', width:220, headerSort:false, formatter:cell=> { const j=cell.getData().job; return `<div class="job-row-actions">${j.deletedAt?button('恢复','job-restore','small subtle','',`data-id="${j.id}"`)+button('彻底删除','job-purge','small danger','',`data-id="${j.id}" ${state.capabilities?.jobBatchTrash?'':'disabled'}`):button('详情','job-detail','small subtle','',`data-id="${j.id}"`)+button('编辑','job-edit','small subtle','edit',`data-id="${j.id}"`)+button('删除','job-delete','small danger','trash',`data-id="${j.id}"`)}</div>`; } },
  ],headerFilters,!!state.capabilities?.jobBatchTrash);
  if(!state.capabilities?.appliedPosition)$('#job-grid').insertAdjacentHTML('beforebegin','<p class="callout">后台尚未加载投递岗位功能，请保存当前编辑并重新启动工作台后填写。</p>');
  jobGrid.on('rowSelectionChanged',updateJobSelection);
  jobGrid.on('tableBuilt',()=>{updateJobFilterSummary();updateJobSelection();});
  jobGrid.on('dataFiltered',(_filters,rows)=>{const active=new Set(rows.map(row=>row.getData().id));for(const row of jobGrid.getSelectedRows())if(!active.has(row.getData().id))row.deselect();updateJobFilterSummary(rows.length);updateJobSelection();});
}
function pullDialog(source,automatic=false) {
  const c=(automatic?source.automation?.conditions:source.lastConditions) || source.lastConditions || {}, offer=isOfferURL(source.url), platform=Boolean(source.platform);
  const input=(name,label,type='text',extra='')=>`<div class="field"><label for="pull-${name}">${label}（选填）</label><input id="pull-${name}" name="${name}" type="${type}" ${extra} value="${e(c[name] ?? '')}"></div>`;
  const requirements = ['zhilian','51job'].includes(source.platform) ? `<div class="field"><label for="pull-employmentType">工作性质（选填）</label><select id="pull-employmentType" name="employmentType"><option value="">不限</option><option value="fulltime" ${['fulltime','fulltime_or_unknown'].includes(c.employmentType)?'selected':''}>全职</option><option value="internship" ${c.employmentType==='internship'?'selected':''}>实习</option></select></div><div class="field-row">${input('salaryMin','月薪下限（元）','number','min="0" max="10000000" step="any" placeholder="如 6000"')}${input('salaryMax','月薪上限（元）','number','min="0" max="10000000" step="any" placeholder="留空不限"')}</div><div class="field"><label for="pull-experienceMax">最低经验要求最多几年（选填）</label><input id="pull-experienceMax" name="experienceMax" type="number" min="0" max="50" step="any" placeholder="填 0：不要求工作经验" value="${e(c.experienceMax ?? '')}"></div><p>校招 / 应届包含校园、毕业届别标签岗位，以及经验不限、无需经验、一年以下的应届友好岗位；明确要求多年经验的仍排除。仅按经验纳入的岗位不会标成明确校招。按填写的岗位名称搜索，行业留空即不限制行业。选择全职时排除明确的实习、兼职等岗位，不因缺少全职标签而排除；选择实习时只保留识别为实习的岗位。经验填 0 表示不要求已有工作经验。薪资按区间有交集筛选，年薪除以 12，不计额外薪数；日薪、面议和缺失值不通过薪资筛选。平台字段矛盾时从严排除。</p>` : '';
  modal(automatic?'自动拉取设置':'设置拉取条件',`<form id="${automatic?'source-auto-form':'source-pull-form'}" data-id="${source.id}" data-revision="${source.revision||1}"><p>${e(source.name)} · ${platform?'首次请先登录本机采集窗口。多个岗位或专业用顿号分隔，逐组搜索；行业、招聘类型按返回字段筛选。':offer?'按网站更新时间倒序读取，自动翻页并去重。首次请先登录采集窗口。':'筛选公开来源返回的岗位记录。'}</p>${offer?`<div class="field"><label for="pull-table">招聘表格</label><select id="pull-table" name="table">${['秋招汇总','实习信息汇总','26届25届信息汇总','社招国央企&事业单位&高校','校招实习内推合集'].map(t=>`<option ${c.table===t?'selected':''}>${t}</option>`).join('')}</select></div>`:''}<div class="field-row">${input('keyword','岗位名称','text','maxlength="100" placeholder="如产品经理"')}${platform?input('major','专业','text','maxlength="100" placeholder="如计算机、市场营销"'):input('location','工作地点','text','maxlength="100" placeholder="如上海"')}</div>${platform?`<div class="field-row">${input('industry','行业','text','maxlength="150" placeholder="如互联网、医疗"')}<div class="field"><label for="pull-recruitmentType">招聘类型（选填）</label><select id="pull-recruitmentType" name="recruitmentType"><option value="">不限</option><option value="campus" ${c.recruitmentType==='campus'?'selected':''}>校招 / 应届</option><option value="social" ${c.recruitmentType==='social'?'selected':''}>社招</option></select></div></div><div class="field-row">${input('location','工作地点','text','maxlength="100" placeholder="如上海"')}${input('limit','本次读取上限','number','min="1" max="200" placeholder="默认20，最多200"')}</div>`:`<div class="field-row">${input('limit','本次读取上限','number','min="1" max="200" placeholder="默认20，最多200"')}${input('from','更新开始日期','date')}</div>${input('to','更新结束日期','date')}`}${requirements}<p>${platform?'按岗位标签与经验字段筛选；智联、前程无忧不再自动追加应届生关键词。多个专业用顿号分隔，每组都会搜索，再均衡汇总到总条数上限。手动拉取先预览；启用自动拉取后，新增岗位直接去重入库。': '日期按网站更新时间筛选，含起止当天；没有更新时间的记录在设置日期条件后不纳入。留空表示不限。读取后跳过已入库和已删除记录，新增数量可能少于上限。预览不会自动入库。'}</p>${automatic?`<div class="field"><label for="source-auto-interval">自动拉取间隔（分钟）</label><input id="source-auto-interval" name="intervalMinutes" type="number" min="15" max="1440" value="${source.automation?.intervalMinutes||60}" required></div><p>保存后开始自动拉取并去重入库。电脑和工作台后台需保持运行；遇到登录过期或验证时暂停，完成验证后可在这里重新启用。不会自动投递。</p>`:''}<p id="pull-progress" role="status"></p><div class="inline-error" role="alert"></div><div class="form-actions">${platform||offer?button('登录采集窗口','source-login','','external',`data-id="${source.id}"`):''}${button('取消','close-modal')}<button class="btn primary" type="submit">${automatic?'保存并启用自动拉取':'开始拉取并预览'}</button></div></form>`);
}
function showSourcePreview(result) {
  sourcePreview=result.jobs;
  modal('确认拉取的岗位',`<form id="source-import-form"><p>可新增 ${sourcePreview.length} 条，读取 ${result.scanned ?? sourcePreview.length} 行；跳过已入库 ${result.skippedExisting||0} 条、已删除 ${result.skippedDeleted||0} 条、无效数据 ${result.skipped||0} 条。${e(result.warning || '')}</p><div class="import-preview">${sourcePreview.map((j,i)=>`<label class="import-row"><input type="checkbox" name="job-${i}" ${j.duplicate?'disabled':'checked'}><span><strong>${e(j.announcement || j.title)}</strong><br>${e(j.title)} · ${e(j.company)} · ${e(j.location || '地点未注明')}${jobRequirementsHTML(j)}<small>网站更新：${e(j.sourceUpdatedAt || '未注明')} ${j.duplicate?'· 已存在':''}</small><details><summary>查看来源内容</summary><p class="preserve">${e(j.description || '未提供 JD')}</p></details>${sourceLink(j.url,'查看并投递',j)}</span></label>`).join('') || '<p>本次没有新的岗位。已入库和已删除的记录会自动跳过；需要找回已删除岗位时，请到回收站手动恢复。</p>'}</div><div class="inline-error" role="alert"></div><div class="form-actions">${button('关闭','close-modal')}<button type="submit" class="btn primary" ${!sourcePreview.some(j=>!j.duplicate)?'disabled':''}>确认入库</button></div></form>`);
}

function applicationsView() {
  const trash = applicationSearch.box === 'trash', all = (trash ? state.deletedApplications : state.applications) || [], statuses = state.applicationStatuses || {}, list = all.filter(a => (!applicationSearch.status || a.status === applicationSearch.status) && (!applicationSearch.due || applicationDue(a)) && `${a.jobSnapshot.company} ${applicationRole(a)}`.toLowerCase().includes((applicationSearch.q || '').trim().toLowerCase())).sort((a,b) => Number(Boolean(applicationDue(b))) - Number(Boolean(applicationDue(a))) || b.updatedAt.localeCompare(a.updatedAt));
  const filtered = Boolean((applicationSearch.q || '').trim() || applicationSearch.status || applicationSearch.due);
  const empty = `<section class="panel empty-list">${all.length ? '没有符合筛选条件的投递记录，请调整条件或清除筛选。' : trash ? '回收站为空。只有主动删除的投递记录会出现在这里。' : '暂无投递记录。打开岗位详情，点击“准备投递”。'}</section>`;
  const metrics = [[trash?'回收站记录':'全部投递记录', all.length], ['已确认投递', all.filter(a => a.submittedAt).length], ['面试中', all.filter(a => a.status === 'interview').length], ['收到 Offer', all.filter(a => a.status === 'offer').length]];
  return heading('投递跟踪', '集中查看投递岗位；匹配到的测评、面试通知自动更新进展。', trash?'':`<div class="view-switch" role="group" aria-label="投递视图">${['board','list'].map(mode=>button(mode==='board'?'阶段看板':'列表','application-view',applicationView===mode?'primary':'','',`data-mode="${mode}" aria-pressed="${applicationView===mode}"`)).join('')}</div>`) + recruitmentUnavailable() + `${applicationTrashTabs()}${state.mail?.mailAutoProgress?'':'<p class="callout">请重启工作台，启用邮件自动更新投递进展。</p>'}${trash?`<div class="recruitment-stats">${metrics.map(([label,n])=>`<div class="panel"><span class="muted">${label}</span><strong>${n}</strong></div>`).join('')}</div>`:'<section id="application-calendar" class="panel application-calendar" aria-label="投递统计看板"></section>'}<div class="stage-summary">${Object.entries(statuses).map(([key,label])=>`<span class="badge neutral">${e(label)} ${list.filter(a=>a.status===key).length}</span>`).join('')}</div><form id="application-filter-form" class="list-filters"><input type="hidden" name="box" value="${trash?'trash':'active'}"><div class="field"><label for="app-search">公司 / 投递岗位</label><input id="app-search" name="q" value="${e(applicationSearch.q)}"></div><div class="field"><label for="app-status-filter">投递阶段</label><select id="app-status-filter" name="status"><option value="">全部阶段</option>${Object.entries(statuses).map(([key,label])=>`<option value="${key}" ${applicationSearch.status===key?'selected':''}>${e(label)}</option>`).join('')}</select></div><button type="submit" class="btn">筛选</button>${button('清除筛选','application-clear-filters','subtle')}</form><p id="application-result-count" class="report-notice" role="status">${filtered?'筛选结果':trash?'回收站记录':'全部记录'}：找到 ${list.length} 条 · 总计 ${all.length} 条投递记录</p>${!list.length ? empty : applicationView==='board' && !trash ? applicationBoard(list,statuses,filtered) : `<section class="panel"><div class="panel-body application-list"><div class="table-scroll"><table class="review-table jobs-table"><thead><tr><th>投递岗位</th><th>${trash?'删除前阶段':'投递状态'}</th><th>投递链接</th><th>操作</th></tr></thead><tbody>${list.map(a=>`<tr><th scope="row">${e(a.jobSnapshot.company || '公司未识别')}<p class="muted">${e(applicationRole(a))}</p></th><td><span class="badge neutral">${e(statuses[a.status])}</span></td><td>${applicationLink(a)}</td><td><div class="actions">${applicationActions(a)}</div></td></tr>`).join('')}</tbody></table></div></div></section>`}`;
}
function applicationBoard(list, statuses, filtered = false) {
  const columns = Object.entries(statuses).filter(([key]) => !filtered || list.some(a=>a.status===key));
  return `<p class="report-notice">${filtered ? '当前仅显示匹配的阶段。可点击“更新进展”，或清除筛选后拖动到其他阶段。' : '拖动卡片可更新阶段，变更自动记入时间线。'}</p><div id="application-scroll-top" class="job-scroll-top" tabindex="0" role="region" aria-label="投递阶段看板横向滚动条"><div></div></div><div class="application-board" tabindex="0" role="region" aria-label="投递阶段看板">${columns.map(([key,label])=>{
    const cards=list.filter(a=>a.status===key);
    return `<section class="kanban-column"><header><h2>${e(label)}</h2><span class="badge neutral">${cards.length}</span></header><div class="kanban-lane" data-status="${key}" role="list" aria-label="${e(label)}">${cards.map(a=>`<article class="application-card" data-id="${a.id}" role="listitem"><div class="card-heading"><strong>${e(a.jobSnapshot.company || '公司未识别')}</strong><span class="card-drag" aria-hidden="true" title="拖动到其他阶段">⠿</span></div><p class="card-role">${e(applicationRole(a))}</p><p>${applicationLink(a)}</p><div class="actions">${applicationActions(a)}</div></article>`).join('')}</div></section>`;
  }).join('')}</div>`;
}
function applicationTrashTabs() {
  const trash=applicationSearch.box==='trash';
  return `<div class="actions" role="group" aria-label="投递记录范围">${button('投递记录 '+(state.applications||[]).length,'application-box',trash?'':'primary','','data-box="active" aria-pressed="'+!trash+'"')}${button('回收站 '+(state.deletedApplications||[]).length,'application-box',trash?'primary':'','','data-box="trash" aria-pressed="'+trash+'"')}</div><p class="report-notice">${state.capabilities?.applicationRecycle ? (trash?'仅存放主动删除的投递记录；恢复后回到原阶段。':'删除后移入回收站，可恢复。') : '请重启工作台，启用投递删除与回收站。'}</p>`;
}
function applicationActions(app) {
  const extra=`data-id="${app.id}"`, unavailable=state.capabilities?.applicationRecycle?'':' disabled';
  return button('时间线','application-detail','small','',extra)+(app.deletedAt
    ? button('恢复','application-restore','small','',extra+unavailable)+button('彻底删除','application-purge','small','trash',extra+unavailable)
    : button('更新进展','application-update','small','',extra)+button('删除','application-delete','small','trash',extra+unavailable));
}
function applicationRole(app) {
  const job=(state.jobs||[]).find(j=>j.id===app.jobId)||app.jobSnapshot;
  return job.appliedPosition || app.jobSnapshot.appliedPosition || job.title || app.jobSnapshot.title || '岗位未注明';
}
function applicationLink(app) {
  const job=(state.jobs||[]).find(j=>j.id===app.jobId)||app.jobSnapshot;
  const url=(job.recordType==='position'?job.url:'') || currentAnnouncement(job).url || job.url || app.jobSnapshot.announcementUrl || app.jobSnapshot.url;
  return sourceLink(url,'投递链接 ↗',job);
}
function applicationLocalDay(value) {
  if (!value) return '';
  // Date-only records are already local calendar days, not UTC midnight.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(value + 'T12:00:00');
    return Number.isFinite(date.getTime()) && date.getDate() === Number(value.slice(8)) ? value : '';
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}` : '';
}
function applicationCalendarStats(applications, now = new Date()) {
  const today = applicationLocalDay(now), active = applications.filter(a=>!a.deletedAt), days = new Map();
  const confirmed = new Set(['submitted','communicating','assessment','interview','offer','rejected']);
  for (const app of active) {
    // Legacy records may have a confirmation in their timeline but no submittedAt.
    // Never substitute creation/update time, or count subsequent stage changes again.
    const day = applicationLocalDay(app.submittedAt) || (app.history || []).filter(h=>confirmed.has(h.status)).map(h=>applicationLocalDay(h.at)).filter(Boolean).sort()[0];
    if (!day) continue;
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(app);
  }
  return { today, days, total:[...days.values()].reduce((n,rows)=>n+rows.length,0), interview:active.filter(a=>a.status==='interview').length, offer:active.filter(a=>a.status==='offer').length };
}
function setupApplicationCalendar() {
  const root = $('#application-calendar');
  if (!root) return;
  let expanded = preference('workbench-application-calendar-expanded', true) !== false;
  if (!applicationCalendarMonth) applicationCalendarMonth = applicationLocalDay(new Date()).slice(0,7);
  if (!applicationCalendarSelected) applicationCalendarSelected = applicationLocalDay(new Date());
  function paint() {
    const stats = applicationCalendarStats(state.applications || []), month = applicationCalendarMonth;
    const [year, monthNumber] = month.split('-').map(Number), count = new Date(year,monthNumber,0).getDate();
    const offset = (new Date(year,monthNumber-1,1).getDay()+6)%7;
    const monthTotal = [...stats.days].filter(([day])=>day.startsWith(month)).reduce((n,[,rows])=>n+rows.length,0);
    const selected = applicationCalendarSelected, rows = stats.days.get(selected) || [];
    const metrics = [['today','今日投递',stats.days.get(stats.today)?.length || 0],['total','总投递',stats.total],['interview','面试中',stats.interview],['offer','收到 Offer',stats.offer]];
    const cells = Array.from({length:offset},()=>'<span aria-hidden="true"></span>');
    for (let day=1;day<=count;day++) {
      const date = `${month}-${String(day).padStart(2,'0')}`, n = stats.days.get(date)?.length || 0;
      cells.push(`<button type="button" class="application-calendar-day" data-calendar-date="${date}" data-level="${n>=6?3:n>=3?2:n?1:0}" aria-pressed="${date===selected}" ${date===stats.today?'aria-current="date"':''} aria-label="${year}年${monthNumber}月${day}日，${date===stats.today?'今天，':''}投递 ${n} 份"><span>${day}</span><span class="application-calendar-count">${n?n+'份':date>stats.today?'':'—'}</span></button>`);
    }
    root.innerHTML = `<div class="application-calendar-summary"><div class="application-calendar-metrics">${metrics.map(([key,label,n])=>`<div><span class="muted">${label}</span><strong data-calendar-stat="${key}">${n}</strong></div>`).join('')}</div><button type="button" class="btn small subtle" data-calendar-action="toggle" aria-expanded="${expanded}" aria-controls="application-calendar-body">${expanded?'收起日历 ⌃':'展开日历 ⌄'}</button></div>
      <div id="application-calendar-body" ${expanded?'':'hidden'}><div class="application-calendar-toolbar"><div><strong>${year} 年 ${monthNumber} 月</strong><span class="muted" data-calendar-month-total>本月投递 ${monthTotal} 份</span></div><div class="actions"><button type="button" class="btn small" data-calendar-action="prev" aria-label="上个月">‹</button><button type="button" class="btn small" data-calendar-action="today">今天</button><button type="button" class="btn small" data-calendar-action="next" aria-label="下个月">›</button></div></div>
      <div class="application-calendar-content"><div><div class="application-calendar-week" aria-hidden="true">${['一','二','三','四','五','六','日'].map(d=>`<span>${d}</span>`).join('')}</div><div class="application-calendar-days" role="group" aria-label="每日投递数量">${cells.join('')}</div></div>
      <section class="application-calendar-detail" aria-live="polite"><div class="application-calendar-detail-heading"><strong>${Number(selected.slice(5,7))} 月 ${Number(selected.slice(8))} 日${selected===stats.today?' · 今天':''}</strong><span class="muted">投递 ${rows.length} 份</span></div><div class="application-calendar-records">${rows.length?rows.map(a=>`<div class="application-calendar-record"><div><strong>${e(applicationRole(a))}</strong><span class="muted">${e(a.jobSnapshot?.company || '公司未识别')} · ${e(state.applicationStatuses?.[a.status] || '阶段未注明')}</span></div>${button('查看','application-detail','small subtle','',`data-id="${e(a.id)}" aria-label="查看${e(a.jobSnapshot?.company || '')}的投递记录"`)}</div>`).join(''):`<p class="muted">${selected>stats.today?'尚未到该日期':'当天暂无投递记录'}</p>`}</div></section></div>
      <p class="application-calendar-note">按首次确认投递的本机日期统计，每条记录计一次；不含尚未确认投递和回收站记录。</p></div>`;
  }
  root.onclick = event => {
    const target = event.target.closest('[data-calendar-action], [data-calendar-date]');
    if (!target || !root.contains(target)) return;
    const action = target.dataset.calendarAction, today = applicationLocalDay(new Date());
    if (action==='toggle') { expanded=!expanded; savePreference('workbench-application-calendar-expanded',expanded); }
    else if (action==='today') { applicationCalendarMonth=today.slice(0,7); applicationCalendarSelected=today; }
    else if (action==='prev' || action==='next') {
      const [year,month]=applicationCalendarMonth.split('-').map(Number);
      applicationCalendarMonth=applicationLocalDay(new Date(year,month-1+(action==='prev'?-1:1),1)).slice(0,7);
      applicationCalendarSelected=applicationCalendarMonth===today.slice(0,7)?today:applicationCalendarMonth+'-01';
    } else if (target.dataset.calendarDate) applicationCalendarSelected=target.dataset.calendarDate;
    paint();
    root.querySelector(action?`[data-calendar-action="${action}"]`:`[data-calendar-date="${applicationCalendarSelected}"]`)?.focus({preventScroll:true});
  };
  paint();
}
function setupApplicationBoard() {
  destroyBoard = createApplicationBoard(async (id,status) => {
    const app=(state.applications || []).find(a=>a.id===id);
    if (!app || app.status===status || pendingMutations) return;
    try {
      await api('/api/applications/'+id,{method:'PATCH',body:JSON.stringify({revision:app.revision,status,nextAction:app.nextAction,nextActionAt:app.nextActionAt,note:'通过阶段看板更新进展。'})});
      await refresh(); render(); toast('已更新为'+state.applicationStatuses[status]+'，跟进安排已保留。');
    } catch(error) { try { await refresh(); render(); } catch {} toast(error.message); }
  });
}
function appliedPositionHistory(recent = '') {
  const saved = preference('workbench-applied-position-history', []);
  const values = [recent, ...(Array.isArray(saved) ? saved : []), ...state.jobs.filter(job=>!job.deletedAt).map(job=>job.appliedPosition)];
  return [...new Set(values.filter(value=>typeof value==='string').map(value=>value.trim()).filter(value=>value&&value.length<=1000))].slice(0,100);
}
const pendingPositionEdits = new Map();
async function editAppliedPosition(job, element) {
  const existing = document.querySelector('.job-position-inline');
  if (existing) {
    await existing.flushPosition();
    if(existing.isConnected){existing.querySelector('textarea').focus({preventScroll:true});return;}
  }
  const row = view==='jobs'&&jobGrid?.getRow(job.id), cell = row&&row.getCell('appliedPosition').getElement();
  if (!row || !cell?.isConnected) return;
  const history = appliedPositionHistory(), draft = pendingPositionEdits.get(job.id);
  const form = document.createElement('form');
  form.id='job-applied-position-form';form.className='job-position-inline';
  form.dataset.id=job.id;form.dataset.revision=draft?.revision??job.revision;form.dataset.inline='true';form.dataset.autosave='true';
  form.innerHTML=`<textarea id="job-applied-position" name="appliedPosition" maxlength="1000" rows="3" aria-label="投递岗位" placeholder="填写投递岗位">${e(draft?.value??job.appliedPosition??'')}</textarea><select aria-label="历史快捷填写"><option value="">${history.length?'历史快捷填写':'暂无填写历史'}</option>${history.map((value,index)=>`<option value="${index}">${e(value)}</option>`).join('')}</select><small role="status">${draft?'有未保存的输入':'输入后自动保存'}</small><div class="inline-error" role="alert"></div>`;
  const input=form.querySelector('textarea'),status=form.querySelector('small'),errorBox=form.querySelector('.inline-error');
  let timer, running, composing=false;
  const remember=()=>pendingPositionEdits.set(job.id,{value:input.value,revision:Number(form.dataset.revision)});
  const flush=()=>{
    clearTimeout(timer);
    if(composing)return Promise.resolve();
    if(running)return running;
    running=(async()=>{
      try {
        errorBox.textContent='';
        do {
          const value=input.value;
          status.textContent='正在保存…';
          await recruitmentSubmit(form,{appliedPosition:value});
          if(input.value===value)pendingPositionEdits.delete(job.id);else remember();
          status.textContent=input.value===value?'已自动保存':'等待自动保存…';
          // A newer edit waits for the previous response and uses its new revision.
        } while(!composing&&input.value.trim()!==state.jobs.find(item=>item.id===job.id)?.appliedPosition);
        if(!composing&&input.value.trim()===state.jobs.find(item=>item.id===job.id)?.appliedPosition){pendingPositionEdits.delete(job.id);status.textContent='已自动保存';}
      } catch(error) {
        remember();status.textContent='未保存';errorBox.textContent=error.message+' 修改内容或离开输入框时会再次尝试。';
        if(form.isConnected)row.normalizeHeight();else toast('投递岗位未保存，重新点击该岗位可继续编辑。',true);
      } finally {running=null;}
    })();
    return running;
  };
  form.flushPosition=flush;
  const schedule=()=>{remember();errorBox.textContent='';status.textContent='等待自动保存…';clearTimeout(timer);if(!composing)timer=setTimeout(flush,600);};
  input.addEventListener('input',schedule);
  input.addEventListener('compositionstart',()=>{composing=true;clearTimeout(timer);});
  input.addEventListener('compositionend',()=>{composing=false;schedule();});
  form.querySelector('select').addEventListener('change',event=>{
    if(event.target.value==='')return;
    input.value=history[Number(event.target.value)];event.target.value='';
    input.focus({preventScroll:true});input.setSelectionRange(input.value.length,input.value.length);remember();void flush();
  });
  form.addEventListener('focusout',()=>{setTimeout(()=>{if(!form.contains(document.activeElement))void flush();},0);});
  form.addEventListener('submit',event=>{event.preventDefault();event.stopPropagation();void flush();});
  form.addEventListener('keydown',event=>{
    if(event.isComposing||composing)return;
    if(event.target===input&&event.key==='Enter'&&!event.shiftKey){event.preventDefault();void flush();}
  });
  cell.replaceChildren(form);row.normalizeHeight();input.focus({preventScroll:true});
  input.setSelectionRange(input.value.length,input.value.length);
}

function appliedPositionField(job={}) {
  return `<div class="field"><label for="job-applied-position">投递岗位</label><textarea id="job-applied-position" name="appliedPosition" maxlength="1000" rows="4" aria-describedby="job-applied-position-help" placeholder="例如：客户经理、销售管培生">${e(job.appliedPosition || '')}</textarea><small id="job-applied-position-help">记录你实际投递的职位名称，多个岗位可换行或用顿号分隔。留空表示尚未记录，不会自动改变求职进展。</small></div>`;
}
function jobDialog(job = {}, sourceName = '', announcement = null) {
  const wechat = ['wechat','qq'].includes(job.sourceType) || (job.sourceName || sourceName).startsWith('微信群 · ');
  const entry = (label,name,max,required=false,type='text') => `<div class="field"><label for="job-${name}">${label}</label><input id="job-${name}" name="${name}" type="${type}" maxlength="${max}" ${required?'required':''} value="${e(job[name] || (name==='sourceName'?sourceName:''))}"></div>`;
  modal(job.id?'编辑岗位':'录入岗位 / 粘贴 JD', `<form id="job-form" data-id="${job.id||''}" data-revision="${job.revision||''}">${wechat?'<input type="hidden" name="sourceType" value="'+(job.sourceType==='qq'?'qq':'wechat')+'">':''}<p>${wechat?'群招聘消息已入库，岗位名称和公司可留空。可直接修改，或在岗位库删除不需要的信息。':'可粘贴来自微信群、BOSS 或登录后网站的岗位内容。岗位名称和公司必填。'}</p><div class="field-row">${entry('岗位名称','title',160,!wechat)}${entry('公司名称','company',160,!wechat)}</div><div class="field-row">${entry('工作地点','location',200)}${entry('类型（如实习 / 校招）','category',100)}</div><div class="field-row">${entry('薪资（原文）','salary',200)}${entry('截止日期','deadline',10,false,'date')}</div><div class="field-row">${entry('工作年限（原文）','experience',100)}<div class="field"><label for="job-recruitmentType">招聘类型</label><select id="job-recruitmentType" name="recruitmentType">${Object.entries({'':'未注明',campus:'校招 / 应届',social:'社招'}).map(([value,label])=>`<option value="${value}" ${job.recruitmentType===value?'selected':''}>${label}</option>`).join('')}</select></div></div><div class="field"><label for="job-employmentType">工作性质</label><select id="job-employmentType" name="employmentType">${Object.entries({'':'未注明',fulltime:'全职',internship:'实习'}).map(([value,label])=>`<option value="${value}" ${job.employmentType===value?'selected':''}>${label}</option>`).join('')}</select></div>${entry('岗位标签（原文）','jobTags',2000)}${entry('招聘批次','batch',100)}${entry('招聘公告','announcement',500)}<div class="field-row">${entry('企业性质','companyType',100)}${entry('行业','industry',150)}</div>${entry('网站更新时间','sourceUpdatedAt',10,false,'date')}${entry('公告链接','announcementUrl',2000,false,'url')}${entry('原岗位 / 投递链接','url',2000,false,'url')}${entry('来源名称','sourceName',120)}${state.capabilities?.appliedPosition?appliedPositionField(job):''}<div class="field"><label for="job-description">岗位 JD</label><textarea id="job-description" name="description" class="large" maxlength="30000">${e(job.description)}</textarea></div><div class="field"><label for="job-notes">个人备注</label><textarea id="job-notes" name="notes" maxlength="5000">${e(job.notes)}</textarea></div>${recruitmentForms}</form>`);
  if(announcement) {
    $('#job-form').dataset.announcement=announcement.id;
    $('#job-form').dataset.announcementRevision=announcement.revision;
    $('#modal-title').textContent='添加具体职位';
    $('#job-form p').textContent='所属公告：'+announcement.title+'。请按招聘原文填写这个职位的名称、JD 和申请链接；未注明的信息留空。';
    $('#job-company').required=false;
  }
  if(job.recordType==='position')$('#job-company').required=false;
}
function announcementDialog(announcement={}) {
  const input=(name,label,max=500,type='text')=>`<div class="field"><label for="announcement-${name}">${label}</label><input id="announcement-${name}" name="${name}" type="${type}" maxlength="${max}" ${name==='title'?'required':''} value="${e(announcement[name]||'')}"></div>`;
  modal(announcement.id?'编辑招聘公告':'录入招聘公告',`<form id="job-announcement-form" data-id="${announcement.id||''}" data-revision="${announcement.revision||0}"><p>公告可包含多个职位。先保存公告，再按原文添加具体职位；公司或职位尚不明确时保留未知。</p>${input('title','公告名称')}${input('company','公司（选填）',160)}${input('url','公告链接（选填）',2000,'url')}${input('sourceName','来源名称（选填）',120)}${input('deadline','公告截止日期（选填）',10,'date')}<div class="field"><label for="announcement-description">公告内容</label><textarea id="announcement-description" name="description" class="large" maxlength="30000">${e(announcement.description||'')}</textarea></div>${recruitmentForms}</form>`);
}
function announcementDetail(announcement) {
  const parent=state.jobs.find(j=>j.id===announcement.id), children=state.jobs.filter(j=>j.announcementId===announcement.id), oldApp=state.applications.find(a=>a.jobId===announcement.id);
  modal(announcement.title,`<p><span class="badge neutral">招聘公告</span> ${e(announcement.company||'公司未注明')} · ${children.filter(j=>!j.deletedAt).length} 个具体职位</p><div class="job-description preserve">${e(announcement.description||'尚未填写公告内容')}</div><p class="preserve">投递岗位：${e(parent?.appliedPosition || '尚未记录')}</p><details><summary>最初来源原文与链接（保留）</summary><p class="preserve">${e(announcement.sourceText||'未提供')}</p>${sourceLink(announcement.sourceUrl,'查看最初来源',parent)}</details><div class="actions">${sourceLink(announcement.url,'查看公告',parent)}${!parent?.deletedAt?button('编辑公告','job-announcement-edit','','edit',`data-id="${announcement.id}"`)+button('添加具体职位','job-position-new','primary','plus',`data-id="${announcement.id}"`):''}${oldApp?button('查看原有投递','application-detail','','file',`data-id="${oldApp.id}"`):''}${parent?.deletedAt?button('恢复公告','job-restore','','',`data-id="${announcement.id}"`):button(parent?.archived?'恢复公告':'归档公告','job-archive','subtle','',`data-id="${announcement.id}"`)}</div><p class="report-notice">每个具体职位分别保存 JD、申请链接和投递记录。原有投递历史仍保留在原记录。</p><div class="application-list">${children.map(job=>{const app=state.applications.find(a=>a.jobId===job.id);return `<article class="panel panel-body"><strong>${e(job.title)}</strong><p>${e(job.location||'地点未注明')} · ${job.deletedAt?'已在回收站':job.archived?'已归档':e(app?state.applicationStatuses[app.status]:'待投递')}</p><div class="actions">${button('职位详情','job-detail','small','file',`data-id="${job.id}"`)}${job.deletedAt?button('恢复','job-restore','small','',`data-id="${job.id}"`):button(app?'查看投递':'准备投递',app?'application-detail':'application-new','small primary','',`data-id="${app?.id||job.id}"`)}</div></article>`;}).join('')||'<p>尚未添加具体职位，请根据公告原文录入。</p>'}</div><div class="form-actions">${button('关闭','close-modal')}</div>`);
}
function jobRelationHTML(job) {
  const parent=(state.announcements||[]).find(a=>a.id===job.announcementId);
  return parent?`<p>所属公告：${button(e(parent.title),'job-detail','small','',`data-id="${parent.id}"`)}</p><details><summary>最初来源公告（保留）</summary><p>${e(job.announcement||'未注明')}</p>${sourceLink(job.announcementUrl,'最初来源公告',job)}</details><div class="actions">${button('更换 / 解除公告关联','job-attach','small','',`data-id="${job.id}"`)}</div>`:`<div class="actions">${button('作为招聘公告管理','job-promote','small','',`data-id="${job.id}"`)}${button('关联已有公告','job-attach','small','',`data-id="${job.id}"`)}</div>`;
}
function applicationOptions() {
  return '<option value="">暂不关联简历</option>' + state.resumes.map(r=>`<optgroup label="${e(r.name)}"><option value="${r.id}">${e(r.name)} · 原文 v${r.revision}</option>${r.reports.filter(report=>report.expert).map(report=>`<option value="${r.id}/${report.id}">草稿 · ${e(report.target?.company || report.target?.title || '通用评审')} · ${fmtDate(report.createdAt)}</option>`).join('')}</optgroup>`).join('');
}
function nextActionFields(app = {}) {
  return `<div class="field"><label for="next-action">下一步安排</label><input id="next-action" name="nextAction" maxlength="500" value="${e(app.nextAction)}" placeholder="例如：完成网申、准备笔试、跟进 HR"></div><div class="field"><label for="next-action-at">跟进时间（选填）</label><input id="next-action-at" name="nextActionAt" type="datetime-local" value="${dateTimeField(app.nextActionAt)}"></div><div class="field"><label for="application-note">本次进展 / 备注</label><textarea id="application-note" name="note" maxlength="5000"></textarea></div>`;
}
async function recruitmentAction(action, element) {
  if (!state.capabilities?.recruitment) throw new Error('请重启工作台服务并刷新，以启用岗位功能。');
  const id = element.dataset.id, job = (state.jobs || []).find(j=>j.id===id);
  if(action==='application-box') {
    applicationSearch={q:'',status:'',due:'',box:element.dataset.box==='trash'?'trash':'active'};
    await refresh();render();return;
  }
  if(['application-delete','application-restore','application-purge'].includes(action)) {
    if(!state.capabilities?.applicationRecycle)throw new Error('请重启工作台，启用投递回收站。');
    const app=[...(state.applications||[]),...(state.deletedApplications||[])].find(a=>a.id===id);
    if(!app)throw new Error('投递记录已变化，请刷新后重试。');
    if(action==='application-delete'&&!await confirmAction('删除投递记录','移入回收站后可恢复，原阶段、时间线和简历快照保留。岗位和邮件不会删除。','移入回收站'))return;
    if(action==='application-purge'&&!await confirmAction('彻底删除投递记录','将永久删除这条投递记录及其时间线、投递简历快照，无法恢复。岗位、原简历和邮件保留，旧邮件不会自动重新关联。','彻底删除'))return;
    try {
      await api('/api/applications/'+id,{method:action==='application-restore'?'PATCH':'DELETE',body:JSON.stringify({revision:app.revision,...(action==='application-restore'?{restore:true}:action==='application-purge'?{permanent:true,confirm:true}:{})})});
      $('#modal').close();await refresh();render();toast(action==='application-restore'?'已恢复到原阶段。':action==='application-purge'?'已彻底删除投递记录。':'已移入回收站。');
    }catch(error){await refresh();render();throw error;}
    return;
  }
  const announcement=(state.announcements||[]).find(a=>a.id===id);
  if(action==='job-announcement-new') {announcementDialog();return;}
  if(action==='job-announcement-edit') {announcementDialog(announcement);return;}
  if(action==='job-position-new') {
    jobDialog({company:announcement.company,sourceName:announcement.sourceName,announcement:announcement.title,announcementUrl:announcement.url},'',announcement);return;
  }
  if(action==='job-promote') {
    if(!job.announcement && !job.title) {
      modal('填写公告名称',`<form id="job-promote-form" data-id="${job.id}" data-revision="${job.revision}"><p>原记录未注明名称，请按原文填写公告名称。原文、链接和投递历史保留。</p><div class="field"><label for="promote-title">公告名称</label><input id="promote-title" name="title" required maxlength="500"></div>${recruitmentForms}</form>`);return;
    }
    if(!await confirmAction('作为招聘公告管理','此记录将作为公告展示，可在其下添加多个具体职位。原记录编号、来源内容和已有投递历史保留，不会自动生成职位。','确认作为公告'))return;
    const {announcement:created}=await api(`/api/jobs/${id}/announcement`,{method:'POST',body:JSON.stringify({revision:job.revision})});
    await refresh();render();announcementDetail(created);return;
  }
  if(action==='job-attach') {
    modal('关联招聘公告',`<form id="job-attach-form" data-id="${job.id}" data-revision="${job.revision}" data-current="${job.announcementId||''}"><p>将“${e(job.title||'岗位未注明')}”作为具体职位关联公告，原职位、投递和简历快照保留。</p><div class="field"><label for="job-parent">所属公告</label><select id="job-parent" name="announcementId"><option value="">不关联公告</option>${(state.announcements||[]).filter(a=>!state.jobs.find(j=>j.id===a.id)?.deletedAt).map(a=>`<option value="${a.id}" ${job.announcementId===a.id?'selected':''}>${e(a.title)}</option>`).join('')}</select></div>${recruitmentForms}</form>`);return;
  }
  if(action==='job-detail' && announcement) {announcementDetail(announcement);return;}
  if(action==='job-edit' && announcement) {announcementDialog(announcement);return;}
  if(action==='application-new' && announcement && !state.applications.some(a=>a.jobId===id)) {announcementDetail(announcement);toast('请先选择或添加具体职位，再准备投递。');return;}
  if(action==='job-wechat-link') {
    const url=element.dataset.url;
    if(!isWechatContactLink(url))throw new Error('无法识别该微信入口，请查看岗位原文。');
    const search=officialRecruitmentSearch({company:element.dataset.company});
    modal('这是微信联系入口',`<p>原文提供的是“添加微信后领取投递链接”的入口，并非招聘公告或网申页面。该网站要求使用手机微信，电脑浏览器会显示你看到的提示。</p><p>可以复制原链接到手机微信打开，或查找该公司的官方招聘网站。找到真实公告后，可通过“编辑岗位”保存链接。</p><div class="field"><label for="wechat-contact-url">原始链接（已保留）</label><input id="wechat-contact-url" readonly value="${e(url)}"></div><div class="form-actions">${button('复制原链接','job-copy-wechat-link','primary')}${search?`<a class="btn" href="${e(search)}" target="_blank" rel="noopener noreferrer">查找官方招聘 ↗</a>`:''}${button('关闭','close-modal')}</div>`);
    return;
  }
  if(action==='job-copy-wechat-link') {
    const input=$('#wechat-contact-url');
    if(!input)return;
    try {await navigator.clipboard.writeText(input.value);toast('原链接已复制，请在手机微信中打开。');}
    catch {input.focus();input.select();toast('浏览器未允许自动复制，链接已选中，请按 Ctrl+C。');}
    return;
  }
  if (action==='source-new' || action==='source-edit') { const source=state.jobSources.find(s=>s.id===id)||{}; modal(source.id?'编辑岗位来源':'添加岗位来源', `<form id="source-form" data-id="${source.id||''}" data-revision="${source.revision||1}"><p>填写公开岗位详情页或 JSON 数据源地址。需要登录的平台请使用“录入岗位 / 粘贴 JD”。</p><div class="field"><label for="source-name">来源名称</label><input id="source-name" name="name" required maxlength="120" value="${e(source.name)}"></div><div class="field"><label for="source-url">来源地址</label><input id="source-url" name="url" type="url" required maxlength="2000" value="${e(source.url)}"></div>${recruitmentForms}</form>`); return; }
  if (action==='source-open-job') { const result=await api('/api/job-sources/'+id+'/open',{method:'POST',body:JSON.stringify({url:element.dataset.url})});toast(result.message);return; }
  if (action==='source-auto') { if(!state.capabilities?.platformAutoCollect)throw Error('请先重新启动新版后台，加载自动拉取功能。');pullDialog(state.jobSources.find(s=>s.id===id),true);return; }
  if (action==='source-auto-pause') { const source=state.jobSources.find(s=>s.id===id);await api('/api/job-sources/'+id+'/automation',{method:'PUT',body:JSON.stringify({revision:source.revision||1,enabled:false})});await refresh();render();toast('自动拉取已暂停。');return; }
  if (action==='source-pull') { pullDialog(state.jobSources.find(s=>s.id===id)); return; }
  if (action==='source-login') { const result=await api('/api/job-sources/'+id+'/login',{method:'POST'}); toast(result.message); return; }
  if (action==='job-row-more') {
    const app=[...(state.applications||[]),...(state.deletedApplications||[])].find(a=>a.jobId===job.id);
    modal('岗位操作',`<p>${e(job.company)} · ${e(job.title)}</p><div class="form-actions">${app?button('查看投递','application-detail','','arrow',`data-id="${app.id}"`):''}${job.deletedAt?button('彻底删除','job-purge','danger','',`data-id="${job.id}" ${state.capabilities?.jobBatchTrash?'':'disabled'}`):button('删除','job-delete','danger','trash',`data-id="${job.id}"`)}${button('取消','close-modal')}</div>`);return;
  }
  if (action==='job-filter-load') {
    const filter=(state.savedJobFilters||[]).find(item=>item.id===$('#saved-job-filter').value);
    if(!filter)throw new Error('请先选择一个筛选组合。');
    selectedJobFilter=filter.id; jobSearch={q:filter.q,archived:filter.archived,kind:filter.kind||''};
    pendingHeaderFilters=filter.headerFilters;render();return;
  }
  if (action==='job-filter-save') {
    if(!state.capabilities?.jobColumnChoices&&jobGrid.getHeaderFilters().some(item=>Array.isArray(item.value)))throw new Error('请重启新版工作台后保存多选筛选；当前筛选已自动记在此浏览器中。');
    selectedJobFilter=$('#saved-job-filter').value;
    const saved=(state.savedJobFilters||[]).find(item=>item.id===selectedJobFilter);
    modal('保存当前筛选',`<form id="job-filter-save-form" data-id="${saved?.id||''}" data-revision="${saved?.revision||0}"><p>保存当前已应用的搜索、岗位范围、信息类型和表头筛选，供下次一键使用。</p><div class="field"><label for="job-filter-name">组合名称</label><input id="job-filter-name" name="name" maxlength="80" required value="${e(saved?.name||'')}"></div>${saved?'<label><input type="checkbox" name="replace"> 更新所选组合（不勾选则另存为新组合）</label>':''}${recruitmentForms}</form>`);return;
  }
  if (action==='job-filter-delete') {
    const filter=(state.savedJobFilters||[]).find(item=>item.id===$('#saved-job-filter').value);
    if(!filter)throw new Error('请先选择一个筛选组合。');
    if(!await confirmAction('删除筛选组合',`删除“${filter.name}”后，岗位和当前筛选条件仍保留。`,'删除组合'))return;
    await api('/api/job-filters/'+filter.id,{method:'DELETE',body:JSON.stringify({revision:filter.revision})});selectedJobFilter='';await refresh();render();return;
  }
  if(action==='job-box'){jobSearch={q:'',archived:element.dataset.box,kind:''};pendingHeaderFilters=[];render();return;}
  if(action==='job-select-all'){jobGrid?.selectRow('active');return;}
  if(action==='job-select-none'){jobGrid?.deselectRow();return;}
  if(action.startsWith('job-batch-')||action==='job-purge'){
    if(!state.capabilities?.jobBatchTrash)throw new Error('请先重启新版后台加载岗位回收站功能。');
    const mode=action==='job-purge'?'purge':action.slice('job-batch-'.length),rows=action==='job-purge'?[job]:jobGrid.getSelectedData().map(row=>row.job);
    if(!rows.length||rows.length>1000)throw new Error('请勾选 1 至 1000 条岗位。');
    const items=rows.map(j=>({id:j.id,revision:j.revision,announcementRevision:j.announcementRevision}));
    const title={trash:'批量删除岗位',restore:'恢复岗位',purge:'彻底删除岗位'}[mode];
    const note=mode==='purge'?'彻底删除后无法从回收站恢复。会清除所选岗位及关联采集原文，保留去重标识，后续相同信息不再入库；已有投递记录、简历快照和既有备份保留。':mode==='trash'?'所选岗位将移入回收站，可恢复。再次采集会跳过，已有投递记录保留。':'所选岗位将移出回收站，恢复到删除前的归档状态。';
    if(!await confirmAction(title,`确认处理 ${items.length} 条岗位？`+note,mode==='purge'?'确认彻底删除':mode==='trash'?'移入回收站':'确认恢复'))return;
    try{const result=await api('/api/jobs/batch',{method:'POST',body:JSON.stringify({action:mode,items,confirm:mode==='purge'})});await refresh();render();toast(`已处理 ${result.count} 条岗位。`);}catch(error){await refresh();render();throw error;}return;
  }
  if (action==='job-clear-filters') { pendingHeaderFilters=[];jobSearch={q:'',archived:jobSearch.archived,kind:''};selectedJobFilter='';render();return; }
  if (action==='job-export') { if (!jobGrid?.getDataCount('active')) { toast('没有可导出的岗位，请调整筛选。'); return; } jobGrid.download('csv','岗位列表-'+new Date().toISOString().slice(0,10)+'.csv',{bom:true},'active'); return; }
  if (action==='job-reset-layout') { jobGrid?.destroy(); jobGrid=null; for(const type of ['columns','sort','page']) { try { localStorage.removeItem((globalThis.cloudPrefix||'')+'tabulator-workbench-jobs-v1-'+type); } catch {} } render(); return; }
  if (action==='application-clear-filters') { applicationSearch={q:'',status:'',due:'',box:applicationSearch.box}; render(); return; }
  if (action==='application-view') { const form=$('#application-filter-form'); if(form) applicationSearch=Object.fromEntries(new FormData(form)); applicationView=element.dataset.mode==='list'?'list':'board'; savePreference('workbench-application-view',applicationView); render(); return; }
  if (action==='job-delete' || action==='job-restore') {
    if(action==='job-delete' && !await confirmAction('删除岗位','岗位将移入回收站，再次采集会跳过，不会重新入库；可手动恢复，投递记录与简历快照保留。','移入回收站')) return;
    await api('/api/jobs/'+id,{method:action==='job-delete'?'DELETE':'PATCH',body:JSON.stringify({revision:job.revision,...(action==='job-restore'?{restore:true}:{})})});
    await refresh(); render(); toast(action==='job-delete'?'已移入回收站。':'已恢复岗位。'); return;
  }
  if (action==='job-applied-position') {
    if(!state.capabilities?.appliedPosition)throw new Error('后台尚未加载投递岗位功能，请先重新启动工作台。');
    if(job.deletedAt)throw new Error('请先从回收站恢复岗位。');
    await editAppliedPosition(job,element);return;
  }
  if (action==='job-new') { jobDialog({},element.dataset.source||''); return; }
  if (action==='job-edit') { jobDialog(job); return; }
  if (action==='job-detail') { modal(job.title || job.announcement || '微信招聘信息', `<p><strong>${e(job.company)}</strong> · ${e(job.location || '地点未注明')} · ${e(job.category)}</p>${jobRequirementsHTML(job)}<p>${e(job.sourceName)}${job.deadline?' · 截止 '+e(job.deadline):''}</p><div class="job-description preserve">${e(job.description || '尚未填写 JD')}</div><p class="preserve">投递岗位：${e(job.appliedPosition || '尚未记录')}</p>${job.notes?`<p class="preserve">备注：${e(job.notes)}</p>`:''}${jobRelationHTML(job)}<div class="form-actions">${sourceLink(currentAnnouncement(job).url,'查看公告',job)}${sourceLink(job.url,'打开原岗位',job)}${button('编辑','job-edit','small','edit',`data-id="${job.id}"`)}${button('用于简历评审','job-review','small','spark',`data-id="${job.id}"`)}${button('准备投递','application-new','primary','arrow',`data-id="${job.id}"`)}${button(job.archived?'恢复岗位':'归档岗位','job-archive','small subtle','',`data-id="${job.id}"`)}</div>`); return; }
  if (action==='job-archive') { await api(`/api/jobs/${id}`,{method:'PATCH',body:JSON.stringify({revision:job.revision,archived:!job.archived})}); $('#modal').close(); await refresh(); render(); return; }
  if (action==='job-review') { $('#modal').close(); if(await go('reviews')) { reviewInput={resumeId:'',company:job.company.slice(0,120),title:job.title.slice(0,80),description:job.description.slice(0,10000),keywords:''}; reviewDirty=true; render(); if(job.description.length>10000) toast('JD 已带入前 10000 字，请按本次评审需要精简。'); } return; }
  if (action==='application-new') {
    const existing=[...(state.applications||[]),...(state.deletedApplications||[])].find(a=>a.jobId===id); if(existing) { await recruitmentAction('application-detail',{dataset:{id:existing.id}}); return; }
    modal('准备投递', `<form id="application-form" data-job="${id}"><p><strong>${e(job.company)} · ${e(job.title)}</strong></p><p>保存后建立“准备投递”记录。打开原岗位完成实际投递，再确认“已投递”。所选简历文字会保存独立快照。</p><div class="field"><label for="application-resume">投递使用的简历 / 草稿</label><select id="application-resume" name="resumeChoice">${applicationOptions()}</select></div><div class="field"><label for="application-channel">投递渠道</label><input id="application-channel" name="channel" maxlength="120" value="原岗位网站"></div>${nextActionFields()}${recruitmentForms}</form>`); return;
  }
  if (action==='application-detail' || action==='application-update') {
    const {application:app}=await api(`/api/applications/${id}`), statuses=state.applicationStatuses;
    if(action==='application-update'&&app.deletedAt)throw new Error('投递记录已在回收站，请先恢复。');
    if(action==='application-update') { modal('更新投递进展', `<form id="application-status-form" data-id="${id}" data-revision="${app.revision}"><p>${e(app.jobSnapshot.company || '公司未识别')} · ${e(app.jobSnapshot.title || '岗位未注明')}</p><p>请根据真实投递或收到的反馈确认状态；打开链接本身不代表已投递。</p><div class="field"><label for="application-status">当前状态</label><select id="application-status" name="status">${Object.entries(statuses).map(([key,label])=>`<option value="${key}" ${key===(element.dataset.status||app.status)?'selected':''}>${e(label)}</option>`).join('')}</select></div>${nextActionFields(app)}${recruitmentForms}</form>`); return; }
    modal('投递记录与时间线', `<h3>${e(app.jobSnapshot.company || '公司未识别')} · ${e(app.jobSnapshot.title || '岗位未注明')}</h3><p><span class="badge">${e(statuses[app.status])}</span> · ${e(app.channel)}</p><div class="actions">${applicationLink(app)}${app.deletedAt?button('恢复投递','application-restore','primary','',`data-id="${id}"`):button(app.status==='preparing'?'确认已投递':'更新进展','application-update','primary','check',`data-id="${id}" ${app.status==='preparing'?'data-status="submitted"':''}`)}</div><p class="report-notice">在原网站完成投递后再更新状态，本按钮不会代替网站提交申请。</p>${app.resumeSnapshot?`<details class="source-jd"><summary>投递简历快照：${e(app.resumeSnapshot.name)} · v${app.resumeSnapshot.revision}</summary><p class="preserve">${e(app.resumeSnapshot.text)}</p><a class="btn small" href="/api/applications/${id}/resume">下载投递文字快照</a></details>`:'<p>未关联简历快照。</p>'}<p>下一步：${e(app.nextAction||'尚未安排')}${app.nextActionAt?' · '+fmtDate(app.nextActionAt):''}</p><div class="application-timeline">${[...app.history].reverse().map(item=>`<article><strong>${e(statuses[item.status])}</strong><small>${fmtDate(item.at)}</small><p class="preserve">${e(item.note)}</p>${item.mailId?button('查看关联邮件','mail-open','small','',`data-id="${item.mailId}"`):''}</article>`).join('')}</div>`); return;
  }
}
async function recruitmentSubmit(form, fields) {
  if(form.id==='job-applied-position-form') {
    if(!state.capabilities?.appliedPosition)throw new Error('后台尚未加载投递岗位功能，请先重新启动工作台。');
    if(form.dataset.saving)return;
    form.dataset.saving='true';if(!form.dataset.autosave)form.inert=true;
    const grid=jobGrid;
    try {
      let job;
      try {
        const current=state.jobs.find(item=>item.id===form.dataset.id);
        if(current&&current.revision===Number(form.dataset.revision)&&current.appliedPosition===fields.appliedPosition.trim())job=current;
        else ({job}=await api('/api/jobs/'+form.dataset.id,{method:'PATCH',body:JSON.stringify({revision:Number(form.dataset.revision),appliedPosition:fields.appliedPosition})}));
      }
      catch(error) { throw new Error(error.message+' 本次输入仍保留；若记录已更新，请复制输入后刷新页面，核对最新内容再修改。'); }
      if(job.appliedPosition!==fields.appliedPosition.trim())throw new Error('后台未确认投递岗位内容，输入仍保留。请确认新版后台已启动后刷新核对。');
      state.jobs=state.jobs.map(item=>item.id===job.id?job:item);form.dataset.revision=job.revision;
      savePreference('workbench-applied-position-history',appliedPositionHistory(job.appliedPosition));
      if(!form.dataset.inline)$('#modal').close();
      if(form.dataset.autosave&&(form.contains(document.activeElement)||form.querySelector('textarea').value.trim()!==job.appliedPosition))return;
      const row=view==='jobs'&&jobGrid===grid&&grid?.getRow(job.id);
      if(row){
        const holder=$('#job-grid .tabulator-tableholder'),left=holder.scrollLeft,top=holder.scrollTop,page=grid.getPage();
        if(filteredJobs().some(item=>item.id===job.id)){
          await row.update({appliedPosition:job.appliedPosition,revision:job.revision,job});row.reformat();row.normalizeHeight();
        }else await row.delete();
        grid.refreshFilter();await grid.setPage(Math.min(page,grid.getPageMax()||1));
        holder.scrollLeft=left;holder.scrollTop=top;$('#job-scroll-top').scrollLeft=left;updateJobFilterSummary();
      }
      if(!form.dataset.autosave)toast('投递岗位已保存，求职进展保持不变。');
    } finally {delete form.dataset.saving;form.inert=false;}
    return;
  }
  if(form.id==='job-promote-form') {
    const {announcement}=await api(`/api/jobs/${form.dataset.id}/announcement`,{method:'POST',body:JSON.stringify({revision:Number(form.dataset.revision),title:fields.title})});
    await refresh();render();announcementDetail(announcement);return;
  }
  if(form.id==='job-announcement-form') {
    const {announcement}=await api('/api/announcements'+(form.dataset.id?'/'+form.dataset.id:''),{method:form.dataset.id?'PATCH':'POST',body:JSON.stringify({...fields,revision:Number(form.dataset.revision)})});
    await refresh();render();announcementDetail(announcement);toast('招聘公告已保存。');return;
  }
  if(form.id==='job-attach-form') {
    const parent=(state.announcements||[]).find(a=>a.id===fields.announcementId), previous=(state.announcements||[]).find(a=>a.id===form.dataset.current);
    await api(`/api/jobs/${form.dataset.id}/announcement`,{method:'PATCH',body:JSON.stringify({revision:Number(form.dataset.revision),announcementId:fields.announcementId,announcementRevision:parent?.revision,currentAnnouncementRevision:previous?.revision})});
    $('#modal').close();await refresh();render();toast('公告关联已保存。');return;
  }
  if(form.id==='job-form' && form.dataset.announcement) {
    const {announcement}=await api(`/api/announcements/${form.dataset.announcement}/jobs`,{method:'POST',body:JSON.stringify({...fields,revision:Number(form.dataset.announcementRevision)})});
    await refresh();render();announcementDetail(announcement);toast('具体职位已保存，可分别准备投递。');return;
  }
  if(form.id==='job-filter-save-form') {
    const id=fields.replace==='on'?form.dataset.id:'';
    const {filter}=await api('/api/job-filters'+(id?'/'+id:''),{method:id?'PATCH':'POST',body:JSON.stringify({name:fields.name,q:jobSearch.q||'',archived:jobSearch.archived||'',kind:jobSearch.kind||'',headerFilters:jobGrid.getHeaderFilters().map(({field,value})=>({field,value})),revision:Number(form.dataset.revision)})});
    selectedJobFilter=filter.id;$('#modal').close();await refresh();render();toast('筛选组合已保存。');return;
  }
  if(form.id.startsWith('mail-')) { await mailSubmit(form,fields); return; }
  if(form.id==='wechat-source-form') {
    await api(form.dataset.id?'/api/wechat/sources/'+form.dataset.id:'/api/wechat/sources',{method:form.dataset.id?'PATCH':'POST',body:JSON.stringify({...fields,enabled:fields.enabled==='on',revision:Number(form.dataset.revision)})});
    $('#modal').close();await refresh();render();toast('微信群采集配置已保存。');return;
  }
  if(form.id==='job-form' && form.dataset.wechatCandidate) {
    await api('/api/wechat/candidates/'+form.dataset.wechatCandidate+'/import',{method:'POST',body:JSON.stringify(fields)});await refresh();render();await wechatInbox();toast('岗位已核对入库。');return;
  }
  if(form.id==='source-auto-form') {
    const {intervalMinutes,...conditions}=fields;
    await api('/api/job-sources/'+form.dataset.id+'/automation',{method:'PUT',body:JSON.stringify({revision:Number(form.dataset.revision),enabled:true,intervalMinutes:Number(intervalMinutes),conditions})});
    $('#modal').close();await refresh();render();toast('自动拉取已启用，后台将在 10 秒内开始，新增岗位直接入库。');return;
  }
  if(form.id==='source-pull-form') {
    const source=state.jobSources.find(s=>s.id===form.dataset.id); source.lastConditions=fields;
    const progress=form.querySelector('#pull-progress'); progress.textContent='正在拉取，请保留采集窗口，通常需要数十秒…';
    let polling=false;
    const timer=setInterval(async()=>{if(polling)return;polling=true;try{const {source:item}=await api('/api/job-sources/'+source.id+'/status');if(progress.isConnected)progress.textContent=item.lastResult;}catch{}finally{polling=false;}},2500);
    try { const result=await api('/api/job-sources/'+source.id+'/pull',{method:'POST',body:JSON.stringify(fields)});await refresh();render();showSourcePreview(result); }
    finally {clearInterval(timer);if(progress.isConnected)progress.textContent='';}
    return;
  }
  if(form.id==='job-filter-form') { if(fields.archived!==jobSearch.archived)pendingHeaderFilters=[];jobSearch=fields;render();return; }
  if(form.id==='application-filter-form') { applicationSearch={q:'',status:'',due:'',...fields}; render(); return; }
  if(form.id==='source-form') await api(form.dataset.id?`/api/job-sources/${form.dataset.id}`:'/api/job-sources',{method:form.dataset.id?'PATCH':'POST',body:JSON.stringify({...fields,revision:Number(form.dataset.revision)})});
  if(form.id==='job-form') await api(form.dataset.id?`/api/jobs/${form.dataset.id}`:'/api/jobs',{method:form.dataset.id?'PATCH':'POST',body:JSON.stringify({...fields,...(!form.dataset.id?{recordType:'position'}:{}),revision:Number(form.dataset.revision)})});
  if(form.id==='source-import-form') { const jobs=sourcePreview.filter((_,i)=>fields[`job-${i}`]); if(!jobs.length) throw new Error('请至少选择一个未入库岗位。'); const result=await api('/api/jobs/import',{method:'POST',body:JSON.stringify({jobs})}); toast(`新增 ${result.inserted} 个岗位，跳过 ${result.duplicates} 个重复岗位。`); }
  if(form.id==='application-form') {
    const [resumeId,reportId]=fields.resumeChoice.split('/'), resume=state.resumes.find(r=>r.id===resumeId), report=resume?.reports.find(r=>r.id===reportId);
    const result=await api('/api/applications',{method:'POST',body:JSON.stringify({...fields,jobId:form.dataset.job,resumeId,reportId,resumeRevision:resume?.revision,workspaceVersion:report?.workspace?.version||0,nextActionAt:fields.nextActionAt?new Date(fields.nextActionAt).toISOString():''})});
    $('#modal').close(); await refresh(); render(); await recruitmentAction('application-detail',{dataset:{id:result.application.id}}); return;
  }
  if(form.id==='application-status-form') await api(`/api/applications/${form.dataset.id}`,{method:'PATCH',body:JSON.stringify({...fields,revision:Number(form.dataset.revision),nextActionAt:fields.nextActionAt?new Date(fields.nextActionAt).toISOString():''})});
  $('#modal').close(); await refresh(); render(); if(form.id!=='source-import-form') toast('已保存到工作台。');
}


const fullDate=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'尚无记录';
function wechatCoverageHTML(s) {
 const reset=s.incrementalResetRequired?`<p class="risk-note">读取位置与本机历史不再一致，请先核对微信同步情况。</p>${button('重建读取起点','wechat-reset-cursor','small','',`data-id="${s.id}"`)}`:'';
 const c=s.lastCoverage;if(!c)return reset+'<p class="muted">历史采集未记录可确认的时间覆盖，下次成功采集后显示。</p>';
 const continuity=c.continuity==='baseline'?'已从最近一批建立起点，更早历史不在本次覆盖内。':c.incremental?'已核对上次读取位置，按本机已同步记录增量读取。':'';
 const limit=c.hasMore?'还有新增消息待补读，请点击“继续补读”。':c.incremental?'本批已读到当前本机记录末尾；未同步消息不在范围内。':c.limitReached?'已达到条数上限，可能遗漏更早消息。':'未达到条数上限，仍不代表历史消息完整。';
 return `${reset}<div class="coverage-note"><strong>上次成功采集：实际读取 ${c.readCount} / ${c.limit} 条</strong><p>${continuity} ${limit}</p><p>${c.datedCount?`可确认时间：${e(fullDate(c.from))} 至 ${e(fullDate(c.to))}（${c.datedCount} 条）`:'本批没有带完整日期的消息，无法显示时间范围。'}</p><small>${c.unknownTimeCount} 条时间无法确认；不推断“昨天”或只有时分的记录。${s.lastError?'最近一次尝试失败，上述为此前成功记录。':''}</small></div>`;
}
function sourceStatusTable() {
 const wx=state.wechat?.sources||[];
 const rows=(state.jobSources||[]).map(s=>{
  const w=wx.find(w=>w.id===s.id);return w?{...w,next:w.nextRunAt,action:'wechat-pull',label:'采集 / 重试'}:{...s,next:'',action:'source-pull',label:'拉取 / 重试'};
 });
 const m=state.mail;
 if(m)rows.push({...m,id:'mail',name:'QQ 邮箱',next:m.enabled&&m.hasSecret?(m.lastAttemptAt?new Date(new Date(m.lastAttemptAt).getTime()+m.interval*60000).toISOString():new Date().toISOString()):'',action:'mail-sync',label:'同步 / 重试'});
 return `<p class="report-notice">自动任务需要后台运行。微信数据库采集不占用窗口，仅读取本机已同步消息；界面采集仍需桌面解锁。到达计划时间不代表执行成功，未同步的历史不在采集范围内。</p><div class="table-scroll"><table class="review-table"><thead><tr><th>来源</th><th>上次成功</th><th>下次执行</th><th>当前情况 / 失败原因</th><th>操作</th></tr></thead><tbody>${rows.map(s=>`<tr><td>${e(s.name)}</td><td>${e(fullDate(s.lastSuccessAt))}</td><td>${s.next?e(fullDate(s.next)):s.type==='wechat'||s.id==='mail'?'已暂停或未配置':'手动执行'}</td><td>${s.running?'执行中':s.lastError?`<span class="risk-note">${e(s.lastError)}</span>`:new Date(s.lastStartedAt||s.lastAttemptAt||0)>new Date((s.id==='mail'?s.lastAttemptAt:s.lastCheckedAt)||0)?'上次执行未返回结果，可能因后台关闭而中断；请重试。':s.next&&new Date(s.next)<=new Date()?'已到计划时间，等待后台执行':e(s.lastResult||'尚未执行')}</td><td>${button(s.label,s.action,'small','','data-id="'+s.id+'" '+(s.running?'disabled':''))}</td></tr>`).join('')}</tbody></table></div>`;
}
async function runtimeAction(action) {
 if(action==='runtime-refresh'){await refresh();render();return;}
 if(action==='runtime-backup'){const result=await api('/api/backups',{method:'POST'});await refresh();render();toast('备份已生成并通过完整性检查：'+result.name);}
}
function runtimeView() {
 const r=state.runtime,b=r?.backups;
 return heading('运行与备份','查看后台、凭据保存和来源执行状态。',button('刷新状态','runtime-refresh'))+`<section class="panel home-panel"><h2>后台状态</h2><p>本次检查连接正常${r?` · 进程 ${r.processId} · 启动于 ${e(fullDate(r.startedAt))}`:' · 尚未加载本次运行状态功能'}</p><p>模型密钥：${state.settings.keySaved?'已加密保存，可在同一 Windows 用户下恢复':state.settings.hasKey?'仅在内存，重启前请在分析设置勾选加密保存':'尚未配置'} · QQ 授权码：${state.mail?.hasSecret?(state.mail.remember?'已加密保存':'仅本次运行有效'):'尚未配置'}</p><details><summary>网页打不开 / 更新后没有生效</summary><p>刷新网页不会重启后台。服务停止时，双击项目内“启动工作台.cmd”。已有旧后台时，先确认没有正在分析、采集、同步或备份，再手动结束对应工作台进程，随后运行启动脚本。不要结束其他 Node 程序。</p><p>启动失败请查看 data/server.err.log；也可在项目目录运行 npm.cmd start 查看错误。这里不提供自动停止或重启按钮。</p></details></section>${b?`<section class="panel home-panel"><h2>本地备份</h2><p>后台运行时每天备份一次，启动后一分钟内检查；自动快照保留最近 ${b.retention} 份，手动备份保留。采用 SQLite 在线备份，不中断工作台。</p><p>上次成功：${e(fullDate(b.lastSuccessAt))} · 下次检查目标：${e(fullDate(b.nextRunAt))}</p>${b.lastError?`<p class="risk-note">${e(b.lastError)}</p>`:''}<p class="preserve">目录：${e(b.directory)}</p>${button(b.running?'正在备份…':'立即备份','runtime-backup','primary','',b.running?'disabled':'')}<div class="table-scroll"><table class="review-table"><thead><tr><th>备份文件</th><th>时间</th><th>大小 / 类型</th></tr></thead><tbody>${b.backups.map(f=>`<tr><td>${e(f.name)}</td><td>${e(fullDate(f.createdAt))}</td><td>${e(fmtSize(f.bytes))} · ${f.automatic?'自动':'手动'}</td></tr>`).join('')||'<tr><td colspan="3">尚无受管理的备份。此前备份仍在 data/backups 原目录。</td></tr>'}</tbody></table></div><details><summary>恢复流程（先恢复到新目录）</summary><ol><li>在项目目录打开终端，运行：<code>node scripts/restore-backup.mjs "备份文件完整路径" "尚不存在的新目录"</code>。脚本先检查完整性，拒绝覆盖已有目录。</li><li>确认恢复结果后，停止当前后台。在 PowerShell 中设置 <code>$env:WORKBENCH_DATA_DIR="恢复目录"</code>，再运行 <code>npm.cmd start</code>。</li><li>核对简历、岗位、历史和提醒，再决定是否继续使用恢复目录。原 data 目录保持不变；恢复数据中的自动采集配置仍会生效。</li></ol><p>备份含简历原件、数据及加密凭据；仅当前 Windows 用户可恢复凭据。微信 Python 组件和独立浏览器登录资料不在 SQLite 备份中。启动脚本沿用环境变量，换终端后需重新指定恢复目录。</p></details></section>`:'<section class="panel home-panel">备份功能尚未加载，请按上方说明更新后台。</section>'}<section class="panel home-panel"><h2>来源执行情况</h2>${sourceStatusTable()}</section>`;
}
let scanRows=[];
async function scanInbox(){
 const result=await api('/api/mail/scans');scanRows=result.scans;
 modal('近期扫描结果',`<p>最多保留最近 ${result.limit} 条扫描预览（含私人邮件纯文本），${result.days} 天后在后台运行或下次访问时清理。求职邮件入库后单独保留。扫描按各文件夹 UID 顺序、每文件夹每批 ${state.mail.limit} 封；不代表邮箱全部邮件。</p><p>当前重新识别范围：最近 ${state.mail.days} 天。超过 2 MB 或解析失败的正文需到 QQ 邮箱查看。</p><div class="actions">${button('从头重新识别范围','mail-rescan')}${state.mail.rescanSince?button('继续此轮重新识别','mail-rescan-more'):''}${button('清空扫描预览','mail-scan-clear','subtle')}</div><div class="table-scroll"><table id="mail-scan-table" class="review-table"><thead><tr><th>邮件</th><th>文件夹 / 扫描时间</th><th>识别或过滤原因</th><th>操作</th></tr></thead><tbody>${scanRows.map(s=>`<tr><td>${e(s.mail?.subject||'正文未读取')}<p>${e(s.mail?.from||'')}</p></td><td>${e(s.folder)}<p>${e(fmtDate(s.scannedAt))}</p></td><td>${e(s.reason)}</td><td>${s.mail?button('查看原文','mail-scan-open','small','','data-id="'+s.id+'"'):''}</td></tr>`).join('')||'<tr><td colspan="4">暂无预览；同步或重新识别后可查看。</td></tr>'}</tbody></table></div>`);
}
function mailReminderHTML(m){
 if(!state.mail.phase1)return '';
 return `<h3>时间与准备事项</h3><p class="muted">只有明确年月日、时分和时区才自动确定时间。手工确认 / 延后按本机时区 ${e(Intl.DateTimeFormat().resolvedOptions().timeZone)} 输入。</p>${(m.reminders||[]).map(r=>`<form id="mail-reminder-${r.id}" data-id="${m.id}" data-revision="${m.revision}" data-reminder="${r.id}"><p><strong>${e(r.kind)}</strong> · ${m.completedAt?'已随邮件完成':r.done?'已完成':r.needsConfirmation?'待确认':e(fmtDate(r.dueAt))}</p><blockquote class="preserve">${e(r.evidence)}</blockquote>${r.reason&&r.needsConfirmation?`<small>${e(r.reason)}</small>`:''}<div class="field"><label for="time-${r.id}">确认 / 延后时间</label><input id="time-${r.id}" name="dueAt" type="datetime-local" required value="${r.dueAt?e(localDateTime(r.dueAt)):''}"></div><button class="btn small" type="submit">保存提醒时间</button>${m.completedAt?'':button(r.done?'恢复待办':'完成','mail-todo-done','small','','data-mail="'+m.id+'" data-id="'+r.id+'" data-revision="'+m.revision+'" data-done="'+!r.done+'"')}</form>`).join('')||'<p>未提取出时间；请核对正文，必要时在投递记录设置跟进。</p>'}<details><summary>地点、链接与准备材料（原文）</summary><div class="preserve">${e([...new Set((m.eventDetails||(m.reminders||[]).flatMap(r=>r.details||[])))].join('\n')||'未提取到相关内容，请查看正文。')}</div></details>`;
}
function localDateTime(value){const d=new Date(value);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}
let mailFilter={q:'',status:'',category:'',completion:'active',offset:0},mailLoad=0;
let mailRows=[],mailPendingPurge=[];
function mailCompletionButton(m){
 if(state.mail?.mailRecycle){
   const trash=!!(m.completedAt||m.deletedAt),attrs='data-id="'+m.id+'" data-revision="'+m.revision+'"';
   return button(trash?'恢复':'完成','mail-batch','small','',attrs+' data-operation="'+(trash?'restore':'complete')+'"')+button(trash?'彻底删除':'删除','mail-batch','small danger','',attrs+' data-operation="'+(trash?'purge':'delete')+'"');
 }
 return state.mail?.mailCompletion?button(m.completedAt?'恢复':'完成','mail-complete','small','','data-id="'+m.id+'" data-revision="'+m.revision+'" data-completed="'+!m.completedAt+'"'):'';
}
function mailBatchControls(result){
 if(!state.mail?.mailRecycle)return '';
 const trash=mailFilter.box==='trash';
 return `<div class="mail-list-top"><div class="actions mail-box-tabs" aria-label="邮件列表">${button('通知列表','mail-box',trash?'small':'small primary','','data-box="inbox" aria-pressed="'+!trash+'"')}${button('回收站 '+result.trashTotal,'mail-box',trash?'small primary':'small','','data-box="trash" aria-pressed="'+trash+'"')}</div><span class="mail-hint">${trash?'仅收纳已完成、已删除邮件':'完成或删除后，可在回收站恢复'}</span></div>
 ${mailCategoryControls(result)}<div class="mail-bulk-row"><div class="actions" aria-label="批量处理"><span id="mail-selection-count">已选 0 封</span>${Object.entries(trash?{restore:'批量恢复',purge:'批量彻底删除'}:{complete:'批量完成',delete:'批量删除'}).map(([key,label])=>button(label,'mail-batch','small'+(['delete','purge'].includes(key)?' danger':''),'','data-operation="'+key+'" data-mail-bulk disabled')).join('')}<span class="mail-hint">仅处理本页勾选</span></div><span class="mail-hint">共 ${result.total} 封</span></div>`;
}
function selectedMailItems(){
 const ids=new Set([...document.querySelectorAll('[data-mail-select]:checked')].map(el=>el.dataset.mailSelect));
 return mailRows.filter(m=>ids.has(m.id)).map(m=>({id:m.id,revision:m.revision}));
}
function updateMailSelection(){
 const count=selectedMailItems().length,all=$('#mail-select-all');
 if($('#mail-selection-count'))$('#mail-selection-count').textContent='已选 '+count+' 封';
 document.querySelectorAll('[data-mail-bulk]').forEach(el=>el.disabled=!count);
 if(all){all.checked=mailRows.length>0&&count===mailRows.length;all.indeterminate=count>0&&count<mailRows.length;}
}
async function processMailBatch(operation,items,confirm=false){
 try{await api('/api/mail/messages/batch',{method:'POST',body:JSON.stringify({action:operation,items,confirm})});}
 catch(error){if($('#modal').open)$('#modal').close();if(view==='mail')await loadMail();throw error;}
 mailPendingPurge=[];if($('#modal').open)$('#modal').close();
 await refresh();if(view==='mail')await loadMail();
 toast(items.length+' 封邮件'+({complete:'已完成并移入回收站',delete:'已移入回收站',restore:'已恢复到原分类',purge:'已从工作台彻底删除'})[operation]+'。');
}
function qqMailboxLink(m){return button('QQ 原邮件 ↗','mail-open-qq','small','','data-id="'+m.id+'" title="在工作台 QQ 窗口定位并打开对应原邮件"');}
function mailCategoryControls(result){
 const labels=state.mail?.notificationCategories;if(!labels)return '';
 const counts=result.counts||{},total=(mailFilter.box==='trash'?Object.keys(labels):['assessment','interview','uncategorized']).reduce((n,k)=>n+(counts[k]||0),0);
 return `<div class="actions mail-categories" aria-label="通知分类">${Object.entries({'':mailFilter.box==='trash'?'全部邮件':'全部通知',...labels}).map(([key,label])=>button(e(label)+' <span class="mail-category-count">'+(key?counts[key]||0:total)+'</span>','mail-category',mailFilter.category===key?'small primary':'small','','data-category="'+key+'" aria-pressed="'+(mailFilter.category===key)+'"')).join('')}</div>`;
}
function mailCategoryForm(m){
 const labels=state.mail?.notificationCategories;if(!labels)return '';
 return `<form id="mail-category-form" data-id="${m.id}" data-revision="${m.revision}"><div class="field"><label for="mail-category-edit">通知分类</label><select id="mail-category-edit" name="category">${Object.entries({auto:'自动识别',...labels}).map(([key,label])=>`<option value="${key}" ${key===(m.categoryOverride||'auto')?'selected':''}>${e(label)}</option>`).join('')}</select><small>当前：${e(labels[m.category]||'未分类')} · ${e(m.categoryReason)}。调整分类不改变投递进展。</small></div><button type="submit" class="btn small">保存分类</button><div class="inline-error" role="alert"></div></form>`;
}
function mailView(){
 const c=state.mail;
 if(!c)return heading('邮箱追踪','请重启工作台服务后使用。');
 return `<div class="mail-heading">${heading('邮箱追踪','集中查看测评、面试与求职通知。',button('配置邮箱','mail-config','','settings')+button(c.running?'正在同步…':'立即同步','mail-sync','primary','download',c.running?'disabled':''))}</div>
 ${!c.mailRecycle?'<p class="callout">批量处理和回收站需要重启工作台后台后使用。</p>':''}
 <section class="panel mail-account-card" aria-label="邮箱同步状态">
   <div class="mail-account-top"><div class="mail-account-identity"><span class="mail-account-icon">${icon('note')}</span><div><strong>${e(c.account||'尚未配置邮箱')}</strong><div class="mail-account-meta"><span>${e((c.folders||[c.folder]).filter(Boolean).join('、'))}</span><span>${c.enabled?'每 '+c.interval+' 分钟同步':'自动同步已暂停'}</span><span>${c.hasSecret?'已授权':'未配置授权码'}</span></div></div></div><span class="mail-last-sync">上次同步 ${c.lastSuccessAt?e(fmtDate(c.lastSuccessAt)):'尚无记录'}</span></div>
   <div class="mail-account-bottom"><p>${e(c.lastResult||(c.account?'点击“立即同步”获取邮件':'先配置 QQ 邮箱，开始接收求职通知'))}${c.remaining?`<span class="mail-remaining">还有 ${c.remaining} 封待扫描</span>`:''}</p>${c.phase1?`<div class="actions mail-secondary-actions">${button('扫描记录','mail-scans','small subtle','','title="查看扫描结果，找回漏判邮件"')}${button('重新匹配投递','mail-rematch','small subtle')}</div>`:''}</div>
   ${c.lastError?`<p class="risk-note mail-status-warning" role="alert">${e(c.lastError)}</p>`:''}${c.warning?`<p class="risk-note mail-status-warning">${e(c.warning)}</p>`:''}
 </section>
 <form id="mail-filter-form" class="mail-search-bar">
   <div class="field mail-search-field"><label for="mail-search">搜索邮件</label><input id="mail-search" name="q" placeholder="主题、发件人或正文关键词" value="${e(mailFilter.q)}"></div>
   <div class="field mail-range-field"><label for="mail-stage">邮件范围</label><select id="mail-stage" name="status">${Object.entries({'':mailFilter.box==='trash'?'全部回收邮件':'未忽略邮件',pending:'待同步进展',unlinked:'未关联投递',...state.applicationStatuses,ignored:'已忽略'}).map(([v,label])=>`<option value="${v}" ${mailFilter.status===v?'selected':''}>${e(label)}</option>`).join('')}</select></div>
   ${!c.mailRecycle&&c.mailCompletion?`<div class="field"><label for="mail-completion">处理状态</label><select id="mail-completion" name="completion">${Object.entries({active:'未完成',completed:'已完成',all:'全部状态'}).map(([key,label])=>`<option value="${key}" ${mailFilter.completion===key?'selected':''}>${label}</option>`).join('')}</select></div>`:''}
   <div class="actions mail-search-actions"><button class="btn" type="submit">筛选</button>${button('刷新','mail-refresh','subtle')}</div>
 </form><section class="panel mail-list-panel" id="mail-list" role="status">正在读取本地邮件…</section>`;
}
async function loadMail(){
 if(state.mail?.mailRecycle){mailFilter.box||='inbox';mailFilter.completion='all';}
 const serial=++mailLoad,result=await api('/api/mail/messages?'+new URLSearchParams(mailFilter));if(serial!==mailLoad||view!=='mail'||!$('#mail-list'))return;
 mailFilter.offset=result.offset??mailFilter.offset;
 if(state.mail?.mailRecycle)mailRows=result.messages;
 $('#mail-list').innerHTML=`${state.mail?.mailRecycle?mailBatchControls(result):mailCategoryControls(result)}<div class="table-scroll"><table class="review-table"><thead><tr>${state.mail?.mailRecycle?'<th class="mail-select-column"><input type="checkbox" id="mail-select-all" aria-label="全选本页邮件" '+(result.messages.length?'':'disabled')+'></th>':''}<th>邮件 / 发件人</th><th>收件时间</th><th>通知分类 / 进展</th><th>关联投递</th><th>操作</th></tr></thead><tbody>${result.messages.map(m=>{const a=[...state.applications,...(state.deletedApplications||[])].find(a=>a.id===m.applicationId);return `<tr>${state.mail?.mailRecycle?`<td><input type="checkbox" data-mail-select="${m.id}" aria-label="选择邮件：${e(m.subject)}"></td>`:''}<td><button class="text-link" data-action="mail-open-qq" data-id="${m.id}" title="在 QQ 邮箱打开这封邮件"><strong>${e(m.subject)}</strong></button><p>${e(m.from)}</p><small>${e(m.account)}</small></td><td>${e(fmtDate(m.date))}</td><td>${m.category?`<span class="badge neutral" title="${e(m.categoryReason)}">${e(state.mail?.notificationCategories?.[m.category]||'未分类')}</span><p>${e(state.applicationStatuses[m.suggestedStatus]||'进展待确认')}</p>`:e(state.applicationStatuses[m.suggestedStatus]||'未识别阶段')}<p class="muted">${m.deletedAt?'已删除 · '+e(fmtDate(m.deletedAt)):m.completedAt?'已完成 · '+e(fmtDate(m.completedAt)):m.appliedAt?'已同步进展':m.ignored?'已忽略':'待查看'}</p></td><td>${a?e(a.jobSnapshot.company+' · '+(a.jobSnapshot.title||'岗位未注明')+(a.deletedAt?'（投递已删除）':'')):'未关联'}</td><td><div class="actions">${button('查看 / 同步','mail-open','small','','data-id="'+m.id+'"')}${mailCompletionButton(m)}${qqMailboxLink(m)}</div></td></tr>`;}).join('')||'<tr><td colspan="'+(state.mail?.mailRecycle?6:5)+'">没有符合条件的邮件。</td></tr>'}</tbody></table></div><div class="mail-pagination"><span class="mail-hint">共 ${result.total} 封 · 当前第 ${Math.floor(mailFilter.offset/50)+1} 页</span><div class="actions">${button('上一页','mail-prev','small','',mailFilter.offset?'':'disabled')}${button('下一页','mail-next','small','',mailFilter.offset+50<result.total?'':'disabled')}</div></div>`;
}
function mailSettings(){if(state.local){cloud.mailSettings();return;}const c=state.mail;modal('配置 QQ 邮箱',`<form id="mail-settings-form" data-revision="${c.revision}">${qqMailSetupGuide()}<div class="field"><label for="mail-account">QQ / Foxmail 邮箱地址</label><input id="mail-account" name="account" type="email" required maxlength="160" value="${e(c.account)}"></div><div class="field"><label for="mail-code">邮箱授权码</label><input id="mail-code" name="authorizationCode" type="password" autocomplete="new-password" maxlength="256" placeholder="${c.hasSecret?'已配置，同一邮箱留空保留':'填写邮箱生成的授权码'}"></div><div class="field"><label for="mail-folder">邮件文件夹</label><input id="mail-folder" name="folder" required maxlength="80" value="${e(c.folder)}"><small>INBOX 为收件箱。先保存邮箱与授权码，再读取实际文件夹；可多选，最多 10 个。每批条数按各文件夹分别计算。</small>${c.phase1?button("读取实际文件夹","mail-folders")+'<div id="mail-folder-options"></div>':''}</div><div class="field-row"><div class="field"><label for="mail-days">首次同步范围</label><select id="mail-days" name="days">${[7,30,90].map(d=>`<option ${c.days===d?'selected':''} value="${d}">最近 ${d} 天</option>`).join('')}</select></div><div class="field"><label for="mail-limit">每次最多扫描</label><input id="mail-limit" name="limit" type="number" min="1" max="200" value="${c.limit}"></div><div class="field"><label for="mail-interval">自动同步间隔</label><select id="mail-interval" name="interval">${[15,30,60].map(d=>`<option ${c.interval===d?'selected':''} value="${d}">${d} 分钟</option>`).join('')}</select></div></div><div class="field"><label><input type="checkbox" name="enabled" ${c.enabled||!c.account?'checked':''}>启用自动同步（工作台后台需运行）</label></div><div class="field"><label><input type="checkbox" name="remember" ${c.remember||!c.account?'checked':''}>使用 Windows 加密记住授权码</label><small>仅当前 Windows 用户可解密；不勾选则仅保留在内存，服务重启需重新输入。</small></div><div class="field"><label><input type="checkbox" name="clearSecret">清除已保存授权码并暂停同步</label></div><p class="muted">固定使用 imap.qq.com:993 加密连接。每封最多读取 2 MB，附件不保存、不执行；大邮件会提示在 QQ 邮箱查看。</p>${recruitmentForms}</form>`);}
async function openMail(id){await refresh();const {message:m}=await api('/api/mail/messages/'+id);const app=[...state.applications,...(state.deletedApplications||[])].find(a=>a.id===m.applicationId);modal('求职邮件',`<h3>${e(m.subject)}</h3><p>${e(m.from)} · ${e(fmtDate(m.date))}</p><div class="actions">${qqMailboxLink(m)}${button('复制邮件主题','mail-copy-subject','small','','data-subject="'+e(m.subject)+'"')}${mailCompletionButton(m)}</div><p class="muted">${state.mail?.mailRecycle?(m.completedAt||m.deletedAt?'邮件已在回收站，可恢复后继续处理。':'完成或删除后可在回收站找回。'):(m.completedAt?'已完成于 '+e(fmtDate(m.completedAt))+'；可点击恢复重新处理。':'完成后可在“处理状态 → 已完成”中找回。')} 可打开 QQ 邮箱并复制主题查找原邮件。</p><details open><summary>邮件正文（纯文本）</summary><div class="preserve job-description">${e(m.text||'无可读正文，请在 QQ 邮箱查看。')}</div></details>${mailCategoryForm(m)}${mailReminderHTML(m)}<form id="mail-link-form" data-id="${m.id}" data-revision="${m.revision}"><div class="field"><label for="mail-application">关联投递记录</label><select id="mail-application" name="applicationId"><option value="">暂不关联</option>${app?.deletedAt?`<option value="${app.id}" selected disabled>${e(app.jobSnapshot.company)} · 投递已删除，请先恢复</option>`:''}${state.applications.map(a=>`<option value="${a.id}" ${m.applicationId===a.id?'selected':''}>${e(a.jobSnapshot.company)} · ${e(a.jobSnapshot.title||'岗位未注明')} · ${e(state.applicationStatuses[a.status])}</option>`).join('')}</select><small>匹配到多个岗位时需自行选择。没有投递记录时，先打开岗位详情，再点击“准备投递”。</small></div><div class="field"><label for="mail-status">同步为以下进展</label><select id="mail-status" name="status">${Object.entries(state.applicationStatuses).map(([key,label])=>`<option value="${key}" ${key===(m.suggestedStatus||app?.status||'communicating')?'selected':''}>${e(label)}</option>`).join('')}</select><small>识别建议：${e(state.applicationStatuses[m.suggestedStatus]||'无法确定')}。请以邮件实际内容为准，尤其注意旧邮件和终止状态。</small>${state.mail.phase1?'<label><input type="checkbox" name="confirmProgress"> 已核对邮件日期和当前阶段，确认旧邮件 / 阶段倒退仍需同步</label>':''}</div><div class="inline-error" role="alert"></div><div class="form-actions">${m.appliedAt?`<span>已于 ${e(fmtDate(m.appliedAt))} 同步为${e(state.applicationStatuses[m.appliedStatus])}</span>${m.appliedRevision?button("撤销此次进展","mail-undo"):""}`:`<button class="btn" type="submit">仅保存关联</button>${button('同步此进展','mail-apply','primary')}`}${button(m.ignored?'恢复邮件':'忽略邮件','mail-ignore','subtle','','data-id="'+m.id+'" data-revision="'+m.revision+'" data-ignored="'+!m.ignored+'"')}${button('关闭','close-modal')}</div></form>`);}
async function mailSubmit(form,fields){
 if(form.id==='mail-filter-form'){mailFilter={...mailFilter,...fields,offset:0};await loadMail();return;}
 if(form.id==='mail-category-form'){await api('/api/mail/messages/'+form.dataset.id,{method:'PATCH',body:JSON.stringify({revision:Number(form.dataset.revision),category:fields.category})});await openMail(form.dataset.id);if(view==='mail')await loadMail();toast('邮件分类已保存。');return;}
 if(form.id==='mail-settings-form'){if(state.mail.phase1){const options=[...form.querySelectorAll('[name=folderChoice]:checked')];if(form.querySelector('#mail-folder-options')?.dataset.loaded&&!options.length)throw new Error('请至少选择一个文件夹。');fields.folders=options.length?options.map(el=>el.value):((fields.folder!==state.mail.folder)?[fields.folder]:(state.mail.folders||[fields.folder]));}await api('/api/mail/settings',{method:'PUT',body:JSON.stringify({...fields,revision:Number(form.dataset.revision),enabled:fields.enabled==='on',remember:fields.remember==='on',clearSecret:fields.clearSecret==='on'})});$('#modal').close();await refresh();render();toast('邮箱配置已保存。');return;}
 if(form.dataset.reminder){await api('/api/mail/messages/'+form.dataset.id,{method:'PATCH',body:JSON.stringify({revision:Number(form.dataset.revision),reminder:{id:form.dataset.reminder,dueAt:new Date(fields.dueAt).toISOString()}})});await openMail(form.dataset.id);if(view==='mail')await loadMail();return;}
 const app=state.applications.find(a=>a.id===fields.applicationId);await api('/api/mail/messages/'+form.dataset.id,{method:'PATCH',body:JSON.stringify({...fields,confirmProgress:fields.confirmProgress==='on',revision:Number(form.dataset.revision),applicationRevision:app?.revision})});await refresh();if(view==='mail')await loadMail();await openMail(form.dataset.id);toast(fields.apply?'已同步投递进展，原跟进安排保留。':'已保存关联。');
}
async function mailAction(action,el){
 if(!state.mail)throw new Error('请重启工作台服务。');
 if(action==='mail-box'){mailFilter={...mailFilter,box:el.dataset.box,category:'',status:'',offset:0};render();return;}
 if(action==='mail-batch'){
   const operation=el.dataset.operation,items=el.dataset.id?[{id:el.dataset.id,revision:Number(el.dataset.revision)}]:selectedMailItems();
   if(!items.length){toast('请先勾选邮件。',true);return;}
   if(operation==='purge'){
     mailPendingPurge=items;
     modal('彻底删除邮件',`<p>确定从工作台彻底删除这 ${items.length} 封邮件？正文、提醒和对应扫描预览将被清除，无法在回收站恢复，后续同步也不会重新入库。QQ 邮箱中的原邮件不受影响。</p><div class="actions">${button('取消','close-modal')}${button('确认彻底删除','mail-purge-confirm','danger')}</div>`);return;
   }
   await processMailBatch(operation,items);return;
 }
 if(action==='mail-purge-confirm'){if(mailPendingPurge.length)await processMailBatch('purge',mailPendingPurge,true);return;}
 if(action==='mail-todo-done'){
   await api('/api/mail/messages/'+el.dataset.mail,{method:'PATCH',body:JSON.stringify({revision:Number(el.dataset.revision),reminder:{id:el.dataset.id,done:el.dataset.done==='true'}})});
   if($('#modal').open)await openMail(el.dataset.mail);if(view==='mail')await loadMail();return;
 }
 if(action==='mail-undo'){
   const form=$('#mail-link-form'),app=state.applications.find(a=>a.id===form.elements.applicationId.value);
   await api('/api/mail/messages/'+form.dataset.id,{method:'PATCH',body:JSON.stringify({revision:Number(form.dataset.revision),applicationRevision:app?.revision,undo:true})});
   await openMail(form.dataset.id);if(view==='mail')await loadMail();toast('已撤销进展，时间线保留撤销记录。');return;
 }
 if(action==='mail-folders'){
   const result=await api('/api/mail/folders',{method:'POST'});
   $('#mail-folder-options').innerHTML=`<p>来自已保存邮箱 ${e(state.mail.account)}</p>${result.folders.map(f=>`<label><input type="checkbox" name="folderChoice" value="${e(f.path)}" ${(state.mail.folders||[state.mail.folder]).includes(f.path)?'checked':''}>${e(f.path)}</label>`).join('')}`;
   $('#mail-folder-options').dataset.loaded='true';return;
 }
 if(action==='mail-scans'){await scanInbox();return;}
 if(action==='mail-scan-open'){
   const s=scanRows.find(s=>s.id===el.dataset.id);if(!s)return;
   modal('扫描邮件原文',`<h3>${e(s.mail.subject)}</h3><p>${e(s.mail.from)} · ${e(fmtDate(s.mail.date))}</p><p>${e(s.reason)}</p><div class="preserve job-description">${e(s.mail.text)}</div><div class="actions">${s.mailId?button('查看求职邮件','mail-open','','','data-id="'+s.mailId+'"'):button('标记为求职邮件','mail-promote','primary','','data-id="'+s.id+'"')}${button('返回扫描结果','mail-scans')}</div>`);return;
 }
 if(action==='mail-promote'){const result=await api('/api/mail/scans/'+el.dataset.id+'/promote',{method:'POST'});await openMail(result.message.id);if(view==='mail')await loadMail();return;}
 if(action==='mail-scan-clear'){await api('/api/mail/scans',{method:'DELETE'});await scanInbox();return;}
 if(action==='mail-rescan'||action==='mail-rescan-more'){toast('正在重新读取所选范围，按每文件夹批次扫描…');await api('/api/mail/rescan',{method:'POST',body:JSON.stringify({restart:action==='mail-rescan'})});await refresh();await loadMail();await scanInbox();return;}
 if(action==='mail-rematch'){const r=await api('/api/mail/rematch',{method:'POST'});await refresh();render();toast('已重新关联 '+r.matched+' 封邮件；多个候选仍需手动选择。');return;}
 if(action==='mail-config'){mailSettings();return;}
 if(action==='mail-open-qq'){
   if(!state.mail?.mailDirectOpen){toast('请重启工作台并刷新页面，加载 QQ 原邮件定位功能。',true);return;}
   toast('正在 QQ 窗口定位原邮件；首次使用请完成登录…');
   const result=await api('/api/mail/messages/'+el.dataset.id+'/open',{method:'POST'});
   if(result.status==='login_required')modal('登录工作台 QQ 窗口',`<p>${e(result.message)}</p><p>网页登录与 IMAP 同步独立。请在新打开的 Edge 窗口完成登录。</p><div class="actions">${button('已登录，继续打开','mail-open-qq','primary','','data-id="'+el.dataset.id+'"')}${button('关闭','close-modal')}</div>`);
   else {if($('#modal').open)$('#modal').close();toast(result.message);}return;
 }
 if(action==='mail-copy-subject'){
   try {await navigator.clipboard.writeText(el.dataset.subject||'');toast('邮件主题已复制，可在 QQ 邮箱中搜索。');}
   catch {toast('复制失败，请选中上方邮件主题手动复制。',true);}return;
 }
 if(action==='mail-complete'){
   const id=el.dataset.id,completed=el.dataset.completed==='true';
   try {await api('/api/mail/messages/'+id,{method:'PATCH',body:JSON.stringify({revision:Number(el.dataset.revision),completed})});}
   catch(error){if(view==='mail')await loadMail();throw error;}
   if($('#modal').open)await openMail(id);
   if(view==='mail')await loadMail();
   toast(completed?(state.mail?.mailRecycle?'已完成，可在回收站中恢复。':'已完成，可在“已完成”中恢复。'):'已恢复到未完成。');return;
 }
 if(action==='mail-open'){await openMail(el.dataset.id);return;}
 if(action==='mail-apply'){const form=$('#mail-link-form');await mailSubmit(form,{...Object.fromEntries(new FormData(form)),apply:true});return;}
 if(action==='mail-ignore'){await api('/api/mail/messages/'+el.dataset.id,{method:'PATCH',body:JSON.stringify({revision:Number(el.dataset.revision),ignored:el.dataset.ignored==='true'})});$('#modal').close();await refresh();render();return;}
 if(action==='mail-category'){mailFilter.category=el.dataset.category||'';mailFilter.offset=0;await loadMail();return;}
 if(action==='mail-next'||action==='mail-prev'){mailFilter.offset=Math.max(0,mailFilter.offset+(action==='mail-next'?50:-50));await loadMail();return;}
 if(action==='mail-sync'){toast('正在同步邮箱，最多等待约两分钟…');try {await api('/api/mail/sync',{method:'POST'});toast('同步完成。');}finally{await refresh();render();}return;}
 if(action==='mail-refresh'){await refresh();render();}
}

function settingsView() {
  const s = state.settings;
  return heading('分析设置', '从本地检查开始，也可以连接你自己的 AI 模型。') + `<div class="settings-layout"><section class="panel"><form id="settings-form" class="settings-form"><h2>AI 深度评审</h2><p>支持兼容 Chat Completions 的接口。保存设置不会发送简历。</p><div class="field"><label for="base-url">模型接口地址</label><input id="base-url" name="baseUrl" type="url" maxlength="500" value="${e(s.baseUrl)}" placeholder="https://你的模型服务地址/v1"><small>填写接口基础地址，不要包含 /chat/completions。也支持本地模型的 HTTP 地址。</small></div><div class="field"><label for="model-name">模型名称</label><input id="model-name" name="model" maxlength="150" value="${e(s.model)}" placeholder="填写服务商提供的模型标识"></div><div class="field"><label for="api-key">API Key</label><input id="api-key" name="apiKey" type="password" maxlength="2000" autocomplete="off" placeholder="${s.hasKey ? '已设置；同一服务留空保留密钥' : '云端模型填写密钥，本地无鉴权模型可留空'}"><small>切换服务域名或端口时，请填写对应密钥。同一服务留空可保留当前密钥。</small></div><div class="field"><label><input name="rememberKey" type="checkbox" ${s.rememberKey?'checked':''} ${s.keyPersistence?'':'disabled'}> 使用 Windows 加密记住模型密钥</label><small>勾选后仅保存当前 Windows 用户可解密的密文，后台重启自动恢复；取消后只保留在本次运行内存中。</small><p id="model-key-state" class="muted">${e(s.keyPersistence?(s.keyError||(s.keySaved?'已加密保存，下次启动自动恢复。':s.hasKey?'当前密钥仅在内存中；勾选并保存即可记住。':'尚未保存模型密钥。')):'当前后台尚未加载密钥保存功能，需要重启后台后启用。')}</p></div><div class="field"><label><input name="redact" type="checkbox" ${s.redact !== false ? 'checked' : ''}> 发送前隐藏常见手机号、邮箱和身份证号</label><small>此规则不能完全匿名化简历；姓名、学校、公司和经历仍可能发送给你配置的模型服务。</small></div><div class="inline-error" id="settings-error" role="alert"></div><div class="form-actions">${s.hasKey || s.keySaved || s.keyError ? button('清除模型密钥', 'clear-key', 'subtle') : ''}<button type="submit" class="btn primary">${icon('check')}保存分析设置</button></div></form></section><aside class="right-stack"><section class="panel accent-panel"><h2>${icon('lock')}基础检查一直可用</h2><p>不配置模型也可以上传简历，检查常见模块、时间信息、成果表达与关键词。基础检查不调用云端服务。</p></section><section class="panel tip-card"><h3>本地数据</h3><p>简历原件、校对文字、历次评审报告和投递记录保存在本机。编辑文字不会覆盖上传时的原文件。</p><p>报告中的改写仅作为表达参考，请用真实事实补齐，不要直接采用未核实的内容。</p></section></aside></div>`;
}

function pasteDialog() {
  modal('粘贴简历文字', `<form id="paste-form"><p>适合没有文件、扫描版 PDF 或需要快速分析一段简历的情况。</p><div class="field"><label for="paste-name">简历名称</label><input id="paste-name" name="name" required maxlength="160" placeholder="给这份简历起个名字"></div><div class="field"><label for="paste-text">简历内容</label><textarea id="paste-text" name="text" class="large" required minlength="30" maxlength="120000" placeholder="粘贴你的教育、经历、项目、技能等内容…"></textarea></div><div class="inline-error" id="modal-error" role="alert"></div><div class="form-actions">${button('取消', 'close-modal')}<button type="submit" class="btn primary">保存简历 ${icon('arrow')}</button></div></form>`);
}
function setupDrop() {
  const zone = $('#drop-zone');
  zone.addEventListener('dragover', ev => { ev.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', ev => { ev.preventDefault(); zone.classList.remove('drag'); const files = ev.dataTransfer.files; if (files.length > 1) { toast('请一次上传一份简历。', true); return; } if (files[0]) upload(files[0]); });
}
let uploading = false;
async function upload(file) {
  if (uploading) return;
  if (file.size > 10 * 1024 * 1024) { toast('文件不能超过 10 MB。', true); return; }
  if (!/\.(pdf|docx|txt|md)$/i.test(file.name)) { toast('请上传 PDF、DOCX、TXT 或 Markdown 文件。', true); return; }
  uploading = true;
  document.querySelectorAll('[data-action="upload"]').forEach(b => { b.disabled = true; b.textContent = '正在提取文字…'; });
  try {
    const result = await api('/api/resumes', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file });
    replaceResume(result.resume);
    await go('document', result.resume.id);
    toast(result.duplicate ? '这份文件已经上传，已打开已有简历。' : '简历已导入，请核对原文后开始分析。');
  } catch (error) { toast(error.message, true); if (view === 'resumes') render(); }
  finally { uploading = false; $('#file-input').value = ''; }
}
async function saveText() {
  if (!dirty) return;
  const r = state.resumes.find(r => r.id === selectedId), text = $('#resume-text').value;
  const result = await api(`/api/resumes/${r.id}`, { method: 'PATCH', body: JSON.stringify({ text, revision: r.revision }) });
  replaceResume(result.resume); dirty = false;
  toast('分析文字已保存，原始文件保持不变。');
}
async function analyze() {
  if (analyzing || pendingMutations) return;
  if (!state.capabilities?.reviewJobInput) { toast('工作台服务需要重启后才能使用独立 JD 评审，请重启服务并刷新页面。', true); return; }
  const form = $('#review-form'); if (!form.reportValidity()) return;
  const fields = Object.fromEntries(new FormData(form));
  const resume = state.resumes.find(r => r.id === fields.resumeId);
  if (!resume) { toast('请先选择一份简历。', true); return; }
  analysisMode = fields.mode;
  reviewInput = { resumeId: resume.id, company: fields.company, title: fields.title, description: fields.description, keywords: fields.keywords };
  if (analysisMode === 'ai' && (state.settings.enabled === false || state.local?.model?.enabled === false)) { toast('AI 已关闭，请先在本地设置中启用 AI。', true); return; }
  if (analysisMode === 'ai' && (!state.settings.baseUrl || !state.settings.model)) { toast('请先在“分析设置”中配置模型地址和名称。', true); return; }
  if (analysisMode === 'ai' && state.capabilities?.structuredResume !== 5) { toast('当前后台尚未加载最新简历优化规则，请退出并重新启动工作台，再刷新页面。', true); return; }
  analyzing = true;
  const stopStatus = analysisMode === 'ai' ? startAnalysisStatus(resume.id) : () => {};
  render();
  try {
    const { resumeId, ...job } = reviewInput;
    const result = analysisMode === 'ai' ? await reviewRequest(resume.id, 'analyze', { mode: analysisMode, job, revision: resume.revision }) : await api(`/api/resumes/${resume.id}/analyze`, { method: 'POST', body: JSON.stringify({ mode: analysisMode, job, revision: resume.revision }) });
    const report = result.resume.reports[0];
    replaceResume(result.resume); selectedId = resume.id; selectedReportId = report.id; view = 'detail'; reportTab = report.reviewProcess?.version === 3 && report.target?.description ? 'match' : report.engine === 'ai' && report.reviewProcess?.version === 2 && report.target?.description ? 'optimize' : 'diagnosis'; reviewsExpanded = true;
    reviewDirty = false; workspaceAutosave.clear(); history.replaceState(null, '', `#detail/${selectedId}/${selectedReportId}/${reportTab}`); window.scrollTo({ top: 0 }); toast(report.engine === 'ai' ? 'AI 评审与修改建议已保存，请核对后采纳到草稿。' : '本地基础检查已完成，未进行 JD 语义改写。');
  } finally { stopStatus(); analyzing = false; render(); }
  if (currentReport()?.reviewProcess?.version !== 3 && canPreviewTargeted(currentReport())) await showTargetedPreview();
}
async function reextract() {
  if (dirty) { toast('请先保存当前修改，再预览重新提取的文字。'); return; }
  const id = selectedId;
  toast('正在从原始文件重新提取文字…');
  const result = await api(`/api/resumes/${id}/reextract`, { method: 'POST' });
  modal('预览重新提取的文字', `<form id="reextract-form" data-id="${id}" data-revision="${result.revision}"><p>按页面位置重新排列文字。核对后点击“替换分析文字”保存；原始文件与历史报告会保留。</p><div class="field"><label for="reextract-text">提取结果（可继续校对）</label><textarea id="reextract-text" name="text" class="large" required minlength="30" maxlength="120000">${e(result.text)}</textarea></div><div class="inline-error" role="alert"></div><div class="form-actions">${button('取消', 'close-modal')}<button type="submit" class="btn primary">替换分析文字</button></div></form>`);
}
document.addEventListener('click', async event => {
  document.querySelectorAll('.job-more[open]').forEach(menu=>{if(!menu.contains(event.target)||event.target.closest('[data-action]'))menu.open=false;});
  if ((pendingMutations || analyzing) && event.target.closest('[data-view], [data-action]')) { event.preventDefault(); toast('正在处理，请稍候。'); return; }
  const nav = event.target.closest('[data-view]');
  if (nav) { await go(nav.dataset.view); return; }
  const buttonEl = event.target.closest('[data-action]');
  if (!buttonEl || buttonEl.disabled) return;
  const action = buttonEl.dataset.action, id = buttonEl.dataset.id;
  try {
    if (action.startsWith('private-')) {await cloud.action(action,buttonEl);return;}
    if (action.startsWith('runtime-')) {await runtimeAction(action);return;}
    if (action.startsWith('mail-')) { await mailAction(action,buttonEl); return; }
    if (action.startsWith('wechat-')) { await wechatAction(action,buttonEl); return; }
    if (/^(job|source|application)-/.test(action)) { await recruitmentAction(action, buttonEl); return; }
    if (action === 'open-reviews') { await openReviewCenter(); return; }
    if (action === 'toggle-reviews') { toggleReviewNav(); return; }
    if (action === 'print-draft') { if (view === 'detail' && reportTab === 'draft') window.print(); return; }
    if (action === 'close-modal') { $('#modal').close(); return; }
    if (action.startsWith('workspace-')) { await workspaceAction(action); return; }
    if (action.startsWith('targeted-')) { await targetedAction(action); return; }
    if (action === 'upload') { $('#file-input').click(); return; }
    if (action === 'paste') { pasteDialog(); return; }
    if (action === 'open-resume') { await go('document', id); return; }
    if (action === 'start-review') { await go('reviews', id); return; }
    if (action === 'open-draft') { if (await go('detail', id, buttonEl.dataset.report)) { reportTab = 'draft'; history.replaceState(null, '', `#detail/${id}/${buttonEl.dataset.report}/draft`); render(); } return; }
    if (action === 'open-report') { await go('detail', id, buttonEl.dataset.report); return; }
    if (action === 'back') { await go('resumes'); return; }
    if (action === 'review-home') { await go('reviews'); return; }
    if (action === 'save-text') { buttonEl.disabled = true; try { await saveText(); render(); } catch (error) { buttonEl.disabled = false; throw error; } return; }
    if (action === 'analyze') { await analyze(); return; }
    if (action === 'reextract') { await reextract(); return; }
    if (action === 'report-tab') {
      const step = buttonEl.dataset.tab;
      if (!Object.hasOwn(reportTabs, step)) return;
      if (view !== 'detail') { if (!lastReview || !await go('detail', lastReview.resumeId, lastReview.reportId)) return; }
      if (!currentReport() || (step !== 'diagnosis' && !currentReport().expert)) return;
      reportTab = step; reviewsExpanded = true;
      history.replaceState(null, '', `#detail/${selectedId}/${currentReport().id}/${step}`);
      render(); window.scrollTo({ top: 0 });
      return;
    }
    if (action.startsWith('expert-')) { await expertAction(action, buttonEl); return; }
    if (action === 'export-report') {
      await saveWorkspace(); const report = currentReport();
      const link = document.createElement('a'); link.href = `/api/resumes/${selectedId}/report?id=${report.id}`; document.body.append(link); link.click(); link.remove(); return;
    }
    if (action === 'delete-resume') {
      const r = state.resumes.find(r => r.id === id);
      if (!await confirmAction('删除这份简历？', `将删除「${r.name}」的本地副本、校对文字和评审报告。你电脑上的原文件不会改变。`, '删除简历')) return;
      await api(`/api/resumes/${id}`, { method: 'DELETE' }); state.resumes = state.resumes.filter(r => r.id !== id); render(); toast('已删除工作台中的简历。'); return;
    }
    if (action === 'view-report') { await go('detail', selectedId, buttonEl.dataset.report); return; }
    if (action === 'export-text') { await saveText(); const link = document.createElement('a'); link.href = `/api/resumes/${selectedId}/text`; document.body.append(link); link.click(); link.remove(); return; }
    if (action === 'clear-key') {
      const result = await api('/api/settings/key', { method: 'DELETE' });
      state.settings = result.settings; $('#api-key').value = ''; $('#api-key').placeholder = '云端模型填写密钥，本地无鉴权模型可留空'; buttonEl.remove();
      if($('#model-key-state'))$('#model-key-state').textContent='密钥已清除，内存和已保存密文均已移除。';
      updateSettingsDirty(); toast('密钥已清除，其他未保存设置仍保留在表单中。');
    }
  } catch (error) { toast(error.message, true); }
});
document.addEventListener('change', async event => {
  if(event.target.matches('#job-archive-filter, #job-kind-filter')){event.target.form.requestSubmit();return;}

  if(event.target.matches('#mail-select-all, [data-mail-select]')){
    if(event.target.id==='mail-select-all')document.querySelectorAll('[data-mail-select]').forEach(el=>el.checked=event.target.checked);
    updateMailSelection();return;
  }
  if (event.target.matches('#application-filter-form select, #application-filter-form input[type="checkbox"]')) { event.target.form.requestSubmit(); return; }
  if (event.target.matches('[data-job-progress]')) {
    const control=event.target;
    if(pendingMutations) return;
    try { await api(`/api/jobs/${control.dataset.jobProgress}/progress`,{method:'POST',body:JSON.stringify({status:control.value,revision:Number(control.dataset.revision)})}); await refresh(); render(); toast('进展已同步到投递跟踪。'); }
    catch(error) { await refresh(); render(); toast(error.message,true); }
    return;
  }
  if (event.target.closest('#review-form')) updateReviewInput();
  if (event.target.closest('#settings-form, #private-model-form')) updateSettingsDirty();
  if (event.target.id === 'analysis-mode') { analysisMode = event.target.value; savePreference('workbench-analysis-mode', analysisMode); $('#analysis-disclosure').innerHTML = analysisDisclosure(); $('#analysis-submit').innerHTML = icon('spark') + analysisButtonLabel(); }
});
function updateReviewInput() {
  const form = $('#review-form'); if (!form) return;
  const { mode, ...fields } = Object.fromEntries(new FormData(form));
  reviewInput = fields; reviewDirty = Object.values(fields).some(x => x.trim()); if ($('#analysis-submit') && !analyzing) $('#analysis-submit').innerHTML = icon('spark') + analysisButtonLabel();
}
function updateSettingsDirty() {
  const privateForm=$('#private-model-form');
  if(privateForm){const fields=new FormData(privateForm),saved=state.local.model;settingsDirty=fields.get('baseUrl').trim()!==(saved.baseUrl||'')||fields.get('model').trim()!==(saved.model||'')||!!fields.get('apiKey').trim()||fields.has('enabled')!==saved.enabled||fields.has('clearKey');return;}
  const form = $('#settings-form'); if (!form) return;
  const fields = new FormData(form), saved = state.settings;
  settingsDirty = fields.get('baseUrl').trim() !== (saved.baseUrl || '') || fields.get('model').trim() !== (saved.model || '') || Boolean(fields.get('apiKey').trim()) || fields.has('redact') !== (saved.redact !== false) || (saved.keyPersistence && fields.has('rememberKey') !== Boolean(saved.rememberKey));
}
document.addEventListener('input', event => {
  const el = event.target;
  if (el.closest('#settings-form, #private-model-form')) updateSettingsDirty();
  if (el.closest('#review-form')) updateReviewInput();
  if (!el.matches('[data-answer], [data-rewrite], #expert-draft')) return;
  const report = currentReport(); if (!report?.expert) return;
  const w = working(report);
  if (el.dataset.answer) w.answers[el.dataset.answer] = el.value;
  else if (el.dataset.rewrite !== undefined) { w.edits ||= {}; w.edits[el.dataset.rewrite] = el.value; const i = Number(el.dataset.rewrite), item = (w.optimizedItems || report.expert.optimizedItems)[i]; $(`#adoption-${i}`).innerHTML = adoptionCell(item, i, w); }
  else { w.draft = el.value; if ($('#resume-preview')) { $('#resume-preview').innerHTML = resumePaper(w.draft); fitResumePreviews(); } }
  workspaceAutosave.touch(workspaceAutosave.get(selectedId, report));
});
document.addEventListener('submit', async event => {
  if(event.target.id.startsWith('private-')){event.preventDefault();await cloud.submit(event.target);return;}
  if (!event.target.dataset.reminder && !['paste-form', 'settings-form', 'reextract-form', 'review-form', 'placeholder-form', 'mail-settings-form', 'mail-filter-form', 'mail-category-form', 'mail-link-form', 'wechat-source-form', 'job-form', 'job-applied-position-form', 'source-form', 'source-import-form', 'source-pull-form', 'source-auto-form', 'application-form', 'application-status-form', 'job-filter-form', 'job-filter-save-form', 'job-announcement-form', 'job-promote-form', 'job-attach-form', 'application-filter-form'].includes(event.target.id)) return;
  event.preventDefault();
  if (pendingMutations || analyzing) return;
  if (event.target.id === 'review-form') { try { await analyze(); } catch (error) { toast(error.message, true); } return; }
  const form = event.target, submit = form.querySelector('[type="submit"]'), fields = Object.fromEntries(new FormData(form));
  submit.disabled = true;
  const errorBox = form.querySelector('.inline-error'); if (errorBox) errorBox.textContent = '';
  try {
    if (form.dataset.reminder || ['mail-settings-form', 'mail-filter-form', 'mail-category-form', 'mail-link-form', 'wechat-source-form', 'job-form', 'job-applied-position-form', 'source-form', 'source-import-form', 'source-pull-form', 'source-auto-form', 'application-form', 'application-status-form', 'job-filter-form', 'job-filter-save-form', 'job-announcement-form', 'job-promote-form', 'job-attach-form', 'application-filter-form'].includes(form.id)) {
      await recruitmentSubmit(form, fields);
    } else if (form.id === 'placeholder-form') {
      const report = currentReport();
      if (report?.id !== form.dataset.report) throw new Error('报告已切换，请重新选择修改项。');
      const index = Number(form.dataset.index), w = working(report), item = (w.optimizedItems || report.expert.optimizedItems)[index];
      const after = w.edits?.[index] ?? item.after;
      const completed = fillPlaceholders(after, Object.keys(fields).sort((a, b) => Number(a) - Number(b)).map(key => fields[key]));
      w.edits ||= {}; w.edits[index] = completed; workspaceAutosave.touch(workspaceAutosave.get(selectedId, report)); render();
      await expertAction('expert-apply', { dataset: { index: String(index) } });
      $('#modal').close();
    } else if (form.id === 'paste-form') {
      const result = await api('/api/resumes', { method: 'POST', body: JSON.stringify(fields) });
      replaceResume(result.resume); $('#modal').close(); await go('document', result.resume.id); toast(result.duplicate ? '已打开相同内容的简历。' : '简历文字已保存。');
    } else if (form.id === 'reextract-form') {
      const result = await api(`/api/resumes/${form.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ text: fields.text, revision: Number(form.dataset.revision) }) });
      replaceResume(result.resume); dirty = false; $('#modal').close(); render(); toast('文字已重新提取并保存，原始文件保留。');
    } else {
      const result = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ ...fields, revision: state.settings.revision, ...(state.settings.keyPersistence?{rememberKey:new FormData(form).has('rememberKey')}:{}), redact: new FormData(form).has('redact') }) });
      state.settings = result.settings; settingsDirty = false; render(); toast('分析设置已保存。');
    }
  } catch (error) { if (errorBox) errorBox.textContent = error.message; else toast(error.message, true); }
  finally { submit.disabled = false; if(form.dataset.inline&&form.isConnected)jobGrid?.getRow(form.dataset.id)?.normalizeHeight(); }
});
$('#file-input').addEventListener('change', ev => { if (ev.target.files[0]) upload(ev.target.files[0]); });
$('.brand-name').addEventListener('click', event => { event.preventDefault(); go('resumes'); });
window.addEventListener('beforeunload', event => { if (pendingPositionEdits.size || dirty || workspaceDirty || settingsDirty || reviewDirty || ((pendingMutations || analyzing) && !activeAnalysis?.background)) { event.preventDefault(); event.returnValue = ''; } });
$('#modal').addEventListener('cancel', event => { if (pendingMutations) event.preventDefault(); });

// Progressive enhancement: expose a read-only summary of the active workbench sections.
function registerTools() {
  if (!document.modelContext?.registerTool) return;
  const lifecycle = new AbortController();
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
  for (const tool of [
    { name: 'get_workbench_summary', description: '读取本机工作台简历、岗位和投递记录的数量，不返回私密内容。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true }, execute(input) { if (!input || typeof input !== 'object' || Object.keys(input).length) throw new Error('无需参数'); return { resumes: state.resumes.length, jobs: (state.jobs || []).length, applications: (state.applications || []).length, view }; } },
  ]) {
    try { Promise.resolve(document.modelContext.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); } catch { /* Unsupported experimental API does not affect the UI. */ }
  }
}
try {
  await refresh();
  const [route, id, reportId, step] = location.hash.slice(1).split('/');
  if (['intents','home','todos'].includes(route)) { view = 'resumes'; history.replaceState(null, '', '#resumes'); }
  if (Object.hasOwn(names, route)) { view = route; selectedId = id; selectedReportId = reportId; if (view === 'reviews') reviewInput.resumeId = id || ''; }
  if(['catalog','admin'].includes(view))view='sources';
  if(['runtime','settings'].includes(view))view='account';
  reviewsExpanded = ['reviews', 'detail'].includes(view);
  if (view === 'detail' && currentReport()?.expert && Object.hasOwn(reportTabs, step)) reportTab = step;
  render(); registerTools();
  let pending; try { pending = JSON.parse(sessionStorage.getItem(pendingReviewKey)); } catch { clearPendingReview(); }
  if (pending && state.capabilities?.reviewBackground) {
    selectedId = pending.resumeId; selectedReportId = pending.reportId || null;
    view = pending.reportId ? 'detail' : 'reviews'; reviewInput.resumeId = pending.resumeId;
    if (pending.endpoint === 'interview') reportTab = 'interview';
    render();
    const stopStatus = startAnalysisStatus(pending.resumeId); analyzing = true;
    pendingMutations++; $('#main').inert = true;
    try {
      const result = await waitReviewJob(pending); replaceResume(result.resume);
      selectedId = pending.resumeId; selectedReportId = pending.reportId || result.resume.reports[0]?.id;
      view = 'detail'; reportTab = pending.endpoint === 'interview' ? 'interview' : 'match'; workspaceAutosave.clear();
      history.replaceState(null, '', '#detail/' + selectedId + '/' + selectedReportId + '/' + reportTab);
    } catch (error) { toast(error.message, true); }
    finally { stopStatus(); analyzing = false; if (--pendingMutations === 0) $('#main').inert = false; render(); }
  }
} catch (error) { $('#main').innerHTML = `<div class="error-state"><h2>暂时无法打开工作台</h2><p>${e(error.message)}</p><p>请检查网络连接，再刷新页面。</p></div>`; }
