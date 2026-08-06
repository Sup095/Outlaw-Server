// ============================================================================
// Outlaw Server — browser-side API bridge
// ----------------------------------------------------------------------------
// The panel UI is the same code whether it runs inside Electron or in a plain
// browser tab. Electron gets `window.outlaw` from preload.js (contextBridge over
// IPC); a browser gets it from THIS file (the same shape, over HTTP).
//
// That is the entire trick behind "the web app is literally just the UI": the
// renderer never knows or cares which transport it has. Keep the two in the same
// shape — if an operation exists in one, it must exist in the other or degrade
// visibly, never silently.
//
//   invoke  -> POST /rpc   {op, args}
//   events  -> GET  /events (server-sent events)
//
// Zero idle cost applies here too: nothing polls. The SSE stream is opened once
// and the server pushes only when something actually happens.
// ============================================================================
(function () {
    'use strict';

    // The SAME index.html is loaded by both frontends, so this file ships in
    // both. Inside Electron, preload.js has already installed the real (IPC)
    // bridge — bail out rather than clobbering it with the HTTP one. Only a
    // plain browser, which has no preload, gets the transport below.
    if (window.outlaw) return;

    const RPC = '/rpc';

    // Ring buffer of UI faults, for the crash reporter below.
    const recentFaults = [];

    async function invoke(op, args) {
        let res;
        try {
            res = await fetch(RPC, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ op, args: args || {} }),
            });
        } catch (e) {
            // Network-level failure: the daemon is down or unreachable. Surface
            // it as a rejection so callers' existing try/catch paths handle it.
            throw new Error('Cannot reach the server daemon: ' + ((e && e.message) || e));
        }
        if (!res.ok) throw new Error(`Server error (HTTP ${res.status})`);
        return res.json();
    }

    // --- one-way events (toast / job-progress / …) --------------------------
    const listeners = new Map();   // channel -> Set<fn>
    let stream = null;

    function ensureStream() {
        if (stream || typeof EventSource === 'undefined') return;
        stream = new EventSource('/events');
        // Re-dispatch every named event to whoever subscribed to that channel.
        for (const channel of ['toast', 'job-progress', 'diagnostics-progress', 'alert']) {
            stream.addEventListener(channel, (ev) => {
                const set = listeners.get(channel);
                if (!set || !set.size) return;
                let data;
                try { data = JSON.parse(ev.data); } catch { data = ev.data; }
                for (const fn of set) { try { fn(data); } catch { /* one bad listener must not break the rest */ } }
            });
        }
        stream.onerror = () => { /* EventSource reconnects on its own; nothing to do */ };
    }

    function on(channel, listener) {
        if (typeof listener !== 'function') return () => {};
        if (!listeners.has(channel)) listeners.set(channel, new Set());
        listeners.get(channel).add(listener);
        ensureStream();
        return () => { const s = listeners.get(channel); if (s) s.delete(listener); };
    }

    // --- the API surface ----------------------------------------------------
    // Mirrors preload.js so the renderer is transport-agnostic.
    const bridge = {
        system: {
            info: () => invoke('system:info'),
            stats: () => invoke('system:stats'),
            processes: () => invoke('system:processes').then((r) => (r && r.processes) || []),
            disk: () => invoke('system:disk'),
            kill: (pid) => invoke('proc:kill', { pid }),
        },
        services: {
            // Returns the whole result, not just the array: callers need the
            // `available` flag to tell "couldn't read it" from "none exist".
            list: () => invoke('services:list'),
            status: (unit) => invoke('services:status', { unit }),
            start: (unit) => invoke('services:action', { unit, action: 'start' }),
            stop: (unit) => invoke('services:action', { unit, action: 'stop' }),
            restart: (unit) => invoke('services:action', { unit, action: 'restart' }),
            enable: (unit) => invoke('services:action', { unit, action: 'enable' }),
            disable: (unit) => invoke('services:action', { unit, action: 'disable' }),
        },
        logs: {
            recent: (opts) => invoke('logs:recent', opts || {}),
        },
        power: {
            reboot: () => invoke('power:reboot'),
            shutdown: () => invoke('power:shutdown'),
        },
        daemon: {
            info: () => invoke('daemon:info'),
        },
        // The UI's crash reporter calls into this on every uncaught error. It
        // therefore has to SUCCEED QUIETLY even when there is nowhere to write:
        // a reporter that rejects gets reported, and that is a loop. Until the
        // daemon carries a real error log, keep the most recent entries in
        // memory so the page can still show them.
        errorlog: {
            add: (entry) => {
                try {
                    recentFaults.push({ at: new Date().toISOString(), ...(entry || {}) });
                    if (recentFaults.length > 200) recentFaults.shift();
                } catch { /* never throw from the error path */ }
                return Promise.resolve({ ok: true });
            },
            read: () => Promise.resolve({ ok: true, entries: recentFaults.slice() }),
            clear: () => { recentFaults.length = 0; return Promise.resolve({ ok: true }); },
        },
        // Escape hatch for operations the UI knows about before this bridge does.
        invoke,
        on,
        // Electron-only nicety; harmless no-op in a browser (the page can zoom).
        setZoom: () => {},
    };

    // --- honest degradation for what isn't wired yet -------------------------
    // The panel UI is shared with the Electron build, which reaches a much
    // larger API (files, terminal, settings, the app catalogue…). Those are
    // being brought across to the daemon phase by phase.
    //
    // Until then, touching one must NOT be a bare `undefined is not a function`
    // TypeError: that reads as a broken page, tells the admin nothing, and (in
    // the paths without a try/catch) takes the rest of an init routine down with
    // it. Every unknown namespace instead answers with a real function that
    // rejects with a sentence explaining exactly what happened.
    //
    // This is the "degrade visibly, never silently" rule at the top of the file,
    // enforced rather than merely documented.
    const notYet = (path) => () => Promise.reject(new Error(
        `"${path}" isn't available in the browser panel yet — it still runs only in the local Electron panel. `
        + 'Use SSH or the `outlaw` command for now.',
    ));

    window.outlaw = new Proxy(bridge, {
        get(target, prop) {
            if (prop in target) return target[prop];
            if (typeof prop !== 'string') return undefined;
            // Hand back a namespace object whose every member is a clear refusal.
            return new Proxy({}, {
                get: (_t, method) => (typeof method === 'string' ? notYet(`${prop}.${method}`) : undefined),
            });
        },
        // Keep `'x' in window.outlaw` and Object.keys() honest about what is real.
        has: (target, prop) => prop in target,
    });
})();
