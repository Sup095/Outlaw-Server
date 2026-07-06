// ============================================================================
// Outlaw OS — Session greeter (preload bridge)
// ----------------------------------------------------------------------------
// One method. The renderer can only ask the main process to record a session
// choice — it can never write to disk directly.
// ============================================================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('greeter', {
    // remember=true tells main to mirror the choice into the persistent pref
    // file (`~/.outlaw-session-pref`) so future boots skip the greeter entirely.
    choose: (choice, remember) => ipcRenderer.invoke('greeter:choose', choice, !!remember),
    // Phase 8: cinematic boot intro + optional pre-flight check (both read-only).
    bootLog: () => ipcRenderer.invoke('greeter:boot-log'),
    preflight: () => ipcRenderer.invoke('greeter:preflight'),
    // Lock gate — require the shell's PIN before the picker (fail-open in main).
    authNeeded: () => ipcRenderer.invoke('greeter:auth-needed'),
    verifyUnlock: (payload) => ipcRenderer.invoke('greeter:verify', payload),
});
