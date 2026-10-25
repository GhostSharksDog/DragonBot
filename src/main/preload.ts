import { contextBridge, ipcRenderer } from 'electron';
import type { AppSnapshot, PetBridge } from '../shared/types';
const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
const bridge: PetBridge = {
  getState: () => invoke('pet:state'),
  onState: listener => { const handler = (_: unknown, state: AppSnapshot) => listener(state); ipcRenderer.on('pet:state-change', handler); return () => ipcRenderer.removeListener('pet:state-change', handler); },
  send: text => invoke('pet:send', text), answer: payload => invoke('pet:answer', payload), approve: (id, decision) => invoke('pet:approve', id, decision),
  stop: () => invoke('pet:stop'), newThread: () => invoke('pet:new-thread'), resumeThread: id => invoke('pet:resume-thread', id),
  updateSettings: patch => invoke('pet:settings', patch), chooseFolder: () => invoke('pet:choose-folder'), importSkin: () => invoke('pet:import-skin'),
  setBubble: open => invoke('pet:bubble', open), drag: (dx, dy) => invoke('pet:drag', dx, dy),
  setBubbleMode: (mode, tab) => invoke('pet:bubble-mode', mode, tab), showContextMenu: () => invoke('pet:context-menu'), resizeQuickBubble: height => invoke('pet:quick-height', height),
  openQuota: () => invoke('pet:quota-open'), refreshQuota: () => invoke('pet:quota-refresh'),
  openComposer: () => invoke('pet:compose-open'), showReply: () => invoke('pet:reply-show'),
  connectBrowser: () => invoke('pet:connect-browser'), reconnect: () => invoke('pet:reconnect'), login: () => invoke('pet:login'), openExternal: url => invoke('pet:external', url),
  detectBrowser: () => invoke('pet:browser-detect'), selectBrowserProfile: id => invoke('pet:browser-profile', id), installBrowserExtension: () => invoke('pet:browser-install'),
  cancelLogin: () => invoke('pet:cancel-login'),
};
contextBridge.exposeInMainWorld('pet', bridge);
