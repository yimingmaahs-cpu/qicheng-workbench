import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, readdirSync, copyFileSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const [sourceArg,targetArg]=process.argv.slice(2);
if(!sourceArg||!targetArg)throw Error('Usage: node scripts/backup-cloud.mjs <cloud-data or backup> <new-empty-directory>');
const source=path.resolve(sourceArg),target=path.resolve(targetArg);
if(existsSync(target))throw Error('目标已存在，拒绝覆盖任何数据。');
if(!existsSync(path.join(source,'cloud.sqlite'))||!existsSync(path.join(source,'master.key')))throw Error('缺少网站数据库或凭据加密密钥。');
if(target.startsWith(source+path.sep))throw Error('备份目标不能位于源目录内。');
const previousManifest=existsSync(path.join(source,'backup-manifest.json'))?JSON.parse(readFileSync(path.join(source,'backup-manifest.json'),'utf8')):null;
if(previousManifest)for(const item of previousManifest.files)if(createHash('sha256').update(readFileSync(path.join(source,item.path))).digest('hex')!==item.sha256)throw Error('备份文件校验失败：'+item.path);
mkdirSync(target,{recursive:true});const files=[];
async function copy(relative){const src=path.join(source,relative),dst=path.join(target,relative);mkdirSync(path.dirname(dst),{recursive:true});if(relative.endsWith('.sqlite')){const db=new DatabaseSync(src,{readOnly:true});try{await backup(db,dst);}finally{db.close();}const check=new DatabaseSync(dst,{readOnly:true});try{if(check.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('数据库完整性检查失败');}finally{check.close();}}else copyFileSync(src,dst);files.push({path:relative,sha256:createHash('sha256').update(readFileSync(dst)).digest('hex')});}
await copy('cloud.sqlite');await copy('master.key');
if(existsSync(path.join(source,'qq-bridge','connection.json')))await copy('qq-bridge/connection.json');
if(existsSync(path.join(source,'users')))for(const entry of readdirSync(path.join(source,'users'),{withFileTypes:true}))if(entry.isDirectory()&&/^[a-f0-9-]{36}$/.test(entry.name)&&existsSync(path.join(source,'users',entry.name,'workbench.sqlite')))await copy(path.join('users',entry.name,'workbench.sqlite'));
const connectionPath=path.join(source,'private-sources','connection.json');
if(existsSync(connectionPath)){
  const connection=JSON.parse(readFileSync(connectionPath,'utf8'));
  if(!/^connection-[a-f0-9-]{36}$/.test(connection.generation))throw Error('Invalid connection generation');
  await copy('private-sources/connection.json');
  const folder='private-sources/'+connection.generation;
  for(const entry of readdirSync(path.join(source,folder),{withFileTypes:true}))if(entry.isFile()&&!entry.isSymbolicLink())await copy(folder+'/'+entry.name);
}
// Restored sessions must not keep old browser logins valid on another deployment.
const central=new DatabaseSync(path.join(target,'cloud.sqlite'));if(central.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get())central.exec('DELETE FROM sessions');central.close();
files.find(f=>f.path==='cloud.sqlite').sha256=createHash('sha256').update(readFileSync(path.join(target,'cloud.sqlite'))).digest('hex');
writeFileSync(path.join(target,'backup-manifest.json'),JSON.stringify({createdAt:new Date().toISOString(),files,notice:'数据库逐个在线快照；计划切换部署时先停止新版写入再备份。master.key 与数据库须一同保护和恢复。'},null,2));
console.log(JSON.stringify({target,databases:files.filter(f=>f.path.endsWith('.sqlite')).length,verified:true}));
