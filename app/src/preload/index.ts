import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Startup } from '../startup.ts';

// contextBridge cannot carry a MessagePort, so the engine port is re-posted into the page, which listens for it.
ipcRenderer.on('gnomi-port', (event, startup: Startup) => {
  window.postMessage({ gnomi: 'port', ...startup }, '*', event.ports);
});

// A key goes to main and never comes back.
contextBridge.exposeInMainWorld('gnomi', {
  saveKey: (provider, key) => ipcRenderer.invoke('save-key', provider, key),
  listProviders: () => ipcRenderer.invoke('list-providers'),
  clearKey: (provider) => ipcRenderer.invoke('clear-key', provider),
  testKey: (provider) => ipcRenderer.invoke('test-key', provider),
  saveFigmaToken: (token) => ipcRenderer.invoke('save-figma-token', token),
  clearFigmaToken: () => ipcRenderer.invoke('clear-figma-token'),
  testFigmaToken: () => ipcRenderer.invoke('test-figma-token'),
  listAudiences: () => ipcRenderer.invoke('list-audiences'),
  saveAudience: (name, audience, schema) => ipcRenderer.invoke('save-audience', name, audience, schema),
  deleteAudience: (id) => ipcRenderer.invoke('delete-audience', id),
  listProjects: () => ipcRenderer.invoke('list-projects'),
  listRuns: () => ipcRenderer.invoke('list-runs'),
  projectAction: (action) => ipcRenderer.invoke('project-action', action),
  reportThumbnails: (paths) => ipcRenderer.invoke('report-thumbnails', paths),
  saveReport: (format, runId, content) => ipcRenderer.invoke('save-report', format, runId, content),
  pathForFile: (file) => webUtils.getPathForFile(file),
} satisfies Window['gnomi']);
