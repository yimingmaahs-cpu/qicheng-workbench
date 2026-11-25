import './style.css';
import { Actor } from './actor';
import { stepBehavior, type Behavior } from './behavior';
import { DEFAULT_SETTINGS, parseManifest, type PetAPI, type Template, type Frame, type Bootstrap, type Command } from './domain';
import { mountPlanner } from './planner-view';
import { mountBubble } from './bubble-view';
import { mountPetChat } from './pet-chat-view';

declare global { interface Window { pet?: PetAPI; } }
const app=document.querySelector<HTMLElement>('#app')!;
const panelMode=new URLSearchParams(location.search).has('panel')||!window.pet;
const api=window.pet;
let boot: Bootstrap,actor: Actor,selected: Template|undefined,loading=false,raf=0,last=performance.now(),lastDraw=0;
let localCursor={x:-1000,y:-1000},previewAction: 'idle'|'walk'|'react'|'drag'|'rest'='idle',previewRotation=0;
let behavior: Behavior={action:'idle',elapsed:0,idleTime:0},reactUntil=0,toastTimer: ReturnType<typeof setTimeout>;
let currentFrame: Frame;
function element<K extends keyof HTMLElementTagNameMap>(tag: K,text?: string,className?: string) {const el=document.createElement(tag);if(text)el.textContent=text;if(className)el.className=className;return el;}
function toast(message: string,error=false) {
  const box=document.querySelector<HTMLElement>('#toast');if(!box)return;box.textContent=message;box.classList.toggle('error',error);box.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>box.classList.remove('show'),5500);
}
async function command(c: Command) {
  try { if(api)await api.command(c);else {
    if(c.type==='select'){const t=boot.templates.find(t=>t.manifest.id===c.id);if(t)await load(t);boot.settings.templateId=c.id;renderCards();}
    if(c.type==='size')boot.settings.size=c.size;
    if(c.type==='walk')boot.settings.walking=c.enabled;
    if(c.type==='import')toast('ZIP 导入请在 Windows 桌面程序中使用');
    if(c.type==='bottom'||c.type==='hide')toast('移动与隐藏属于 Windows 桌面功能');
  }}catch(error){toast(String(error),true);}
}
async function load(template: Template) {
  if(loading){api?.selectResult(template.manifest.id,false,'另一个模型正在加载');return;}
  loading=true;document.body.classList.add('loading');
  try {
    if(await actor.load(template)){
      selected=template;behavior={action:'idle',elapsed:0,idleTime:0};reactUntil=0;
      document.body.dataset.template=template.manifest.id;
      if(!panelMode)api?.selectResult(template.manifest.id,true);
      const status=document.querySelector<HTMLElement>('#model-status');if(status)status.textContent=template.manifest.draft?'动作调试版 · 尚未完成验收':'三维角色已就绪';
      const name=document.querySelector<HTMLElement>('#actor-name');if(name)name.textContent=template.manifest.name;
      renderCards();
    }
  }catch(error){if(!panelMode)api?.selectResult(template.manifest.id,false,String(error));toast(`模型加载失败：${String(error)}`,true);}
  finally {loading=false;document.body.classList.remove('loading');}
}
function renderCards() {
  const list=document.querySelector<HTMLElement>('#characters');if(!list)return;list.replaceChildren();
  for(const t of boot.templates){
    const card=element('button',undefined,'character-card');card.type='button';card.dataset.id=t.manifest.id;card.setAttribute('aria-label',`切换到${t.manifest.name}`);
    const chosen=t.manifest.id===boot.settings.templateId;card.classList.toggle('selected',chosen);card.setAttribute('aria-pressed',String(chosen));
    const image=element('img');image.src=t.previewUrl;image.alt='';image.className='character-icon';
    const text=element('span',undefined,'card-text');text.append(element('strong',t.manifest.name),element('small',t.manifest.draft?'动作调试版 · 可预览互动':t.source==='builtin'?'内置角色':'已导入模板'));
    card.append(image,text,element('span',chosen?'✓':'↗','card-check'));card.onclick=()=>{void command({type:'select',id:t.manifest.id});};list.append(card);
  }
}
function setupPanel() {
  document.body.classList.add('panel');
  app.innerHTML=`<header class="topbar"><div class="brand-mark">✦</div><div class="brand">毛毡伙伴<small>FELT COMPANIONS</small></div><span class="local-badge"><i></i>${api?'本地运行':'浏览器预览'}</span></header>
  <section class="heading"><div><p class="eyebrow">A LITTLE COMPANY, EVERY DAY</p><h1>桌面上的，小小陪伴。</h1><p class="subheading">选一位伙伴，让平常的日子多一点生动。</p></div><button id="import" class="secondary">＋ 导入角色</button></section>
  <div class="workspace"><section class="stage-card"><div class="stage-label"><span>角色预览</span><span class="pill">3D</span></div><div id="stage"></div><div class="ground-shadow"></div><div class="stage-caption"><h2 id="actor-name">正在迎接伙伴…</h2><p id="model-status">加载三维模型</p></div><div class="views"><button data-angle="0" class="active">正面</button><button data-angle="90">侧面</button><button data-angle="180">背面</button></div><div class="preview-actions"><button data-action="idle" class="active">待机</button><button data-action="walk">散步</button><button data-action="react">打招呼</button><button data-action="drag">拖起</button><button data-action="rest">休息</button></div></section>
  <aside><div class="section-title"><h2>我的伙伴</h2><span>一次一位，随时切换</span></div><div id="characters"></div><section class="settings-card"><div class="setting-label"><label for="size">伙伴大小</label><output id="size-output">260</output></div><input id="size" type="range" min="180" max="380" step="10"/><div class="range-labels"><span>小巧</span><span>醒目</span></div><div class="divider"></div><label class="toggle-row" for="walking"><span><strong>底部自由散步</strong><small>拖到别处后会原地陪伴</small></span><input id="walking" type="checkbox" role="switch"/></label><button id="bottom" class="text-button">↘ 回到屏幕底部</button></section><div class="help-card"><span>✧</span><p>把鼠标轻轻移近，伙伴会转头看你。<br>点一下打招呼，按住就能搬动它。<br>双击伙伴，直接在身旁聊聊天。</p></div></aside></div>
  <footer><span>模型可替换，陪伴一直在。</span><button id="hide">暂时隐藏桌宠</button></footer><div id="toast" role="status" aria-live="polite"></div>`;
  actor=new Actor(document.querySelector<HTMLElement>('#stage')!);
  document.querySelector('#import')!.addEventListener('click',()=>{void command({type:'import'});});
  const size=document.querySelector<HTMLInputElement>('#size')!;size.value=String(boot.settings.size);
  document.querySelector('#size-output')!.textContent=String(boot.settings.size);
  size.oninput=()=>{document.querySelector('#size-output')!.textContent=size.value;};size.onchange=()=>{void command({type:'size',size:Number(size.value)});};
  const walking=document.querySelector<HTMLInputElement>('#walking')!;walking.checked=boot.settings.walking;walking.onchange=()=>{void command({type:'walk',enabled:walking.checked});};
  document.querySelector('#bottom')!.addEventListener('click',()=>{void command({type:'bottom'});});
  document.querySelector('#hide')!.addEventListener('click',()=>{void command({type:'hide'});});
  document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button=>button.onclick=()=>{previewAction=button.dataset.action as typeof previewAction;actor.play(previewAction,true);if(previewAction==='react')reactUntil=performance.now()+actor.duration('react')*1000;document.querySelectorAll('[data-action]').forEach(b=>b.classList.toggle('active',b===button));});
  document.querySelectorAll<HTMLButtonElement>('[data-angle]').forEach(button=>button.onclick=()=>{previewRotation=Number(button.dataset.angle)*Math.PI/180;document.querySelectorAll('[data-angle]').forEach(b=>b.classList.toggle('active',b===button));});
  actor.container.addEventListener('pointermove',e=>{const r=actor.container.getBoundingClientRect();localCursor={x:e.clientX-r.left,y:e.clientY-r.top};});
  actor.container.addEventListener('pointerleave',()=>{localCursor={x:-1000,y:-1000};});
  actor.container.addEventListener('click',()=>{actor.play('react',true);previewAction='react';reactUntil=performance.now()+actor.duration('react')*1000;});
}
function setupPet() {
  document.body.classList.add('pet');app.innerHTML='<div id="stage"></div><div id="toast" role="status"></div>';
  actor=new Actor(document.querySelector<HTMLElement>('#stage')!,true);
  let reportedHit: boolean|undefined,reportedHead={x:-1000,y:-1000},reportedCrown={x:-1000,y:-1000};
  const reportHit=(x: number,y: number)=>{
    const hit=actor.hits(x,y),head=actor.headPoint(),crown=actor.bubblePoint();
    if(hit!==reportedHit||Math.hypot(head.x-reportedHead.x,head.y-reportedHead.y)>.5||Math.hypot(crown.x-reportedCrown.x,crown.y-reportedCrown.y)>.5){api!.hit(hit,head,crown);reportedHit=hit;reportedHead=head;reportedCrown=crown;}
  };
  actor.container.addEventListener('pointerdown',e=>{
    if(e.button!==0)return;
    if(actor.hits(e.clientX,e.clientY)){api!.hit(true,actor.headPoint(),actor.bubblePoint());api!.pointer('down');actor.container.setPointerCapture(e.pointerId);e.preventDefault();}
  });
  actor.container.addEventListener('pointerup',e=>{if(e.button===0){api!.pointer('up');if(actor.container.hasPointerCapture(e.pointerId))actor.container.releasePointerCapture(e.pointerId);}});
  actor.container.addEventListener('pointercancel',()=>api!.pointer('cancel'));
  actor.container.addEventListener('lostpointercapture',()=>api!.pointer('cancel'));
  actor.container.addEventListener('contextmenu',e=>{e.preventDefault();api!.menu();});
  actor.container.addEventListener('pointermove',e=>{reportHit(e.clientX,e.clientY);});
  api!.onFrame(f=>{currentFrame=f;reportHit(f.cursor.x-f.bounds.x,f.cursor.y-f.bounds.y);});
  api!.onSelect(t=>{void load(t);});
}
async function refresh() {
  if(!api)return;boot=await api.bootstrap();currentFrame=boot.frame;
  const t=boot.templates.find(t=>t.manifest.id===boot.settings.templateId);
  if(panelMode&&t&&t.manifest.id!==selected?.manifest.id)await load(t);
  if(panelMode){renderCards();const range=document.querySelector<HTMLInputElement>('#size')!,walking=document.querySelector<HTMLInputElement>('#walking')!;range.value=String(boot.settings.size);document.querySelector('#size-output')!.textContent=range.value;walking.checked=boot.settings.walking;}
}
function animate(time: number) {
  raf=requestAnimationFrame(animate);
  if(document.hidden||(panelMode&&document.querySelector<HTMLElement>('#partner-page')?.hidden)||(!panelMode&&!currentFrame.visible)){last=time;return;}
  const interval=1000/30,elapsed=time-lastDraw;
  if(elapsed<interval)return;lastDraw=time-(elapsed%interval);
  const dt=Math.min((time-last)/1000,0.1);last=time;
  const hp=actor.headPoint();let yaw=0,pitch=0,rotation=0;
  if(panelMode){
    rotation=previewRotation;
    if(previewAction==='react'&&time>reactUntil){previewAction='idle';actor.play('idle');}
    if(localCursor.x>-500&&previewAction==='idle'&&rotation===0){yaw=(localCursor.x-hp.x)*.14;pitch=(localCursor.y-hp.y)*.10;}
  }else{
    const f=currentFrame;
    const reacting=time<reactUntil;
    behavior=stepBehavior(behavior,{dragging:f.dragging,reacting,attention:f.attention,walking:f.walking},dt,key=>actor.duration(key));
    actor.play(behavior.action);
    rotation=f.walking?f.direction*Math.PI/2:0;
    if(f.attention&&!f.dragging&&!reacting&&!['restIn','rest','restOut'].includes(behavior.action)){
      yaw=(f.cursor.x-f.bounds.x-hp.x)*.14;pitch=(f.cursor.y-f.bounds.y-hp.y)*.10;
    }
  }
  actor.update(dt,yaw,pitch,rotation);actor.render();
}
async function start() {
  if(new URLSearchParams(location.search).has('pet-chat')){await mountPetChat(app);return;}
  if(new URLSearchParams(location.search).has('bubble')){await mountBubble(app);return;}
  if(api)boot=await api.bootstrap();else{
    const templates=await Promise.all(['felt-beagle','felt-rabbit'].map(async id=>({manifest:parseManifest(await (await fetch(`./templates/${id}/pet.json`)).json()),url:`./templates/${id}/model.glb`,previewUrl:`./templates/${id}/preview.png`,source:'builtin' as const})));
    boot={templates,settings:{...DEFAULT_SETTINGS},frame:{cursor:{x:-1000,y:-1000},bounds:{x:0,y:0,width:430,height:312},walking:false,dragging:false,attention:false,direction:1,visible:true}};
  }
  currentFrame=boot.frame;
  panelMode?setupPanel():setupPet();
  if(panelMode)await mountPlanner(app);
  api?.onEvent(event=>{
    if(event.type==='react'){reactUntil=performance.now()+actor.duration('react')*1000;actor.play('react',true);behavior={action:'react',elapsed:0,idleTime:0};}
    if(['settings','templates','visibility'].includes(event.type))void refresh();
    if(event.message)toast(event.message,event.type==='error');
  });
  const t=boot.templates.find(t=>t.manifest.id===boot.settings.templateId)??boot.templates[0];await load(t);
  raf=requestAnimationFrame(animate);
  window.addEventListener('pagehide',()=>{cancelAnimationFrame(raf);actor.dispose();});
}
void start().catch(error=>{app.replaceChildren(element('p',`启动失败：${String(error)}`,'fatal'));console.error(error);});
