import {wechatConfig,recruitingMessage} from './wechat.mjs';
import {fail,json,readBody,send,text} from './cloud-security.mjs';

export function pastedJobs(input){
  if(!['wechat','qq'].includes(input.platform))throw fail(400,'请选择微信或 QQ。');
  const group=text(input.group,100,'群名称'),body=text(input.text,300000,'招聘消息');
  const normalized=body.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
  if(normalized.includes('\0')||normalized.includes('\uFFFD'))throw fail(400,'文本编码无法识别，请重新选择文件编码或复制文字。');
  // Recognize complete QQ sender/time headers, never split a JD on blank lines.
  const date='(?:20\\d{2})[-/.]\\d{1,2}[-/.]\\d{1,2}',time='(?:[01]?\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?';
  const header=new RegExp('^(?:'+date+'\\s+'+time+'\\s+\\S.{0,150}|[^\\s:：][^:：]{0,100}?\\s+'+date+'\\s+'+time+')$');
  const chunks=[];let current=[],headers=0;
  const flush=()=>{const message=current.join('\n').trim();if(message)chunks.push(message);current=[];};
  for(const line of normalized.split('\n')){
    const value=line.trim(),schedule=/^(?:截止(?:时间|日期)?|报名(?:时间|日期|截止时间)?|投递(?:时间|截止时间)?|面试(?:时间|安排)?|宣讲(?:时间|安排)?|工作时间|发布时间|更新时间|日期|时间)\s+/.test(value);
    if(input.platform==='qq'&&!schedule&&header.test(value)){
      // Only remove recognized export metadata, never discard an unheaded first message.
      if(!headers)current=current.filter(s=>!/^\s*(?:消息记录[（(]|消息(?:分组|对象)\s*[:：]|={3,}\s*$)/.test(s));
      flush();headers++;
    }
    else if(/^-{3,}$/.test(line.trim()))flush();else current.push(line);
  }
  flush();
  if(chunks.length>1000)throw fail(400,'每次最多识别 1000 条消息，请分批导入。');
  const source=wechatConfig({group,keyword:input.keyword || '',location:input.location || '',exclude:input.exclude || ''});
  const results=chunks.map(message=>recruitingMessage({type:'text',text:message},source));
  const jobs=results.filter(r=>r.job).map(r=>({...r.job,sourceType:input.platform,sourceName:(input.platform==='qq'?'QQ群 · ':'微信群 · ')+group,notes:'用户从'+(input.platform==='qq'?'QQ':'微信')+'群导入：'+group}));
  return{jobs,scanned:chunks.length,filtered:results.filter(r=>r.reason==='filtered').length,unsupported:results.filter(r=>r.reason==='unsupported').length};
}
export function privateSources({innerJSON}){
  return {
    async handle(req,res,url){
      const route=url.pathname;
      if(!route.startsWith('/api/private/'))return false;
      if(req.method!=='POST')throw fail(404,'来源接口不存在。');
      const input=json(await readBody(req,1024*1024));
      if(route==='/api/private/import-preview'){send(res,200,pastedJobs(input));return true;}
      if(route==='/api/private/import'){
        if(input.confirm!==true)throw fail(400,'请先预览并确认导入。');
        const preview=pastedJobs(input);if(!preview.jobs.length)throw fail(400,'没有符合条件的招聘消息。');
        const selected=input.selected===undefined?preview.jobs.map((_,i)=>i):input.selected;
        if(!Array.isArray(selected)||!selected.length||selected.length>200||new Set(selected).size!==selected.length||selected.some(i=>!Number.isInteger(i)||i<0||i>=preview.jobs.length))throw fail(400,'请选择 1 至 200 条有效招聘消息。');
        send(res,200,await innerJSON('/api/jobs/import','POST',{jobs:selected.map(i=>preview.jobs[i])}));return true;
      }
      throw fail(404,'来源接口不存在。');
    }
  };
}
