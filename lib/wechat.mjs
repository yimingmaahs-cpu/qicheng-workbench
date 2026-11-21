import { createHash, randomUUID } from 'node:crypto';
import {textConnector} from './text-connector.mjs';
import { field, normalizeJob } from './jobs.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const chinaClock = date => new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 16);
export function wechatConfig(input) {
  const group = field(input.group, 100, '微信群名', true);
  const time = field(input.dailyTime, 5, '采集时间') || '09:00';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw fail(400, '请选择有效的每日采集时间。');
  const limit = input.limit === '' || input.limit === undefined ? 500 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 20 || limit > 2000) throw fail(400, '每次读取条数须为 20 至 2000。');
  return { type: 'wechat', group, name: '微信群 · ' + group, url: '', dailyTime: time, enabled: input.enabled === true,
    keyword: field(input.keyword, 300, '岗位关键词'), exclude: field(input.exclude, 300, '排除关键词'),
    location: field(input.location, 200, '地点关键词'), limit };
}
const words = value => String(value || '').split(/[,，;；\n]/).map(x => x.trim().toLowerCase()).filter(Boolean);
export const messageFingerprint = text => createHash('sha256').update(text.normalize('NFKC').replace(/[\s\u200b-\u200d\ufeff]+/g, '').toLowerCase()).digest('hex');

export function recruitingMessage(message, source) {
  if (message.type === '系统') return { reason: 'filtered' };
  if (typeof message.text !== 'string' || !['文本', '链接', 'text', 'link'].includes(message.type)) return { reason: 'unsupported' };
  const text = message.text.trim();
  if (!text || text.length > 30000) return { reason: 'unsupported' };
  const lower = text.toLowerCase();
  // A job keyword alone (e.g. someone asking about a PM interview) is not a vacancy.
  if (!/(招聘|校招|秋招|春招|内推|招聘岗位|职位描述|岗位职责|招募|诚聘|急聘|招聘需求|招[聘收]实习)/.test(text)) return { reason: 'filtered' };
  if (words(source.keyword).length && !words(source.keyword).some(w => lower.includes(w))) return { reason: 'filtered' };
  if (words(source.exclude).some(w => lower.includes(w))) return { reason: 'filtered' };
  if (words(source.location).length && !words(source.location).some(w => lower.includes(w))) return { reason: 'filtered' };
  const draft = wechatJob(text, source);
  return { text, fingerprint: messageFingerprint(text), draft, job: draft };
}

export function wechatJob(text, source) {
  // ponytail: common local JD formats; unknown values stay empty instead of blocking import.
  const label = names => text.match(new RegExp('(?:^|\\n)\\s*(?:【(?:' + names + ')】|\\[(?:' + names + ')\\]|(?:' + names + ')\\s*[:：])\\s*[:：]?\\s*([^\\n]+)', 'i'))?.[1]?.trim() || '';
  let company = label('公司名称|招聘企业|企业名称|公司|企业');
  if (!company) {
    const intro = label('公司简介|企业简介|关于我们');
    company = intro.match(/^(.{2,60}?)(?:是一家|是一|是|成立于|创立于|专注于|致力于)/)?.[1] || '';
  }
  if (!company) {
    const headline = text.split('\n').find(line => line.trim())?.trim().replace(/^[【\[\s]+|[】\]]/g, '') || '';
    company = headline.match(/^([^，。！!：:\n]{2,60}?)(?:(?:20)?\d{2}届|20\d{2}年?|校园招聘|秋招|春招|校招|招聘|诚聘)/)?.[1]?.trim() || '';
    if (/^(全国|上海|北京|深圳|广州|成都|杭州|武汉|南京|天津|公司|企业|我们|本公司|招聘|校园|急聘|实习|内推)$/.test(company)) company = '';
  }
  const title = label('岗位名称|招聘岗位|热招岗位|职位名称|招聘职位|岗位|职位');
  const location = label('工作地点|工作城市|地点|城市');
  const urls = text.match(/https?:\/\/[^\s<>"“”]+/g) || [];
  const url = (urls[0] || '').replace(/[。；，、）)\]】]+$/, '');
  const draft = { sourceType:'wechat', company:company.slice(0,160), title:title.slice(0,160), location:location.slice(0,200),
    description:text, url:'', sourceName:source.name || '微信群 · ' + source.group, category:label('招聘类型|岗位类型').slice(0,100),
    announcement:text.split('\n').find(line=>line.trim())?.slice(0,500) || '', notes:'来自微信群：'+source.group };
  try { if(url) { const parsed=new URL(url); if(!parsed.username && !parsed.password && parsed.href.length<=2000)draft.url=parsed.href; } } catch {}
  return normalizeJob(draft);
}

