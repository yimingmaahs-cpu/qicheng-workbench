export const CATEGORIES = ['通用','学习','工作','吃饭','休息','睡前'] as const;
export type Category = typeof CATEGORIES[number];
export type Repeat = 'once'|'daily'|'weekdays'|'weekly'|'monthly';
export type Task = {id:string; title:string; notes:string; category:Category; date:string; time:string; repeat:Repeat; weekdays:number[]; end:string; advance:number; enabled:boolean; archived:boolean; cursor:string; important?:boolean};
export type Occurrence = {id:string; taskId:string; title:string; notes:string; category:Category; date:string; time:string; repeat:Repeat; advance:number; status:'pending'|'done'|'skipped'|'cancelled'; handledAt?:number; snoozeAt?:number; receipts:string[]; important?:boolean; end?:string};
export type Notice = {id:string; ids:string[]; kind:'due'|'advance'|'snooze'|'focusEnd'|'breakEnd'; createdAt:number; delivery:'pending'|'offered'|'failed'; read:boolean; error?:string};
export type Focus = {phase:'focus'|'short'|'long'; status:'ready'|'running'|'paused'; remainingMs:number; activeMs:number; occurrenceId:string; startedAt:number};
export type FocusRecord = {id:string; startedAt:number; endedAt:number; activeMs:number; completed:boolean; occurrenceId:string};
export type Preferences = {clicks:boolean; chatter:'off'|'quiet'|'normal'|'active'; sound:boolean; dnd:boolean; quietEnabled:boolean; quietStart:string; quietEnd:string; focusMinutes:number; shortMinutes:number; longMinutes:number; bubbleSeconds:number; reminderSeconds:number; login:boolean};
export type Quote = {id:string; role:string; scene:string; category:string; text:string; enabled:boolean; deleted?:boolean};
export type PlannerData = {version:1; tasks:Task[]; occurrences:Occurrence[]; notices:Notice[]; focus:Focus; focusRecords:FocusRecord[]; completedRounds:number; dailyMs:Record<string,number>; preferences:Preferences; quotes:Quote[]; updatedAt:number};
export type PlannerCommand = {type:string; [key:string]:unknown};
export type PlannerSnapshot = PlannerData & {warning?:string};
export type BubbleMessage = {id:string; role:string; name:string; text:string; ids:string[]; noticeIds:string[]; kind:string; duration:number; repeat:boolean; sound?:boolean; maxWidth?:number; streaming?:boolean; status?:string; conversation?:string};
export interface CompanionAPI {read():Promise<PlannerSnapshot>; command(command:PlannerCommand):Promise<PlannerSnapshot>; onChange(callback:()=>void):()=>void; onNavigate(callback:(tab:string)=>void):()=>void; bubble():Promise<BubbleMessage|null>; onBubble(callback:(message:BubbleMessage|null)=>void):()=>void; bubbleInput(data:{type:string; id?:string; value?:unknown}):void;}
export const DEFAULT_PREFERENCES:Preferences={clicks:true,chatter:'normal',sound:false,dnd:false,quietEnabled:false,quietStart:'23:00',quietEnd:'07:00',focusMinutes:25,shortMinutes:5,longMinutes:15,bubbleSeconds:10,reminderSeconds:20,login:false};
export function emptyPlanner(now=Date.now()):PlannerData{return {version:1,tasks:[],occurrences:[],notices:[],focus:{phase:'focus',status:'ready',remainingMs:25*60000,activeMs:0,occurrenceId:'',startedAt:0},focusRecords:[],completedRounds:0,dailyMs:{},preferences:{...DEFAULT_PREFERENCES},quotes:[],updatedAt:now};}
export const localDate=(date=new Date())=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
export const localTime=(date=new Date())=>`${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
export function validDate(value:unknown):value is string {if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const d=new Date(`${value}T12:00:00`);return Number.isFinite(d.getTime())&&localDate(d)===value&&d.getFullYear()>=1900&&d.getFullYear()<=2199;}
export const validTime=(v:unknown):v is string=>typeof v==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(v);
export function addDays(date:string,n:number){const d=new Date(`${date}T12:00:00`);d.setDate(d.getDate()+n);return localDate(d);}
export const dueAt=(o:Pick<Occurrence,'date'|'time'>)=>new Date(`${o.date}T${o.time||'23:59'}:00`).getTime();
export function isQuiet(p:Preferences,now:number){if(p.dnd)return true;if(!p.quietEnabled)return false;const t=localTime(new Date(now));return p.quietStart<p.quietEnd?t>=p.quietStart&&t<p.quietEnd:t>=p.quietStart||t<p.quietEnd;}
function text(v:unknown,max:number,required=false){if(typeof v!=='string'||v.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)||(required&&!v.trim()))throw Error(`请输入${required?'非空、':''}${max}字以内的文字`);return v.trim();}
export function parseTask(v:any,id:string):Task {
  if(!v||!validDate(v.date)||!(v.time===''||validTime(v.time))||!['once','daily','weekdays','weekly','monthly'].includes(v.repeat)||!CATEGORIES.includes(v.category)||typeof v.enabled!=='boolean')throw Error('任务日期、时间、类别或重复规则无效');
  if(v.important!==undefined&&typeof v.important!=='boolean')throw Error('重要事件标记无效');
  if(v.end!==''&&(!validDate(v.end)||v.end<v.date))throw Error('结束日期不能早于开始日期');
  if(![0,5,10,15,30,60].includes(v.advance))throw Error('提前提醒时间无效');
  if(!Array.isArray(v.weekdays)||v.weekdays.some((n:unknown)=>!Number.isInteger(n)||Number(n)<0||Number(n)>6)||(v.repeat==='weekly'&&!v.weekdays.length))throw Error('请选择重复星期');
  return {id,important:v.important??false,title:text(v.title,100,true),notes:text(v.notes,2000),category:v.category,date:v.date,time:v.time,repeat:v.repeat,weekdays:[...new Set<number>(v.weekdays)].sort(),end:v.end,advance:v.time?v.advance:0,enabled:v.enabled,archived:false,cursor:addDays(v.date,-1)};
}
export function occurs(task:Task,date:string){if(date<task.date||(task.end&&date>task.end))return false;const d=new Date(`${date}T12:00:00`),weekday=d.getDay();switch(task.repeat){case 'once':return date===task.date;case 'daily':return true;case 'weekdays':return weekday>0&&weekday<6;case 'weekly':return task.weekdays.includes(weekday);case 'monthly':return date.slice(8)===task.date.slice(8);}}
export function materialize(data:PlannerData,through:string){through=through>'2199-12-31'?'2199-12-31':through;const known=new Set(data.occurrences.map(o=>o.id));for(const task of data.tasks){if(!task.enabled||task.archived)continue;let end=task.end&&task.end<through?task.end:through;if(task.repeat==='once'&&task.date<end)end=task.date;for(let date=addDays(task.cursor,1);date<=end;date=addDays(date,1)){if(occurs(task,date)){const id=`${task.id}:${date}`;if(!known.has(id)){data.occurrences.push({id,taskId:task.id,title:task.title,notes:task.notes,category:task.category,date,time:task.time,repeat:task.repeat,advance:task.advance,important:task.important??false,end:task.repeat==='once'?task.end:'',status:'pending',receipts:[]});known.add(id);}}}if(end>task.cursor)task.cursor=end;}}
export function collectReminders(data:PlannerData,now:number,id:()=>string){materialize(data,addDays(localDate(new Date(now)),60));const groups=new Map<Notice['kind'],string[]>();for(const o of data.occurrences){if(o.status!=='pending'||!o.time||!data.tasks.some(t=>t.id===o.taskId&&t.enabled&&!t.archived))continue;const due=dueAt(o);let stage:string|undefined,kind:Notice['kind']='due';if(o.snoozeAt!==undefined){stage=`snooze:${o.snoozeAt}`;kind='snooze';if(now<o.snoozeAt)continue;}else if(now>=due){stage='due';}else if(o.advance&&now>=due-o.advance*60000){stage='advance';kind='advance';}if(!stage||o.receipts.includes(stage))continue;o.receipts.push(stage);const list=groups.get(kind)||[];list.push(o.id);groups.set(kind,list);}
  for(const [kind,ids] of groups)data.notices.push({id:id(),ids,kind,createdAt:now,delivery:'pending',read:false});
  // An advance notice no longer applies once its scheduled time has passed.
  for(const n of data.notices)if(n.kind==='advance'&&n.delivery==='pending'){n.ids=n.ids.filter(id=>{const o=data.occurrences.find(o=>o.id===id);return o&&dueAt(o)>now&&o.snoozeAt===undefined;});if(!n.ids.length)n.read=true;}
}
export function activeNoticeIds(data:PlannerData,n:Notice){return n.ids.filter(id=>data.occurrences.some(o=>o.id===id&&o.status==='pending'&&data.tasks.some(t=>t.id===o.taskId&&t.enabled&&!t.archived)));}
export function invalidateNotices(data:PlannerData,id:string){for(const n of data.notices)if(n.ids.includes(id)){n.ids=n.ids.filter(x=>x!==id);if(!n.ids.length)n.read=true;}}
export function tickFocus(data:PlannerData,delta:number,now:number,id:()=>string){const f=data.focus;if(f.status!=='running')return;if(!Number.isFinite(delta)||delta<0||!Number.isFinite(now))throw Error('计时时间无效');const elapsed=Math.min(delta,f.remainingMs),end=now-delta+elapsed;f.remainingMs-=elapsed;f.activeMs+=elapsed;if(f.phase==='focus'){let cursor=end-elapsed;while(cursor<end){const day=localDate(new Date(cursor)),midnight=new Date(cursor);midnight.setHours(24,0,0,0);const next=Math.min(end,midnight.getTime());data.dailyMs[day]=(data.dailyMs[day]||0)+next-cursor;cursor=next;}}if(f.remainingMs<=0){const isFocus=f.phase==='focus';if(isFocus){data.completedRounds++;data.focusRecords.push({id:id(),startedAt:f.startedAt,endedAt:end,activeMs:f.activeMs,completed:true,occurrenceId:f.occurrenceId});}data.notices.push({id:id(),ids:[],kind:isFocus?'focusEnd':'breakEnd',createdAt:now,delivery:'pending',read:false});const phase=isFocus?(data.completedRounds%4===0?'long':'short'):'focus';data.focus={phase,status:'ready',remainingMs:(phase==='focus'?data.preferences.focusMinutes:phase==='short'?data.preferences.shortMinutes:data.preferences.longMinutes)*60000,activeMs:0,occurrenceId:data.occurrences.some(o=>o.id===f.occurrenceId&&o.status==='pending')?f.occurrenceId:'',startedAt:0};}}
export function applyPlannerCommand(data:PlannerData,c:PlannerCommand,now:number,id:()=>string){switch(c.type){
  case 'tasks.quick':{if(!Array.isArray(c.titles)||!c.titles.length||c.titles.length>20||!validDate(c.date)||typeof c.important!=='boolean')throw Error('每次可添加 1～20 项清单');const tasks=c.titles.map(title=>parseTask({title,notes:'',category:'通用',date:c.date,time:'',repeat:'once',weekdays:[],end:'',advance:0,enabled:true,important:c.important},id()));data.tasks.push(...tasks);materialize(data,addDays(c.date,60));break;}
  case 'task.save': {
    const old=typeof c.id==='string'?data.tasks.find(t=>t.id===c.id&&!t.archived):undefined;
    if(c.id&&!old)throw Error('任务不存在');
    const previousIds=new Set(data.occurrences.map(o=>o.id)),task=parseTask(c.task,old?.id||id());
    const editSingle=old?.repeat==='once'&&task.repeat==='once';
    if(old){
      if(editSingle&&old.date===task.date&&old.time===task.time&&old.advance===task.advance){task.cursor=old.cursor;data.tasks[data.tasks.indexOf(old)]=task;for(const o of data.occurrences)if(o.taskId===old.id&&o.status==='pending')Object.assign(o,{title:task.title,notes:task.notes,category:task.category,important:task.important,end:task.end});materialize(data,addDays(localDate(new Date(now)),60));break;}
      if(!editSingle)task.cursor=addDays(localDate(new Date(now)),-1);
      const removable=new Set(data.occurrences.filter(o=>o.taskId===old.id&&o.status==='pending'&&(editSingle||(!(data.focus.status!=='ready'&&data.focus.occurrenceId===o.id)&&(o.time?dueAt(o)>now:o.date>localDate(new Date(now)))&&!o.receipts.length&&o.snoozeAt===undefined))).map(o=>o.id));
      for(const oid of removable)invalidateNotices(data,oid);
      if(editSingle&&removable.has(data.focus.occurrenceId))data.focus.occurrenceId=task.id+':'+task.date;
      data.occurrences=data.occurrences.filter(o=>!removable.has(o.id));
      data.tasks[data.tasks.indexOf(old)]=task;
    }else data.tasks.push(task);
    materialize(data,addDays(localDate(new Date(now)),60));
    if(old&&!editSingle)data.occurrences=data.occurrences.filter(o=>o.taskId!==old.id||previousIds.has(o.id)||dueAt(o)>now);
    break;
  }
  case 'task.delete':{const t=data.tasks.find(t=>t.id===c.id);if(!t)throw Error('任务不存在');t.archived=true;for(const o of data.occurrences)if(o.taskId===t.id&&o.status==='pending'){o.status='cancelled';o.handledAt=now;invalidateNotices(data,o.id);}break;}
  case 'occurrences.delete':{
    if(!Array.isArray(c.ids)||!c.ids.length||c.ids.some(id=>typeof id!=='string'))throw Error('请选择要删除的计划');
    const ids=new Set<string>(c.ids),items=data.occurrences.filter(o=>ids.has(o.id));
    if(items.length!==ids.size)throw Error('部分计划已不存在，请刷新后重试');
    // Keep a cancelled record without handledAt as a tombstone. Existing versions
    // already hide it from day/history lists, and recurrence edits cannot recreate it.
    for(const o of items){o.status='cancelled';delete o.handledAt;delete o.snoozeAt;invalidateNotices(data,o.id);}
    for(const task of data.tasks)if(task.repeat==='once'&&ids.has(`${task.id}:${task.date}`))task.archived=true;
    if(ids.has(data.focus.occurrenceId))data.focus.occurrenceId='';
    break;
  }
  case 'task.remove':{
    const task=data.tasks.find(t=>t.id===c.id);if(!task)throw Error('任务不存在');
    const ids=new Set(data.occurrences.filter(o=>o.taskId===task.id).map(o=>o.id));
    for(const id of ids)invalidateNotices(data,id);
    data.occurrences=data.occurrences.filter(o=>!ids.has(o.id));data.tasks=data.tasks.filter(t=>t.id!==task.id);
    if(ids.has(data.focus.occurrenceId))data.focus.occurrenceId='';
    break;
  }
  case 'occurrence.handle':{const o=data.occurrences.find(o=>o.id===c.id);if(!o)throw Error('任务记录不存在');if(!['done','skipped','pending'].includes(String(c.status))||o.status==='cancelled')throw Error('任务状态无效');if(c.status===o.status)break;o.status=c.status as Occurrence['status'];if(o.status==='pending'){delete o.handledAt;}else{o.handledAt=now;delete o.snoozeAt;invalidateNotices(data,o.id);if(data.focus.status==='ready'&&data.focus.occurrenceId===o.id)data.focus.occurrenceId='';}break;}
  case 'occurrence.snooze':{const o=data.occurrences.find(o=>o.id===c.id);if(!o||o.status!=='pending'||!o.time)throw Error('该任务不能稍后提醒');if(typeof c.at!=='number'||!Number.isFinite(c.at)||c.at<=now)throw Error('请选择未来的提醒时间');o.snoozeAt=c.at;invalidateNotices(data,o.id);break;}
  case 'notices.read':{if(!Array.isArray(c.ids)||c.ids.some(x=>typeof x!=='string'))throw Error('提醒列表无效');for(const n of data.notices)if(c.ids.includes(n.id))n.read=true;break;}
  case 'focus.start':{const f=data.focus;if(f.status==='running'){if(c.occurrenceId!==undefined&&c.occurrenceId!==f.occurrenceId)throw Error('已有专注正在进行，请先结束当前专注再更换任务');break;}if(c.occurrenceId!==undefined){if(typeof c.occurrenceId!=='string'||(c.occurrenceId&&!data.occurrences.some(o=>o.id===c.occurrenceId&&(o.status==='pending'||f.status==='paused'&&f.occurrenceId===o.id))))throw Error('关联任务无效');if(f.status==='paused'&&c.occurrenceId!==f.occurrenceId)throw Error('请先结束当前专注再更换任务');f.occurrenceId=c.occurrenceId;}f.status='running';if(!f.startedAt)f.startedAt=now;break;}
  case 'focus.duration':{const f=data.focus,minutes=c.minutes;if(typeof minutes!=='number'||!Number.isInteger(minutes)||minutes<1||minutes>180)throw Error('时长需为 1～180 整数分钟');if(f.status==='running')throw Error('请先暂停，再修改本轮时长');if(minutes*60000<=f.activeMs)throw Error('本轮总时长需大于已投入时间');f.remainingMs=minutes*60000-f.activeMs;const key=f.phase==='focus'?'focusMinutes':f.phase==='short'?'shortMinutes':'longMinutes';data.preferences[key]=minutes;break;}
  case 'focus.pause':if(data.focus.status==='running')data.focus.status='paused';break;
  case 'focus.stop':{const f=data.focus;if(f.phase==='focus'&&f.activeMs>0)data.focusRecords.push({id:id(),startedAt:f.startedAt,endedAt:now,activeMs:f.activeMs,completed:false,occurrenceId:f.occurrenceId});data.focus={phase:'focus',status:'ready',remainingMs:data.preferences.focusMinutes*60000,activeMs:0,occurrenceId:'',startedAt:0};break;}
  case 'preferences.save':{const p=Object.assign({bubbleSeconds:DEFAULT_PREFERENCES.bubbleSeconds,reminderSeconds:DEFAULT_PREFERENCES.reminderSeconds},c.preferences) as Preferences;if(!p||['clicks','sound','dnd','quietEnabled','login'].some(k=>typeof p[k as keyof Preferences]!=='boolean')||!['off','quiet','normal','active'].includes(p.chatter)||!validTime(p.quietStart)||!validTime(p.quietEnd)||(p.quietEnabled&&p.quietStart===p.quietEnd)||[p.focusMinutes,p.shortMinutes,p.longMinutes].some(n=>!Number.isInteger(n)||n<1||n>180))throw Error('设置无效：时长需为 1～180 分钟，免打扰起止时间需不同');if([p.bubbleSeconds,p.reminderSeconds].some(n=>!Number.isInteger(n)||n<1||n>120))throw Error('气泡显示时长需为 1～120 整数秒');data.preferences={...p};if(data.focus.status==='ready'){const key=data.focus.phase==='focus'?'focusMinutes':data.focus.phase==='short'?'shortMinutes':'longMinutes';data.focus.remainingMs=p[key]*60000;}break;}
  case 'range':if(!validDate(c.through))throw Error('日期无效');materialize(data,c.through);break;
  default:throw Error('未知计划命令');
}data.updatedAt=now;}
export function validatePlanner(v:any):PlannerData {
  if(!v||v.version!==1||!Array.isArray(v.tasks)||!Array.isArray(v.occurrences)||!Array.isArray(v.notices)||!Array.isArray(v.quotes)||!Array.isArray(v.focusRecords)||!v.dailyMs)throw Error('陪伴数据格式或版本无效');
  const probe=emptyPlanner();applyPlannerCommand(probe,{type:'preferences.save',preferences:v.preferences},Date.now(),()=> 'validate');v.preferences=probe.preferences;
  const ids=new Set<string>();for(const t of v.tasks){if(typeof t.id!=='string'||ids.has(t.id)||!(validDate(t.cursor)||t.cursor==='1899-12-31'&&t.date==='1900-01-01')||typeof t.archived!=='boolean')throw Error('任务数据损坏');ids.add(t.id);parseTask(t,t.id);}
  const occurrences=new Set<string>();for(const o of v.occurrences){if(typeof o.id!=='string'||occurrences.has(o.id)||!ids.has(o.taskId)||!validDate(o.date)||!(o.time===''||validTime(o.time))||!CATEGORIES.includes(o.category)||!['once','daily','weekdays','weekly','monthly'].includes(o.repeat)||![0,5,10,15,30,60].includes(o.advance)||!['pending','done','skipped','cancelled'].includes(o.status)||!Array.isArray(o.receipts)||o.receipts.some((x:any)=>typeof x!=='string')||(o.snoozeAt!==undefined&&!Number.isFinite(o.snoozeAt))||(o.handledAt!==undefined&&!Number.isFinite(o.handledAt)))throw Error('任务发生记录损坏');if(o.important!==undefined&&typeof o.important!=='boolean'||o.end!==undefined&&o.end!==''&&(!validDate(o.end)||o.end<o.date))throw Error('计划标记或结束日期损坏');text(o.title,100,true);text(o.notes,2000);occurrences.add(o.id);}
  const notices=new Set<string>();for(const n of v.notices){if(typeof n.id!=='string'||notices.has(n.id)||!Array.isArray(n.ids)||n.ids.some((id:any)=>!occurrences.has(id))||!['due','advance','snooze','focusEnd','breakEnd'].includes(n.kind)||!['pending','offered','failed'].includes(n.delivery)||typeof n.read!=='boolean'||!Number.isFinite(n.createdAt))throw Error('提醒记录损坏');notices.add(n.id);}
  const f=v.focus;if(!f||!['focus','short','long'].includes(f.phase)||!['ready','running','paused'].includes(f.status)||typeof f.occurrenceId!=='string'||!Number.isFinite(f.startedAt)||!Number.isFinite(f.remainingMs)||f.remainingMs<0||!Number.isFinite(f.activeMs)||f.activeMs<0||!Number.isInteger(v.completedRounds)||v.completedRounds<0)throw Error('专注记录损坏');
  for(const r of v.focusRecords)if(typeof r.id!=='string'||typeof r.completed!=='boolean'||typeof r.occurrenceId!=='string'||![r.startedAt,r.endedAt,r.activeMs].every(Number.isFinite)||r.activeMs<0)throw Error('专注历史损坏');for(const [key,val] of Object.entries(v.dailyMs))if(!validDate(key)||typeof val!=='number'||!Number.isFinite(val)||val<0)throw Error('专注统计损坏');
  if(!Number.isFinite(v.updatedAt))throw Error('保存时间损坏');return v;
}

// A multi-day single plan is one occurrence, displayed on each included date.
export function onCalendarDay(o:Occurrence,date:string){return o.date<=date&&(o.end||o.date)>=date;}
export function monthDays(month:string){const first=month+'-01',weekday=new Date(first+'T12:00:00').getDay(),start=addDays(first,-((weekday+6)%7));return Array.from({length:42},(_,i)=>addDays(start,i));}
