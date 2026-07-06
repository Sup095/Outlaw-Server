#!/usr/bin/env node
// ============================================================================
// Outlaw OS - Diagnostics CLI (SC4)
// ----------------------------------------------------------------------------
// Standalone Node entry point for the scheduled diagnostic timers. Runs the
// SAME tests as the in-shell `DiagnosticRunner` (via require('./diagnostics'))
// so there is exactly one place to add or change a check. The shell version
// gets streaming events; this version gets stdout progress + a notify-send
// pop on warn/fail.
//
// Invoked by either:
//   * /usr/local/bin/outlaw-diagnose <profile>          (terminal / scripts)
//   * outlaw-diagnose@<profile>.service                 (systemd timers)
//
// The shell payload lives at /usr/share/outlaw-os/, so requires resolve
// relative to this file. Reports land in ~/.outlaw-diagnostics/ — the same
// directory the in-shell runs use, so the history dropdown shows both.
// ============================================================================

'use strict';

const { spawn } = require('child_process');
const path = require('path');

// Load the same module the Electron shell uses. Because diagnostics-cli.js is
// bundled into /usr/share/outlaw-os/ alongside diagnostics.js, the relative
// require resolves cleanly on a real install AND during dev (running this
// script from the outlaw-shell directory).
const { DiagnosticRunner, PROFILE_TIER, REPORTS_DIR } = require('./diagnostics');


// ---------------------------------------------------------------------------
// Minimal runShell — no Electron dependency. Matches the shape diagnostics.js
// expects: ({stdout, stderr, code}).
// ---------------------------------------------------------------------------
function runShell(command, { timeout = 30000 } = {}) {
    return new Promise((resolve) => {
        const child = spawn('bash', ['-c', command], {
            cwd: process.env.HOME || '/tmp',
            env: process.env,
        });
        let stdout = '', stderr = '';
        const killer = setTimeout(() => child.kill('SIGKILL'), timeout);
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('close', (code) => {
            clearTimeout(killer);
            resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
        });
        child.on('error', (err) => {
            clearTimeout(killer);
            resolve({ code: 1, stdout: '', stderr: err.message });
        });
    });
}


// ---------------------------------------------------------------------------
// notify-send wrapper — silent if not installed (some minimal WMs lack it).
// ---------------------------------------------------------------------------
function notify(urgency, summary, body) {
    return new Promise((resolve) => {
        const child = spawn('notify-send', [
            '--app-name=Outlaw OS',
            `--urgency=${urgency}`,
            summary,
            body || '',
        ], { stdio: 'ignore' });
        child.on('error', () => resolve());   // notify-send missing — silent
        child.on('close', () => resolve());
    });
}


// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv) {
    const profile = (argv[0] || 'quick').toLowerCase();
    if (!PROFILE_TIER[profile]) {
        console.error(`outlaw-diagnose: unknown profile '${profile}'`);
        console.error(`  valid: ${Object.keys(PROFILE_TIER).join(', ')}`);
        process.exit(2);
    }

    const runner = new DiagnosticRunner({ runShell });

    // Optional --json switch silences the human-friendly line output.
    const quiet = argv.includes('--json');
    if (!quiet) {
        runner.on('progress', (ev) => {
            if (ev.phase === 'start') {
                console.log(`▶ Starting ${ev.profile} sweep (${ev.total} test(s))`);
            } else if (ev.phase === 'test-start') {
                process.stdout.write(`  · ${ev.label || ev.name} …`);
            } else if (ev.phase === 'test-done') {
                const s = (ev.result.status || 'skip').toUpperCase();
                const sym = { PASS: '✓', WARN: '⚠', FAIL: '✕', SKIP: '–' }[s] || '·';
                console.log(` ${sym} ${s.toLowerCase()} (${ev.result.durationMs}ms)`);
                if (ev.result.detail) console.log(`       ${ev.result.detail}`);
            } else if (ev.phase === 'done') {
                const s = ev.report.summary;
                console.log(
                    `\n${s.pass} pass · ${s.warn} warn · ${s.fail} fail · ${s.skip} skip`,
                );
                console.log(`Saved → ${ev.report.savedTo || REPORTS_DIR}`);
            }
        });
    }

    const report = await runner.run(profile);

    if (quiet) {
        // Emit a minimal status line for scripts piping us.
        process.stdout.write(JSON.stringify({
            profile, summary: report.summary, savedTo: report.savedTo,
        }) + '\n');
    }

    // Notification policy: silent on a clean pass, low urgency on warnings,
    // critical urgency on failures. Tests-all-skipped (off-OS preview) gets a
    // gentle low-urgency note so the user can tell the timer fired.
    const { pass = 0, warn = 0, fail = 0, skip = 0 } = report.summary;
    if (fail > 0) {
        const firstFail = report.results.find((r) => r.status === 'fail');
        await notify('critical',
            `Outlaw OS · ${profile} diagnostic · ${fail} failure(s)`,
            firstFail ? `${firstFail.label}: ${firstFail.detail}` : '');
    } else if (warn > 0) {
        const firstWarn = report.results.find((r) => r.status === 'warn');
        await notify('normal',
            `Outlaw OS · ${profile} diagnostic · ${warn} warning(s)`,
            firstWarn ? `${firstWarn.label}: ${firstWarn.detail}` : '');
    } else if (pass + warn === 0 && skip > 0) {
        await notify('low',
            `Outlaw OS · ${profile} diagnostic skipped`,
            'No tests applicable on this platform.');
    }
    // All-pass: no notification (don't pester the user with good news).

    // Exit code reflects worst result so cron-like consumers can fan out.
    if (fail > 0) process.exit(1);
    if (warn > 0) process.exit(2);
    process.exit(0);
}


main(process.argv.slice(2)).catch((err) => {
    console.error('outlaw-diagnose: ' + (err && err.message ? err.message : err));
    process.exit(3);
});
