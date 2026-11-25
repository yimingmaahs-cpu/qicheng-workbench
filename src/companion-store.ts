import {readFile,writeFile,rename,mkdir,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {emptyPlanner,validatePlanner,type PlannerData} from './planner';
import {validateQuote} from './dialogue';
export class CompanionStore {
  data=emptyPlanner();warning='';private chain:Promise<unknown>=Promise.resolve();
  constructor(readonly directory:string){}
  get path(){return join(this.directory,'companion-v1.json');}
  async load(){await mkdir(this.directory,{recursive:true});let raw:string;try{raw=await readFile(this.path,'utf8');}catch(e:any){if(e.code==='ENOENT')return;throw e;}
    const parse=(raw:string)=>{const value=validatePlanner(JSON.parse(raw));value.quotes.forEach(q=>validateQuote(q,true));return value;};
    try{this.data=parse(raw);}catch{const preserved=`${this.path}.corrupt-${Date.now()}-${randomUUID()}`;await copyFile(this.path,preserved);try{this.data=parse(await readFile(`${this.path}.bak`,'utf8'));this.warning='陪伴数据损坏，已恢复最近可用备份。损坏原件已保留。';await writeFile(`${this.path}.tmp`,JSON.stringify(this.data));await rename(`${this.path}.tmp`,this.path);}catch{this.warning='陪伴数据与备份均不可用；原件已保留，请在设置中选择恢复。当前为只读模式。';this.blocked=true;}}
    if(this.data.focus.status==='running')this.data.focus.status='paused';
  }
  blocked=false;
  snapshot(){return {...structuredClone(this.data),...(this.warning?{warning:this.warning}:{})};}
  transact<T>(fn:(draft:PlannerData)=>T):Promise<T>{const operation=this.chain.catch(()=>{}).then(async()=>{if(this.blocked)throw Error(this.warning);const draft=structuredClone(this.data),result=fn(draft);if(JSON.stringify(draft)===JSON.stringify(this.data))return result;await this.persist(draft);this.data=draft;return result;});this.chain=operation;return operation;}
  private async persist(data:PlannerData){
    await mkdir(this.directory,{recursive:true});const raw=JSON.stringify(data,null,2);
    await writeFile(`${this.path}.tmp`,raw,'utf8');
    let previous=await readFile(this.path,'utf8').catch((e:any)=>{if(e.code==='ENOENT')return '';throw e;});
    try{const parsed=validatePlanner(JSON.parse(previous));parsed.quotes.forEach(q=>validateQuote(q,true));}catch{previous='';}
    // Never replace a usable backup with a corrupt primary during manual recovery.
    await writeFile(`${this.path}.bak.tmp`,previous||raw,'utf8');
    await rename(`${this.path}.bak.tmp`,`${this.path}.bak`);
    await rename(`${this.path}.tmp`,this.path);
  }
  async recover(path:string){const raw=await readFile(path,'utf8'),data=validatePlanner(JSON.parse(raw));data.quotes.forEach(q=>validateQuote(q,true));if(data.focus.status==='running')data.focus.status='paused';const operation=this.chain.catch(()=>{}).then(async()=>{await copyFile(this.path,`${this.path}.before-restore-${Date.now()}-${randomUUID()}`).catch((e:any)=>{if(e.code!=='ENOENT')throw e;});await this.persist(data);this.data=data;this.blocked=false;this.warning='已从所选备份恢复，恢复前的数据已另存。';});this.chain=operation;await operation;}
  flush(){return this.chain;}
}
