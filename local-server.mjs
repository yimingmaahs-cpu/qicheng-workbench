import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { textConnector } from './lib/text-connector.mjs';

import { privateSources } from './lib/private-sources.mjs';
import { createApp } from './server.mjs';
import { offerBrowser } from './lib/offer-browser.mjs';
import { platformBrowser } from './lib/platform-browser.mjs';
import { qqReader, mailConfig } from './lib/mail.mjs';
import { fail, token, text, vaultAt, readBody, json, send } from './lib/cloud-security.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const now = () => new Date().toISOString();
export async function createLocal({ dataDir = path.join(root, 'local-data'), mailReaderFactory = qqReader, tenantOptions = {}, connectorFactory = textConnector, qqConnectorFactory = textConnector } = {}) {
  dataDir = path.resolve(dataDir);
  const instanceId=createHash('sha256').update((root+'\n'+dataDir).toLowerCase()).digest('hex');
  if (path.basename(dataDir) === 'data' || existsSync(path.join(dataDir, 'workbench.sqlite'))) throw Error('Cloud data must use a new dedicated directory');
  mkdirSync(dataDir, { recursive: true });
  const manifestPath=path.join(dataDir,'backup-manifest.json');
  if(existsSync(manifestPath)){
    const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
    for(const item of manifest.files){
      const file=path.resolve(dataDir,item.path);
      if(!file.startsWith(dataDir+path.sep) || createHash('sha256').update(readFileSync(file)).digest('hex')!==item.sha256)throw Error('恢复数据校验失败，停止启动。');
    }
    renameSync(manifestPath,path.join(dataDir,'restored-from.json'));
  }
  const db = new DatabaseSync(path.join(dataDir, 'cloud.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS config(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,created_at TEXT NOT NULL);`);
  const vault = vaultAt(dataDir);
  // Existing trial data stays in place; select its owner's workspace once, without login.
  db.exec('CREATE TABLE IF NOT EXISTS local_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  let owner = db.prepare("SELECT value FROM local_meta WHERE key='owner'").get()?.value;
  if (!owner) {
    const legacy = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
    owner = (legacy && db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY rowid LIMIT 1").get()?.id) || randomUUID();
    db.prepare('INSERT INTO local_meta VALUES(?,?)').run('owner', owner);
  }
  const user={id:owner};
  const settings = () => ({ enabled: false, baseUrl: '', model: '', cipher: '', revision: 0, ...JSON.parse(db.prepare('SELECT data FROM config WHERE id=1').get()?.data || '{}') });
  const audit = (actor, action, target) => db.prepare('INSERT INTO audit VALUES(?,?,?,?,?)').run(randomUUID(), actor, action, target, now());
  const publicSettings = () => { const {baseUrl,model,cipher,enabled,revision}=settings(); return {baseUrl,model,hasKey:!!cipher,enabled,revision}; };
  const model = () => { const c = settings(); return { baseUrl: c.baseUrl, model: c.model, enabled: c.enabled, redact: true, apiKey: c.enabled && c.cipher ? vault(c.cipher, 'open', 'model') : '' }; };
  const connector=connectorFactory(path.join(dataDir,'private-sources'));
  const qq=qqConnectorFactory(path.join(dataDir,'qq-bridge'));
  const tenants = new Map(), binding = new Set(), rates = new Map();
  let closing = false;
  function rate(key, limit, ms = 60000) {
    const time = Date.now(); let v = rates.get(key);
    if (!v || v.until < time) { v = { n: 0, until: time + ms }; rates.set(key, v); }
    if (++v.n > limit) throw fail(429, '操作过于频繁，请稍后再试。');
    if (rates.size > 5000) for (const [k, r] of rates) if (r.until < time) rates.delete(k);
  }
  async function tenant(user) {
    if(closing)throw fail(503,'工作台正在关闭。');
    if (!tenants.has(user.id)) {
      const promise = (async () => {
        const internalKey = token(), directory = path.join(dataDir, 'users', user.id);
        const app = createApp(directory, { ...tenantOptions, browser: tenantOptions.browser || offerBrowser(directory), platformBrowser: tenantOptions.platformBrowser || platformBrowser(directory), sharedModel: model, internalKey, mailVault: (v, op) => vault(v, op, user.id), mailReader: mailReaderFactory(), wechatReader:connector, qqReader:qq, cloud: true });
        await new Promise((resolve, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', resolve); });
        return { app, internalKey, directory, url: `http://127.0.0.1:${app.address().port}` };
      })();
      tenants.set(user.id, promise); promise.catch(() => tenants.delete(user.id));
    }
    return tenants.get(user.id);
  }
  async function inner(user, route, method = 'GET', body, contentType = 'application/json', extra = {}) {
    const t = await tenant(user);
    const payload=body!==undefined && typeof body==='object'&&!Buffer.isBuffer(body)?JSON.stringify(body):body;
    // Native HTTP accepts the OS-assigned internal port, including ports blocked by browser fetch.
    return new Promise((resolve,reject)=>{
      const request=http.request(t.url+route,{method,headers:{'X-Workbench':'1','X-Internal-Key':t.internalKey,'Content-Type':contentType,...extra,...(payload!==undefined?{'Content-Length':Buffer.byteLength(payload)}:{})},signal:AbortSignal.timeout(600000)},response=>{
        const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);
        response.on('end',()=>{const bytes=Buffer.concat(chunks);resolve({ok:response.statusCode>=200&&response.statusCode<300,status:response.statusCode,headers:new Headers(response.headers),json:async()=>JSON.parse(bytes.toString()),arrayBuffer:async()=>bytes});});
      });
      request.on('error',reject);request.end(payload);
    });
  }
  async function innerJSON(user, route, method, body) {
    const r = await inner(user, route, method, body), value = await r.json();
    if (!r.ok) throw fail(r.status, value.error || '操作失败。'); return value;
  }
  const sources=privateSources({innerJSON:(...args)=>innerJSON(user,...args)});
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      if (closing) throw fail(503, '服务正在维护，请稍后。');
      const expectedOrigin = `http://127.0.0.1:${server.address().port}`;
      const base = new URL(expectedOrigin);
      if (req.headers.host !== base.host) throw fail(403, '访问域名不正确。');
      const url = new URL(req.url, expectedOrigin), route = url.pathname, method = req.method;
      if (route.startsWith('/api/')) {
        if (req.headers.origin && req.headers.origin !== expectedOrigin) throw fail(403, '不允许跨站请求。');
        if (req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, '不允许跨站请求。');
        if (!['GET', 'HEAD'].includes(method) && req.headers['x-workbench'] !== '1') throw fail(403, '缺少请求标识。');
      }
      if (route === '/api/health' && method === 'GET') return send(res, 200, { app: 'offer-workbench-private', version, processId:process.pid, instanceId });
      if (route.startsWith('/api/')) {
        if (await sources.handle(req,res,url)) return;
        if (route === '/api/local/model') {
          const input = json(await readBody(req, 2 * 1024 * 1024));
          if (route === '/api/local/model' && method === 'PUT') {
            const previous = settings(); if (input.revision !== previous.revision) throw fail(409, '模型设置已更新，请刷新。');
            const baseUrl = text(input.baseUrl, 500, '模型地址'), modelName = text(input.model, 150, '模型名称');
            let u;try{u=new URL(baseUrl);}catch{throw fail(400,'请填写完整的模型 HTTPS 地址。');} if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw fail(400, '模型地址须为不含凭据的 HTTPS 地址。');
            const key = input.apiKey ? text(input.apiKey, 2000, '模型密钥') : '';
            let cipher = new URL(previous.baseUrl || baseUrl).origin === u.origin ? previous.cipher : '';
            if (key) cipher = vault(key, 'seal', 'model'); if (input.clearKey === true) cipher = '';
            if (input.enabled && !cipher) throw fail(400, '请先填写模型密钥。');
            db.prepare('INSERT INTO config VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify({ ...previous, baseUrl: baseUrl.replace(/\/$/, ''), model: modelName, cipher, enabled: input.enabled === true, revision: previous.revision + 1 }));
            audit(user.id, 'update-model', ''); return send(res, 200, { settings: publicSettings() });
          }
        }
        if (route === '/api/mail/connect' && method === 'POST') {
          rate('bind:' + user.id, 5, 600000); if (binding.has(user.id)) throw fail(409, '正在连接，请稍后。');
          binding.add(user.id);let reader;
          try {
            const input = json(await readBody(req, 4096));
            const config = mailConfig({ account: input.account, days: Number(input.days || 30), folder: 'INBOX', limit: 100, interval: 15, enabled: true, remember: true });
            const secret = text(input.authorizationCode, 256, '邮箱授权码');reader=mailReaderFactory();
            try { const folders = await reader.folders(config, secret); if (!folders.some(f => f.path.toUpperCase() === 'INBOX')) throw Error('missing inbox'); }
            catch { throw fail(502, '连接未成功。请确认已开启 IMAP、填写的是授权码，并检查网络；原绑定保持不变。'); }
            const current = await innerJSON(user, '/api/state');
            await innerJSON(user, '/api/mail/settings', 'PUT', { ...config, revision: current.mail.revision, authorizationCode: secret });
            // The validated account is saved before its first bounded read. A sync failure does not erase the successful binding.
            let syncError = ''; try { await innerJSON(user, '/api/mail/sync', 'POST'); } catch (e) { syncError = e.message; }
            return send(res, 200, { connected: true, syncError });
          } finally { binding.delete(user.id);reader?.stop?.(); }
        }
        if (route === '/api/mail/disconnect' && method === 'POST') {
          if(binding.has(user.id))throw fail(409,'正在连接邮箱，请稍后。');
          binding.add(user.id);
          try {
          const current = await innerJSON(user, '/api/state');
          await innerJSON(user, '/api/mail/settings', 'PUT', { ...current.mail, clearSecret: true, enabled: false });
          return send(res, 200, { disconnected: true });
          } finally {binding.delete(user.id);}
        }
        if (route === '/api/mail/clear-data' && method === 'POST') {
          if(binding.has(user.id))throw fail(409,'正在连接邮箱，请稍后。');
          binding.add(user.id);
          try {
          const input=json(await readBody(req,4096));if(input.confirm!==true)throw fail(400,'请确认清除站内邮件数据。');
          return send(res,200,await innerJSON(user,'/api/mail/cloud-clear','POST',{confirm:true}));
          } finally {binding.delete(user.id);}
        }
        const allowed = /^\/api\/(?:state$|wechat(?:\/|$)|qq(?:\/|$)|resumes(?:\/|$)|jobs(?:\/|$)|job-sources(?:\/|$)|announcements(?:\/|$)|applications(?:\/|$)|job-filters(?:\/|$)|mail\/(?:messages(?:\/|$)|sync$|rescan$|rematch$|scans(?:\/|$)))/.test(route);
        if (!allowed || (/\/open$/.test(route) && !/^\/api\/job-sources\/source-(boss|zhilian|51job)\/open$/.test(route))) throw fail(404, '接口不存在。');
        if (binding.has(user.id) && route.startsWith('/api/mail/') && method !== 'GET') throw fail(409, '正在连接邮箱，请稍后。');
        const body = ['GET', 'HEAD'].includes(method) ? undefined : await readBody(req);
        if (binding.has(user.id) && route.startsWith('/api/mail/') && method !== 'GET') throw fail(409, '正在连接邮箱，请稍后。');
          const response = await inner(user, route + url.search, method, body, req.headers['content-type'] || 'application/json', req.headers['x-file-name'] ? { 'X-File-Name': req.headers['x-file-name'] } : {});
          if (route === '/api/state' && response.ok) {
            const state = await response.json(); state.source = {}; 
            state.capabilities.privateImportSelection = true;
            state.local = { workspace:owner, model:publicSettings(), version };
            state.settings = { ...state.settings, keySaved: !!settings().cipher, keyError: '', keyPersistence: true }; state.mail.mailDirectOpen = false;
            return send(res, 200, state);
          }
          for (const h of ['content-type', 'content-disposition']) if (response.headers.has(h)) res.setHeader(h, response.headers.get(h));
          res.writeHead(response.status); res.end(Buffer.from(await response.arrayBuffer())); return;
      }
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/private-ui.js': ['private-ui.js', 'text/javascript'], '/private-bootstrap.js': ['private-bootstrap.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/private.css': ['private.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'], '/recruitment-ui.js': ['recruitment-ui.js', 'text/javascript'], '/workspace-autosave.js': ['workspace-autosave.js', 'text/javascript'], '/vendor/tabulator.js': ['../node_modules/tabulator-tables/dist/js/tabulator_esm.min.js', 'text/javascript'], '/vendor/tabulator.css': ['../node_modules/tabulator-tables/dist/css/tabulator.min.css', 'text/css'], '/vendor/sortable.js': ['../node_modules/sortablejs/modular/sortable.complete.esm.js', 'text/javascript'] };
      if (!assets[route] || method !== 'GET') throw fail(404, '页面不存在。');
      const [file, type] = assets[route]; res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }); res.end(readFileSync(path.join(root, 'public', file)));
    } catch (e) { if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : '操作失败，请稍后重试。' }); else res.end(); }
  });
  server.requestTimeout = 120000; server.headersTimeout = 15000;
  let shutdown;
  const close = () => shutdown ||= (async () => { closing = true; qq.close?.(); await connector.close(); if (server.listening) await new Promise(r => server.close(r)); for (const p of tenants.values()) { const t = await p; if (t.app.listening) await new Promise(r => t.app.close(r)); } db.close(); })();
  await tenant(user);
  return { server, close, dataDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port=Number(process.env.PORT || 4320);
  const app=await createLocal({dataDir:process.env.WORKBENCH_DATA_DIR || undefined});
  app.server.listen(port,'127.0.0.1',()=>console.log('启程私人来源版 http://127.0.0.1:'+port));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void app.close().then(()=>process.exit(0)));
}
