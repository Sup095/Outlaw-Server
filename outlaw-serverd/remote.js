// ============================================================================
// Outlaw Server — remote access
// ----------------------------------------------------------------------------
// How you reach the control panel from somewhere that isn't this machine,
// without putting a root-privileged control plane on the public internet.
//
// THE RULE THIS MODULE EXISTS TO ENFORCE
// --------------------------------------
// The panel speaks plain HTTP. It may therefore listen on exactly two kinds of
// address, and `classifyBind()` is the gate:
//
//   * LOOPBACK      — nothing leaves the machine.
//   * A TUNNEL ADDRESS — an address that provably belongs to a WireGuard or
//     Tailscale interface. Everything on those interfaces is encrypted
//     end-to-end by WireGuard before it hits a wire, so plain HTTP inside is
//     as private as HTTPS would be, for the same reason SSH tunnelling is.
//
// A LAN address, a public address, or a wildcard bind (0.0.0.0) is REFUSED.
// Not warned about — refused, with the daemon exiting. "Bind it to the LAN just
// for a minute" is how control planes end up on Shodan.
//
// Note this is strictly stronger than a firewall rule: the socket is never
// created on those interfaces at all, so there is no rule to get wrong, flush,
// or forget after a reboot.
//
// TWO WAYS IN, AND WHY BOTH EXIST
// -------------------------------
//   TUNNEL BIND (default, recommended) — the panel listens on the machine's
//     Tailscale/WireGuard address. Simplest possible path: no proxy, so every
//     request carries its real client address and the per-IP lockout and
//     session pinning work on the truth.
//
//   TAILSCALE SERVE (opt-in) — the panel stays on loopback and Tailscale's own
//     proxy fronts it with real HTTPS (a free Let's Encrypt certificate for the
//     machine's `*.ts.net` name). You get a padlock, a memorable hostname, and
//     a browser "secure context". The cost is that every request now arrives
//     from 127.0.0.1, so the daemon has to be told to trust the proxy's
//     forwarded address — see `trustProxy` in serverd.js, which is the ONLY
//     place that trust is granted, and only for loopback peers.
//
// NOTHING HERE RUNS ON A TIMER. Every function is called because a human asked
// a question or pressed a button.
//
// COST, HONESTLY: turning remote access on starts `tailscaled`, which is a real
// daemon with real (small) memory use and periodic keepalive traffic. That is
// not free, so it is OFF until you ask for it. `outlaw remote off` puts the
// machine back to nothing-listening, nothing-running.
// ============================================================================
'use strict';

const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { run } = require('./exec');

const IS_LINUX = process.platform === 'linux';

// ----------------------------------------------------------------------------
// Tunnel detection
// ----------------------------------------------------------------------------

// Interface names used by the two tunnels we support. Tailscale creates
// `tailscale0`; WireGuard interfaces are conventionally `wg0`, `wg-home`, …
const TUNNEL_IFACE_RE = /^(tailscale\d*|ts\d+|wg\d*|wg-[\w.-]+)$/i;

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);
const WILDCARD = new Set(['0.0.0.0', '::', '*', '']);

function isLoopback(addr) {
    const a = String(addr || '').trim().toLowerCase();
    return LOOPBACK.has(a) || a.startsWith('127.');
}

// Tailscale allocates from the CGNAT block 100.64.0.0/10, and fd7a:115c:a1e0::/48
// for IPv6. Used as a corroborating signal, never on its own — the interface
// name is what actually decides.
function looksTailscale(addr) {
    const a = String(addr || '');
    const m = /^(\d+)\.(\d+)\./.exec(a);
    if (m) return Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127;
    return a.toLowerCase().startsWith('fd7a:115c:a1e0');
}

