// Outlaw OS installer GUI — preload. Narrow, validated bridge only.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('installer', {
    env:    () => ipcRenderer.invoke('inst:env'),
    probe:  () => ipcRenderer.invoke('inst:probe'),
    online: () => ipcRenderer.invoke('inst:online'),
    wifiList:    () => ipcRenderer.invoke('inst:wifi-list'),
    wifiConnect: (ssid, password) => ipcRenderer.invoke('inst:wifi-connect', { ssid, password }),
    start:  (opts) => ipcRenderer.invoke('inst:start', opts),
    reboot: () => ipcRenderer.invoke('inst:reboot'),
    quit:   () => ipcRenderer.invoke('inst:quit'),
    onLine:  (fn) => ipcRenderer.on('inst:line',  (_e, s) => fn(s)),
    onStage: (fn) => ipcRenderer.on('inst:stage', (_e, s) => fn(s)),
    onDone:  (fn) => ipcRenderer.on('inst:done',  () => fn()),
    onError: (fn) => ipcRenderer.on('inst:error', (_e, s) => fn(s)),
});
