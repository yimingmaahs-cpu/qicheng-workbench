import http from 'node:http';
import { mailTracking, protectMailSecret } from './lib/mail.mjs';
import { qqMailBrowser } from './lib/mail-browser.mjs';
import { dashboard } from './lib/dashboard.mjs';
import { localBackups } from './lib/backups.mjs';
import { jobFilters } from './lib/job-filters.mjs';
import { wechatSources } from './lib/wechat.mjs';
import { qqSources } from './lib/qq.mjs';
import { recruitment } from './lib/recruitment.mjs';
import { offerBrowser } from './lib/offer-browser.mjs';
import { platformBrowser as createPlatformBrowser } from './lib/platform-browser.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { extractFile, cleanText, MAX_FILE_BYTES, MAX_TEXT_LENGTH } from './lib/parse.mjs';
import { localReview, aiReview, reportMarkdown, optimizeReview, generateInterview } from './lib/analyze.mjs';
import { reviewAnswersKey } from './lib/review-workflow.mjs';
import { workspaceFor, applyOptimization, targetedDraft, initializeStructuredDraft, STYLES } from './lib/expert.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const fail = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
function textField(value, max, label, required = false) {
  if (typeof value !== 'string') { if (required) throw fail(400, `请填写${label}。`); return ''; }
  const valueTrimmed = value.trim();
  if ((required && !valueTrimmed) || valueTrimmed.length > max) throw fail(400, `${label}不能为空且不能超过 ${max} 个字符。`);
  return valueTrimmed;
}