// Every address currently living on a tunnel interface.
function tunnels() {
    const out = [];
    let ifaces = {};
    try { ifaces = os.networkInterfaces() || {}; } catch { return out; }
    for (const [iface, addrs] of Object.entries(ifaces)) {
        if (!TUNNEL_IFACE_RE.test(iface)) continue;
        for (const a of addrs || []) {
            if (!a || a.internal) continue;
            out.push({
                iface,
                address: a.address,
                family: String(a.family).includes('6') || a.family === 6 ? 'IPv6' : 'IPv4',
                kind: /^(tailscale|ts)/i.test(iface) ? 'tailscale' : 'wireguard',
            });
        }
    }
    return out;
}

// The address we'd pick if asked to "bind to the tunnel". IPv4 first: it is
// what an admin can actually type into a browser without brackets.
function preferredTunnelAddress() {
    const t = tunnels();
    return t.find((x) => x.family === 'IPv4' && x.kind === 'tailscale')
        || t.find((x) => x.family === 'IPv4')
        || t[0]
        || null;
}

// THE GATE. Given a configured host, may the daemon listen on it?
function classifyBind(host) {
    const h = String(host == null ? '' : host).trim();

    if (isLoopback(h)) {
        return { allowed: true, kind: 'loopback', address: h || '127.0.0.1' };
    }

    if (WILDCARD.has(h)) {
        return {
            allowed: false,
            kind: 'wildcard',
            reason: 'binding every interface would expose the control panel to whatever network this machine is plugged into',
        };
    }

    const match = tunnels().find((t) => t.address.toLowerCase() === h.toLowerCase());
    if (match) {
        return { allowed: true, kind: match.kind, address: match.address, iface: match.iface };
    }

    // Distinguish "you picked a tunnel address that isn't up right now" from
    // "you picked a LAN address" — the fixes are completely different.
    if (looksTailscale(h)) {
        return {
            allowed: false,
            kind: 'tunnel-down',
            reason: 'that looks like a Tailscale address, but no tunnel interface currently holds it — is tailscaled running and connected?',
        };
    }

    return {
        allowed: false,
        kind: 'network',
        reason: 'the panel speaks plain HTTP, so it may only listen on loopback or on an encrypted tunnel interface',
    };
}

// ----------------------------------------------------------------------------
// Tailscale
// ----------------------------------------------------------------------------

function tailscaleBin() {
    for (const p of ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/usr/sbin/tailscale']) {
        try { if (fs.existsSync(p)) return p; } catch { /* unreadable — treat as absent */ }
    }
    return null;
}

async function tailscaleStatus() {
    const bin = tailscaleBin();
    if (!IS_LINUX || !bin) {
        return {
            installed: false,
            running: false,
            connected: false,
            hint: 'Tailscale is not installed. Install it with: sudo pacman -S tailscale',
        };
    }

    const [activeR, enabledR] = await Promise.all([
        run('systemctl', ['is-active', 'tailscaled'], { timeout: 5000 }),
        run('systemctl', ['is-enabled', 'tailscaled'], { timeout: 5000 }),
    ]);
    const running = activeR.stdout.trim() === 'active';
    const enabled = enabledR.stdout.trim() || 'unknown';

    if (!running) {
        return {
            installed: true, running: false, enabled, connected: false,
            hint: 'The tailscaled service is not running. Start it with: sudo outlaw remote up',
        };
    }

    const r = await run(bin, ['status', '--json'], { timeout: 10000 });
    let st = null;
    try { st = JSON.parse(r.stdout); } catch { /* not JSON — reported below */ }
    if (!st) {
        return {
            installed: true, running: true, enabled, connected: false,
            error: (r.stderr || r.stdout || 'tailscale status returned nothing readable').trim().slice(-300),
        };
    }

    const self = st.Self || {};
    const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [];
    return {
        installed: true,
        running: true,
        enabled,
        state: st.BackendState || 'Unknown',
        connected: st.BackendState === 'Running',
        ips,
        ipv4: ips.find((a) => a.includes('.')) || null,
        // DNSName arrives with a trailing dot (it is a FQDN); strip it so the
        // value can be pasted straight into a browser.
        dnsName: String(self.DNSName || '').replace(/\.$/, ''),
        tailnet: st.MagicDNSSuffix || '',
        // Present when the node is waiting for someone to authenticate it.
        authUrl: st.AuthURL || null,
        peers: Object.keys(st.Peer || {}).length,
    };
}

