// ============================================================================
// Outlaw OS - System Core diagnostics (SC3)
// ----------------------------------------------------------------------------
// Three-tier test runner: Quick (~30s), Standard (~2min), Thorough (~10min).
// Each tier is a superset of the previous one — Standard runs Quick's tests
// plus its own, etc. — so the user never has to wait for Standard to also
// cover what Quick already covered.
//
// Design rules:
//   * Tests are plain async functions returning {status, detail, hint?}.
//     status ∈ {pass, warn, fail, skip}. 'skip' means the test was not
//     applicable (e.g., clamscan not installed) — never counted as a failure.
//   * The runner is sequential by default. Some tests are intentionally slow
//     (smartctl, clamscan); running them in parallel would saturate the
//     system and obscure individual results.
//   * Every test has a hard timeout. A wedged test never blocks the next one.
//   * Off-Linux every test returns 'skip' with a clear note so the screen
//     still renders cleanly during dev on Windows / macOS.
//   * Reports persist to ~/.outlaw-diagnostics/report-<iso>.json. Filesystem
//     rather than a DB so a corrupted/missing sqlite never loses the history.
// ============================================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const IS_LINUX = process.platform === 'linux';
const REPORTS_DIR = path.join(os.homedir(), '.outlaw-diagnostics');


// ---------------------------------------------------------------------------
// Test catalogue
// ---------------------------------------------------------------------------
//
// Tests are registered with the lowest tier they belong to. The runner pulls
// `tier <= profile` for each profile.
//   tier=1 → Quick
//   tier=2 → Standard
//   tier=3 → Thorough
//
// The `fn` receives `({ runShell })` so the module is dependency-injection
// friendly — main.js's existing `runShell` wrapper is the only thing tests
// touch outside the standard library.

function _statusFrom(out, regexes) {
    // Tiny helper: classify a shell exit + stdout against ok/warn/fail regexes.
    if (regexes.fail && regexes.fail.test(out)) return 'fail';
    if (regexes.warn && regexes.warn.test(out)) return 'warn';
    return 'pass';
}


