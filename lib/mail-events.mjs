import { createHash } from 'node:crypto';

export function mailDetails(text) {
  return text.split(/\n(?:From:|发件人[:：]|On .+wrote:)/i)[0].slice(0,20000).split(/[\r\n]+/).map(s=>s.trim()).filter(s=>/地点|地址|会议|链接|https?:\/\/|准备|携带|材料/.test(s)).slice(0,12);
}

// ponytail: conservative Chinese notice rules; unsupported formats remain for manual confirmation.
export function mailEvents(subject, text) {
  const content = (subject + '\n' + text.split(/\n(?:From:|发件人[:：]|On .+wrote:)/i)[0]).slice(0,20000);
  const lines = content.split(/[\r\n]+/).map(s=>s.trim()).filter(Boolean);
  const details = mailDetails(content);
  const events = [];
  for (const evidence of lines) {
    if (!/面试|笔试|测评|截止|考试|时间|日期/.test(evidence) && !/面试|笔试|测评/.test(subject)) continue;
    if (!/\d{1,2}[月/.-]\d{1,2}|今天|明天|后天|周[一二三四五六日天]|星期|\d+\s*[天小时]+内|另行通知|待定/.test(evidence)) continue;
    const dates = [...evidence.matchAll(/(?<!\d)(20\d{2})[年/.-](\d{1,2})[月/.-](\d{1,2})日?(?!\d)/g)];
    const offsets = /\b(?:UTC|GMT)\s*[+-]\d{1,2}(?::\d{2})?\b/gi;
    const supportedOffset = /^(?:UTC|GMT)\s*\+0?8(?::00)?$/i;
    const zones = [...evidence.matchAll(offsets)].map(m=>m[0]);
    const withoutOffsets = evidence.replace(offsets,'');
    const times = [...withoutOffsets.matchAll(/(?<!\d)(\d{1,2})[:：](\d{2})(?!\d)/g)];
    const zone = /北京时间|中国标准时间|Asia\/Shanghai/i.test(evidence)||zones.some(z=>supportedOffset.test(z));
    const otherZone = zones.some(z=>!supportedOffset.test(z))||/当地时间|纽约|东京|伦敦|\b(?:CST|EST|EDT|PST|PDT|JST|UTC|GMT)\b/i.test(withoutOffsets);
    let dueAt = '', reason = '缺少完整年月日、时分或明确时区，请核对原文后确认。';
    if (dates.length===1 && times.length===1 && zone && !otherZone && !/今天|明天|后天|周[一二三四五六日天]|上午|下午|晚上|凌晨|至|~|～|另行通知|待定|可能|暂定/.test(evidence)) {
      const [,y,mo,d] = dates[0], [,h,mi] = times[0];
      const utc = new Date(Date.UTC(+y,+mo-1,+d,+h,+mi));
      if (utc.getUTCFullYear()===+y && utc.getUTCMonth()===+mo-1 && utc.getUTCDate()===+d && +h<24 && +mi<60) {
        dueAt = new Date(utc.getTime()-8*3600000).toISOString(); reason = '';
      }
    }
    const kind = /截止|之前|前完成/.test(evidence)?'截止时间':/面试/.test(evidence+' '+subject)?'面试':'笔试 / 测评';
    const id = createHash('sha256').update(evidence).digest('hex').slice(0,20);
    if (!events.some(r=>r.id===id)) events.push({id,kind,evidence,details,dueAt,needsConfirmation:!dueAt,reason,done:false});
    if(events.length===20)break;
  }
  return events;
}

export function progressWarnings(mail, app, status) {
  const order = ['preparing','submitted','communicating','assessment','interview','offer'];
  const warnings = [];
  if (app.updatedAt && new Date(mail.date)<new Date(app.updatedAt)) warnings.push('邮件早于投递记录的最近更新，可能是旧进展。');
  if ((order.indexOf(status)>=0 && order.indexOf(status)<order.indexOf(app.status)) || (['rejected','withdrawn'].includes(app.status) && status!==app.status)) warnings.push('此次更新会倒退阶段或重新打开已终止的投递。');
  return warnings;
}
