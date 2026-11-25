import {app,ipcMain,utilityProcess,safeStorage,dialog,type BrowserWindow,type UtilityProcess} from 'electron';
import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {bounded,validateConfig,type AICommand,type AIEvent} from './ai-types';
export class AIBackend {
  private worker:UtilityProcess|null=null;private pending=new Map<string,{resolve:(value:any)=>void;reject:(reason:Error)=>void;timer:ReturnType<typeof setTimeout>}>();private key='';private keyURL='';private startupWarning='';private active=false;private busy=false;private chain=Promise.resolve();
  private dir=join(app.getPath('userData'),'ai');private credentialPath=join(this.dir,'credentials.json');
  private selections=new Map<string,string>();
  constructor(private panel:()=>BrowserWindow|null,private onReply:(event:Extract<AIEvent,{type:'finished'}>)=>void,private onEvent?:(event:AIEvent)=>void){}
  selectedConversation(role:string){return this.selections.get(role);}
  private publish(event:AIEvent){const panel=this.panel();if(panel&&!panel.isDestroyed())panel.webContents.send('ai:event',event);this.onEvent?.(event);}
  chatting(){const panel=this.panel();return this.busy||this.active&&!!panel?.isVisible();}
  private request(command:unknown):Promise<any>{if(!this.worker)return Promise.reject(Error('AI 后端不可用，请重新启动应用；计划和桌宠仍可使用'));const id=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('AI 后端操作超时'));},180000);this.pending.set(id,{resolve,reject,timer});this.worker!.postMessage({id,command});});}
  async init(){
    await mkdir(this.dir,{recursive:true});
    try{const saved=JSON.parse(await readFile(this.credentialPath,'utf8'));if(saved.cipher){if(!safeStorage.isEncryptionAvailable())throw Error('系统密钥加密不可用');this.key=safeStorage.decryptString(Buffer.from(saved.cipher,'base64'));}this.keyURL=saved.baseURL;}catch(e:any){if(e.code!=='ENOENT')this.startupWarning='已保存的 Key 无法解密，请在模型设置中重新填写；原文件已保留。';}
    this.worker=utilityProcess.fork(join(__dirname,'ai-worker.cjs'),[],{serviceName:'毛毡伙伴 AI',stdio:'ignore'});
    this.worker.on('message',data=>{if(data.event){const event=data.event as AIEvent;if(event.type==='delta')this.busy=true;if(event.type==='finished'){this.busy=false;if(event.status==='complete'&&event.text)this.onReply(event);}if(event.type==='changed')this.busy=event.busy;this.publish(event);return;}const pending=this.pending.get(data.id);if(pending){clearTimeout(pending.timer);this.pending.delete(data.id);data.error?pending.reject(Error(data.error)):pending.resolve(data.result);}});
    this.worker.on('exit',()=>{this.worker=null;this.busy=false;for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(Error('AI 后端已退出，请重启应用。未完成回复不会自动重发。'));}this.pending.clear();this.publish({type:'warning',message:'AI 后端已退出，请重启应用。'});});
    try{await this.request({type:'init',dir:this.dir,key:this.key});const state=await this.request({type:'read',role:'felt-beagle'});if(this.key&&state.config.baseURL!==this.keyURL){this.key='';await this.request({type:'configure',config:state.config,key:''});this.startupWarning='服务地址与保存的 Key 不匹配，请重新配置。';}}catch(e){this.startupWarning=e instanceof Error?e.message:'AI 数据库无法打开';}
    const authorized=(e:Electron.IpcMainInvokeEvent|Electron.IpcMainEvent)=>e.senderFrame===e.sender.mainFrame&&e.sender===this.panel()?.webContents;
    const commands=new Set(['read','configure','saveUserPersona','resetAddress','send','revise','stop','new','deleteConversation','deleteMessage','deleteMemory','editMemory','resolveMemory','clear','maintain','recheckMemories','translateMemories','export']);
    ipcMain.handle('ai:command',async(event,c:AICommand)=>{if(!authorized(event))throw Error('此窗口无权访问 AI 数据');if(!c||!commands.has(c.type))throw Error('命令无效');const result=await this.dispatch(c);if(c.type==='read'){const selected=result.conversations.find((x:{id:string})=>x.id===c.conversation)||result.conversations[0];if(selected)this.selections.set(c.role,selected.id);else this.selections.delete(c.role);}return result;});
    ipcMain.on('ai:active',(event,active)=>{if(authorized(event))this.active=active===true;});
  }
  dispatch(c:AICommand):Promise<any>{
    if(c.type==='read')return this.request(c).then(s=>({...s,warning:[this.startupWarning,s.warning].filter(Boolean).join(' ')}));
    // All chat surfaces share the mutation queue. Cancellation must bypass it.
    if(c.type==='stop')return this.command(c);
    const run=()=>this.command(c),result=this.chain.then(run,run);if(c.type!=='maintain'&&c.type!=='recheckMemories'&&c.type!=='translateMemories'&&c.type!=='export')this.chain=result.then(()=>{},()=>{});return result;
  }
  private async command(c:AICommand){
    if(c.type==='configure'){
      const config=validateConfig(c.config);let key=this.key;
      if(c.clearKey===true)key='';else if(c.key!==undefined&&c.key!=='')key=bounded(c.key,4096,'API Key');else if(this.keyURL&&this.keyURL!==config.baseURL)throw Error('修改服务地址时请重新填写 Key，避免把旧 Key 发给其他服务');
      if(/[\r\n]/.test(key))throw Error('API Key 不可包含换行');if(key&&!safeStorage.isEncryptionAvailable())throw Error('系统加密不可用，未保存 Key');
      const previous=await readFile(this.credentialPath).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
      const bytes=JSON.stringify({baseURL:config.baseURL,cipher:key?safeStorage.encryptString(key).toString('base64'):''});
      await writeFile(this.credentialPath+'.tmp',bytes,'utf8');await rename(this.credentialPath+'.tmp',this.credentialPath);
      try{await this.request({type:'configure',config,key});}catch(e){if(previous)await writeFile(this.credentialPath,previous);else await unlink(this.credentialPath);throw e;}
      this.key=key;this.keyURL=config.baseURL;this.startupWarning='';return;
    }
    if(c.type==='export'){const result=await dialog.showSaveDialog({title:'导出 AI 聊天与记忆（包含私人聊天内容）',defaultPath:'毛毡伙伴-AI数据.json',filters:[{name:'JSON',extensions:['json']}]});if(result.canceled||!result.filePath)return {saved:false};const data=await this.request(c);await writeFile(result.filePath,JSON.stringify(data,null,2),'utf8');return {saved:true};}
    return this.request(c);
  }
  async close(){this.active=false;if(this.worker){try{await Promise.race([this.request({type:'shutdown'}),new Promise((_,reject)=>setTimeout(()=>reject(Error('关闭超时')),5000))]);}finally{this.worker?.kill();}}}
}
