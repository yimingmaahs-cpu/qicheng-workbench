// Recognize explicit naming requests locally; questions, quotations and ordinary stories are not settings.
export function addressChange(text:string):{value:string|null;avoid?:string}|undefined {
  const input=text.trim().replace(/[。！？!?]+$/,'').trim();
  if(/^(?:请)?(?:恢复|用回|改回)(?:人设里的|人设中的|默认)(?:称呼|叫法)$/.test(input))return {value:null};
  const replacement=input.match(/^(?:不要|别)叫我[^，,。；;]+[，,。；;]\s*((?:请)?(?:改)?叫我.+)$/);
  if(replacement)return addressChange(replacement[1].replace(/^改叫我/,'叫我'));
  const negative=input.match(/^(?:请)?(?:不要|别)(?:再)?叫我(.+?)(?:了)?$/);
  if(negative){const named=addressChange('叫我'+negative[1]);return named?.value?{value:'',avoid:named.value}:undefined;}
  const match=input.match(/^(?:(?:请|你可以|你要|你|还是|以后|现在|这次聊天|这次|本次聊天|本会话|今天|暂时|先)[，,\s]*)*(?:称呼我为|称呼我|叫我|为什么不叫我|怎么不叫我)(.+)$/);
  if(!match)return;
  const name=match[1].trim().replace(/^[：:]\s*/,'').replace(/(?:就好|就行|吧)$/,'').trim();
  const quoted=name.match(/^(?:“([^”]+)”|「([^」]+)」|"([^"]+)")$/);
  const value=quoted?quoted.slice(1).find(Boolean)!:name;
  if(!value||value.length>40||/[\r\n，,。！？!?；;：:]/.test(value))return;
  if(!quoted&&(!/^[\p{L}\p{N}· _-]+$/u.test(value)||/^(?:去|来|帮|把|给|做|拿|用|吃|睡|怎么|如何|明天|今天|马上|不要|别)/.test(value)||/(?:来接|去接|吃饭|帮忙|告诉|提醒|通知|教我|一起|因为|如果|但是|好吗|了吗)/.test(value)))return;
  return {value};
}
export function legacyAddress(text:string){
  // Compatibility only: an explicit isolated sentence in the old free-text persona can supply a default.
  for(const line of text.split(/[。；;，,\r\n]/)){const change=addressChange(line);if(change?.value)return change.value;}
  return '';
}
