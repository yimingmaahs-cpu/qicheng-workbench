import type {ChatMessage} from './ai-types';

export function completeTurns(records:ChatMessage[]):ChatMessage[][]{
  const turns=new Map<string,ChatMessage[]>();
  for(const message of records){const turn=turns.get(message.request)||[];turn.push(message);turns.set(message.request,turn);}
  return [...turns.values()].filter(turn=>turn.length===2&&turn.every(m=>!m.excluded&&m.status==='complete')&&turn.some(m=>m.speaker==='user')&&turn.some(m=>m.speaker==='assistant')).map(turn=>[turn.find(m=>m.speaker==='user')!,turn.find(m=>m.speaker==='assistant')!]);
}

const clipped='[长消息已截取]';
function clipMessage(message:ChatMessage,budget:number):ChatMessage{
  if(message.text.length<=budget)return message;
  const remaining=budget-clipped.length,head=Math.ceil(remaining/2),tail=remaining-head;
  return {...message,text:message.text.slice(0,head)+clipped+(tail?message.text.slice(-tail):'')};
}

export function selectRecentTurns(records:ChatMessage[],budget=6000,maxTurns=4):ChatMessage[]{
  budget=Math.min(14000,Math.max(0,Math.floor(budget)));maxTurns=Math.min(40,Math.max(0,Math.floor(maxTurns)));
  const turns=completeTurns(records).slice(-maxTurns),selected:ChatMessage[]=[];
  if(!maxTurns)return selected;
  for(let i=turns.length-1;i>=0;i--){
    const pair=turns[i],size=pair[0].text.length+pair[1].text.length;
    if(size<=budget){selected.unshift(...pair);budget-=size;continue;}
    if(!selected.length&&budget>=2*(clipped.length+1)){
      // Keep the latest user request intact when possible, and enough of the reply to preserve the thread.
      const assistantReserve=Math.min(pair[1].text.length,Math.max(clipped.length+1,Math.min(1000,Math.floor(budget/3))));
      const userBudget=Math.min(pair[0].text.length,budget-assistantReserve);
      selected.push(clipMessage(pair[0],userBudget),clipMessage(pair[1],budget-userBudget));
    }
    break;
  }
  return selected;
}

export const changedTopic=/换(?:个)?话题|换一个话题|另一个问题|说点别的|不(?:说|聊|提)这个|先不(?:说|聊|提)|先聊别的/;
const followUp=/那(?:件事|个人|个事|次的事|天的事)|这(?:件事|个人|个事)|又(?:遇到|碰到)(?:了)?(?:他|她|那|这|[，,。？?！!\s]|$)|又(?:发生|这样)|还是这样|^(?:那|嗯|所以|然后|后来|接着|结果|之后|再后来)[，,\s]*(?:呢|怎么样|怎样|怎么了|怎么办)?[？?！!。\s]*$|^(?:那)?(?:他|她|他们|她们)(?:为什么|怎么|后来|之前|又|还|呢)/;
const vagueFollowUp=/^(?:我|今天|昨天|刚才|又|遇到|碰到|发生|了|他|她|他们|她们|这|那|件事|个事|个人|还是|这样|怎么办|为什么|怎么|后来|然后|接着|结果|之后|呢|怎么样|怎样|所以|嗯|[，,。？?！!\s])+$/;
const historyWords=/上次|上周|那天|之前|以前|当时|那次|还记得|后来|历史|哪天|说过|提过|聊过|约好|约定/;
const personalHistory=/还记得.{0,5}(?:我|我们|咱们)|(?:我|我们|咱们)(?:上次|上周|那天|之前|以前|当时|那次)|(?:上次|上周|那天|之前|以前|当时|那次).{0,10}(?:我(?:说|提|讲|聊|遇|做|去|跟|和|的)|我们|咱们)|(?:我|我们|咱们).{0,8}(?:跟你|和你|告诉你|说过|提过|讲过|聊过|约好|约定)/;
const personalTopic=/(?:我(?:的|们|今天|昨天|最近|喜欢|讨厌|遇到|碰到|跟|和|被|感觉|觉得|心情|打算|准备)|咱们)/;

export function recallContext(question:string,recent:ChatMessage[],loreMatched=false):{query:string;history:boolean}{
  // ponytail: resolve a few explicit Chinese follow-ups locally; broad semantic search can follow measured misses.
  const follows=!changedTopic.test(question)&&!/(?:又遇到|又碰到)(?:了)?(?:新|一个|一位)/.test(question)&&followUp.test(question);
  const topic=follows?completeTurns(recent).slice(-4).map(turn=>turn[0].text).reverse().find(text=>!vagueFollowUp.test(text)&&text.trim().length>3):undefined;
  const previous=topic&&(topic.length>600?topic.slice(0,300)+' '+topic.slice(-300):topic);
  const personal=personalHistory.test(question)||!!(follows&&topic&&personalTopic.test(topic));
  return {query:previous?question+'\n最近用户话题：'+previous:question,history:personal||!loreMatched&&(historyWords.test(question)||follows)};
}