export function createApp(dataDir = path.join(root, 'data'), options = {}) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'workbench.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS resumes (id TEXT PRIMARY KEY, data TEXT NOT NULL, original BLOB, hash TEXT); CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);`);
  let apiKey = process.env.LLM_API_KEY || '';
  const storedSettings = () => ({ baseUrl: process.env.LLM_BASE_URL || '', model: process.env.LLM_MODEL || '', redact: true, rememberKey: false, revision: 0, ...JSON.parse(db.prepare('SELECT data FROM settings WHERE id=1').get()?.data || '{}') });
  const getSettings = () => { const { keyCipher, keyOrigin, ...settings } = storedSettings(); if(options.sharedModel){const {apiKey: key, ...shared}=options.sharedModel();return {...settings,...shared};} return settings; };
  const saveSettings = settings => db.prepare('INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(settings));
  const origin = value => { try { return new URL(value).origin; } catch { return ''; } };
  const modelVault = options.modelVault || protectMailSecret;
  let keyError = '';
  const keyReady = (async () => {
    const saved = storedSettings();
    if (saved.rememberKey && saved.keyCipher) {
      try {
        if (!saved.keyOrigin || saved.keyOrigin !== origin(saved.baseUrl)) throw new Error('Service changed');
        apiKey = await modelVault(saved.keyCipher, 'open');
        if (!apiKey) throw new Error('Empty key');
      } catch { apiKey = ''; keyError = '无法恢复已加密的模型密钥，请重新填写后保存，或清除密钥。'; }
    }
  })();
  const readResume = id => { const row = db.prepare('SELECT data FROM resumes WHERE id=?').get(id); if (!row) throw fail(404, '这份简历已不存在，请刷新列表。'); return JSON.parse(row.data); };
  const saveResume = doc => db.prepare('UPDATE resumes SET data=? WHERE id=?').run(JSON.stringify(doc), doc.id);
  const publicSettings = () => ({ ...getSettings(), hasKey: Boolean(apiKey), keyPersistence: true, keySaved: Boolean(storedSettings().keyCipher && !keyError), keyError });
  const busy = new Set();
  const reviewProgress = new Map();
  const reviewTasks = new Set();
  async function executeReview(res, id, background, work) {
    busy.add(id);
    const job = { running: true, operationId: randomUUID(), stage: 'queued', message: '评审已在后台开始，关闭或刷新页面不会停止任务。', startedAt: now() };
    reviewProgress.set(id, job);
    const progress = (stage, message) => Object.assign(job, { stage, message });
    const task = (async () => {
      try {
        const result = await work(progress);
        Object.assign(job, { running: false, stage: 'done', message: '结果已保存。', finishedAt: now() });
        return result;
      } catch (error) {
        Object.assign(job, { running: false, error: error.message, status: error.status || 502, finishedAt: now() });
        throw fail(error.status || 502, error.message);
      } finally { busy.delete(id); }
    })();
    reviewTasks.add(task);
    task.then(() => reviewTasks.delete(task), () => reviewTasks.delete(task));
    if (background) { send(res, 202, { background: true, operationId: job.operationId, resumeId: id }); return; }
    try { send(res, 200, await task); } finally { reviewProgress.delete(id); }
  }
  async function body(req, limit = 1024 * 1024) {
    if (Number(req.headers['content-length']) > limit) throw fail(413, '内容过大，请减少文件或文字大小。');
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw fail(413, '内容过大，请减少文件或文字大小。'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  async function jsonBody(req) {
    try { const value = JSON.parse((await body(req)).toString('utf8')); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; }
    catch (error) { if (error.status) throw error; throw fail(400, '请求格式不正确。'); }
  }
  function send(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
  const browser = options.browser || (options.cloud ? {close:async()=>{}} : offerBrowser(dataDir));
  const platform = options.platformBrowser || (options.cloud ? null : createPlatformBrowser(dataDir));
  const recruiting = recruitment(db, { jsonBody, send, readResume, browser, platformBrowser: platform, clock: options.clock });
  const savedJobFilters = jobFilters(db);
  const wechat = wechatSources(db, { importJobs: recruiting.importJobs, reader: options.wechatReader, clock: options.clock });
  const qq = qqSources(db, { importJobs: recruiting.importJobs, reader: options.qqReader, clock: options.clock });
  const mailBrowser = options.cloud ? {close:async()=>{}} : options.mailBrowser || qqMailBrowser(dataDir);
  const mail = mailTracking(db, { updateApplication: recruiting.updateApplication, reader: options.mailReader, vault: options.mailVault, clock: options.clock, webmail: options.cloud ? undefined : mailBrowser });
  const today = dashboard(db,{recruiting,mail,clock:options.clock});
  const backups = localBackups(db,dataDir,{clock:options.clock});
  const startedAt=now();
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      if(options.internalKey && req.headers['x-internal-key']!==options.internalKey)throw fail(403,'Internal access denied');
      const port = server.address()?.port;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(req.headers.host)) throw fail(403, '工作台仅接受本机访问。');
      const url = new URL(req.url, `http://${req.headers.host}`), route = url.pathname;
      if (route.startsWith('/api/')) {
        if (req.headers.origin && !hosts.map(h => `http://${h}`).includes(req.headers.origin)) throw fail(403, '不允许跨站访问工作台。');
        if (req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, '不允许跨站访问工作台。');
        if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-workbench'] !== '1') throw fail(403, '缺少本地工作台请求标识。');
        await keyReady;
        if(options.sharedModel)apiKey=options.sharedModel().apiKey;
        if (req.method === 'GET' && route === '/api/health') { send(res, 200, { app: 'offer-workbench', version: '0.1.0' }); return; }
        if (req.method === 'GET' && route === '/api/state') {
          send(res, 200, { capabilities: { reviewBackground: true, reviewWorkflow: 3, structuredResume: 5, reviewMatchScore: true, reviewJobInput: true, jdTargetedReview: true, targetedDraftPreview: true, appliedPosition: true, applicationRecycle: true, jobBatchTrash: true, recruitment: true, platformAutoCollect: !!platform, platformJobOpen: !!platform?.openJob, dashboard:true, savedJobFilters:true, jobColumnChoices:true }, runtime:{startedAt,processId:process.pid,backups:backups.state()}, ...recruiting.state(), savedJobFilters:savedJobFilters.list(), wechat: wechat.state(), qq:qq.state(), mail: mail.state(), resumes: db.prepare('SELECT data FROM resumes ORDER BY rowid DESC').all().map(r => JSON.parse(r.data)), intents: db.prepare('SELECT data FROM intents ORDER BY rowid').all().map(r => JSON.parse(r.data)), settings: publicSettings(), source: { name: 'Offer 情报局', url: 'https://offerqingbaoju.cn/info-summary', status: '待接入' } }); return;
        }
        if (await today.handle(req,res,route,{jsonBody,send})) return;
        if (await backups.handle(req,res,route,{send})) return;
        if (await savedJobFilters.handle(req,res,route,{jsonBody,send})) return;
        if (await mail.handle(req, res, route, { jsonBody, send })) return;
        if (await wechat.handle(req, res, route, { jsonBody, send })) return;
        if (await qq.handle(req, res, route, { jsonBody, send })) return;
        if (await recruiting.handle(req, res, route, url)) { if(req.method==='POST'&&(route==='/api/applications'||/^\/api\/jobs\/[^/]+\/progress$/.test(route)))mail.rematch(); return; }
        if (req.method === 'POST' && route === '/api/resumes') {
          let filename, text, ext, pages = null, original;
          if (req.headers['content-type']?.startsWith('application/json')) {
            const input = await jsonBody(req);
            filename = textField(input.name, 160, '简历名称', true);
            text = cleanText(textField(input.text, MAX_TEXT_LENGTH, '简历文字', true));
            if (text.length < 30) throw fail(400, '简历文字至少需要 30 个字符。');
            ext = 'txt'; original = Buffer.from(text);
          } else {
            try { filename = decodeURIComponent(req.headers['x-file-name'] || ''); } catch { throw fail(400, '文件名无效。'); }
            filename = textField(filename, 200, '文件名', true).replace(/[\\/\x00-\x1f]/g, '_');
            original = await body(req, MAX_FILE_BYTES);
            try { ({ text, ext, pages } = await extractFile(original, filename)); } catch (error) { throw fail(422, error.message); }
          }
          const hash = createHash('sha256').update(original).digest('hex');
          const existing = db.prepare('SELECT data FROM resumes WHERE hash=?').get(hash);
          if (existing) { send(res, 200, { resume: JSON.parse(existing.data), duplicate: true }); return; }
          const doc = { id: randomUUID(), name: filename, text, ext, pages, size: original.length, createdAt: now(), updatedAt: now(), revision: 1, reports: [] };
          db.prepare('INSERT INTO resumes (id,data,original,hash) VALUES (?,?,?,?)').run(doc.id, JSON.stringify(doc), original, hash);
          send(res, 201, { resume: doc }); return;
        }
        const match = route.match(/^\/api\/resumes\/([a-f0-9-]+)(?:\/(analyze|analysis-status|original|report|text|reextract|workspace|optimize|interview|apply|copy|draft|targeted-draft|targeted-copy))?$/);
        if (match) {
          const [, id, action] = match, doc = readResume(id);
          if (req.method === 'GET' && action === 'analysis-status') { send(res, 200, reviewProgress.get(id) || { running: false, stage: '', message: '' }); return; }
          if ((req.method === 'GET' && action === 'targeted-draft') || (req.method === 'POST' && action === 'targeted-copy')) {
            const input = req.method === 'POST' ? await jsonBody(req) : Object.fromEntries(url.searchParams), current = readResume(id);
            const report = current.reports.find(r => r.id === (input.reportId || input.id));
            if (!report?.expert) throw fail(404, '报告已不存在或没有定向改写。');
            const version = workspaceFor(report).version;
            if ((input.workspaceVersion !== undefined && Number(input.workspaceVersion) !== version) || (req.method === 'POST' && (input.workspaceVersion !== version || input.reportRevision !== report.revision))) throw fail(409, '修改建议或报告版本已变化，请重新查看完整定向稿后再保存。');
            if (busy.has(id)) throw fail(409, '正在生成新的改写，请等待完成后再查看。');
            let preview;
            try { preview = targetedDraft(report); } catch (error) { throw fail(400, error.message); }
            const title = (report.target?.title || '本次岗位').replace(/[\\/\x00-\x1f]/g, '_');
            const filename = `${current.name.replace(/\.[^.]+$/, '').slice(0, 70)}-${title.slice(0, 70)}-定向版.txt`;
            if (action === 'targeted-draft' && input.download !== '1') { send(res, 200, { ...preview, filename, targetTitle: report.target?.title || '本次岗位' }); return; }
            if (!preview.appliedCount) throw fail(400, '没有可合入的有效改写，请先核对修改建议；未创建新简历。');
            if (preview.draft.length > MAX_TEXT_LENGTH) throw fail(400, '定向稿文字过长，请精简建议后重试。');
            if (action === 'targeted-draft') {
              res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` });
              res.end(preview.draft); return;
            }
            const original = Buffer.from(preview.draft), hash = createHash('sha256').update(original).digest('hex');
            const existing = db.prepare('SELECT data FROM resumes WHERE hash=?').all(hash).map(row => JSON.parse(row.data)).find(r => r.text === preview.draft);
            if (existing) { send(res, 200, { resume: existing, duplicate: true }); return; }
            const copy = { id: randomUUID(), name: filename, text: preview.draft, ext: 'txt', pages: null, size: original.length, revision: 1, createdAt: now(), updatedAt: now(), reports: [], origin: { resumeId: id, reportId: report.id, type: 'targeted', workspaceVersion: version } };
            db.prepare('INSERT INTO resumes (id,data,original,hash) VALUES (?,?,?,?)').run(copy.id, JSON.stringify(copy), original, hash);
            send(res, 201, { resume: copy }); return;
          }
          if (req.method === 'GET' && action === 'draft') {
            const report = doc.reports.find(r => r.id === url.searchParams.get('id'));
            if (!report) throw fail(404, '报告已不存在。');
            const filename = doc.name.replace(/\.[^.]+$/, '') + '-优化草稿.txt';
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` });
            res.end(workspaceFor(report).draft); return;
          }
          if ((req.method === 'PATCH' && action === 'workspace') || (req.method === 'POST' && ['apply', 'copy', 'optimize', 'interview'].includes(action))) {
            const input = await jsonBody(req), current = readResume(id);
            const report = current.reports.find(r => r.id === input.reportId);
            if (!report?.expert) throw fail(400, '请先重新分析，生成新版评审流程。');
            let workspace = workspaceFor(report);
            if (input.workspaceVersion !== workspace.version) throw fail(409, '这份优化草稿已更新，请先复制未保存内容，再刷新页面。');
            if (busy.has(id)) throw fail(409, '正在处理这份简历，请稍候。');
            if (action === 'workspace') {
              const draft = textField(input.draft, MAX_TEXT_LENGTH, '优化草稿', true);
              if (draft.length < 30) throw fail(400, '草稿至少需要 30 个字符。');
              if (!input.answers || typeof input.answers !== 'object' || Array.isArray(input.answers)) throw fail(400, '回答格式无效。');
              const answers = {};
              for (const q of report.expert.followUpQuestions) answers[q.id] = textField(input.answers[q.id], 3000, '追问回答');
              const edits = {};
              for (let i = 0; i < (workspace.optimizedItems || report.expert.optimizedItems).length; i++) {
                if (typeof input.edits?.[i] === 'string') edits[i] = textField(input.edits[i], 5000, '修改建议');
              }
              workspace = { ...workspace, draft, answers, edits };
            } else if (action === 'apply') {
              const after = textField(input.after, 5000, '改写文字', true);
              if (!Number.isInteger(input.index) || input.index < 0) throw fail(400, '请选择有效修改项。');
              try { workspace = applyOptimization(report, input.index, after); } catch (error) { throw fail(400, error.message); }
              if (workspace.draft.length > MAX_TEXT_LENGTH) throw fail(400, '草稿文字过长。');
            } else if (action === 'copy') {
              if (/\[(?:待补充|实际|真实|具体|可验证)[^\]]*\]/.test(workspace.draft)) throw fail(400, '草稿仍有待补充占位符，请校对后再另存。');
              const original = Buffer.from(workspace.draft), hash = createHash('sha256').update(original).digest('hex');
              const existing = db.prepare('SELECT data FROM resumes WHERE hash=?').all(hash).map(row => JSON.parse(row.data)).find(r => r.text === workspace.draft);
              if (existing) { send(res, 200, { resume: existing, duplicate: true }); return; }
              const copy = { id: randomUUID(), name: current.name.replace(/\.[^.]+$/, '') + '-优化版.txt', text: workspace.draft, ext: 'txt', pages: null, size: original.length, revision: 1, createdAt: now(), updatedAt: now(), reports: [], origin: { resumeId: id, reportId: report.id } };
              db.prepare('INSERT INTO resumes (id,data,original,hash) VALUES (?,?,?,?)').run(copy.id, JSON.stringify(copy), original, hash);
              send(res, 201, { resume: copy }); return;
            } else if (action === 'interview') {
              await executeReview(res, id, input.background === true, async progress => {
                const interview = await generateInterview(report, getSettings(), apiKey, progress);
                const fresh = readResume(id), freshReport = fresh.reports.find(r => r.id === report.id);
                if (fresh.revision !== current.revision || !freshReport || workspaceFor(freshReport).version !== workspace.version) throw fail(409, '生成期间原文或草稿已变化，面试结果未保存。');
                if (freshReport.expert.interviewPrep?.length) (freshReport.interviewHistory ||= []).push({ items: freshReport.expert.interviewPrep, metadata: freshReport.interview });
                freshReport.expert.interviewPrep = interview.items; freshReport.interview = interview;
                freshReport.workspace = { ...workspace, version: workspace.version + 1, updatedAt: now() };
                saveResume(fresh); return { resume: fresh };
              });
              return;
            } else {
              if (!Object.hasOwn(STYLES, input.style)) throw fail(400, '请选择有效的优化风格。');
              await executeReview(res, id, input.background === true, async progress => {
                const modelSettings = getSettings();
                const rewrite = await optimizeReview(report, modelSettings, apiKey, input.style, progress, checkpoint => {
                  const latest = readResume(id), saved = latest.reports.find(r => r.id === report.id);
                  if (latest.revision !== current.revision || !saved || workspaceFor(saved).version !== workspace.version) throw fail(409, '评审期间材料已变化，已停止保存。');
                  saved.pendingReview = checkpoint; saveResume(latest);
                });
                const fresh = readResume(id), freshReport = fresh.reports.find(r => r.id === report.id);
                if (fresh.revision !== current.revision || !freshReport || workspaceFor(freshReport).version !== workspace.version) throw fail(409, '生成期间原文或草稿已变化，结果未保存，请重试。');
                (freshReport.workflowHistory ||= []).push({ generatedAt: now(), summary: freshReport.summary, strengths: freshReport.strengths, suggestions: freshReport.suggestions, targetFit: freshReport.targetFit, expert: freshReport.expert, reviewProcess: freshReport.reviewProcess, workspace, interview: freshReport.interview });
                for (const key of ['summary', 'strengths', 'suggestions', 'targetFit', 'expert', 'reviewProcess', 'engine', 'model']) freshReport[key] = rewrite[key];
                delete freshReport.interview; delete freshReport.pendingReview;
                freshReport.workspace = { ...workspace, optimizedItems: rewrite.items, edits: {}, style: input.style, optimization: { engine: 'ai', model: modelSettings.model, generatedAt: now(), targeted: Boolean(report.target?.description), noRewriteReason: rewrite.noRewriteReason }, version: workspace.version + 1, updatedAt: now() };
                freshReport.workspace = initializeStructuredDraft(freshReport, workspace);
                saveResume(fresh); return { resume: fresh };
              });
              return;
            }
            report.workspace = { ...workspace, version: workspace.version + 1, updatedAt: now() };
            if (report.reviewProcess?.version === 3) report.reviewProcess.answersStale = reviewAnswersKey(report) !== report.reviewProcess.answersKey;
            saveResume(current); send(res, 200, { resume: current }); return;
          }
          if (req.method === 'POST' && action === 'reextract') {
            if (!['pdf', 'docx'].includes(doc.ext)) throw fail(400, '只有 PDF 和 Word 文件需要重新提取。');
            const original = db.prepare('SELECT original FROM resumes WHERE id=?').get(id).original;
            try {
              const result = await extractFile(Buffer.from(original), `${id}.${doc.ext}`);
              // Preview only: the client must explicitly save with its current revision.
              send(res, 200, { text: result.text, pages: result.pages, revision: doc.revision });
            } catch (error) { throw fail(422, error.message); }
            return;
          }
          if (req.method === 'GET' && ['report', 'text'].includes(action)) {
            const report = doc.reports.find(r => r.id === url.searchParams.get('id'));
            if (action === 'report' && !report) throw fail(404, '报告已不存在。');
            const filename = doc.name.replace(/\.[^.]+$/, '') + (action === 'report' ? '-评审报告.md' : '-校对文字.txt');
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` });
            res.end(action === 'report' ? reportMarkdown(doc, report) : doc.text); return;
          }
          if (req.method === 'GET' && action === 'original') {
            const original = db.prepare('SELECT original FROM resumes WHERE id=?').get(id).original;
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(doc.name)}` }); res.end(Buffer.from(original)); return;
          }
          if (req.method === 'PATCH' && !action) {
            const input = await jsonBody(req);
            const current = readResume(id);
            if (input.revision !== current.revision) throw fail(409, '简历在另一窗口已更新，请先复制未保存文字，再刷新后修改。');
            const text = cleanText(textField(input.text, MAX_TEXT_LENGTH, '简历文字', true));
            if (text.length < 30) throw fail(400, '简历文字至少需要 30 个字符。');
            if (text !== current.text) { current.text = text; current.revision++; current.updatedAt = now(); saveResume(current); }
            send(res, 200, { resume: current }); return;
          }
          if (req.method === 'DELETE' && !action) { db.prepare('DELETE FROM resumes WHERE id=?').run(id); send(res, 200, { ok: true }); return; }
          if (req.method === 'POST' && action === 'analyze') {
            const input = await jsonBody(req);
            if (busy.has(id)) throw fail(409, '这份简历正在分析，请等待完成。');
            const source = readResume(id);
            if (input.revision !== undefined && input.revision !== source.revision) throw fail(409, '简历原文已更新，请刷新后选择最新版本再分析。');
            if (!['local', 'ai'].includes(input.mode)) throw fail(400, '请选择基础检查或 AI 深度评审。');
            if (input.intentId) throw fail(400, '请在简历评审中粘贴本次 JD，不再从求职意向读取岗位描述。');
            let target = null;
            if (input.job !== undefined) {
              if (!input.job || typeof input.job !== 'object' || Array.isArray(input.job)) throw fail(400, '本次岗位信息格式无效。');
              if (['title', 'company', 'description', 'keywords'].some(key => input.job[key] !== undefined && typeof input.job[key] !== 'string')) throw fail(400, '本次岗位信息必须填写文字。');
              const job = { title: textField(input.job.title, 80, '本次岗位名称'), company: textField(input.job.company, 120, '公司名称'), description: textField(input.job.description, 10000, '岗位 JD'), keywords: textField(input.job.keywords, 500, '本次关注关键词') };
              if (Object.values(job).some(Boolean)) target = { ...job, title: job.title || '本次岗位', source: 'review' };
            }
            const reportId = randomUUID(), createdAt = now();
            await executeReview(res, id, input.mode === 'ai' && input.background === true, async progress => {
              const checkpoint = pendingReview => {
                const latest = readResume(id);
                if (latest.revision !== source.revision) throw fail(409, '评审期间原文已变化，已停止保存。');
                let saved = latest.reports.find(r => r.id === reportId);
                if (!saved) {
                  const base = localReview(source.text, target, source.pages);
                  saved = { ...base, id: reportId, createdAt, revision: source.revision, target, sourceText: source.text, engine: 'ai', model: getSettings().model, summary: '评审进行中，已完成的节点自动保存。', strengths: [], suggestions: [], targetFit: null, expert: { engine: 'ai', note: '评审尚未完成，可继续已保存的进度。', jdAnalysis: { requirements: [], responsibilities: [], hardRequirements: [], keywords: [], summary: '', ambiguities: [] }, matchItems: [], optimizedItems: [], followUpQuestions: [], interviewPrep: [] } };
                  latest.reports.unshift(saved);
                }
                saved.pendingReview = pendingReview;
                saved.reviewProcess = { ...pendingReview, status: 'partial', failedStage: 'resume', error: '评审尚未完成，刷新后可查看进度或继续评审。' };
                saveResume(latest);
              };
              const result = input.mode === 'ai' ? await aiReview(source.text, target, source.pages, getSettings(), apiKey, progress, checkpoint) : localReview(source.text, target, source.pages);
              const current = readResume(id);
              if (current.revision !== source.revision) throw fail(409, '分析期间简历已修改，结果未保存，请重新分析。');
              const report = { ...result, id: reportId, createdAt, revision: source.revision, target, sourceText: source.text };
              if (report.expert?.structure?.experienceCount) report.workspace = initializeStructuredDraft(report);
              current.reports = [report, ...current.reports.filter(r => r.id !== reportId)]; saveResume(current);
              return { resume: current };
            });
            return;
          }
        }
        if ((route === '/api/intents' && req.method === 'POST') || (/^\/api\/intents\/[a-f0-9-]+$/.test(route) && req.method === 'PATCH')) {
          const input = await jsonBody(req), editing = req.method === 'PATCH', id = editing ? route.split('/').pop() : randomUUID();
          if (editing && !db.prepare('SELECT id FROM intents WHERE id=?').get(id)) throw fail(404, '意向已不存在。');
          const intent = { id, title: textField(input.title, 80, '岗位名称', true), category: textField(input.category, 80, '求职类型'), cities: textField(input.cities, 200, '城市'), keywords: textField(input.keywords, 500, '关键词'), description: textField(input.description, 10000, '岗位描述'), updatedAt: now() };
          db.prepare('INSERT INTO intents(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id, JSON.stringify(intent)); send(res, 200, { intent }); return;
        }
        if (/^\/api\/intents\/[a-f0-9-]+$/.test(route) && req.method === 'DELETE') { db.prepare('DELETE FROM intents WHERE id=?').run(route.split('/').pop()); send(res, 200, { ok: true }); return; }
        if (route === '/api/settings/key' && req.method === 'DELETE') {
          const { keyCipher, keyOrigin, ...saved } = storedSettings();
          saveSettings({ ...saved, revision: saved.revision + 1 });
          apiKey = ''; keyError = ''; send(res, 200, { settings: publicSettings() }); return;
        }
        if (route === '/api/settings' && req.method === 'PUT') {
          const input = await jsonBody(req), previous = storedSettings();
          if (input.revision !== undefined && input.revision !== previous.revision) throw fail(409, '分析设置已更新，请刷新后重试。');
          const baseUrl = textField(input.baseUrl, 500, '模型地址'), model = textField(input.model, 150, '模型名称');
          if (baseUrl) {
            let u; try { u = new URL(baseUrl); } catch { throw fail(400, '请输入完整的模型接口地址。'); }
            if (u.username || u.password || u.search || u.hash || !(u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))) throw fail(400, '模型地址需为 HTTPS；本地模型可用 localhost 或 127.0.0.1 的 HTTP 地址。地址不能包含凭据或查询参数。');
          }
          const settings = { baseUrl: baseUrl.replace(/\/$/, ''), model, redact: input.redact !== false, rememberKey: input.rememberKey === undefined ? previous.rememberKey : input.rememberKey === true, revision: previous.revision + 1 };
          const changedService = origin(settings.baseUrl) !== origin(previous.baseUrl);
          let nextKey = changedService ? '' : apiKey;
          if (typeof input.apiKey === 'string' && input.apiKey.trim()) nextKey = textField(input.apiKey, 2000, 'API Key');
          if (input.clearKey === true) nextKey = '';
          if (settings.rememberKey && nextKey) {
            if (!settings.baseUrl) throw fail(400, '加密记住密钥前，请填写模型接口地址。');
            try { settings.keyCipher = await modelVault(nextKey, 'seal'); if (!settings.keyCipher || typeof settings.keyCipher !== 'string') throw new Error('Empty cipher'); }
            catch { throw fail(500, '模型密钥加密失败，设置未保存。请确认使用 Windows，或取消加密记住密钥。'); }
            settings.keyOrigin = origin(settings.baseUrl);
          } else if (settings.rememberKey && !changedService && keyError && input.clearKey !== true) {
            throw fail(400, '已保存密钥无法解密，请重新填写或清除密钥后再保存。');
          }
          // Encryption yields; a later save or clear must win rather than resurrect an old key.
          if (storedSettings().revision !== previous.revision) throw fail(409, '分析设置或密钥已更新，请刷新后重试。');
          saveSettings(settings);
          apiKey = nextKey; keyError = ''; send(res, 200, { settings: publicSettings() }); return;
        }
        throw fail(404, '接口不存在。');
      }
      const assets = { '/workspace-autosave.js': ['workspace-autosave.js', 'text/javascript; charset=utf-8'], '/recruitment-ui.js': ['recruitment-ui.js', 'text/javascript; charset=utf-8'], '/vendor/tabulator.js': ['../node_modules/tabulator-tables/dist/js/tabulator_esm.min.js', 'text/javascript; charset=utf-8'], '/vendor/tabulator.css': ['../node_modules/tabulator-tables/dist/css/tabulator.min.css', 'text/css; charset=utf-8'], '/vendor/sortable.js': ['../node_modules/sortablejs/modular/sortable.complete.esm.js', 'text/javascript; charset=utf-8'], '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      const asset = assets[route];
      if (!asset || req.method !== 'GET') throw fail(404, '页面不存在。');
      const content = readFileSync(path.join(root, 'public', asset[0]));
      res.writeHead(200, { 'Content-Type': asset[1] }); res.end(content);
    } catch (error) {
      if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : '操作失败，数据未保存，请重试。' });
      else res.end();
      if (!error.status) console.error('Request failed:', error.name);
    }
  });
  server.on('listening', () => { wechat.start(); qq.start(); mail.start(); if(options.autoSources!==false)recruiting.start(); if(options.autoBackups!==false)backups.start(); });
  server.on('close', () => { mail.stop(); wechat.stop(); qq.stop(); const collecting=recruiting.stop(); void browser.close().catch(() => {}); void platform?.close?.().catch(() => {}); void mailBrowser.close?.().catch(() => {}); const pending=backups.stop(); if (reviewTasks.size || pending || collecting) void Promise.allSettled([...reviewTasks, ...(pending ? [pending] : []), ...(collecting ? [collecting] : [])]).then(() => db.close()); else db.close(); });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4317);
  const server = createApp(process.env.WORKBENCH_DATA_DIR || undefined);
  server.listen(port, '127.0.0.1', () => console.log(`启程工作台已启动 http://127.0.0.1:${port}`));
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被使用；请打开已有工作台，或通过 PORT 设置其他端口。` : error.message); process.exit(1); });
}
