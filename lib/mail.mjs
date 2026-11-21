import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { field, dateValue, APPLICATION_STATUSES } from './jobs.mjs';
import { mailEvents, mailDetails, progressWarnings } from './mail-events.mjs';

const fail = (status,message)=>Object.assign(new Error(message),{status});
const secretCommand=`$ErrorActionPreference='Stop'; [Console]::InputEncoding=[System.Text.Encoding]::UTF8; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; try { [System.Reflection.Assembly]::LoadWithPartialName('System.Security') | Out-Null; $request=[Console]::In.ReadToEnd() | ConvertFrom-Json; $scope=[System.Security.Cryptography.DataProtectionScope]::CurrentUser; if($request.operation -eq 'seal'){$bytes=[System.Text.Encoding]::UTF8.GetBytes($request.value); [Console]::Write([Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,$scope)))} elseif($request.operation -eq 'open'){$bytes=[Convert]::FromBase64String($request.value); [Console]::Write([System.Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,$scope)))} else {exit 1} } catch {exit 1}`;

export function protectMailSecret(value, operation) {
  if(process.platform!=='win32')throw fail(400,'本机加密保存需要 Windows；请取消记住授权码。');
  return new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',secretCommand],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let out='',done=false;const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(result);};
    const timer=setTimeout(()=>{child.kill();finish(fail(500,'本机凭据加密操作超时。'));},10000);
    child.stdout.setEncoding('utf8');child.stdout.on('data',s=>{out+=s;if(out.length>20000){child.kill();finish(fail(500,'凭据格式错误。'));}});child.stderr.resume();child.stdin.on('error',()=>{});
    child.on('error',()=>finish(fail(500,'无法使用 Windows 凭据加密。')));child.on('close',code=>finish(code===0&&out?null:fail(500,'凭据无法解密，请重新填写邮箱授权码。'),out));
    child.stdin.end(JSON.stringify({value,operation}));
  });
}
export function mailConfig(input) {
  const account=field(input.account,160,'QQ 邮箱地址',true).toLowerCase();
  if(!/^[a-z0-9._+-]+@(qq\.com|foxmail\.com)$/.test(account))throw fail(400,'请填写完整的个人 QQ / Foxmail 邮箱地址。');
  const values=input.folders===undefined?[input.folder||'INBOX']:input.folders;
  if(!Array.isArray(values)||!values.length||values.length>10)throw fail(400,'请选择 1 至 10 个邮件文件夹。');
  const folders=[...new Set(values.map(value=>{const s=field(value,200,'邮件文件夹',true);if(/[\x00-\x1f]/.test(s))throw fail(400,'邮件文件夹名称无效。');return s;}))];
  const folder=folders[0];
  const days=Number(input.days??30),limit=Number(input.limit??100),interval=Number(input.interval??15);
  if(![7,30,90].includes(days)||!Number.isInteger(limit)||limit<1||limit>200||![15,30,60].includes(interval))throw fail(400,'请选择有效的同步范围、条数和间隔。');
  return {account,folder,folders,days,limit,interval,enabled:input.enabled===true,remember:input.remember===true};
}
export function mailSignal(subject='',text='') {
  // Only explicit notices produce a stage; ambiguous content stays unclassified.
  const content=(subject+'\n'+text.split(/\n(?:From:|发件人[:：]|On .+wrote:)/i)[0]).slice(0,20000);
  const relevant=/(招聘|应聘|求职|简历|面试|初试|复试|终面|笔试|测评|评测|测验|在线测试|录用|校招|网申|秋招|春招|interview|application|assessment|\bjob\b|\boffer\b)/i.test(content);
  if(!relevant)return {relevant:false,status:''};
  const matches=[];
  if(/未能通过|未通过|不予录用|未被录用|不再推进|遗憾.{0,20}(未能|未通过)|not (?:selected|proceeding)|unsuccessful/i.test(content))matches.push('rejected');
  if(/录用通知|正式录用|聘用通知|offer letter|offer of employment|\bjob offer\b/i.test(content))matches.push('offer');
  if(/(?:面试|初试|复试|终面)(?:邀请|通知|安排)|(?:邀请|请您|请你|请于).{0,30}(?:参加|预约|确认).{0,12}面试|interview (?:invitation|schedule)|invite.{0,30}interview/i.test(content))matches.push('interview');
  if(/(?:笔试|测评|评测|测验|在线测试)(?:邀请|通知|安排|提醒)|(?:邀请|请您|请你|请于).{0,40}(?:完成|参加).{0,20}(?:笔试|测评|评测|在线测试)|assessment invitation|online assessment/i.test(content))matches.push('assessment');
  if(/收到.{0,12}(简历|申请)|投递成功|申请已提交|application (?:received|submitted)/i.test(content))matches.push('submitted');
  const primary=matches.filter(s=>s!=='submitted');
  return {relevant:true,status:primary.length===1?primary[0]:primary.length===0&&matches.includes('submitted')?'submitted':''};
}
export const MAIL_CATEGORIES={assessment:'测评通知',interview:'面试通知',uncategorized:'未分类',filtered:'已过滤'};
export function classifyMail(mail={}) {
  const subject=mail.subject||'',text=(mail.text||'').split(/\n(?:From:|发件人[:：]|On .+wrote:)/i)[0];
  const signal=mailSignal(subject,text),content=subject+'\n'+text.slice(0,20000);
  // Explicit promotions and routine receipts are filtered; ambiguous notices stay visible.
  const promotion=/(?:面试|笔试|测评|评测|求职|简历).{0,12}(?:技巧|攻略|题库|训练营|辅导课程)|(?:课程|会员|培训).{0,12}(?:优惠|促销|限时|报名)|岗位推荐|职位推荐|每日职位|热门职位|限时优惠|促销活动/i.test(subject);
  const routine=!signal.relevant && /快递|包裹|物流通知|取件码|账单|支付成功|订单确认|验证码|登录提醒|安全提醒|订阅周刊|verification code/i.test(subject);
  const cancelled=/(?:取消|无需参加|不必参加).{0,15}(?:面试|笔试|测评|评测)|(?:面试|笔试|测评|评测).{0,15}(?:取消|已完成)|(?:interview|assessment).{0,15}cancel/i.test(content);
  let category=promotion||routine?'filtered':!cancelled&&['assessment','interview'].includes(signal.status)?signal.status:'uncategorized';
  let reason=promotion?'求职推广或课程信息':routine?'物流、账单、账号或订阅通知':category==='uncategorized'?'通知类型不明确或含多个阶段，待人工核对':'识别到明确的'+MAIL_CATEGORIES[category];
  if(Object.hasOwn(MAIL_CATEGORIES,mail.categoryOverride)) {category=mail.categoryOverride;reason='手动分类';}
  else if(mail.manual&&category==='filtered'){category='uncategorized';reason='用户标记为求职邮件，待分类';}
  return {category,categoryReason:reason};
}
export function matchMail(mail,applications) {
  const content=(mail.subject+'\n'+(mail.text||'').split(/\n(?:From:|发件人[:：]|On .+wrote:)/i)[0]+'\n'+mail.from).toLowerCase();
  let found=applications.filter(a=>{
    const company=a.jobSnapshot.company?.trim().toLowerCase();
    const short=company?.replace(/(?:股份有限公司|有限责任公司|股份公司|有限公司)$/u,'');
    return company?.length>=2 && (content.includes(company) || short?.length>=2 && content.includes(short));
  });
  if(found.length>1)found=found.filter(a=>[a.jobSnapshot.appliedPosition,a.jobSnapshot.title].some(role=>role?.length>=2&&content.includes(role.toLowerCase())));
  return found.length===1&&!found[0].deletedAt?found[0].id:'';
}

