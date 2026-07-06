// ============================================================================
// Outlaw OS first-boot wizard — preload bridge.
// ----------------------------------------------------------------------------
// Exposes a tightly-scoped API to the renderer. Only the wizard's narrow
// surface — list/install/done — is reachable; the renderer has no Node
// access otherwise.
// ============================================================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('firstboot', {
    /** List available bundles to render as checkboxes. Returns Promise<Bundle[]>. */
    listBundles: () => ipcRenderer.invoke('bundles:list'),

    /**
     * Install one bundle by id. Resolves with { ok, exitCode, errorMessage? }.
     * Subscribe to onProgress() before invoking so log lines aren't lost.
     */
    installBundle: (bundleId) => ipcRenderer.invoke('bundles:install', bundleId),

    /**
     * Subscribe to live pacman output. The callback receives
     * { bundleId, line } for each line written by the install subprocess.
     * Returns an unsubscribe function.
     */
    onProgress: (callback) => {
        const handler = (_event, payload) => callback(payload);
        ipcRenderer.on('bundle:progress', handler);
        return () => ipcRenderer.removeListener('bundle:progress', handler);
    },

    /** Mark wizard complete and quit Electron. */
    finish: () => ipcRenderer.invoke('bundles:done'),

    /** Network — bundles install over the internet, so let first boot connect. */
    netOnline:   () => ipcRenderer.invoke('net:online'),
    wifiList:    () => ipcRenderer.invoke('net:wifi-list'),
    wifiConnect: (ssid, password) => ipcRenderer.invoke('net:wifi-connect', { ssid, password }),
});
