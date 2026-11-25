import {legacyAddress} from './ai-address';
export const AI_ROLES: Record<string, string> = {'felt-beagle':'比格·烧冬瓜','felt-rabbit':'垂耳兔·陈慎'};
export type MemoryState = 'active'|'pending'|'superseded'|'expired';
export type Memory = {id:string; role:string; level:'L1'|'L2'|'L3'; kind:'fact'|'preference'|'episode'|'inference'; key:string; text:string; context:string; tags:string[]; state:MemoryState; certainty:'explicit'|'uncertain'|'inferred'|'confirmed'; sources:string[]; evidence:string[]; created:number; updated:number; expires:number|null; occurred:string; pinned:boolean; replaces:string|null; chinese?:{text:string;context:string;occurred:string}};
// Display translations leave conflict identity, evidence and forgetting keys intact.
export function memoryNeedsChinese(m:Memory){return !m.chinese&&[m.text,m.context,m.occurred].some(needsChinese);}
export function needsChinese(text:unknown){return typeof text==='string'&&/[a-z]{3,}/i.test(text)&&!/[\u3400-\u9fff]/.test(text);}
export type ChatMessage = {id:string; conversation:string; request:string; speaker:'user'|'assistant'; text:string; status:string; created:number; excluded:number; processed:number};
export type Conversation = {id:string; role:string; title:string; created:number};
export type TurnVersion = {id:string;operation:string;mode:string;user:string;assistant:string;userText:string;assistantText:string;assistantStatus:string;created:number};
export type MaintenanceResult = {status:'complete'|'cancelled';processed:number;active:number;pending:number;historical?:number;rejected?:number;updated:number;summaries:number;remaining:boolean;nextBefore?:string};
export type AIConfig = {baseURL:string; chatModel:string; memoryModel:string; dailyLimit:number; autoMemory:boolean};
export type UserPersona = {shared:string;sharedAddress?:string;sharedRelationship?:string;roles:Record<string,{mode:'shared'|'private';text:string;address?:string;relationship?:string}>};
export function defaultUserPersona():UserPersona{return {shared:'',roles:Object.fromEntries(Object.keys(AI_ROLES).map(role=>[role,{mode:'shared',text:''}]))};}
export function validateUserPersona(raw:unknown):UserPersona{
  if(!raw||typeof raw!=='object')throw Error('人设格式无效');const value=raw as UserPersona;
  const text=(s:unknown)=>{if(typeof s!=='string'||s.length>2000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s))throw Error('每份人设最多 2000 字，不能包含特殊控制字符');return s.trim();};
  const result=defaultUserPersona();result.shared=text(value.shared);
  for(const role of Object.keys(AI_ROLES)){const item=value.roles?.[role];if(!item||!['shared','private'].includes(item.mode))throw Error('请选择每个角色的人设读取方式');result.roles[role]={mode:item.mode,text:text(item.text)};}
  const field=(s:unknown,max:number)=>{if(typeof s!=='string'||s.length>max||/[\u0000-\u001f]/.test(s))throw Error(`称呼最多40字，关系设定最多200字，均不能包含换行`);return s.trim();};
  if(value.sharedAddress!==undefined)result.sharedAddress=field(value.sharedAddress,40);
  if(value.sharedRelationship!==undefined)result.sharedRelationship=field(value.sharedRelationship,200);
  for(const role of Object.keys(AI_ROLES)){if(value.roles[role].address!==undefined)result.roles[role].address=field(value.roles[role].address,40);if(value.roles[role].relationship!==undefined)result.roles[role].relationship=field(value.roles[role].relationship,200);}
  return result;
}
export function activeUserPersona(persona:UserPersona,role:string){validRole(role);const mode=persona.roles[role].mode;const own=persona.roles[role],text=mode==='private'?own.text:persona.shared;return {mode,text,address:(mode==='private'?own.address:persona.sharedAddress)??legacyAddress(text),relationship:(mode==='private'?own.relationship:persona.sharedRelationship)??''};}
export const DEFAULT_AI_CONFIG:AIConfig = {baseURL:'',chatModel:'qwen-plus-character',memoryModel:'qwen-plus',dailyLimit:200,autoMemory:true};
export type AISnapshot = {lore?:{title:string;entries:number};config:AIConfig;userPersona:UserPersona;address?:{value:string;source:'persona'|'conversation'|'none'}; hasKey:boolean; conversations:Conversation[]; messages:ChatMessage[]; versions?:TurnVersion[]; memories:Memory[]; busy: {request:string;conversation:string;role:string}|null; usage:{kind:string; model:string; calls:number; input:number; output:number; unknown:number}[]; warning:string; summary:string};
export type AICommand = {type:'read';role:string;conversation?:string;limit?:number}|{type:'configure';config:AIConfig;key?:string;clearKey?:boolean}|{type:'send';role:string;conversation:string;request:string;text:string}|{type:'revise';id:string;mode:'regenerate'|'edit'|'continue'|'restore';request:string;text?:string}|{type:'saveUserPersona';persona:UserPersona}|{type:'resetAddress';conversation:string}|{type:'stop';request?:string}|{type:'new';role:string}|{type:'deleteConversation';conversation:string}|{type:'deleteMessage';id:string}|{type:'deleteMemory';id:string;deleteSources?:boolean}|{type:'editMemory';id:string;text:string;context:string;shared:boolean;pinned:boolean}|{type:'resolveMemory';id:string;resolution:'accept'|'keep'|'both'|'reject'}|{type:'clear';role?:string}|{type:'maintain';role:string}|{type:'recheckMemories';role:string;conversation:string;before?:string}|{type:'translateMemories';role:string}|{type:'export'};
export type AIEvent = {type:'delta';request:string;conversation:string;role:string;text:string}|{type:'changed';busy:boolean}|{type:'finished';request:string;role:string;conversation:string;text:string;status:string}|{type:'warning';message:string};
export type AIAPI = {command:(command:AICommand)=>Promise<any>; onEvent:(callback:(event:AIEvent)=>void)=>()=>void; active:(active:boolean)=>void};
export function validRole(role:unknown):asserts role is string {if(typeof role!=='string'||!Object.hasOwn(AI_ROLES,role))throw Error('请选择内置聊天角色');}
export function bounded(value:unknown,max:number,label:string):string {if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(`${label}无效（最多 ${max} 字符）`);return value.trim();}
export function validateConfig(raw:AIConfig):AIConfig {
  if(!raw||typeof raw!=='object')throw Error('模型配置无效');
  const baseURL=bounded(raw.baseURL,500,'服务地址').replace(/\/+$/,'');let url:URL;try{url=new URL(baseURL);}catch{throw Error('服务地址无效');}
  if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw Error('服务地址须为 HTTPS；仅本机服务允许 HTTP，不可包含密码或查询参数');
  const chatModel=bounded(raw.chatModel,100,'聊天模型'),memoryModel=bounded(raw.memoryModel,100,'记忆模型');
  if(!Number.isInteger(raw.dailyLimit)||raw.dailyLimit<1||raw.dailyLimit>2000||typeof raw.autoMemory!=='boolean')throw Error('每日调用上限须为 1～2000 次');
  return {baseURL,chatModel,memoryModel,dailyLimit:raw.dailyLimit,autoMemory:raw.autoMemory};
}
