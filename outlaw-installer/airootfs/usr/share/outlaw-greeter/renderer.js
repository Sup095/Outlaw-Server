// ============================================================================
// Outlaw OS — Session greeter (renderer)
// CSP-safe: no inline handlers. Click/key handlers wire up to the chooser.
// Phase 8: a skippable cinematic boot intro + an optional "check this PC"
// pre-flight. Both are heavily guarded — the session chooser is ALWAYS reachable
// (a hard timeout reveals it no matter what, and any key/click skips the intro).
// ============================================================================
'use strict';

const api = window.greeter;

// Phase 14h — match the chooser's palette to the desktop's chosen theme (passed
// in via the loadFile query, mirrored from ~/.outlaw-theme). 'green' is the
// default and needs no class. The boot intro stays green (a fixed identity
// moment) and hides the chooser until now, so this never flashes.
(function applyTheme() {
    try {
        const t = new URLSearchParams(location.search).get('theme');
        if (t === 'gold' || t === 'broken') document.body.classList.add('theme-' + t);
    } catch { /* default green */ }
})();

let introActive = !!document.getElementById('boot-intro');
let locked = false;       // PIN gate up — block the chooser until unlocked
let finishing = false;    // ensure the intro→gate transition runs once
let pinBuf = '';          // entered PIN digits
let pwMode = false;       // account-password fallback mode

const _esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function revealChooser() {
    locked = false;
    const first = document.querySelector('[data-choice="dev"]');
    if (first) first.focus();
}

// Intro is over — decide whether to show the PIN gate or the chooser. Async
// (asks main if a lock is needed); FAIL-OPEN so any hiccup just shows the chooser.
function endIntro() {
    if (!introActive || finishing) return;
    finishing = true;
    introActive = false;
    locked = true;   // block interaction until the gate decision resolves
    finishBoot();
}
async function finishBoot() {
    let needed = false;
    try { needed = (api && api.authNeeded) ? (await api.authNeeded()).needed : false; } catch { needed = false; }
    const intro = document.getElementById('boot-intro');
    if (needed) {
        showLock();
        if (intro) intro.classList.add('hide');
    } else {
        if (intro) intro.classList.add('hide');
        revealChooser();
    }
}

// --- PIN gate ---------------------------------------------------------------
function renderLockDots() {
    const dots = document.getElementById('lock-dots');
    if (dots) [...dots.children].forEach((d, i) => d.classList.toggle('on', i < pinBuf.length));
}
function showLock() {
    locked = true;
    const ov = document.getElementById('greeter-lock');
    if (ov) ov.hidden = false;
    pinBuf = ''; renderLockDots();
}
async function submitUnlock(payload) {
    let r = null;
    try { r = (api && api.verifyUnlock) ? await api.verifyUnlock(payload) : null; } catch { r = null; }
    if (r && r.ok) {
        const ov = document.getElementById('greeter-lock'); if (ov) ov.hidden = true;
        revealChooser();
        return;
    }
    pinBuf = ''; renderLockDots();
    const pw = document.getElementById('lock-pw'); if (pw) pw.value = '';
    const err = document.getElementById('lock-err');
    if (err) err.textContent = (r && r.error) || 'Incorrect — try again.';
}
function lockKey(d) {
    const err = document.getElementById('lock-err'); if (err) err.textContent = '';
    if (d === 'back') { pinBuf = pinBuf.slice(0, -1); renderLockDots(); return; }
    if (d === 'ok') { if (pinBuf.length === 4) submitUnlock({ pin: pinBuf }); return; }
    if (/^[0-9]$/.test(d) && pinBuf.length < 4) {
        pinBuf += d; renderLockDots();
        if (pinBuf.length === 4) submitUnlock({ pin: pinBuf });
    }
}
function enterPwMode() {
    pwMode = true;
    const wrap = document.getElementById('lock-pw-wrap'); if (wrap) wrap.classList.add('show');
    const usepw = document.getElementById('lock-usepw'); if (usepw) usepw.style.display = 'none';
    const pw = document.getElementById('lock-pw'); if (pw) pw.focus();
}

