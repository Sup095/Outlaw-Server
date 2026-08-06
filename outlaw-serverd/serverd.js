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
// SECURITY POSTURE — READ THIS
// ----------------------------
// The panel speaks plain HTTP, so it is only ever allowed to listen where plain
// HTTP is safe:
//
//   * loopback — nothing leaves the machine, or
//   * an address that provably belongs to a WireGuard/Tailscale interface,
//     where WireGuard has already encrypted everything end-to-end.
//
// A LAN address, a public address or a wildcard bind is REFUSED and the daemon
// exits. remote.js owns that decision; this file just obeys it. Sign-in
// (password + TOTP) guards every operation on top of that.
// ============================================================================
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { dispatch } = require('./ops');
const auth = require('./auth');
const remote = require('./remote');
const config = require('./config');

const VERSION = '0.7.0';
const CONFIG_PATH = config.CONFIG_PATH;

const loadConfig = config.load;

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

// --- host-header allowlist --------------------------------------------------
// Refuse requests that didn't ask for us by a name we recognise. This closes
// DNS rebinding: a hostile page can point a name it controls at our address and
// have the victim's own browser talk to the panel, but it cannot change the
// Host header the browser sends. Cheap, and it costs a legitimate user nothing.

function hostNameOf(req) {
    let raw = String(req.headers.host || '').trim();
    if (!raw) return '';
    if (raw.startsWith('[')) {                    // [::1]:7717
        const end = raw.indexOf(']');
        return end > 0 ? raw.slice(1, end).toLowerCase() : '';
    }
    const colon = raw.lastIndexOf(':');
    // A lone colon is a port separator; several means a bare IPv6 literal,
    // which is malformed in a Host header and gets rejected below.
    if (colon > 0 && raw.indexOf(':') === colon) raw = raw.slice(0, colon);
    return raw.toLowerCase();
}

function buildHostAllowlist(cfg) {
    const allow = new Set(['localhost', '127.0.0.1', '::1', 'ip6-localhost']);
    if (cfg.host) allow.add(String(cfg.host).toLowerCase());
    for (const t of remote.tunnels()) allow.add(t.address.toLowerCase());
    for (const h of cfg.allowedHosts || []) allow.add(h);
    return allow;
}

function hostIsAllowed(name, allow, trustProxy) {
    if (!name) return false;
    if (allow.has(name)) return true;
    if (name.startsWith('127.')) return true;
    // Behind Tailscale's HTTPS proxy the browser asks for the machine's MagicDNS
    // name, which we can't know until the tailnet hands it out.
    if (trustProxy && name.endsWith('.ts.net')) return true;
    return false;
}

// --- auth plumbing ----------------------------------------------------------

// The client's address, for session binding and rate limiting.
//
// X-Forwarded-For is IGNORED unless BOTH of these hold:
//   * the admin explicitly enabled `tailscale serve` (which sets trustProxy), and
//   * the request actually arrived from loopback, i.e. from the local proxy.
// Trusting it any other time would let a caller forge its own identity and walk
// straight past the lockout. When we do trust it, the raw peer is returned as a
// second, much-more-tolerant lockout key so a local process can't brute-force
// the panel by forging a fresh address on every attempt.
function clientIp(req, cfg) {
    const peer = (req.socket && (req.socket.remoteAddress || '')) || 'unknown';
    if (cfg.trustProxy && remote.isLoopback(peer)) {
        const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
        if (fwd) return { ip: fwd, peerKey: auth.PROXY_KEY };
    }
    return { ip: peer, peerKey: null };
}

