import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync,readdirSync,statSync,renameSync,unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const fail=(status,message)=>Object.assign(new Error(message),{status});
export function localBackups(db,dataDir,{clock=()=>new Date()}={}) {
  const directory=path.resolve(dataDir,'backups','managed');
  let running=null,timer,closed=false,lastError='',lastAttemptAt='';
  try{mkdirSync(directory,{recursive:true});}catch{lastError='无法访问备份目录，请检查目录权限；工作台其他功能仍可使用。';}
  const pattern=/^(auto|manual)-\d{8}T\d{9}Z-[a-f0-9-]+\.sqlite$/;
  const list=()=>{try{return readdirSync(directory).filter(name=>pattern.test(name)).map(name=>{const stat=statSync(path.join(directory,name)),stamp=name.split('-')[1];return {name,bytes:stat.size,createdAt:new Date(Date.UTC(+stamp.slice(0,4),+stamp.slice(4,6)-1,+stamp.slice(6,8),+stamp.slice(9,11),+stamp.slice(11,13),+stamp.slice(13,15),+stamp.slice(15,18))).toISOString(),automatic:name.startsWith('auto-')};}).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}catch{lastError='无法读取备份列表，请检查备份目录权限和文件。';return [];}};
  const latestAuto=()=>list().find(item=>item.automatic);
  function state(){const entries=list(),last=entries.find(item=>item.automatic);return {enabled:true,running:!!running,lastError,lastAttemptAt,lastSuccessAt:entries[0]?.createdAt||'',nextRunAt:new Date(Math.max(last?new Date(last.createdAt).getTime()+86400000:clock().getTime(),lastAttemptAt?new Date(lastAttemptAt).getTime()+30*60000:0)).toISOString(),directory,retention:14,backups:entries};}
  async function create(automatic=false) {
    if(closed)throw fail(503,'备份服务已停止。');if(running)throw fail(409,'备份正在生成，请稍后。');
    const name=(automatic?'auto-':'manual-')+clock().toISOString().replace(/[-:.]/g,'')+'-'+randomUUID()+'.sqlite';
    const target=path.join(directory,name),temporary=target+'.partial';lastAttemptAt=clock().toISOString();
    running=(async()=>{
      try {
        mkdirSync(directory,{recursive:true});
        await backup(db,temporary);
        const check=new DatabaseSync(temporary,{readOnly:true});try{if(check.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw new Error('Integrity check failed');}finally{check.close();}
        renameSync(temporary,target);lastError='';
        // Only this module's automatic snapshots are pruned; manual and historical backups remain.
        for(const entry of list().filter(item=>item.automatic).slice(14))unlinkSync(path.join(directory,entry.name));
        return {name};
      } catch {lastError='备份失败，请检查磁盘空间和备份目录权限；原数据库未替换。';try{unlinkSync(temporary);}catch{}throw fail(500,lastError);}
    })();
    try{return await running;}finally{running=null;}
  }
  async function tick(){if(closed||running)return;const last=latestAuto();if((!last||clock()-new Date(last.createdAt)>=86400000)&&(!lastAttemptAt||clock()-new Date(lastAttemptAt)>=30*60000))try{await create(true);}catch{}}
  return {state,create,tick,start(){timer=setInterval(()=>void tick(),60000);timer.unref();},stop(){closed=true;clearInterval(timer);return running;},
    handle:async(req,res,route,{send})=>{
      if(route==='/api/backups'&&req.method==='GET'){send(res,200,state());return true;}
      if(route==='/api/backups'&&req.method==='POST'){send(res,200,await create());return true;}
      return false;
    }};
}
