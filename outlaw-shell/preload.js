// ============================================================================
// Outlaw Server - Secure preload bridge
// ----------------------------------------------------------------------------
// Runs in an isolated world with Node access. Exposes ONLY an explicit, audited
// API to the renderer via contextBridge. The renderer never gets `require`,
// `ipcRenderer`, or raw shell access. Everything is funnelled through named IPC
// channels that are validated in the main process.
//
// Server fork note (Phase 0): this bridge is the seam for Phase 1 — the same
// renderer will talk to `outlaw-serverd` over WebSocket using this exact API
// shape, so keep it lean and transport-agnostic.
// ============================================================================
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Whitelisted one-way event channels the renderer may subscribe to.
const EVENT_CHANNELS = ['toast',
    'diagnostics-progress',
    'job-progress',       // live phase/log for the loading screen
    'idle-lock',          // main's idle watch says "lock the console now"
];

contextBridge.exposeInMainWorld('outlaw', {
    // --- System information -------------------------------------------------
    system: {
        info: () => ipcRenderer.invoke('system:info'),
        stats: () => ipcRenderer.invoke('system:stats'),
        processes: () => ipcRenderer.invoke('system:processes'),
        // Real boot messages for the boot screen.
        bootLog: () => ipcRenderer.invoke('system:boot-log'),
        // End task / End process tree.
        kill: (pid) => ipcRenderer.invoke('proc:kill', pid),
        killTree: (pid) => ipcRenderer.invoke('proc:kill-tree', pid),
        gpu: () => ipcRenderer.invoke('system:gpu'),
        disk: () => ipcRenderer.invoke('system:disk'),
        net: () => ipcRenderer.invoke('system:net'),
        // Returns {live: bool, dismissed: bool}. Drives the live-ISO welcome
        // card on the Dashboard.
        liveIso: () => ipcRenderer.invoke('system:live-iso'),
    },

    // --- Files (read-only browsing + guarded open) --------------------------
    files: {
        list: (dir) => ipcRenderer.invoke('files:list', dir),
        open: (target) => ipcRenderer.invoke('files:open', target),
        openManager: (dir) => ipcRenderer.invoke('files:open-manager', dir),
        home: () => ipcRenderer.invoke('files:home'),
    },

    // --- Applications (allowlisted launchers + on-demand installer) --------
    apps: {
        launch: (id) => ipcRenderer.invoke('apps:launch', id),
        list: () => ipcRenderer.invoke('apps:list'),
        catalog: () => ipcRenderer.invoke('apps:catalog'),
        installedList: () => ipcRenderer.invoke('apps:installed-list'),
        install: (id) => ipcRenderer.invoke('apps:install', id),
        uninstall: (id) => ipcRenderer.invoke('apps:uninstall', id),
        search: (query) => ipcRenderer.invoke('apps:search', query),
        installPkg: (pkg) => ipcRenderer.invoke('apps:install-pkg', pkg),
        refreshDb: () => ipcRenderer.invoke('apps:refresh-db'),
        discover: () => ipcRenderer.invoke('apps:discover'),
        launchDiscovered: (id) => ipcRenderer.invoke('apps:launch-discovered', id),
    },

    // --- Terminal (guarded executor) ----------------------------------------
    terminal: {
        run: (command, opts) => ipcRenderer.invoke('terminal:run', { command, opts }),
        inspect: (command) => ipcRenderer.invoke('terminal:inspect', command),
    },

    // --- Persistent settings ------------------------------------------------
    settings: {
        get: () => ipcRenderer.invoke('settings:get'),
        set: (patch) => ipcRenderer.invoke('settings:set', patch),
    },

    // Current shell version (for the "Updated to vX.Y.Z" note).
    appVersion: () => ipcRenderer.invoke('app:version'),

    // --- Local AI helper (on-demand: loads to answer, unloads after) --------
    ai: {
        status: () => ipcRenderer.invoke('ai:status'),
        enable: () => ipcRenderer.invoke('ai:enable'),
        disable: () => ipcRenderer.invoke('ai:disable'),
        ask: (prompt, opts) => ipcRenderer.invoke('ai:ask', { prompt, ...(opts || {}) }),
        confirmAction: (action) => ipcRenderer.invoke('ai:confirm-action', action),
        chats: {
            load: () => ipcRenderer.invoke('ai:chats:load'),
            save: (store) => ipcRenderer.invoke('ai:chats:save', store),
        },
        summarize: (payload) => ipcRenderer.invoke('ai:summarize', payload),
        recommend: (opts) => ipcRenderer.invoke('ai:recommend', opts),
        recommendExplain: (opts) => ipcRenderer.invoke('ai:recommend-explain', opts),
        setupChat: (payload) => ipcRenderer.invoke('ai:setup-chat', payload),
        ensureBaseModel: () => ipcRenderer.invoke('ai:ensure-base-model'),
    },
    // Ollama model management (status / list / pull) — the AI engine.
    ollama: {
        status: () => ipcRenderer.invoke('ollama:status'),
        list: () => ipcRenderer.invoke('ollama:list'),
        pull: (model) => ipcRenderer.invoke('ollama:pull', model),
    },
    // Accessibility — scale the whole UI (text size). Clamped for safety.
    setZoom: (factor) => { try { webFrame.setZoomFactor(Math.max(0.7, Math.min(2, Number(factor) || 1))); } catch {} },
    // Combined error/warning log.
    errorlog: {
        read: () => ipcRenderer.invoke('errorlog:read'),
        collect: () => ipcRenderer.invoke('errorlog:collect'),
        clear: () => ipcRenderer.invoke('errorlog:clear'),
        add: (payload) => ipcRenderer.invoke('errorlog:add', payload),
        issueUrl: () => ipcRenderer.invoke('errorlog:issue-url'),
        openIssue: () => ipcRenderer.invoke('errorlog:open-issue'),
    },

    // --- Power --------------------------------------------------------------
    power: {
        reboot: () => ipcRenderer.invoke('power:reboot'),
        shutdown: () => ipcRenderer.invoke('power:shutdown'),
    },

    // --- Date / time / timezone --------------------------------------------
    time: {
        status: () => ipcRenderer.invoke('time:status'),
        zones: () => ipcRenderer.invoke('time:zones'),
        setZone: (tz) => ipcRenderer.invoke('time:set-zone', tz),
        setNtp: (on) => ipcRenderer.invoke('time:set-ntp', on),
    },

    // --- Updates / installer -----------------------------------------------
    updates: {
        check: () => ipcRenderer.invoke('updates:check'),
        apply: () => ipcRenderer.invoke('updates:apply'),
        checkShell: () => ipcRenderer.invoke('updates:check-shell'),
        installShell: (info) => ipcRenderer.invoke('updates:install-shell', info),
        checkRollback: () => ipcRenderer.invoke('updates:rollback-check'),
        rollback: () => ipcRenderer.invoke('updates:rollback'),
    },
    // Storage-as-memory (swapfile) for low-RAM machines.
    swap: {
        status: () => ipcRenderer.invoke('swap:status'),
        set: (opts) => ipcRenderer.invoke('swap:set', opts),
    },
    // Storage cleanup (scan = read-only; clean = safe caches only).
    storage: {
        scan: () => ipcRenderer.invoke('storage:scan'),
        clean: () => ipcRenderer.invoke('storage:clean'),
    },
    // Advisory community-stability signal for the installed version.
    stability: {
        tally: () => ipcRenderer.invoke('stability:tally'),
        reportUrl: (verdict) => ipcRenderer.invoke('stability:report-url', verdict),
    },
    installer: {
        launch: () => ipcRenderer.invoke('installer:launch'),
    },

    // --- Sign-in / console lock ---------------------------------------------
    auth: {
        status: () => ipcRenderer.invoke('auth:status'),
        unlock: (payload) => ipcRenderer.invoke('auth:unlock', payload),
        setPin: (pin, current) => ipcRenderer.invoke('auth:set-pin', { pin, current }),
        clearPin: (payload) => ipcRenderer.invoke('auth:clear-pin', payload),
        setLock: (enabled) => ipcRenderer.invoke('auth:set-lock', enabled),
        recentlyUnlocked: () => ipcRenderer.invoke('auth:recently-unlocked'),
    },
    net: {
        status: () => ipcRenderer.invoke('net:status'),
        wifiList: () => ipcRenderer.invoke('net:wifi-list'),
        wifiConnect: (ssid, password) => ipcRenderer.invoke('net:wifi-connect', { ssid, password }),
        wifiForget: (ssid) => ipcRenderer.invoke('net:wifi-forget', ssid),
    },

    // --- Health diagnostics --------------------------------------------------
    // Streaming progress arrives via outlaw.on('diagnostics-progress', cb).
    diagnostics: {
        run: (profile) => ipcRenderer.invoke('diagnostics:run', profile),
        cancel: () => ipcRenderer.invoke('diagnostics:cancel'),
        status: () => ipcRenderer.invoke('diagnostics:status'),
        listReports: () => ipcRenderer.invoke('diagnostics:list-reports'),
        readReport: (filename) => ipcRenderer.invoke('diagnostics:read-report', filename),
    },

    // --- Safe mode + emergency stop ----------------------------------------
    safeMode: {
        check: () => ipcRenderer.invoke('safe-mode:check'),
    },
    emergency: {
        stop: () => ipcRenderer.invoke('emergency:stop'),
    },

    // --- One-way events from main -> renderer -------------------------------
    on: (channel, listener) => {
        if (!EVENT_CHANNELS.includes(channel)) return () => {};
        const wrapped = (_event, ...args) => listener(...args);
        ipcRenderer.on(channel, wrapped);
        return () => ipcRenderer.removeListener(channel, wrapped);
    },
});
