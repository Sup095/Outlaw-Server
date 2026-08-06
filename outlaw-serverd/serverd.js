#!/usr/bin/env node
// ============================================================================
// outlaw-serverd — the Outlaw Server control daemon
// ----------------------------------------------------------------------------
// Serves the control panel and executes operations on the machine's behalf.
//
// WHY IT LOOKS LIKE THIS
// ----------------------
// * ZERO DEPENDENCIES. Plain Node built-ins only — no npm tree to install,
//   audit, or keep patched on a machine whose job is to stay up. (It also
//   means `lean` mode needs nothing but Node.)
// * ZERO IDLE COST. There is no interval, no poll, no watcher anywhere in this
//   process. It sleeps in the event loop until a request arrives. `top` on an
//   untouched server shows it at 0.0% — that is a hard requirement of the OS,
//   not a nice-to-have.
// * TWO MODES.
//     panel — serve the browser UI + the API      (easy to run and configure)
//     lean  — no UI, no HTTP listener at all      (minimum footprint)
//   The mode lives in /etc/outlaw-server/daemon.json and can be switched any
//   time; `lean` genuinely binds nothing.
//
// TRANSPORT
// ---------
//   POST /rpc      {op, args}  -> JSON result        (replaces ipcRenderer.invoke)
//   GET  /events   text/event-stream                 (replaces ipcRenderer.on)
//   GET  /*        static files from the UI directory
// SSE rather than WebSocket on purpose: it is one-way (which is all our events
// ever are), it is plain HTTP, and it needs no framing code — less surface, less
// to get wrong. The stream exists only while a browser is actually open.
//
// SECURITY POSTURE FOR THIS PHASE — READ THIS
// -------------------------------------------
// Phase 1 has NO AUTHENTICATION YET. It therefore binds to 127.0.0.1 ONLY and
// refuses to start on a non-loopback address: an unauthenticated control plane
// must never be reachable from the network, even by accident. Password + TOTP
// 2FA arrive in Phase 2 and remote access in Phase 3; only then does binding
// beyond loopback become allowed.
// ============================================================================
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { dispatch } = require('./ops');

const VERSION = '0.3.0';
const CONFIG_PATH = process.env.OUTLAW_SERVERD_CONFIG || '/etc/outlaw-server/daemon.json';
const DEFAULT_UI_DIR = '/usr/share/outlaw-server/ui';

const DEFAULTS = {
    mode: 'panel',          // 'panel' | 'lean'
    port: 7717,
    host: '127.0.0.1',      // Phase 1: loopback only, enforced below.
    uiDir: DEFAULT_UI_DIR,
};

function loadConfig() {
    let cfg = { ...DEFAULTS };
    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') cfg = { ...cfg, ...parsed };
    } catch { /* no config yet — defaults are correct for a fresh install */ }
    if (cfg.mode !== 'lean') cfg.mode = 'panel';
    const port = parseInt(cfg.port, 10);
    cfg.port = (Number.isInteger(port) && port > 0 && port < 65536) ? port : DEFAULTS.port;
    return cfg;
}

// --- Server-sent events -----------------------------------------------------
// Connected panels, so an operation can push a toast / progress line. The set
// is empty (and costs nothing) when no browser is open.
const clients = new Set();

function broadcast(event, data) {
    if (!clients.size) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
        try { res.write(payload); } catch { clients.delete(res); }
    }
}

// --- static file serving ----------------------------------------------------
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
};

function serveStatic(cfg, urlPath, res) {
    // Resolve inside uiDir and verify containment — a request can never escape
    // the UI directory via ../ or an absolute path.
    const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
    const full = path.resolve(cfg.uiDir, rel);
    const root = path.resolve(cfg.uiDir);
    if (full !== root && !full.startsWith(root + path.sep)) {
        res.writeHead(403).end('Forbidden');
        return;
    }
    fs.readFile(full, (err, buf) => {
        if (err) { res.writeHead(404).end('Not found'); return; }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
            // The panel is a control plane: never let anything cache it, and
            // never let another origin frame or sniff it.
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
        }).end(buf);
    });
}

function readBody(req, limitBytes = 256 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > limitBytes) { reject(new Error('Request body too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function start() {
    const cfg = loadConfig();
    const ctx = { version: VERSION, mode: cfg.mode, bind: `${cfg.host}:${cfg.port}`, broadcast };

    if (cfg.mode === 'lean') {
        // Lean mode listens for nothing. Say so plainly and exit — systemd is
        // configured not to restart on a clean exit, so the machine simply runs
        // without a control plane until the admin switches modes.
        console.log('[outlaw-serverd] lean mode — no UI, no listener. Manage this server over SSH or with `outlaw`.');
        console.log(`[outlaw-serverd] switch modes: edit ${CONFIG_PATH} ("mode": "panel") and restart outlaw-serverd.`);
        return;
    }

    // Phase-1 safety gate: no auth exists yet, so refuse anything but loopback.
    if (cfg.host !== '127.0.0.1' && cfg.host !== '::1' && cfg.host !== 'localhost') {
        console.error(`[outlaw-serverd] REFUSING to bind ${cfg.host}: this build has no authentication yet,`);
        console.error('[outlaw-serverd] so it must stay on loopback. Remote access arrives in phases 2-3.');
        process.exit(1);
    }

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        if (url.pathname === '/rpc' && req.method === 'POST') {
            let payload;
            try {
                payload = JSON.parse(await readBody(req) || '{}');
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' })
                   .end(JSON.stringify({ ok: false, error: 'Bad request: ' + e.message }));
                return;
            }
            const result = await dispatch(String(payload.op || ''), payload.args, ctx);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
               .end(JSON.stringify(result));
            return;
        }

        if (url.pathname === '/events' && req.method === 'GET') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-store',
                Connection: 'keep-alive',
            });
            res.write(': connected\n\n');
            clients.add(res);
            req.on('close', () => clients.delete(res));
            return;
        }

        if (req.method === 'GET') { serveStatic(cfg, url.pathname, res); return; }
        res.writeHead(405).end('Method not allowed');
    });

    server.on('error', (e) => {
        console.error('[outlaw-serverd] listen failed:', e.message);
        process.exit(1);
    });

    server.listen(cfg.port, cfg.host, () => {
        console.log(`[outlaw-serverd] v${VERSION} — panel on http://${cfg.host}:${cfg.port}`);
        console.log('[outlaw-serverd] loopback only (no auth yet). Idle cost: no timers, no polling.');
    });

    // Shut down cleanly so `systemctl restart` is instant rather than waiting
    // for a timeout, and open SSE streams don't hang the exit.
    const bye = () => {
        for (const c of clients) { try { c.end(); } catch { /* already gone */ } }
        clients.clear();
        server.close(() => process.exit(0));
        // Don't let a stuck socket hold the process forever.
        setTimeout(() => process.exit(0), 3000).unref();
    };
    process.on('SIGTERM', bye);
    process.on('SIGINT', bye);
}

if (require.main === module) start();
module.exports = { start, loadConfig, VERSION };
