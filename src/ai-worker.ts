import {openAIStore} from './ai-store';
import {AIEngine} from './ai-engine';
import {validateConfig} from './ai-types';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseLore} from './ai-lore';
const port=process.parentPort;let engine:AIEngine|undefined;
port.on('message',async({data})=>{const {id,command}=data;try{
  let result:unknown;
  if(command.type==='init'){if(engine)throw Error('AI 后端已初始化');const lore=parseLore(readFileSync(join(__dirname,'ai-lore.md'),'utf8'));const opened=openAIStore(command.dir);engine=new AIEngine(opened.store,event=>port.postMessage({event}),lore);engine.warning=opened.warning;engine.key=command.key||'';}
  else{if(!engine)throw Error('AI 后端尚未就绪');if(command.type==='configure')result=await engine.configure(validateConfig(command.config),command.key);else if(command.type==='shutdown'){await engine.close();engine=undefined;}else result=await engine.command(command);}
  port.postMessage({id,result});
}catch(error){port.postMessage({id,error:error instanceof Error?error.message:'AI 操作失败'});}});