function parseCookies(req) {
    const out = {};
    const raw = req.headers.cookie || '';
    for (const part of raw.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

function sessionCookie(token, maxAgeSec, secure) {
    // HttpOnly  — JavaScript can't read it, so an XSS can't exfiltrate it.
    // SameSite=Strict — a hostile page can't ride the session cross-site.
    // Path=/     — the whole control plane.
    // Secure     — only once something is actually terminating TLS in front of
    //   us (`tailscale serve`). Setting it on a plain-HTTP bind would mean the
    //   browser never sends the cookie back and nobody could stay signed in.
    return `outlaw_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`
        + (secure ? '; Secure' : '');
}

function json(res, code, obj, extraHeaders = {}) {
    res.writeHead(code, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...extraHeaders,
    }).end(JSON.stringify(obj));
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

    // THE BIND GATE. Loopback, or an address that belongs to an encrypted
    // tunnel. Anything else and we exit rather than start — a control plane that
    // can reboot the machine does not get to be "temporarily" on the LAN.
    const verdict = remote.classifyBind(cfg.host);
    if (!verdict.allowed) {
        console.error(`[outlaw-serverd] REFUSING to listen on ${cfg.host} — ${verdict.reason}.`);
        console.error('[outlaw-serverd] Allowed: 127.0.0.1, or a Tailscale/WireGuard address on this machine.');
        console.error('[outlaw-serverd] Set one up with:  sudo outlaw remote up  then  sudo outlaw remote bind tunnel');
        process.exit(1);
    }

    // Forwarded-header trust is only coherent while we're on loopback with a
    // local proxy in front. If the config says otherwise, the config is wrong —
    // drop the trust rather than honour it on a network-facing socket.
    if (cfg.trustProxy && verdict.kind !== 'loopback') {
        console.warn('[outlaw-serverd] ignoring trustProxy: it only applies to a loopback bind behind a local proxy.');
        cfg.trustProxy = false;
    }

    const hostAllowlist = buildHostAllowlist(cfg);

    const server = http.createServer(async (req, res) => {
        // Reject an unrecognised Host before anything else looks at the request.
        if (!hostIsAllowed(hostNameOf(req), hostAllowlist, cfg.trustProxy)) {
            res.writeHead(421, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
               .end('Misdirected request: this panel does not answer to that host name.');
            return;
        }

        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        const { ip, peerKey } = clientIp(req, cfg);

        // ---- authentication endpoints (the only unauthenticated surface) ----

        if (url.pathname === '/auth/status' && req.method === 'GET') {
            const token = parseCookies(req).outlaw_session;
            const sess = auth.verifySession(token, ip);
            json(res, 200, {
                configured: auth.isConfigured(),
                authenticated: !!sess,
                user: sess ? sess.user : null,
            });
            return;
        }

        if (url.pathname === '/auth/login' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await readBody(req, 8 * 1024) || '{}'); }
            catch { json(res, 400, { ok: false, error: 'Bad request.' }); return; }
            const r = auth.login({ user: body.user, password: body.password, code: body.code, ip, peerKey });
            if (!r.ok) { json(res, 401, r); return; }
            json(res, 200, { ok: true, user: r.user },
                 { 'Set-Cookie': sessionCookie(r.token, Math.floor(r.expiresInMs / 1000), cfg.trustProxy) });
            return;
        }

        if (url.pathname === '/auth/logout' && req.method === 'POST') {
            auth.logout(parseCookies(req).outlaw_session);
            json(res, 200, { ok: true },
                 { 'Set-Cookie': 'outlaw_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
            return;
        }

        // First-run enrolment. Allowed ONLY while no user exists — once the
        // machine has an admin this endpoint is permanently closed, so it can
        // never be used to add a second one.
        if (url.pathname === '/auth/setup' && req.method === 'POST') {
            if (auth.isConfigured()) {
                auth.audit('auth.setup_refused', { ip, reason: 'already_configured' });
                json(res, 409, { ok: false, error: 'This server already has an administrator.' });
                return;
            }
            let body;
            try { body = JSON.parse(await readBody(req, 8 * 1024) || '{}'); }
            catch { json(res, 400, { ok: false, error: 'Bad request.' }); return; }
            const r = auth.setUser(body.user, body.password);
            json(res, r.ok ? 200 : 400, r);
            return;
        }

        // Confirm the authenticator app before 2FA starts being enforced.
        if (url.pathname === '/auth/confirm-totp' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await readBody(req, 8 * 1024) || '{}'); }
            catch { json(res, 400, { ok: false, error: 'Bad request.' }); return; }
            json(res, 200, auth.confirmTotp(body.user, body.code));
            return;
        }

        // ---- everything below requires a session ----------------------------

        const token = parseCookies(req).outlaw_session;
        const session = auth.verifySession(token, ip);
        const needsAuth = url.pathname === '/rpc' || url.pathname === '/events';

        if (needsAuth && !session) {
            // A machine with no admin yet must be set up before it will do
            // anything — say which case this is so the UI can route correctly.
            json(res, 401, {
                ok: false,
                error: auth.isConfigured() ? 'Not signed in.' : 'This server has no administrator yet.',
                needSetup: !auth.isConfigured(),
                needLogin: auth.isConfigured(),
            });
            return;
        }

        if (url.pathname === '/rpc' && req.method === 'POST') {
            let payload;
            try {
                payload = JSON.parse(await readBody(req) || '{}');
            } catch (e) {
                json(res, 400, { ok: false, error: 'Bad request: ' + e.message });
                return;
            }
            const op = String(payload.op || '');
            const result = await dispatch(op, payload.args, { ...ctx, user: session.user });
            // Record what was actually done, by whom — reads are noise, so only
            // state-changing operations are audited.
            if (/^(services:action|proc:kill|power:|remote:(up|down|bind|serve))/.test(op)) {
                auth.audit('op', { user: session.user, ip, op, args: payload.args || {}, ok: result.ok !== false });
            }
            json(res, 200, result);
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
        const shown = cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host;
        console.log(`[outlaw-serverd] v${VERSION} — panel on http://${shown}:${cfg.port}`);
        console.log(verdict.kind === 'loopback'
            ? `[outlaw-serverd] loopback only${cfg.trustProxy ? ', fronted by tailscale serve (HTTPS)' : ' — reachable from this machine alone'}.`
            : `[outlaw-serverd] reachable over your ${verdict.kind} tunnel (${verdict.iface}), encrypted end to end.`);
        console.log(auth.isConfigured()
            ? '[outlaw-serverd] sign-in required.'
            : '[outlaw-serverd] NO ADMINISTRATOR YET — open the panel (or run `outlaw passwd`) to create one.');
        console.log('[outlaw-serverd] idle cost: no timers, no polling.');
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
module.exports = {
    start, loadConfig, VERSION,
    _internals: { hostNameOf, hostIsAllowed, buildHostAllowlist, clientIp, sessionCookie },
};
