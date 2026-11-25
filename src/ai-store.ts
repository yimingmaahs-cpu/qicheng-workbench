import {addressChange} from './ai-address';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,existsSync,readdirSync,unlinkSync,renameSync,copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {type ChatMessage,type Conversation,type Memory,type AIConfig,DEFAULT_AI_CONFIG,bounded,defaultUserPersona,validateUserPersona,activeUserPersona} from './ai-types';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
function checkDatabase(path:string){const db=new DatabaseSync(path,{readOnly:true});try{const result=db.prepare('PRAGMA quick_check').get() as any;if(result.quick_check!=='ok')throw Error('数据库校验失败');if(Number((db.prepare('PRAGMA user_version').get() as any).user_version)>1)throw Error('数据库版本较新，请使用新版应用');}finally{db.close();}}
export function openAIStore(dir:string){
  mkdirSync(dir,{recursive:true});const path=join(dir,'chat.sqlite');let warning='';
  if(existsSync(path))try{checkDatabase(path);}catch(error){
    if(!/not a database|malformed|database disk image|校验失败/i.test(String(error)))throw error;
    const backup=readdirSync(dir).filter(f=>/^backup-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort().reverse().find(f=>{try{checkDatabase(join(dir,f));return true;}catch{return false;}});
    if(!backup)throw Error('AI 数据库损坏且没有有效自动备份，原文件已保留。请保留 ai 目录以便恢复。');
    const stamp=Date.now();copyFileSync(join(dir,backup),join(dir,'recovery.tmp'));checkDatabase(join(dir,'recovery.tmp'));
    for(const suffix of ['-wal','-shm',''])if(existsSync(path+suffix))renameSync(path+suffix,join(dir,`damaged-${stamp}-chat.sqlite${suffix}`));
    renameSync(join(dir,'recovery.tmp'),path);warning=`AI 数据库损坏，已恢复 ${backup}。损坏文件已另存；备份后的聊天可能缺失，请检查。`;
  }
  return {store:new AIStore(dir),warning};
}
export class AIStore {
  db:DatabaseSync;revision=0;
  constructor(readonly dir:string){
    mkdirSync(dir,{recursive:true});this.db=new DatabaseSync(join(dir,'chat.sqlite'));
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;');
    const check=this.db.prepare('PRAGMA quick_check').get() as any;if(check.quick_check!=='ok')throw Error('AI 数据库校验失败，已停止写入。请保留目录并恢复备份。');
    const version=(this.db.prepare('PRAGMA user_version').get() as any).user_version;if(version>1)throw Error('AI 数据库版本较新，请使用新版应用');
    this.db.exec(`CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,role TEXT NOT NULL,title TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,conversation TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,request TEXT NOT NULL,speaker TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,excluded INTEGER NOT NULL DEFAULT 0,processed INTEGER NOT NULL DEFAULT 0,UNIQUE(request,speaker));
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation,created);
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,role TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memories_role ON memories(role);
      CREATE TABLE IF NOT EXISTS summaries(conversation TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,text TEXT NOT NULL,through INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS forgotten(role TEXT NOT NULL,keyhash TEXT NOT NULL,PRIMARY KEY(role,keyhash));
      CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY,day TEXT NOT NULL,kind TEXT NOT NULL,model TEXT NOT NULL,input INTEGER,output INTEGER,status TEXT NOT NULL,elapsed INTEGER NOT NULL DEFAULT 0);
      PRAGMA user_version=1;`);
    // A separate cursor table preserves the original summary schema for older builds.
    this.db.exec('CREATE TABLE IF NOT EXISTS summary_cursors(conversation TEXT PRIMARY KEY REFERENCES summaries(conversation) ON DELETE CASCADE,through_id TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS conversation_addresses(conversation TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE, value TEXT NOT NULL, source TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE)');
    this.db.exec('CREATE TABLE IF NOT EXISTS turn_versions(id TEXT PRIMARY KEY,source TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,assistant TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,operation TEXT NOT NULL UNIQUE,mode TEXT NOT NULL,body TEXT NOT NULL,address_allowed INTEGER NOT NULL,created INTEGER NOT NULL)');
    this.db.prepare("UPDATE messages SET status='interrupted' WHERE speaker='assistant' AND status IN ('preparing','streaming')").run();
    const pending=this.allMemories().filter(memory=>memory.state==='pending');
    if(pending.length)this.transaction(()=>{this.expire();for(const memory of pending.sort((a,b)=>this.compareMemory(a,b))){
      const live=memory.sources.map(id=>this.message(id)).filter((source):source is ChatMessage=>!!source&&!source.excluded);
      const forgotten=this.db.prepare("SELECT 1 FROM forgotten WHERE (role=? OR role='shared') AND keyhash=?").get(memory.role,hash(memory.key+'|'+memory.context));
      if(!live.length||live.length!==memory.sources.length||forgotten){memory.state='expired';this.putMemory(memory);continue;}
      if(memory.level==='L2'&&!memory.expires)memory.expires=Math.max(...live.map(source=>source.created))+7*86400000;
      memory.state='active';this.saveAutomaticMemory(memory);
    }this.invalidate();});
  }
  transaction<T>(fn:()=>T):T {this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  config():AIConfig {const row=this.db.prepare("SELECT body FROM settings WHERE id='config'").get() as any;return row?JSON.parse(row.body):{...DEFAULT_AI_CONFIG};}
  saveConfig(config:AIConfig){this.db.prepare("INSERT OR REPLACE INTO settings VALUES ('config',?)").run(JSON.stringify(config));}
  userPersona(){const row=this.db.prepare("SELECT body FROM settings WHERE id='user-persona'").get();return row?validateUserPersona(JSON.parse(String(row.body))):defaultUserPersona();}
  saveUserPersona(raw:unknown){const persona=validateUserPersona(raw),previous=this.userPersona();this.purgeBackups();this.transaction(()=>{this.db.prepare("INSERT OR REPLACE INTO settings VALUES ('user-persona',?)").run(JSON.stringify(persona));for(const role of Object.keys(persona.roles))if(JSON.stringify(activeUserPersona(previous,role))!==JSON.stringify(activeUserPersona(persona,role))){this.db.prepare('DELETE FROM conversation_addresses WHERE conversation IN (SELECT id FROM conversations WHERE role=?)').run(role);this.db.prepare('UPDATE turn_versions SET address_allowed=0 WHERE source IN (SELECT m.id FROM messages m JOIN conversations c ON c.id=m.conversation WHERE c.role=?)').run(role);}});this.purgeBackups();return persona;}
  address(role:string,conversation?:string){const saved=activeUserPersona(this.userPersona(),role).address;const row=conversation?this.db.prepare('SELECT a.value FROM conversation_addresses a JOIN conversations c ON c.id=a.conversation JOIN messages m ON m.id=a.source WHERE a.conversation=? AND c.role=? AND m.excluded=0').get(conversation,role):undefined;return {value:row?String(row.value):saved,source:row?'conversation' as const:saved?'persona' as const:'none' as const};}
  resetAddress(conversation:string){this.conversation(conversation);this.purgeBackups();this.transaction(()=>{this.db.prepare('DELETE FROM conversation_addresses WHERE conversation=?').run(conversation);this.db.prepare('UPDATE turn_versions SET address_allowed=0 WHERE source IN (SELECT id FROM messages WHERE conversation=?)').run(conversation);});}

  conversations(role:string){return this.db.prepare('SELECT * FROM conversations WHERE role=? ORDER BY created DESC,rowid DESC').all(role) as unknown as Conversation[];}
  conversation(id:string){const row=this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id);if(!row)throw Error('会话不存在');return row as unknown as Conversation;}
  newConversation(role:string){const c={id:randomUUID(),role,title:'新的聊天',created:Date.now()};this.db.prepare('INSERT INTO conversations VALUES (?,?,?,?)').run(c.id,c.role,c.title,c.created);return c;}
  messages(conversation:string,limit=200){return (this.db.prepare('SELECT * FROM messages WHERE conversation=? ORDER BY rowid DESC LIMIT ?').all(conversation,limit) as unknown as ChatMessage[]).reverse();}
  message(id:string){return this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) as unknown as ChatMessage|undefined;}
  startTurn(conversation:string,request:string,text:string){
    const old=this.db.prepare('SELECT * FROM messages WHERE request=? ORDER BY rowid').all(request) as unknown as ChatMessage[];
    if(old.length){if(old[0].conversation!==conversation||old[0].text!==text)throw Error('请求编号已使用');return null;}
    return this.transaction(()=>{const now=Date.now(),user=randomUUID(),assistant=randomUUID();const insert=this.db.prepare('INSERT INTO messages(id,conversation,request,speaker,text,status,created) VALUES (?,?,?,?,?,?,?)');insert.run(user,conversation,request,'user',text,'complete',now);insert.run(assistant,conversation,request,'assistant','','preparing',now+1);this.db.prepare("UPDATE conversations SET title=? WHERE id=? AND title='新的聊天'").run(text.slice(0,24),conversation);const naming=addressChange(text);if(naming){this.db.prepare('UPDATE messages SET processed=1 WHERE id=?').run(user);if(naming.avoid&&this.address(this.conversation(conversation).role,conversation).value!==naming.avoid)return {user,assistant};if(naming.value===null)this.db.prepare('DELETE FROM conversation_addresses WHERE conversation=?').run(conversation);else this.db.prepare('INSERT OR REPLACE INTO conversation_addresses VALUES (?,?,?)').run(conversation,naming.value,user);}return {user,assistant};});
  }
  saveReply(id:string,text:string,status:string){this.db.prepare('UPDATE messages SET text=?,status=? WHERE id=?').run(text,status,id);}
  turnVersions(conversation:string){
    return this.db.prepare("SELECT * FROM turn_versions WHERE source=(SELECT id FROM messages WHERE conversation=? AND speaker='user' ORDER BY rowid DESC LIMIT 1) ORDER BY rowid DESC").all(conversation).map(row=>{const body=JSON.parse(String(row.body));return {id:String(row.id),operation:String(row.operation),mode:String(row.mode),user:String(row.source),assistant:String(row.assistant),userText:body.user.text as string,assistantText:body.assistant.text as string,assistantStatus:body.assistant.status as string,created:Number(row.created)};});
  }
  prepareRevision(id:string,mode:'regenerate'|'edit'|'continue'|'restore',operation:string,text?:string){
    bounded(id,100,'消息编号');bounded(operation,100,'操作编号');if(!['regenerate','edit','continue','restore'].includes(mode))throw Error('消息操作无效');
    const edited=mode==='edit'?bounded(text,4000,'消息'):undefined,target=this.message(id);if(!target)throw Error('消息不存在');
    const pair=this.db.prepare('SELECT * FROM messages WHERE request=? ORDER BY rowid').all(target.request) as unknown as ChatMessage[],user=pair.find(m=>m.speaker==='user'),assistant=pair.find(m=>m.speaker==='assistant');
    if(!user||!assistant||pair.length!==2||user.conversation!==assistant.conversation)throw Error('这轮聊天不完整');
    const role=this.conversation(user.conversation).role,base={role,conversation:user.conversation,user:user.id,assistant:assistant.id,request:user.request};
    const duplicate=this.db.prepare('SELECT * FROM turn_versions WHERE operation=?').get(operation);
    if(duplicate){const saved=JSON.parse(String(duplicate.body));if(duplicate.source!==user.id||duplicate.mode!==mode||saved.edited!==edited)throw Error('操作编号已使用');return {...base,text:user.text,prefix:mode==='continue'?assistant.text:'',previousStatus:assistant.status,duplicate:true,restored:mode==='restore'};}
    if(this.messages(user.conversation,1)[0]?.id!==assistant.id)throw Error('只能修改当前会话最后一轮聊天');
    if(user.excluded||assistant.excluded)throw Error('已排除的聊天不能重新生成或恢复');
    if(['preparing','streaming'].includes(assistant.status))throw Error('请先停止当前生成');
    if(mode==='continue'&&(!assistant.text||!['truncated','failed','cancelled','interrupted'].includes(assistant.status)))throw Error('只有未完成且已有正文的回复可以继续');
    const previous=mode==='restore'?this.db.prepare('SELECT * FROM turn_versions WHERE source=? ORDER BY rowid DESC LIMIT 1').get(user.id):undefined;
    if(mode==='restore'&&!previous)throw Error('没有可以恢复的旧版本');
    const restored=previous?JSON.parse(String(previous.body)) as {user:ChatMessage;assistant:ChatMessage}:undefined,nextText=restored?.user.text??edited??user.text,changed=nextText!==user.text;
    if(changed)this.purgeBackups();
    this.transaction(()=>{
      const naming=addressChange(user.text),addressAllowed=!!this.db.prepare('SELECT 1 FROM conversation_addresses WHERE source=?').get(user.id)||naming?.value===null;
      this.db.prepare('INSERT INTO turn_versions VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),user.id,assistant.id,operation,mode,JSON.stringify({user,assistant,edited}),Number(addressAllowed),Date.now());
      if(changed){
        // Editing evidence is not forgetting its attribute: the corrected fact may be learned again.
        this.removeMemories(new Set(this.allMemories().filter(memory=>memory.sources.includes(user.id)).map(memory=>memory.id)));
        this.db.prepare('UPDATE messages SET text=?,processed=0 WHERE id=?').run(nextText,user.id);
        this.db.prepare('DELETE FROM conversation_addresses WHERE source=?').run(user.id);
        const nextNaming=addressChange(nextText);if(nextNaming){this.db.prepare('UPDATE messages SET processed=1 WHERE id=?').run(user.id);if(mode!=='restore'||previous?.address_allowed){if(!nextNaming.avoid||this.address(role,user.conversation).value===nextNaming.avoid){if(nextNaming.value===null)this.db.prepare('DELETE FROM conversation_addresses WHERE conversation=?').run(user.conversation);else this.db.prepare('INSERT OR REPLACE INTO conversation_addresses VALUES (?,?,?)').run(user.conversation,nextNaming.value,user.id);}}}
        this.db.exec('DELETE FROM summaries');
      }else this.db.prepare('DELETE FROM summaries WHERE conversation=?').run(user.conversation);
      this.saveReply(assistant.id,restored?restored.assistant.text:mode==='continue'?assistant.text:'',restored?restored.assistant.status:'preparing');
    });
    this.revision++;if(changed)this.purgeBackups();
    return {...base,text:nextText,prefix:mode==='continue'?assistant.text:'',previousStatus:assistant.status,duplicate:false,restored:mode==='restore'};
  }
  allMemories(role?:string):Memory[]{const rows=role?this.db.prepare("SELECT body FROM memories WHERE role=? OR role='shared'").all(role):this.db.prepare('SELECT body FROM memories').all();return rows.map(row=>JSON.parse(row.body as string));}
  memory(id:string){const row=this.db.prepare('SELECT body FROM memories WHERE id=?').get(id);if(!row)throw Error('记忆不存在');return JSON.parse(row.body as string) as Memory;}
  putMemory(memory:Memory){this.db.prepare('INSERT OR REPLACE INTO memories VALUES (?,?,?)').run(memory.id,memory.role,JSON.stringify(memory));}
  private memoryOrder(memory:Memory){let time=memory.certainty==='confirmed'?memory.updated:0,seq=memory.certainty==='confirmed'?Number.MAX_SAFE_INTEGER:0;
    for(const id of memory.sources){const row=this.db.prepare('SELECT created,rowid seq FROM messages WHERE id=?').get(id);if(row&&(Number(row.created)>time||Number(row.created)===time&&Number(row.seq)>seq)){time=Number(row.created);seq=Number(row.seq);}}
    return {time,seq};
  }
  private compareMemory(a:Memory,b:Memory){const left=this.memoryOrder(a),right=this.memoryOrder(b);return left.time-right.time||left.seq-right.seq;}
  private saveAutomaticMemory(memory:Memory){
    if(!memory.pinned&&memory.expires&&memory.expires<=Date.now())memory.state='expired';
    if(memory.state==='active'&&memory.kind!=='episode'){
      const peers=this.allMemories(memory.role).filter(old=>old.id!==memory.id&&old.state==='active'&&old.kind!=='episode'&&old.key===memory.key&&old.context===memory.context).sort((a,b)=>this.compareMemory(b,a)),latest=peers[0];
      if(latest&&this.compareMemory(memory,latest)<=0){memory.state='superseded';memory.replaces=latest.id;}
      else{let changed=false;for(const old of peers)if(old.role===memory.role){old.state='superseded';this.putMemory(old);changed=true;}if(latest)memory.replaces=latest.id;if(changed)this.invalidate(memory.role);}
    }this.putMemory(memory);
  }
  expire(now=Date.now()){for(const m of this.allMemories())if(!m.pinned&&m.state==='active'&&m.expires&&m.expires<=now){m.state='expired';this.putMemory(m);}}
  summary(conversation:string){return this.db.prepare('SELECT s.text,s.through,coalesce((SELECT rowid FROM messages WHERE id=c.through_id),0) through_row FROM summaries s LEFT JOIN summary_cursors c ON c.conversation=s.conversation WHERE s.conversation=?').get(conversation) as {text:string;through:number;through_row:number}|undefined;}
  summaryMessages(conversation:string,after:number){
    // Read from the oldest unprocessed turn, retaining the latest four turns verbatim.
    return this.db.prepare(`WITH complete AS (
      SELECT m.rowid AS seq,m.* FROM messages m WHERE m.conversation=? AND m.excluded=0 AND m.status='complete'
      AND EXISTS(SELECT 1 FROM messages other WHERE other.request=m.request AND other.speaker!=m.speaker AND other.excluded=0 AND other.status='complete')
    ) SELECT * FROM complete WHERE seq>? AND seq<(SELECT seq FROM complete WHERE speaker='user' ORDER BY seq DESC LIMIT 1 OFFSET 3) ORDER BY seq LIMIT 40`).all(conversation,after) as unknown as (ChatMessage&{seq:number})[];
  }
  invalidate(role?:string){this.revision++;if(!role||role==='shared')this.db.exec('DELETE FROM summaries');else this.db.prepare('DELETE FROM summaries WHERE conversation IN (SELECT id FROM conversations WHERE role=?)').run(role);}
  pending(role:string){return this.db.prepare(`SELECT m.* FROM messages m JOIN conversations c ON c.id=m.conversation WHERE c.role=? AND m.speaker='user' AND m.processed=0 AND m.excluded=0 AND EXISTS(SELECT 1 FROM messages a WHERE a.request=m.request AND a.speaker='assistant' AND a.status='complete') ORDER BY m.rowid LIMIT 40`).all(role) as unknown as ChatMessage[];}
  reviewMessages(conversation:string,before?:string):ChatMessage[]{
    this.conversation(conversation);let cursor:number|null=null;
    if(before!==undefined){const anchor=this.db.prepare("SELECT rowid seq FROM messages WHERE id=? AND conversation=? AND speaker='user'").get(bounded(before,100,'消息游标'),conversation);if(!anchor)throw Error('旧聊天消息游标无效');cursor=Number(anchor.seq);}
    const query=this.db.prepare(`SELECT m.rowid seq,m.* FROM messages m WHERE m.conversation=? AND m.speaker='user' AND m.status='complete' AND m.excluded=0 AND (? IS NULL OR m.rowid<?)
      AND EXISTS(SELECT 1 FROM messages a WHERE a.request=m.request AND a.conversation=m.conversation AND a.speaker='assistant' AND a.status='complete' AND a.excluded=0) ORDER BY m.rowid DESC LIMIT 41`),result:ChatMessage[]=[];
    while(result.length<41){const rows=query.all(conversation,cursor,cursor) as unknown as (ChatMessage&{seq:number})[];if(!rows.length)break;
      for(const {seq,...message} of rows){cursor=seq;if(!addressChange(message.text))result.push(message);if(result.length===41)break;}
      if(rows.length<41)break;
    }return result;
  }
  memoryContext(sources:ChatMessage[]):{source:string;previous:{speaker:ChatMessage['speaker'];text:string}[]}[]{
    if(!sources.length)return [];const budget=Math.min(400,Math.floor(4000/(2*sources.length)));
    const crop=(text:string)=>text.length<=budget?text:budget<3?'…'.slice(0,budget):text.slice(0,Math.ceil((budget-1)/2))+'…'+text.slice(-Math.floor((budget-1)/2));
    const query=this.db.prepare(`SELECT m.speaker,m.text FROM messages m WHERE m.conversation=? AND m.status='complete' AND m.excluded=0
      AND m.rowid<(SELECT rowid FROM messages WHERE id=? AND conversation=? AND speaker='user' AND status='complete' AND excluded=0)
      AND EXISTS(SELECT 1 FROM messages other WHERE other.request=m.request AND other.conversation=m.conversation AND other.speaker!=m.speaker AND other.status='complete' AND other.excluded=0) ORDER BY m.rowid DESC LIMIT 2`);
    return sources.map(source=>({source:source.id,previous:(query.all(source.conversation,source.id,source.conversation) as unknown as Pick<ChatMessage,'speaker'|'text'>[]).reverse().map(message=>({speaker:message.speaker,text:crop(message.text)}))}));
  }
  usageStart(kind:string,model:string,limit:number){const day=new Date().toLocaleDateString('sv-SE'),count=(this.db.prepare('SELECT count(*) n FROM usage WHERE day=?').get(day) as any).n;if(count>=limit)throw Error('已达到今日调用上限，可在模型设置中调整');const id=randomUUID();this.db.prepare('INSERT INTO usage(id,day,kind,model,status) VALUES (?,?,?,?,?)').run(id,day,kind,model,'pending');return id;}
  usageFinish(id:string,input:number|null,output:number|null,status:string,elapsed:number){this.db.prepare('UPDATE usage SET input=?,output=?,status=?,elapsed=? WHERE id=?').run(input,output,status,elapsed,id);}
  usage(){return this.db.prepare('SELECT kind,model,count(*) calls,coalesce(sum(input),0) input,coalesce(sum(output),0) output,sum(CASE WHEN input IS NULL OR output IS NULL THEN 1 ELSE 0 END) unknown FROM usage WHERE day=? GROUP BY kind,model').all(new Date().toLocaleDateString('sv-SE'));}
  private forgetSources(ids:string[],remove=false){
    const requests=new Set(ids.map(id=>this.message(id)?.request).filter((x):x is string=>!!x));
    // Exclude both sides: an assistant may have repeated the forgotten fact.
    for(const request of requests){this.db.prepare('DELETE FROM conversation_addresses WHERE source IN (SELECT id FROM messages WHERE request=?)').run(request);this.db.prepare('DELETE FROM turn_versions WHERE source IN (SELECT id FROM messages WHERE request=?)').run(request);if(remove)this.db.prepare('DELETE FROM messages WHERE request=?').run(request);else this.db.prepare('UPDATE messages SET excluded=1,processed=1 WHERE request=?').run(request);}
  }
  private removeMemories(ids:Set<string>){for(const m of this.allMemories())if(ids.has(m.id))this.db.prepare('DELETE FROM memories WHERE id=?').run(m.id);else if(m.replaces&&ids.has(m.replaces)){m.replaces=null;this.putMemory(m);}}
  private removeDerived(ids:Set<string>){const removed=new Set<string>();for(const m of this.allMemories())if(m.sources.some(id=>ids.has(id))){this.db.prepare('INSERT OR IGNORE INTO forgotten VALUES (?,?)').run(m.role,hash(m.key+'|'+m.context));removed.add(m.id);}this.removeMemories(removed);}
  deleteMemory(id:string,removeSources=false){const m=this.memory(id);const source=this.message(m.sources[0]);const origin=source?this.conversation(source.conversation).role:m.role;const versions=this.allMemories().filter(x=>[m.role,origin].includes(x.role)&&x.key===m.key&&x.context===m.context);const sources=[...new Set(versions.flatMap(x=>x.sources))];this.purgeBackups();this.transaction(()=>{for(const scope of new Set([m.role,origin]))this.db.prepare('INSERT OR IGNORE INTO forgotten VALUES (?,?)').run(scope,hash(m.key+'|'+m.context));this.forgetSources(sources,removeSources);this.removeDerived(new Set(sources));this.removeMemories(new Set(versions.map(version=>version.id)));this.invalidate();});this.purgeBackups();}
  deleteMessage(id:string){const message=this.message(id);if(!message)throw Error('消息不存在');const ids=(this.db.prepare('SELECT id FROM messages WHERE request=?').all(message.request)).map(x=>String(x.id));this.purgeBackups();this.transaction(()=>{this.removeDerived(new Set(ids));this.forgetSources(ids,true);this.invalidate();});this.purgeBackups();}
  deleteConversation(id:string){this.conversation(id);const ids=this.db.prepare('SELECT id FROM messages WHERE conversation=?').all(id).map(x=>String(x.id));this.purgeBackups();this.transaction(()=>{this.removeDerived(new Set(ids));this.db.prepare('DELETE FROM conversations WHERE id=?').run(id);this.invalidate();});this.purgeBackups();}
  clear(role?:string){this.purgeBackups();this.transaction(()=>{if(role){const ids=this.db.prepare('SELECT m.id FROM messages m JOIN conversations c ON c.id=m.conversation WHERE c.role=?').all(role).map(x=>String(x.id));this.removeDerived(new Set(ids));this.db.prepare('DELETE FROM conversations WHERE role=?').run(role);this.removeMemories(new Set(this.allMemories(role).filter(m=>m.role===role).map(m=>m.id)));this.db.prepare('DELETE FROM forgotten WHERE role=?').run(role);const persona=this.userPersona();persona.roles[role]={mode:'shared',text:''};this.db.prepare("INSERT OR REPLACE INTO settings VALUES ('user-persona',?)").run(JSON.stringify(persona));}else{this.db.exec("DELETE FROM conversations; DELETE FROM memories; DELETE FROM forgotten; DELETE FROM usage; DELETE FROM settings WHERE id='user-persona';");}this.invalidate();});this.purgeBackups();}
  editMemory(id:string,text:string,context:string,shared:boolean,pinned:boolean){const m=this.memory(id);this.purgeBackups();this.transaction(()=>{this.invalidate();this.forgetSources(m.sources);const chinese=m.chinese,previousContext=m.context;m.text=bounded(text,600,'记忆内容');if(typeof context!=='string'||context.length>120)throw Error('适用场景无效');m.context=context;if(chinese)m.chinese={text:m.text,context:context===previousContext?chinese.context:context,occurred:chinese.occurred};m.role=shared?'shared':m.role==='shared'?this.conversation(this.message(m.sources[0])?.conversation||'').role:m.role;m.pinned=pinned;m.certainty='confirmed';if(m.state==='active'&&this.allMemories().some(x=>x.id!==m.id&&x.role===m.role&&x.state==='active'&&x.key===m.key&&x.context===m.context))throw Error('已有相同属性和场景的有效记忆，请先处理冲突');m.updated=Date.now();this.putMemory(m);});this.purgeBackups();}
  resolveMemory(id:string,resolution:string){const m=this.memory(id);if(m.state!=='pending')throw Error('这条记忆已处理');const old=m.replaces?this.allMemories().find(memory=>memory.id===m.replaces)??null:null;if(!old)m.replaces=null;this.purgeBackups();
    this.transaction(()=>{if(resolution==='accept'||resolution==='both'){if(resolution==='both'&&old&&old.context===m.context)throw Error('请先编辑适用场景，再保留两条记忆');if(this.allMemories(m.role).some(x=>x.id!==m.id&&x.id!==old?.id&&x.state==='active'&&x.key===m.key&&x.context===m.context&&x.role===m.role))throw Error('当前有效记忆已变更，请先查看并处理新冲突');if(old&&resolution==='accept'&&old.context===m.context&&(old.role!=='shared'||m.role==='shared')){old.state='superseded';old.updated=Date.now();this.forgetSources(old.sources);this.putMemory(old);}m.state='active';m.certainty='confirmed';m.updated=Date.now();this.putMemory(m);}else if(resolution==='keep'||resolution==='reject'){this.forgetSources(m.sources);this.removeMemories(new Set([id]));if(old&&resolution==='reject'){old.state='expired';this.forgetSources(old.sources);this.putMemory(old);}}else throw Error('无效的确认操作');this.invalidate();});this.purgeBackups();}
  applyCandidates(role:string,raw:unknown,sources:ChatMessage[],revision:number,review=false,onInvalid?:(reason:string)=>void){
    if(revision!==this.revision)return false;if(!Array.isArray(raw)||raw.length>20)throw Error('记忆结构无效，未写入');
    const allowed=new Map(sources.filter(source=>{const current=this.message(source.id);return current&&!current.excluded&&current.text===source.text;}).map(s=>[s.id,s]));const candidates:Memory[]=[];let valid=0,rejected=0,firstError:unknown;
    for(const value of raw)try{const v=value as any;if(!v||!['L1','L2','L3'].includes(v.level)||!['fact','preference','episode','inference'].includes(v.kind)||!['explicit','uncertain','inferred'].includes(v.certainty))throw Error('记忆分类无效，未写入');
      const key=bounded(v.key,80,'记忆属性'),text=bounded(v.text,600,'记忆'),context=typeof v.context==='string'?v.context.slice(0,120):'';
      if(!Array.isArray(v.sources)||!v.sources.length||v.sources.length>10||!Array.isArray(v.evidence)||v.evidence.length!==v.sources.length)throw Error('记忆缺少来源');
      for(let i=0;i<v.sources.length;i++){const source=allowed.get(v.sources[i]);if(!source||typeof v.evidence[i]!=='string'||v.evidence[i].length<2||!source.text.includes(v.evidence[i]))throw Error('记忆原文证据无效，未写入');}
      if(this.db.prepare("SELECT 1 FROM forgotten WHERE (role=? OR role='shared') AND keyhash=?").get(role,hash(key+'|'+context))){valid++;continue;}
      const now=Date.now(),kind=v.kind,certainty=kind==='inference'?'inferred':v.certainty,level=(kind==='inference'?'L2':kind==='episode'?'L3':v.level) as Memory['level'];
      const expiry=typeof v.expires==='string'?Date.parse(v.expires):NaN;
      const sourceTime=Math.max(...v.sources.map((id:string)=>allowed.get(id)!.created));
      const expires=level==='L2'?Number.isFinite(expiry)?Math.min(expiry,sourceTime+30*86400000):sourceTime+7*86400000:null;
      const tags=Array.isArray(v.tags)?v.tags.filter((s:unknown)=>typeof s==='string').slice(0,8).map((s:string)=>s.slice(0,30)):[];
      candidates.push({id:randomUUID(),role,level,kind,key,text,context,tags,state:expires&&expires<=now?'expired':'active',certainty,sources:v.sources,evidence:v.evidence,created:now,updated:now,expires,occurred:typeof v.occurred==='string'?v.occurred.slice(0,80):'',pinned:false,replaces:null});
      valid++;
    }catch(error){if(!onInvalid)throw error;if(!rejected)firstError=error;rejected++;onInvalid(error instanceof Error?error.message:'记忆校验失败');}
    if(rejected&&!valid)throw firstError;if(revision!==this.revision)return false;
    this.transaction(()=>{this.expire();for(const m of candidates){const library=this.allMemories(role);if(review&&library.some(x=>x.key===m.key&&x.context===m.context&&(x.text===m.text||m.sources.every(source=>x.sources.includes(source)))))continue;
      const existing=library.filter(x=>x.state==='active'&&x.key===m.key&&x.context===m.context&&x.kind!=='episode').sort((a,b)=>Number(b.role===role)-Number(a.role===role));const old=existing[0];
      if(old&&old.text===m.text&&m.state==='active'){if(old.role==='shared'||old.certainty==='confirmed'||m.sources.every(source=>old.sources.includes(source)))continue;old.sources=[...new Set([...old.sources,...m.sources])].slice(-10);old.evidence=old.sources.map(id=>this.message(id)?.text.slice(0,600)||'');old.updated=Date.now();this.putMemory(old);continue;}
      this.saveAutomaticMemory(m);
    }for(const s of sources)this.db.prepare('UPDATE messages SET processed=1 WHERE id=?').run(s.id);});return true;
  }
  recall(role:string,query:string,history=false){this.expire();const normalized=query.toLowerCase();const tokens=new Set(normalized.match(/[a-z0-9]+|[\u3400-\u9fff]{2}/g)||[]);for(let i=0;i<normalized.length-1;i++)if(/[\u3400-\u9fff]/.test(normalized[i]))tokens.add(normalized.slice(i,i+2));
    // ponytail: local scan is sufficient for a personal memory library; measure recall before adding embeddings.
    const library=this.allMemories(role);const local=new Set(library.filter(m=>m.role===role&&m.state==='active').map(m=>m.key+'|'+m.context));
    return library.filter(m=>(m.state==='active'||history&&m.state==='superseded')&&!(m.role==='shared'&&local.has(m.key+'|'+m.context))).map(m=>{const text=[m.text,m.context,m.chinese?.text||'',m.chinese?.context||'',m.key,...m.tags].join(' ').toLowerCase();const matches=[...tokens].filter(t=>text.includes(t)).length;return {m,score:matches*10+(m.pinned?5:0)+(m.level==='L1'?2:0),matches};}).filter(x=>x.matches||x.m.level==='L1'||x.m.pinned).sort((a,b)=>b.score-a.score||b.m.updated-a.m.updated).slice(0,12).map(x=>x.m);
  }
  backup(){const day=new Date().toISOString().slice(0,10),path=join(this.dir,`backup-${day}.sqlite`);if(existsSync(path))return;this.db.prepare('VACUUM INTO ?').run(path);const files=readdirSync(this.dir).filter(f=>/^backup-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort().reverse();for(const f of files.slice(3))unlinkSync(join(this.dir,f));}
  purgeBackups(){for(const f of readdirSync(this.dir).filter(f=>/^backup-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)||/^damaged-\d+-chat\.sqlite(-wal|-shm)?$/.test(f)||f==='recovery.tmp'))unlinkSync(join(this.dir,f));this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}
  export(){return {version:1,exportedAt:new Date().toISOString(),userPersona:this.userPersona(),conversationAddresses:this.db.prepare('SELECT * FROM conversation_addresses').all(),conversations:this.db.prepare('SELECT * FROM conversations').all(),messages:this.db.prepare('SELECT * FROM messages ORDER BY rowid').all(),turnVersions:this.db.prepare('SELECT * FROM turn_versions ORDER BY rowid').all(),memories:this.allMemories(),summaries:this.db.prepare('SELECT * FROM summaries').all()};}
  close(){this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');this.db.close();}
}
