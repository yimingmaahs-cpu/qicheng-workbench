// Restores into a NEW directory only; never replaces a running database.
import { DatabaseSync,backup } from 'node:sqlite';
import { existsSync,mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function restoreBackup(source,destination) {
  const target=path.resolve(destination);
  if(existsSync(target))throw new Error('恢复目录必须尚不存在，避免覆盖任何现有数据。');
  const db=new DatabaseSync(path.resolve(source),{readOnly:true});
  try {
    if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('备份完整性检查未通过。');
    const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
    for(const name of ['resumes','intents','settings','jobs','applications'])if(!tables.has(name))throw new Error('该文件不是完整的工作台数据库备份。');
    mkdirSync(target,{recursive:true});await backup(db,path.join(target,'workbench.sqlite'));
    return target;
  } finally {db.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {if(process.argv.length!==4)throw new Error('用法：node scripts/restore-backup.mjs <备份.sqlite> <全新目录>');const directory=await restoreBackup(process.argv[2],process.argv[3]);console.log('已校验并恢复到新目录：'+directory+'。当前工作台数据未替换。');}
  catch(error){console.error(error.message);process.exitCode=1;}
}