export function qqReader() {
  let client=null;
  return {
    async folders(config,password) {
      const connection=new ImapFlow({host:'imap.qq.com',port:993,secure:true,auth:{user:config.account,pass:password},logger:false,disableAutoIdle:true,connectionTimeout:15000,greetingTimeout:15000,socketTimeout:25000});
      client=connection;connection.on('error',()=>{});const timeout=setTimeout(()=>connection.close(),60000);
      try {await connection.connect();return (await connection.list()).filter(f=>!f.flags.has('\\Noselect')).map(f=>({path:f.path,name:f.name}));}
      finally {clearTimeout(timeout);connection.close();if(client===connection)client=null;}
    },
    async read(config,password,cursor,consume,knownMessage = () => false) {
      const connection=new ImapFlow({host:'imap.qq.com',port:993,secure:true,auth:{user:config.account,pass:password},logger:false,disableAutoIdle:true,connectionTimeout:15000,greetingTimeout:15000,socketTimeout:25000});
      client=connection;connection.on('error',()=>{});
      const timeout=setTimeout(()=>connection.close(),120000);
      let lock;
      try {
        await connection.connect();lock=await connection.getMailboxLock(config.folder,{readOnly:true});
        const validity=String(connection.mailbox.uidValidity),after=cursor.validity===validity?cursor.uid||0:0;
        const query=after?{uid:`${after+1}:*`,...(config.rescan?{since:new Date(config.scanSince)}:{})}:{since:new Date(config.scanSince||Date.now()-config.days*86400000)};
        const uids=(await connection.search(query,{uid:true})||[]).filter(uid=>uid>after).sort((a,b)=>a-b);
        let oversized=0;
        for(const uid of uids.slice(0,config.limit)) {
          const meta=await connection.fetchOne(uid,{size:true,envelope:true,internalDate:true},{uid:true});
          if(!meta) {await consume(null,{uid,validity,reason:'邮件已移动或无法读取'});continue;}
          if(meta.envelope?.messageId && knownMessage({messageId:meta.envelope.messageId})) {await consume(null,{uid,validity,duplicate:true,reason:'已读取邮件，跳过正文下载'});continue;}
          if(meta.size>2*1024*1024){oversized++;await consume(null,{uid,validity,reason:'超过 2 MB，未读取正文'});continue;}
          const raw=await connection.fetchOne(uid,{source:{maxLength:2*1024*1024+1}},{uid:true});
          if(!raw?.source||raw.source.length>2*1024*1024){oversized++;await consume(null,{uid,validity,reason:'正文过大或读取失败'});continue;}
          let parsed;
          try {parsed=await simpleParser(raw.source,{skipImageLinks:true,skipTextToHtml:true,skipTextLinks:true,maxHtmlLengthToParse:2*1024*1024});}
          catch {oversized++;await consume(null,{uid,validity,reason:'邮件格式无法解析'});continue;}
          await consume({subject:(parsed.subject||'无主题').slice(0,1000),from:(parsed.from?.text||'').slice(0,1000),text:(parsed.text||'').slice(0,50000),messageId:(parsed.messageId||'').slice(0,1000),date:new Date(meta.internalDate||parsed.date||Date.now()).toISOString()}, {uid,validity});
        }
        return {remaining:Math.max(0,uids.length-config.limit),oversized};
      } finally {clearTimeout(timeout);lock?.release();connection.close();if(client===connection)client=null;}
    },
    stop(){client?.close();}
  };
}

