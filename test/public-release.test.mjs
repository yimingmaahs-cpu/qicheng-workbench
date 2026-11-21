import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {createLocal} from '../local-server.mjs';
import {assetName,selectUpdate,installUpdate} from '../release/launcher.mjs';

test('new desktop workspace starts with empty records, model and mailbox',async t=>{
  const dataDir=mkdtempSync(path.join(os.tmpdir(),'qicheng-empty-'));
  const app=await createLocal({dataDir});
  t.after(async()=>{await app.close();rmSync(dataDir,{recursive:true,force:true,maxRetries:5,retryDelay:150});});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const response=await fetch('http://127.0.0.1:'+app.server.address().port+'/api/state');
  assert.equal(response.status,200);
  const s=await response.json();
  for(const key of ['jobs','applications','resumes','announcements','intents','savedJobFilters']) assert.deepEqual(s[key],[],key);
  assert.equal(s.mail.account,'');assert.equal(s.mail.hasSecret,false);assert.equal(s.mail.count,0);
  assert.equal(s.local.model.hasKey,false);assert.equal(s.local.model.baseUrl,'');assert.equal(s.local.model.enabled,false);
  assert.deepEqual(s.wechat.sources,[]);assert.deepEqual(s.qq.sources,[]);
});

test('verified newer release is staged beside user data; corrupted or older releases never replace it',async t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'qicheng-update-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const versions=path.join(root,'versions'), data=path.join(root,'我的数据');
  mkdirSync(versions);mkdirSync(data);writeFileSync(path.join(data,'marker'),'kept');
  const bytes='synthetic archive',digest='sha256:'+createHash('sha256').update(bytes).digest('hex');
  const release={tag_name:'v0.14.0',assets:[{name:assetName,digest}]};
  const update=selectUpdate(release,'0.13.4');
  assert.equal(selectUpdate(release,'0.14.0'),undefined);
  assert.equal(selectUpdate({...release,prerelease:true},'0.13.4'),undefined);
  const unpack=(_,stage)=>{const dir=path.join(stage,'app');mkdirSync(path.join(dir,'runtime','node'),{recursive:true});writeFileSync(path.join(dir,'runtime','node','node.exe'),'');writeFileSync(path.join(dir,'local-server.mjs'),'');writeFileSync(path.join(dir,'package.json'),'{"version":"0.14.0"}');};
  await assert.rejects(installUpdate(update,versions,async()=>new Response('broken'),unpack),/校验失败/);
  assert.deepEqual(readdirSync(versions),[]);
  assert.equal(await installUpdate(update,versions,async()=>new Response(bytes),unpack),path.join(versions,'0.14.0'));
  assert.equal(readFileSync(path.join(data,'marker'),'utf8'),'kept');
});
