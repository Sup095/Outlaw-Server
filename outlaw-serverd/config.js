// ============================================================================
// Outlaw Server — daemon configuration
// ----------------------------------------------------------------------------
// One reader, one writer, one set of defaults. The daemon and the `outlaw` CLI
// both go through here so they can never disagree about what the config means.
//
// Everything read off disk is normalised before it is returned: a hand-edited
// file with a garbage port or an unknown mode produces a working default, never
// a crashed daemon. Writes are atomic (write-then-rename), so a power cut in the
// middle of `outlaw remote bind` can't leave a half-written file that stops the
// machine from booting its own control panel.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.OUTLAW_SERVERD_CONFIG || '/etc/outlaw-server/daemon.json';

const DEFAULTS = {
    mode: 'panel',              // 'panel' | 'lean'
    host: '127.0.0.1',          // loopback, or a tunnel address — see remote.js
    port: 7717,
    uiDir: '/usr/share/outlaw-server/ui',
    // Trust X-Forwarded-For from a loopback peer. Set ONLY by `outlaw remote
    // serve on`, and honoured only while the daemon is bound to loopback.
    trustProxy: false,
    // Extra Host: header values to accept, for anyone fronting the panel with
    // their own reverse proxy.
    allowedHosts: [],
};

function readRaw() {
    try {
        const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch {
        return {};   // absent or unparseable — defaults are right for a fresh install
    }
}

function normalize(raw) {
    const cfg = { ...DEFAULTS, ...raw };
    cfg.mode = cfg.mode === 'lean' ? 'lean' : 'panel';
    const port = parseInt(cfg.port, 10);
    cfg.port = (Number.isInteger(port) && port > 0 && port < 65536) ? port : DEFAULTS.port;
    cfg.host = String(cfg.host || DEFAULTS.host).trim() || DEFAULTS.host;
    cfg.uiDir = String(cfg.uiDir || DEFAULTS.uiDir);
    cfg.trustProxy = cfg.trustProxy === true;
    cfg.allowedHosts = Array.isArray(cfg.allowedHosts)
        ? cfg.allowedHosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean)
        : [];
    return cfg;
}

function load() {
    return normalize(readRaw());
}

// Merge changes into whatever is on disk, preserving keys we don't know about
// (comments, future settings, anything the admin added by hand).
function patch(changes) {
    const raw = { ...readRaw(), ...(changes || {}) };
    try {
        fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
        const tmp = CONFIG_PATH + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
        fs.renameSync(tmp, CONFIG_PATH);
        return { ok: true, config: normalize(raw) };
    } catch (e) {
        return { ok: false, error: `Could not write ${CONFIG_PATH}: ${e.message}` };
    }
}

module.exports = { load, patch, normalize, DEFAULTS, CONFIG_PATH };
