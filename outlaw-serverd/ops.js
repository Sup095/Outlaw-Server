// ============================================================================
// Outlaw Server — privileged operations registry
// ----------------------------------------------------------------------------
// Every action the control panel (or the `outlaw` CLI) can perform lives here,
// as a named operation. This is the ONLY place that touches the system.
//
// Design rules, in order of importance:
//   1. NOTHING RUNS ON ITS OWN. There are no timers, no polling loops, no
//      background work in this module. An operation executes only when someone
//      explicitly asks for it. An idle server spends exactly zero CPU here —
//      that is the whole point of the OS.
//   2. NO SHELL INTERPOLATION OF CALLER INPUT. Anything that comes from a
//      client is passed as an execFile argv element, or validated against a
//      real system list first. A caller must never be able to smuggle a shell
//      metacharacter into a command.
//   3. FAIL SOFT, REPORT HONESTLY. An operation returns {ok:false, error} —
//      it never throws the daemon over, and never claims success it didn't get.
//
// The op names deliberately match the Electron IPC channel names the existing
// UI already calls (`system:stats`, `power:reboot`, …) so the same renderer
// works whether it's talking to Electron IPC or to this daemon over HTTP.
// ============================================================================
'use strict';

const os = require('os');
const fs = require('fs');
const { run } = require('./exec');
const remote = require('./remote');
const config = require('./config');

const IS_LINUX = process.platform === 'linux';

// --- small helpers ----------------------------------------------------------

function readFileSafe(p) {
    try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function memInfo() {
    // /proc/meminfo is the honest source on Linux: os.freemem() counts page
    // cache as used, which makes a healthy server look like it's out of RAM.
    const txt = readFileSafe('/proc/meminfo');
    const grab = (k) => {
        const m = txt.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm'));
        return m ? parseInt(m[1], 10) : 0;
    };
    const totalKb = grab('MemTotal');
    const availKb = grab('MemAvailable');
    if (totalKb > 0) return { totalKb, availKb, usedKb: Math.max(0, totalKb - availKb) };
    // No /proc (off-Linux dev box, or an unreadable procfs): fall back to Node's
    // own numbers rather than reporting a confident, wrong 0.
    const t = Math.round(os.totalmem() / 1024);
    const a = Math.round(os.freemem() / 1024);
    return { totalKb: t, availKb: a, usedKb: Math.max(0, t - a) };
}

const gb = (kb) => Math.round((kb / 1024 / 1024) * 10) / 10;

// CPU load without sampling over time (which would mean sleeping / timers).
// Load average is the standard server metric and costs one file read.
function cpuLoad() {
    const [l1, l5, l15] = os.loadavg();
    const cores = os.cpus().length || 1;
    return {
        load1: Math.round(l1 * 100) / 100,
        load5: Math.round(l5 * 100) / 100,
        load15: Math.round(l15 * 100) / 100,
        cores,
        // Load relative to core count — the number an admin actually reads.
        pct: Math.min(100, Math.round((l1 / cores) * 100)),
    };
}

// A systemd unit name we're willing to hand to systemctl. Deliberately strict:
// letters/digits/._@- and an optional known suffix. Anything else is refused
// before it reaches the system.
const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}(\.(service|socket|timer|target|mount|path))?$/;

