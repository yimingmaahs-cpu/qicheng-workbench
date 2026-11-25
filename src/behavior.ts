import type { Action } from './domain';
export type Behavior = { action: Action; elapsed: number; idleTime: number };
export function stepBehavior(state: Behavior, input: {dragging: boolean; reacting: boolean; attention: boolean; walking: boolean}, dt: number, duration: (key: Action)=>number): Behavior {
  let requested: Action=input.dragging?'drag':input.reacting?'react':input.attention?'idle':input.walking?'walk':'idle';
  let idleTime=requested==='idle'&&!input.attention?state.idleTime+dt:0;
  const elapsed=state.elapsed+dt;
  if(requested==='idle'&&!input.attention) {
    if(state.action==='restIn')requested=elapsed>=duration('restIn')?'rest':'restIn';
    else if(state.action==='rest')requested='rest';
    else if(state.action==='restOut'&&elapsed<duration('restOut'))requested='restOut';
    else if(idleTime>22)requested='restIn';
  }
  if((state.action==='rest'||state.action==='restIn') && !['rest','restIn','drag','react'].includes(requested))requested='restOut';
  else if(state.action==='restOut'&&elapsed<duration('restOut')&&!['drag','react'].includes(requested))requested='restOut';
  if(requested==='restOut')idleTime=0;
  return {action:requested,elapsed:requested===state.action?elapsed:0,idleTime};
}