// Join a tailnet. Returns the sign-in URL as soon as Tailscale prints it —
// authentication happens in a browser, so blocking the caller until it finishes
// would be wrong (and would hang a panel request for minutes).
function tailscaleUp({ ssh = false, acceptDns = true, timeoutMs = 25000 } = {}) {
    return new Promise((resolve) => {
        const bin = tailscaleBin();
        if (!IS_LINUX || !bin) {
            resolve({ ok: false, error: 'Tailscale is not installed. Run: sudo pacman -S tailscale' });
            return;
        }

        // `tailscale up` talks to tailscaled over a local socket, so the service
        // has to exist first. --now starts it; enable makes it survive a reboot,
        // which is the whole point of remote access.
        run('systemctl', ['enable', '--now', 'tailscaled'], { timeout: 30000 }).then((svc) => {
            if (!svc.ok) {
                resolve({ ok: false, error: (svc.stderr || 'could not start tailscaled').trim().slice(-300) });
                return;
            }

            const args = ['up'];
            if (ssh) args.push('--ssh');
            if (!acceptDns) args.push('--accept-dns=false');

            // detached: the sign-in can take minutes while the admin finds their
            // phone. It must not die because this request finished, or because
            // the daemon is restarted while they're logging in.
            let child;
            try {
                child = spawn(bin, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
            } catch (e) {
                resolve({ ok: false, error: e.message });
                return;
            }

            let buf = '';
            let settled = false;
            const finish = (r) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(r);
            };

            // Keep draining after we've resolved. We deliberately do NOT close
            // these pipes: a Go process writing to a closed pipe gets EPIPE, and
            // killing `tailscale up` mid-authentication is exactly the failure
            // we're trying to avoid.
            const onData = (d) => {
                if (buf.length < 64 * 1024) buf += String(d);
                const m = buf.match(/https:\/\/login\.tailscale\.com\/\S+/);
                if (m) finish({ ok: true, pending: true, authUrl: m[0] });
            };
            child.stdout.on('data', onData);
            child.stderr.on('data', onData);
            child.on('error', (e) => finish({ ok: false, error: e.message }));
            child.on('exit', (code) => finish(code === 0
                ? { ok: true, pending: false, note: 'Already authenticated — this machine is on your tailnet.' }
                : { ok: false, error: (buf.trim() || `tailscale up exited with code ${code}`).slice(-400) }));

            const timer = setTimeout(() => finish({
                ok: true,
                pending: true,
                note: 'Tailscale is still working on it. Run `outlaw remote` in a moment to see where it got to.',
            }), timeoutMs);

            child.unref();
        });
    });
}

// Disconnect from the tailnet. `hard` also stops and disables tailscaled, which
// is what returns the machine to zero background cost.
async function tailscaleDown({ hard = false } = {}) {
    const bin = tailscaleBin();
    if (!IS_LINUX || !bin) return { ok: false, error: 'Tailscale is not installed.' };
    const r = await run(bin, ['down'], { timeout: 20000 });
    if (!hard) {
        return r.ok ? { ok: true, stopped: false } : { ok: false, error: (r.stderr || 'tailscale down failed').trim().slice(-300) };
    }
    const svc = await run('systemctl', ['disable', '--now', 'tailscaled'], { timeout: 30000 });
    return svc.ok
        ? { ok: true, stopped: true }
        : { ok: false, error: (svc.stderr || 'could not stop tailscaled').trim().slice(-300) };
}

