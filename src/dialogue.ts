import type {Category, PlannerData, Quote} from './planner';
export const ROLES:Record<string,string>=Object.assign(Object.create(null),{'felt-beagle':'比格·烧冬瓜','felt-rabbit':'垂耳兔·陈慎',generic:'伙伴'});
export const SCENES:Record<string,string>={click:'轻触招呼',drag:'鼠标拖拽',focusClick:'专注中点击',idle:'闲时陪伴',easter:'彩蛋',advance:'提前提醒',due:'到点提醒',snooze:'稍后提醒',complete:'任务完成',focusStart:'专注开始',focusEnd:'专注结束',breakEnd:'休息结束'};
const beagle:Record<string,string[]>={
 click:['嗨！你总算理我啦？','哟～叫我干嘛？有好吃的吗？','在呢在呢！别戳了别戳了','哎！我看见你啦～'],
 drag:['耶——江湖人会飞！','呼呼——比我追着糖人摊跑还快！','轻功走起！陈慎你追不上我吧哈哈！','诶诶，吓我一跳'],
 focusClick:['还学呢？比江叔盯我练功还拼啊。','歇会儿呗～我藏了寒姨的蜜饯，分你一块。','看什么呢？我帮你瞅？……哦这字我认得！','累了就歇一会儿，走啊出去跑两圈。'],
 idle:['走！街口糖人摊出新花样了。','我教你耍剑啊！保证一学就废。','陈慎抱着医书能坐一下午，木头似的。','要不要打赌？我能爬去屋顶掏鸟窝，你信不信？'],
 easter:['嘘——陈慎在找他的银针包，嘿嘿。','今早江叔夸我剑练得好！……我就少练了半趟。'],
 advance:['哎，{时间}该“{任务}”啦，先收拾收拾？','我帮你记着呢：“{任务}”，别临时手忙脚乱。','再过{分钟}分钟就是“{任务}”，准备好没？','先提个醒，待会儿还有“{任务}”呢！'],
 due:['到点啦！该“{任务}”了，我陪你。','哎哎，“{任务}”！这回可别忘啦。','“{任务}”的时辰到了，忙完咱们歇会儿。','走起！先把“{任务}”办了，心里就踏实啦。'],
 snooze:['好，就再缓{分钟}分钟。我帮你记着。','行，{时间}再喊你。可别把我也哄忘啦。','那就等到{时间}，说好了啊。','收到！“{任务}”先放一会儿，我盯着时辰。'],
 complete:['可以啊！“{任务}”这就做完了？奖励一颗蜜饯！','辛苦啦！换我坐这么久，早想上街跑八圈了。','不错嘛，收尾了！这下能踏实歇会儿啦。','成啦！我就知道你能行。'],
 focusStart:['开工开工！这{分钟}分钟我陪着你。','我都坐好了，你也加油！先忙“{任务}”。','我不闹你，专心做，时间我记着。','先专注一阵，忙完再惦记糖人！'],
 focusEnd:['这一轮做完啦！起来活动活动？','辛苦辛苦，先歇一会儿，蜜饯分你一颗。','可以啊，又认认真真坐完一轮！','时间到！让眼睛也偷个懒吧。'],
 breakEnd:['歇够这一轮啦。准备好了，咱们再出发！','回来啦？下一轮你说开始，我就记时。','喝口水，慢慢收心，我等你。','先把东西理好，再忙下一阵。']
};
const rabbit:Record<string,string[]>={
 click:['嗯。','何事。','在。','说。'],drag:['别闹。','诶，怎么跟大黄一样毛手毛脚的。','你要带我去哪？','被你抓住……是失误。'],
 focusClick:['专心。','累了便歇半刻。','莫分神。','喝口水。'],
 idle:['闲了？便把功课温一温。','大黄刚偷溜出去了，你莫跟他疯。','坐端正。肩颈放松些。','无事？我整理药囊，你自便。'],
 easter:['方才大黄爬树摔下来了。没敢说。','师傅的蜜饯，分你一颗。别让大黄看见。'],
 advance:['{时间}，“{任务}”。记得留出时间。','“{任务}”还有{分钟}分钟。不必赶。','先提醒你。待会儿该“{任务}”了。','手边的事收一收，“{任务}”快到了。'],
 due:['到时辰了。“{任务}”。','该“{任务}”了。慢慢来。','先做“{任务}”。我在。','“{任务}”，别遗漏了。'],
 snooze:['好。{时间}再提醒你。','再缓{分钟}分钟。记下了。','“{任务}”挪到{时间}。','不急。先处理手边的事。'],
 complete:['“{任务}”做完了。不错。','辛苦了。歇着吧。','收尾得很稳。','忙完就好。喝口水。'],
 focusStart:['这{分钟}分钟，专心。','“{任务}”，从眼前这一点开始。','我陪着。慢慢做。','收心。不必一口气做完所有事。'],
 focusEnd:['这一轮结束了。歇会儿。','做得不错。起来走两步。','辛苦了。眼睛也该歇一歇。','先停手。下一轮不急。'],
 breakEnd:['休息时间到了。准备好了再继续。','该收心了。我等你开始。','慢慢来。下一轮由你决定。','歇好了，便接着做。']
};
const categoryLines:Record<string,Partial<Record<Category,string[]>>>={
 'felt-beagle':{'学习':['该看书啦！我背剑诀都能坐睡着，你可别学我。','先把“{任务}”做完，等你忙完再惦记杂耍！'],'工作':['开工啦！“{任务}”可别漏了，我可不想看你着急。','先忙“{任务}”，忙完咱们再偷个闲。'],'吃饭':['到饭点啦！寒姨的冬瓜汤我都惦记上了。你也去吃点！','干饭不积极怎么行！先吃饭，吃完再说。'],'休息':['歇会儿歇会儿！起来活动两步，别一直坐着。','喝点水？我去转一圈，你也松快松快。'],'睡前':['到你定的休息时间啦，洗漱睡觉去。','晚安晚安！剩下的事，明天再慢慢来。']},
 'felt-rabbit':{'学习':['该“{任务}”了。静下心来。','先读眼前这一页。不急。'],'工作':['“{任务}”。按次序来。','先做手边这一件。莫分神。'],'吃饭':['到饭点了。先停手。','先吃饭。手头事待会儿再做。'],'休息':['歇会儿。起来走两步。','喝口水。让眼睛歇一歇。'],'睡前':['到你定的休息时间了。歇着吧。','该洗漱了。明日再说。']}
};
export const DEFAULT_QUOTES:Quote[]=[];
for(const [role,scenes] of Object.entries({'felt-beagle':beagle,'felt-rabbit':rabbit}))for(const [scene,lines] of Object.entries(scenes))lines.forEach((text,i)=>DEFAULT_QUOTES.push({id:`${role}.${scene}.${i}`,role,scene,category:'通用',text,enabled:true}));
for(const [role,categories] of Object.entries(categoryLines))for(const [category,lines] of Object.entries(categories))lines!.forEach((text,i)=>DEFAULT_QUOTES.push({id:`${role}.due.${category}.${i}`,role,scene:'due',category,text,enabled:true}));
for(const [scene,text] of Object.entries({click:'我在，陪着你。',drag:'要换个地方吗？我跟着你。',focusClick:'专心，我在这里。',idle:'愿今天顺顺利利。',easter:'歇一会儿也很好。',advance:'{时间}有“{任务}”，记得准备。',due:'该“{任务}”了。',snooze:'已延后到{时间}。',complete:'“{任务}”已完成，辛苦了。',focusStart:'开始专注{分钟}分钟。',focusEnd:'本轮专注结束，休息一下。',breakEnd:'休息结束，准备好了再继续。'}))DEFAULT_QUOTES.push({id:`generic.${scene}`,role:'generic',scene,category:'通用',text,enabled:true});
export function allQuotes(data:Pick<PlannerData,'quotes'>){const map=new Map(DEFAULT_QUOTES.map(q=>[q.id,{...q}]));for(const q of data.quotes)map.set(q.id,{...q});return [...map.values()].filter(q=>q.scene!=='rapid'&&!q.deleted);}
export function validateQuote(q:any,allowLegacy=false):Quote{if(!q||q.deleted!==undefined&&(typeof q.deleted!=='boolean'||q.deleted&&q.enabled)||typeof q.id!=='string'||q.id.length>100||!ROLES[q.role]||!(Object.hasOwn(SCENES,q.scene)||allowLegacy===true&&q.scene==='rapid')||!['通用','学习','工作','吃饭','休息','睡前'].includes(q.category)||typeof q.enabled!=='boolean'||typeof q.text!=='string'||!q.text.trim()||q.text.length>180||/[\u0000-\u001f]/.test(q.text))throw Error('语录需为 1～180 字的单段文字，角色与场景必须有效');const remaining=q.text.replace(/\{(任务|时间|分钟)\}/g,'');if(/[{}]/.test(remaining))throw Error('只支持 {任务}、{时间}、{分钟} 占位符');return {id:q.id,role:q.role,scene:q.scene,category:q.category,text:q.text.trim(),enabled:q.enabled,...(q.deleted!==undefined?{deleted:q.deleted}:{})};}
export function deleteQuote(data:Pick<PlannerData,'quotes'>,id:unknown){
  const quote=typeof id==='string'?allQuotes(data).find(q=>q.id===id):undefined;
  if(!quote)throw Error('语录不存在，请刷新后重试');
  data.quotes=data.quotes.filter(q=>q.id!==id);
  if(DEFAULT_QUOTES.some(q=>q.id===id))data.quotes.push({...quote,enabled:false,deleted:true});
}
export class Dialogue {
  private lastText=new Map<string,string>();
  constructor(private random=()=>Math.random()){}
  clickScene(_now:number,focused:boolean){if(focused)return 'focusClick';return this.random()<.05?'easter':'click';}
  pick(data:Pick<PlannerData,'quotes'>,role:string,scene:string,category='通用',values:Record<string,string>={}){if(!ROLES[role])role='generic';const all=allQuotes(data).filter(q=>q.enabled&&q.role===role&&q.scene===scene);let candidates=all.filter(q=>q.category===category);if(!candidates.length)candidates=all.filter(q=>q.category==='通用');if(!candidates.length)return '';
    // Excluding three recent lines from a four-line scene forces a fixed cycle.
    // Draw afresh each time; only exclude the last text in this role and scene.
    const key=`${role}:${scene}`;let available=candidates.filter(q=>q.text!==this.lastText.get(key));if(!available.length)available=candidates;const selected=available[Math.floor(this.random()*available.length)];this.lastText.set(key,selected.text);return selected.text.replace(/\{(任务|时间|分钟)\}/g,(_,key)=>values[key]||({'任务':'手边的事','时间':'约定时间','分钟':'几'} as Record<string,string>)[key]);
  }
}
