import { randomUUID, createHash } from 'node:crypto';
import { APPLICATION_STATUSES, field, jobURL, normalizeJob, dateValue, jobFingerprint, platformJobFingerprint, platformJobURLFingerprint, fetchJobSource, parseJobSource, pullConditions, filterPulledJobs } from './jobs.mjs';
import { platformForJobURL, searchQueries } from './platform-pages.mjs';
import { isOfferSource } from './offer-browser.mjs';
const fail = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();

export function recruitment(db, { jsonBody, send, readResume, browser, platformBrowser, clock = () => new Date() }) {
  db.exec(`CREATE TABLE IF NOT EXISTS job_sources (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS announcements (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS job_import_aliases (fingerprint TEXT PRIMARY KEY, job_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS job_suppressions (fingerprint TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL);`);
  db.prepare('INSERT OR IGNORE INTO job_sources(id,data) VALUES(?,?)').run('offerqingbaoju', JSON.stringify({ id: 'offerqingbaoju', name: 'Offer 情报局', url: 'https://offerqingbaoju.cn/info-summary', createdAt: now(), lastCheckedAt: '', lastResult: '需在浏览器登录；支持复制岗位 JD 录入。' }));
  for (const [id, name, platform, url] of [['source-boss', 'BOSS直聘', 'boss', 'https://www.zhipin.com/'], ['source-zhilian', '智联招聘', 'zhilian', 'https://sou.zhaopin.com/'], ['source-51job', '前程无忧', '51job', 'https://we.51job.com/pc/search']]) {
    db.prepare('INSERT OR IGNORE INTO job_sources(id,data) VALUES(?,?)').run(id, JSON.stringify({ id, name, platform, url, createdAt: now(), lastCheckedAt: '', lastResult: '使用本机 Edge 登录后采集。' }));
  }
  const all = table => db.prepare(`SELECT data FROM ${table} ORDER BY ${table === 'job_sources' ? "CASE id WHEN 'offerqingbaoju' THEN 0 WHEN 'source-boss' THEN 1 WHEN 'source-zhilian' THEN 2 WHEN 'source-51job' THEN 3 ELSE 4 END, rowid DESC" : 'rowid DESC'}`).all().map(r => JSON.parse(r.data));
  const read = (table, id) => { if (typeof id !== 'string' || !id) throw fail(400, '请选择有效记录。'); const row = db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id); if (!row) throw fail(404, '记录不存在，请刷新页面。'); return JSON.parse(row.data); };
  const save = (table, doc) => db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(doc), doc.id);
  const announcementFor = id => { const row = db.prepare('SELECT data FROM announcements WHERE id=?').get(id); return row ? JSON.parse(row.data) : null; };
  const announcementFields = input => ({ title: field(input.title, 500, '公告名称', true), company: field(input.company, 160, '公司名称'), description: field(input.description, 30000, '公告原文'), url: jobURL(input.url), sourceName: field(input.sourceName, 120, '来源名称') || '手动录入', location: field(input.location, 200, '工作地点'), deadline: dateValue(input.deadline, true), batch: field(input.batch, 100, '招聘批次'), companyType: field(input.companyType, 100, '企业性质'), industry: field(input.industry, 150, '行业'), notes: field(input.notes, 5000, '备注') });
  const publicJob = (job, announcement = announcementFor(job.id)) => announcement ? { appliedPosition: '', ...job, ...announcementFields(announcement), recordType: 'announcement', revision: job.revision, announcementRevision: announcement.revision, announcement: announcement.title, announcementUrl: announcement.url } : { appliedPosition: '', ...job };
  const announcementFrom = job => ({ ...announcementFields({ ...job, title: job.announcement || job.title, url: job.announcementUrl || job.url }), id: job.id, sourceJobId: job.id, sourceText: job.description, sourceUrl: job.url, revision: 1, createdAt: now(), updatedAt: now() });
  const checkAnnouncement = (id, revision, allowDeleted = false) => {
    const announcement = read('announcements', id);
    if (revision !== announcement.revision) throw fail(409, '公告已更新，请刷新后重试。');
    if (read('jobs', id).deletedAt && !allowDeleted) throw fail(400, '请先恢复已删除的公告。');
    return announcement;
  };
  const touchAnnouncement = announcement => { announcement.revision++; announcement.updatedAt = now(); save('announcements', announcement); };
  const insertJob = job => {
    const doc = { ...job, id: randomUUID(), revision: 1, archived: false, createdAt: now(), updatedAt: now() };
    db.prepare('INSERT INTO jobs(id,fingerprint,data) VALUES(?,?,?)').run(doc.id, jobFingerprint(doc), JSON.stringify(doc));
    for (const identity of [platformJobFingerprint(doc),platformJobURLFingerprint(doc)].filter(Boolean)) db.prepare('INSERT OR IGNORE INTO job_import_aliases(fingerprint,job_id) VALUES(?,?)').run(identity, doc.id);
    return doc;
  };
  const insertAnnouncement = announcement => db.prepare('INSERT INTO announcements(id,data) VALUES(?,?)').run(announcement.id, JSON.stringify(announcement));
  const duplicateFingerprint = (fingerprint, id) => db.prepare('SELECT id FROM jobs WHERE fingerprint=? AND id<>? UNION ALL SELECT job_id AS id FROM job_import_aliases WHERE fingerprint=? AND job_id<>? LIMIT 1').get(fingerprint, id, fingerprint, id)
    || db.prepare('SELECT fingerprint AS id FROM job_suppressions WHERE fingerprint=?').get(fingerprint)
    || all('announcements').find(announcement => announcement.id !== id && jobFingerprint({ ...announcement, recordType: 'announcement' }) === fingerprint);
  const existingJob = (job, exceptId = '') => {
    const platformIdentity = platformJobFingerprint(job), urlIdentity = platformJobURLFingerprint(job);
    for (const fingerprint of [jobFingerprint(job), platformIdentity, urlIdentity].filter(Boolean)) {
      if(db.prepare('SELECT 1 FROM job_suppressions WHERE fingerprint=?').get(fingerprint))return {suppressed:true,deletedAt:true};
      const duplicate = duplicateFingerprint(fingerprint, exceptId);
      if (duplicate) return read('jobs', duplicate.id);
    }
    if (urlIdentity) { const sameURL=all('jobs').find(item=>item.id!==exceptId&&platformJobURLFingerprint(item)===urlIdentity); if(sameURL)return sameURL; }
    if (platformIdentity) {
      const crossPlatform = all('jobs').find(item => item.id !== exceptId && platformJobFingerprint(item) === platformIdentity);
      if (crossPlatform) return crossPlatform;
    }
    // Offer rows are announcements containing several roles. Pulling a different
    // role from the same announcement must not create another announcement row.
    if (!job.recordType && job.sourceName.startsWith('Offer 情报局') && job.announcement && job.announcementUrl) return all('jobs').find(j => j.id !== exceptId && !j.recordType && j.sourceName.startsWith('Offer 情报局') && j.announcement === job.announcement && j.announcementUrl === job.announcementUrl);
    return null;
  };
  function importJobs(values, { transaction = true } = {}) {
    const normalized = values.map(normalizeJob); let inserted = 0, duplicates = 0, suppressed = 0; const jobs = [];
    if (transaction) db.exec('BEGIN');
    try {
      for (const job of normalized) {
        const existing = existingJob(job);
        if (existing) { duplicates++;if(existing.suppressed)suppressed++;else { jobs.push(existing);for(const identity of [platformJobURLFingerprint(job),platformJobFingerprint(job)].filter(Boolean))db.prepare('INSERT OR IGNORE INTO job_import_aliases(fingerprint,job_id) VALUES(?,?)').run(identity,existing.id); } continue; }
        if (job.announcementId) throw fail(400, '请从公告详情添加具体岗位。');
        const doc = insertJob(job);
        if (doc.recordType === 'announcement') insertAnnouncement(announcementFrom(doc));
        jobs.push(doc); inserted++;
      }
      if (transaction) db.exec('COMMIT');
    } catch (error) { if (transaction) db.exec('ROLLBACK'); throw error; }
    return { inserted, duplicates, suppressed, jobs: jobs.map(job => publicJob(job)) };
  }
  function jobBatch(input){
    const {action,items}=input;
    if(!['trash','restore','purge'].includes(action)||!Array.isArray(items)||!items.length||items.length>1000)throw fail(400,'请选择 1 至 1000 条岗位和有效操作。');
    if(items.some(i=>!i||typeof i.id!=='string'||!Number.isInteger(i.revision))||new Set(items.map(i=>i.id)).size!==items.length)throw fail(400,'岗位选择无效，请刷新。');
    if(action==='purge'&&input.confirm!==true)throw fail(400,'请确认彻底删除，删除后不可恢复。');
    const selected=new Set(items.map(i=>i.id)),jobs=items.map(i=>{const j=read('jobs',i.id);if(j.revision!==i.revision)throw fail(409,'所选岗位已更新，请刷新后重试。');if(action==='trash'?!!j.deletedAt:!j.deletedAt)throw fail(409,'所选岗位不在当前列表，请刷新。');return j;});
    for(const item of items){const announcement=announcementFor(item.id);if(announcement&&item.announcementRevision!==announcement.revision)throw fail(409,'所选公告已更新，请刷新后重试。');}
    if(action==='purge'&&all('jobs').some(j=>j.announcementId&&selected.has(j.announcementId)&&!selected.has(j.id)))throw fail(409,'公告还有关联职位，请先解除关联，或将公告及其全部职位一起移入回收站并选中。');
    const candidates=new Map();
    if(action==='purge'&&db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wechat_candidates'").get()){
      for(const row of db.prepare('SELECT id,data FROM wechat_candidates').all()){const {jobId}=JSON.parse(row.data);if(selected.has(jobId)){if(!candidates.has(jobId))candidates.set(jobId,[]);candidates.get(jobId).push(row.id);}}
    }
    db.exec('BEGIN');
    try{
      for(const job of jobs){
        if(action!=='purge'){job.deletedAt=action==='trash'?now():'';job.revision++;job.updatedAt=now();save('jobs',job);continue;}
        const hashes=new Set([jobFingerprint(job),jobFingerprint(publicJob(job)),platformJobFingerprint(job),platformJobURLFingerprint(job),...db.prepare('SELECT fingerprint FROM job_import_aliases WHERE job_id=?').all(job.id).map(r=>r.fingerprint)].filter(Boolean));
        for(const fingerprint of hashes)db.prepare('INSERT OR IGNORE INTO job_suppressions VALUES(?)').run(fingerprint);
        // Keep only deduplication identities; remove original imported chat text and drafts.
        for(const id of candidates.get(job.id)||[])db.prepare('UPDATE wechat_candidates SET data=? WHERE id=?').run(JSON.stringify({id,jobId:job.id,status:'imported',purged:true}),id);
        db.prepare('DELETE FROM job_import_aliases WHERE job_id=?').run(job.id);
        db.prepare('DELETE FROM announcements WHERE id=?').run(job.id);
        db.prepare('DELETE FROM jobs WHERE id=?').run(job.id);
      }
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    return {action,count:jobs.length};
  }
  const pulling = new Set();
  let stopped = false, timer, ticking;
  const currentTime = () => clock().toISOString();
  async function pullSource(id,conditions,automatic = false) {
    const source = read('job_sources',id);
    if (stopped) throw fail(503,'岗位采集已停止。');
    if (source.type === 'wechat') throw fail(400,'请使用微信群采集入口。');
    if (pulling.has(id)) throw fail(409,'该来源正在拉取，请稍候。');
    pulling.add(id);
    try {
      source.lastConditions = conditions; source.lastResult = '正在拉取…'; source.lastAttemptAt = currentTime(); save('job_sources',source);
      const progress = message => { if (!stopped) { source.lastResult = message; save('job_sources',source); } };
      let parsed;
      if (source.platform) {
        if (!platformBrowser) throw fail(400,'本机招聘平台浏览器不可用。');
        parsed = await platformBrowser.pull(source.platform,conditions,progress,job=>existingJob(job));
      } else if (isOfferSource(source.url)) parsed = await browser.pull(conditions,progress);
      else { const remote = await fetchJobSource(source.url); parsed = parseJobSource(remote.text,remote.url,source.name); parsed.scanned = parsed.jobs.length; parsed.jobs = filterPulledJobs(parsed.jobs,conditions); }
      if (stopped) throw fail(503,'采集已停止，本批未入库。');
      const jobs = [], batchIdentities = new Set(); let skippedExisting = parsed.skippedExisting || 0, skippedDeleted = parsed.skippedDeleted || 0, skippedRepeated = 0;
      for (const job of parsed.jobs) {
        const existing = existingJob(job);
        if (existing) { if (existing.deletedAt) skippedDeleted++; else skippedExisting++; }
        else { const identities=[jobFingerprint(job),platformJobFingerprint(job),platformJobURLFingerprint(job)].filter(Boolean); if(identities.some(id=>batchIdentities.has(id))){skippedRepeated++;continue;} identities.forEach(id=>batchIdentities.add(id));jobs.push({...job,duplicate:false}); }
      }
      if(skippedRepeated)parsed.warning=(parsed.warning||'')+'已跳过本批重复 '+skippedRepeated+' 条。';
      source.lastCheckedAt = currentTime(); source.lastSuccessAt = source.lastCheckedAt; source.lastError = '';
      if (source.automation?.enabled) source.automation = {...source.automation,paused:false,nextRunAt:new Date(clock().getTime()+source.automation.intervalMinutes*60000).toISOString()};
      db.exec('BEGIN');
      try {
        const imported = automatic ? importJobs(jobs,{transaction:false}) : null;
        source.lastStats = {scanned:parsed.scanned,inserted:imported?.inserted||0,skippedExisting,skippedDeleted};
        source.lastResult = (automatic ? '自动采集新增 '+imported.inserted+' 条；' : jobs.length ? '可入库 '+jobs.length+' 条，等待确认；' : '本次没有新的岗位；')+'跳过已入库 '+skippedExisting+' 条、已删除 '+skippedDeleted+' 条。'+(parsed.warning||'');
        save('job_sources',source); db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return {...parsed,jobs,skippedExisting,skippedDeleted,skippedRepeated,source};
    } catch (error) {
      if (!stopped) {
        const previous = read('job_sources',id);
        previous.lastCheckedAt = currentTime(); previous.lastError = error.status ? error.message : '来源处理失败，请检查采集窗口后重试。'; previous.lastResult = previous.lastError;
        if (previous.automation?.enabled) previous.automation = {...previous.automation,paused:!!error.requiresAction,nextRunAt:new Date(clock().getTime()+Math.max(15,previous.automation.intervalMinutes)*60000).toISOString()};
        save('job_sources',previous);
      }
      throw error;
    } finally { pulling.delete(id); }
  }
  function tick() {
    if (stopped || ticking || pulling.size || !platformBrowser) return ticking || Promise.resolve();
    ticking = (async () => {
      for (const {id} of all('job_sources').filter(s => s.platform)) {
        if (stopped) break;
        const s = read('job_sources',id), a = s.automation;
        if (!a?.enabled || a.paused || a.nextRunAt > currentTime() || pulling.size) continue;
        try { await pullSource(id,a.conditions,true); } catch { /* Per-source error is persisted; other sources still run. */ }
      }
    })().finally(() => { ticking = undefined; });
    return ticking;
  }

  const snapshot = input => {
    if (!input.resumeId) return null;
    const resume = readResume(field(input.resumeId, 50, '简历编号', true));
    if (input.resumeRevision !== resume.revision) throw fail(409, '简历已更新，请刷新后重新选择投递版本。');
    if (input.reportId) {
      const report = resume.reports.find(r => r.id === input.reportId);
      if (!report?.expert) throw fail(400, '请选择有效的简历草稿。');
      if (input.workspaceVersion !== (report.workspace?.version || 0)) throw fail(409, '草稿已更新，请刷新后重新选择。');
      return { resumeId: resume.id, reportId: report.id, name: resume.name + ' · 优化草稿', revision: report.revision, workspaceVersion: report.workspace?.version || 0, text: report.workspace?.draft || report.sourceText, capturedAt: now() };
    }
    return { resumeId: resume.id, name: resume.name, revision: resume.revision, text: resume.text, capturedAt: now() };
  };
  function updateApplication(id, input, mailId = '') {
    const app = read('applications', id);
    if (app.deletedAt) throw fail(409, '投递记录已在回收站，请先恢复。');
        if (input.revision !== app.revision) throw fail(409, '投递记录已更新，请刷新后再操作。');
        if (!Object.hasOwn(APPLICATION_STATUSES, input.status)) throw fail(400, '请选择有效投递状态。');
        const timestamp = now(), note = field(input.note, 5000, '进展备注');
        app.history.push({ at: timestamp, status: input.status, previousStatus: app.status, note: note || (input.status === app.status ? '更新跟进安排。' : `状态更新为${APPLICATION_STATUSES[input.status]}。`) });
        if (app.status === 'preparing' && input.status !== 'preparing' && input.status !== 'withdrawn' && !app.submittedAt) app.submittedAt = timestamp;
        app.status = input.status; app.nextActionAt = dateValue(input.nextActionAt); app.nextAction = field(input.nextAction, 500, '下一步安排'); app.updatedAt = timestamp; app.revision++;
    if (mailId) app.history.at(-1).mailId = mailId;
    save('applications', app); return app;
  }
  return {
    importJobs, updateApplication, tick,
    start(){ if (!timer) { stopped = false; timer = setInterval(() => { void tick().catch(() => {}); },10000); timer.unref(); } },
    stop(){ stopped = true; clearInterval(timer); timer = undefined; return ticking; },
    state() {
      const announcements = all('announcements'), byId = new Map(announcements.map(a => [a.id, a]));
      const applications=all('applications').map(({ resumeSnapshot, ...a }) => ({ ...a, resumeSnapshot: resumeSnapshot ? { ...resumeSnapshot, text: undefined } : null }));
      return { jobSources: all('job_sources').map(({ readCursor, ...s })=>({...s,running:pulling.has(s.id)})), announcements, jobs: all('jobs').map(job => publicJob(job, byId.get(job.id) || null)), applications:applications.filter(a=>!a.deletedAt), deletedApplications:applications.filter(a=>a.deletedAt), applicationStatuses: APPLICATION_STATUSES };
    },
    async handle(req, res, route, url) {
      if(route==='/api/jobs/batch'&&req.method==='POST'){send(res,200,jobBatch(await jsonBody(req)));return true;}
      const sourceStatus = route.match(/^\/api\/job-sources\/([a-z0-9-]+)\/status$/);
      if (req.method === 'GET' && sourceStatus) {
        const s = read('job_sources', sourceStatus[1]);
        send(res, 200, { source: { id: s.id, name: s.name, running: pulling.has(s.id), lastResult: s.lastResult || '', lastError: s.lastError || '', lastAttemptAt: s.lastAttemptAt || '', lastCheckedAt: s.lastCheckedAt || '', lastSuccessAt: s.lastSuccessAt || '' } }); return true;
      }
      if (req.method === 'POST' && route === '/api/announcements') {
        const input = await jsonBody(req), fields = announcementFields(input), normalized = normalizeJob({ ...fields, recordType: 'announcement' });
        if (existingJob(normalized)) throw fail(409, '相同公告已存在，请在岗位库中查看。');
        let job, announcement;
        db.exec('BEGIN');
        try { job = insertJob(normalized); announcement = announcementFrom(job); insertAnnouncement(announcement); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
        send(res, 201, { job: publicJob(job, announcement), announcement }); return true;
      }
      const promoteMatch = route.match(/^\/api\/jobs\/([a-f0-9-]+)\/announcement$/);
      if (req.method === 'POST' && promoteMatch) {
        const input = await jsonBody(req), job = read('jobs', promoteMatch[1]);
        if (input.revision !== job.revision) throw fail(409, '岗位已更新，请刷新后重试。');
        if (job.deletedAt) throw fail(400, '请先恢复已删除的记录。');
        if (job.announcementId) throw fail(400, '请先解除与现有公告的关系。');
        const existing = announcementFor(job.id);
        if (existing) { send(res, 200, { announcement: existing }); return true; }
        const announcement = announcementFrom({ ...job, announcement: input.title === undefined ? job.announcement : field(input.title, 500, '公告名称', true) });
        if (duplicateFingerprint(jobFingerprint({ ...announcement, recordType: 'announcement' }), job.id)) throw fail(409, '相同公告已存在，请在岗位库中查看。');
        insertAnnouncement(announcement); send(res, 201, { announcement }); return true;
      }
      if (req.method === 'PATCH' && promoteMatch) {
        const input = await jsonBody(req), previous = read('jobs', promoteMatch[1]);
        if (input.revision !== previous.revision) throw fail(409, '岗位已更新，请刷新后重试。');
        if (previous.deletedAt) throw fail(400, '请先恢复已删除的岗位。');
        if (announcementFor(previous.id)) throw fail(400, '招聘公告不能作为另一个公告下的具体岗位。');
        const targetId = field(input.announcementId, 50, '公告编号');
        const old = previous.announcementId ? checkAnnouncement(previous.announcementId, input.currentAnnouncementRevision, true) : null;
        const target = targetId ? checkAnnouncement(targetId, input.announcementRevision) : null;
        if (targetId === previous.id) throw fail(400, '岗位不能关联自身。');
        if (targetId === (previous.announcementId || '')) { send(res, 200, { job: previous, announcement: target }); return true; }
        const updated = { ...previous, recordType: 'position', announcementId: targetId, revision: previous.revision + 1, updatedAt: now() };
        field(updated.title, 160, '具体岗位名称', true);
        const fingerprint = jobFingerprint(updated);
        if (duplicateFingerprint(fingerprint, updated.id)) throw fail(409, '相同岗位已存在，请核对后再关联。');
        db.exec('BEGIN');
        try {
          db.prepare('INSERT OR IGNORE INTO job_import_aliases(fingerprint,job_id) VALUES(?,?)').run(jobFingerprint(previous), previous.id);
          db.prepare('UPDATE jobs SET data=?,fingerprint=? WHERE id=?').run(JSON.stringify(updated), fingerprint, updated.id);
          if (old) touchAnnouncement(old);
          if (target) touchAnnouncement(target);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        send(res, 200, { job: updated, announcement: target, previousAnnouncement: old }); return true;
      }
      const announcementMatch = route.match(/^\/api\/announcements\/([a-f0-9-]+)$/);
      if (req.method === 'GET' && announcementMatch) {
        const announcement = read('announcements', announcementMatch[1]);
        send(res, 200, { announcement, jobs: all('jobs').filter(job => job.announcementId === announcement.id) }); return true;
      }
      if (req.method === 'PATCH' && announcementMatch) {
        const input = await jsonBody(req), previous = checkAnnouncement(announcementMatch[1], input.revision);
        const announcement = { ...previous, ...announcementFields({ ...previous, ...input }), revision: previous.revision + 1, updatedAt: now() };
        if (duplicateFingerprint(jobFingerprint({ ...announcement, recordType: 'announcement' }), announcement.id)) throw fail(409, '相同公告已存在，请在岗位库中查看。');
        db.exec('BEGIN');
        try {
          db.prepare('INSERT OR IGNORE INTO job_import_aliases(fingerprint,job_id) VALUES(?,?)').run(jobFingerprint({ ...previous, recordType: 'announcement' }), previous.id);
          save('announcements', announcement);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        send(res, 200, { announcement }); return true;
      }
      const positionMatch = route.match(/^\/api\/announcements\/([a-f0-9-]+)\/jobs$/);
      if (req.method === 'POST' && positionMatch) {
        const input = await jsonBody(req), announcement = checkAnnouncement(positionMatch[1], input.revision);
        const normalized = normalizeJob({ company: announcement.company, sourceName: announcement.sourceName, ...input, recordType: 'position', announcementId: announcement.id, announcement: announcement.title, announcementUrl: announcement.url });
        if (existingJob(normalized)) throw fail(409, '该公告下已有相同岗位，请在岗位库中查看。');
        let job;
        db.exec('BEGIN');
        try { job = insertJob(normalized); touchAnnouncement(announcement); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
        send(res, 201, { job, announcement }); return true;
      }
      const automationMatch = route.match(/^\/api\/job-sources\/([a-z0-9-]+)\/automation$/);
      if (req.method === 'PUT' && automationMatch) {
        const input = await jsonBody(req), source = read('job_sources',automationMatch[1]);
        if (!source.platform || !platformBrowser) throw fail(400,'此来源不支持自动拉取。');
        if (pulling.has(source.id)) throw fail(409,'来源正在采集，请完成后修改。');
        if (input.revision !== (source.revision || 1)) throw fail(409,'来源设置已更新，请刷新。');
        if (typeof input.enabled !== 'boolean') throw fail(400,'请选择是否启用自动拉取。');
        if (input.enabled) {
          const intervalMinutes = Number(input.intervalMinutes), conditions = pullConditions(input.conditions);
          if (!Number.isInteger(intervalMinutes) || intervalMinutes < 15 || intervalMinutes > 1440) throw fail(400,'自动拉取间隔须为 15 至 1440 分钟。');
          searchQueries(conditions);
          source.automation = {enabled:true,paused:false,intervalMinutes,conditions,nextRunAt:currentTime()};
          source.lastConditions = conditions;
        } else source.automation = {...source.automation,enabled:false,paused:false};
        source.revision = (source.revision || 1)+1; save('job_sources',source);
        send(res,200,{source}); return true;
      }
      const openMatch = route.match(/^\/api\/job-sources\/([a-z0-9-]+)\/open$/);
      if (req.method === 'POST' && openMatch) {
        const input = await jsonBody(req), source = read('job_sources',openMatch[1]);
        const url = jobURL(input.url,true);
        if (!source.platform || platformForJobURL(url) !== source.platform || !platformBrowser?.openJob) throw fail(400,'此链接不属于当前招聘平台的岗位。');
        send(res,200,await platformBrowser.openJob(source.platform,url)); return true;
      }
      const loginMatch = route.match(/^\/api\/job-sources\/([a-z0-9-]+)\/login$/);
      if (req.method === 'POST' && loginMatch) {
        const source = read('job_sources', loginMatch[1]);
        if (source.platform) { if (!platformBrowser) throw fail(400, '本机招聘平台浏览器不可用。'); send(res, 200, await platformBrowser.login(source.platform)); return true; }
        if (!isOfferSource(source.url)) throw fail(400, '该来源不支持独立采集浏览器。');
        send(res, 200, await browser.login()); return true;
      }
      const sourceEdit = route.match(/^\/api\/job-sources\/([a-z0-9-]+)$/);
      if (req.method === 'PATCH' && sourceEdit) {
        const input = await jsonBody(req), source = read('job_sources', sourceEdit[1]);
        if (source.type === 'wechat') throw fail(400, '请使用微信群来源配置。');
        if (source.platform) throw fail(400, '招聘平台内置来源不可编辑。');
        if (pulling.has(source.id)) throw fail(409, '来源正在拉取，请稍后修改。');
        if (input.revision !== (source.revision || 1)) throw fail(409, '来源已更新，请刷新。');
        source.name = field(input.name, 120, '来源名称', true); source.url = jobURL(input.url, true); source.revision = (source.revision || 1) + 1; source.lastCheckedAt = ''; source.lastResult = '来源已修改，请重新拉取';
        save('job_sources', source); send(res, 200, { source }); return true;
      }
      if (req.method === 'POST' && route === '/api/job-sources') {
        const input = await jsonBody(req), source = { id: randomUUID(), revision: 1, name: field(input.name, 120, '来源名称', true), url: jobURL(input.url, true), createdAt: now(), lastCheckedAt: '', lastResult: '尚未拉取' };
        db.prepare('INSERT INTO job_sources(id,data) VALUES(?,?)').run(source.id, JSON.stringify(source)); send(res, 201, { source }); return true;
      }
      const sourceMatch = route.match(/^\/api\/job-sources\/([a-z0-9-]+)\/pull$/);
      if (req.method === 'POST' && sourceMatch) {
        const conditions = pullConditions(Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding'] ? await jsonBody(req) : {});
        send(res,200,await pullSource(sourceMatch[1],conditions));
        return true;
      }
      if (req.method === 'POST' && ['/api/jobs', '/api/jobs/import'].includes(route)) {
        const input = await jsonBody(req), values = route.endsWith('/import') ? input.jobs : [input];
        if (!Array.isArray(values) || !values.length || values.length > 200) throw fail(400, '每次入库 1 至 200 个岗位。');
        const result = importJobs(values);
        if (route === '/api/jobs' && !result.inserted) throw fail(409, result.suppressed ? '此岗位已彻底删除，已阻止重复入库。' : result.jobs[0]?.deletedAt ? '此岗位已在回收站，请恢复原记录。' : '相同岗位已存在，请在岗位库中查看。');
        send(res, 200, result); return true;

      }
      const jobMatch = route.match(/^\/api\/jobs\/([a-f0-9-]+)$/);
      if (req.method === 'GET' && jobMatch) {
        send(res, 200, { job: publicJob(read('jobs', jobMatch[1])) }); return true;
      }
      if (req.method === 'DELETE' && jobMatch) {
        const input = await jsonBody(req), job = read('jobs', jobMatch[1]);
        if(input.permanent===true){send(res,200,jobBatch({action:'purge',items:[{id:job.id,revision:input.revision,announcementRevision:input.announcementRevision}],confirm:input.confirm}));return true;}
        if (input.revision !== job.revision) throw fail(409, '岗位已更新，请刷新后重试。');
        if(job.deletedAt)throw fail(409,'岗位已在回收站。');
        job.deletedAt = now(); job.revision++; job.updatedAt = now(); save('jobs', job);
        send(res, 200, { job: publicJob(job) }); return true;
      }
      if (req.method === 'PATCH' && jobMatch) {
        const input = await jsonBody(req), previous = read('jobs', jobMatch[1]);
        if (input.revision !== previous.revision) throw fail(409, '岗位已更新，请刷新后再修改。');
        if (previous.deletedAt && input.restore !== true) throw fail(400, '请先从回收站恢复岗位。');
        if (announcementFor(previous.id) && Object.keys(input).some(key => !['revision', 'archived', 'restore', 'appliedPosition'].includes(key))) throw fail(400, '请在公告详情中修改公告内容。');
        if ((input.announcementId !== undefined && input.announcementId !== (previous.announcementId || '')) || (input.recordType !== undefined && input.recordType !== previous.recordType)) throw fail(400, '请使用公告关联操作修改记录类型或所属公告。');
        const updated = { ...previous, ...normalizeJob({ ...previous, ...input }), archived: input.archived === undefined ? previous.archived : input.archived === true, revision: previous.revision + 1, updatedAt: now() };
        if (input.restore === true) updated.deletedAt = '';
        const fingerprint = jobFingerprint(updated), duplicate = existingJob(updated, previous.id);
        if (duplicate) throw fail(409, '相同岗位已存在，请在岗位库中查看。');
        db.exec('BEGIN');
        try {
          if (fingerprint !== jobFingerprint(previous)) db.prepare('INSERT OR IGNORE INTO job_import_aliases(fingerprint,job_id) VALUES(?,?)').run(jobFingerprint(previous), previous.id);
          for (const identity of [platformJobFingerprint(previous),platformJobURLFingerprint(previous)].filter(Boolean)) db.prepare('INSERT OR IGNORE INTO job_import_aliases(fingerprint,job_id) VALUES(?,?)').run(identity, previous.id);
          db.prepare('UPDATE jobs SET data=?,fingerprint=? WHERE id=?').run(JSON.stringify(updated), fingerprint, updated.id);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        send(res, 200, { job: publicJob(updated) }); return true;
      }
      const progressMatch = route.match(/^\/api\/jobs\/([a-f0-9-]+)\/progress$/);
      if (req.method === 'POST' && progressMatch) {
        const input = await jsonBody(req), job = read('jobs', progressMatch[1]);
        if (job.deletedAt) throw fail(400, '请先恢复已删除的岗位。');
        if (!Object.hasOwn(APPLICATION_STATUSES, input.status)) throw fail(400, '请选择有效进展标签。');
        const row = db.prepare('SELECT data FROM applications WHERE job_id=?').get(job.id);
        const old = row ? JSON.parse(row.data) : null;
        if (old?.deletedAt) throw fail(409, '投递记录已在回收站，请先恢复。');
        if (!old && announcementFor(job.id)) throw fail(400, '请先在公告下添加具体岗位，再记录投递进展。');
        if (input.revision !== (old?.revision || 0)) throw fail(409, '进展已更新，请刷新后重试。');
        const timestamp = now();
        const app = old || { id: randomUUID(), jobId: job.id, jobSnapshot: job, revision: 0, channel: '岗位库手动记录', resumeSnapshot: null, createdAt: timestamp, submittedAt: '', nextActionAt: '', nextAction: '', history: [] };
        if (app.status !== input.status) {
          app.history.push({ at: timestamp, status: input.status, previousStatus: app.status || 'preparing', note: `在岗位列表手动更新为${APPLICATION_STATUSES[input.status]}。` });
          if (!app.submittedAt && !['preparing', 'withdrawn'].includes(input.status)) app.submittedAt = timestamp;
          app.status = input.status; app.revision++; app.updatedAt = timestamp;
          if (old) save('applications', app); else db.prepare('INSERT INTO applications(id,job_id,data) VALUES(?,?,?)').run(app.id, job.id, JSON.stringify(app));
        }
        send(res, 200, { application: app }); return true;
      }
      if (req.method === 'POST' && route === '/api/applications') {
        const input = await jsonBody(req), job = read('jobs', input.jobId), previous = db.prepare('SELECT data FROM applications WHERE job_id=?').get(job.id);
        if (job.deletedAt) throw fail(400, '请先恢复已删除的岗位。');
        if (previous) { const app=JSON.parse(previous.data); if(app.deletedAt)throw fail(409,'投递记录已在回收站，请先恢复。'); send(res, 200, { application: app, duplicate: true }); return true; }
        if (announcementFor(job.id)) throw fail(400, '请先在公告下添加具体岗位，再准备投递。');
        const resumeSnapshot = snapshot(input);
        if (resumeSnapshot && /\[(?:待补充|实际|真实|具体|可验证)[^\]]*\]/.test(resumeSnapshot.text)) throw fail(400, '所选简历仍含待补充内容，请先完成定稿再准备投递。');
        const timestamp = now(), app = { id: randomUUID(), jobId: job.id, jobSnapshot: job, status: 'preparing', revision: 1, channel: field(input.channel, 120, '投递渠道') || '原岗位网站', resumeSnapshot, createdAt: timestamp, updatedAt: timestamp, submittedAt: '', nextActionAt: dateValue(input.nextActionAt), nextAction: field(input.nextAction, 500, '下一步安排'), history: [{ status: 'preparing', at: timestamp, note: field(input.note, 5000, '备注') || '已建立投递记录，尚未确认投递。' }] };
        db.prepare('INSERT INTO applications(id,job_id,data) VALUES(?,?,?)').run(app.id, job.id, JSON.stringify(app)); send(res, 201, { application: app }); return true;
      }
      const appMatch = route.match(/^\/api\/applications\/([a-f0-9-]+)(?:\/(resume))?$/);
      if (appMatch && !appMatch[2] && req.method === 'DELETE') {
        const input=await jsonBody(req),app=read('applications',appMatch[1]);
        if(input.revision!==app.revision)throw fail(409,'投递记录已更新，请刷新后重试。');
        if(input.permanent===true){
          if(!app.deletedAt)throw fail(400,'请先将投递记录移入回收站。');
          if(input.confirm!==true)throw fail(400,'请确认彻底删除，此操作无法恢复。');
          db.exec('BEGIN');
          try {
            for(const row of db.prepare('SELECT id,data FROM mail_messages').all()){
              const m=JSON.parse(row.data);if(m.applicationId!==app.id)continue;
              m.applicationId='';m.linkEdited=true;m.revision++;
              for(const key of ['applicationBefore','appliedAt','appliedStatus','appliedRevision','autoApplied','undoneAt'])delete m[key];
              db.prepare('UPDATE mail_messages SET data=? WHERE id=?').run(JSON.stringify(m),m.id);
            }
            for(const kind of ['preparing','followup'])db.prepare('DELETE FROM todo_actions WHERE id=?').run(createHash('sha256').update(kind+':'+app.id).digest('hex').slice(0,32));
            db.prepare('DELETE FROM applications WHERE id=?').run(app.id);
            db.exec('COMMIT');
          }catch(error){db.exec('ROLLBACK');throw error;}
          send(res,200,{deleted:true});return true;
        }
        if(app.deletedAt)throw fail(409,'此记录已在回收站。');
        app.deletedAt=now();app.revision++;save('applications',app);
        send(res,200,{application:app});return true;
      }
      if (appMatch && req.method === 'GET') {
        const app = read('applications', appMatch[1]);
        if (appMatch[2]) {
          if (!app.resumeSnapshot) throw fail(404, '该记录未关联简历。');
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(app.resumeSnapshot.name + '-投递快照.txt')}` }); res.end(app.resumeSnapshot.text);
        } else send(res, 200, { application: app });
        return true;
      }
      if (appMatch && !appMatch[2] && req.method === 'PATCH') {
        const input=await jsonBody(req);
        if(input.restore===true){
          const app=read('applications',appMatch[1]);
          if(input.revision!==app.revision)throw fail(409,'投递记录已更新，请刷新后重试。');
          if(!app.deletedAt)throw fail(409,'此记录不在回收站。');
          app.deletedAt='';app.revision++;save('applications',app);
          send(res,200,{application:app});return true;
        }
        send(res, 200, { application: updateApplication(appMatch[1], input) }); return true;
      }
      return false;
    },
  };
}