export function scheduledDue(source, date = new Date()) {
  const local = chinaClock(date), day = local.slice(0,10);
  return source.type === 'wechat' && source.enabled && local.slice(11) >= source.dailyTime && source.lastScheduledDay !== day
    && !(source.retryAt && new Date(source.retryAt) > date) && !(source.attemptDay === day && source.attempts >= 3);
}
export function nextWechatRun(source, date = new Date()) {
  if (!source.enabled) return '';
  const day = chinaClock(date).slice(0,10);
  let next = new Date(`${day}T${source.dailyTime}:00+08:00`);
  if (source.lastScheduledDay === day || (source.attemptDay === day && source.attempts >= 3)) next = new Date(next.getTime()+86400000);
  if(source.retryAt&&new Date(source.retryAt)>next)next=new Date(source.retryAt);
  return next.toISOString();
}

export function wechatCoverage(messages,limit) {
  const dates=[];
  for(const message of messages) {
    const stamp=typeof message?.sentAt==='string'?message.sentAt.trim():'';
    const match=stamp.match(/^(20\d{2})[年/.-](\d{1,2})[月/.-](\d{1,2})日?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if(!match)continue;
    const [,y,mo,d,h,mi,sec='0']=match;
    const check=new Date(Date.UTC(+y,+mo-1,+d,+h,+mi,+sec));
    if(check.getUTCFullYear()!==+y||check.getUTCMonth()!==+mo-1||check.getUTCDate()!==+d||+h>23||+mi>59||+sec>59)continue;
    dates.push(new Date(check.getTime()-8*3600000).toISOString());
  }
  dates.sort();return {readCount:messages.length,limit,limitReached:messages.length>=limit,datedCount:dates.length,unknownTimeCount:messages.length-dates.length,from:dates[0]||'',to:dates.at(-1)||''};
}

export function wechatSources(db, { importJobs, reader = textConnector(), clock = ()=>new Date() }) {
  db.exec('CREATE TABLE IF NOT EXISTS wechat_candidates(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL UNIQUE,status TEXT NOT NULL,data TEXT NOT NULL)');
  const sources = ()=>db.prepare('SELECT data FROM job_sources').all().map(r=>JSON.parse(r.data)).filter(s=>s.type==='wechat');
  const save = source=>db.prepare('UPDATE job_sources SET data=? WHERE id=?').run(JSON.stringify(source),source.id);
  const get = id=>{const s=sources().find(s=>s.id===id);if(!s)throw fail(404,'微信群来源不存在。');return s;};
  let running = '', timer = null, closed = false;
  const publicSource = source=>{const {readCursor,...safe}=source;return {...safe,readerMode:reader.mode?.() || source.readerMode || 'unknown',running:running===source.id,nextRunAt:nextWechatRun(source,clock())};};
  function list(status='pending') {
    if(!['pending','imported','ignored'].includes(status)) throw fail(400,'无效的消息状态。');
    const rows=db.prepare('SELECT data FROM wechat_candidates WHERE status=? ORDER BY rowid DESC LIMIT 200').all(status).map(r=>JSON.parse(r.data));
    return { candidates:rows, total:db.prepare('SELECT COUNT(*) AS n FROM wechat_candidates WHERE status=?').get(status).n };
  }
  function ingest(source, result, afterIngest=()=>{}) {
    if(!Array.isArray(result.messages) || result.messages.length>2000) throw fail(502,'采集结果格式不正确。');
    const stats={scanned:result.messages.length,matched:0,inserted:0,pending:0,duplicates:0,filtered:0,unsupported:0};
    db.exec('BEGIN');
    try {
      for(const message of result.messages) {
        const parsed=recruitingMessage(message || {},source);
        if(parsed.reason) {stats[parsed.reason]++;continue;}
        stats.matched++;
        if(db.prepare('SELECT id FROM wechat_candidates WHERE fingerprint=?').get(parsed.fingerprint)) {stats.duplicates++;continue;}
        const candidate={id:randomUUID(),sourceId:source.id,group:source.group,text:parsed.text,draft:parsed.draft,firstSeenAt:clock().toISOString(),sentAt:typeof message.sentAt==='string'?message.sentAt.slice(0,100):'',status:'pending'};
        {
          const imported=importJobs([parsed.job],{transaction:false});candidate.status='imported';candidate.jobId=imported.jobs[0]?.id || '';if(imported.suppressed){candidate.purged=true;delete candidate.text;delete candidate.draft;}
          stats.inserted+=imported.inserted;stats.duplicates+=imported.duplicates;
        }
        db.prepare('INSERT INTO wechat_candidates(id,fingerprint,status,data) VALUES(?,?,?,?)').run(candidate.id,parsed.fingerprint,candidate.status,JSON.stringify(candidate));
      }
      afterIngest(stats);db.exec('COMMIT'); return stats;
    } catch(error) {db.exec('ROLLBACK');throw error;}
  }
  const pending = db.prepare("SELECT data FROM wechat_candidates WHERE status='pending'").all();
  if (pending.length) {
    db.exec('BEGIN');
    try {
      for (const row of pending) {
        const candidate=JSON.parse(row.data);
        const job=wechatJob(candidate.text,{group:candidate.group});
        const result=importJobs([job],{transaction:false});
        Object.assign(candidate,{status:'imported',jobId:result.jobs[0]?.id || ''});if(result.suppressed){candidate.purged=true;delete candidate.text;delete candidate.draft;}else candidate.draft=job;
        db.prepare('UPDATE wechat_candidates SET status=?,data=? WHERE id=?').run(candidate.status,JSON.stringify(candidate),candidate.id);
      }
      db.exec('COMMIT');
    } catch(error) {db.exec('ROLLBACK');throw error;}
  }
  async function collect(id, scheduled=false) {
    if(closed) throw fail(503,'微信采集已停止。');
    if(running) throw fail(409,'另一微信群正在采集，请稍后重试。');
    const source=get(id); running=id;
    const day=chinaClock(clock()).slice(0,10);
    if(scheduled) {source.attempts=source.attemptDay===day?(source.attempts || 0)+1:1;source.attemptDay=day;}
    try {
      source.lastResult=source.readCursor?'正在核验读取位置并补读指定微信群的新消息…':'正在读取指定微信群的最近消息…';source.lastAttemptAt=clock().toISOString();source.retryAt='';save(source);
      const result=await reader.read({group:source.group,limit:source.limit,...(source.readCursor?{cursor:source.readCursor}:{})});
      if(closed) throw fail(503,'微信采集已停止。');
      if((source.readCursor || result.mode==='database') && (!result.nextCursor || result.nextCursor.version!==1 || typeof result.nextCursor.scope!=='string' || !result.nextCursor.shards || !['baseline','continuous'].includes(result.coverage?.continuity)))throw fail(502,'增量采集结果缺少有效读取位置，未导入本批消息。');
      const nextSource={...source};
      const stats=ingest(source,result,stats=>{
        nextSource.lastCoverage={...wechatCoverage(result.messages,source.limit),...(result.coverage?{incremental:result.coverage.incremental===true,hasMore:result.coverage.hasMore===true,continuity:result.coverage.continuity}:{})};
        nextSource.lastStats=stats;nextSource.lastCheckedAt=clock().toISOString();nextSource.lastSuccessAt=nextSource.lastCheckedAt;
        nextSource.lastScheduledDay=day;nextSource.retryAt='';nextSource.lastError='';nextSource.incrementalResetRequired=false;
        nextSource.readerMode=result.mode || reader.mode?.() || 'unknown';
        if(result.nextCursor)nextSource.readCursor=result.nextCursor;
        nextSource.lastResult=`读取 ${stats.scanned} 条；招聘消息 ${stats.matched} 条；新增岗位 ${stats.inserted} 条；重复 ${stats.duplicates} 条；过滤 ${stats.filtered} 条；不支持 ${stats.unsupported} 条。`+(result.coverage?.hasMore?'仍有消息待补读，可继续采集。':'');
        nextSource.warning=typeof result.warning==='string'?result.warning.slice(0,500):'';save(nextSource);
      });
      return {source:{...publicSource(nextSource),running:false},stats,formats:result.formats};
    } catch(error) {
      if(!closed) {source.lastCheckedAt=clock().toISOString();source.lastError=error.status?error.message:'消息处理失败，请稍后重试。';source.lastResult=source.lastError;source.incrementalResetRequired=error.code==='WECHAT_CURSOR_INVALID' && !!source.readCursor;
        if(scheduled && source.attempts<3) source.retryAt=new Date(clock().getTime()+30*60000).toISOString();save(source);}
      throw error;
    } finally {running='';}
  }
  async function tick() {
    if(closed || running || reader.busy?.()) return;
    for(const s of sources()) if(scheduledDue(s,clock())) {try {await collect(s.id,true);} catch {} if(closed)return;}
  }
  return {
    state:()=>({pendingCount:db.prepare("SELECT COUNT(*) AS n FROM wechat_candidates WHERE status='pending'").get().n,sources:sources().map(publicSource)}),
    start(){closed=false;timer=setInterval(()=>{void tick();},30000);timer.unref();},
    stop(){closed=true;clearInterval(timer);reader.stop?.();}, tick, collect, ingest,
    async handle(req,res,route,{jsonBody,send}) {
      if(route==='/api/wechat/check' && req.method==='POST') {send(res,200,await reader.check());return true;}
      if(route==='/api/wechat/sources' && req.method==='POST') {
        const input=wechatConfig(await jsonBody(req));
        if(sources().some(s=>s.group===input.group)) throw fail(409,'该微信群已添加，请编辑现有来源。');
        const source={...input,id:randomUUID(),revision:1,createdAt:clock().toISOString(),lastResult:'尚未采集',lastCheckedAt:'',lastScheduledDay:chinaClock(clock()).slice(0,10)};
        db.prepare('INSERT INTO job_sources(id,data) VALUES(?,?)').run(source.id,JSON.stringify(source));send(res,201,{source:publicSource(source)});return true;
      }
      const match=route.match(/^\/api\/wechat\/sources\/([a-f0-9-]+)(?:\/(pull|status|reset-cursor))?$/);
      if(match && match[2]==='status' && req.method==='GET') {send(res,200,{source:publicSource(get(match[1]))});return true;}
      if(match && match[2]==='pull' && req.method==='POST') {send(res,200,await collect(match[1]));return true;}
      if(match && !match[2] && req.method==='DELETE') {
        const input=await jsonBody(req),source=get(match[1]);
        if(running===source.id)throw fail(409,'正在采集，请结束后再移除。');
        if(input.revision!==source.revision)throw fail(409,'配置已更新，请刷新。');
        if(input.confirm!==true)throw fail(400,'请确认移除来源。');
        db.prepare('DELETE FROM job_sources WHERE id=?').run(source.id);
        send(res,200,{removed:true});return true;
      }
      if(match && match[2]==='reset-cursor' && req.method==='POST') {
        if(running===match[1])throw fail(409,'正在采集，请结束后再重建读取起点。');
        const input=await jsonBody(req),source=get(match[1]);
        if(running===match[1])throw fail(409,'正在采集，请结束后再重建读取起点。');
        if(input.revision!==source.revision)throw fail(409,'配置已更新，请刷新后重试。');
        if(input.confirmed!==true)throw fail(400,'请确认重建起点后只读取最近设定条数，更早未读取历史可能遗漏。');
        if(!source.readCursor)throw fail(400,'当前没有需要重建的增量读取位置。');
        delete source.readCursor;delete source.lastCoverage;
        Object.assign(source,{revision:source.revision+1,incrementalResetRequired:false,lastError:'',retryAt:'',attempts:0,lastResult:'读取起点已重置，下次采集将读取最近消息并建立新起点。',warning:'重建起点前后的历史不保证连续；原有岗位、忽略和删除记录均保留。'});
        save(source);send(res,200,{source:publicSource(source)});return true;
      }
      if(match && !match[2] && req.method==='PATCH') {
        if(running===match[1]) throw fail(409,'正在采集，请稍后修改。');
        const input=await jsonBody(req),source=get(match[1]);
        if(running===match[1])throw fail(409,'正在采集，请稍后修改。');
        if(input.revision!==source.revision) throw fail(409,'配置已更新，请刷新。');
        const config=wechatConfig(input);
        if(sources().some(s=>s.id!==source.id && s.group===config.group)) throw fail(409,'该微信群已添加。');
        if(config.group!==source.group) {delete source.readCursor;delete source.lastCoverage;source.incrementalResetRequired=false;source.warning='群名已修改，下次采集会核验授权并建立新的读取起点。';}
        Object.assign(source,config,{revision:source.revision+1,retryAt:'',attempts:0});save(source);send(res,200,{source:publicSource(source)});return true;
      }
      if(route==='/api/wechat/candidates' && req.method==='GET') {const url=new URL(req.url,'http://localhost');send(res,200,list(url.searchParams.get('status') || 'pending'));return true;}
      const candidateMatch=route.match(/^\/api\/wechat\/candidates\/([a-f0-9-]+)\/(import|ignore|restore)$/);
      if(candidateMatch && req.method==='POST') {
        const row=db.prepare('SELECT data FROM wechat_candidates WHERE id=?').get(candidateMatch[1]);if(!row)throw fail(404,'消息不存在。');
        const candidate=JSON.parse(row.data);
        if(candidate.status==='imported')throw fail(409,'该消息已入库。');
        const action=candidateMatch[2];let result;
        if(action==='import' || action==='restore') {
          const input=action==='import'?await jsonBody(req):{};const job=normalizeJob({...wechatJob(candidate.text,{group:candidate.group}),...input,sourceType:'wechat',sourceName:'微信群 · '+candidate.group});
          db.exec('BEGIN');
          try {result=importJobs([job],{transaction:false});if(result.suppressed)throw fail(409,'此岗位已彻底删除，后续采集会跳过。');candidate.jobId=result.jobs[0].id;candidate.status='imported';candidate.draft=job;
            db.prepare('UPDATE wechat_candidates SET status=?,data=? WHERE id=?').run(candidate.status,JSON.stringify(candidate),candidate.id);db.exec('COMMIT');}
          catch(error) {db.exec('ROLLBACK');throw error;}
        } else {candidate.status=action==='ignore'?'ignored':'pending';db.prepare('UPDATE wechat_candidates SET status=?,data=? WHERE id=?').run(candidate.status,JSON.stringify(candidate),candidate.id);}
        send(res,200,{candidate,...result});return true;
      }
      return false;
    },
  };
}
