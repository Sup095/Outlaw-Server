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
const path = require('path');
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

// An SSH public key we're willing to write into authorized_keys.
//
// ANCHORED AT THE START ON PURPOSE. The real file format allows a leading
// options field (command="…", environment="…", permitopen=…) that executes on
// every login — so a line beginning with anything other than a known key type
// is refused rather than parsed. Base64 body, then an optional free-text
// comment. No newlines: the caller gets one key per call.
const SSH_KEY_RE = new RegExp(
    '^(ssh-ed25519|ssh-rsa|ssh-dss|ecdsa-sha2-nistp(?:256|384|521)'
    + '|sk-ssh-ed25519@openssh\\.com|sk-ecdsa-sha2-nistp256@openssh\\.com)'
    + '\\s+[A-Za-z0-9+/]{32,}={0,3}'      // the key body
    + '(?:\\s+[^\\r\\n]{1,200})?$',        // optional comment
);

// The account someone actually logs into over SSH. The daemon runs as root, so
// "the user's keys" has to be resolved rather than assumed — uid 1000 is the
// account the installer creates.
function primaryUser() {
    for (const line of readFileSafe('/etc/passwd').split('\n')) {
        const p = line.split(':');
        if (p.length >= 6 && Number(p[2]) === 1000) {
            return { name: p[0], uid: Number(p[2]), gid: Number(p[3]), home: p[5] };
        }
    }
    return null;
}

function authorizedKeysPath(u) {
    return path.join(u.home || ('/home/' + u.name), '.ssh', 'authorized_keys');
}

// ============================================================================
// Server software (Phase 5)
// ============================================================================
// A FIXED allowlist. The caller picks an id from this table; it never supplies
// a package name. Anything else would make a signed-in session equivalent to
// arbitrary root package installation.
//
// pacman runs --noconfirm because nothing is attached to answer a prompt, and
// --needed so re-running an install is a no-op rather than a reinstall.

function pacman(args) {
    return run('pacman', ['--noconfirm', ...args], { timeout: 600000 });
}

async function unitActive(unit) {
    const r = await run('systemctl', ['is-active', unit], { timeout: 5000 });
    return r.stdout.trim() === 'active';
}

async function pkgInstalled(name) {
    const r = await run('pacman', ['-Q', name], { timeout: 8000 });
    return r.ok;
}

// Portainer is a container, not a package — its presence is a docker question.
async function containerState(name) {
    const r = await run('docker', ['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.State}}'], { timeout: 15000 });
    if (!r.ok) return { present: false, running: false };
    const s = r.stdout.trim();
    return { present: !!s, running: s === 'running' };
}