const TESTS = [
    // ----- Tier 1 (Quick) ----------------------------------------------------

    {
        tier: 1,
        name: 'apparmor-active',
        label: 'AppArmor enforcement',
        timeout: 5000,
        fn: async ({ runShell }) => {
            const r = await runShell('systemctl is-active apparmor', { timeout: 4000 });
            const active = (r.stdout || '').trim() === 'active';
            return {
                status: active ? 'pass' : 'warn',
                detail: active
                    ? 'AppArmor is active.'
                    : `AppArmor reports: ${(r.stdout || r.stderr || 'unknown').trim()}`,
                hint: active ? '' : 'Run `sudo systemctl enable --now apparmor` to enable it.',
            };
        },
    },

    {
        tier: 1,
        name: 'ufw-active',
        label: 'Firewall (ufw)',
        timeout: 5000,
        fn: async ({ runShell }) => {
            const r = await runShell('ufw status 2>/dev/null | head -n 1', { timeout: 4000 });
            const out = (r.stdout || '').trim();
            // /active/i would falsely match "Status: inactive". Require a word
            // boundary and explicitly check for the negation first.
            const inactive = /\binactive\b/i.test(out);
            const active = !inactive && /\bactive\b/i.test(out);
            return {
                status: active ? 'pass' : 'warn',
                detail: out || 'No ufw output.',
                hint: active ? '' : 'Enable with `sudo ufw enable`.',
            };
        },
    },

    {
        tier: 1,
        name: 'ram-free',
        label: 'Free RAM headroom',
        timeout: 3000,
        fn: async () => {
            try {
                const text = fs.readFileSync('/proc/meminfo', 'utf8');
                const get = (k) => {
                    const m = text.match(new RegExp(`${k}:\\s+(\\d+)\\s*kB`));
                    return m ? Number(m[1]) : 0;
                };
                const totalKb = get('MemTotal');
                const availKb = get('MemAvailable');
                if (!totalKb) {
                    return { status: 'skip', detail: 'meminfo unavailable' };
                }
                const availMb = Math.round(availKb / 1024);
                const pctAvail = (availKb / totalKb) * 100;
                let status = 'pass';
                if (pctAvail < 5) status = 'fail';
                else if (pctAvail < 15) status = 'warn';
                return {
                    status,
                    detail: `${availMb} MB available · ${pctAvail.toFixed(1)}% of total`,
                    hint: status !== 'pass' ? 'Close heavy apps or add swap.' : '',
                };
            } catch (e) {
                return { status: 'skip', detail: 'meminfo read failed: ' + e.message };
            }
        },
    },

    {
        tier: 1,
        name: 'root-disk-space',
        label: 'Root partition free space',
        timeout: 4000,
        fn: async ({ runShell }) => {
            const r = await runShell('df -P / | tail -n 1', { timeout: 3000 });
            const m = (r.stdout || '').match(/\s+(\d+)%\s+\/$/);
            if (!m) return { status: 'skip', detail: 'df output unparseable' };
            const pct = Number(m[1]);
            let status = 'pass';
            if (pct >= 97) status = 'fail';
            else if (pct >= 90) status = 'warn';
            return {
                status,
                detail: `${pct}% used`,
                hint: status === 'pass' ? '' : 'Free space (clean ~/Downloads, prune snapshots, run `pacman -Sc`).',
            };
        },
    },

    {
        tier: 1,
        name: 'smart-health',
        label: 'Disk SMART health',
        timeout: 8000,
        fn: async ({ runShell }) => {
            // Pick the first plausible block device under /dev. We can't rely
            // on smartctl scanning all of them in 8s, so just probe the root
            // device's parent disk.
            const root = await runShell(
                "lsblk -ndo PKNAME $(findmnt -no SOURCE /) 2>/dev/null",
                { timeout: 3000 },
            );
            const dev = (root.stdout || '').trim();
            if (!dev) {
                return { status: 'skip', detail: 'could not identify root disk' };
            }
            const r = await runShell(`sudo -n smartctl --health /dev/${dev} 2>&1 | tail -n 5`,
                { timeout: 7000 });
            const out = (r.stdout || '').trim();
            if (/password required|sudo:/i.test(out)) {
                return {
                    status: 'skip',
                    detail: 'smartctl needs sudo without password prompt',
                    hint: 'Add `%wheel ALL=(ALL) NOPASSWD: /usr/bin/smartctl` to /etc/sudoers.d/ if you want unattended SMART checks.',
                };
            }
            if (!out) {
                return { status: 'skip', detail: 'smartctl not installed or no SMART support' };
            }
            const passed = /SMART overall-health self-assessment test result: PASSED/i.test(out);
            const failed = /FAILED/i.test(out);
            return {
                status: failed ? 'fail' : passed ? 'pass' : 'warn',
                detail: out.split('\n').slice(-2).join(' · ').slice(0, 200),
            };
        },
    },

    {
        tier: 1,
        name: 'pacman-verify-quick',
        label: 'Package integrity (sample)',
        timeout: 25000,
        fn: async ({ runShell }) => {
            // Sample the first ~60 packages — full verify lives in tier 3.
            const r = await runShell(
                'pacman -Q 2>/dev/null | head -n 60 | awk "{print $1}" | xargs pacman -Qkk 2>&1 | grep -Ev "^[^ ]+: 0 missing files|^[^ ]+: [0-9]+ total files," | head -n 50',
                { timeout: 24000 },
            );
            const out = (r.stdout || '').trim();
            if (!out) {
                return { status: 'pass', detail: 'Sample of 60 packages — all files match.' };
            }
            const warnings = (out.match(/warning:/gi) || []).length;
            const errors = (out.match(/(error|missing)/gi) || []).length;
            return {
                status: errors > 0 ? 'fail' : warnings > 0 ? 'warn' : 'pass',
                detail: `${warnings} warning(s) · ${errors} error(s) across the sample`,
                hint: errors > 0 ? 'Run thorough sweep for the full picture, then `sudo pacman -S <pkg>` to repair.' : '',
            };
        },
    },

    // ----- Tier 2 (Standard) -------------------------------------------------

    {
        tier: 2,
        name: 'swap-usage',
        label: 'Swap pressure',
        timeout: 3000,
        fn: async () => {
            try {
                const text = fs.readFileSync('/proc/meminfo', 'utf8');
                const get = (k) => {
                    const m = text.match(new RegExp(`${k}:\\s+(\\d+)\\s*kB`));
                    return m ? Number(m[1]) : 0;
                };
                const swapTotal = get('SwapTotal');
                const swapFree = get('SwapFree');
                if (!swapTotal) {
                    return { status: 'skip', detail: 'No swap configured.' };
                }
                const usedKb = swapTotal - swapFree;
                const pct = (usedKb / swapTotal) * 100;
                let status = 'pass';
                if (pct > 60) status = 'warn';
                if (pct > 90) status = 'fail';
                return {
                    status,
                    detail: `${Math.round(usedKb / 1024)} MB used · ${pct.toFixed(1)}% of swap`,
                    hint: status !== 'pass' ? 'Heavy swap = system trashing; close apps or grow RAM.' : '',
                };
            } catch (e) {
                return { status: 'skip', detail: 'meminfo read failed' };
            }
        },
    },

    {
        tier: 2,
        name: 'smart-attributes',
        label: 'SMART reallocated + pending sectors',
        timeout: 12000,
        fn: async ({ runShell }) => {
            const root = await runShell(
                "lsblk -ndo PKNAME $(findmnt -no SOURCE /) 2>/dev/null",
                { timeout: 3000 },
            );
            const dev = (root.stdout || '').trim();
            if (!dev) return { status: 'skip', detail: 'could not identify root disk' };
            const r = await runShell(
                `sudo -n smartctl -A /dev/${dev} 2>&1 | grep -E "Reallocated_Sector_Ct|Current_Pending_Sector|Offline_Uncorrectable" || true`,
                { timeout: 10000 },
            );
            const out = (r.stdout || '').trim();
            if (/password required|sudo:/i.test(out)) {
                return { status: 'skip', detail: 'sudo password required for smartctl' };
            }
            if (!out) return { status: 'skip', detail: 'no SMART attributes available' };
            let worst = 0;
            const reasons = [];
            for (const line of out.split('\n')) {
                const m = line.trim().match(/^\s*\d+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\d+)/);
                if (m) {
                    const v = Number(m[1]);
                    worst = Math.max(worst, v);
                    if (v > 0) reasons.push(line.trim().slice(0, 60));
                }
            }
            const status = worst === 0 ? 'pass' : worst < 10 ? 'warn' : 'fail';
            return {
                status,
                detail: worst === 0 ? 'All counters at 0.' : `worst counter: ${worst}`,
                hint: worst > 0 ? 'Reallocated/pending sectors are a sign the disk is dying — back up soon.' : '',
            };
        },
    },

    {
        tier: 2,
        name: 'journal-recent-errors',
        label: 'System errors (last hour)',
        timeout: 6000,
        fn: async ({ runShell }) => {
            const r = await runShell(
                'journalctl --priority=err --since "1 hour ago" --no-pager 2>/dev/null | wc -l',
                { timeout: 5000 },
            );
            const n = Number((r.stdout || '0').trim()) || 0;
            const status = n === 0 ? 'pass' : n < 20 ? 'warn' : 'fail';
            return {
                status,
                detail: `${n} priority=err entries`,
                hint: n > 0 ? 'Inspect via `journalctl -p err --since "1 hour ago"`.' : '',
            };
        },
    },

    {
        tier: 2,
        name: 'cpu-temperature',
        label: 'CPU temperature',
        timeout: 5000,
        fn: async ({ runShell }) => {
            const r = await runShell('sensors -u 2>/dev/null | grep -E "Tctl_input|Package id 0_input|temp1_input" | head -n 1',
                { timeout: 4000 });
            const m = (r.stdout || '').match(/(\d+\.\d+)/);
            if (!m) return { status: 'skip', detail: 'sensors / lm_sensors not installed' };
            const temp = Number(m[1]);
            let status = 'pass';
            if (temp > 90) status = 'fail';
            else if (temp > 80) status = 'warn';
            return {
                status,
                detail: `${temp.toFixed(1)} °C`,
                hint: status !== 'pass' ? 'Check fans/dust/thermal paste.' : '',
            };
        },
    },

    // ----- Tier 3 (Thorough) -------------------------------------------------

    {
        tier: 3,
        name: 'pacman-verify-full',
        label: 'Package integrity (full)',
        timeout: 5 * 60 * 1000,  // 5 min ceiling
        fn: async ({ runShell }) => {
            const r = await runShell(
                'pacman -Qkk 2>&1 | grep -Ev "^[^ ]+: 0 missing files|^[^ ]+: [0-9]+ total files," | head -n 200',
                { timeout: 4.5 * 60 * 1000 },
            );
            const out = (r.stdout || '').trim();
            if (!out) return { status: 'pass', detail: 'Every installed package matches its manifest.' };
            const warnings = (out.match(/warning:/gi) || []).length;
            const errors = (out.match(/(error|missing)/gi) || []).length;
            return {
                status: errors > 0 ? 'fail' : warnings > 0 ? 'warn' : 'pass',
                detail: `${warnings} warning(s) · ${errors} error(s)`,
                hint: errors > 0 ? 'Reinstall affected packages: `sudo pacman -S <name>`.' : '',
            };
        },
    },

    {
        tier: 3,
        name: 'journal-day-errors',
        label: 'System errors (last 24h)',
        timeout: 8000,
        fn: async ({ runShell }) => {
            const r = await runShell(
                'journalctl --priority=err --since "1 day ago" --no-pager 2>/dev/null | wc -l',
                { timeout: 7000 },
            );
            const n = Number((r.stdout || '0').trim()) || 0;
            const status = n < 50 ? 'pass' : n < 500 ? 'warn' : 'fail';
            return {
                status,
                detail: `${n} priority=err entries today`,
            };
        },
    },

    {
        tier: 3,
        name: 'clamav-scan-home',
        label: 'ClamAV scan of ~/Downloads + ~/Desktop',
        timeout: 5 * 60 * 1000,
        fn: async ({ runShell }) => {
            const hasClam = await runShell('command -v clamscan', { timeout: 2000 });
            if (!hasClam.stdout.trim()) {
                return {
                    status: 'skip',
                    detail: 'clamscan not installed',
                    hint: 'Install via Apps → Security → ClamAV (or `sudo pacman -S clamav`).',
                };
            }
            // Best-effort signature freshness — don't fail the test on it.
            const r = await runShell(
                'clamscan --recursive --quiet --no-summary --infected ' +
                '"$HOME/Downloads" "$HOME/Desktop" 2>/dev/null || true',
                { timeout: 4.5 * 60 * 1000 },
            );
            const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
            if (lines.length === 0) {
                return { status: 'pass', detail: 'No infections found.' };
            }
            return {
                status: 'fail',
                detail: `${lines.length} infected file(s) — first: ${lines[0].slice(0, 120)}`,
                hint: 'Move to quarantine and run `freshclam` to ensure signatures are current.',
            };
        },
    },
];


