import { contextBridge, ipcRenderer } from 'electron';

import type { Api, AppEvent } from '../shared/types.ts';

const call =
  (name: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(`army:${name}`, ...args);

const api: Api = {
  getState: call('getState') as Api['getState'],
  addProject: call('addProject') as Api['addProject'],
  removeProject: call('removeProject') as Api['removeProject'],
  createSession: call('createSession') as Api['createSession'],
  getSession: call('getSession') as Api['getSession'],
  renameSession: call('renameSession') as Api['renameSession'],
  deleteSession: call('deleteSession') as Api['deleteSession'],
  setChat: call('setChat') as Api['setChat'],
  send: call('send') as Api['send'],
  stop: call('stop') as Api['stop'],
  getRun: call('getRun') as Api['getRun'],
  answer: call('answer') as Api['answer'],
  stopRun: call('stopRun') as Api['stopRun'],
  runDiff: call('runDiff') as Api['runDiff'],
  mergeRun: call('mergeRun') as Api['mergeRun'],
  saveFlow: call('saveFlow') as Api['saveFlow'],
  deleteFlow: call('deleteFlow') as Api['deleteFlow'],
  saveSettings: call('saveSettings') as Api['saveSettings'],
  doctor: call('doctor') as Api['doctor'],
  refreshModels: call('refreshModels') as Api['refreshModels'],
  testJev: call('testJev') as Api['testJev'],
  onEvent(listener) {
    const fn = (_e: unknown, ev: AppEvent) => listener(ev);
    ipcRenderer.on('army:event', fn);
    return () => ipcRenderer.removeListener('army:event', fn);
  },
};

contextBridge.exposeInMainWorld('api', api);
