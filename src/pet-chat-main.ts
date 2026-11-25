import {app,BrowserWindow,ipcMain,powerMonitor,screen} from 'electron';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AIBackend} from './ai-main';
import {AI_ROLES,bounded,validRole,type AIEvent,type AISnapshot} from './ai-types';
import {clampWindow} from './domain';
import type {PetChatCommand,PetChatEvent,PetChatSnapshot,PetChatReply} from './pet-chat-types';

type Hooks={pet:()=>BrowserWindow;role:()=>string;position:()=>{x:number;y:number;dragging:boolean};openPanel:(tab:string)=>Promise<void>;reply?:(reply:PetChatReply)=>void};
export class PetChat {
  window:BrowserWindow|null=null;
  private loading:Promise<void>|null=null;private wanted=false;private ready=false;private height=120;private role='';private version=0;private opening=0;private reading=0;private sending=false;private stopped=false;private ownReply:{request:string;role:string;conversation:string}|null=null;
  private conversations=new Map<string,string>();private state:PetChatSnapshot|null=null;private streamed:{request:string;text:string}|null=null;
  constructor(private ai:AIBackend,private hooks:Hooks){
    ipcMain.handle('pet-chat:command',(event,c:PetChatCommand)=>{if(event.senderFrame!==event.sender.mainFrame||event.sender!==this.window?.webContents)throw Error('此窗口无权操作桌面对话');return this.command(c);});
    powerMonitor.on('lock-screen',this.hide);powerMonitor.on('suspend',this.hide);
  }
  isOpen(){return this.wanted&&!this.stopped;}
  ownsReply(event:Extract<AIEvent,{type:'finished'}>){return !!this.ownReply&&event.request===this.ownReply.request&&this.ownReply.role===event.role&&this.ownReply.conversation===event.conversation;}
  private emit(event:PetChatEvent){if(this.ready&&this.window&&!this.window.isDestroyed())this.window.webContents.send('pet-chat:event',event);}
  private async create(){
    if(this.window&&!this.window.isDestroyed()){if(this.loading)await this.loading;return;}
    this.window=new BrowserWindow({width:380,height:240,transparent:true,frame:false,resizable:false,hasShadow:false,alwaysOnTop:true,skipTaskbar:true,show:false,backgroundColor:'#00000000',webPreferences:{preload:join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    const window=this.window;window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',e=>e.preventDefault());window.webContents.session.setPermissionRequestHandler((_w,_permission,cb)=>cb(false));
    window.on('close',e=>{if(!this.stopped){e.preventDefault();this.hide();}});
    window.on('closed',()=>{if(this.window===window){this.window=null;this.ready=false;this.wanted=false;}});
    window.webContents.on('render-process-gone',()=>{this.hide();window.destroy();});
    this.loading=window.loadFile(join(app.getAppPath(),'dist/index.html'),{query:{'pet-chat':'1'}}).then(()=>{this.ready=true;});
    try{await this.loading;}finally{this.loading=null;}
  }
  async open(conversation?:string){
    const role=this.hooks.role();validRole(role);this.role=role;const version=++this.version,opening=++this.opening;this.wanted=true;
    const selected=conversation||this.ai.selectedConversation(role);if(selected)this.conversations.set(role,selected);
    try{await this.create();}catch(error){if(opening===this.opening)this.hide();throw error;}
    if(opening!==this.opening||version!==this.version||!this.isOpen())return;
    await this.refresh();if(opening!==this.opening||version!==this.version||!this.wanted)return;
    if(!this.hooks.pet().isVisible()){this.hide();return;}if(this.hooks.position().dragging)return;
    this.position();this.window?.show();this.window?.focus();this.emit({type:'focus'});
  }
  hide=()=>{++this.opening;this.wanted=false;this.window?.hide();};
  roleChanged(){
    this.role=this.hooks.role();++this.version;
    if(!Object.hasOwn(AI_ROLES,this.role)){this.hide();return;}
    if(this.isOpen()){this.emit({type:'state',state:{role:this.role,name:AI_ROLES[this.role],conversation:this.conversations.get(this.role)||'',hasKey:false,user:'',reply:null,busy:null,warning:'正在切换伙伴…'}});void this.refresh();}
  }
  private async snapshot(role:string):Promise<PetChatSnapshot>{
    validRole(role);const selected=this.conversations.get(role),data:AISnapshot=await this.ai.dispatch({type:'read',role,...(selected?{conversation:selected}:{}),limit:50});
    const conversation=data.conversations.find(c=>c.id===selected)?.id||data.conversations[0]?.id||'';if(this.conversations.get(role)===selected)this.conversations.set(role,conversation);
    const user=data.messages.filter(m=>m.speaker==='user').at(-1),reply=user?data.messages.find(m=>m.request===user.request&&m.speaker==='assistant'):undefined;
    return {role,name:AI_ROLES[role],conversation,hasKey:data.hasKey&&!!data.config.baseURL,user:user?.text||'',reply:reply?{request:reply.request,text:['preparing','streaming'].includes(reply.status)&&this.streamed?.request===reply.request?this.streamed.text:reply.text,status:reply.status}:null,busy:data.busy,warning:data.warning};
  }
  private replyState(state:PetChatSnapshot){const own=this.ownReply;if(!own||state.role!==own.role||state.conversation!==own.conversation||state.reply?.request!==own.request)return;if(own.role===this.hooks.role())this.hooks.reply?.({...own,...state.reply});}
  private async refresh(){
    const role=this.role,version=this.version,reading=++this.reading;if(!role||this.stopped)return;
    try{const state=await this.snapshot(role);if(version!==this.version||reading!==this.reading||this.stopped)return;this.state=state;this.replyState(state);this.emit({type:'state',state});}
    catch(error){if(version!==this.version||reading!==this.reading||this.stopped)return;const state:PetChatSnapshot={role,name:AI_ROLES[role]||'伙伴',conversation:this.conversations.get(role)||'',user:'',reply:null,...(this.state?.role===role?this.state:{}),hasKey:false,busy:null,warning:error instanceof Error?error.message:String(error)};this.state=state;this.emit({type:'state',state});if(this.ownReply?.role===this.hooks.role()){this.hooks.reply?.({...this.ownReply,text:this.streamed?.request===this.ownReply.request?this.streamed.text:'',status:'failed'});this.ownReply=null;}}
  }
  onEvent(event:AIEvent){
    if(event.type==='delta'){this.streamed={request:event.request,text:event.text};if(event.request===this.ownReply?.request&&event.role===this.hooks.role())this.hooks.reply?.({...this.ownReply,text:event.text,status:'streaming'});if(this.isOpen()&&event.role===this.role&&event.conversation===this.conversations.get(this.role))this.emit({type:'delta',role:event.role,conversation:event.conversation,text:event.text});return;}
    if(event.type==='finished'){if(this.ownsReply(event)){if(event.role===this.hooks.role())this.hooks.reply?.({...this.ownReply!,text:event.text,status:event.status});this.ownReply=null;}if(event.request===this.streamed?.request)this.streamed=null;}
    if(this.isOpen()||this.ownReply)void this.refresh();
  }
  private async command(c:PetChatCommand){
    if(!c||typeof c!=='object')throw Error('桌面对话命令无效');
    if(c.type==='layout'){if(!Number.isFinite(c.height)||c.height<60||c.height>260)throw Error('输入框尺寸无效');this.height=Math.max(60,Math.min(240,Math.ceil(c.height)));this.position();return;}
    if(c.type==='close'){this.hide();return;}
    if(c.type==='panel'){const conversation=this.conversations.get(this.role);await this.hooks.openPanel(conversation?'chat:'+conversation:'chat');this.hide();return;}
    if(c.type==='read'){const role=this.role||this.hooks.role();return this.snapshot(role);}
    if(c.type==='stop'){
      const state=await this.snapshot(this.role);if(!state.busy||state.busy.role!==this.role||state.busy.conversation!==state.conversation||state.busy.request!==c.request)throw Error('这条回复已结束，或正在其他会话中生成');
      await this.ai.dispatch({type:'stop',request:bounded(c.request,100,'请求编号')});await this.refresh();return;
    }
    if(c.type!=='send')throw Error('桌面对话命令无效');
    const role=this.role,version=this.version,text=bounded(c.text,4000,'消息');
    if(!this.isOpen()||c.role!==role||c.conversation!==(this.conversations.get(role)||''))throw Error('聊天对象已变化，请确认后重新发送');
    if(this.sending)throw Error('正在发送，请稍候');this.sending=true;
    try{
      const state=await this.snapshot(role);if(version!==this.version||state.conversation!==c.conversation)throw Error('会话已变化，请确认后重新发送');
      if(!state.hasKey)throw Error('请先在完整聊天中保存模型服务地址和 API Key');if(state.busy)throw Error('请等待当前回复完成');
      let conversation=state.conversation;
      if(!conversation){const created=await this.ai.dispatch({type:'new',role});conversation=created.id;this.conversations.set(role,conversation);if(version!==this.version)throw Error('伙伴已切换，请确认后重新发送');}
      const request=randomUUID();this.ownReply={request,role,conversation};await this.ai.dispatch({type:'send',role,conversation,request,text});
      // A refresh failure after acceptance must never restore already-sent input.
      const reading=version===this.version?++this.reading:this.reading;
      let result:PetChatSnapshot;try{result=await this.snapshot(role);}catch(error){result={...state,conversation,user:text,reply:{request,text:this.streamed?.request===request?this.streamed.text:'',status:'failed'},hasKey:false,busy:null,warning:'消息已发送，但暂时无法读取回复状态。请在完整聊天中查看。'+(error instanceof Error?error.message:String(error))};}
      if(version===this.version&&reading===this.reading){this.state=result;this.replyState(result);this.emit({type:'state',state:result});}return result;
    }catch(error){await this.refresh();throw error;}finally{this.sending=false;}
  }
  position(){
    const window=this.window,pet=this.hooks.pet();if(!this.isOpen()||!window||window.isDestroyed()||!this.ready)return;
    const p=this.hooks.position();if(!pet.isVisible()||p.dragging){window.hide();return;}
    const work=screen.getDisplayNearestPoint({x:Math.round(p.x),y:Math.round(p.y)}).workArea;
    // Native Windows bounds can round outward by one DIP at fractional scaling.
    const area={x:work.x+2,y:work.y+2,width:Math.max(1,work.width-4),height:Math.max(1,work.height-4)},width=Math.min(380,area.width),height=Math.min(this.height,area.height);
    const petBounds=pet.getBounds(),right=petBounds.x+petBounds.width+8,left=petBounds.x-width-8;
    const beside=right+width<=area.x+area.width?right:left>=area.x?left:null;
    const bounds=clampWindow({x:beside??p.x-width/2,y:beside===null?Math.max(p.y+12,area.y+260):p.y+12,width,height},area),old=window.getBounds();
    if(old.x!==bounds.x||old.y!==bounds.y||old.width!==bounds.width||old.height!==bounds.height)window.setBounds(bounds);
    if(!window.isVisible())window.showInactive();
  }
  close(){this.stopped=true;this.hide();powerMonitor.removeListener('lock-screen',this.hide);powerMonitor.removeListener('suspend',this.hide);ipcMain.removeHandler('pet-chat:command');this.window?.destroy();this.window=null;}
}
