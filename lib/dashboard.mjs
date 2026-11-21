import { createHash } from 'node:crypto';
import { dateValue } from './jobs.mjs';

const fail=(status,message)=>Object.assign(new Error(message),{status});
const terminal=['offer','rejected','withdrawn'];
export function dashboard(db,{recruiting,mail,clock=()=>new Date()}) {
  db.exec('CREATE TABLE IF NOT EXISTS todo_actions(id TEXT PRIMARY KEY,data TEXT NOT NULL)');
  function state() {
    const {jobs,applications}=recruiting.state(),rows=[],now=clock().toISOString();
    const add=row=>{
      if(row.dueAt)row.dueAt=new Date(row.dueAt).toISOString();
      const id=createHash('sha256').update(row.kind+':'+row.targetId).digest('hex').slice(0,32);
      const signature=JSON.stringify([row.dueAt||'',row.version||0]);
      const stored=JSON.parse(db.prepare('SELECT data FROM todo_actions WHERE id=?').get(id)?.data||'{}');
      const action=stored.signature===signature?stored:{};
      const dueAt=action.snoozedUntil||row.dueAt||'';
      const needsConfirmation=!!row.needsConfirmation&&!action.snoozedUntil;
      const done=!!(row.done||action.done);
      const bucket=done?'done':row.closed?'closed':row.kind==='deadline'&&row.dueAt&&row.dueAt<now?'expired':needsConfirmation?'unknown':dueAt&&dueAt>new Date(clock().getTime()+7*86400000).toISOString()?'later':'active';
      rows.push({...row,id,signature,actionRevision:stored.revision||0,dueAt,originalDueAt:row.dueAt||'',needsConfirmation,done,bucket,snoozed:!!action.snoozedUntil,overdue:!done&&!row.closed&&!!dueAt&&dueAt<now});
    };
    for(const job of jobs.filter(j=>!j.deletedAt&&!j.archived)) {
      const app=applications.find(a=>a.jobId===job.id);
      const announcement=job.recordType==='announcement';
      if(!app||app.status==='preparing')add({kind:'deadline',targetId:job.id,title:(job.company||'公司未识别')+' · '+(job.title||(announcement?'招聘公告':'岗位未注明')),label:announcement?'公告截止':'岗位截止',dueAt:job.deadline?job.deadline+'T23:59:59+08:00':'',needsConfirmation:!job.deadline,version:job.deadline||'',evidence:job.deadline?(announcement?'公告':'岗位')+'原文仅提供日期，按北京时间当日结束排序，请以原公告为准。':'未注明截止日期；不推测截止时间。',jobId:job.id});
    }
    for(const app of applications) {
      const title=(app.jobSnapshot.company||'公司未识别')+' · '+(app.jobSnapshot.title||'岗位未注明');
      if(app.status==='preparing')add({kind:'preparing',targetId:app.id,title,label:'待投递',dueAt:'',version:app.status,evidence:'仍在准备投递；请在原岗位完成申请，再确认投递状态。',applicationId:app.id});
      if(app.nextActionAt||app.nextAction)add({kind:'followup',targetId:app.id,title,label:'投递跟进',dueAt:app.nextActionAt,needsConfirmation:!app.nextActionAt,version:app.nextAction,closed:terminal.includes(app.status),closedReason:app.status==='withdrawn'?'已撤回':'投递已结束',evidence:app.nextAction,applicationId:app.id});
    }
    for(const r of mail.todos().filter(r=>r.source==='mail')) {
      const app=applications.find(a=>a.id===r.applicationId);
      add({...r,kind:'mail',label:r.kind,targetId:r.mailId+':'+r.id,reminderId:r.id,version:r.confirmedAt||'',closed:!!app&&terminal.includes(app.status),closedReason:app?.status==='withdrawn'?'已撤回':'投递已结束'});
    }
    for(const m of mail.records().filter(m=>!m.ignored&&!m.appliedAt)){
      const app=applications.find(a=>a.id===m.applicationId);
      add({kind:'mail-review',label:'待处理邮件',targetId:m.id,mailId:m.id,revision:m.revision,mailCompleted:!!m.completedAt,title:m.subject,version:m.suggestedStatus||'',done:!!m.completedAt,dueAt:'',closed:!!app&&terminal.includes(app.status),closedReason:app?.status==='withdrawn'?'已撤回':'投递已结束',evidence:m.applicationId?'核对邮件内容后同步进展，或标记待办已处理。':'尚未关联投递，可查看邮件并选择记录。'});
    }
    const counts=Object.fromEntries(['active','unknown','later','expired','done','closed'].map(bucket=>[bucket,rows.filter(r=>r.bucket===bucket).length]));
    rows.sort((a,b)=>Number(b.overdue)-Number(a.overdue)||(a.dueAt||'9999').localeCompare(b.dueAt||'9999')||a.title.localeCompare(b.title));
    return {todos:rows,counts,generatedAt:now};
  }
  return {state,async handle(req,res,route,{jsonBody,send}) {
    if(route==='/api/dashboard'&&req.method==='GET'){send(res,200,state());return true;}
    const match=route.match(/^\/api\/dashboard\/todos\/([a-f0-9]{32})$/);
    if(match&&req.method==='PATCH') {
      const input=await jsonBody(req),row=state().todos.find(r=>r.id===match[1]);
      if(!row)throw fail(404,'事项已变化，请刷新待办。');
      if(row.kind==='mail')throw fail(400,'请通过原邮件编辑提醒。');
      if(row.mailCompleted&&input.done===false)throw fail(409,'这封邮件已完成，请先恢复邮件再处理待办。');
      if(row.closed)throw fail(409,'投递已结束，请刷新后查看历史。');
      if(input.signature!==row.signature||input.revision!==row.actionRevision)throw fail(409,'待办已更新，请刷新后重试。');
      const old=JSON.parse(db.prepare('SELECT data FROM todo_actions WHERE id=?').get(row.id)?.data||'{}');
      const action={...(old.signature===row.signature?old:{}),signature:row.signature,revision:row.actionRevision+1};
      if(input.done!==undefined)action.done=input.done===true;
      if(input.snoozedUntil!==undefined){
        action.snoozedUntil=dateValue(input.snoozedUntil);
      }
      db.prepare('INSERT INTO todo_actions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(row.id,JSON.stringify(action));send(res,200,{saved:true});return true;
    }
    return false;
  }};
}