// ============================================================================
// Operations
// ============================================================================
const ops = {
    // --- identity + health --------------------------------------------------

    'system:info': async () => {
        const mem = memInfo();
        let distro = '';
        const rel = readFileSafe('/etc/os-release');
        const m = rel.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
        if (m) distro = m[1];
        return {
            hostname: os.hostname(),
            distro: distro || 'Outlaw Server',
            kernel: os.release(),
            arch: os.arch(),
            cpu: (os.cpus()[0] || {}).model || 'CPU',
            cores: os.cpus().length,
            ramTotal: gb(mem.totalKb) + ' GB',
            uptimeSec: Math.round(os.uptime()),
        };
    },

    'system:stats': async () => {
        const mem = memInfo();
        return {
            cpu: cpuLoad(),
            ramUsed: gb(mem.usedKb),
            ramTotal: gb(mem.totalKb),
            ramPct: mem.totalKb ? Math.round((mem.usedKb / mem.totalKb) * 100) : 0,
            uptimeSec: Math.round(os.uptime()),
            time: new Date().toISOString(),
        };
    },

    'system:disk': async () => {
        if (!IS_LINUX) return { filesystems: [] };
        // -P = POSIX output (one line per fs, never wrapped) -> safe to parse.
        const r = await run('df', ['-PhT', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'squashfs']);
        const filesystems = r.stdout.split('\n').slice(1).map((line) => {
            const p = line.trim().split(/\s+/);
            if (p.length < 7) return null;
            return {
                device: p[0], type: p[1], size: p[2], used: p[3],
                avail: p[4], usePct: parseInt(p[5], 10) || 0, mount: p.slice(6).join(' '),
            };
        }).filter(Boolean);
        return { filesystems };
    },

    'system:processes': async () => {
        if (!IS_LINUX) return { processes: [] };
        const r = await run('ps', ['-eo', 'pid,comm,pcpu,pmem,rss', '--sort=-pcpu']);
        const processes = r.stdout.split('\n').slice(1).map((l) => {
            const m2 = l.trim().match(/^(\d+)\s+(.+?)\s+([\d.]+)\s+([\d.]+)\s+(\d+)$/);
            return m2 ? {
                pid: m2[1], comm: m2[2], cpu: m2[3], mem: m2[4],
                memMb: Math.round(Number(m2[5]) / 1024),
            } : null;
        }).filter(Boolean).slice(0, 250);
        return { processes };
    },

    // --- services (the daily bread of server admin) -------------------------

    'services:list': async () => {
        if (!IS_LINUX) return { units: [] };
        const r = await run('systemctl', [
            'list-units', '--type=service', '--all', '--no-legend', '--no-pager', '--plain',
        ], { timeout: 12000 });
        const units = r.stdout.split('\n').map((l) => {
            const p = l.trim().split(/\s+/);
            if (p.length < 4) return null;
            return {
                unit: p[0], load: p[1], active: p[2], sub: p[3],
                description: p.slice(4).join(' '),
            };
        }).filter(Boolean);
        return { units };
    },

    'services:status': async (_ctx, { unit } = {}) => {
        if (!IS_LINUX) return { ok: false, error: 'Runs on Outlaw Server.' };
        if (!UNIT_RE.test(String(unit || ''))) return { ok: false, error: 'Invalid unit name.' };
        const [active, enabled] = await Promise.all([
            run('systemctl', ['is-active', unit], { timeout: 5000 }),
            run('systemctl', ['is-enabled', unit], { timeout: 5000 }),
        ]);
        return {
            ok: true, unit,
            active: active.stdout.trim(),
            enabled: enabled.stdout.trim(),
        };
    },

    // start/stop/restart/enable/disable share one validated path.
    'services:action': async (_ctx, { unit, action } = {}) => {
        if (!IS_LINUX) return { ok: false, error: 'Runs on Outlaw Server.' };
        const allowed = ['start', 'stop', 'restart', 'reload', 'enable', 'disable'];
        if (!allowed.includes(action)) return { ok: false, error: 'Unsupported action.' };
        if (!UNIT_RE.test(String(unit || ''))) return { ok: false, error: 'Invalid unit name.' };
        // The unit must actually exist — refuse to hand systemctl a name that
        // merely looks well-formed.
        const known = await run('systemctl', ['list-unit-files', '--no-legend', '--no-pager', '--plain'], { timeout: 12000 });
        const exists = known.stdout.split('\n').some((l) => l.trim().split(/\s+/)[0] === unit);
        if (!exists) return { ok: false, error: `No such unit: ${unit}` };
        const r = await run('systemctl', [action, unit], { timeout: 30000 });
        if (!r.ok) return { ok: false, error: (r.stderr || r.stdout || `systemctl ${action} failed`).slice(-300) };
        return { ok: true, unit, action };
    },

    // --- logs ---------------------------------------------------------------

    'logs:recent': async (_ctx, { unit, lines } = {}) => {
        if (!IS_LINUX) return { lines: [] };
        const n = Math.max(10, Math.min(1000, parseInt(lines, 10) || 200));
        const args = ['--no-pager', '-n', String(n), '-o', 'short-iso'];
        if (unit) {
            if (!UNIT_RE.test(String(unit))) return { ok: false, error: 'Invalid unit name.' };
            args.push('-u', unit);
        }
        const r = await run('journalctl', args, { timeout: 15000 });
        return { ok: true, lines: r.stdout.split('\n').filter(Boolean) };
    },

    // --- process control ----------------------------------------------------

    'proc:kill': async (_ctx, { pid } = {}) => {
        const n = parseInt(pid, 10);
        if (!Number.isInteger(n) || n <= 1) return { ok: false, error: 'Invalid PID.' };
        try { process.kill(n, 'SIGTERM'); return { ok: true, pid: n }; }
        catch (e) { return { ok: false, error: e.code === 'EPERM' ? 'Access denied.' : e.message }; }
    },

    // --- power --------------------------------------------------------------

    'power:reboot': async () => {
        if (!IS_LINUX) return { ok: false, error: 'Runs on Outlaw Server.' };
        const r = await run('systemctl', ['reboot'], { timeout: 10000 });
        return r.ok ? { ok: true } : { ok: false, error: (r.stderr || 'reboot failed').slice(-200) };
    },

    'power:shutdown': async () => {
        if (!IS_LINUX) return { ok: false, error: 'Runs on Outlaw Server.' };
        const r = await run('systemctl', ['poweroff'], { timeout: 10000 });
        return r.ok ? { ok: true } : { ok: false, error: (r.stderr || 'shutdown failed').slice(-200) };
    },

    // --- remote access ------------------------------------------------------
    // Reaching this machine from somewhere else. The rules about WHERE the
    // panel is allowed to listen live in remote.js; these operations only ever
    // ask it, never work around it.

    'remote:status': async () => remote.status(config.load()),

    'remote:up': async (_ctx, { ssh, acceptDns } = {}) =>
        remote.tailscaleUp({ ssh: ssh === true, acceptDns: acceptDns !== false }),

    // hard:true also stops and disables tailscaled — back to nothing running.
    'remote:down': async (_ctx, { hard } = {}) => remote.tailscaleDown({ hard: hard === true }),

    // Move where the panel listens. Validated BEFORE anything is written, so a
    // bad target is refused while the daemon is still happily serving on the
    // old address — you can't lock yourself out with a typo.
    'remote:bind': async (_ctx, { target } = {}) => {
        const cfg = config.load();
        const want = String(target || '').trim();
        let host;

        if (want === 'loopback' || want === 'local') {
            host = '127.0.0.1';
        } else if (want === 'tunnel' || want === 'auto') {
            const cand = remote.preferredTunnelAddress();
            if (!cand) {
                return {
                    ok: false,
                    error: 'No tunnel interface is up, so there is no encrypted address to listen on.',
                    hint: 'Connect first: sudo outlaw remote up',
                };
            }
            host = cand.address;
        } else if (want) {
            host = want;
        } else {
            return { ok: false, error: 'Say where to listen: loopback, tunnel, or an address.' };
        }

        const verdict = remote.classifyBind(host);
        if (!verdict.allowed) {
            return { ok: false, error: `Refusing to listen on ${host} — ${verdict.reason}`, kind: verdict.kind };
        }

        // Serving through Tailscale's HTTPS proxy only makes sense while the
        // daemon is on loopback; moving off it would leave forwarded-header
        // trust switched on for a network-facing socket. Turn it off with the
        // move rather than leaving a contradictory config behind.
        const changes = { host };
        let serveDisabled = false;
        if (verdict.kind !== 'loopback' && cfg.trustProxy) {
            changes.trustProxy = false;
            serveDisabled = true;
        }

        const w = config.patch(changes);
        if (!w.ok) return w;
        return {
            ok: true, host, kind: verdict.kind, serveDisabled,
            restartRequired: true,
            note: 'Restart the daemon to move the socket: systemctl restart outlaw-serverd',
        };
    },

    // Put Tailscale's HTTPS proxy in front of the panel (or take it away).
    'remote:serve': async (_ctx, { enabled } = {}) => {
        const cfg = config.load();
        if (enabled === false) {
            const off = await remote.tailscaleServeOff();
            const w = config.patch({ trustProxy: false });
            if (!w.ok) return w;
            return { ...off, ok: true, enabled: false, restartRequired: true };
        }

        const on = await remote.tailscaleServeOn(cfg.port);
        if (!on.ok) return on;
        // The proxy forwards to loopback, so that is where the daemon belongs.
        const changes = { trustProxy: true };
        if (!remote.isLoopback(cfg.host)) changes.host = '127.0.0.1';
        const w = config.patch(changes);
        if (!w.ok) return w;
        return { ...on, enabled: true, movedToLoopback: changes.host === '127.0.0.1', restartRequired: true };
    },

    // --- daemon self-description -------------------------------------------

    'daemon:info': async (ctx) => {
        const cfg = config.load();
        return {
            version: ctx.version,
            mode: ctx.mode,               // 'panel' | 'lean'
            uiEnabled: ctx.mode === 'panel',
            bind: ctx.bind,
            bindKind: remote.classifyBind(cfg.host).kind,
            serve: cfg.trustProxy === true,
            // Honest statement of what this build can do yet.
            phase: 3,
            note: 'Phase 3: local control, sign-in, and remote access over an encrypted tunnel. Server toolset and one-click game servers land in phases 4-5.',
        };
    },
};

// Dispatch one operation by name. Unknown names are refused (no reflection into
// arbitrary properties), and a thrown handler becomes a clean error response.
async function dispatch(name, args, ctx) {
    if (!Object.prototype.hasOwnProperty.call(ops, name)) {
        return { ok: false, error: `Unknown operation: ${name}` };
    }
    try {
        const result = await ops[name](ctx, args || {});
        return result === undefined ? { ok: true } : result;
    } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
    }
}

module.exports = { ops, dispatch, names: () => Object.keys(ops) };
