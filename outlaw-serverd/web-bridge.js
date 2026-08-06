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

    const RPC = '/rpc';

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
    window.outlaw = {
        system: {
            info: () => invoke('system:info'),
            stats: () => invoke('system:stats'),
            processes: () => invoke('system:processes').then((r) => (r && r.processes) || []),
            disk: () => invoke('system:disk'),
            kill: (pid) => invoke('proc:kill', { pid }),
        },
        services: {
            list: () => invoke('services:list').then((r) => (r && r.units) || []),
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
        // Escape hatch for operations the UI knows about before this bridge does.
        invoke,
        on,
        // Electron-only nicety; harmless no-op in a browser (the page can zoom).
        setZoom: () => {},
    };
})();