// Put the panel behind Tailscale's HTTPS proxy. The `serve` command line has
// changed shape across Tailscale releases, so try the forms in newest-first
// order and report exactly what worked (or everything that didn't) rather than
// guessing at the installed version.
async function tailscaleServeOn(port) {
    const bin = tailscaleBin();
    if (!IS_LINUX || !bin) return { ok: false, error: 'Tailscale is not installed.' };
    const p = parseInt(port, 10);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return { ok: false, error: 'Invalid port.' };

    const attempts = [
        ['serve', '--bg', `http://127.0.0.1:${p}`],
        ['serve', '--bg', String(p)],
        ['serve', 'https:443', '/', `http://127.0.0.1:${p}`],
    ];
    const tried = [];
    for (const args of attempts) {
        const r = await run(bin, args, { timeout: 45000 });
        if (r.ok) {
            const st = await tailscaleStatus();
            return {
                ok: true,
                ran: `tailscale ${args.join(' ')}`,
                url: st.dnsName ? `https://${st.dnsName}/` : null,
                output: (r.stdout || '').trim().slice(0, 600),
            };
        }
        tried.push({ cmd: `tailscale ${args.join(' ')}`, error: (r.stderr || r.stdout || '').trim().slice(-300) });
    }
    return {
        ok: false,
        error: 'Tailscale refused every form of the `serve` command.',
        // The real reason is almost always "HTTPS certificates aren't enabled
        // for this tailnet yet" — surface Tailscale's own words, don't paraphrase.
        hint: 'Most often this means HTTPS certificates are not enabled for your tailnet: enable them in the Tailscale admin console under DNS → HTTPS Certificates. The exact errors are below.',
        tried,
    };
}

async function tailscaleServeOff() {
    const bin = tailscaleBin();
    if (!IS_LINUX || !bin) return { ok: false, error: 'Tailscale is not installed.' };
    // `reset` clears the whole serve configuration and exists across versions.
    const r = await run(bin, ['serve', 'reset'], { timeout: 30000 });
    return r.ok ? { ok: true } : { ok: false, error: (r.stderr || r.stdout || 'could not clear the serve config').trim().slice(-300) };
}

// ----------------------------------------------------------------------------
// WireGuard (self-hosted alternative — no third party involved at all)
// ----------------------------------------------------------------------------

async function wireguardStatus() {
    const ifaces = tunnels().filter((t) => t.kind === 'wireguard');
    let installed = false;
    try { installed = fs.existsSync('/usr/bin/wg'); } catch { /* treat as absent */ }
    if (!IS_LINUX || !installed) {
        return { installed: false, interfaces: [], addresses: ifaces };
    }
    const r = await run('/usr/bin/wg', ['show', 'interfaces'], { timeout: 5000 });
    return {
        installed: true,
        interfaces: r.stdout.trim().split(/\s+/).filter(Boolean),
        addresses: ifaces,
    };
}

// ----------------------------------------------------------------------------
// The combined picture an admin actually wants to see
// ----------------------------------------------------------------------------

async function status(cfg = {}) {
    const [ts, wg] = await Promise.all([tailscaleStatus(), wireguardStatus()]);
    const bind = classifyBind(cfg.host);
    const port = cfg.port || 7717;

    const reachableAt = [];
    if (bind.allowed && bind.kind === 'loopback') {
        reachableAt.push({ url: `http://127.0.0.1:${port}/`, from: 'this machine only' });
    }
    if (bind.allowed && bind.kind !== 'loopback') {
        const host = bind.address.includes(':') ? `[${bind.address}]` : bind.address;
        reachableAt.push({ url: `http://${host}:${port}/`, from: `anything on your ${bind.kind} network` });
    }
    if (cfg.trustProxy && ts.dnsName) {
        reachableAt.push({ url: `https://${ts.dnsName}/`, from: 'your tailnet, over HTTPS' });
    }

    return {
        ok: true,
        tailscale: ts,
        wireguard: wg,
        bind: { host: cfg.host || '127.0.0.1', port, ...bind },
        serve: { enabled: !!cfg.trustProxy },
        tunnels: tunnels(),
        candidate: preferredTunnelAddress(),
        reachableAt,
    };
}

module.exports = {
    tunnels,
    preferredTunnelAddress,
    classifyBind,
    isLoopback,
    looksTailscale,
    tailscaleBin,
    tailscaleStatus,
    tailscaleUp,
    tailscaleDown,
    tailscaleServeOn,
    tailscaleServeOff,
    wireguardStatus,
    status,
};
