import {randomUUID} from 'node:crypto';
import {field} from './jobs.mjs';
import {recruitingMessage,messageFingerprint} from './wechat.mjs';
const fail=(status,message)=>Object.assign(Error(message),{status});
export function qqSources(db,{importJobs,reader,clock=()=>new Date()}={}){
  db.exec('CREATE TABLE IF NOT EXISTS qq_sources(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS qq_seen(fingerprint TEXT PRIMARY KEY);');
  let running='',closed=false,timer,selection=null;
  const now=()=>clock().toISOString(),all=()=>db.prepare('SELECT data FROM qq_sources ORDER BY rowid').all().map(r=>JSON.parse(r.data));
  const get=id=>{const row=db.prepare('SELECT data FROM qq_sources WHERE id=?').get(id);if(!row)throw fail(404,'QQ 来源不存在。');return JSON.parse(row.data);};
  const save=s=>db.prepare('UPDATE qq_sources SET data=? WHERE id=?').run(JSON.stringify(s),s.id);
  const publicSource=s=>{const {lastMessageId,...rest}=s;return {...rest,running:running===s.id};};
  const preferences=input=>{
    const interval=Number(input.interval??5),limit=Number(input.limit??100);
    if(!Number.isInteger(interval)||interval<1||interval>60||!Number.isInteger(limit)||limit<20||limit>200)throw fail(400,'采集间隔为 1–60 分钟，每批 20–200 条。');
    return {interval,limit,keyword:field(input.keyword,300,'岗位关键词'),location:field(input.location,200,'城市关键词'),exclude:field(input.exclude,300,'排除关键词'),enabled:input.enabled===true};
  };
  const needReader=()=>{if(!reader)throw fail(503,'QQ 自动采集需要新版启动器。');if(closed)throw fail(503,'QQ 采集已关闭。');};
  async function collect(id,preview=false){
    needReader();if(running)throw fail(409,'另一个 QQ 群正在读取，请稍后。');const source=get(id);running=id;
    try{
      const messages=await reader.read({...source,limit:preview?20:source.limit});if(closed)throw fail(503,'QQ 采集已停止，本批未入库。');
      if(!Array.isArray(messages)||messages.length>(preview?20:source.limit))throw fail(502,'QQ 读取结果无效。');
      const parsed=messages.map(m=>recruitingMessage(m,{...source,name:'QQ群 · '+source.group}));
      if(preview)return {messages:messages.map((m,i)=>({text:m.text,sentAt:m.sentAt,matched:!!parsed[i].job})),note:'试读最近 20 条，不入库；只读取文本，图片、附件及合并转发不解析。'};
      const stats={scanned:messages.length,matched:0,inserted:0,duplicates:0,filtered:0,unsupported:0};
      const nextSource={...source};
      const warning=source.lastMessageId&&!messages.some(m=>m.id===source.lastMessageId)?'最近消息中未找到上次读取位置，期间可能有遗漏。可提高条数、缩短间隔或手动导入缺失记录。':!source.lastMessageId?'首次只读取最近一批，更早历史不在本次范围内。':'';
      db.exec('BEGIN');
      try{
        for(const p of parsed){
          if(p.reason){stats[p.reason]++;continue;}stats.matched++;
          const fingerprint=messageFingerprint(p.text);
          if(db.prepare('SELECT 1 FROM qq_seen WHERE fingerprint=?').get(fingerprint)){stats.duplicates++;continue;}
          const job={...p.job,sourceType:'qq',sourceName:'QQ群 · '+source.group,notes:'来自 QQ 群：'+source.group};
          const result=importJobs([job],{transaction:false});stats.inserted+=result.inserted;stats.duplicates+=result.duplicates;
          db.prepare('INSERT INTO qq_seen VALUES(?)').run(fingerprint);
        }
        const latest=[...messages].sort((a,b)=>String(a.sentAt).localeCompare(String(b.sentAt))).at(-1);
        Object.assign(nextSource,{lastMessageId:latest?.id||source.lastMessageId||'',lastSuccessAt:now(),lastAttemptAt:now(),lastError:'',warning,lastStats:stats,nextRunAt:new Date(clock().getTime()+source.interval*60000).toISOString(),lastResult:`读取 ${stats.scanned} 条，新增 ${stats.inserted} 条，重复 ${stats.duplicates} 条，过滤 ${stats.filtered} 条，不支持 ${stats.unsupported} 条。`});save(nextSource);db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');throw e;}
      return {source:{...publicSource(nextSource),running:false},stats};
    }catch(e){if(!preview&&!closed){Object.assign(source,{lastAttemptAt:now(),lastError:e.status?e.message:'QQ 处理失败，本批未入库。',nextRunAt:new Date(clock().getTime()+15*60000).toISOString()});save(source);}throw e;}
    finally{running='';}
  }
  async function tick(){if(closed||running||!reader)return;for(const {id} of all()){if(closed)return;try{const s=get(id);if(s.enabled&&(!s.nextRunAt||s.nextRunAt<=now()))await collect(s.id);}catch{}}}
  return {
    state:()=>({supported:!!reader,setupProgress:!!reader?.startSetup,sources:all().map(publicSource)}),collect,tick,
    start(){closed=false;timer=setInterval(()=>void tick(),10000);timer.unref();},stop(){closed=true;clearInterval(timer);selection=null;},
    async handle(req,res,route,{jsonBody,send}){
      if(!route.startsWith('/api/qq/'))return false;needReader();
      if(route==='/api/qq/status'&&req.method==='GET'){send(res,200,await reader.status());return true;}
      if(route==='/api/qq/setup-progress'&&req.method==='GET'){send(res,200,reader.progress());return true;}
      if(req.method==='GET')throw fail(404,'QQ 接口不存在。');const input=await jsonBody(req);
      if(route==='/api/qq/setup'&&req.method==='POST'){if(input.consent!==true)throw fail(400,'请确认安装第三方 QQ 本地连接组件。');send(res,input.background===true?202:200,input.background===true?reader.startSetup():await reader.setup());return true;}
      if(route==='/api/qq/login'&&req.method==='POST'){send(res,200,reader.login());return true;}
      if(route==='/api/qq/groups'&&req.method==='POST'){
        if(input.consent!==true)throw fail(400,'请确认读取 QQ 群名。');const result=await reader.groups();
        if(all().some(s=>s.accountId!==result.account.id))throw fail(409,'工作区已连接另一个 QQ 账号，请先移除旧 QQ 来源。');
        selection={...result,token:randomUUID(),expires:clock().getTime()+600000};send(res,200,{account:result.account,groups:result.groups,token:selection.token});return true;
      }
      if(route==='/api/qq/connect'&&req.method==='POST'){
        const choice=selection;if(input.consent!==true||!choice||input.token!==choice.token||choice.expires<clock().getTime())throw fail(409,'QQ 群选择已过期或未授权，请重新选择。');
        if(!Array.isArray(input.groups)||!input.groups.length||input.groups.length>20||new Set(input.groups).size!==input.groups.length)throw fail(400,'请选择 1–20 个 QQ 群。');
        const groups=input.groups.map(id=>choice.groups.find(g=>g.id===id));if(groups.some(g=>!g))throw fail(400,'请选择列表中的 QQ 群。');
        const settings=preferences({...input,enabled:false}),status=await reader.status();
        if(closed||!status.online||status.account.id!==choice.account.id)throw fail(409,'QQ 登录账号发生变化，请重新连接。');
        if(all().some(s=>s.accountId!==choice.account.id))throw fail(409,'工作区 QQ 账号已变更，请刷新。');
        const sources=[];db.exec('BEGIN');try{for(const g of groups){const old=all().find(s=>s.groupId===g.id);if(old){sources.push(publicSource(old));continue;}const s={...settings,id:randomUUID(),groupId:g.id,group:g.name,accountId:choice.account.id,revision:1,createdAt:now(),lastResult:'已连接，请先试读并启用采集。'};db.prepare('INSERT INTO qq_sources VALUES(?,?)').run(s.id,JSON.stringify(s));sources.push(publicSource(s));}db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
        selection=null;send(res,200,{sources});return true;
      }
      const match=route.match(/^\/api\/qq\/sources\/([a-f0-9-]+)(?:\/(preview|pull))?$/);
      if(match&&req.method==='POST'&&match[2]){send(res,200,await collect(match[1],match[2]==='preview'));return true;}
      if(match&&!match[2]&&['PATCH','DELETE'].includes(req.method)){
        if(running===match[1])throw fail(409,'正在读取此 QQ 群，请稍后。');const s=get(match[1]);if(input.revision!==s.revision)throw fail(409,'QQ 来源已更新，请刷新。');
        if(req.method==='DELETE'){if(input.confirm!==true)throw fail(400,'请确认移除来源。');db.prepare('DELETE FROM qq_sources WHERE id=?').run(s.id);send(res,200,{removed:true});}
        else{Object.assign(s,preferences(input));Object.assign(s,{revision:s.revision+1,nextRunAt:new Date(clock().getTime()+s.interval*60000).toISOString()});save(s);send(res,200,{source:publicSource(s)});}return true;
      }
      throw fail(404,'QQ 接口不存在。');
    }
  };
}
