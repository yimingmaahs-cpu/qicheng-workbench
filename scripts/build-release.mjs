import path from 'node:path';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import {mkdirSync,mkdtempSync,copyFileSync,createWriteStream,readFileSync,writeFileSync,readdirSync,rmSync,existsSync,renameSync} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {assetName} from '../release/launcher.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dist=path.join(root,'releases');
const temp=mkdtempSync(path.join(os.tmpdir(),'qicheng-release-'));
const payload=path.join(temp,'bundle'), app=path.join(payload,'app');
function ps(script,env={}) {
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; "+script],{env:{...process.env,...env},stdio:'inherit'});
}
function copy(file) {
  const dest=path.join(app,file);
  mkdirSync(path.dirname(dest),{recursive:true});copyFileSync(path.join(root,file),dest);
}
try {
  mkdirSync(app,{recursive:true});mkdirSync(dist,{recursive:true});
  for(const file of ['server.mjs','local-server.mjs','package.json','package-lock.json','THIRD_PARTY_NOTICES.md','third_party/jobfindsme-MIT.txt','third_party/mailparser/LICENSE','third_party/imapflow/LICENSE.txt','third_party/administrative-divisions-of-china/LICENSE']) copy(file);
  for(const folder of ['lib','public']){
    for(const item of readdirSync(path.join(root,folder),{withFileTypes:true})){
      if(item.isFile() && /\.(mjs|js|css|html|svg)$/.test(item.name))copy(folder+'/'+item.name);
    }
  }
  execFileSync('cmd.exe',['/d','/c','npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund'],{cwd:app,stdio:'inherit'});
  const archive=process.env.QICHENG_NODE_ARCHIVE || path.join(temp,'node.zip');
  if(!process.env.QICHENG_NODE_ARCHIVE){
    const res=await fetch('https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip',{signal:AbortSignal.timeout(180000)});
    if(!res.ok) throw Error('Node 下载未完成。');
    await pipeline(Readable.fromWeb(res.body),createWriteStream(archive));
  }
  if(createHash('sha256').update(readFileSync(archive)).digest('hex')!=='57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73') throw Error('Node 运行时校验失败。');
  const runtime=path.join(app,'runtime','node');mkdirSync(runtime,{recursive:true});
  ps("$z=[IO.Compression.ZipFile]::OpenRead($env:QICHENG_NODE_ZIP); try {foreach ($name in 'node.exe','LICENSE'){[IO.Compression.ZipFileExtensions]::ExtractToFile($z.GetEntry('node-v24.19.0-win-x64/'+$name),(Join-Path $env:QICHENG_RUNTIME $name))}}finally{$z.Dispose()}",{QICHENG_NODE_ZIP:archive,QICHENG_RUNTIME:runtime});
  copyFileSync(path.join(root,'release','launcher.mjs'),path.join(payload,'launcher.mjs'));
  copyFileSync(path.join(root,'README.md'),path.join(payload,'使用说明.md'));
  writeFileSync(path.join(payload,'开始使用.cmd'),'@echo off\r\n"%~dp0app\\runtime\\node\\node.exe" "%~dp0launcher.mjs"\r\nif errorlevel 1 pause\r\n','ascii');
  const out=path.join(dist,assetName), zip=path.join(dist,'.build-'+process.pid+'.zip');
  try{ps('[IO.Compression.ZipFile]::CreateFromDirectory($env:QICHENG_PAYLOAD,$env:QICHENG_ZIP)',{QICHENG_PAYLOAD:payload,QICHENG_ZIP:zip});renameSync(zip,out);}
  finally{if(existsSync(zip))rmSync(zip);}
  console.log(out);
}finally{rmSync(temp,{recursive:true,force:true});}

