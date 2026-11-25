import { app, BrowserWindow, Menu, Tray, nativeImage, screen, ipcMain, protocol, dialog } from 'electron';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { TemplateStore } from './templates';
import { Companion } from './companion-main';
import { AIBackend } from './ai-main';
import { PetChat } from './pet-chat-main';
import { AI_ROLES } from './ai-types';
import { attentionAt, clamp, clampWindow, dragged, readSettings, type Frame, type Settings, type Template, type Command, type Point } from './domain';

if (process.env.FELT_TEST_HOME) app.setPath('userData', process.env.FELT_TEST_HOME);
protocol.registerSchemesAsPrivileged([{ scheme: 'pet', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
let pet: BrowserWindow, panel: BrowserWindow | null = null, tray: Tray, store: TemplateStore;
let companion: Companion | undefined;
let ai: AIBackend | undefined;
let petChat: PetChat | undefined;
let lastClick: {at:number;point:Point}|null=null;
let settings: Settings = readSettings(null), ready = false, hit = false, attention = false, moving = false, direction = 1;
let head: Point = {x:210,y:100},crown:Point={x:210,y:60};
let gesture: { start: Point; origin: Point; active: boolean } | null = null;
let walkEnd = 0, nextWalk = 0, targetX = 0, floatX = 0, reactUntil = 0, lastTick = performance.now(), menuOpen = false;
let active: Template | undefined;
let pending: { template: Template; resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null;
let timer: NodeJS.Timeout, saveTimer: NodeJS.Timeout, lastIgnored = true, quitting = false, importing = false;
const resourceRoot = () => app.isPackaged ? process.resourcesPath : app.getAppPath();
const settingsPath = () => join(app.getPath('userData'),'settings.json');
let saveChain = Promise.resolve();
function save(): Promise<void> {
  const data = JSON.stringify(settings,null,2);
  saveChain = saveChain.catch(() => {}).then(async () => {
    await mkdir(app.getPath('userData'),{recursive:true});
    await writeFile(`${settingsPath()}.tmp`,data,'utf8');
    await rename(`${settingsPath()}.tmp`,settingsPath());
  });
  return saveChain;
}
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { void save().catch(console.error); },400); }
function emit(type: string, message?: string) {
  for (const w of [pet,panel]) if (w && !w.isDestroyed()) w.webContents.send('pet:event',{type,message});
}
function frame(): Frame {
  return {cursor:screen.getCursorScreenPoint(),bounds:pet.getBounds(),walking:moving,dragging:gesture?.active ?? false,attention,direction,visible:pet.isVisible()};
}
const petSize = () => ({width:Math.round(settings.size*1.65),height:Math.round(settings.size*1.2)});
function placePet(x: number,y: number) {
  // setPosition reuses rounded native bounds on Windows. At fractional display
  // scaling those dimensions grow on every move; always send the intended size.
  pet.setBounds({x:Math.round(x),y:Math.round(y),...petSize()});
}
function groundedPosition() {
  const bounds = pet.getBounds(), area = screen.getDisplayMatching(bounds).workArea;
  const position = clampWindow({...bounds,y:area.y+area.height-bounds.height},area);
  placePet(position.x,position.y); floatX = position.x;
  settings.position = {x:position.x,y:position.y}; settings.grounded = true; nextWalk = Date.now()+7000;
  scheduleSave();
}
function reconcileDisplay() {
  if (!pet || pet.isDestroyed()) return;
  finishGesture(false); moving = false;
  const bounds = {...pet.getBounds(),...petSize()}, area = screen.getDisplayMatching(bounds).workArea;
  const b = clampWindow(settings.grounded ? {...bounds,y:area.y+area.height-bounds.height} : bounds,area);
  placePet(b.x,b.y); floatX = b.x; settings.position = {x:b.x,y:b.y}; scheduleSave();
}
function setSize(size: number) {
  settings.size = clamp(Math.round(size),180,380);
  const b = pet.getBounds(), {width,height} = petSize();
  pet.setBounds({ x: Math.round(b.x+(b.width-width)/2), y:b.y+b.height-height,width,height });
  reconcileDisplay(); emit('settings');
}
function setIgnored(ignore: boolean) {
  if (ignore !== lastIgnored) { pet.setIgnoreMouseEvents(ignore,{forward:true}); lastIgnored=ignore; }
}
function moveGesture(cursor: Point) {
  if (!gesture) return;
  if (!gesture.active&&dragged(gesture.start,cursor)) {gesture.active=true;lastClick=null;companion?.beginDrag();}
  if (!gesture.active) return;
  const b=pet.getBounds(),area=screen.getDisplayNearestPoint(cursor).workArea;
  const target=clampWindow({...b,x:gesture.origin.x+cursor.x-gesture.start.x,y:gesture.origin.y+cursor.y-gesture.start.y},area);
  if (target.x!==b.x || target.y!==b.y) placePet(target.x,target.y);
  floatX=target.x;
}
function finishGesture(released: boolean) {
  if (!gesture) return;
  // A complete fast drag can fall between two movement ticks. Sample the final
  // pointer position before deciding whether release counts as a click.
  if (released) moveGesture(screen.getCursorScreenPoint());
  if (gesture.active) {
    const b=pet.getBounds(),area=screen.getDisplayMatching(b).workArea;
    settings.grounded=Math.abs(b.y+b.height-area.y-area.height)<24;
    settings.position={x:b.x,y:b.y};
    if(settings.grounded) groundedPosition();
    scheduleSave();emit('settings');
  } else if (released) {
    reactUntil=Date.now()+1800;emit('react');
    const point=screen.getCursorScreenPoint(),now=Date.now();
    if(lastClick&&now-lastClick.at<=450&&Math.hypot(point.x-lastClick.point.x,point.y-lastClick.point.y)<=6){lastClick=null;if(petChat?.isOpen())petChat.hide();else void openPetChat().catch(showError);}
    else{lastClick={at:now,point};companion?.click();}
  } else lastClick=null;
  const wasDragging=gesture.active;gesture=null;if(wasDragging)companion?.endDrag();moving=false;nextWalk=Date.now()+7000;setIgnored(!hit);
}
function select(template: Template): Promise<void> {
  if (pending) return Promise.reject(new Error('角色正在切换，请稍候'));
  if (template.manifest.id === active?.manifest.id) return Promise.resolve();
  finishGesture(false); moving = false;
  return new Promise((resolve,reject) => {
    const timer = setTimeout(() => { pending = null; reject(new Error('模型加载超时，原角色已保留')); },20000);
    pending = {template,resolve,reject,timer};
    pet.webContents.send('pet:select',template);
  });
}
async function importTemplate() {
  if (importing) return;
  importing = true;
  try {
    const result = await dialog.showOpenDialog({title:'导入角色模板包',filters:[{name:'角色模板 ZIP',extensions:['zip']}],properties:['openFile']});
    if (result.canceled || !result.filePaths[0]) return;
    const template = await store.import(result.filePaths[0]);
    emit('templates'); await select(template);
    emit('notice',`已导入 ${template.manifest.name}`);
  } catch (error) { showError(error); } finally { importing = false; }
}
function showError(error: unknown) { const message = error instanceof Error ? error.message : String(error); emit('error',message); void dialog.showMessageBox({type:'error',title:'毛毡伙伴',message,buttons:['知道了']}); }
async function command(c: Command) {
  if (!c || typeof c !== 'object' || typeof c.type !== 'string') throw new Error('无效命令');
  switch(c.type) {
    case 'select': { const t = store.templates.find(t=>t.manifest.id===c.id); if (!t) throw new Error('模板不存在'); await select(t); break; }
    case 'size': if (typeof c.size !== 'number' || !Number.isFinite(c.size)) throw new Error('无效大小'); setSize(c.size); break;
    case 'walk': if (typeof c.enabled !== 'boolean') throw new Error('无效散步设置'); settings.walking=c.enabled; moving=false; nextWalk=Date.now()+7000; scheduleSave(); emit('settings'); break;
    case 'bottom': groundedPosition(); emit('settings'); break;
    case 'hide': finishGesture(false); pet.hide(); moving=false; emit('visibility'); break;
    case 'import': await importTemplate(); break;
    case 'panel': await openPanel(); break;
    case 'chat': await openPetChat(); break;
    case 'quit': app.quit(); break;
    default: throw new Error('未知命令');
  }
  updateMenu();
}
function menuItems(): Electron.MenuItemConstructorOptions[] {
  const run = (c: Command) => () => { void command(c).catch(showError); };
  return [
    {label:'毛毡伙伴',enabled:false},
    {label:active?.manifest.draft ? '当前：动作调试版' : '桌面上的小小陪伴',enabled:false},
    {type:'separator'},
    {label:'切换角色',submenu:store.templates.map(t=>({label:t.manifest.name+(t.manifest.draft?'（样模）':''),type:'radio',checked:t.manifest.id===active?.manifest.id,click:run({type:'select',id:t.manifest.id})}))},
    {label:'角色与设置…',click:run({type:'panel'})},
    {label:'今日计划…',click:()=>{void openPanel('plan');}},
    {label:'和我聊聊（桌面气泡）',enabled:!!AI_ROLES[active?.manifest.id??settings.templateId],click:run({type:'chat'})},
    {label:'打开完整聊天…',click:()=>{void openPanel('chat');}},
    {label:companion?.store.data.focus.status==='running'?'暂停专注':'开始／继续专注',click:()=>{void companion?.command({type:companion.store.data.focus.status==='running'?'focus.pause':'focus.start'}).catch(showError);}},
    {label:'免打扰',type:'checkbox',checked:companion?.store.data.preferences.dnd??false,click:()=>{if(companion)void companion.command({type:'preferences.save',preferences:{...companion.store.data.preferences,dnd:!companion.store.data.preferences.dnd}}).catch(showError);}},
    {label:'导入模板包…',click:run({type:'import'})},
    {type:'separator'},
    {label:'允许散步',type:'checkbox',checked:settings.walking,click:run({type:'walk',enabled:!settings.walking})},
    {label:'回到底部',click:run({type:'bottom'})},
    {label:'角色大小',submenu:[200,260,320].map(size=>({label:`${size} DIP`,type:'radio',checked:Math.abs(settings.size-size)<5,click:run({type:'size',size})}))},
    {label:pet.isVisible()?'隐藏伙伴':'显示伙伴',click:()=>{finishGesture(false);pet.isVisible()?pet.hide():pet.showInactive();emit('visibility');updateMenu();}},
    {type:'separator'}, {label:'退出',click:run({type:'quit'})}
  ];
}
function updateMenu() { if (tray && !tray.isDestroyed()) tray.setContextMenu(Menu.buildFromTemplate(menuItems())); }
async function openPetChat(conversation?:string){
  if(!petChat)throw Error('聊天还在准备，请稍后再试');
  if(!AI_ROLES[active?.manifest.id??settings.templateId])throw Error('当前导入角色暂不支持 AI 对话，请切换内置伙伴');
  if(!pet.isVisible())pet.showInactive();moving=false;nextWalk=Date.now()+7000;
  if(companion?.message?.kind!=='ai-chat'&&!companion?.message?.noticeIds.length)companion?.closeBubble();
  await petChat.open(conversation);
}
async function openPanel(tab?:string) {
  if (panel && !panel.isDestroyed()) { panel.show(); panel.focus(); if(tab)panel.webContents.send('companion:navigate',tab); return; }
  panel = new BrowserWindow({width:880,height:740,minWidth:720,minHeight:600,title:process.argv.includes('--review-preview')?'毛毡伙伴 · AI 开发预览（待验收）':'毛毡伙伴 · 角色与设置',backgroundColor:'#f7f5ef',autoHideMenuBar:true,
    webPreferences:{preload:join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  secure(panel); panel.on('closed',()=>{panel=null;});
  if(process.argv.includes('--review-preview'))panel.on('page-title-updated',event=>event.preventDefault());
  await panel.loadFile(join(app.getAppPath(),'dist/index.html'),{query:{panel:'1',...(tab?{tab}:{})}});
}
function secure(window: BrowserWindow) {
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_w,_permission,cb)=>cb(false));
}
function authorized(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent, petOnly=false): boolean {
  return event.senderFrame === event.sender.mainFrame && (event.sender === pet.webContents || (!petOnly && panel?.webContents===event.sender));
}
function setupIPC() {
  ipcMain.handle('pet:bootstrap',event=>{
    if (!authorized(event)) throw new Error('来源无效');
    return {templates:store.templates,settings,frame:frame()};
  });
  ipcMain.handle('pet:command',(event,c)=>{if (!authorized(event)) throw new Error('来源无效');return command(c);});
  ipcMain.on('pet:select-result',(event,data)=>{
    if (!authorized(event,true) || typeof data?.id !== 'string' || typeof data?.ok !== 'boolean') return;
    if (pending && pending.template.manifest.id === data.id) {
      const p = pending; clearTimeout(p.timer); pending = null;
      if (data.ok) {active=p.template;ready=true;settings.templateId=data.id;scheduleSave();p.resolve();emit('settings');companion?.roleChanged();petChat?.roleChanged();}
      else p.reject(new Error(typeof data.error === 'string' ? data.error.slice(0,500) : '模型加载失败'));
    } else if (!ready && store.templates.some(t=>t.manifest.id===data.id)) {
      if (data.ok) {active=store.templates.find(t=>t.manifest.id===data.id);settings.templateId=data.id;ready=true;scheduleSave();}
      else showError(`初始模型加载失败：${data.error ?? '未知错误'}。可从托盘切换角色。`);
    }
    nextWalk=Date.now()+7000;updateMenu();
  });
  ipcMain.on('pet:hit',(event,data)=>{
    if (!authorized(event,true) || typeof data?.hit !== 'boolean') return;
    hit=data.hit;
    if (Number.isFinite(data.head?.x) && Number.isFinite(data.head?.y)) { const b=pet.getBounds();head={x:clamp(data.head.x,0,b.width),y:clamp(data.head.y,0,b.height)}; }
    if (Number.isFinite(data.crown?.x) && Number.isFinite(data.crown?.y)) {const b=pet.getBounds();crown={x:clamp(data.crown.x,0,b.width),y:clamp(data.crown.y,0,b.height)};}
    setIgnored(!hit && !gesture && !menuOpen);
  });
  ipcMain.on('pet:pointer',(event,kind)=>{
    if (!authorized(event,true)) return;
    if (kind==='down' && hit && ready && !pending) { const b=pet.getBounds();gesture={start:screen.getCursorScreenPoint(),origin:{x:b.x,y:b.y},active:false};moving=false;setIgnored(false); }
    else if (kind==='up') finishGesture(true);
    else if (kind==='cancel') finishGesture(false);
  });
  ipcMain.on('pet:menu',event=>{
    if (!authorized(event,true)) return;
    finishGesture(false);moving=false;menuOpen=true;setIgnored(false);
    Menu.buildFromTemplate(menuItems()).popup({window:pet,callback:()=>{menuOpen=false;nextWalk=Date.now()+7000;setIgnored(!hit);}});
  });
}
function tick() {
  const now=performance.now(),dt=Math.min((now-lastTick)/1000,0.1);lastTick=now;
  if (!pet || pet.isDestroyed() || !pet.isVisible()) return;
  const cursor=screen.getCursorScreenPoint(),b=pet.getBounds(),time=Date.now();
  attention=attentionAt(attention,Math.hypot(cursor.x-b.x-head.x,cursor.y-b.y-head.y));
  moveGesture(cursor);
  const canWalk=ready && settings.walking && settings.grounded && !attention && !gesture && !pending && !menuOpen && !petChat?.isOpen() && time>reactUntil;
  if (!canWalk) {moving=false;nextWalk=time+5000;}
  else if (moving) {
    const area=screen.getDisplayMatching(b).workArea;
    targetX=clamp(targetX,area.x,area.x+Math.max(0,area.width-b.width));
    const speed=(active?.manifest.walkSpeed ?? 36)*(settings.size/260);
    floatX += direction*speed*dt;
    if (direction*(floatX-targetX)>=0 || time>walkEnd) {floatX=clamp(floatX,area.x,area.x+Math.max(0,area.width-b.width));moving=false;nextWalk=time+8000+Math.random()*12000;}
    if (Math.round(floatX)!==b.x) placePet(floatX,b.y);
    settings.position={x:Math.round(floatX),y:b.y};if(!moving)scheduleSave();
  } else if (time>nextWalk) {
    const area=screen.getDisplayMatching(b).workArea;
    targetX=clamp(b.x+(Math.random()<0.5?-1:1)*(80+Math.random()*180),area.x,area.x+Math.max(0,area.width-b.width));
    direction=targetX>=b.x?1:-1;floatX=b.x;moving=Math.abs(targetX-b.x)>10;walkEnd=time+7000;nextWalk=time+8000;
  }
  pet.webContents.send('pet:frame',frame());petChat?.position();
}
const locked=app.requestSingleInstanceLock();
if (!locked) app.quit();
else {
  app.on('second-instance',()=>{if(pet){pet.showInactive();void openPanel();}});
  app.whenReady().then(async()=>{
    app.setAppUserModelId('local.felt.companions');
    try {
      settings=readSettings(JSON.parse(await readFile(settingsPath(),'utf8').catch(()=>'{}')));
    } catch {settings=readSettings(null);}
    const root=resourceRoot();
    store=new TemplateStore(join(root,app.isPackaged?'templates':'assets/templates'),join(app.getPath('userData'),'templates'));
    await store.scan();
    if(!store.templates.length) throw new Error('没有可用模板，请先运行 npm run models');
    if(!store.templates.some(t=>t.manifest.id===settings.templateId))settings.templateId=store.templates[0].manifest.id;
    protocol.handle('pet',async request=>{
      try {
        const url=new URL(request.url),match=/^\/([a-z][a-z0-9-]{2,47})\/(model\.glb|preview\.png)$/.exec(url.pathname);
        if(request.method!=='GET'||url.hostname!=='assets'||!match)return new Response('Forbidden',{status:403});
        const path=store.roots.get(match[1]);if(!path)return new Response('Not found',{status:404});
        const bytes=await readFile(join(path,match[2]));
        return new Response(bytes,{headers:{'Content-Type':match[2].endsWith('.glb')?'model/gltf-binary':'image/png','Cache-Control':'no-store'}});
      }catch{return new Response('Invalid asset',{status:400});}
    });
    const firstRun=!settings.position;
    const {width,height}=petSize(),area=(settings.position?screen.getDisplayNearestPoint(settings.position):screen.getPrimaryDisplay()).workArea;
    const initial=clampWindow({width,height,...(settings.position??{x:area.x+area.width-width-50,y:area.y+area.height-height})},area);
    pet=new BrowserWindow({...initial,transparent:true,frame:false,resizable:false,hasShadow:false,alwaysOnTop:true,skipTaskbar:true,focusable:false,show:false,backgroundColor:'#00000000',
      webPreferences:{preload:join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:true}});
    secure(pet);pet.setIgnoreMouseEvents(true,{forward:true});floatX=initial.x;
    const imagePath=join(root,app.isPackaged?'tray.png':'assets/tray.png');
    tray=new Tray(nativeImage.createFromPath(imagePath));tray.setToolTip('毛毡伙伴 · 双击伙伴聊天，右键打开菜单');tray.on('double-click',()=>{void openPanel();});
    setupIPC();updateMenu();
    companion=new Companion({pet:()=>pet,panel:()=>panel,openPanel,openChat:openPetChat,role:()=>({id:active?.manifest.id??settings.templateId,name:active?.manifest.name??'伙伴'}),position:()=>{const b=pet.getBounds();return {x:b.x+crown.x,y:b.y+crown.y,dragging:gesture?.active??false};},menu:updateMenu,react:()=>{if(!gesture){reactUntil=Date.now()+1800;emit('react');}}});
    await companion.init();
    ai=new AIBackend(()=>panel,event=>{if(event.role===(active?.manifest.id??settings.templateId)&&!petChat?.isOpen()&&!petChat?.ownsReply(event))companion?.aiReply(event.text);},event=>petChat?.onEvent(event));
    await ai.init();
    petChat=new PetChat(ai,{pet:()=>pet,role:()=>active?.manifest.id??settings.templateId,position:()=>{const b=pet.getBounds();return {x:b.x+crown.x,y:b.y+crown.y,dragging:gesture?.active??false};},openPanel,reply:reply=>companion?.aiChatReply(reply)});
    companion.chatting=()=>!!petChat?.isOpen()||!!ai?.chatting();
    companion.immersive=()=>!!petChat?.isOpen();
    pet.on('show',()=>{lastTick=performance.now();emit('visibility');updateMenu();});
    pet.on('hide',()=>{finishGesture(false);lastClick=null;moving=false;petChat?.hide();void companion?.petHidden().catch(showError);updateMenu();});
    pet.webContents.on('render-process-gone',()=>{ready=false;showError('渲染进程已退出，请从托盘退出后重新打开。');});
    await pet.loadFile(join(app.getAppPath(),'dist/index.html'));
    reconcileDisplay();pet.showInactive();
    if(process.argv.includes('--chat') || process.argv.includes('--settings') || firstRun)await openPanel(process.argv.includes('--chat')?'chat':undefined);
    // Windows may quantize a 33ms timer up to ~47ms. Poll the global pointer at
    // 16ms so dragging and attention stay responsive; rendering keeps its 30 FPS cap.
    nextWalk=Date.now()+7000;timer=setInterval(tick,16);
    screen.on('display-added',reconcileDisplay);screen.on('display-removed',reconcileDisplay);screen.on('display-metrics-changed',reconcileDisplay);
  }).catch(error=>{console.error(error);dialog.showErrorBox('毛毡伙伴启动失败',String(error));app.exit(1);});
}
app.on('window-all-closed',()=>{});
app.on('before-quit',event=>{
  if(quitting)return;
  event.preventDefault();quitting=true;clearInterval(timer);clearTimeout(saveTimer);petChat?.close();
  if(pending){clearTimeout(pending.timer);pending.reject(new Error('程序正在退出'));pending=null;}
  void Promise.all([save(),companion?.shutdown(),ai?.close()]).catch(console.error).finally(()=>app.quit());
});
