import { contextBridge, ipcRenderer } from 'electron';
import type { PetAPI } from './domain';
import type { CompanionAPI } from './planner';
import type { AIAPI } from './ai-types';
import type { PetChatAPI } from './pet-chat-types';
const subscribe = (channel: string, cb: (data: any) => void) => {
  const listener = (_event: Electron.IpcRendererEvent, data: any) => cb(data);
  ipcRenderer.on(channel, listener); return () => ipcRenderer.removeListener(channel, listener);
};
const api: PetAPI = {
  bootstrap: () => ipcRenderer.invoke('pet:bootstrap'),
  command: command => ipcRenderer.invoke('pet:command', command),
  selectResult: (id,ok,error) => ipcRenderer.send('pet:select-result', {id,ok,error}),
  hit: (hit,head,crown) => ipcRenderer.send('pet:hit', {hit,head,crown}),
  pointer: kind => ipcRenderer.send('pet:pointer',kind),
  menu: () => ipcRenderer.send('pet:menu'),
  onFrame: callback => subscribe('pet:frame',callback),
  onSelect: callback => subscribe('pet:select',callback),
  onEvent: callback => subscribe('pet:event',callback)
};
contextBridge.exposeInMainWorld('pet',api);
const companion:CompanionAPI={
  read:()=>ipcRenderer.invoke('companion:read'),
  command:command=>ipcRenderer.invoke('companion:command',command),
  onChange:callback=>subscribe('companion:change',callback),
  onNavigate:callback=>subscribe('companion:navigate',callback),
  bubble:()=>ipcRenderer.invoke('companion:bubble'),
  onBubble:callback=>subscribe('companion:bubble-message',callback),
  bubbleInput:data=>ipcRenderer.send('companion:bubble-input',data)
};
contextBridge.exposeInMainWorld('companion',companion);
const ai:AIAPI={command:command=>ipcRenderer.invoke('ai:command',command),onEvent:callback=>subscribe('ai:event',callback),active:active=>ipcRenderer.send('ai:active',active)};
contextBridge.exposeInMainWorld('ai',ai);
const petChat:PetChatAPI={command:command=>ipcRenderer.invoke('pet-chat:command',command),onEvent:callback=>subscribe('pet-chat:event',callback)};
contextBridge.exposeInMainWorld('petChat',petChat);
contextBridge.exposeInMainWorld('bubblePointer',{subscribe:(callback:(point:{x:number;y:number})=>void)=>subscribe('companion:bubble-pointer',callback)});