export function mailTracking(db,{updateApplication,reader=qqReader(),vault=protectMailSecret,clock=()=>new Date(),webmail}={}) {
  db.exec('CREATE TABLE IF NOT EXISTS mail_settings(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS mail_messages(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL UNIQUE,data TEXT NOT NULL);');
  db.exec('CREATE TABLE IF NOT EXISTS mail_scans(id TEXT PRIMARY KEY,expires_at TEXT NOT NULL,data TEXT NOT NULL);');
  db.exec('CREATE TABLE IF NOT EXISTS mail_deleted(fingerprint TEXT PRIMARY KEY);');
  let password='',running=false,closed=false,timer;
  const now=()=>clock().toISOString();
  const config=()=>({revision:0,account:'',folder:'INBOX',days:30,limit:100,interval:15,enabled:false,remember:false,...JSON.parse(db.prepare('SELECT data FROM mail_settings WHERE id=1').get()?.data||'{}')});
  const save=c=>db.prepare('INSERT INTO mail_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(c));
  const messages=()=>db.prepare('SELECT data FROM mail_messages ORDER BY rowid DESC').all().map(r=>JSON.parse(r.data));
  const applications=()=>db.prepare('SELECT data FROM applications').all().map(r=>JSON.parse(r.data));
  const saveMail=m=>db.prepare('UPDATE mail_messages SET data=? WHERE id=?').run(JSON.stringify(m),m.id);
  const categorized=m=>({...m,...classifyMail(m)});
  const inTrash=m=>!!(m.completedAt||m.deletedAt);
  function pruneScans() {
    db.prepare('DELETE FROM mail_scans WHERE expires_at<=?').run(now());
    db.exec('DELETE FROM mail_scans WHERE id NOT IN (SELECT id FROM mail_scans ORDER BY rowid DESC LIMIT 200)');
  }
  pruneScans();
  const fingerprint=(c,m)=>createHash('sha256').update(JSON.stringify([c.account,m.messageId||[m.from,m.subject,m.date,m.text]])).digest('hex');
  function ingest(c,mail,cursor,manual=false) {
    const key=fingerprint(c,mail),row=db.prepare('SELECT data FROM mail_messages WHERE fingerprint=?').get(key);
    if(db.prepare('SELECT 1 FROM mail_deleted WHERE fingerprint=?').get(key))return {suppressed:true};
    if(row){
      const m=JSON.parse(row.data);
      // Repeated scans must not recreate dismissed reminders or alter confirmed mail.
      if(manual&&!m.manual){m.manual=true;m.revision++;saveMail(m);}
      return {message:m,duplicate:true};
    }
    const m={...mail,id:randomUUID(),account:c.account,folder:c.folder,uid:cursor.uid,receivedAt:now(),suggestedStatus:mailSignal(mail.subject,mail.text).status,applicationId:matchMail(mail,applications()),ignored:false,revision:1,manual,reminders:mailEvents(mail.subject,mail.text),eventDetails:mailDetails(mail.text)};
    db.prepare('INSERT INTO mail_messages VALUES(?,?,?)').run(m.id,key,JSON.stringify(m));return {message:m,duplicate:false};
  }
  function rematch() {
    let matched=0;const apps=applications(), allMail=messages(), order=['preparing','submitted','communicating','assessment','interview','offer'];
    db.exec('SAVEPOINT mail_rematch');
    try {
      for(const m of allMail.filter(m=>!inTrash(m)&&!m.ignored&&!m.appliedAt&&!m.undoneAt&&classifyMail(m).category!=='filtered').sort((a,b)=>new Date(b.date)-new Date(a.date))) {
        if(apps.some(a=>a.id===m.applicationId&&a.deletedAt))continue;
        let changed=false;
        if(!m.linkEdited){const id=matchMail(m,apps);if(id!==m.applicationId){m.applicationId=id;changed=true;if(id)matched++;}}
        const a=apps.find(a=>a.id===m.applicationId), status=mailSignal(m.subject,m.text).status;
        const previousMail=allMail.find(previous=>previous.id===a?.history?.at(-1)?.mailId&&previous.appliedAt&&previous.appliedRevision===a?.revision&&previous.appliedStatus===a?.status);
        const newPreparing=a?.status==='preparing'&&a.revision===1&&(a.history||[]).length<=1;
        const age=clock()-new Date(m.date);
        // New preparing records may match existing notices. Later manual stages,
        // terminal states, old notices and explicit undo decisions take precedence.
        if(a&&!a.deletedAt&&typeof updateApplication==='function'&&['assessment','interview'].includes(status)&&classifyMail(m).category===status
          &&order.indexOf(a.status)>=0&&order.indexOf(status)>order.indexOf(a.status)
          &&Number.isFinite(age)&&age>=-300000&&age<=config().days*86400000
          &&(newPreparing||!progressWarnings(m,{...a,updatedAt:previousMail?.date||a.updatedAt},status).length)) {
          m.applicationBefore={status:a.status,nextActionAt:a.nextActionAt,nextAction:a.nextAction,submittedAt:a.submittedAt};
          const updated=updateApplication(a.id,{revision:a.revision,status,nextActionAt:a.nextActionAt,nextAction:a.nextAction,note:'邮件自动同步：'+m.subject+'（'+m.date+'）'},m.id);
          Object.assign(a,updated);
          m.suggestedStatus=status;m.appliedAt=now();m.appliedStatus=status;m.appliedRevision=updated.revision;m.autoApplied=true;changed=true;
        }
        if(changed){m.revision++;saveMail(m);}
      }
      db.exec('RELEASE mail_rematch');return matched;
    }catch(error){db.exec('ROLLBACK TO mail_rematch; RELEASE mail_rematch');throw error;}
  }
  function todos() {
    const fromMail=messages().filter(m=>!m.deletedAt&&!m.ignored&&classifyMail(m).category!=='filtered').flatMap(m=>(m.reminders||[]).map(r=>({...r,done:!!(m.completedAt||r.done),mailCompleted:!!m.completedAt,mailId:m.id,revision:m.revision,title:m.subject,applicationId:m.applicationId,source:'mail'})));
    const followups=applications().filter(a=>!a.deletedAt&&a.nextActionAt&&!['offer','rejected','withdrawn'].includes(a.status)).map(a=>({id:a.id,applicationId:a.id,title:a.jobSnapshot.company+' · '+a.jobSnapshot.title,kind:'投递跟进',dueAt:a.nextActionAt,evidence:a.nextAction,source:'application',revision:a.revision}));
    return [...fromMail,...followups].sort((a,b)=>(a.dueAt||'9999').localeCompare(b.dueAt||'9999'));
  }
  function state() {const {cipher,...c}=config();return {...c,folders:c.folders||[c.folder],phase1:true,mailAutoProgress:true,mailCompletion:true,mailRecycle:true,mailDirectOpen:!!webmail,notificationCategories:MAIL_CATEGORIES,hasSecret:!!(password||cipher),running,count:db.prepare('SELECT COUNT(*) n FROM mail_messages').get().n};}
  const secretFor=async c=>{const secret=password||(c.cipher?await vault(c.cipher,'open'):'');if(!secret)throw fail(400,'请填写 QQ 邮箱授权码。');return secret;};
  async function sync({rescan=false,restart=false}={}) {
    if(closed)throw fail(503,'邮箱同步已停止。');
    if(running)throw fail(409,'邮箱正在同步，请稍后。');const c=config();
    if(!c.account)throw fail(400,'请先配置 QQ 邮箱。');running=true;
    const stats={scanned:0,inserted:0,duplicates:0,filtered:0};
    try {
      c.lastStartedAt=now();save(c);
      const secret=await secretFor(c);
      if(closed)throw fail(503,'邮箱同步已停止。');
      c.cursors=c.cursors||{[c.folder]:c.cursor||{}};
      if(rescan&&(restart||!c.rescanSince)){c.rescanCursors={};c.rescanSince=new Date(clock()-c.days*86400000).toISOString();}
      const cursors=rescan?(c.rescanCursors||={}):c.cursors;
      const result={remaining:0,oversized:0};
      for(const folder of c.folders||[c.folder]) {
      const readResult=await reader.read({...c,folder,rescan,scanSince:rescan?c.rescanSince:undefined},secret,cursors[folder]||{},async(mail,cursor)=>{
        if(closed)throw fail(503,'邮箱同步已停止。');
        stats.scanned++;db.exec('BEGIN');
        try {
          const classification=mail?classifyMail(mail):null;
          const suppressed=!!mail&&!!db.prepare('SELECT 1 FROM mail_deleted WHERE fingerprint=?').get(fingerprint(c,mail));
          let reason=cursor.reason||classification?.categoryReason||'没有可读内容',mailId='';
          if(cursor.duplicate)stats.duplicates++;
          else if(mail&&!suppressed&&classification.category!=='filtered'){const item=ingest({...c,folder},mail,cursor);mailId=item.message.id;if(item.duplicate){stats.duplicates++;reason='已入库 / 重复邮件';}else{stats.inserted++;reason=MAIL_CATEGORIES[classification.category]+'：'+classification.categoryReason;}}
          else stats.filtered++;
          const id=createHash('sha256').update(JSON.stringify([c.account,folder,cursor.validity,cursor.uid])).digest('hex');
          const preview={id,account:c.account,folder,uid:cursor.uid,reason,mailId,mail:mail||null,scannedAt:now()};
          if(!suppressed&&!cursor.duplicate)db.prepare('INSERT OR REPLACE INTO mail_scans VALUES(?,?,?)').run(id,new Date(clock().getTime()+7*86400000).toISOString(),JSON.stringify(preview));pruneScans();
          const nextCursor={uid:cursor.uid,validity:cursor.validity},legacy=!rescan&&folder===c.folder;
          save({...c,[rescan?'rescanCursors':'cursors']:{...cursors,[folder]:nextCursor},...(legacy?{cursor:nextCursor}:{})});db.exec('COMMIT');
          Object.defineProperty(cursors,folder,{value:nextCursor,enumerable:true,configurable:true,writable:true});if(legacy)c.cursor=nextCursor;
        } catch(error){db.exec('ROLLBACK');throw error;}
      },mail=>{const key=fingerprint(c,mail);return !!db.prepare('SELECT 1 FROM mail_messages WHERE fingerprint=? UNION ALL SELECT 1 FROM mail_deleted WHERE fingerprint=? LIMIT 1').get(key,key);});
      if(closed)throw fail(503,'邮箱同步已停止。');
      result.remaining+=readResult.remaining||0;result.oversized+=readResult.oversized||0;
      }
      rematch();
      c.lastSuccessAt=now();c.lastError='';c.lastResult=`扫描 ${stats.scanned} 封；新增求职邮件 ${stats.inserted} 封；重复 ${stats.duplicates} 封；过滤 ${stats.filtered} 封。`;
      c.warning=result.oversized?`${result.oversized} 封超过 2 MB、无法解析或读取，已跳过；请在 QQ 邮箱查看。`:'';if(rescan)c.rescanRemaining=result.remaining||0;else c.remaining=result.remaining||0;c.lastAttemptAt=now();save(c);
      return {stats,remaining:result.remaining};
    } catch(error){if(!closed){c.lastAttemptAt=now();c.lastError=error.status?error.message:'邮箱连接或读取失败，请检查 IMAP 服务、授权码、网络与文件夹名称。';save(c);}throw fail(error.status||502,c.lastError||'邮箱同步停止。');}
    finally{running=false;}
  }
  async function tick(){if(closed)return;pruneScans();const c=config();if(!running&&c.enabled&&(password||c.cipher)&&(!c.lastAttemptAt||clock()-new Date(c.lastAttemptAt)>=c.interval*60000))try{await sync();}catch{}}
  return {
    state,sync,tick,rematch,todos,records:()=>messages().filter(m=>!m.deletedAt&&classifyMail(m).category!=='filtered'),
    start(){rematch();timer=setInterval(()=>{void tick();},30000);timer.unref();},
    stop(){closed=true;clearInterval(timer);reader.stop?.();},
    async handle(req,res,route,{jsonBody,send}) {
      if(route==='/api/mail/cloud-clear'&&req.method==='POST') {
        const input=await jsonBody(req);if(input.confirm!==true)throw fail(400,'请确认清除站内邮件数据。');
        if(running)throw fail(409,'请等待邮件同步完成。');
        const previous=config();db.exec('BEGIN');
        try {
          if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='todo_actions'").get())for(const m of messages())for(const target of ['mail-review:'+m.id,...(m.reminders||[]).map(r=>'mail:'+m.id+':'+r.id)])db.prepare('DELETE FROM todo_actions WHERE id=?').run(createHash('sha256').update(target).digest('hex').slice(0,32));
          db.exec('DELETE FROM mail_messages; DELETE FROM mail_scans; DELETE FROM mail_deleted;');
          save({revision:previous.revision+1,account:'',folder:'INBOX',folders:['INBOX'],days:30,limit:100,interval:15,enabled:false,remember:false,cipher:''});
          db.exec('COMMIT');password='';
        }catch(error){db.exec('ROLLBACK');throw error;}
        send(res,200,{cleared:true});return true;
      }
      if(route==='/api/mail/folders'&&req.method==='POST') {
        if(running)throw fail(409,'邮箱正在读取，请稍后。');running=true;
        try {const c=config();send(res,200,{folders:await reader.folders(c,await secretFor(c))});}
        catch(error){throw fail(error.status||502,error.status?error.message:'无法列出文件夹，请检查邮箱配置、授权码和网络。');}
        finally {running=false;}return true;
      }
      if(route==='/api/mail/rescan'&&req.method==='POST'){const input=await jsonBody(req);send(res,200,await sync({rescan:true,restart:input.restart===true}));return true;}
      if(route==='/api/mail/rematch'&&req.method==='POST'){send(res,200,{matched:rematch()});return true;}
      if(route==='/api/todos'&&req.method==='GET'){send(res,200,{todos:todos()});return true;}
      if(route==='/api/mail/scans'&&req.method==='GET'){pruneScans();send(res,200,{days:7,limit:200,scans:db.prepare('SELECT data FROM mail_scans ORDER BY rowid DESC').all().map(r=>JSON.parse(r.data)).filter(r=>r.account===config().account)});return true;}
      if(route==='/api/mail/scans'&&req.method==='DELETE'){if(running)throw fail(409,'请等邮箱读取结束后清空。');db.exec('DELETE FROM mail_scans');send(res,200,{cleared:true});return true;}
      const promote=route.match(/^\/api\/mail\/scans\/([a-f0-9]+)\/promote$/);
      if(promote&&req.method==='POST'){
        pruneScans();const row=db.prepare('SELECT data FROM mail_scans WHERE id=?').get(promote[1]);if(!row)throw fail(404,'扫描预览已过期，请重新扫描。');const scan=JSON.parse(row.data);
        if(scan.account!==config().account)throw fail(409,'邮箱已切换，请刷新。');if(!scan.mail)throw fail(400,'没有可读正文，请在 QQ 邮箱查看。');
        const result=ingest(scan,scan.mail,{uid:scan.uid},true);if(result.suppressed)throw fail(409,'这封邮件已彻底删除，不能再次入库。');scan.mailId=result.message.id;scan.reason='用户标记为求职邮件';db.prepare('UPDATE mail_scans SET data=? WHERE id=?').run(JSON.stringify(scan),scan.id);send(res,200,result);return true;
      }
      if(route==='/api/mail/settings'&&req.method==='PUT'){
        if(running)throw fail(409,'请等待同步完成后修改配置。');const input=await jsonBody(req),previous=config();if(input.revision!==previous.revision)throw fail(409,'邮箱设置已更新，请刷新。');
        const c={...mailConfig(input),revision:previous.revision+1};const changed=c.account!==previous.account;
        let nextPassword=changed?'':password,cipher=changed?'':previous.cipher||'';
        if(input.clearSecret===true){nextPassword='';cipher='';c.enabled=false;}
        else {
          const incoming=field(input.authorizationCode,256,'邮箱授权码');if(incoming){nextPassword=incoming;cipher='';}
          if(c.remember){if(nextPassword)cipher=await vault(nextPassword,'seal');}
          else {if(!nextPassword&&cipher)nextPassword=await vault(cipher,'open');cipher='';}
        }
        const latest=config();
        if(running||latest.revision!==previous.revision)throw fail(409,'邮箱正在同步或设置已更新，请刷新后重试。');
        // Encryption yields to the scheduler; retain any sync progress made meanwhile.
        const updated={...latest,...c,cipher,cursors:latest.cursors||{[latest.folder]:latest.cursor||{}}};
        if(changed||c.days!==previous.days){updated.cursors={};updated.cursor={};}
        updated.cursor=updated.cursors[c.folder]||{};
        if(changed||JSON.stringify(c.folders)!==JSON.stringify(previous.folders||[previous.folder])||c.days!==previous.days){updated.rescanCursors={};updated.rescanSince='';updated.rescanRemaining=0;updated.lastAttemptAt='';updated.lastResult='';updated.lastError='';updated.lastSuccessAt='';updated.remaining=0;updated.warning='';}
        save(updated);password=nextPassword;send(res,200,{settings:state()});return true;
      }
      if(route==='/api/mail/sync'&&req.method==='POST'){send(res,200,await sync());return true;}
      if(route==='/api/mail/messages/batch'&&req.method==='POST'){
        const input=await jsonBody(req),{action,items}=input;
        if(!['complete','delete','restore','purge'].includes(action)||!Array.isArray(items)||!items.length||items.length>50)throw fail(400,'请选择 1–50 封邮件和有效操作。');
        if(items.some(item=>!item||typeof item.id!=='string'||!Number.isInteger(item.revision))||new Set(items.map(item=>item.id)).size!==items.length)throw fail(400,'邮件选择无效，请重新选择。');
        if(action==='purge'&&input.confirm!==true)throw fail(400,'请确认彻底删除，这个操作无法恢复。');
        // Validate the whole selection before writing: a stale page must never partially delete mail.
        const rows=items.map(item=>{
          const row=db.prepare('SELECT fingerprint,data FROM mail_messages WHERE id=?').get(item.id);
          if(!row)throw fail(409,'所选邮件已不存在，请刷新后重新选择。');
          const m=JSON.parse(row.data);
          if(m.revision!==item.revision)throw fail(409,'所选邮件已更新，请刷新后重新选择。');
          if(inTrash(m)!==['restore','purge'].includes(action))throw fail(409,'邮件所在列表已变化，请刷新后重新选择。');
          return {...row,message:m};
        });
        db.exec('BEGIN');try {
          for(const {fingerprint:key,message:m} of rows){
            if(action==='purge'){
              db.prepare('INSERT OR IGNORE INTO mail_deleted VALUES(?)').run(key);
              for(const row of db.prepare('SELECT id,data FROM mail_scans').all()){
                const scan=JSON.parse(row.data);
                if(scan.mailId===m.id||(scan.mail&&fingerprint(scan,scan.mail)===key))db.prepare('DELETE FROM mail_scans WHERE id=?').run(row.id);
              }
              if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='todo_actions'").get()){
                for(const target of ['mail-review:'+m.id,...(m.reminders||[]).map(r=>'mail:'+m.id+':'+r.id)])db.prepare('DELETE FROM todo_actions WHERE id=?').run(createHash('sha256').update(target).digest('hex').slice(0,32));
              }
              db.prepare('DELETE FROM mail_messages WHERE id=?').run(m.id);
            }else{
              if(action==='complete')m.completedAt=now();
              if(action==='delete')m.deletedAt=now();
              if(action==='restore'){m.completedAt='';m.deletedAt='';m.ignored=false;}
              m.revision++;saveMail(m);
            }
          }
          db.exec('COMMIT');
        }catch(error){db.exec('ROLLBACK');throw error;}
        send(res,200,{action,count:rows.length});return true;
      }
      if(route==='/api/mail/messages'&&req.method==='GET'){
        const params=new URL(req.url,'http://localhost').searchParams,q=(params.get('q')||'').toLowerCase(),status=params.get('status')||'';
        const category=params.get('category')||'';
        const completion=params.get('completion')||'all';
        const box=params.get('box')||'all';
        if(!['inbox','trash','all'].includes(box))throw fail(400,'请选择有效邮件列表。');
        if(!['active','completed','all'].includes(completion))throw fail(400,'请选择有效处理状态。');
        if(category&&!Object.hasOwn(MAIL_CATEGORIES,category))throw fail(400,'请选择有效邮件分类。');
        const all=messages().map(categorized),trashTotal=all.filter(inTrash).length;
        const matching=all.filter(m=>(box==='all'||(box==='trash'?inTrash(m):!inTrash(m)))&&(status==='ignored'?m.ignored:box==='trash'&&!status||!m.ignored)&&(!status||status==='ignored'||(status==='unlinked'?!m.applicationId:status==='pending'?!m.appliedAt&&!!m.suggestedStatus:m.suggestedStatus===status))&&(!q||[m.subject,m.from,m.text].join(' ').toLowerCase().includes(q)));
        const scoped=matching.filter(m=>completion==='all'||(completion==='completed'?!!m.completedAt:!m.completedAt));
        const counts=Object.fromEntries(Object.keys(MAIL_CATEGORIES).map(key=>[key,scoped.filter(m=>m.category===key).length]));
        const rows=scoped.filter(m=>category?m.category===category:box==='trash'||m.category!=='filtered');
        const requested=Number(params.get('offset'))||0;
        const offset=Math.min(Math.max(0,Math.floor(requested/50)*50),Math.max(0,Math.ceil(rows.length/50)-1)*50);
        send(res,200,{total:rows.length,offset,counts,trashTotal,messages:rows.slice(offset,offset+50)});return true;
      }
      const openMatch=route.match(/^\/api\/mail\/messages\/([a-f0-9-]+)\/open$/);
      if(openMatch&&req.method==='POST'){
        const row=db.prepare('SELECT data FROM mail_messages WHERE id=?').get(openMatch[1]);
        if(!row)throw fail(404,'邮件记录不存在。');
        if(!webmail)throw fail(503,'请重启工作台加载 QQ 原邮件定位功能。');
        send(res,200,await webmail.open(JSON.parse(row.data)));return true;
      }
      const match=route.match(/^\/api\/mail\/messages\/([a-f0-9-]+)$/);
      if(match&&req.method==='GET'){const row=db.prepare('SELECT data FROM mail_messages WHERE id=?').get(match[1]);if(!row)throw fail(404,'邮件记录不存在。');send(res,200,{message:categorized(JSON.parse(row.data))});return true;}
      if(match&&req.method==='PATCH'){
        const input=await jsonBody(req),row=db.prepare('SELECT data FROM mail_messages WHERE id=?').get(match[1]);if(!row)throw fail(404,'邮件记录不存在。');const m=JSON.parse(row.data);if(input.revision!==m.revision)throw fail(409,'邮件记录已更新，请重新打开。');
        if(input.applicationId!==undefined){const id=field(input.applicationId,50,'投递记录');if(id&&!applications().some(a=>a.id===id&&!a.deletedAt))throw fail(400,'请选择已有投递记录。');if(m.appliedAt&&id!==m.applicationId)throw fail(400,'这封邮件已同步进展，不能更换关联。');m.applicationId=id;m.linkEdited=true;}
        if(input.ignored!==undefined)m.ignored=input.ignored===true;
        if(input.completed!==undefined){
          if(typeof input.completed!=='boolean')throw fail(400,'完成状态必须是布尔值。');
          m.completedAt=input.completed?(m.completedAt||now()):'';
        }
        if(input.category!==undefined){if(input.category==='auto')delete m.categoryOverride;else if(Object.hasOwn(MAIL_CATEGORIES,input.category))m.categoryOverride=input.category;else throw fail(400,'请选择有效邮件分类。');}
        db.exec('BEGIN');try {
          if(input.reminder){
            if(m.completedAt&&input.reminder.done===false)throw fail(409,'这封邮件已完成，请先恢复邮件再处理提醒。');
            const r=(m.reminders||[]).find(r=>r.id===input.reminder.id);if(!r)throw fail(404,'提醒不存在。');
            if(input.reminder.dueAt!==undefined){r.dueAt=dateValue(field(input.reminder.dueAt,40,'提醒时间',true));r.needsConfirmation=false;r.confirmedAt=now();}
            if(input.reminder.done!==undefined)r.done=input.reminder.done===true;
          }
          if(input.undo===true){
            if(!m.appliedAt||!m.applicationBefore||!m.appliedRevision)throw fail(400,'此记录没有可撤销的进展快照。');
            const a=applications().find(a=>a.id===m.applicationId);
            if(!a||a.revision!==m.appliedRevision||input.applicationRevision!==a.revision)throw fail(409,'投递记录已有后续更新，不能撤销覆盖。');
            const restored=updateApplication(a.id,{...m.applicationBefore,revision:a.revision,note:'撤销 QQ 邮件进展：'+m.subject},m.id);
            restored.submittedAt=m.applicationBefore.submittedAt;db.prepare('UPDATE applications SET data=? WHERE id=?').run(JSON.stringify(restored),restored.id);
            m.undoneAt=now();m.appliedAt='';m.appliedRevision=0;
          }
          if(input.apply===true){if(m.ignored)throw fail(400,'请先恢复邮件。');if(m.appliedAt)throw fail(409,'这封邮件已同步进展。');if(!m.applicationId)throw fail(400,'请先关联投递记录。');if(!Object.hasOwn(APPLICATION_STATUSES,input.status))throw fail(400,'请选择有效进展。');
            const a=applications().find(a=>a.id===m.applicationId);if(!a)throw fail(404,'投递记录不存在。');
            const warnings=progressWarnings(m,a,input.status);if(warnings.length&&input.confirmProgress!==true)throw fail(409,warnings.join('')+'核对后勾选确认再同步。');
            m.applicationBefore={status:a.status,nextActionAt:a.nextActionAt,nextAction:a.nextAction,submittedAt:a.submittedAt};
            const updated=updateApplication(a.id,{revision:input.applicationRevision,status:input.status,nextActionAt:a.nextActionAt,nextAction:a.nextAction,note:'依据 QQ 邮件：'+m.subject+'（'+m.date+'）'},m.id);m.appliedAt=now();m.appliedStatus=input.status;m.appliedRevision=updated.revision;
          }
          m.revision++;saveMail(m);
          if(input.apply!==true&&input.undo!==true&&(input.applicationId!==undefined||input.category!==undefined))rematch();
          db.exec('COMMIT');
        }catch(error){db.exec('ROLLBACK');throw error;}
        send(res,200,{message:categorized(JSON.parse(db.prepare('SELECT data FROM mail_messages WHERE id=?').get(m.id).data))});return true;
      }
      return false;
    }
  };
}