const SERVER_APPS = {
    docker: {
        meta: {
            name: 'Docker',
            blurb: 'Runs software in isolated containers. Pterodactyl and Portainer both need it.',
            note: 'Adds a background service. Leave it off until something needs it.',
        },
        install: async () => {
            const r = await pacman(['-S', '--needed', 'docker', 'docker-compose']);
            if (!r.ok) return { ok: false, error: (r.stderr || r.stdout || 'pacman failed').trim().slice(-300) };
            const e = await run('systemctl', ['enable', '--now', 'docker'], { timeout: 60000 });
            if (!e.ok) return { ok: false, error: (e.stderr || 'installed, but the docker service would not start').trim().slice(-300) };
            return { ok: true };
        },
        remove: async () => {
            await run('systemctl', ['disable', '--now', 'docker'], { timeout: 60000 });
            // -Rs removes the package and any dependencies nothing else needs.
            // Images and volumes under /var/lib/docker are deliberately LEFT —
            // silently deleting someone's game-server data because they removed
            // a package would be unforgivable.
            const r = await pacman(['-Rs', 'docker', 'docker-compose']);
            return r.ok
                ? { ok: true, note: 'Docker removed. Container data in /var/lib/docker was left untouched.' }
                : { ok: false, error: (r.stderr || r.stdout || 'pacman failed').trim().slice(-300) };
        },
        setRunning: async (on) => {
            const r = await run('systemctl', [on ? 'start' : 'stop', 'docker'], { timeout: 60000 });
            return r.ok ? { ok: true, running: on } : { ok: false, error: (r.stderr || 'systemctl failed').trim().slice(-250) };
        },
        status: async () => ({ installed: await pkgInstalled('docker'), running: await unitActive('docker') }),
    },

    cockpit: {
        meta: {
            name: 'Cockpit',
            blurb: 'A classic Linux admin console in the browser — users, storage, networking, terminal.',
            note: 'Socket-activated: it uses nothing until you open it.',
        },
        install: async () => {
            const r = await pacman(['-S', '--needed', 'cockpit']);
            if (!r.ok) return { ok: false, error: (r.stderr || r.stdout || 'pacman failed').trim().slice(-300) };
            // The SOCKET, not the service: systemd starts cockpit only when a
            // browser actually connects, so an idle server pays nothing.
            const e = await run('systemctl', ['enable', '--now', 'cockpit.socket'], { timeout: 60000 });
            if (!e.ok) return { ok: false, error: (e.stderr || 'installed, but cockpit.socket would not start').trim().slice(-300) };
            return { ok: true, note: 'Cockpit listens on port 9090. Open the firewall for it if you want it reachable.' };
        },
        remove: async () => {
            await run('systemctl', ['disable', '--now', 'cockpit.socket'], { timeout: 60000 });
            const r = await pacman(['-Rs', 'cockpit']);
            return r.ok ? { ok: true } : { ok: false, error: (r.stderr || r.stdout || 'pacman failed').trim().slice(-300) };
        },
        setRunning: async (on) => {
            const r = await run('systemctl', [on ? 'start' : 'stop', 'cockpit.socket'], { timeout: 60000 });
            return r.ok ? { ok: true, running: on } : { ok: false, error: (r.stderr || 'systemctl failed').trim().slice(-250) };
        },
        status: async () => ({ installed: await pkgInstalled('cockpit'), running: await unitActive('cockpit.socket') }),
    },

    portainer: {
        meta: {
            name: 'Portainer',
            blurb: 'A point-and-click manager for Docker containers, images and volumes.',
            note: 'Needs Docker. Runs as a container itself.',
            requires: 'docker',
        },
        install: async () => {
            if (!await unitActive('docker')) {
                return { ok: false, error: 'Docker must be installed and running first.' };
            }
            const vol = await run('docker', ['volume', 'create', 'portainer_data'], { timeout: 60000 });
            if (!vol.ok) return { ok: false, error: (vol.stderr || 'could not create the portainer_data volume').trim().slice(-300) };
            const r = await run('docker', [
                'run', '-d',
                '--name', 'portainer',
                '--restart=always',
                // Bound to LOOPBACK on purpose. Portainer can control every
                // container on the box, so it does not go on a network
                // interface by default — reach it through the tunnel or an SSH
                // port-forward, exactly like the panel itself.
                '-p', '127.0.0.1:9443:9443',
                '-v', '/var/run/docker.sock:/var/run/docker.sock',
                '-v', 'portainer_data:/data',
                'portainer/portainer-ce:latest',
            ], { timeout: 600000 });
            if (!r.ok) return { ok: false, error: (r.stderr || r.stdout || 'docker run failed').trim().slice(-300) };
            return { ok: true, note: 'Portainer is on https://127.0.0.1:9443 — loopback only, so reach it over your tunnel.' };
        },
        remove: async () => {
            await run('docker', ['rm', '-f', 'portainer'], { timeout: 120000 });
            // The volume holds Portainer's own users/settings, not container
            // data. Still left behind: removing it is not ours to decide.
            return { ok: true, note: 'Portainer removed. Its settings volume (portainer_data) was left in place.' };
        },
        setRunning: async (on) => {
            const r = await run('docker', [on ? 'start' : 'stop', 'portainer'], { timeout: 120000 });
            return r.ok ? { ok: true, running: on } : { ok: false, error: (r.stderr || 'docker failed').trim().slice(-250) };
        },
        status: async () => {
            const c = await containerState('portainer');
            return { installed: c.present, running: c.running };
        },
    },
};

