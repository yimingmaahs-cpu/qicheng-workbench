import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync} from 'node:fs';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {spawnSync, spawn} from 'node:child_process';

const repo = 'Yimingmaahs-CPU/qicheng-workbench';
export const assetName = 'Qicheng-Windows-x64.zip';
const versionPattern = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/;
export function compareVersions(a, b) {
  if (!versionPattern.test(a) || !versionPattern.test(b)) throw Error('无效的版本号。');
  const right = b.split('.').map(Number);
  const parts = a.split('.').map(Number);
  return (parts[0]-right[0]) || (parts[1]-right[1]) || (parts[2]-right[2]);
}
export function selectUpdate(release, current) {
  const version = String(release.tag_name || '').replace(/^v/, '');
  if (release.draft || release.prerelease || !versionPattern.test(version) || compareVersions(version,current)<=0) return;
  const asset = release.assets?.find(a => a.name === assetName);
  if (!asset || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest)) throw Error('正式版安装包或校验值尚未就绪。');
  return {version, digest:asset.digest.toLowerCase(), url:'https://github.com/'+repo+'/releases/download/v'+version+'/'+assetName};
}
const versionAt = dir => JSON.parse(readFileSync(path.join(dir,'package.json'),'utf8')).version;
const runtime = dir => path.join(dir,'runtime','node','node.exe');
export async function installUpdate(update, versions, download = fetch, unpack = expand) {
  const stage = mkdtempSync(path.join(versions,'.download-'));
  try {
    const archive = path.join(stage,'update.zip');
    const response = await download(update.url,{signal:AbortSignal.timeout(180000)});
    if (!response.ok) throw Error('下载失败（HTTP '+response.status+'）。');
    const hash = createHash('sha256');
    await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,enc,done){hash.update(chunk);done(null,chunk);}}),createWriteStream(archive));
    if ('sha256:'+hash.digest('hex') !== update.digest) throw Error('安装包校验失败。');
    unpack(archive,stage);
    const dir = path.join(stage,'app'), dest = path.join(versions,update.version);
    if (versionAt(dir)!==update.version || !existsSync(runtime(dir)) || !existsSync(path.join(dir,'local-server.mjs'))) throw Error('安装包不完整。');
    try {renameSync(dir,dest);} catch(error) {if (!existsSync(dest) || versionAt(dest)!==update.version) throw error;}
    return dest;
  } finally {rmSync(stage,{recursive:true,force:true});}
}
function expand(zip,destination) {
  const script = 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:QICHENG_ZIP,$env:QICHENG_STAGE)';
  const p = spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; "+script],{windowsHide:true,env:{...process.env,QICHENG_ZIP:zip,QICHENG_STAGE:destination}});
  if (p.status!==0) throw Error('解压未完成。');
}
async function main() {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const data = path.join(root,'我的数据'), versions = path.join(root,'versions');
  mkdirSync(versions,{recursive:true});
  let dir = path.join(root,'app');
  for(const item of readdirSync(versions,{withFileTypes:true})) {
    const installed = path.join(versions,item.name);
    if(item.isDirectory() && versionPattern.test(item.name) && compareVersions(item.name,versionAt(dir))>0 && versionAt(installed)===item.name) dir=installed;
  }
  const site='http://127.0.0.1:4320';
  const health=async()=>{try{return await (await fetch(site+'/api/health',{signal:AbortSignal.timeout(800)})).json();}catch{return null;}};
  const open=()=>spawn('rundll32.exe',['url.dll,FileProtocolHandler',site],{windowsHide:true,stdio:'ignore'}).unref();
  const id=folder=>createHash('sha256').update((folder+'\n'+data).toLowerCase()).digest('hex');
  const active=await health();
  if(active){
    const folders=[path.join(root,'app'),...readdirSync(versions).filter(n=>versionPattern.test(n)).map(n=>path.join(versions,n))];
    if(!folders.some(folder=>id(folder)===active.instanceId)) throw Error('4320 端口已有其他工作台。请先保存并关闭它。');
    open(); return;
  }
  try {
    const response=await fetch('https://api.github.com/repos/'+repo+'/releases/latest',{signal:AbortSignal.timeout(4500)});
    if(!response.ok) throw Error('HTTP '+response.status);
    const update=selectUpdate(await response.json(),versionAt(dir));
    if(update){console.log('正在更新到 v'+update.version);dir=await installUpdate(update,versions);}
  } catch(error){console.log('本次更新未完成，使用已安装版本。'+error.message);}
  console.log('启程工作台 v'+versionAt(dir)+'。保存工作后按 Ctrl+C 退出；下次启动会检查更新。');
  const child=spawn(runtime(dir),['--disable-warning=ExperimentalWarning','local-server.mjs'],{cwd:dir,stdio:'inherit',env:{...process.env,PORT:'4320',WORKBENCH_DATA_DIR:data}});
  const ended=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??0));});
  const stop=()=>{};process.on('SIGINT',stop); // The console delivers Ctrl+C to the server as well.
  try {
    for(let i=0;i<60 && child.exitCode===null;i++){
      if((await health())?.instanceId===id(dir)){open();break;}
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    process.exitCode=await ended;
  }finally{process.off('SIGINT',stop);}
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(e=>{console.error(e.message);process.exitCode=1;});

