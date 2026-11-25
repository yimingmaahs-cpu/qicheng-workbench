import type {AIConfig} from './ai-types';
export type ModelMessage={role:'system'|'user'|'assistant';content:string};
export type ModelUsage={input:number|null;output:number|null};
// Stream boundaries do not coincide with UTF-8 characters, lines, or SSE events.
export async function* sseData(body:ReadableStream<Uint8Array>){
  const reader=body.getReader(),decoder=new TextDecoder();let buffer='',data:string[]=[],eventSize=0;
  try{while(true){const {value,done}=await reader.read();buffer+=decoder.decode(value,{stream:!done});if(buffer.length>1_000_000)throw Error('模型事件过大');
    let match:RegExpExecArray|null;while((match=(done?/\r\n|\n|\r/:/\r\n|\n|\r(?!$)/).exec(buffer))){const line=buffer.slice(0,match.index);buffer=buffer.slice(match.index+match[0].length);if(!line){if(data.length)yield data.join('\n');data=[];eventSize=0;}else if(line.startsWith('data:')){eventSize+=line.length;if(eventSize>1_000_000)throw Error('模型事件过大');data.push(line.slice(5).replace(/^ /,''));}}
    if(done){if(buffer.startsWith('data:'))data.push(buffer.slice(5).trimStart());if(data.length)yield data.join('\n');break;}
  }}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function completion(config:AIConfig,key:string,messages:ModelMessage[],options:{signal:AbortSignal;structured?:boolean;maxTokens?:number;delta?:(text:string)=>void;usage?:(usage:ModelUsage)=>void}){
  const model=options.structured?config.memoryModel:config.chatModel;
  const body:Record<string,unknown>={model,messages,stream:!options.structured,max_tokens:options.maxTokens??(options.structured?2400:512)};
  if(options.structured)body.response_format={type:'json_object'};else body.stream_options={include_usage:true};
  if(model.startsWith('qwen')&&!model.includes('character'))body.enable_thinking=false;
  if(model.startsWith('deepseek'))body.thinking={type:'disabled'};
  const signal=AbortSignal.any([options.signal,AbortSignal.timeout(120000)]);
  let response:Response;try{response=await fetch(`${config.baseURL}/chat/completions`,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify(body),signal});}catch{if(options.signal.aborted)throw Error('已停止');throw Error('连接失败或超时，请检查服务地址与网络');}
  if(!response.ok){await response.body?.cancel();throw Error(({401:'API Key 无效',403:'该 Key 无权访问模型',402:'模型账户余额不足',429:'模型限流或额度不足'} as Record<number,string>)[response.status]||`模型服务请求失败（HTTP ${response.status}）`);}
  const usage=(raw:any)=>{if(raw)options.usage?.({input:Number.isFinite(raw.prompt_tokens)?raw.prompt_tokens:null,output:Number.isFinite(raw.completion_tokens)?raw.completion_tokens:null});};
  if(options.structured){if(!response.body)throw Error('模型返回内容为空');const reader=response.body.getReader(),decoder=new TextDecoder();let raw='';try{while(true){const {value,done}=await reader.read();raw+=decoder.decode(value,{stream:!done});if(raw.length>120000)throw Error('记忆响应过大');if(done)break;}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}let json:any;try{json=JSON.parse(raw);}catch{throw Error('模型没有返回有效 JSON');}usage(json.usage);const text=json.choices?.[0]?.message?.content;if(typeof text!=='string')throw Error('模型返回内容为空');if(json.choices[0].finish_reason&&json.choices[0].finish_reason!=='stop')throw Error('记忆响应未完成，原聊天已保留');return {text,reason:json.choices[0].finish_reason||'stop'};}
  if(!response.body)throw Error('模型没有返回数据流');let text='',reason='',ended=false;
  for await(const data of sseData(response.body)){if(options.signal.aborted)throw Error('已停止');if(data==='[DONE]'){ended=true;break;}let json:any;try{json=JSON.parse(data);}catch{throw Error('模型返回了无法解析的数据流');}if(json.error)throw Error('模型在回复途中返回错误');usage(json.usage);const choice=json.choices?.[0];if(choice?.finish_reason)reason=choice.finish_reason;const part=choice?.delta?.content;if(typeof part==='string'){text+=part;if(text.length>32000)throw Error('回复超过应用长度限制');options.delta?.(part);}}
  if(!text)throw Error('模型未返回正文');if(!ended&&!reason)throw Error('连接提前结束，回复未完成');return {text,reason};
}