function _summarize(results) {
    const counts = { pass: 0, warn: 0, fail: 0, skip: 0, cancelled: 0 };
    for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
    return counts;
}


// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------


class DiagnosticRunner extends EventEmitter {
    constructor({ runShell }) {
        super();
        if (typeof runShell !== 'function') {
            throw new Error('DiagnosticRunner needs a runShell({command, timeout}) → Promise<{stdout,stderr,code}> dependency.');
        }
        this._runShell = runShell;
        this._abort = false;
        this._running = false;
        this._currentProfile = null;
        this._currentIdx = -1;
        this._currentTotal = 0;
        this._results = [];
    }

    state() {
        return {
            running: this._running,
            profile: this._currentProfile,
            idx: this._currentIdx,
            total: this._currentTotal,
            results: this._results.slice(),
        };
    }

    abort() {
        if (this._running) this._abort = true;
    }

    async run(profile) {
        if (this._running) {
            throw new Error('A diagnostic run is already in progress.');
        }
        const tier = PROFILE_TIER[profile];
        if (!tier) throw new Error(`Unknown diagnostic profile: ${profile}`);

        const tests = TESTS.filter((t) => t.tier <= tier);
        this._running = true;
        this._abort = false;
        this._currentProfile = profile;
        this._currentIdx = -1;
        this._currentTotal = tests.length;
        this._results = [];

        const startedAt = Date.now();
        this._emit('start', { profile, total: tests.length, started: startedAt });

        try {
            for (let i = 0; i < tests.length; i++) {
                if (this._abort) {
                    this._results.push({
                        name: 'cancelled', label: 'Cancelled by user',
                        status: 'cancelled', detail: 'Aborted before remaining tests ran.',
                        durationMs: 0,
                    });
                    this._emit('cancelled', { idx: i, total: tests.length });
                    break;
                }
                const test = tests[i];
                this._currentIdx = i;
                this._emit('test-start', { idx: i, total: tests.length, name: test.name, label: test.label });
                const tStart = Date.now();
                const result = await this._runOne(test);
                result.durationMs = Date.now() - tStart;
                this._results.push(result);
                this._emit('test-done', { idx: i, total: tests.length, result });
            }

            const report = {
                profile,
                tier,
                started: new Date(startedAt).toISOString(),
                elapsedMs: Date.now() - startedAt,
                hostname: os.hostname(),
                summary: _summarize(this._results),
                results: this._results,
            };
            let savedTo = null;
            try {
                savedTo = await this._saveReport(report);
                report.savedTo = savedTo;
            } catch (e) {
                this.emit('save-failed', e);
            }
            this._emit('done', { report });
            return report;
        } finally {
            this._running = false;
            this._currentProfile = null;
            this._currentIdx = -1;
            this._currentTotal = 0;
        }
    }

