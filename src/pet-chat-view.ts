import './pet-chat.css';
import type {PetChatAPI,PetChatCommand,PetChatSnapshot} from './pet-chat-types';

declare global {interface Window {petChat?:PetChatAPI;}}
function el<K extends keyof HTMLElementTagNameMap>(tag:K,text='',className=''){const node=document.createElement(tag);node.textContent=text;node.className=className;return node;}

export function mountPetChat(root:HTMLElement){
  document.body.className='pet-chat-page';
  const api=window.petChat,drafts=new Map<string,string>(),errors=new Map<string,string>(),firstDrafts=new Set<string>(),stateEvents=new Map<string,number>();
  let state:PetChatSnapshot|undefined,received=false,composing=false,stopping=false,lastHeight=0,eventSequence=0;
  let pending:{role:string;conversation:string;key:string;text:string}|undefined;
  const key=(s:Pick<PetChatSnapshot,'role'|'conversation'>)=>s.role+':'+s.conversation;
  const card=el('section','','pet-chat-card'),close=el('button','×','pet-chat-close');
  card.setAttribute('aria-label','桌宠聊天输入框');close.type='button';close.setAttribute('aria-label','收起聊天');
  const notice=el('p','','pet-chat-notice'),setup=el('button','设置模型，开始聊天','pet-chat-setup');notice.setAttribute('role','status');setup.type='button';
  const form=el('form','','pet-chat-composer'),input=el('textarea'),controls=el('div','','pet-chat-controls'),hint=el('small','Enter 发送 · Shift + Enter 换行'),stop=el('button','停止','pet-chat-stop'),send=el('button','发送','pet-chat-send');
  input.rows=1;input.maxLength=4000;input.placeholder=api?'正在连接伙伴…':'对桌宠说点什么…';input.setAttribute('aria-label','对桌宠说的话');input.disabled=true;stop.type='button';send.type='submit';send.disabled=true;stop.hidden=true;notice.hidden=setup.hidden=true;
  controls.append(hint,stop,send,close);form.append(input,controls);card.append(form,notice,setup);root.append(card);
  const command=(c:PetChatCommand)=>api?api.command(c):Promise.reject(Error('请在桌面程序中打开聊天。'));
  const errorText=(error:unknown)=>error instanceof Error?error.message:String(error);
  function tell(error:unknown){if(state)errors.set(key(state),errorText(error));else{notice.textContent=errorText(error);notice.hidden=false;}render();}
  function fitInput(){input.style.overflowY='hidden';input.style.height='auto';const height=input.scrollHeight+2;input.style.height=Math.max(38,Math.min(84,height))+'px';input.style.overflowY=height>84?'auto':'hidden';}
  function render(){
    if(!state)return;
    card.dataset.role=state.role;input.placeholder=`对${state.name}说点什么…`;
    const active=state.busy?.role===state.role&&state.busy.conversation===state.conversation;
    notice.textContent=errors.get(key(state))||state.warning||'';notice.hidden=!notice.textContent;
    setup.hidden=state.hasKey;input.disabled=false;send.disabled=!!state.busy||!!pending||!state.hasKey||!input.value.trim();stop.hidden=!active;stop.disabled=stopping;
    hint.textContent=state.busy?(active?'回复中，可以先写下一句':'另一段聊天正在回复…'):'Enter 发送 · Shift + Enter 换行';
  }
  function moveFirstDraft(next:PetChatSnapshot){
    // Also handles returning to a role switched away from while its first conversation was being created.
    if(!next.conversation||!firstDrafts.delete(next.role))return;
    const source=next.role+':',target=key(next),draft=drafts.get(source)||'';
    if(draft)drafts.set(target,[drafts.get(target),draft].filter(Boolean).join('\n'));
    drafts.delete(source);const error=errors.get(source);if(error){errors.set(target,error);errors.delete(source);}
    if(pending?.role===next.role&&!pending.conversation){pending.conversation=next.conversation;pending.key=target;}
    if(input.dataset.draftKey===source)input.dataset.draftKey=target;
  }
  function accept(next:PetChatSnapshot){
    const nextKey=key(next);moveFirstDraft(next);
    state=next;
    if(input.dataset.draftKey!==nextKey){
      input.dataset.draftKey=nextKey;input.value=drafts.get(nextKey)||'';fitInput();
    }
    render();
  }
  input.oninput=()=>{if(state)drafts.set(input.dataset.draftKey||key(state),input.value);fitInput();render();};
  input.addEventListener('compositionstart',()=>{composing=true;});input.addEventListener('compositionend',()=>{composing=false;});
  input.onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&!composing&&event.keyCode!==229){event.preventDefault();form.requestSubmit();}};
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!event.isComposing&&!composing&&event.keyCode!==229){event.preventDefault();void command({type:'close'}).catch(tell);}});
  close.onclick=()=>{void command({type:'close'}).catch(tell);};setup.onclick=()=>{void command({type:'panel'}).catch(tell);};
  stop.onclick=async()=>{if(!state?.busy||stopping)return;const request=state.busy.request;stopping=true;render();try{await command({type:'stop',request});}catch(error){tell(error);}finally{stopping=false;render();}};
  form.onsubmit=async event=>{
    event.preventDefault();if(!state||pending||state.busy||!state.hasKey||composing)return;
    const text=input.value.trim();if(!text)return;
    const submittedAt=eventSequence,submission={role:state.role,conversation:state.conversation,key:key(state),text};pending=submission;if(!submission.conversation)firstDrafts.add(submission.role);errors.delete(submission.key);drafts.set(submission.key,'');input.value='';fitInput();input.focus({preventScroll:true});render();
    try{
      const next:PetChatSnapshot=await command({type:'send',role:submission.role,conversation:submission.conversation,text});
      moveFirstDraft(next);
      if((stateEvents.get(key(next))||0)<=submittedAt&&state.role===submission.role&&(state.conversation===submission.conversation||!state.conversation))accept(next);
    }catch(error){
      const draft=drafts.get(submission.key)||'';drafts.set(submission.key,[text,draft].filter(Boolean).join('\n'));errors.set(submission.key,errorText(error));
      if(input.dataset.draftKey===submission.key){input.value=drafts.get(submission.key)!;fitInput();input.setSelectionRange(input.value.length,input.value.length);}
    }finally{pending=undefined;render();}
  };
  render();
  const observer=new ResizeObserver(()=>{const height=Math.ceil(card.getBoundingClientRect().height)+16;if(height!==lastHeight){lastHeight=height;void command({type:'layout',height}).catch(()=>{});}});observer.observe(card);
  api?.onEvent(event=>{
    if(event.type==='focus'){input.focus({preventScroll:true});return;}
    if(event.type==='state'){
      received=true;
      // The role-switch hint is a placeholder, not a newer backend snapshot.
      if(event.state.warning!=='正在切换伙伴…')stateEvents.set(key(event.state),++eventSequence);
      accept(event.state);return;
    }
  });
  void command({type:'read'}).then((initial:PetChatSnapshot)=>{if(!received)accept(initial);}).catch(error=>{if(!received)tell(error);});
}
