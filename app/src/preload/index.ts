import { contextBridge, ipcRenderer } from 'electron';

// contextBridge cannot carry a MessagePort, so the engine port is re-posted into the page, which listens for it.
ipcRenderer.on('gnomi-port', (event, startup: { startupError: string | null; sessionsPersist: boolean }) => {
  window.postMessage({ gnomi: 'port', ...startup }, '*', event.ports);
});

// The key goes to main and never comes back.
contextBridge.exposeInMainWorld('gnomi', {
  saveKey: (key: string) => ipcRenderer.invoke('save-key', key),
  hasKey: () => ipcRenderer.invoke('has-key'),
  clearKey: () => ipcRenderer.invoke('clear-key'),
} satisfies Window['gnomi']);