    async _runOne(test) {
        if (!IS_LINUX) {
            return {
                name: test.name, label: test.label,
                status: 'skip',
                detail: 'Diagnostics run on Outlaw OS (Linux).',
            };
        }
        const timeoutMs = test.timeout || 15000;
        try {
            const result = await Promise.race([
                test.fn({ runShell: this._runShell }),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('test exceeded ' + timeoutMs + 'ms')), timeoutMs)),
            ]);
            return {
                name: test.name, label: test.label,
                status: (result && result.status) || 'skip',
                detail: (result && result.detail) || '',
                hint: (result && result.hint) || '',
            };
        } catch (e) {
            return {
                name: test.name, label: test.label,
                status: 'fail',
                detail: 'Test errored: ' + (e && e.message ? e.message : String(e)),
            };
        }
    }

    _emit(phase, payload) {
        this.emit('progress', { phase, ...payload });
    }

    async _saveReport(report) {
        await fs.promises.mkdir(REPORTS_DIR, { recursive: true });
        const stamp = report.started.replace(/[:.]/g, '-');
        const filename = `report-${stamp}-${report.profile}.json`;
        const target = path.join(REPORTS_DIR, filename);
        await fs.promises.writeFile(target, JSON.stringify(report, null, 2), 'utf8');
        await this._prune();
        return target;
    }

    async _prune(keepCount = 30) {
        try {
            const files = (await fs.promises.readdir(REPORTS_DIR))
                .filter((f) => f.startsWith('report-') && f.endsWith('.json'))
                .sort();  // ISO timestamps sort lexically
            const drop = files.length - keepCount;
            for (let i = 0; i < drop; i++) {
                await fs.promises.unlink(path.join(REPORTS_DIR, files[i])).catch(() => {});
            }
        } catch { /* prune is best-effort */ }
    }
}


const PROFILE_TIER = { quick: 1, standard: 2, thorough: 3 };


async function listReports() {
    try {
        const files = (await fs.promises.readdir(REPORTS_DIR))
            .filter((f) => f.startsWith('report-') && f.endsWith('.json'))
            .sort()
            .reverse();
        return files.slice(0, 30);
    } catch {
        return [];
    }
}


async function readReport(filename) {
    // Defence in depth: refuse path traversal.
    if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        throw new Error('Invalid report name.');
    }
    const target = path.join(REPORTS_DIR, filename);
    const text = await fs.promises.readFile(target, 'utf8');
    return JSON.parse(text);
}


module.exports = {
    DiagnosticRunner,
    listReports,
    readReport,
    REPORTS_DIR,
    PROFILE_TIER,
    // Exposed for tests / future expansion
    _TESTS: TESTS,
    _summarize,
};
