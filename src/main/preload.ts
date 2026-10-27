import { contextBridge, ipcRenderer } from 'electron';
import type { AppSnapshot, PetBridge } from '../shared/types';
const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
const bridge: PetBridge = {
  getState: () => invoke('pet:state'),
  onState: listener => { const handler = (_: unknown, state: AppSnapshot) => listener(state); ipcRenderer.on('pet:state-change', handler); return () => ipcRenderer.removeListener('pet:state-change', handler); },
  send: (text,mode) => invoke('pet:send', text,mode), answer: payload => invoke('pet:answer', payload), approve: (id, decision) => invoke('pet:approve', id, decision),
  connectChat:()=>invoke('pet:chat-connect'), checkChat:()=>invoke('pet:chat-check'), showChat:()=>invoke('pet:chat-show'), loginChat:()=>invoke('pet:chat-login'), stopChat:()=>invoke('pet:chat-stop'), newChat:()=>invoke('pet:chat-new'), resumeChat:id=>invoke('pet:chat-resume',id), confirmChatNotSent:()=>invoke('pet:chat-not-sent'),
  stop: () => invoke('pet:stop'), newThread: () => invoke('pet:new-thread'), resumeThread: id => invoke('pet:resume-thread', id),
  updateSettings: patch => invoke('pet:settings', patch), chooseFolder: () => invoke('pet:choose-folder'), importSkin: () => invoke('pet:import-skin'),
  setBubble: open => invoke('pet:bubble', open), drag: (dx, dy) => invoke('pet:drag', dx, dy),
  setBubbleMode: (mode, tab) => invoke('pet:bubble-mode', mode, tab), showContextMenu: () => invoke('pet:context-menu'), resizeQuickBubble: height => invoke('pet:quick-height', height),
  layoutQuickBubble: layout => invoke('pet:quick-layout', layout), confirmQuickLayout: id => invoke('pet:quick-ready', id),
  openQuota: inputAt => invoke('pet:quota-open', inputAt), refreshQuota: () => invoke('pet:quota-refresh'),
  openComposer: inputAt => invoke('pet:compose-open', inputAt), showReply: inputAt => invoke('pet:reply-show', inputAt),
  discoverProjects: () => invoke('pet:projects-discover'), openProject: id => invoke('pet:project-open', id), continueProject: (id, prompt) => invoke('pet:project-continue', id, prompt), refreshProject: () => invoke('pet:project-refresh'), confirmProjectNotSent: () => invoke('pet:project-not-sent'),
  showBrowser: () => invoke('pet:browser-show'), reconnectBrowser: () => invoke('pet:browser-reconnect'),
  connectBrowser: () => invoke('pet:connect-browser'), reconnect: () => invoke('pet:reconnect'), login: () => invoke('pet:login'), openExternal: url => invoke('pet:external', url),
  detectBrowser: () => invoke('pet:browser-detect'), selectBrowserProfile: id => invoke('pet:browser-profile', id), installBrowserExtension: () => invoke('pet:browser-install'),
  cancelLogin: () => invoke('pet:cancel-login'),
};
contextBridge.exposeInMainWorld('pet', bridge);