async function runIntro() {
    // Safety net #1: reveal the chooser within ~3.2s no matter what happens below.
    const cap = setTimeout(endIntro, 3200);
    const log = document.getElementById('bi-log');
    const sigil = document.getElementById('bi-sigil');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const push = (s) => { if (log) { log.textContent += s + '\n'; log.scrollTop = log.scrollHeight; } };
    try {
        push('OUTLAW OS · BOOT');
        let lines = [];
        try { lines = (api && api.bootLog) ? await api.bootLog() : []; } catch {}
        const half = Math.ceil(lines.length / 2);
        for (const l of lines.slice(0, half)) { if (!introActive) break; push(l); await sleep(55); }
        if (sigil) sigil.classList.add('warm');
        push('· · · power-on self test · · ·');
        await sleep(800);
        for (const l of lines.slice(half)) { if (!introActive) break; push(l); await sleep(55); }
        push('system ready.');
    } catch { /* ignore — the cap below still reveals the chooser */ }
    clearTimeout(cap);
    setTimeout(endIntro, 450);   // brief beat, then reveal
}

function choose(choice) {
    if (!api) return;  // running outside Electron — preview mode
    const rememberEl = document.getElementById('remember-choice');
    const remember = !!(rememberEl && rememberEl.checked);
    document.body.style.pointerEvents = 'none';
    document.body.style.opacity = '0.55';
    api.choose(choice, remember).catch((err) => console.error('greeter choose failed:', err));
}

async function showPreflight() {
    const out = document.getElementById('preflight-out');
    if (!out) return;
    out.classList.add('show');
    out.textContent = 'Checking this PC…';
    try {
        const r = (api && api.preflight) ? await api.preflight() : null;
        if (!r || !r.ok) { out.textContent = 'Pre-flight check unavailable.'; return; }
        let html = `<b>CPU</b> ${_esc(r.cpu)} (${r.cores} cores) · <b>RAM</b> ${r.ramGb} GB`
            + ` · <b>GPU</b> ${_esc(r.gpu)}${r.vramGb ? ` (${r.vramGb} GB VRAM)` : ''}`;
        if (r.diskFree) html += ` · <b>Free disk</b> ${_esc(r.diskFree)}`;
        html += (r.warnings && r.warnings.length)
            ? '<br>' + r.warnings.map((w) => `<span class="warn">⚠ ${_esc(w)}</span>`).join('<br>')
            : '<br>Looks good — you’re ready to go.';
        out.innerHTML = html;
    } catch { out.textContent = 'Pre-flight check failed.'; }
}

document.addEventListener('click', (e) => {
    if (introActive) { endIntro(); return; }   // first click skips the intro
    if (locked) {
        const k = e.target.closest('[data-d]');
        if (k) { lockKey(k.dataset.d); return; }
        if (e.target.closest('#lock-usepw')) { enterPwMode(); return; }
        if (e.target.closest('#lock-pw-go')) {
            const pw = document.getElementById('lock-pw'); submitUnlock({ password: pw ? pw.value : '' });
            return;
        }
        return;   // swallow other clicks while the gate is up
    }
    if (e.target.closest('[data-action="preflight"]')) { showPreflight(); return; }
    const el = e.target.closest('[data-choice]');
    if (el) choose(el.dataset.choice);
});

document.addEventListener('keydown', (e) => {
    if (introActive) { endIntro(); return; }   // first key skips the intro
    if (locked) {
        if (pwMode) {
            if (e.key === 'Enter') {
                const pw = document.getElementById('lock-pw'); submitUnlock({ password: pw ? pw.value : '' });
            }
            return;   // otherwise let the password field receive typing
        }
        if (/^[0-9]$/.test(e.key)) { lockKey(e.key); return; }
        if (e.key === 'Backspace') { lockKey('back'); return; }
        if (e.key === 'Enter') { lockKey('ok'); return; }
        return;   // swallow other keys while the gate is up
    }
    const k = e.key.toLowerCase();
    if (k === '1' || k === 'd') { choose('dev'); return; }
    if (k === '2' || k === 's') { choose('desktop'); return; }
    if (k === 't') { choose('tty'); return; }
    if (e.key === 'Enter') {
        const focused = document.activeElement;
        if (focused && focused.dataset && focused.dataset.choice) choose(focused.dataset.choice);
        else choose('dev');
    }
});

// Safety net #2: even if runIntro throws synchronously, never leave the chooser
// hidden behind the overlay.
setTimeout(endIntro, 3500);

if (introActive) runIntro();
else if (!finishing) { finishing = true; locked = true; finishBoot(); }   // no intro → gate immediately