async function serverAppStatus(id, app) {
    if (!IS_LINUX) return { installed: false, running: false, unavailable: true };
    try { return await app.status(); }
    catch (e) { return { installed: false, running: false, error: (e && e.message) || String(e) }; }
}

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
        if (!IS_LINUX) return { ok: true, available: false, filesystems: [], error: 'Runs on Outlaw Server.' };
        // -P = POSIX output (one line per fs, never wrapped) -> safe to parse.
        const r = await run('df', ['-PhT', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'squashfs']);
        if (!r.ok) {
            return {
                ok: true, available: false, filesystems: [],
                error: (r.stderr || r.stdout || 'df did not answer').trim().slice(-200),
            };
        }
        const filesystems = r.stdout.split('\n').slice(1).map((line) => {
            const p = line.trim().split(/\s+/);
            if (p.length < 7) return null;
            return {
                device: p[0], type: p[1], size: p[2], used: p[3],
                avail: p[4], usePct: parseInt(p[5], 10) || 0, mount: p.slice(6).join(' '),
            };
        }).filter(Boolean);
        return { ok: true, available: true, filesystems };
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

    // NOTE the `available` flag. "We couldn't read the service list" and "this
    // machine has no services" are wildly different facts, and an empty array
    // renders identically for both — a reassuring blank screen over a failure.
    // Callers must be able to tell them apart.
    'services:list': async () => {
        if (!IS_LINUX) return { ok: true, available: false, units: [], error: 'Runs on Outlaw Server.' };
        const r = await run('systemctl', [
            'list-units', '--type=service', '--all', '--no-legend', '--no-pager', '--plain',
        ], { timeout: 12000 });
        if (!r.ok) {
            return {
                ok: true, available: false, units: [],
                error: (r.stderr || r.stdout || 'systemctl did not answer').trim().slice(-200),
            };
        }
        const units = r.stdout.split('\n').map((l) => {
            const p = l.trim().split(/\s+/);
            if (p.length < 4) return null;
            return {
                unit: p[0], load: p[1], active: p[2], sub: p[3],
                description: p.slice(4).join(' '),
            };
        }).filter(Boolean);
        return { ok: true, available: true, units };
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
        if (!IS_LINUX) return { ok: true, available: false, lines: [], error: 'Runs on Outlaw Server.' };
        const n = Math.max(10, Math.min(1000, parseInt(lines, 10) || 200));
        const args = ['--no-pager', '-n', String(n), '-o', 'short-iso'];
        if (unit) {
            if (!UNIT_RE.test(String(unit))) return { ok: false, error: 'Invalid unit name.' };
            args.push('-u', unit);
        }
        const r = await run('journalctl', args, { timeout: 15000 });
        // Same reasoning as services:list — an unreadable journal must not be
        // presented as a quiet one.
        if (!r.ok) {
            return {
                ok: true, available: false, lines: [],
                error: (r.stderr || r.stdout || 'journalctl did not answer').trim().slice(-200),
            };
        }
        return { ok: true, available: true, lines: r.stdout.split('\n').filter(Boolean) };
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

    // --- SSH keys -----------------------------------------------------------
    // An authorized_keys line IS a login. Treat this file as the most dangerous
    // thing the panel can write, because it is.
    //
    // The format allows a leading OPTIONS field — command="…", environment="…",
    // permitopen=… — which runs on connect. Accepting a pasted line verbatim
    // would let anything in that field execute as the account. So we accept
    // ONLY a bare "<type> <base64> [comment]" and refuse everything else,
    // including any line that begins with an option. Multi-line input is
    // refused outright: one call, one key.

    'ssh:keys': async () => {
        if (!IS_LINUX) return { ok: true, available: false, keys: [], error: 'Runs on Outlaw Server.' };
        const u = primaryUser();
        if (!u) return { ok: true, available: false, keys: [], error: 'No login account found to read keys for.' };
        const txt = readFileSafe(authorizedKeysPath(u));
        const keys = txt.split('\n').map((line, i) => {
            const t = line.trim();
            if (!t || t.startsWith('#')) return null;
            const parts = t.split(/\s+/);
            return {
                index: i,
                type: parts[0] || '',
                comment: parts.slice(2).join(' '),
                // Short, stable identifier so a key can be recognised without
                // showing the whole blob.
                short: (parts[1] || '').slice(-16),
                valid: SSH_KEY_RE.test(t),
            };
        }).filter(Boolean);
        return { ok: true, available: true, user: u.name, path: authorizedKeysPath(u), keys };
    },

    'ssh:add-key': async (_ctx, { key } = {}) => {
        if (!IS_LINUX) return { ok: false, error: 'Runs on Outlaw Server.' };
        const u = primaryUser();
        if (!u) return { ok: false, error: 'No login account found to add a key to.' };
        const raw = String(key == null ? '' : key).trim();
        if (!raw) return { ok: false, error: 'Paste a public key first.' };
        if (/[\r\n]/.test(raw)) {
            return { ok: false, error: 'That looks like more than one line. Add one key at a time — a second line could smuggle in login options.' };
        }
        if (!SSH_KEY_RE.test(raw)) {
            return {
                ok: false,
                error: 'That is not a plain public key. Expected something like "ssh-ed25519 AAAAC3Nza… you@laptop". '
                     + 'Keys carrying options (command=, environment=, …) are refused on purpose: those run on every login. '
                     + 'Also check you pasted the .pub file and not a PRIVATE key.',
            };
        }
        const p = authorizedKeysPath(u);
        const existing = readFileSafe(p);
        const blob = raw.split(/\s+/)[1];
        if (existing.split('\n').some((l) => l.trim().split(/\s+/)[1] === blob)) {
            return { ok: false, error: 'That key is already authorised.' };
        }
        try {
            fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
            fs.appendFileSync(p, (existing && !existing.endsWith('\n') ? '\n' : '') + raw + '\n', { mode: 0o600 });
            // sshd refuses to use a key file that others can write, and the
            // daemon runs as root — so fix ownership and modes explicitly
            // rather than leaving a file the account can't be trusted with.
            fs.chmodSync(p, 0o600);
            fs.chmodSync(path.dirname(p), 0o700);
            if (Number.isInteger(u.uid) && Number.isInteger(u.gid)) {
                fs.chownSync(path.dirname(p), u.uid, u.gid);
                fs.chownSync(p, u.uid, u.gid);
            }
        } catch (e) {
            return { ok: false, error: 'Could not write the key file: ' + e.message };
        }
        return { ok: true, user: u.name };
    },

    'ssh:remove-key': async (_ctx, { index } = {}) => {
        if (!IS_LINUX) return { ok: false, error: 'Runs on Outlaw Server.' };
        const u = primaryUser();
        if (!u) return { ok: false, error: 'No login account found.' };
        const raw = String(index == null ? '' : index).trim();
        if (!/^\d{1,5}$/.test(raw)) return { ok: false, error: 'Invalid key number.' };
        const n = Number(raw);
        const p = authorizedKeysPath(u);
        const lines = readFileSafe(p).split('\n');
        if (n < 0 || n >= lines.length || !lines[n].trim()) return { ok: false, error: 'No key at that position — reload the list.' };
        lines.splice(n, 1);
        try {
            fs.writeFileSync(p, lines.join('\n').replace(/\n+$/, '\n'), { mode: 0o600 });
            fs.chmodSync(p, 0o600);
            if (Number.isInteger(u.uid) && Number.isInteger(u.gid)) fs.chownSync(p, u.uid, u.gid);
        } catch (e) {
            return { ok: false, error: 'Could not rewrite the key file: ' + e.message };
        }
        return { ok: true, removed: n };
    },

    // --- firewall (ufw) -----------------------------------------------------
    // A game server means opening ports, and opening ports is the single
    // easiest way to turn a private box into a public one by accident. So the
    // rules here are deliberately narrow: numeric ports and tcp/udp only.
    // No "allow from any to any", no service-name lookups, no raw rule strings
    // — anything richer is a job for the terminal, where the person doing it
    // can see exactly what they typed.

    'firewall:status': async () => {
        if (!IS_LINUX) return { ok: true, available: false, active: false, rules: [] };
        const v = await run('ufw', ['status', 'numbered'], { timeout: 10000 });
        if (!v.ok) {
            // Not installed, or we're not root. Both are worth saying out loud
            // rather than rendering an empty (and reassuring) rule list.
            const msg = (v.stderr || v.stdout || '').trim();
            return {
                ok: true, available: false, active: false, rules: [],
                error: /command not found|ENOENT/i.test(msg) ? 'ufw is not installed.'
                    : /root|permission/i.test(msg) ? 'Reading the firewall needs root.'
                        : msg.slice(-200) || 'Could not read the firewall.',
            };
        }
        const out = v.stdout;
        const active = /Status:\s*active/i.test(out);
        const rules = [];
        for (const line of out.split('\n')) {
            // "[ 1] 25565/tcp                  ALLOW IN    Anywhere"
            const m = line.match(/^\s*\[\s*(\d+)\]\s+(.+?)\s{2,}(ALLOW|DENY|REJECT|LIMIT)\s+(IN|OUT)\s*(.*)$/i);
            if (m) rules.push({ num: Number(m[1]), target: m[2].trim(), action: m[3].toUpperCase(), dir: m[4].toUpperCase(), from: (m[5] || '').trim() });
        }
        return { ok: true, available: true, active, rules };
    },

    'firewall:set': async (_ctx, { enabled } = {}) => {
        if (!IS_LINUX) return { ok: false, error: 'Runs on Outlaw Server.' };
        // --force on enable, because ufw otherwise asks an interactive
        // "this may disrupt existing ssh connections" question that nothing is
        // there to answer, and the command would hang until it timed out.
        const args = enabled === false ? ['disable'] : ['--force', 'enable'];
        const r = await run('ufw', args, { timeout: 20000 });
        if (!r.ok) return { ok: false, error: (r.stderr || r.stdout || 'ufw failed').trim().slice(-250) };
        return { ok: true, active: enabled !== false };
    },

    'firewall:allow': async (_ctx, { port, proto, action } = {}) => {
        if (!IS_LINUX) return { ok: false, error: 'Runs on Outlaw Server.' };
        // Whole string or nothing. parseInt() would happily read "2500-2600" as
        // 2500 and "80abc" as 80 — opening a port the person did not ask for
        // while reporting success. On a firewall, quietly acting on a different
        // value than the one typed is the worst possible failure.
        const raw = String(port == null ? '' : port).trim();
        if (!/^\d{1,5}$/.test(raw)) {
            return { ok: false, error: 'Port must be a single whole number from 1 to 65535 (ranges and lists are not supported here — use the terminal).' };
        }
        const p = Number(raw);
        if (p < 1 || p > 65535) return { ok: false, error: 'Port must be a number from 1 to 65535.' };
        const pr = String(proto || 'tcp').toLowerCase();
        if (pr !== 'tcp' && pr !== 'udp') return { ok: false, error: 'Protocol must be tcp or udp.' };
        const act = action === 'deny' ? 'deny' : 'allow';
        const r = await run('ufw', [act, `${p}/${pr}`], { timeout: 15000 });
        if (!r.ok) return { ok: false, error: (r.stderr || r.stdout || 'ufw failed').trim().slice(-250) };
        return { ok: true, rule: `${act} ${p}/${pr}` };
    },

    'firewall:delete': async (_ctx, { num } = {}) => {
        if (!IS_LINUX) return { ok: false, error: 'Runs on Outlaw Server.' };
        // Same strictness as the port: deleting rule 1 when "1x" was meant is
        // an unnoticed hole in the firewall.
        const raw = String(num == null ? '' : num).trim();
        if (!/^\d{1,4}$/.test(raw)) return { ok: false, error: 'Invalid rule number.' };
        const n = Number(raw);
        if (n < 1) return { ok: false, error: 'Invalid rule number.' };
        // Rule numbers shift after every delete, so the caller must be looking
        // at a current list. --force skips the interactive confirmation.
        const r = await run('ufw', ['--force', 'delete', String(n)], { timeout: 15000 });
        if (!r.ok) return { ok: false, error: (r.stderr || r.stdout || 'ufw failed').trim().slice(-250) };
        return { ok: true, deleted: n };
    },

    // --- server software (Phase 5) -----------------------------------------
    // The things a server actually runs, installed on demand so the base image
    // stays small and nobody pays for what they didn't ask for. Every one of
    // these is removable — that was a hard requirement, not a nicety.
    //
    // These are the ONLY package names this daemon will ever install. It is a
    // fixed allowlist, not a caller-supplied name: "install whatever the panel
    // asks for" would turn a signed-in session into arbitrary root package
    // installation.

    // Pterodactyl is installed by /usr/local/bin/outlaw-pterodactyl, not from
    // here. It is a ten-minute job that asks questions (the first admin's
    // username and password) and must be watchable while it runs — driving that
    // through a web request would mean a spinner over a process nobody can see,
    // and no way to answer it. The panel reports STATUS and hands over the exact
    // command; the script is readable, re-runnable, and stops at the first
    // failure with the real error.
    'ptero:status': async () => {
        if (!IS_LINUX) return { ok: true, available: false, error: 'Runs on Outlaw Server.' };
        const r = await run('/usr/local/bin/outlaw-pterodactyl', ['status'], { timeout: 20000 });
        if (!r.ok) {
            return { ok: true, available: false, error: (r.stderr || r.stdout || 'could not read Pterodactyl status').trim().slice(-200) };
        }
        const out = r.stdout;
        return {
            ok: true,
            available: true,
            panelInstalled: /Panel\s*:\s*installed/.test(out),
            wingsPresent: /wings\s*:/.test(out),
            report: out.trim(),
        };
    },

    'apps:catalog': async () => {
        const out = [];
        for (const [id, app] of Object.entries(SERVER_APPS)) {
            const st = await serverAppStatus(id, app);
            out.push({ id, ...app.meta, ...st });
        }
        // Carry a reason with `available:false` — a bare flag makes the UI say
        // "unknown", which tells nobody anything.
        return IS_LINUX
            ? { ok: true, available: true, apps: out }
            : { ok: true, available: false, apps: out, error: 'Runs on Outlaw Server.' };
    },

    'apps:install': async (_ctx, { id } = {}) => {
        const app = SERVER_APPS[String(id || '')];
        if (!app) return { ok: false, error: 'Unknown application.' };
        if (!IS_LINUX) return { ok: false, error: 'Runs on Outlaw Server.' };
        return app.install();
    },

    'apps:remove': async (_ctx, { id } = {}) => {
        const app = SERVER_APPS[String(id || '')];
        if (!app) return { ok: false, error: 'Unknown application.' };
        if (!IS_LINUX) return { ok: false, error: 'Runs on Outlaw Server.' };
        return app.remove();
    },

    // Start/stop without uninstalling — the "disable to save resources" path.
    'apps:set-running': async (_ctx, { id, running } = {}) => {
        const app = SERVER_APPS[String(id || '')];
        if (!app) return { ok: false, error: 'Unknown application.' };
        if (!IS_LINUX) return { ok: false, error: 'Runs on Outlaw Server.' };
        return app.setRunning(running !== false);
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
            phase: 5,
            note: 'Phase 5: the full server toolset, one-click Docker/Portainer/Cockpit, and a guided Pterodactyl install (outlaw-pterodactyl).',
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
