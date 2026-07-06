// ============================================================================
// Outlaw OS — combined error/warning log (F1).
// ----------------------------------------------------------------------------
// ONE log for the whole system — the desktop shell, the dev session (CodeMaker
// appends to the SAME file), Xorg/session stderr, and the journal. Records only
// errors + warnings, persists across sessions, and DEDUPES (the same line is
// never stored twice). Designed to be downloaded or turned into a prefilled
// GitHub issue so the maintainer can see real failures without the user typing
// them out. Best-effort throughout — logging must never itself crash anything.
// ============================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

// $HOME so it survives updates AND is shared by both sessions (CodeMaker writes
// here too). Both sessions run as the same user.
const LOG_PATH = path.join(os.homedir(), '.outlaw-errors.log');
const MAX_LINES = 3000;

// #6 — the dedup set holds STABLE content keys (sha1 of the normalized body), so
// the SAME logical error is stored once even across (a) shell restarts and (b)
// the two writers — the desktop shell (this file) AND Outlaw CodeMaker (Python,
// main.py). Both must compute the key identically: normalize the body the same way
// and sha1 it. A process-local hash (the old JS imul / Python hash()) could never
// match between the two writers, so the same error appeared twice in one report.
const _seen = new Set();

// Stable, language-agnostic content key. Mirror in CodeMaker's _SharedErrorLogHandler.
function _key(body) {
    return crypto.createHash('sha1').update(String(body)).digest('hex');
}

// Recover the dedup body ("source: message") from a stored line of the shared
// format `[<iso>] <LEVEL> <source>: <message>` — strip the bracketed timestamp
// AND the single LEVEL token after it. Must match emit-time body exactly (and the
// Python side's parse) so seeding from disk dedups against fresh writes.
function _lineBody(line) {
    return String(line).replace(/^\[[^\]]*\]\s*\S+\s*/, '').trim();
}

// Seed the dedup set from whatever is already on disk so restarts (and the other
// writer's lines) don't re-add.
(function loadSeen() {
    try {
        const txt = fs.readFileSync(LOG_PATH, 'utf8');
        for (const line of txt.split('\n')) {
            const body = _lineBody(line);
            if (body) _seen.add(_key(body));
        }
    } catch { /* no file yet */ }
})();

function _trim() {
    try {
        const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n');
        if (lines.length > MAX_LINES + 200) {
            fs.writeFileSync(LOG_PATH, lines.slice(-MAX_LINES).join('\n'));
        }
    } catch { /* ignore */ }
}

// Append one error/warning. level e.g. 'error'|'warn'; source e.g. 'shell-main'.
function append(level, source, message) {
    try {
        const msg = String(message == null ? '' : message).replace(/\s+/g, ' ').trim().slice(0, 600);
        if (!msg) return;
        const body = `${source}: ${msg}`;
        const key = _key(body);
        if (_seen.has(key)) return;   // dedup — never the same entry twice
        _seen.add(key);
        fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${String(level).toUpperCase()} ${body}\n`);
        _trim();
    } catch { /* logging must never throw */ }
}

// A "cleared watermark" sidecar. When the user clicks Clear we record WHEN (epoch
// seconds) + how far into the session X log we'd read, so a later collect() only
// pulls journal/Xorg entries from AFTER the clear. Without this, collect() re-scraped
// the whole boot journal every time and the errors the user just cleared (often ones
// they ALREADY reported) flooded straight back in.
const CLEAR_MARK = path.join(os.homedir(), '.outlaw-errors.cleared');
const _xlogPath = path.join(os.homedir(), '.outlaw-x.log');

function _readMark() {
    try { return JSON.parse(fs.readFileSync(CLEAR_MARK, 'utf8')); } catch { return null; }
}

// Scrape error/warning lines out of the X/session log + the journal into the
// combined log (so a crash that bounced the user to the picker is captured).
function collect() {
    const mark = _readMark();
    // Session stderr (the .xinitrc redirects Electron/X stderr here). Only the part
    // AFTER the last clear — if the file shrank since (new session / rotation), read all.
    try {
        const buf = fs.readFileSync(_xlogPath, 'utf8');
        let text = buf;
        if (mark && Number.isFinite(mark.xlogOffset) && mark.xlogOffset > 0 && mark.xlogOffset <= buf.length) {
            text = buf.slice(mark.xlogOffset);
        }
        for (const line of text.split('\n')) {
            if (/\b(error|fail|failed|fatal|cannot|unable|segfault|traceback|warn|denied|refused)\b/i.test(line)) {
                append('session', 'xorg', line);
            }
        }
    } catch { /* no x log */ }
    return new Promise((resolve) => {
        try {
            // journalctl: since the clear watermark if we have one (@epoch is
            // timezone-proof), else the last 250 warnings of this boot.
            const args = ['-b', '-p', 'warning', '--no-pager', '-o', 'cat'];
            if (mark && Number.isFinite(mark.epoch)) args.push('--since', '@' + mark.epoch);
            else args.push('-n', '250');
            execFile('journalctl', args, { timeout: 6000 }, (_e, out) => {
                if (out) for (const line of String(out).split('\n')) {
                    if (line.trim()) append('journal', 'system', line);
                }
                resolve(read());
            });
        } catch { resolve(read()); }
    });
}

function read() {
    try { return fs.readFileSync(LOG_PATH, 'utf8'); } catch { return ''; }
}

function clear() {
    try {
        fs.writeFileSync(LOG_PATH, '');
        _seen.clear();
        // Drop a watermark so a later collect() won't re-scrape pre-clear journal /
        // Xorg lines back in — the whole point of Clear is that already-reported
        // errors stay gone and only NEW ones show up from here on.
        let xlogOffset = 0;
        try { xlogOffset = fs.statSync(_xlogPath).size; } catch { /* no x log yet */ }
        fs.writeFileSync(CLEAR_MARK, JSON.stringify({ epoch: Math.floor(Date.now() / 1000), xlogOffset }));
    } catch { /* ignore */ }
}

// Build a prefilled GitHub "new issue" URL from the most recent log lines. No
// token needed — it just opens the issue form in the browser with the body
// filled in. `repo` is "owner/name".
function issueUrl(repo, version) {
    const tail = read().split('\n').slice(-120).join('\n').slice(-5500);
    const title = `Outlaw OS error report (v${version || '?'})`;
    const body = `**Auto-collected error/warning log** (v${version || '?'}):\n\n\`\`\`\n${tail || '(empty)'}\n\`\`\`\n`;
    const base = `https://github.com/${repo || 'Sup095/Outlaw-Game-OS'}/issues/new`;
    return `${base}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

module.exports = { append, collect, read, clear, issueUrl, LOG_PATH };
