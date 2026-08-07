// ============================================================================
// Outlaw Server - renderer
// No inline handlers (CSP-safe). Everything talks to the main process through
// the audited `window.outlaw` bridge defined in preload.js.
// ============================================================================
'use strict';

const api = window.outlaw;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// F1 — capture renderer errors/rejections into the combined error log, so a
// crash leaves a trace even when nobody's reading the console.
//
// The reporter must be incapable of reporting itself. A bare try/catch is NOT
// enough: errorlog.add returns a promise, and a REJECTED one escapes the catch,
// fires 'unhandledrejection', and calls this handler again — an infinite loop
// that buries the original fault under thousands of copies of its own failure.
// So: swallow the rejection too, and never let this path throw.
function _reportUiFault(message) {
    try {
        const p = window.outlaw.errorlog.add({ level: 'error', source: 'shell-ui', message });
        if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* reporting is best-effort by definition */ }
}
window.addEventListener('error', (e) => {
    _reportUiFault((e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || ''));
});
window.addEventListener('unhandledrejection', (e) => {
    _reportUiFault('unhandledrejection: ' + String((e.reason && e.reason.message) || e.reason));
});

let statsTimer = null;
let confirmResolver = null;
let pendingUpdate = null;   // most recent successful shell-update check result

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
let toastTimer = null;
function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// C7 — background notifications. Track the visible screen so an event that
// finishes while the user has moved elsewhere (an AI reply, a found update)
// can surface a toast + a persistent "unread" dot on the relevant nav item.
let currentScreen = '';
function notifyUser(msg, screen) {
    toast(msg);
    if (screen && currentScreen !== screen) {
        const nav = document.querySelector('.nav-item[data-screen="' + screen + '"]');
        if (nav) nav.classList.add('has-unread');
    }
}

// C11 — offline mode + airplane mode. Offline mode REACTS to no connection;
// airplane mode ACTIVELY turns the radios off (and engages offline mode too).
// Either way: everything local — AI, files, apps, projects — keeps working; only
// internet-dependent actions are gated.
let airplaneMode = false;
function updateOnlineStatus() {
    try {
        const offline = airplaneMode || navigator.onLine === false;
        if (document.body) document.body.classList.toggle('offline', offline);
        // Single indicator: the topbar #offline-pill. Airplane mode labels it
        // explicitly; otherwise refreshNetStatus owns visibility (real connectivity).
        const pill = document.querySelector('#offline-pill');
        if (!pill) return;
        if (airplaneMode) {
            pill.hidden = false;
            pill.textContent = '✈ AIRPLANE MODE';
            pill.title = 'Airplane mode is on — radios off. Turn it off in Settings → Network & Wi-Fi.';
        } else {
            pill.textContent = '⚠ OFFLINE — set up Wi-Fi';
            pill.title = 'No internet connection — click to set up Wi-Fi';
            try { refreshNetStatus(); } catch {}
        }
    } catch {}
}
function isOnline() { return !airplaneMode && navigator.onLine !== false; }
window.addEventListener('online', () => { updateOnlineStatus(); if (!airplaneMode) toast('Back online.'); });
window.addEventListener('offline', () => { updateOnlineStatus(); if (!airplaneMode) toast('You\'re offline — local features still work.'); });
async function refreshAirplane() {
    const tog = document.querySelector('#airplane-toggle');
    try {
        const r = await api.net.airplaneStatus();
        if (r) { airplaneMode = !!r.airplane; if (tog) tog.checked = airplaneMode; updateOnlineStatus(); }
    } catch {}
}
async function onAirplaneToggle(e) {
    const on = e.target.checked;
    e.target.disabled = true;
    try {
        const r = await api.net.setAirplane(on);
        if (!r || !r.ok) {
            toast('Couldn\'t change airplane mode' + (r && r.error ? ': ' + r.error.slice(0, 80) : '.'));
            e.target.checked = !on;
        } else {
            airplaneMode = on;
            updateOnlineStatus();
            toast(on ? '✈ Airplane mode on — radios off.' : 'Airplane mode off — reconnecting…');
            if (!on) setTimeout(() => { try { refreshNetStatus(); } catch {} }, 1500);
        }
    } catch (err) { toast('Airplane mode failed: ' + err.message); e.target.checked = !on; }
    finally { e.target.disabled = false; }
}
try { updateOnlineStatus(); } catch {}

// --- Time zone + NTP ---------------------------------------------------------
// A server's clock has to be right: logs, TLS certificates, scheduled jobs and
// the TOTP codes that get you in all depend on it. Keyboard layout went with
// the desktop.
function _regionMsg(t) { const el = document.querySelector('#region-msg'); if (el) el.textContent = t || ''; }
let _regionPopulated = false;
async function refreshRegionUi() {
    const tzSel = document.querySelector('#tz-select');
    const ntp = document.querySelector('#ntp-toggle');
    try {
        if (!_regionPopulated) {
            const zones = await api.time.zones();
            if (tzSel && Array.isArray(zones)) tzSel.innerHTML = zones.map((z) => `<option value="${z}">${z}</option>`).join('');
            _regionPopulated = true;
        }
        const tSt = await api.time.status();
        if (tzSel && tSt && tSt.timezone) tzSel.value = tSt.timezone;
        if (ntp && tSt) ntp.checked = !!tSt.ntp;
        const sub = document.querySelector('#tz-sub'); if (sub && tSt && tSt.local) sub.textContent = tSt.local;
    } catch { /* leave defaults */ }
}

// --- QOL batch: calendar popover (topbar clock) ------------------------------
let _calYear = 0, _calMonth = 0;   // currently displayed month
function renderCal() {
    const title = document.querySelector('#cal-title');
    const grid = document.querySelector('#cal-grid');
    if (!title || !grid) return;
    const now = new Date();
    const first = new Date(_calYear, _calMonth, 1);
    title.textContent = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const cells = [];
    ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].forEach((d) => cells.push(`<div class="cal-dow">${d}</div>`));
    const startDow = first.getDay();
    const daysInMonth = new Date(_calYear, _calMonth + 1, 0).getDate();
    const daysInPrev = new Date(_calYear, _calMonth, 0).getDate();
    for (let i = startDow - 1; i >= 0; i--) cells.push(`<div class="cal-day other">${daysInPrev - i}</div>`);
    for (let d = 1; d <= daysInMonth; d++) {
        const isToday = d === now.getDate() && _calMonth === now.getMonth() && _calYear === now.getFullYear();
        cells.push(`<div class="cal-day${isToday ? ' today' : ''}">${d}</div>`);
    }
    const rem = (7 - (cells.length % 7)) % 7;
    for (let d = 1; d <= rem; d++) cells.push(`<div class="cal-day other">${d}</div>`);
    grid.innerHTML = cells.join('');
}
function closeCalPopover() { const p = document.querySelector('#cal-popover'); if (p) p.hidden = true; }
function toggleCalPopover() {
    const pop = document.querySelector('#cal-popover'); if (!pop) return;
    if (pop.hidden) {
        const now = new Date(); _calYear = now.getFullYear(); _calMonth = now.getMonth();
        renderCal(); pop.hidden = false;
    } else pop.hidden = true;
}

// --- QOL batch: command palette (Ctrl+Space) ---------------------------------
// One search box over screens, settings cards, help topics, apps and common
// actions. Entries only call existing UI paths (showScreen/launchApp/…), so the
// palette adds reach, not privileges.
let _palStatic = null;     // built once per session (screens/settings/help/actions)
let _palSel = 0;
let _palShown = [];        // currently rendered entries
function _palBuildStatic() {
    const items = [];
    document.querySelectorAll('.nav-item[data-screen]').forEach((b) => {
        const name = b.dataset.screen;
        const label = b.textContent.trim();
        items.push({ label, kind: 'screen', kw: name + ' open go', run: () => showScreen(name) });
    });
    document.querySelectorAll('#screen-settings .card h3').forEach((h) => {
        const card = h.closest('.card');
        const label = h.textContent.trim();
        if (!card || !label) return;
        items.push({ label, kind: 'settings', kw: 'settings ' + label, run: () => {
            showScreen('settings');
            requestAnimationFrame(() => { try { card.scrollIntoView({ block: 'start' }); } catch {} });
        } });
    });
    (window.OUTLAW_HELP || []).forEach((t) => items.push({
        label: t.title, kind: 'help', kw: (t.keywords || '') + ' help how',
        run: () => { showScreen('help'); const hs = document.querySelector('#help-search'); if (hs) hs.value = t.title; try { renderHelp(t.title); } catch {} },
    }));
    const actions = [
        ['🔒 Lock the screen', 'lock secure away pin', () => lockNow()],
        ['✦ Ask the AI', 'ai assistant ask chat question', () => { showScreen('ai'); const i = document.querySelector('#ai-in'); if (i) i.focus(); }],
    ];
    actions.forEach(([label, kw, run]) => items.push({ label, kind: 'action', kw, run }));
    return items;
}
async function _palAllItems() {
    if (!_palStatic) _palStatic = _palBuildStatic();
    let apps = [];
    try {
        const reg = await api.apps.list();
        apps = (reg || []).map((a) => ({ label: '▸ Launch ' + a.label, kind: 'app', kw: 'launch open run app ' + a.id, run: () => launchApp(a.id) }));
    } catch {}
    return _palStatic.concat(apps);
}
function _palScore(item, q) {
    const l = item.label.toLowerCase(), k = (item.kw || '').toLowerCase();
    if (l.startsWith(q)) return 3;
    if (l.includes(q)) return 2;
    if (k.includes(q)) return 1;
    return 0;
}
function _palRender(items) {
    _palShown = items;
    _palSel = 0;
    const list = document.querySelector('#pal-list');
    if (!list) return;
    if (!items.length) { list.innerHTML = '<div class="pal-empty">No matches.</div>'; return; }
    list.innerHTML = items.map((it, i) =>
        `<div class="pal-item${i === 0 ? ' sel' : ''}" role="option" aria-selected="${i === 0}" data-pal-idx="${i}">`
        + `<span class="pal-kind">${it.kind}</span><span>${_escapeHtml(it.label)}</span></div>`).join('');
}
function _palMove(dir) {
    if (!_palShown.length) return;
    _palSel = Math.max(0, Math.min(_palShown.length - 1, _palSel + dir));
    document.querySelectorAll('#pal-list .pal-item').forEach((el, i) => {
        el.classList.toggle('sel', i === _palSel);
        el.setAttribute('aria-selected', i === _palSel ? 'true' : 'false');
        if (i === _palSel) el.scrollIntoView({ block: 'nearest' });
    });
}
function _palRun(idx) {
    const it = _palShown[idx];
    closePalette();
    if (it) { try { it.run(); } catch {} }
}
let _palFilterSeq = 0;
async function _palFilter() {
    const seq = ++_palFilterSeq;
    const q = (document.querySelector('#pal-input') || { value: '' }).value.trim().toLowerCase();
    const all = await _palAllItems();
    if (seq !== _palFilterSeq) return;   // a newer keystroke superseded this query
    if (!q) { _palRender(all.filter((i) => i.kind === 'screen' || i.kind === 'action').slice(0, 12)); return; }
    const scored = all.map((it) => ({ it, s: _palScore(it, q) })).filter((x) => x.s > 0);
    scored.sort((a, b) => b.s - a.s);
    _palRender(scored.slice(0, 12).map((x) => x.it));
}
function openPalette() {
    const pal = document.querySelector('#palette'); if (!pal) return;
    // Never open behind a full-screen overlay (lock screen, running-job
    // loading screen, quickstart tour) — actions could run invisibly.
    const si = document.querySelector('#signin');
    if (si && si.style.display && si.style.display !== 'none') return;
    const ls = document.querySelector('#loadscreen');
    if (ls && ls.classList.contains('show')) return;
    const qs = document.querySelector('#quickstart');
    if (qs && qs.style.display === 'flex') return;
    closeCalPopover();
    pal.hidden = false;
    const inp = document.querySelector('#pal-input');
    if (inp) { inp.value = ''; inp.focus(); }
    _palFilter();
}
function closePalette() { const pal = document.querySelector('#palette'); if (pal) pal.hidden = true; }

// --- QOL batch: recent apps on the Dashboard ---------------------------------
const _RECENT_ICONS = { browser: '🌐', files: '📁', terminal: '>_', lmstudio: '✦' };
async function renderRecentApps() {
    const box = document.getElementById('recent-apps');
    const title = document.getElementById('recent-title');
    if (!box || !title) return;
    try {
        const [s, registry] = await Promise.all([api.settings.get(), api.apps.list()]);
        const ids = (Array.isArray(s.recentApps) ? s.recentApps : []).filter((id) => registry.some((r) => r.id === id));
        title.hidden = ids.length === 0;
        box.innerHTML = '';
        for (const id of ids) {
            const label = (registry.find((r) => r.id === id) || {}).label || id;
            const b = document.createElement('button');
            b.className = 'tile';
            b.dataset.launch = id;
            b.innerHTML = `<span class="t-ico">${_RECENT_ICONS[id] || '📦'}</span><span class="t-label">${_escapeHtml(label)}</span><span class="t-sub">launch</span>`;
            box.appendChild(b);
        }
    } catch { title.hidden = true; }
}

// Auto-lock on idle — main watches SYSTEM-WIDE idle (powerMonitor) and sends
// 'idle-lock'; the renderer just owns the guards + the sign-in overlay. The
// system-wide source matters: window-local activity tracking would think the
// machine is idle while the user plays a fullscreen game. Fires only when a
// PIN exists and the sign-in screen isn't already up — never traps the user.
async function onIdleLock() {
    const si = document.querySelector('#signin');
    if (si && si.style.display && si.style.display !== 'none') return; // already locked
    try {
        const st = await api.auth.status();
        if (!st || st.live || !st.hasPin) return;
        lockNow();
    } catch {}
}

// QoL — live filter for the (now long) Settings screen: hide cards that don't
// match the query. Pure show/hide, no logic touched.
function filterSettings(q) {
    const query = (q || '').trim().toLowerCase();
    const cards = document.querySelectorAll('#screen-settings > .card');
    let anyVisible = false;
    cards.forEach((c) => {
        const match = !query || (c.textContent || '').toLowerCase().includes(query);
        c.style.display = match ? '' : 'none';
        if (match) anyVisible = true;
    });
    const none = document.querySelector('#settings-no-match');
    if (none) none.style.display = (query && !anyVisible) ? 'block' : 'none';
}

// ---------------------------------------------------------------------------
// Boot sequence
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Sign-in / PIN (Phase 3c)
// ---------------------------------------------------------------------------
let _signinReauth = false;
let _signinResolve = null;
let _signinHasPin = false;
let _pinBuf = '';

// Startup gate — show the lock screen first (if enabled), then the boot screen.
async function startupGate() {
    let st;
    try { st = await api.auth.status(); } catch { st = { lockEnabled: false }; }
    if (!st || !st.lockEnabled) { runBoot(); return; }
    // If the greeter already took the PIN moments ago, don't ask twice.
    try { const u = await api.auth.recentlyUnlocked(); if (u && u.ok) { runBoot(); return; } } catch {}
    openSignin({ reauth: false, user: st.user, hasPin: st.hasPin });
}

function renderPinDots() {
    const dots = $('#pin-dots'); if (!dots) return;
    [...dots.children].forEach((d, i) => d.classList.toggle('filled', i < _pinBuf.length));
}
function showSigninMode(m) {
    $('#signin-pin-mode').hidden = m !== 'pin';
    $('#signin-pw-mode').hidden = m !== 'pw';
    if (m === 'pw') setTimeout(() => { const e = $('#signin-pw'); if (e) { e.value = ''; e.focus(); } }, 30);
    if (m === 'pin') { _pinBuf = ''; renderPinDots(); }
}
function openSignin({ reauth, user, hasPin }) {
    // Close every floating surface and drop focus first — otherwise a still-
    // focused palette input behind the overlay would keep receiving keystrokes
    // (Enter could run actions "through" the lock screen).
    try { closePalette(); closeCalPopover(); } catch {}
    try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch {}
    _signinReauth = !!reauth;
    _signinHasPin = !!hasPin;
    _pinBuf = '';
    $('#signin-user').textContent = user || 'operator';
    $('#signin-msg').textContent = reauth ? 'Confirm it\'s you to continue.' : '';
    $('#use-password').hidden = !hasPin;
    $('#use-pin').hidden = !hasPin;
    showSigninMode(hasPin ? 'pin' : 'pw');
    $('#signin').style.display = 'flex';
    if (reauth) return new Promise((res) => { _signinResolve = res; });
}
async function submitUnlock(payload) {
    const r = await api.auth.unlock(payload);
    if (r && r.ok) { signinSuccess(); return; }
    $('#signin-msg').textContent = (r && r.error) || 'Incorrect — try again.';
    _pinBuf = ''; renderPinDots();
    const pw = $('#signin-pw'); if (pw) pw.value = '';
}
function signinSuccess() {
    $('#signin').style.display = 'none';
    if (_signinReauth) {
        const res = _signinResolve; _signinResolve = null; _signinReauth = false;
        if (res) res(true);
    } else {
        runBoot();
    }
}
function signinCancel() {
    if (!_signinReauth) return;   // startup sign-in can't be cancelled
    $('#signin').style.display = 'none';
    const res = _signinResolve; _signinResolve = null; _signinReauth = false;
    if (res) res(false);
}
// Require auth for an "important" action (essentials/security installs, etc.).
// Returns true if allowed. No-ops on the live demo / when nothing is configured.
async function requireImportantAuth() {
    let st;
    try { st = await api.auth.status(); } catch { return true; }
    if (!st || st.live) return true;
    if (!st.hasPin && !st.lockEnabled) return true;
    return await openSignin({ reauth: true, user: st.user, hasPin: st.hasPin });
}

// QoL — lock the screen on demand (from the power menu). Reuses the startup
// sign-in path: it's non-cancellable and only unlocks with the correct PIN.
async function lockNow() {
    let st;
    try { st = await api.auth.status(); } catch { st = {}; }
    if (st && st.live) { toast('Lock isn\'t available on the live demo.'); return; }
    if (!st || !st.hasPin) { toast('Set a PIN first (Settings → Security) to lock the screen.'); return; }
    closePower();
    openSignin({ reauth: false, user: st.user, hasPin: st.hasPin });
}

function wireAuth() {
    const pad = $('#pin-pad');
    if (pad) pad.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.hasAttribute('data-pin-back')) { _pinBuf = _pinBuf.slice(0, -1); renderPinDots(); return; }
        const d = b.dataset.d; if (d == null) return;
        if (_pinBuf.length < 4) { _pinBuf += d; renderPinDots(); }
        if (_pinBuf.length === 4) submitUnlock({ pin: _pinBuf });
    });
    const up = $('#use-password'); if (up) up.addEventListener('click', (e) => { e.preventDefault(); showSigninMode('pw'); });
    const ui = $('#use-pin'); if (ui) ui.addEventListener('click', (e) => { e.preventDefault(); showSigninMode('pin'); });
    const go = $('#signin-pw-go'); if (go) go.addEventListener('click', () => submitUnlock({ password: $('#signin-pw').value }));
    const pwIn = $('#signin-pw'); if (pwIn) pwIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitUnlock({ password: pwIn.value }); });
    // Hardware keyboard for the PIN pad + Escape to cancel a reauth prompt.
    document.addEventListener('keydown', (e) => {
        if ($('#signin').style.display === 'none' || $('#signin').style.display === '') return;
        if (e.key === 'Escape') { signinCancel(); return; }
        if ($('#signin-pin-mode').hidden) return;
        if (/^[0-9]$/.test(e.key)) {
            if (_pinBuf.length < 4) { _pinBuf += e.key; renderPinDots(); if (_pinBuf.length === 4) submitUnlock({ pin: _pinBuf }); }
        } else if (e.key === 'Backspace') { _pinBuf = _pinBuf.slice(0, -1); renderPinDots(); }
    });

    // --- Settings: Security card ---
    let _pinFormMode = 'set';
    const refreshSecurityUi = async () => {
        let st; try { st = await api.auth.status(); } catch { return; }
        const lt = $('#lock-toggle'); if (lt) lt.checked = !!st.lockEnabled;
        const has = !!st.hasPin;
        $('#pin-state').textContent = has
            ? 'A PIN is set — use it instead of your password.'
            : 'A 4-digit PIN you can use instead of your password.';
        $('#pin-set-btn').textContent = has ? 'Change PIN' : 'Set PIN';
        $('#pin-remove-btn').hidden = !has;
    };
    window._refreshSecurityUi = refreshSecurityUi;
    const closePinForm = () => { $('#pin-form').hidden = true; ['pin-current', 'pin-new', 'pin-confirm'].forEach((id) => { const x = $('#' + id); if (x) x.value = ''; }); $('#pin-form-msg').textContent = ''; };
    const ltog = $('#lock-toggle'); if (ltog) ltog.addEventListener('change', async (e) => { try { await api.auth.setLock(e.target.checked); } catch {} });
    const setBtn = $('#pin-set-btn'); if (setBtn) setBtn.addEventListener('click', async () => {
        _pinFormMode = 'set';
        let st; try { st = await api.auth.status(); } catch { st = {}; }
        $('#pin-current').hidden = !st.hasPin;
        $('#pin-new').hidden = false; $('#pin-confirm').hidden = false;
        $('#pin-save').textContent = 'Save PIN';
        $('#pin-form').hidden = false; $('#pin-form-msg').textContent = '';
    });
    const rmBtn = $('#pin-remove-btn'); if (rmBtn) rmBtn.addEventListener('click', () => {
        _pinFormMode = 'remove';
        $('#pin-current').hidden = false; $('#pin-new').hidden = true; $('#pin-confirm').hidden = true;
        $('#pin-save').textContent = 'Remove PIN';
        $('#pin-form').hidden = false; $('#pin-form-msg').textContent = 'Enter your current PIN to remove it.';
    });
    const cancelBtn = $('#pin-cancel'); if (cancelBtn) cancelBtn.addEventListener('click', closePinForm);
    const saveBtn = $('#pin-save'); if (saveBtn) saveBtn.addEventListener('click', async () => {
        const cur = $('#pin-current').value, nw = $('#pin-new').value, cf = $('#pin-confirm').value;
        const msg = $('#pin-form-msg');
        if (_pinFormMode === 'remove') {
            const r = await api.auth.clearPin({ pin: cur });
            if (r && r.ok) { closePinForm(); toast('PIN removed.'); refreshSecurityUi(); }
            else { msg.textContent = (r && r.error) || 'Could not remove PIN.'; }
            return;
        }
        if (!/^\d{4}$/.test(nw)) { msg.textContent = 'PIN must be exactly 4 digits.'; return; }
        if (nw !== cf) { msg.textContent = 'The two PINs do not match.'; return; }
        const r = await api.auth.setPin(nw, cur);
        if (r && r.ok) { closePinForm(); toast('PIN saved.'); refreshSecurityUi(); }
        else { msg.textContent = (r && r.error) || 'Could not save PIN.'; }
    });
}

async function runBoot() {
    const log = $('#boot-log');
    const sigil = $('#boot-sigil');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const push = (s) => { log.textContent += s + '\n'; log.scrollTop = log.scrollHeight; };
    log.textContent = '';
    push('INITIALIZING OUTLAW SERVER…');

    // Real boot data (best-effort; empty in preview or if the journal is locked).
    let bootLines = [];
    try { bootLines = await api.system.bootLog(); } catch {}
    try {
        const i = await api.system.info();
        push(`HOST     ${i.hostname}`);
        push(`KERNEL   ${i.kernel}`);
        push(`CPU      ${i.cpu} (${i.cores} cores)`);
        push(`MEMORY   ${i.ramUsed} / ${i.ramTotal}`);
    } catch {
        push('SYSTEM PROBE UNAVAILABLE (preview mode)');
    }

    // First half of the real boot log scrolls up…
    const half = Math.ceil(bootLines.length / 2);
    for (const l of bootLines.slice(0, half)) { push(l); await sleep(60); }

    // …the Outlaw sigil flickers to life like a CRT warming up (~3s)…
    if (sigil) sigil.classList.add('warm');
    push('· · · POWER-ON SELF TEST · · ·');
    await sleep(1100);

    // …then the rest of the boot log, then ready.
    for (const l of bootLines.slice(half)) { push(l); await sleep(60); }
    push('MOUNTING PAYLOAD VAULT… OK');
    push('SECURITY GUARD ACTIVE… OK');
    push('SYSTEM READY.');
    $('#boot-skip').focus();
}

function enterOS() {
    // Idempotent: the boot screen has two entry buttons and #boot-noai is async,
    // so a fast second click could otherwise start a duplicate stats poller.
    if ($('#app').classList.contains('ready')) return;
    $('#boot').style.display = 'none';
    $('#app').classList.add('ready');
    startStats();
    refreshAiStatus();
    checkSafeMode();
    maybeShowQuickstart();
    // Phase 13.2 — first desktop run: make sure the built-in AI model is present
    // (pulls it once, shown on the loading screen). No-op if already there or if
    // the built-in AI / AI itself is turned off. Desktop-only by construction.
    (async () => {
        try {
            const s = await api.ai.status();
            if (s.enabled && s.baseAiEnabled !== false && api.ai.ensureBaseModel) api.ai.ensureBaseModel();
        } catch {}
    })();
}

// Show a persistent toast banner if outlaw-session-watchdog flipped us into
// safe mode after a crash loop. The IPC consumes the marker, so the banner
// fires once per X session.
async function checkSafeMode() {
    try {
        const r = await api.safeMode.check();
        if (r && r.active) {
            const reason = r.reason || 'A previous session was crash-looping.';
            // Toast for ~12 seconds — longer than a normal toast since the
            // user really should see this.
            const t = $('#toast');
            if (t) {
                t.textContent = '⚠ Safe mode: ' + reason.slice(0, 160);
                t.classList.add('show');
                setTimeout(() => t.classList.remove('show'), 12_000);
            }
        }
    } catch {
        /* shell still works without this */
    }
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
function showScreen(name) {
    currentScreen = name;   // C7 — so background events know if the user is elsewhere
    $$('.screen').forEach((s) => s.classList.remove('active'));
    const el = $('#screen-' + name);
    if (el) el.classList.add('active');
    // C7 — arriving on a screen clears its unread dot.
    const navHere = document.querySelector('.nav-item[data-screen="' + name + '"]');
    if (navHere) navHere.classList.remove('has-unread');
    $$('.nav-item[data-screen]').forEach((n) => n.classList.toggle('active', n.dataset.screen === name));
    // C13 — a freshly-shown tab starts at the top; the AI chat jumps to its latest.
    if (name === 'ai') {
        const log = $('#ai-log');
        if (log) requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
    } else {
        const content = document.querySelector('.content');
        if (content) content.scrollTop = 0;
    }
    if (name === 'files') { _fsFilter = ''; const ff = $('#fs-filter'); if (ff) ff.value = ''; loadFiles(currentDir || null); }
    if (name === 'tasks') { refreshTasks(); startTasksPoll(); } else { stopTasksPoll(); }
    if (name === 'dashboard') { renderRecentApps(); refreshDisks(); }
    if (name === 'apps') { refreshServerApps(); refreshPterodactyl(); loadAppsCatalog(); const as = $('#apps-search'); if (as) as.focus(); }
    if (name === 'help') { renderHelp(($('#help-search') || {}).value || ''); const hs = $('#help-search'); if (hs) hs.focus(); }
    if (name === 'settings') { const ss = $('#settings-search'); if (ss) ss.value = ''; filterSettings(''); refreshNetStatus(); refreshSwapStatus(); refreshAirplane(); refreshRegionUi(); refreshSshKeys(); if (window._refreshSecurityUi) window._refreshSecurityUi(); }
    if (name === 'ai') $('#ai-in').focus();
    if (name === 'terminal') $('#term-in').focus();
    // Server screens load on arrival and on demand — never on a timer.
    if (name === 'services') refreshServices();
    if (name === 'firewall') refreshFirewall();
    if (name === 'remote') refreshRemote();
    // System Core lifecycle — init when navigating to it, teardown otherwise.
    // The module is self-contained so this is the only hook the rest of the
    // shell needs to know about. SC2+ slices plug into the same init/teardown.
    if (window.outlawCore) {
        if (name === 'syscore') window.outlawCore.init();
        else window.outlawCore.teardown();
    }
}

// ---------------------------------------------------------------------------
// Server screens — services, journal, firewall, remote access
// ---------------------------------------------------------------------------
// Every one of these reaches the shared operations registry BY NAME through
// api.invoke(). That single call is Electron IPC in the local panel and
// POST /rpc in the browser, so these screens behave identically in both and
// there is no second implementation to keep in step.
//
// Nothing here polls. A screen loads when you open it and when you ask it to
// refresh — an idle panel costs the server nothing, which is the same rule the
// daemon holds itself to.

async function op(name, args) {
    try {
        const r = await api.invoke(name, args || {});
        return r || { ok: false, error: 'No response.' };
    } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
    }
}

// "We couldn't read it" and "there is nothing to show" look identical once both
// render as an empty list, and the empty one reads as reassurance. Every screen
// below asks this before drawing a list, so a failure can never be mistaken for
// a healthy, quiet machine. An op that simply isn't implemented yet (ok:false,
// "Unknown operation") counts as unreadable too — it is not evidence of zero.
function unreadable(r) {
    return !r || r.ok === false || r.available === false;
}

// --- Services ---------------------------------------------------------------
let _svcCache = [];

function renderServices() {
    const body = $('#svc-body');
    if (!body) return;
    const filter = (($('#svc-filter') || {}).value || '').trim().toLowerCase();
    const rows = _svcCache.filter((u) => !filter || u.unit.toLowerCase().includes(filter)
        || (u.description || '').toLowerCase().includes(filter));
    if (!rows.length) {
        body.innerHTML = `<tr><td colspan="5" class="muted">${filter ? 'Nothing matches that filter.' : 'No services reported.'}</td></tr>`;
        return;
    }
    body.innerHTML = rows.map((u) => {
        const running = u.active === 'active';
        const name = _escapeHtml(u.unit);
        return `<tr>
            <td class="mono">${name}</td>
            <td><span class="badge${running ? ' on' : ''}">${_escapeHtml(u.sub || u.active || '?')}</span></td>
            <td class="mono dim" data-svc-boot="${name}">—</td>
            <td class="dim">${_escapeHtml((u.description || '').slice(0, 70))}</td>
            <td class="right" style="white-space:nowrap;">
                <button data-svc="${name}" data-svc-action="restart" aria-label="Restart ${name}" title="Stop and start it again — the usual fix after a config change">↻</button>
                ${running
        ? `<button data-svc="${name}" data-svc-action="stop" aria-label="Stop ${name}" title="Stop it now">■</button>`
        : `<button data-svc="${name}" data-svc-action="start" aria-label="Start ${name}" title="Start it now">▶</button>`}
            </td>
        </tr>`;
    }).join('');
}

async function refreshServices() {
    const body = $('#svc-body');
    if (body) body.innerHTML = '<tr><td colspan="5" class="muted">Loading…</td></tr>';
    const r = await op('services:list');
    // "Couldn't read them" must never render as "there aren't any" — an empty
    // table over a failure reads as a healthy machine with nothing running.
    if (unreadable(r)) {
        if (body) body.innerHTML = `<tr><td colspan="5" class="muted">Couldn't read the service list: ${_escapeHtml(r.error || 'unknown error')}</td></tr>`;
        _svcCache = [];
        return;
    }
    _svcCache = (r.units || []).filter((u) => u && u.unit);
    renderServices();
}

async function serviceAction(unit, action) {
    const msg = $('#svc-msg');
    if (msg) msg.textContent = `${action}ing ${unit}…`;
    const r = await op('services:action', { unit, action });
    if (msg) {
        msg.textContent = r.ok === false
            ? `Couldn't ${action} ${unit}: ${r.error || 'unknown error'}`
            : `${unit} ${action === 'stop' ? 'stopped' : action === 'start' ? 'started' : 'restarted'}.`;
    }
    if (r.ok !== false) toast(`${unit} ${action}ed.`);
    else toast(`Couldn't ${action} ${unit}.`);
    refreshServices();
}

// --- System log -------------------------------------------------------------
async function refreshLogs() {
    const out = $('#log-out');
    if (!out) return;
    out.textContent = 'Reading the journal…';
    const unit = (($('#log-unit') || {}).value || '').trim();
    const lines = parseInt((($('#log-lines') || {}).value || '200'), 10) || 200;
    const r = await op('logs:recent', unit ? { unit, lines } : { lines });
    if (unreadable(r)) {
        out.textContent = "Couldn't read the journal: " + (r.error || 'unknown error');
        return;
    }
    const list = r.lines || [];
    out.textContent = list.length
        ? list.join('\n')
        : (unit ? `The journal has nothing for "${unit}". Check the service name.` : 'The journal came back empty.');
    // Newest entries are last — start the reader where the action is.
    out.scrollTop = out.scrollHeight;
}

// --- Firewall ---------------------------------------------------------------
let _fwRules = [];
function _fwMsg(t) { const el = $('#fw-msg'); if (el) el.textContent = t || ''; }

async function refreshFirewall() {
    const body = $('#fw-body');
    const state = $('#fw-state');
    const tog = $('#fw-toggle');
    const sub = $('#fw-sub');
    const r = await op('firewall:status');

    if (unreadable(r)) {
        // Never leave the toggle usable here: showing "off" for a firewall we
        // simply couldn't read would invite someone to "turn it on" when it may
        // already be on, and imply the machine is currently unprotected.
        if (state) { state.textContent = 'unavailable'; state.className = 'badge'; }
        if (tog) { tog.disabled = true; tog.checked = false; }
        if (sub) sub.textContent = r.error || 'The firewall could not be read on this machine.';
        if (body) body.innerHTML = `<tr><td colspan="5" class="muted">${_escapeHtml(r.error || 'Firewall unavailable.')}</td></tr>`;
        return;
    }
    if (tog) { tog.disabled = false; tog.checked = !!r.active; }
    if (state) { state.textContent = r.active ? 'active' : 'inactive'; state.className = 'badge' + (r.active ? ' on' : ''); }
    if (sub) {
        sub.textContent = r.active
            ? 'On — incoming connections are denied unless a rule below allows them.'
            : 'Off — nothing is being filtered. Every listening port is reachable.';
    }
    _fwRules = r.rules || [];
    if (!body) return;
    const rules = _fwRules;
    if (!rules.length) {
        body.innerHTML = `<tr><td colspan="5" class="muted">No rules${r.active ? ' — everything incoming is denied.' : '.'}</td></tr>`;
        return;
    }
    body.innerHTML = rules.map((x) => `<tr>
        <td class="mono dim">${x.num}</td>
        <td class="mono">${_escapeHtml(x.target)}</td>
        <td><span class="badge${x.action === 'ALLOW' ? ' on' : ''}">${_escapeHtml(x.action)}</span></td>
        <td class="dim">${_escapeHtml(x.from || 'Anywhere')}</td>
        <td class="right"><button class="danger" data-fw-del="${x.num}" aria-label="Delete rule ${x.num} — ${_escapeHtml(x.action)} ${_escapeHtml(x.target)} from ${_escapeHtml(x.from || 'anywhere')}" title="Delete this rule">✕</button></td>
    </tr>`).join('');
}

async function firewallAdd(action) {
    const portEl = $('#fw-port');
    const port = ((portEl || {}).value || '').trim();
    const proto = (($('#fw-proto') || {}).value || 'tcp');
    if (!port) { _fwMsg('Enter a port number first.'); return; }
    _fwMsg(`${action === 'deny' ? 'Denying' : 'Allowing'} ${port}/${proto}…`);
    const r = await op('firewall:allow', { port, proto, action });
    if (r.ok === false) { _fwMsg(r.error || 'That rule was refused.'); return; }
    _fwMsg(`Rule added: ${r.rule}.`);
    if (portEl) portEl.value = '';
    refreshFirewall();
}

async function firewallDelete(num) {
    const rule = (_fwRules || []).find((x) => String(x.num) === String(num));
    const target = rule ? rule.target : '';
    // Deleting the rule that keeps SSH open, while connected over SSH, ends the
    // session and needs physical access to undo. Say so in the dialog rather
    // than letting someone find out afterwards.
    const locksYouOut = /(^|\D)22(\D|$)|ssh/i.test(target);
    const okToGo = await askConfirm({
        title: `Delete firewall rule ${num}?`,
        reason: locksYouOut
            ? 'This rule appears to be what keeps SSH reachable. If you are connected over SSH right now, deleting it ends this connection and you will need physical access to the machine to get back in.'
            : 'Whatever uses this port becomes unreachable from outside. Rule numbers also shift after a delete, so check the list again before deleting another.',
        cmd: `ufw delete ${num}${target ? '    (' + target + ')' : ''}`,
    });
    if (!okToGo) return;
    // Rule numbers shift the moment one is removed, so re-read rather than
    // trusting what is still on screen.
    const r = await op('firewall:delete', { num });
    _fwMsg(r.ok === false ? (r.error || 'Could not delete that rule.') : `Rule ${num} deleted.`);
    if (r.ok !== false) toast(`Firewall rule ${num} deleted.`);
    refreshFirewall();
}

// --- Server software (Phase 5) ----------------------------------------------
function _appsMsg(t) { const el = $('#server-apps-msg'); if (el) el.textContent = t || ''; }

async function refreshServerApps() {
    const box = $('#server-apps');
    if (!box) return;
    const r = await op('apps:catalog');
    if (unreadable(r)) {
        box.innerHTML = `<div class="muted">Couldn't check what's installed: ${_escapeHtml(r.error || 'unknown')}</div>`;
        return;
    }
    box.innerHTML = (r.apps || []).map((a) => {
        const state = a.installed ? (a.running ? 'running' : 'installed, stopped') : 'not installed';
        return `<div class="setting">
            <div class="label">${_escapeHtml(a.name)}
                <small>${_escapeHtml(a.blurb || '')}${a.note ? ' <i>' + _escapeHtml(a.note) + '</i>' : ''}</small>
            </div>
            <div class="row" style="gap:6px;align-items:center;white-space:nowrap;">
                <span class="badge${a.running ? ' on' : ''}">${_escapeHtml(state)}</span>
                ${a.installed
        ? `<button data-app="${a.id}" data-app-action="${a.running ? 'stop' : 'start'}">${a.running ? 'Stop' : 'Start'}</button>
                     <button class="danger" data-app="${a.id}" data-app-action="remove">Remove</button>`
        : `<button class="primary" data-app="${a.id}" data-app-action="install">Install</button>`}
            </div>
        </div>`;
    }).join('') || '<div class="muted">No server software listed.</div>';
}

async function serverAppAction(id, action) {
    if (action === 'remove') {
        const go = await askConfirm({
            title: `Remove ${id}?`,
            reason: 'The software is uninstalled. Your data is NOT deleted — container volumes and /var/lib/docker are left exactly as they are, so anything running on top of this can be brought back.',
            cmd: `remove ${id}`,
        });
        if (!go) return;
    }
    _appsMsg(`${action === 'install' ? 'Installing' : action === 'remove' ? 'Removing' : action === 'start' ? 'Starting' : 'Stopping'} ${id}… this can take a while.`);
    let r;
    if (action === 'install') r = await op('apps:install', { id });
    else if (action === 'remove') r = await op('apps:remove', { id });
    else r = await op('apps:set-running', { id, running: action === 'start' });

    if (r.ok === false) { _appsMsg(r.error || `Could not ${action} ${id}.`); toast(`${id}: ${action} failed.`); }
    else { _appsMsg(r.note || `${id}: done.`); toast(`${id} ${action === 'install' ? 'installed' : action === 'remove' ? 'removed' : action + 'ed'}.`); }
    refreshServerApps();
}

async function refreshPterodactyl() {
    const box = $('#ptero-status');
    if (!box) return;
    const r = await op('ptero:status');
    if (unreadable(r)) {
        box.innerHTML = `<span class="muted">Couldn't check: ${_escapeHtml(r.error || 'unknown')}</span>`;
        return;
    }
    const line = (label, val, on) =>
        `<div><span class="dim" style="display:inline-block;min-width:70px;">${label}</span>`
        + `<span class="badge${on ? ' on' : ''}">${_escapeHtml(val)}</span></div>`;
    box.innerHTML = line('Panel', r.panelInstalled ? 'installed' : 'not installed', r.panelInstalled)
        + line('Wings', r.wingsPresent ? 'installed' : 'not installed', r.wingsPresent)
        + (r.report ? `<pre class="dim" style="margin:8px 0 0;font-size:11px;white-space:pre-wrap;">${_escapeHtml(r.report)}</pre>` : '');
}

// --- Storage (dashboard card) -----------------------------------------------
async function refreshDisks() {
    const box = $('#disk-list');
    if (!box) return;
    const r = await op('system:disk');
    const fss = (r && r.filesystems) || [];
    if (unreadable(r)) { box.innerHTML = `<div class="muted">Couldn't read disk usage: ${_escapeHtml(r.error || 'unknown')}</div>`; return; }
    if (!fss.length) { box.innerHTML = '<div class="muted">No filesystems reported.</div>'; return; }
    box.innerHTML = fss.map((f) => {
        // 90% is where "plenty of room" turns into "about to page someone".
        const pctColour = f.usePct >= 90 ? 'var(--bad, #e66)'
            : f.usePct >= 75 ? 'var(--warn, #ea0)'
                : 'inherit';
        return `<div style="margin:8px 0;">
            <div class="row" style="font-size:12px;"><span class="mono">${_escapeHtml(f.mount)}</span><span class="spacer"></span>
              <span class="mono dim">${_escapeHtml(f.used)} / ${_escapeHtml(f.size)}</span>
              <span class="mono" style="color:${pctColour};">&nbsp;${f.usePct}%</span></div>
            <div class="bar"><span style="width:${Math.min(100, f.usePct)}%"></span></div>
        </div>`;
    }).join('');
}

// --- SSH keys ---------------------------------------------------------------
function _sshMsg(t) { const el = $('#ssh-key-msg'); if (el) el.textContent = t || ''; }

async function refreshSshKeys() {
    const box = $('#ssh-key-list');
    if (!box) return;
    const r = await op('ssh:keys');
    if (unreadable(r)) {
        box.innerHTML = `<div class="muted">Couldn't read the authorised keys: ${_escapeHtml(r.error || 'unknown error')}</div>`;
        return;
    }
    const keys = r.keys || [];
    if (!keys.length) {
        box.innerHTML = '<div class="muted">No keys authorised yet — SSH will ask for a password.</div>';
        return;
    }
    box.innerHTML = `<div class="dim" style="font-size:11px;margin-bottom:6px;">${keys.length} key(s) may log in as <span class="mono">${_escapeHtml(r.user || '')}</span></div>`
        + keys.map((k) => `<div class="row" style="gap:8px;align-items:center;padding:4px 0;border-top:1px solid var(--line);">
            <span class="mono">${_escapeHtml(k.type)}</span>
            <span class="dim mono">…${_escapeHtml(k.short)}</span>
            <span class="dim">${_escapeHtml(k.comment || '(no comment)')}</span>
            ${k.valid ? '' : '<span class="badge" title="This line is not a plain public key — it was not written by this panel.">unrecognised</span>'}
            <span class="spacer"></span>
            <button class="danger" data-ssh-del="${k.index}" aria-label="Revoke ${_escapeHtml(k.type)} key ${_escapeHtml(k.comment || 'with no comment')}" title="Revoke this key">Revoke</button>
        </div>`).join('');
}

async function sshAddKey() {
    const inp = $('#ssh-key-in');
    const key = ((inp || {}).value || '').trim();
    if (!key) { _sshMsg('Paste a public key first.'); return; }
    // Catch the worst mistake before it ever leaves the browser.
    if (/BEGIN [A-Z ]*PRIVATE KEY/.test(key)) {
        _sshMsg('That is a PRIVATE key. Do not paste it anywhere — it is the half that must never leave your own machine. You want the matching .pub file.');
        return;
    }
    _sshMsg('Authorising…');
    const r = await op('ssh:add-key', { key });
    if (r.ok === false) { _sshMsg(r.error || 'That key was refused.'); return; }
    if (inp) inp.value = '';
    _sshMsg(`Key authorised for ${r.user}.`);
    toast('SSH key authorised.');
    refreshSshKeys();
}

async function sshRemoveKey(index) {
    const go = await askConfirm({
        title: 'Revoke this SSH key?',
        reason: 'Whoever holds the matching private key loses SSH access to this server. If that key is how YOU get in, make sure you have another way first — a password login, another key, or physical access.',
        cmd: 'remove authorized_keys entry ' + index,
    });
    if (!go) return;
    const r = await op('ssh:remove-key', { index });
    _sshMsg(r.ok === false ? (r.error || 'Could not revoke that key.') : 'Key revoked.');
    if (r.ok !== false) toast('SSH key revoked.');
    refreshSshKeys();
}

// --- Remote access ----------------------------------------------------------
async function refreshRemote() {
    const box = $('#remote-summary');
    const authBox = $('#remote-auth');
    if (!box) return;
    box.textContent = 'Loading…';
    if (authBox) authBox.textContent = '';
    const r = await op('remote:status');
    if (r.ok === false) { box.textContent = "Couldn't read remote-access status: " + (r.error || 'unknown'); return; }

    const ts = r.tailscale || {};
    const bind = r.bind || {};
    const line = (label, value, cls) =>
        `<div><span class="dim" style="display:inline-block;min-width:150px;">${label}</span>`
        + `<span class="${cls || ''}">${_escapeHtml(String(value))}</span></div>`;

    const state = !ts.installed ? 'not installed'
        : ts.connected ? 'connected'
            : ts.running ? (ts.state || 'running, not signed in')
                : 'stopped';

    let html = line('Tailscale', state, ts.connected ? 'badge on' : 'badge');
    if (ts.ipv4) html += line('This machine', ts.ipv4 + (ts.dnsName ? '  (' + ts.dnsName + ')' : ''), 'mono');
    if (ts.peers) html += line('Other devices', ts.peers);
    html += line('Panel listens on', `${bind.host}:${bind.port}`, 'mono');
    html += line('Bind type', (bind.kind || '?') + (bind.allowed === false ? '  — REFUSED' : ''), bind.allowed === false ? 'badge' : '');
    if (r.serve && r.serve.enabled) html += line('HTTPS proxy', 'on (tailscale serve)');
    if ((r.wireguard || {}).interfaces && r.wireguard.interfaces.length) {
        html += line('WireGuard', r.wireguard.interfaces.join(', '), 'mono');
    }
    for (const w of r.reachableAt || []) {
        html += line('Reachable at', `${w.url}  — ${w.from}`, 'mono');
    }
    if (bind.allowed === false && bind.reason) {
        html += `<div style="margin-top:10px;" class="muted">The daemon will refuse to start: ${_escapeHtml(bind.reason)}</div>`;
    } else if (ts.hint) {
        html += `<div style="margin-top:10px;" class="muted">${_escapeHtml(ts.hint)}</div>`;
    }
    box.innerHTML = html;

    if (authBox && ts.authUrl) {
        authBox.textContent = 'Waiting for sign-in. Open this link on any device: ' + ts.authUrl;
    }
}

// ---------------------------------------------------------------------------
// Dashboard + app tiles
// ---------------------------------------------------------------------------
// Tiles rendered on each screen. A tile that maps to a not-yet-installed app
// still appears — clicking it toasts "X is not installed" and the user can
// pop over to Apps to install it. Tiles that can NEVER be installed from
// official repos (e.g. Heroic — AUR only) are intentionally omitted.
const TILE_GROUPS = {
    launchers: [['terminal', '>_'], ['files', '📁'], ['browser', '🌐']],
};

async function renderTiles() {
    let registry = [];
    try { registry = await api.apps.list(); } catch {}
    const labelOf = (id) => (registry.find((r) => r.id === id) || {}).label || id;
    for (const [containerId, items] of Object.entries(TILE_GROUPS)) {
        const box = document.getElementById(containerId);
        if (!box) continue;
        box.innerHTML = '';
        for (const [id, ico] of items) {
            const b = document.createElement('button');
            b.className = 'tile';
            b.dataset.launch = id;
            b.innerHTML = `<span class="t-ico">${ico}</span><span class="t-label">${labelOf(id)}</span><span class="t-sub">launch</span>`;
            box.appendChild(b);
        }
    }
}

// ---------------------------------------------------------------------------
// Apps panel (on-demand installer over the curated catalog)
// ---------------------------------------------------------------------------
const CATEGORY_ICONS = {
    'Essentials':   '⭐',
    'Server':       '🗄',
    'Monitoring':   '📊',
    'Backup':       '💾',
    'Network':      '🌐',
    'Editors':      '📝',
    'Security':     '🛡',
};

// Built once, then mutated in-place when install state changes. `filter` is
// either a category name from the catalog ("Monitoring", "Security", …),
// the special tokens "all" / "installed", or an empty search string.
let _appsState = {
    catalog: [],
    installed: new Set(),
    busy: new Set(),
    filter: 'all',
    search: '',
    discovered: [],   // Phase 2 — apps found on this PC (.desktop + AppImages)
    repoResults: [],  // Phase 15c — "install anything": pacman -Ss results
    repoQuery: '',
    repoSearching: false,
};

function _escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function _renderDiscoveredList(root) {
    // Phase 2 — apps already on this PC (installed .desktop entries + AppImages
    // the user downloaded). These are already installed, so the only action is
    // Launch (the no-WM focus fix makes the launched window actually focusable).
    const q = (_appsState.search || '').trim().toLowerCase();
    let list = _appsState.discovered || [];
    if (q) list = list.filter((a) => (a.name || '').toLowerCase().includes(q));
    if (!list.length) {
        root.innerHTML = '<div class="muted" style="padding:24px;text-align:center;">'
            + 'Nothing found on this PC yet. Install something from the catalog, or drop an '
            + 'AppImage in your <b>Downloads</b> folder — it shows up here automatically.</div>';
        return;
    }
    const html = [
        `<h3 style="margin-top:18px;">💾  On this PC <span class="muted" style="font-weight:400;">(${list.length})</span></h3>`,
        '<div class="grid cols-2">',
    ];
    for (const a of list) {
        const tag = a.kind === 'appimage' ? 'AppImage' : 'Installed app';
        html.push(`
            <div class="card">
                <div class="row" style="align-items:flex-start;gap:10px;">
                    <div style="flex:1;min-width:0;">
                        <div style="font-weight:600;word-break:break-word;">${_escapeHtml(a.name)}</div>
                        <div class="muted" style="font-size:11px;margin-top:3px;">${tag}</div>
                    </div>
                    <div class="row" style="gap:6px;flex:0 0 auto;">
                        <button data-launch-disc="${_escapeHtml(a.id)}">Launch</button>
                    </div>
                </div>
            </div>
        `);
    }
    html.push('</div>');
    root.innerHTML = html.join('');
}

// Phase 15c — the "install anything" section: a button to search ALL official
// packages for the current query, and the results (with Install) once searched.
function _repoSectionHtml() {
    const q = (_appsState.search || '').trim();
    if (!q) return '';
    const parts = ['<div style="margin-top:20px;border-top:1px solid var(--line);padding-top:12px;">'];
    const haveResults = _appsState.repoQuery === q && _appsState.repoResults.length;
    if (!haveResults) {
        const label = _appsState.repoSearching
            ? 'Searching all packages…'
            : `🔎  Search all packages for "${_escapeHtml(q)}"`;
        parts.push(`<button data-search-all="1" ${_appsState.repoSearching ? 'disabled' : ''}>${label}</button>`);
        parts.push('<div class="muted" style="font-size:11px;margin-top:6px;">Installs from the official Arch repositories.</div>');
    } else {
        parts.push(`<div class="muted" style="margin:2px 0 8px;">All packages matching "${_escapeHtml(q)}" (${_appsState.repoResults.length}):</div>`);
        parts.push('<div class="grid cols-2">');
        for (const p of _appsState.repoResults) {
            const busy = _appsState.busy.has('pkg:' + p.name);
            const action = p.installed
                ? '<span class="muted" style="font-size:11px;">installed</span>'
                : `<button class="primary" ${busy ? 'disabled' : ''} data-install-pkg="${_escapeHtml(p.name)}">${busy ? 'Installing…' : 'Install'}</button>`;
            parts.push(`
                <div class="card">
                    <div class="row" style="align-items:flex-start;gap:10px;">
                        <div style="flex:1;min-width:0;">
                            <div style="font-weight:600;word-break:break-word;">${_escapeHtml(p.name)} <span class="muted" style="font-weight:400;font-size:11px;">${_escapeHtml(p.repo)}</span></div>
                            <div class="muted" style="font-size:11px;margin-top:3px;">${_escapeHtml(p.description || '')}</div>
                        </div>
                        <div class="row" style="gap:6px;flex:0 0 auto;">${action}</div>
                    </div>
                </div>`);
        }
        parts.push('</div>');
    }
    parts.push('</div>');
    return parts.join('');
}

function _renderAppsList() {
    const root = $('#apps-list');
    if (!root) return;
    if (_appsState.filter === 'discovered') { _renderDiscoveredList(root); return; }
    const { catalog, installed, busy, filter, search } = _appsState;
    if (!catalog.length) {
        root.innerHTML = '<div class="muted" style="padding:24px;text-align:center;">No apps in catalog.</div>';
        return;
    }
    const q = (search || '').trim().toLowerCase();
    const matches = (a) => {
        if (filter === 'installed' && !installed.has(a.id)) return false;
        if (filter !== 'all' && filter !== 'installed' && a.category !== filter) return false;
        if (!q) return true;
        return (a.label + ' ' + a.description).toLowerCase().includes(q);
    };
    const filtered = catalog.filter(matches);
    if (!filtered.length) {
        root.innerHTML = '<div class="muted" style="padding:24px;text-align:center;">' +
            'No matches in the curated catalog.</div>' + _repoSectionHtml();
        return;
    }
    const byCat = new Map();
    for (const a of filtered) {
        if (!byCat.has(a.category)) byCat.set(a.category, []);
        byCat.get(a.category).push(a);
    }
    const html = [];
    for (const [category, apps] of byCat) {
        const icon = CATEGORY_ICONS[category] || '📦';
        html.push(`<h3 style="margin-top:18px;">${icon}  ${_escapeHtml(category)}</h3>`);
        html.push('<div class="grid cols-2">');
        for (const a of apps) {
            const isInstalled = installed.has(a.id);
            const isBusy = busy.has(a.id);
            const btnLabel = isBusy
                ? (isInstalled ? 'Removing…' : 'Installing…')
                : (isInstalled ? 'Uninstall' : 'Install');
            const btnClass = isInstalled ? 'danger' : 'primary';
            const dataAttr = isInstalled
                ? `data-uninstall-id="${_escapeHtml(a.id)}"`
                : `data-install-id="${_escapeHtml(a.id)}"`;
            const launchBtn = (isInstalled && a.launchable)
                ? `<button data-launch="${_escapeHtml(a.id)}">Launch</button>`
                : '';
            html.push(`
                <div class="card">
                    <div class="row" style="align-items:flex-start;gap:10px;">
                        <div style="flex:1;min-width:0;">
                            <div style="font-weight:600;">${_escapeHtml(a.label)}</div>
                            <div class="muted" style="font-size:11px;margin-top:3px;">${_escapeHtml(a.description)}</div>
                        </div>
                        <div class="row" style="gap:6px;flex:0 0 auto;">
                            ${launchBtn}
                            <button class="${btnClass}" ${isBusy ? 'disabled' : ''} ${dataAttr}>${btnLabel}</button>
                        </div>
                    </div>
                </div>
            `);
        }
        html.push('</div>');
    }
    html.push(_repoSectionHtml());
    root.innerHTML = html.join('');
}

function setAppsFilter(filter) {
    _appsState.filter = filter || 'all';
    document.querySelectorAll('[data-apps-filter]').forEach((el) => {
        el.classList.toggle('active', el.dataset.appsFilter === _appsState.filter);
    });
    _renderAppsList();
}

function setAppsSearch(q) {
    _appsState.search = q || '';
    _renderAppsList();
}

async function loadAppsCatalog() {
    try {
        const [catalog, installedList, discovered] = await Promise.all([
            api.apps.catalog(),
            api.apps.installedList(),
            api.apps.discover(),
        ]);
        _appsState.catalog = catalog || [];
        _appsState.installed = new Set((installedList || []).filter((x) => x.installed).map((x) => x.id));
        _appsState.discovered = discovered || [];
    } catch {
        _appsState.catalog = [];
        _appsState.installed = new Set();
        _appsState.discovered = [];
    }
    _renderAppsList();
}

async function refreshAppsInstalledOnly() {
    // Cheaper refresh — only the install-state set, used after install/uninstall.
    try {
        const list = await api.apps.installedList();
        _appsState.installed = new Set((list || []).filter((x) => x.installed).map((x) => x.id));
    } catch {}
    _renderAppsList();
}

async function handleAppsInstall(id) {
    const app = _appsState.catalog.find((a) => a.id === id);
    if (!app) return;
    if (!isOnline()) { toast('You\'re offline — connect to the internet to install apps.'); return; }
    // Important installs (Essentials + Security) require the PIN/password.
    // Everyday apps install without prompting (passwordless via the polkit rule).
    if (['Essentials', 'Security'].includes(app.category)) {
        const ok = await requireImportantAuth();
        if (!ok) { toast('Cancelled — not installed.'); return; }
    }
    _appsState.busy.add(id);
    _renderAppsList();
    toast(`Installing ${app.label}…`);
    try {
        const r = await api.apps.install(id);
        if (r.ok) {
            toast(`${app.label} installed.`);
        } else {
            toast(`Install failed: ${(r.error || '').split('\n')[0].slice(0, 140) || 'unknown error'}`);
        }
    } catch (e) {
        toast(`Install failed: ${e.message}`);
    }
    _appsState.busy.delete(id);
    await refreshAppsInstalledOnly();
}

// Phase 15c — search all official packages for the current Apps-panel query.
async function searchAllPackages() {
    const q = (_appsState.search || '').trim();
    if (!q || _appsState.repoSearching) return;
    if (!isOnline()) { toast('You\'re offline — connect to the internet to search for apps.'); return; }
    _appsState.repoSearching = true;
    _renderAppsList();
    try {
        const r = await api.apps.search(q);
        _appsState.repoResults = (r && r.ok && Array.isArray(r.results)) ? r.results : [];
        _appsState.repoQuery = q;
        if (r && !r.ok && r.error) toast(r.error);
        else if (!_appsState.repoResults.length) toast(`No packages found for "${q}".`);
    } catch (e) {
        toast('Search failed: ' + e.message);
        _appsState.repoResults = [];
    }
    _appsState.repoSearching = false;
    _renderAppsList();
}

// Phase 15c — install any official package by name (from the search results).
async function handleAppsInstallPkg(name) {
    if (!name) return;
    if (!isOnline()) { toast('You\'re offline — connect to the internet to install apps.'); return; }
    // Installing arbitrary software is an "important" action — gate on PIN/password.
    const ok = await requireImportantAuth();
    if (!ok) { toast('Cancelled — not installed.'); return; }
    _appsState.busy.add('pkg:' + name);
    _renderAppsList();
    toast(`Installing ${name}…`);
    try {
        const r = await api.apps.installPkg(name);
        if (r.ok) {
            toast(`${name} installed.`);
            const hit = _appsState.repoResults.find((p) => p.name === name);
            if (hit) hit.installed = true;
        } else {
            toast('Install failed: ' + ((r.error || '').split('\n')[0].slice(0, 140) || 'unknown error'));
        }
    } catch (e) {
        toast('Install failed: ' + e.message);
    }
    _appsState.busy.delete('pkg:' + name);
    _renderAppsList();
}

async function handleAppsUninstall(id) {
    const app = _appsState.catalog.find((a) => a.id === id);
    if (!app) return;
    const ok = window.confirm(
        `Uninstall ${app.label}?\n\n` +
        `This removes the package and any of its dependencies that nothing else needs. ` +
        `You can reinstall it later from the Apps panel.`,
    );
    if (!ok) return;
    _appsState.busy.add(id);
    _renderAppsList();
    try {
        const r = await api.apps.uninstall(id);
        if (r.ok) {
            toast(`${app.label} removed.`);
        } else {
            toast(`Uninstall failed: ${(r.error || '').split('\n')[0].slice(0, 140) || 'unknown error'}`);
        }
    } catch (e) {
        toast(`Uninstall failed: ${e.message}`);
    }
    _appsState.busy.delete(id);
    await refreshAppsInstalledOnly();
}

// ---------------------------------------------------------------------------
// Network & Wi-Fi (Settings card + offline pill)
// ---------------------------------------------------------------------------
async function refreshNetStatus() {
    const el = $('#net-status');
    if (!el || !api.net) return;
    try {
        const s = await api.net.status();
        const online = s.connectivity === 'full';
        el.textContent = online
            ? `✔ Online${s.active ? ' — ' + s.active : ''}`
            : (s.connectivity === 'none' || s.connectivity === 'unknown')
                ? '✖ No internet connection' + (s.wifi ? ' — scan for Wi-Fi below' : '')
                : `△ Limited connection (${s.connectivity})${s.active ? ' — ' + s.active : ''}`;
        el.className = online ? 'ok-text' : 'warn-text';
        const pill = $('#offline-pill');
        if (pill) pill.hidden = online;
    } catch {
        el.textContent = 'Network status unavailable.';
    }
}

async function scanWifi() {
    const list = $('#wifi-list');
    const btn = $('#wifi-scan');
    if (!list || !api.net) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Scanning…'; }
    list.innerHTML = '<div class="muted" style="padding:8px;">Looking for networks (a few seconds)…</div>';
    try {
        const r = await api.net.wifiList();
        if (!r.ok || !r.networks.length) {
            list.innerHTML = '<div class="muted" style="padding:8px;">' +
                (r.error ? _escapeHtml(r.error) : 'No Wi-Fi networks found. (Wired connections work automatically when plugged in.)') + '</div>';
            return;
        }
        list.innerHTML = '';
        for (const n of r.networks) {
            const row = document.createElement('div');
            row.className = 'wifi-row';
            const bars = n.signal >= 70 ? '▂▄▆█' : n.signal >= 45 ? '▂▄▆' : n.signal >= 20 ? '▂▄' : '▂';
            row.innerHTML =
                `<span class="wifi-name">${n.inUse ? '✔ ' : ''}${_escapeHtml(n.ssid)}</span>` +
                `<span class="wifi-meta">${n.security ? '🔒' : 'open'} ${bars}</span>` +
                // Saved (but not connected) networks can be forgotten — fixes the
                // "stale profile after a password change" trap without a terminal.
                (n.saved && !n.inUse
                    ? `<button class="wifi-forget" title="Forget this network (delete the saved profile)" aria-label="Forget ${_escapeHtml(n.ssid)}">Forget</button>`
                    : '') +
                `<button class="wifi-join" ${n.inUse ? 'disabled' : ''}>${n.inUse ? 'Connected' : 'Connect'}</button>`;
            const forgetBtn = row.querySelector('.wifi-forget');
            if (forgetBtn) forgetBtn.addEventListener('click', async () => {
                forgetBtn.disabled = true;
                try {
                    const fr = await api.net.wifiForget(n.ssid);
                    toast(fr && fr.ok ? `Forgot ${n.ssid}.` : ((fr && fr.error) || 'Couldn\'t forget that network.'));
                    if (fr && fr.ok) scanWifi();
                    else forgetBtn.disabled = false;
                } catch { forgetBtn.disabled = false; }
            });
            const joinBtn = row.querySelector('.wifi-join');
            joinBtn.addEventListener('click', () => {
                // Collapse any other open password form first.
                $$('.wifi-pwform').forEach((f) => f.remove());
                if (!n.security) { connectWifi(n.ssid, '', row); return; }
                const form = document.createElement('div');
                form.className = 'wifi-pwform';
                form.innerHTML =
                    `<input type="password" placeholder="Wi-Fi password for ${_escapeHtml(n.ssid)}" autocomplete="off">` +
                    `<button class="primary">Join</button>`;
                row.after(form);
                const input = form.querySelector('input');
                const go = () => { if (input.value) connectWifi(n.ssid, input.value, row, form); };
                form.querySelector('button').addEventListener('click', go);
                input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
                input.focus();
            });
            list.appendChild(row);
        }
    } catch (e) {
        list.innerHTML = `<div class="muted" style="padding:8px;">Scan failed: ${_escapeHtml(e.message)}</div>`;
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '⟳ Scan for Wi-Fi'; }
    }
}

async function connectWifi(ssid, password, row, form) {
    toast(`Connecting to ${ssid}…`);
    const btn = row ? row.querySelector('.wifi-join') : null;
    if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
    try {
        const r = await api.net.wifiConnect(ssid, password);
        if (r.ok) {
            toast(`✔ Connected to ${ssid}.`);
            if (form) form.remove();
            await refreshNetStatus();
            await scanWifi();
        } else {
            toast('Could not connect: ' + (r.error || 'unknown error'));
            if (btn) { btn.disabled = false; btn.textContent = 'Connect'; }
        }
    } catch (e) {
        toast('Could not connect: ' + e.message);
        if (btn) { btn.disabled = false; btn.textContent = 'Connect'; }
    }
}

function wireNetworkUI() {
    const scanBtn = $('#wifi-scan');
    if (scanBtn) scanBtn.addEventListener('click', scanWifi);
    const pill = $('#offline-pill');
    if (pill) pill.addEventListener('click', () => {
        showScreen('settings');
        const card = $('#net-card');
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        scanWifi();
    });
}

async function launchDiscoveredApp(id) {
    try {
        const r = await api.apps.launchDiscovered(id);
        toast(r && r.ok ? `Launching ${r.label}…` : (r && r.error ? r.error : 'Could not launch.'));
    } catch (e) {
        toast('Launch failed: ' + e.message);
    }
}

async function loadSysInfo() {
    try {
        const i = await api.system.info();
        const gpu = await api.system.gpu();
        // QoL — show free disk space at a glance (handy on small drives).
        let diskLine = '';
        try {
            const d = await api.system.disk();
            if (d && d.available && d.totalMb) {
                const freeGb = (Math.max(0, d.totalMb - d.usedMb) / 1024).toFixed(1);
                const totGb = (d.totalMb / 1024).toFixed(0);
                diskLine = `\nDISK ${freeGb} GB free of ${totGb} GB (${d.pct}% used)`;
            }
        } catch {}
        $('#sysinfo').textContent =
            `${i.hostname}  •  ${i.cpu} (${i.cores} cores)\nRAM ${i.ramUsed}/${i.ramTotal}  •  kernel ${i.kernel}\nGPU ${gpu}${diskLine}`;
        const v = $('#app-version'); if (v) v.textContent = 'v' + (i.appVersion || '?');
    } catch {
        $('#sysinfo').textContent = 'Preview mode — full telemetry available on Outlaw Server.';
    }
}

async function checkShellUpdate() {
    const status = $('#shell-update-status');
    const btn = $('#install-shell-btn');
    if (!isOnline()) { status.textContent = 'You\'re offline — connect to the internet to check for updates.'; return; }
    status.textContent = 'checking GitHub…';
    btn.disabled = true;
    const r = await api.updates.checkShell();
    if (!r.ok) { status.textContent = r.error; pendingUpdate = null; return; }
    if (!r.available) {
        status.textContent = `up to date (v${r.currentVersion})`;
        pendingUpdate = null;
        return;
    }
    pendingUpdate = r;
    status.textContent = `v${r.remoteVersion} available (you have v${r.currentVersion})`;
    btn.disabled = false;
}

async function installShellUpdate() {
    if (!pendingUpdate || !pendingUpdate.assetUrl) { toast('Run "Check for shell updates" first.'); return; }
    const status = $('#shell-update-status');
    status.textContent = 'downloading + verifying…';
    $('#install-shell-btn').disabled = true;
    const r = await api.updates.installShell({
        assetUrl: pendingUpdate.assetUrl,
        shaUrl: pendingUpdate.shaUrl,
    });
    if (!r.ok) {
        status.textContent = r.error;
        $('#install-shell-btn').disabled = false;
        return;
    }
    status.textContent = 'installed — restart the shell to load it.';
    toast('Update installed. Restart the shell to finish.');
    pendingUpdate = null;
    // A successful update leaves a .prev behind; flip the Rollback button on.
    refreshRollbackAvailability();
}

// Repair / reinstall: re-download the latest release and reinstall ALL Outlaw
// code (shell + helpers + greeter + first-boot + installer + CodeMaker code),
// keeping the user's files, apps and settings. Fixes a half-applied update or a
// system whose helpers got out of sync with the shell.
async function repairShell() {
    const status = $('#repair-status');
    if (!window.confirm(
        'Reinstall the Outlaw Server system code from the latest release?\n\n' +
        'This refreshes the shell, the helper tools, the installer and CodeMaker\'s code. ' +
        'Your files, installed apps, accounts and settings are KEPT. The desktop restarts afterwards.')) return;
    status.textContent = 'fetching latest release…';
    let r;
    try { r = await api.updates.checkShell(); } catch (e) { status.textContent = e.message; return; }
    if (!r || (!r.assetUrl)) { status.textContent = (r && r.error) || 'No release payload found to reinstall from.'; return; }
    status.textContent = 'downloading + reinstalling all components…';
    const res = await api.updates.installShell({ assetUrl: r.assetUrl, shaUrl: r.shaUrl });
    if (!res || !res.ok) { status.textContent = (res && res.error) || 'Repair failed.'; toast('Repair failed: ' + ((res && res.error) || '').slice(0, 120)); return; }
    status.textContent = '✓ reinstalled — restart the shell to finish.';
    toast('Outlaw Server reinstalled. Restart the desktop to finish.');
    refreshRollbackAvailability();
}

// Probe whether /usr/share/outlaw-os.prev exists so the Rollback button is
// only enabled when there's actually something to roll back to.
async function refreshRollbackAvailability() {
    const btn = $('#rollback-shell-btn');
    const status = $('#rollback-status');
    if (!btn) return;
    try {
        const r = await api.updates.checkRollback();
        btn.disabled = !r.available;
        if (status) status.textContent = r.available ? '' : (r.note || 'no previous version on disk');
    } catch (err) {
        btn.disabled = true;
        if (status) status.textContent = 'check failed';
    }
}

// C8 — "use storage as extra memory" (swapfile) status + toggle.
let _swapBusy = false;
async function refreshSwapStatus() {
    const tog = $('#swap-toggle');
    if (!tog) return;
    try {
        const r = await api.swap.status();
        if (r && r.ok) {
            tog.checked = !!r.swapfile;
            const sub = $('#swap-sub');
            if (sub && r.swapfile && r.swapTotalMb) {
                const amt = r.swapTotalMb >= 1024 ? (r.swapTotalMb / 1024).toFixed(1) + ' GB' : r.swapTotalMb + ' MB';
                sub.textContent = 'On — ' + amt + ' of storage usable as memory. Slower than real RAM; turn off any time.';
            }
        }
    } catch {}
}
async function onSwapToggle(e) {
    const tog = e.target;
    if (_swapBusy) return;
    const turnOn = tog.checked;
    if (turnOn && !window.confirm(
        'Use storage as extra memory?\n\n' +
        'Creates a 4 GB swapfile so the system can keep an AI model + the desktop ' +
        'running when RAM is tight. It is slower than real RAM and uses 4 GB of disk, ' +
        'but you can turn it off any time.')) {
        tog.checked = false; return;
    }
    _swapBusy = true;
    const sub = $('#swap-sub');
    if (sub) sub.textContent = turnOn ? 'setting up swapfile — enter your password if prompted (can take a minute)…' : 'removing swapfile…';
    try {
        const r = await api.swap.set({ on: turnOn, sizeGb: 4 });
        if (!r || !r.ok) {
            toast('Storage-as-memory ' + (turnOn ? 'setup' : 'removal') + ' failed.');
            tog.checked = !turnOn;
            if (sub) sub.textContent = (r && r.error) ? r.error.slice(-180) : 'failed';
        } else {
            toast(turnOn ? 'Storage-as-memory enabled.' : 'Storage-as-memory disabled.');
        }
    } catch (err) {
        toast('Failed: ' + err.message);
        tog.checked = !turnOn;
    } finally {
        _swapBusy = false;
        refreshSwapStatus();
    }
}

async function rollbackShell() {
    const btn = $('#rollback-shell-btn');
    const status = $('#rollback-status');
    if (!btn || btn.disabled) return;
    const ok = window.confirm(
        'Roll back to the previous Outlaw shell?\n\n' +
        'This swaps /usr/share/outlaw-os with /usr/share/outlaw-os.prev. ' +
        'You can roll forward again by clicking the same button after the swap.\n\n' +
        'You\'ll need to restart the shell (or reboot) to see the change.',
    );
    if (!ok) return;
    btn.disabled = true;
    if (status) status.textContent = 'rolling back — enter your password if prompted…';
    try {
        const r = await api.updates.rollback();
        if (!r.ok) {
            if (status) status.textContent = r.error || 'rollback failed';
            btn.disabled = false;
            return;
        }
        if (status) status.textContent = 'rolled back — restart the shell to load it.';
        toast('Rolled back. Restart the shell to finish.');
    } catch (err) {
        if (status) status.textContent = 'rollback failed: ' + err.message;
        btn.disabled = false;
    }
    refreshRollbackAvailability();
}

async function launchApp(id) {
    const r = await api.apps.launch(id);
    toast(r.ok ? `Launching ${r.label}…` : (r.error || 'Could not launch.'));
    // Keep the Dashboard's "Recent" row current when launching from it.
    if (r.ok && currentScreen === 'dashboard') renderRecentApps();
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------
let currentDir = null;
let parentDir = null;
let _fsFilter = '';
async function loadFiles(dir) {
    // In the browser panel this whole namespace rejects (files still run only in
    // the local Electron panel). Unhandled, that threw straight past the render
    // and landed in the crash reporter — so the screen stayed blank and the
    // explanation went somewhere the user never looks. Catch it and say so on
    // the screen instead: "degrade visibly" has to mean visible HERE.
    let res;
    try {
        res = await api.files.list(dir);
    } catch (e) {
        const list = $('#fs-list');
        if (list) list.innerHTML = `<div class="muted" style="padding:10px;">${_escapeHtml((e && e.message) || String(e))}</div>`;
        return;
    }
    if (res.error) { toast(res.error); }
    currentDir = res.path; parentDir = res.parent;
    renderBreadcrumb(res.path);
    const list = $('#fs-list');
    list.innerHTML = '';
    if (!res.entries || !res.entries.length) {
        // Distinguish a genuinely empty folder from one we couldn't read, and
        // note that hidden (dot) files aren't shown — a fresh home holds mostly
        // those, which is why it can look empty.
        list.innerHTML = res.error
            ? `<div class="muted" style="padding:10px;">Couldn't open this folder: ${_escapeHtml(res.error)}</div>`
            : '<div class="muted" style="padding:10px;">This folder is empty. (Hidden system files aren\'t shown.)</div>';
        return;
    }
    for (const e of res.entries) {
        const row = document.createElement('button');
        row.className = 'fs-row';
        row.dataset.name = e.name;
        row.dataset.type = e.type;
        const ico = e.type === 'dir' ? '📁' : '📄';
        const size = e.type === 'file' ? humanSize(e.size) : '';
        row.innerHTML = `<span>${ico}</span><span>${escapeHtml(e.name)}</span><span class="sz">${size}</span>`;
        list.appendChild(row);
    }
    applyFsFilter();   // keep any active filter applied across navigation
}

// QoL — a clickable breadcrumb so you can jump back up several levels in one tap
// (instead of pressing Up repeatedly).
function renderBreadcrumb(p) {
    const el = $('#fs-path');
    if (!el) return;
    el.innerHTML = '';
    el.classList.add('fs-crumbs');
    const mkCrumb = (label, target) => {
        const b = document.createElement('button');
        b.className = 'crumb';
        b.textContent = label;
        b.addEventListener('click', () => loadFiles(target));
        return b;
    };
    el.appendChild(mkCrumb('/', '/'));
    let acc = '';
    for (const seg of String(p || '').split('/').filter(Boolean)) {
        acc += '/' + seg;
        const sep = document.createElement('span'); sep.className = 'crumb-sep'; sep.textContent = '›';
        el.appendChild(sep);
        el.appendChild(mkCrumb(seg, acc));
    }
}

// QoL — live filter of the current folder (name contains, case-insensitive).
function applyFsFilter() {
    const q = _fsFilter.trim().toLowerCase();
    for (const row of $$('#fs-list .fs-row')) {
        const name = (row.dataset.name || '').toLowerCase();
        row.style.display = (!q || name.includes(q)) ? '' : 'none';
    }
}
function humanSize(b) {
    if (!b) return '';
    const u = ['B', 'K', 'M', 'G']; let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return b.toFixed(b < 10 && i > 0 ? 1 : 0) + u[i];
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------
// ---- Phase 5: Task Manager -------------------------------------------------
let tasksTimer = null;
let _procSort = { key: 'cpu', asc: false };   // default: CPU, biggest first
let _selectedPid = null;
let _lastProcs = [];
let _procFilter = '';

function _sortProcs(list) {
    const { key, asc } = _procSort;
    const numeric = (key === 'pid' || key === 'cpu' || key === 'memMb');
    const out = list.slice().sort((a, b) => numeric
        ? (Number(a[key]) || 0) - (Number(b[key]) || 0)
        : String(a[key]).localeCompare(String(b[key])));
    if (!asc) out.reverse();
    return out;
}

function _fmtMem(p) {
    if (p.memMb == null) return p.mem + '%';
    return p.memMb >= 1024 ? (p.memMb / 1024).toFixed(1) + ' GB' : p.memMb + ' MB';
}

function _renderProcs() {
    const body = $('#proc-body');
    if (!body) return;
    const wrap = $('#proc-wrap');
    const keepScroll = wrap ? wrap.scrollTop : 0;   // survive the 2s rebuild
    let rows = _sortProcs(_lastProcs);
    if (_procFilter) rows = rows.filter((p) => String(p.comm).toLowerCase().includes(_procFilter));
    body.innerHTML = '';
    for (const p of rows) {
        const tr = document.createElement('tr');
        tr.dataset.pid = p.pid;
        tr.tabIndex = 0;   // a11y — rows are keyboard-focusable/selectable, not mouse-only
        if (String(p.pid) === String(_selectedPid)) tr.classList.add('sel');
        tr.innerHTML = `<td class="mono">${p.pid}</td><td>${escapeHtml(p.comm)}</td>`
            + `<td class="right mono">${p.cpu}</td><td class="right mono">${_fmtMem(p)}</td>`;
        body.appendChild(tr);
    }
    // QoL — empty state (filter matched nothing, or the list isn't ready yet).
    if (!rows.length) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="4" class="muted" style="padding:18px;text-align:center;">'
            + (_procFilter ? `No processes match “${escapeHtml(_procFilter)}”.` : 'Reading the process list…')
            + '</td>';
        body.appendChild(tr);
    }
    if (wrap) wrap.scrollTop = keepScroll;
    $$('#screen-tasks .proc th[data-sort]').forEach((th) => {
        const on = th.dataset.sort === _procSort.key;
        th.classList.toggle('sorted', on);
        th.classList.toggle('asc', on && _procSort.asc);
        // a11y — announce sort state to screen readers, kept in sync with _procSort.
        th.setAttribute('aria-sort', on ? (_procSort.asc ? 'ascending' : 'descending') : 'none');
    });
}

function _selectProc(pid) {
    _selectedPid = pid;
    const sel = _lastProcs.find((p) => String(p.pid) === String(pid));
    const lbl = $('#task-sel');
    if (lbl) lbl.textContent = sel ? `selected: ${sel.comm} (PID ${sel.pid})` : '';
    const end = $('#task-end'), endTree = $('#task-end-tree');
    if (end) end.disabled = !sel;
    if (endTree) endTree.disabled = !sel;
    $$('#proc-body tr').forEach((tr) => tr.classList.toggle('sel', tr.dataset.pid === String(pid)));
}

async function refreshTasks() {
    try { _lastProcs = await api.system.processes(); } catch { _lastProcs = []; }
    // Drop a stale selection (process exited) so the buttons disable themselves.
    if (_selectedPid && !_lastProcs.some((p) => String(p.pid) === String(_selectedPid))) {
        _selectProc(null);
    }
    _renderProcs();
    updateBars();
}

async function updateBars() {
    try {
        const s = await api.system.stats();
        $('#cpu-bar').style.width = Math.min(100, s.cpu).toFixed(0) + '%';
        $('#ram-bar').style.width = Math.min(100, s.ramPct).toFixed(0) + '%';
        $('#cpu-val').textContent = s.cpu.toFixed(0) + '%';
        $('#ram-val').textContent = `${s.ramUsed} / ${s.ramTotal} (${s.ramPct.toFixed(0)}%)`;
    } catch {}
    try {
        const g = await api.system.gpuDetailed();
        const bar = $('#gpu-bar'), val = $('#gpu-val');
        if (g && g.available && g.vramTotalMb > 0) {
            if (bar) bar.style.width = Math.min(100, g.vramPct).toFixed(0) + '%';
            if (val) val.textContent =
                `${(g.vramUsedMb / 1024).toFixed(1)} / ${(g.vramTotalMb / 1024).toFixed(1)} GB (${g.vramPct}%)`;
        } else {
            if (bar) bar.style.width = '0%';
            if (val) val.textContent = (g && g.name) ? g.name : 'n/a';
        }
    } catch {}
}

function startTasksPoll() {
    stopTasksPoll();
    tasksTimer = setInterval(() => {
        const scr = $('#screen-tasks');
        if (scr && scr.classList.contains('active')) refreshTasks();
        else stopTasksPoll();          // safety net if we somehow left without teardown
    }, 2000);
}
function stopTasksPoll() { if (tasksTimer) { clearInterval(tasksTimer); tasksTimer = null; } }

// ---- Phase 6: Help database ------------------------------------------------
function _helpSearchText(t) {
    return (t.title + ' ' + (t.keywords || '') + ' ' + String(t.body).replace(/<[^>]+>/g, ' ')).toLowerCase();
}
function renderHelp(query) {
    const host = $('#help-results');
    if (!host) return;
    const topics = window.OUTLAW_HELP || [];
    const q = (query || '').trim().toLowerCase();
    const matches = q ? topics.filter((t) => _helpSearchText(t).includes(q)) : topics;
    if (matches.length === 0) {
        host.innerHTML = '<div class="muted">No help topics match “' + escapeHtml(query) + '”.</div>';
        return;
    }
    // Group by category in the declared order, appending any unknown categories.
    const order = (window.OUTLAW_HELP_CATS || []).slice();
    const seen = new Set(order);
    for (const t of matches) if (!seen.has(t.cat)) { order.push(t.cat); seen.add(t.cat); }
    let html = '';
    for (const cat of order) {
        const inCat = matches.filter((t) => t.cat === cat);
        if (!inCat.length) continue;
        html += '<h3 class="help-cat">' + escapeHtml(cat) + '</h3>';
        for (const t of inCat) {
            // While searching, open matches so the answer shows immediately.
            html += '<details class="help-topic"' + (q ? ' open' : '') + '>'
                + '<summary>' + escapeHtml(t.title) + '</summary>'
                + '<div class="help-body">' + t.body + '</div></details>';
        }
    }
    host.innerHTML = html;
}

// ---- Phase 6: first-boot Quickstart tour -----------------------------------
// The order here is the order things should actually be done on a new machine:
// lock the door first, then open the one you meant to open.
const QUICKSTART_STEPS = [
    { ico: '⛨', title: 'Welcome to Outlaw Server', body: '<p>A stripped-down Linux server you manage from a browser. This quick tour shows where everything is, in the order worth doing it — you can <b>Skip</b> at any time.</p>' },
    { ico: '🔑', title: 'First: secure the sign-in', body: '<p>Run <code>sudo outlaw passwd</code> to create the administrator. It prints a <b>two-factor secret</b> — add it to a free authenticator app, then confirm it with <code>sudo outlaw 2fa &lt;user&gt; &lt;code&gt;</code>.</p><p>Two-factor isn’t enforced until that confirmation works, so a mistyped secret can’t lock you out.</p>' },
    { ico: '🔗', title: 'Then: reach it from anywhere', body: '<p><code>sudo outlaw remote up</code> joins a free <b>Tailscale</b> network and prints a sign-in link. <code>sudo outlaw remote bind tunnel</code> moves the panel onto it.</p><p>Now it’s reachable from your laptop — and from nowhere on the open internet.</p>' },
    { ico: '📦', title: 'Install only what you need', body: '<p><b>Apps</b> installs <b>Docker</b>, <b>Portainer</b> and <b>Cockpit</b> in one click, plus a guided <b>Pterodactyl</b> setup for game servers. A fresh machine ships with none of it, so an idle server runs nothing it wasn’t told to.</p>' },
    { ico: '🛡', title: 'Open ports on purpose', body: '<p><b>Services</b>, <b>System Log</b> and <b>Firewall</b> are where you run the box day to day. Your game servers need open ports; <b>the control panel never does</b> — it rides the tunnel.</p>' },
    { ico: '❔', title: 'Stuck? Open Help', body: '<p>The <b>Help</b> screen explains every part of the OS and how to fix common problems, with a search box. You can replay this tour from there too.</p><p>This is <b>alpha</b> software — if something breaks, <b>Settings → Report a problem</b> collects the log for you.</p>' },
];
let _qsIndex = 0;

function renderQuickstartStep() {
    const s = QUICKSTART_STEPS[_qsIndex];
    if (!s) return;
    $('#qs-ico').textContent = s.ico;
    $('#qs-title').textContent = s.title;
    $('#qs-body').innerHTML = s.body;
    $('#qs-dots').innerHTML = QUICKSTART_STEPS.map((_, i) => `<span class="${i === _qsIndex ? 'on' : ''}"></span>`).join('');
    $('#qs-back').disabled = _qsIndex === 0;
    $('#qs-next').textContent = (_qsIndex === QUICKSTART_STEPS.length - 1) ? 'Finish' : 'Next';
}
function showQuickstart() {
    const ov = $('#quickstart');
    if (!ov) return;
    _qsIndex = 0;
    ov.style.display = 'flex';
    renderQuickstartStep();
}
async function endQuickstart() {
    const ov = $('#quickstart');
    if (ov) ov.style.display = 'none';
    await setSetting({ quickstartSeen: true });   // "don't show again"
}
async function maybeShowQuickstart() {
    try {
        const s = await api.settings.get();
        if (!s.quickstartSeen) showQuickstart();
    } catch {}
}

// ---------------------------------------------------------------------------
// Live top-bar stats
// ---------------------------------------------------------------------------
// The battery indicator went with the rest of the desktop OS, but its ~16s poll
// stayed behind — calling an api.system.battery that no longer exists, four
// times a minute, forever, swallowed by a try/catch. Removed: a server has no
// battery indicator to show, and idle work for a feature that doesn't exist is
// exactly what "zero idle cost" is supposed to rule out.

function startStats() {
    const tick = async () => {
        try {
            const s = await api.system.stats();
            $('#stat-cpu').textContent = `CPU ${s.cpu.toFixed(0)}%`;
            $('#stat-ram').textContent = `RAM ${s.ramUsed}`;
            const clk = $('#stat-clock');
            clk.textContent = s.time;
            // QoL — full date on hover.
            try { clk.title = new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); } catch {}
        } catch {}
    };
    tick();
    if (statsTimer) clearInterval(statsTimer);   // never stack pollers (defensive)
    statsTimer = setInterval(tick, 2000);
}

// ---------------------------------------------------------------------------
// Terminal (guarded)
// ---------------------------------------------------------------------------
async function inspectCommand(cmd) {
    const hint = $('#term-hint');
    if (!cmd.trim()) { hint.textContent = ''; hint.classList.remove('warn'); return; }
    try {
        const c = await api.terminal.inspect(cmd);
        if (c.danger) { hint.textContent = '⚠ ' + c.reason + ' — confirmation required.'; hint.classList.add('warn'); }
        else { hint.textContent = ''; hint.classList.remove('warn'); }
    } catch {}
}

// QoL — bash-like command history (Up/Down recall) for the terminal.
let _termHist = [];
let _termHistIdx = -1;   // -1 = at the live (un-navigated) input line
function _termHistPush(cmd) {
    if (_termHist[_termHist.length - 1] !== cmd) _termHist.push(cmd);
    if (_termHist.length > 100) _termHist.shift();
    _termHistIdx = -1;
}
function _termHistNav(dir, input) {
    if (!_termHist.length) return;
    if (_termHistIdx === -1) _termHistIdx = _termHist.length;   // begin just past the end
    _termHistIdx = Math.max(0, Math.min(_termHist.length, _termHistIdx + dir));
    input.value = _termHistIdx >= _termHist.length ? '' : _termHist[_termHistIdx];
    requestAnimationFrame(() => { try { input.setSelectionRange(input.value.length, input.value.length); } catch {} });
    inspectCommand(input.value);
}

async function runTerminal(cmd) {
    const out = $('#term-out');
    out.value += `> ${cmd}\n`;
    const c = await api.terminal.inspect(cmd);
    let confirmDangerous = false;
    if (c.danger) {
        const ok = await askConfirm({ title: 'Dangerous command', reason: c.reason, cmd });
        if (!ok) { out.value += '(cancelled)\n\n'; out.scrollTop = out.scrollHeight; return; }
        confirmDangerous = true;
    }
    const r = await api.terminal.run(cmd, { confirmDangerous });
    if (r.blocked) out.value += `[blocked] ${r.reason}\n\n`;
    else out.value += `${(r.stdout || r.stderr || `(exit ${r.code})`)}\n\n`;
    out.scrollTop = out.scrollHeight;
}

// ---------------------------------------------------------------------------
// Confirm modal (shared by terminal + AI run_command)
// ---------------------------------------------------------------------------
let _confirmOpener = null;   // a11y — restore focus to whatever opened the dialog
function askConfirm({ title, reason, cmd }) {
    _confirmOpener = document.activeElement;
    $('#confirm-title').textContent = title || 'Confirm dangerous action';
    $('#confirm-reason').textContent = reason || '';
    $('#confirm-cmd').textContent = cmd || '';
    $('#confirm-input').value = '';
    $('#confirm-go').disabled = true;
    $('#confirm-modal').classList.add('show');
    $('#confirm-input').focus();
    return new Promise((resolve) => { confirmResolver = resolve; });
}
function closeConfirm(result) {
    $('#confirm-modal').classList.remove('show');
    try { if (_confirmOpener && _confirmOpener.focus) _confirmOpener.focus(); } catch {}
    _confirmOpener = null;
    if (confirmResolver) { confirmResolver(result); confirmResolver = null; }
}

// ---------------------------------------------------------------------------
// AI chat
// ---------------------------------------------------------------------------
function addMsg(kind, text) {
    const log = $('#ai-log');
    const div = document.createElement('div');
    div.className = 'msg ' + kind;
    const body = document.createElement('span');
    body.className = 'msg-text';
    body.textContent = text;
    div.appendChild(body);
    // QoL — a hover-revealed Copy button on AI replies (handy for commands the
    // assistant prints, or to paste an answer elsewhere).
    if (kind === 'ai') {
        const btn = document.createElement('button');
        btn.className = 'msg-copy';
        btn.type = 'button';
        btn.title = 'Copy this message';
        btn.setAttribute('aria-label', 'Copy this message');   // a11y: icon-only button needs a name
        btn.textContent = '⧉';
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                await navigator.clipboard.writeText(body.textContent || '');
                btn.textContent = '✓';
                setTimeout(() => { btn.textContent = '⧉'; }, 1200);
            } catch { toast('Couldn\'t copy to clipboard.'); }
        });
        div.appendChild(btn);
    }
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
}

// ---------------------------------------------------------------------------
// Phase 15b — persistent AI chats (Cr1tt3r). Named, multi-turn conversations
// kept in userData so they survive updates. Windowed memory: the most recent
// turns are re-sent each ask so Cr1tt3r follows context; older turns stay saved.
// (An AI summary of the older turns lands in the next slice.)
// ---------------------------------------------------------------------------
let aiChats = { activeId: null, conversations: [] };
const AI_CHAT_WINDOW = 10;     // recent messages re-sent for memory
const AI_SUMMARY_BATCH = 6;    // summarize once this many turns age past the window
let _aiChatsSaveTimer = null;
let _deleteArmed = false;      // two-click delete guard (Electron has no confirm())
let _summarizing = false;      // at most one summary request in flight

function aiActiveConvo() {
    return aiChats.conversations.find((c) => c.id === aiChats.activeId) || null;
}

function persistAiChats() {
    clearTimeout(_aiChatsSaveTimer);
    _aiChatsSaveTimer = setTimeout(() => {
        if (api.ai && api.ai.chats) api.ai.chats.save(aiChats).catch(() => {});
    }, 250);
}

function newConvoObject(title) {
    return {
        id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        title: title || 'New chat',
        autoTitled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        summary: '',
        summaryUpTo: 0,
    };
}

function rebuildAiChatSelect() {
    const sel = $('#ai-chat-select');
    if (!sel) return;
    sel.innerHTML = '';
    for (const c of aiChats.conversations) {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.title || 'Untitled';
        sel.appendChild(opt);
    }
    if (aiChats.activeId) sel.value = aiChats.activeId;
    // The custom no-WM dropdown snapshots options at enhance time, so drop the
    // old wrapper and re-enhance for the current conversation list.
    const wrap = sel.nextElementSibling;
    if (wrap && wrap.classList.contains('cselect')) wrap.remove();
    delete sel.dataset.enhanced;
    enhanceSelects(sel.parentElement);
    rebuildRefSelect();
}

// Phase 15b (slice 3) — the "↗ Reference…" dropdown lists the OTHER chats; picking
// one makes Cr1tt3r draw on it in this conversation. Referenced chats show a ✓.
function rebuildRefSelect() {
    const sel = $('#ai-ref-select');
    if (!sel) return;
    const c = aiActiveConvo();
    sel.innerHTML = '';
    const ph = document.createElement('option');
    ph.value = ''; ph.textContent = '↗ Reference…';
    sel.appendChild(ph);
    for (const conv of aiChats.conversations) {
        if (!c || conv.id === c.id) continue;
        const opt = document.createElement('option');
        opt.value = conv.id;
        const on = !!(c.refs && c.refs.some((r) => r.id === conv.id));
        opt.textContent = (on ? '✓ ' : '') + (conv.title || 'Untitled');
        sel.appendChild(opt);
    }
    sel.value = '';
    const wrap = sel.nextElementSibling;
    if (wrap && wrap.classList.contains('cselect')) wrap.remove();
    delete sel.dataset.enhanced;
    enhanceSelects(sel.parentElement);
}

// A compact recap of a chat to feed as cross-chat context: its running summary if
// it has one, else its most recent turns.
function recapOf(convo) {
    if (!convo) return '';
    if (convo.summary) return convo.summary;
    const msgs = (convo.messages || []).slice(-8)
        .map((m) => (m.role === 'user' ? 'User: ' : 'Cr1tt3r: ') + String(m.content || ''));
    return msgs.join('\n').slice(0, 1500) || '(empty chat)';
}

// Toggle a reference to another chat on/off for the active conversation.
function referenceChat(id) {
    const c = aiActiveConvo();
    const src = aiChats.conversations.find((x) => x.id === id);
    if (!c || !src || src.id === c.id) return;
    if (!Array.isArray(c.refs)) c.refs = [];
    const i = c.refs.findIndex((r) => r.id === id);
    if (i >= 0) {
        c.refs.splice(i, 1);
        addMsg('sys', '↗ Stopped referencing "' + (src.title || 'Untitled') + '".');
    } else {
        c.refs.push({ id, title: src.title || 'Untitled' });
        addMsg('sys', '↗ Now referencing "' + (src.title || 'Untitled') + '" — Cr1tt3r can draw on that chat.');
    }
    persistAiChats();
    rebuildRefSelect();
}

function loadConvoIntoLog() {
    const log = $('#ai-log');
    if (log) log.innerHTML = '';
    const c = aiActiveConvo();
    if (!c) return;
    if (!c.messages.length) {
        addMsg('ai', 'Cr1tt3r here. Ask me anything, or tell me to do things — "install krita", '
            + '"use less VRAM", "switch to the gold theme", "open settings".');
        renderStarterChips();
        return;
    }
    for (const m of c.messages) addMsg(m.role === 'user' ? 'user' : 'ai', m.content);
}

// QoL — clickable starter prompts in a brand-new chat so new users see what the
// assistant can do. Clicking one sends it. Removed as soon as the chat has content.
const AI_STARTER_PROMPTS = [
    'What can you do?',
    'Open the Apps page',
    'Use less VRAM',
    'Install a photo editor',
];
function renderStarterChips() {
    const log = $('#ai-log');
    if (!log) return;
    const wrap = document.createElement('div');
    wrap.className = 'starter-chips';
    for (const p of AI_STARTER_PROMPTS) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'starter-chip';
        chip.textContent = p;
        chip.addEventListener('click', () => {
            const input = $('#ai-in');
            if (input) { input.value = p; sendAI(); }
        });
        wrap.appendChild(chip);
    }
    log.appendChild(wrap);
}

async function initAiChats() {
    try {
        if (api.ai && api.ai.chats) aiChats = await api.ai.chats.load();
    } catch { aiChats = { activeId: null, conversations: [] }; }
    if (!aiChats || !Array.isArray(aiChats.conversations)) aiChats = { activeId: null, conversations: [] };
    if (!aiChats.conversations.length) {
        const c = newConvoObject('Chat 1');
        aiChats.conversations.push(c);
        aiChats.activeId = c.id;
        persistAiChats();
    }
    if (!aiActiveConvo()) aiChats.activeId = aiChats.conversations[0].id;
    rebuildAiChatSelect();
    loadConvoIntoLog();
}

function switchAiChat(id) {
    if (!id || id === aiChats.activeId) return;
    aiChats.activeId = id;
    _deleteArmed = false;
    persistAiChats();
    rebuildAiChatSelect();
    loadConvoIntoLog();
}

function newAiChat() {
    const c = newConvoObject('Chat ' + (aiChats.conversations.length + 1));
    aiChats.conversations.push(c);
    aiChats.activeId = c.id;
    _deleteArmed = false;
    persistAiChats();
    rebuildAiChatSelect();
    loadConvoIntoLog();
    const inp = $('#ai-in'); if (inp) inp.focus();
}

function deleteAiChat() {
    const c = aiActiveConvo();
    if (!c) return;
    const btn = $('#ai-chat-delete');
    // Two-click confirm (Electron has no window.confirm): first click arms it.
    if (!_deleteArmed) {
        _deleteArmed = true;
        if (btn) btn.textContent = 'Delete?';
        setTimeout(() => { _deleteArmed = false; if (btn) btn.textContent = 'Delete'; }, 3000);
        return;
    }
    _deleteArmed = false;
    if (btn) btn.textContent = 'Delete';
    aiChats.conversations = aiChats.conversations.filter((x) => x.id !== c.id);
    if (!aiChats.conversations.length) aiChats.conversations.push(newConvoObject('Chat 1'));
    aiChats.activeId = aiChats.conversations[0].id;
    persistAiChats();
    rebuildAiChatSelect();
    loadConvoIntoLog();
}

// Record a turn in the active conversation + persist. role: 'user' | 'assistant'.
function recordAiTurn(role, content) {
    const c = aiActiveConvo();
    if (!c || !content) return;
    c.messages.push({ role, content, ts: Date.now() });
    c.updatedAt = Date.now();
    // Auto-title from the first user message (so chats get meaningful names).
    if (role === 'user' && c.autoTitled && c.messages.filter((m) => m.role === 'user').length === 1) {
        c.title = content.slice(0, 40) + (content.length > 40 ? '…' : '');
        rebuildAiChatSelect();
    }
    persistAiChats();
    // After a reply lands, fold any aged-out turns into the running summary.
    if (role === 'assistant') maybeSummarize();
}

// Turns since the last summary (excludes the just-added user prompt, sent as the
// new prompt) + the running summary of everything before that. A safety cap keeps
// a long un-summarized burst from overflowing a small model.
function aiHistoryWindow() {
    const c = aiActiveConvo();
    if (!c) return { history: [], summary: '' };
    const start = c.summaryUpTo || 0;
    const prior = c.messages.slice(start, -1);
    const capped = prior.slice(-(AI_CHAT_WINDOW + AI_SUMMARY_BATCH + 2));
    let summary = c.summary || '';
    // Phase 15b (slice 3) — fold any referenced chats' recaps in as context, live
    // (so they stay current). Skip refs whose source chat was deleted.
    if (Array.isArray(c.refs) && c.refs.length) {
        const parts = [];
        for (const ref of c.refs) {
            const src = aiChats.conversations.find((x) => x.id === ref.id);
            if (src) parts.push('From your chat "' + (src.title || ref.title || 'Untitled') + '":\n' + recapOf(src));
        }
        if (parts.length) {
            summary = (parts.join('\n\n') + (summary ? '\n\n— This chat —\n' + summary : '')).slice(0, 3000);
        }
    }
    return { history: capped, summary };
}

// When enough turns have aged past the window, fold them into the running summary
// (Cr1tt3r's long-term memory). Best-effort + non-blocking; one at a time.
async function maybeSummarize() {
    if (_summarizing) return;
    const c = aiActiveConvo();
    if (!c || !api.ai || !api.ai.summarize) return;
    const upTo = c.messages.length - AI_CHAT_WINDOW;        // summarize everything older than the window
    const start = c.summaryUpTo || 0;
    if (upTo - start < AI_SUMMARY_BATCH) return;            // not enough aged out yet
    const slice = c.messages.slice(start, upTo);
    if (!slice.length) return;
    _summarizing = true;
    try {
        const r = await api.ai.summarize({ messages: slice, priorSummary: c.summary || '' });
        // The user may have switched/deleted chats while we awaited — re-fetch by id.
        const cur = aiChats.conversations.find((x) => x.id === c.id);
        if (cur && r && typeof r.summary === 'string' && r.summary) {
            cur.summary = r.summary;
            cur.summaryUpTo = upTo;
            persistAiChats();
        }
    } catch { /* best-effort — keep the prior summary */ }
    finally { _summarizing = false; }
}

async function sendAI() {
    const input = $('#ai-in');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    addMsg('user', text);
    recordAiTurn('user', text);
    const { history, summary } = aiHistoryWindow();
    const thinking = document.createElement('div');
    thinking.className = 'msg ai thinking';   // C10 — animated typing dots, not a static …
    thinking.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    const log = $('#ai-log');
    log.appendChild(thinking);
    log.scrollTop = log.scrollHeight;
    let res;
    try {
        res = await api.ai.ask(text, { history, summary, online: isOnline() });
    } catch (e) {
        // The main handler rejected (backend error / handler threw). Without this
        // the animated typing dots would stay forever and the chat looks stuck.
        thinking.remove();
        addMsg('sys', 'The assistant hit an error: ' + ((e && e.message) || e));
        return;
    }
    thinking.remove();
    if (!res || res.error) { addMsg('sys', (res && res.error) || 'No response from the assistant.'); return; }
    if (res.needsConfirm) {
        addMsg('ai', res.text);
        recordAiTurn('assistant', res.text);
        const act = res.action || {};
        // Phase 13: AI-proposed app install — confirm, then run it on the loading screen.
        if (act.tool === 'install_app') {
            const ok = await askConfirm({
                title: 'Install ' + (act.label || act.pkg) + '?',
                reason: 'From ' + (act.source || 'a known source') + ' — only the Apps catalog and official repositories are used.',
                cmd: [act.pkg].concat(act.extra || []).join(' '),
            });
            if (!ok) { addMsg('sys', 'Cancelled.'); return; }
            loadingScreen.open('Installing ' + (act.label || act.pkg));
            try {
                const r = await api.ai.confirmAction(act);
                loadingScreen.done(!!(r && r.ok));
                const t = (r && r.text) || '(done)';
                addMsg('ai', t); recordAiTurn('assistant', t);
            } catch (e) { loadingScreen.done(false); addMsg('sys', 'Error: ' + e.message); }
            return;
        }
        const danger = res.classify && res.classify.danger;
        const ok = await askConfirm({
            title: danger ? 'AI wants to run a dangerous command' : 'Run this command?',
            reason: danger ? res.classify.reason : 'The assistant proposed a shell command.',
            cmd: res.action.arg,
        });
        if (!ok) { addMsg('sys', 'Cancelled.'); return; }
        try {
            const r = await api.ai.confirmAction(res.action);
            const t = (r && r.text) || '(done)';
            addMsg('ai', t); recordAiTurn('assistant', t);
        } catch (e) { addMsg('sys', 'Command failed: ' + ((e && e.message) || e)); }
        return;
    }
    // QoL — the assistant changed a setting for the user; apply it through the
    // normal settings path (full side-effects) and refresh the UI.
    if (res.settingsPatch) {
        try { await setSetting(res.settingsPatch); await loadSettings(); refreshAiStatus(); } catch {}
    }
    // QoL — the assistant navigated somewhere for the user.
    if (res.openScreen) { try { showScreen(res.openScreen); } catch {} }
    // C1 extension — system actions the assistant performed. The toggles are in
    // the DOM on any screen, so these work from anywhere; we reuse the wired
    // handlers so confirms + UI + toasts all behave as if the user clicked them.
    if (res.lockScreen) { try { lockNow(); } catch {} }
    if (res.openReport) {
        try { showScreen('settings'); setTimeout(() => { const c = $('#report-card'); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 90); } catch {}
    }
    if (typeof res.airplane === 'boolean') {
        try {
            const tog = $('#airplane-toggle');
            if (tog) { tog.checked = res.airplane; onAirplaneToggle({ target: tog }); }
            else { await api.net.setAirplane(res.airplane); airplaneMode = res.airplane; updateOnlineStatus(); }
        } catch {}
    }
    if (typeof res.swap === 'boolean') {
        try {
            const tog = $('#swap-toggle');
            if (tog) { tog.checked = res.swap; onSwapToggle({ target: tog }); }
            else { await api.swap.set({ on: res.swap, sizeGb: 4 }); }
        } catch {}
    }
    // No `res.suspend` branch: the daemon no longer emits one (sleep is a
    // desktop feature this OS doesn't have), and the handler it used to call
    // was removed with it.
    const t = res.text || '(no answer)';
    addMsg('ai', t);
    recordAiTurn('assistant', t);
    // C7 — if the user wandered off while the AI was thinking, let them know
    // its reply landed (toast + an unread dot on the assistant nav).
    if (currentScreen !== 'ai') {
        const who = (document.querySelector('#ai-name') || {}).textContent || 'Cr1tt3r';
        notifyUser('💬 ' + who + ' replied', 'ai');
    }
}

// Phase 16 — show the Ollama model row only when the Ollama engine is selected.
function syncOllamaRow(engine) {
    const row = $('#ollama-model-row');
    if (row) row.style.display = (engine === 'ollama') ? '' : 'none';
}

// Phase 16 — pull a larger Ollama model and switch the engine to it.
async function handleOllamaPull() {
    const inp = $('#ollama-model');
    const model = (inp ? inp.value : '').trim();
    if (!model) { toast('Type a model tag first (e.g. qwen2.5-coder:7b).'); return; }
    if (!api.ollama) { toast('Ollama support is unavailable.'); return; }
    if (!isOnline()) { toast('You\'re offline — connect to the internet to download a model.'); return; }
    try {
        const st = await api.ollama.status();
        if (!st.installed) { toast('Ollama isn\'t installed on this system.'); return; }
    } catch {}
    // Select it first, so even a slow pull leaves Ollama configured as the engine.
    await setSetting({ aiEngine: 'ollama', baseAiEnabled: false, ollamaModel: model });
    loadingScreen.open('Pulling ' + model);
    try {
        const r = await api.ollama.pull(model);
        loadingScreen.done(!!(r && r.ok));
        toast(r && r.ok
            ? (model + ' is ready — Ollama is now your AI engine.')
            : ('Pull failed: ' + ((r && r.error) || 'unknown error')));
    } catch (e) {
        loadingScreen.done(false);
        toast('Pull failed: ' + e.message);
    }
    await refreshAiStatus();
}

async function refreshAiStatus() {
    let s = { enabled: false, available: false };
    try { s = await api.ai.status(); } catch {}
    const pill = $('#stat-ai');
    pill.textContent = 'AI ' + (s.enabled ? (s.available ? 'ON' : 'STARTING') : 'OFF');
    const badge = $('#ai-badge');
    if (badge) {
        badge.textContent = s.enabled ? (s.available ? 'online' : 'starting') : 'offline';
        badge.className = 'badge ' + (s.enabled && s.available ? 'on' : 'off');
    }
    const toggle = $('#ai-toggle');
    if (toggle) toggle.checked = !!s.enabled;
    const baseToggle = $('#base-ai-toggle');
    if (baseToggle) baseToggle.checked = (s.baseAiEnabled !== false);
    const backend = s.backend;   // 'base' | 'ollama' | 'lmstudio'
    const where = backend === 'base' ? 'the built-in AI'
        : backend === 'ollama' ? 'Ollama'
        : 'LM Studio';
    const waiting = backend === 'base'
        ? 'Starting — the built-in model may still be downloading.'
        : backend === 'ollama'
            ? 'Waiting for Ollama — make sure it\'s running and the model is pulled.'
            : 'Waiting for LM Studio — open it, load a model, click Start Server (port 1234).';
    const sub = $('#ai-sub');
    if (sub) sub.textContent = s.enabled
        ? (s.available ? 'Active · using ' + where : waiting)
        : 'Off · the System Core + AI Assistant run locally on this machine';
    const modelSub = $('#ai-model-sub');
    if (modelSub) {
        if (backend === 'base') {
            modelSub.textContent = 'Built-in model: ' + (s.model || 'bundled') + ' — runs on this machine, no setup.';
        } else if (backend === 'ollama') {
            modelSub.textContent = 'Ollama model: ' + (s.model || '(none chosen)') + ' — pull a different one in AI engine settings.';
        } else if (s.enabled && s.available) {
            const loaded = (s.models && s.models[0]) || s.model || '(no model loaded)';
            modelSub.textContent = 'Loaded in LM Studio: ' + loaded + ' — swap models there.';
        } else {
            modelSub.textContent = 'Switch the AI engine to LM Studio to use a model you load there.';
        }
    }
    // Phase 16 — warn AVX1-only CPUs (LM Studio needs AVX2) and point them at Ollama.
    const engSub = $('#ai-engine-sub');
    if (engSub) {
        engSub.textContent = (s.lmStudioOk === false)
            ? '⚠ Your CPU lacks AVX2 — LM Studio won\'t run here. Use the Ollama engine.'
            : 'What runs the model on this PC.';
    }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
// --- P2: stability reporting -------------------------------------------------
// The user's own per-version vote lives in settings.stabilityReports
// ({ "2.0.11": "works" | "broken" }); the community tally is a read-only
// GitHub reaction count fetched on demand (zero idle network cost).
let _stabilityReports = {};
let _stabilityVersion = '';
let _stabilityShareUrl = '';

function _normVer(v) { return String(v || '').replace(/^v/i, '').replace(/-.*$/, '').trim(); }

async function _ensureStabilityVersion() {
    if (_stabilityVersion) return _stabilityVersion;
    try { const i = await api.system.info(); _stabilityVersion = _normVer(i.appVersion); } catch {}
    return _stabilityVersion;
}

async function refreshStabilityUi() {
    await _ensureStabilityVersion();
    const vEl = $('#stability-version');
    if (vEl) vEl.textContent = _stabilityVersion ? ('v' + _stabilityVersion) : 'this build';
    const mine = _stabilityReports[_stabilityVersion];
    const yv = $('#stability-your-vote');
    if (yv) {
        yv.textContent = mine === 'works' ? 'You marked this: Works ✓'
            : mine === 'broken' ? 'You marked this: Problems ✗'
            : '';
    }
}

async function setStabilityVote(vote) {
    await _ensureStabilityVersion();
    if (!_stabilityVersion) { toast('Version unknown — can’t record a report.'); return; }
    _stabilityReports = { ..._stabilityReports, [_stabilityVersion]: vote };
    try { await api.settings.set({ stabilityReports: _stabilityReports }); } catch {}
    refreshStabilityUi();
    // Open a pre-filled GitHub issue so the report actually reaches the
    // maintainer (with system context + an anonymous machine hash for de-dup).
    try {
        const r = await api.stability.reportUrl(vote);
        if (r && r.ok && r.url) {
            window.open(r.url, '_blank');
            toast(vote === 'works'
                ? 'Thanks! A quick report opened on GitHub — just hit Submit.'
                : 'Opening a problem report on GitHub — add what happened, then Submit.');
        } else {
            toast((r && r.error) || (vote === 'works' ? 'Thanks! Marked as working.' : 'Noted — thanks for the report.'));
        }
    } catch {
        toast(vote === 'works' ? 'Thanks! Marked as working.' : 'Noted — thanks for the report.');
    }
    refreshStabilityTally();
}

async function refreshStabilityTally() {
    const el = $('#stability-tally');
    if (el) el.textContent = 'checking…';
    try {
        const t = await api.stability.tally();
        if (!t || !t.ok) { if (el) el.textContent = (t && t.error) ? t.error : 'unavailable'; return; }
        _stabilityShareUrl = t.htmlUrl || '';
        if (el) {
            el.textContent = t.found
                ? `👍 ${t.works}   👎 ${t.broken}   (community)`
                : 'no matching release yet';
        }
    } catch {
        if (el) el.textContent = 'unavailable';
    }
}

function shareStabilityFeedback() {
    const url = _stabilityShareUrl || '';
    if (/^https?:\/\//i.test(url)) { window.open(url, '_blank'); return; }
    // Fall back to the repo's releases page if we haven't fetched a tally yet.
    refreshStabilityTally().then(() => {
        if (/^https?:\/\//i.test(_stabilityShareUrl)) window.open(_stabilityShareUrl, '_blank');
        else toast('Set the GitHub repository in Settings first.');
    });
}

// --- Phase 12: loading screen (driven by streamed 'job-progress' events) ----
const loadingScreen = (() => {
    let _t0 = 0, _tick = null;
    function _fmt(ms) { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's'; }
    function _stopTick() { if (_tick) { clearInterval(_tick); _tick = null; } }
    function open(title) {
        const t = $('#ls-title'); if (t) t.textContent = title || 'Working…';
        const log = $('#ls-log'); if (log) log.textContent = '';
        const steps = $('#ls-steps'); if (steps) steps.innerHTML = '';
        const bar = $('#ls-bar'); if (bar) bar.classList.remove('done');
        const st = $('#ls-status'); if (st) st.textContent = 'working…';
        const close = $('#ls-close'); if (close) close.disabled = true;
        const ov = $('#loadscreen'); if (ov) ov.classList.add('show');
        // QoL — live elapsed time so a long job never feels frozen.
        _t0 = Date.now(); _stopTick();
        _tick = setInterval(() => { const s = $('#ls-status'); if (s) s.textContent = 'working… (' + _fmt(Date.now() - _t0) + ')'; }, 1000);
    }
    function setSteps(labels) {
        const steps = $('#ls-steps');
        if (steps) steps.innerHTML = (labels || []).map((s, i) => `<li data-i="${i}">${escapeHtml(s)}</li>`).join('');
        setStep(0);
    }
    function setStep(i) {
        $$('#ls-steps li').forEach((li) => {
            const n = Number(li.dataset.i);
            li.classList.toggle('active', n === i);
            li.classList.toggle('done', n < i);
        });
    }
    function log(line) {
        const el = $('#ls-log'); if (!el) return;
        el.textContent += line + '\n'; el.scrollTop = el.scrollHeight;
    }
    function done(ok) {
        _stopTick();
        $$('#ls-steps li').forEach((li) => { li.classList.add('done'); li.classList.remove('active'); });
        const bar = $('#ls-bar'); if (bar) bar.classList.add('done');
        const took = _t0 ? ' in ' + _fmt(Date.now() - _t0) : '';
        const st = $('#ls-status'); if (st) st.textContent = (ok ? '✓ done' : '✗ failed — see the log') + took;
        const close = $('#ls-close'); if (close) close.disabled = false;
    }
    function hide() { _stopTick(); const ov = $('#loadscreen'); if (ov) ov.classList.remove('show'); }
    return { open, setSteps, setStep, log, done, hide };
})();
if (api && api.on) api.on('job-progress', (p) => {
    if (!p) return;
    if (Array.isArray(p.phases)) loadingScreen.setSteps(p.phases);
    if (typeof p.phase === 'number') loadingScreen.setStep(p.phase);
    if (typeof p.log === 'string') loadingScreen.log(p.log);
    if (p.done) loadingScreen.done(!!p.ok);
});

// Custom dropdowns. Native <select> popups are a separate OS-level window that
// needs a window manager to stay open; in Outlaw's no-WM session they open and
// vanish instantly. We hide each <select> and drive it from an inline,
// DOM-only dropdown (no OS popup) — and dispatch a real 'change' event so all
// the existing select handlers keep working unchanged.
// Phase 6 (a11y) — this replaced every native <select> with a button and a list
// of plain <div>s. Two consequences, both invisible until you stop using a
// mouse: hiding the <select> threw away its accessible name, so every dropdown
// announced as an unlabelled button; and the options weren't focusable, so a
// keyboard user could open a dropdown and then had no way to reach anything in
// it. It is now a proper combobox — named, arrow-key navigable, Esc to close —
// using aria-activedescendant so focus never leaves the button.
let _cselectSeq = 0;
function enhanceSelects(root) {
    (root || document).querySelectorAll('select:not([data-enhanced])').forEach((sel) => {
        sel.dataset.enhanced = '1';
        sel.style.display = 'none';
        // Carry the name across before the <select> disappears from the a11y tree.
        const accName = sel.getAttribute('aria-label')
            || (sel.labels && sel.labels.length ? (sel.labels[0].innerText || '').trim() : '')
            || sel.getAttribute('title') || '';
        sel.setAttribute('aria-hidden', 'true');
        sel.tabIndex = -1;

        const uid = 'cselect-' + (++_cselectSeq);
        const wrap = document.createElement('div');
        wrap.className = 'cselect';
        wrap.style.minWidth = sel.style.minWidth || '160px';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cselect-btn';
        btn.id = uid + '-btn';
        btn.setAttribute('role', 'combobox');
        btn.setAttribute('aria-haspopup', 'listbox');
        btn.setAttribute('aria-expanded', 'false');
        btn.setAttribute('aria-controls', uid + '-list');
        if (accName) btn.setAttribute('aria-label', accName);
        const list = document.createElement('div');
        list.className = 'cselect-list';
        list.id = uid + '-list';
        list.setAttribute('role', 'listbox');
        if (accName) list.setAttribute('aria-label', accName);
        list.hidden = true;

        const items = () => [...list.querySelectorAll('.cselect-opt')];
        let activeIdx = -1;

        const sync = () => {
            const o = sel.options[sel.selectedIndex];
            btn.textContent = o ? o.textContent : '';
            items().forEach((it) => {
                const on = it.dataset.value === sel.value;
                it.classList.toggle('active', on);
                it.setAttribute('aria-selected', on ? 'true' : 'false');
            });
        };
        const setActive = (i) => {
            const list_ = items();
            if (!list_.length) return;
            activeIdx = Math.max(0, Math.min(list_.length - 1, i));
            list_.forEach((it, n) => it.classList.toggle('kb', n === activeIdx));
            btn.setAttribute('aria-activedescendant', list_[activeIdx].id);
            try { list_[activeIdx].scrollIntoView({ block: 'nearest' }); } catch { /* older engines */ }
        };
        const setOpen = (open) => {
            list.hidden = !open;
            wrap.classList.toggle('open', open);
            btn.setAttribute('aria-expanded', open ? 'true' : 'false');
            if (open) { sync(); setActive(sel.selectedIndex >= 0 ? sel.selectedIndex : 0); }
            else {
                btn.removeAttribute('aria-activedescendant');
                items().forEach((it) => it.classList.remove('kb'));
            }
        };
        const choose = (i) => {
            const o = sel.options[i];
            if (!o) return;
            sel.value = o.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            sync();
            setOpen(false);
            btn.focus();
        };
        // The document-level "click anywhere closes dropdowns" handler needs to
        // reset aria-expanded too, so give it the real closer rather than
        // letting it poke at classes behind this component's back.
        wrap._setOpen = setOpen;

        [...sel.options].forEach((o, i) => {
            const item = document.createElement('div');
            item.className = 'cselect-opt';
            item.id = uid + '-opt-' + i;
            item.setAttribute('role', 'option');
            item.setAttribute('aria-selected', 'false');
            item.textContent = o.textContent;
            item.dataset.value = o.value;
            item.addEventListener('click', (e) => { e.stopPropagation(); choose(i); });
            item.addEventListener('mouseenter', () => setActive(i));
            list.appendChild(item);
        });
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const willOpen = list.hidden;
            document.querySelectorAll('.cselect.open').forEach((w) => {
                if (w !== wrap && w._setOpen) w._setOpen(false);
            });
            setOpen(willOpen);
        });
        btn.addEventListener('keydown', (e) => {
            const open = !list.hidden;
            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault(); if (open) setActive(activeIdx + 1); else setOpen(true); break;
                case 'ArrowUp':
                    e.preventDefault(); if (open) setActive(activeIdx - 1); else setOpen(true); break;
                case 'Home': if (open) { e.preventDefault(); setActive(0); } break;
                case 'End': if (open) { e.preventDefault(); setActive(items().length - 1); } break;
                // preventDefault also suppresses the click these would synthesize,
                // so the dropdown can't toggle twice on one keypress.
                case 'Enter': case ' ':
                    e.preventDefault(); if (open) choose(activeIdx); else setOpen(true); break;
                case 'Escape':
                    // Only swallow Esc when there is actually a dropdown to close,
                    // or it would eat the key the rest of the UI expects.
                    if (open) { e.preventDefault(); e.stopPropagation(); setOpen(false); } break;
                case 'Tab': if (open) setOpen(false); break;
                default: break;
            }
        });
        sel.after(wrap);
        wrap.append(btn, list);
        // Re-enhancing the SAME <select> (rebuildAiChatSelect/rebuildRefSelect drop
        // the wrapper + clear data-enhanced, then re-run this) would otherwise stack
        // a new 'change'->sync listener each time. Drop the prior one first so each
        // element carries exactly one, no matter how many times it's rebuilt.
        if (sel._cselectSync) sel.removeEventListener('change', sel._cselectSync);
        sel._cselectSync = sync;
        sel.addEventListener('change', sync);  // keep label in sync with code changes
        sync();
    });
}
// Any click outside an open dropdown closes it.
document.addEventListener('click', () => {
    document.querySelectorAll('.cselect.open').forEach((w) => {
        if (w._setOpen) { w._setOpen(false); return; }
        w.classList.remove('open'); w.querySelector('.cselect-list').hidden = true;
    });
});

// P1 — apply a visual theme by toggling a body class. The actual palette lives
// in styles.css (body.theme-gold { --term: …; }), so this is a zero-cost swap
// of CSS custom properties; nothing re-renders beyond a repaint.
// Phase 11+ — Broken-mode "live faults" theatre. Purely cosmetic: random glitch
// bursts, fake SYSTEM FAULT cards, brand/stat corruption and a rare SIGNAL LOST
// flash, so the machine feels like it's genuinely struggling. Constraints:
//   * runs ONLY while the Broken theme is active (user opt-in) — zero idle cost
//     on the other themes; Reduce motion disables it entirely.
//   * NEVER touches the real error log or the real #toast — fakes live in their
//     own aria-hidden containers so screen readers don't announce them.
//   * skips a beat while a real overlay owns the screen (sign-in, loading
//     screen) so theatre never mixes with a genuine operation.
//   * compositor-cheap: filter/transform/opacity + tiny text swaps only.
const BRK_FAULTS = [
    'ERR 0x2F: phosphor decay above threshold — compensating',
    'MEMORY PARITY FAULT at 0x0000F3A2 (recovered)',
    'I/O: sector 8,102 remapped after 3 retries',
    'thermal sensor 2: NO RESPONSE — using last known value',
    'CRT deflection coil drift detected (auto-corrected)',
    'WARN: capacitor C41 out of tolerance',
    'bus fault: PCI-3 timeout — bus re-armed',
    'checksum mismatch in cluster 0x11C — retry OK',
    'voltage rail 3.3V sagging (3.06V)',
    'display sync lost — resynced in 12 ms',
    'FAULT: fan 1 spindown, thermal margin shrinking',
    'watchdog: heartbeat missed ×1 (tolerated)',
    'EMI burst on line-in — shielding degraded',
    'kernel: soft lockup recovered on CPU2',
];
const BRK_BRANDS = ['▓UTLAW_0S', 'OU7L4W_OS', 'OUT▚AW_O5', 'OUTLAW_▓S'];
const BRK_STATS = ['▓▓', 'ERR', '0xFF', '─ ─'];
let _brkTimer = null;
function _brkRand(min, max) { return min + Math.random() * (max - min); }
function _brkFakeError() {
    const box = document.querySelector('#brk-toasts');
    if (!box) return;
    while (box.children.length >= 3) box.removeChild(box.firstChild);
    const card = document.createElement('div');
    card.className = 'brk-toast';
    const line = BRK_FAULTS[Math.floor(Math.random() * BRK_FAULTS.length)];
    card.innerHTML = `<b>⚠ SYSTEM FAULT</b><br>${_escapeHtml(line)}`;
    box.appendChild(card);
    setTimeout(() => { try { card.remove(); } catch {} }, 4500);
}
function _brkBurst() {
    document.body.classList.add('brk-burst');
    setTimeout(() => document.body.classList.remove('brk-burst'), 320);
}
function _brkScrambleBrand() {
    const el = document.querySelector('.topbar .brand');
    if (!el) return;
    el.textContent = BRK_BRANDS[Math.floor(Math.random() * BRK_BRANDS.length)];
    setTimeout(() => { el.textContent = BRK_BRANDS[Math.floor(Math.random() * BRK_BRANDS.length)]; }, 140);
    setTimeout(() => { el.textContent = 'OUTLAW_OS'; }, 380);
}
function _brkStatCorrupt() {
    const el = document.querySelector(Math.random() < 0.5 ? '#stat-cpu' : '#stat-ram');
    if (!el) return;
    const prev = el.textContent;
    const label = prev.split(' ')[0] || 'CPU';
    el.textContent = label + ' ' + BRK_STATS[Math.floor(Math.random() * BRK_STATS.length)];
    setTimeout(() => { if (el.textContent.includes('▓') || /ERR|0xFF|─/.test(el.textContent)) el.textContent = prev; }, 1200);
}
function _brkSignalLost() {
    const el = document.querySelector('#brk-flash');
    if (!el) return;
    el.hidden = false;
    setTimeout(() => { el.hidden = true; }, 240);
}
function _brkFire() {
    const ls = document.querySelector('#loadscreen');
    const si = document.querySelector('#signin');
    if ((ls && ls.classList.contains('show')) || (si && si.style.display === 'flex')) return;
    const r = Math.random();
    if (r < 0.30) _brkBurst();
    else if (r < 0.60) _brkFakeError();
    else if (r < 0.75) _brkScrambleBrand();
    else if (r < 0.90) _brkStatCorrupt();
    else _brkSignalLost();
}
function _brkSchedule() {
    _brkTimer = setTimeout(() => { try { _brkFire(); } catch {} _brkSchedule(); }, _brkRand(7000, 16000));
}
function syncBrokenFx() {
    const on = document.body.classList.contains('theme-broken') && !document.body.classList.contains('reduce-motion');
    if (on && !_brkTimer) _brkSchedule();
    if (!on && _brkTimer) {
        clearTimeout(_brkTimer);
        _brkTimer = null;
        const bt = document.querySelector('#brk-toasts'); if (bt) bt.innerHTML = '';
        const bf = document.querySelector('#brk-flash'); if (bf) bf.hidden = true;
        document.body.classList.remove('brk-burst');
        const brand = document.querySelector('.topbar .brand'); if (brand) brand.textContent = 'OUTLAW_OS';
    }
}

function applyTheme(theme) {
    document.body.classList.toggle('theme-gold', theme === 'gold');
    // Phase 11 — "Broken" mode: a third theme (palette + CSS glitch FX). Mutually
    // exclusive with gold; both classes are driven off the single theme value.
    document.body.classList.toggle('theme-broken', theme === 'broken');
    // Start/stop the Broken-mode live-faults theatre with the theme.
    syncBrokenFx();
}

async function loadSettings() {
    let s = {};
    try { s = await api.settings.get(); } catch {}
    document.body.classList.toggle('crt', !!s.crtFx);
    document.body.classList.toggle('glow', !!s.glow);
    document.body.classList.toggle('reduce-motion', !!s.reduceMotion);
    document.body.classList.toggle('high-contrast', !!s.highContrast);
    // C6 — show the AI's self-chosen name on a user-loaded model; base stays Cr1tt3r.
    try {
        const nameEl = document.querySelector('#ai-name');
        if (nameEl) {
            const eng = s.aiEngine || '';
            nameEl.textContent = (eng && eng !== 'base' && s.aiPersonaName) ? s.aiPersonaName : 'Cr1tt3r';
        }
    } catch {}
    // QoL — fill the About card's version once.
    try {
        const av = document.querySelector('#about-version');
        if (av && av.textContent === '…') av.textContent = 'v' + (await api.appVersion() || '?');
    } catch {}
    $('#crt-toggle').checked = !!s.crtFx;
    $('#glow-toggle').checked = !!s.glow;
    const rmToggle = $('#reduce-motion-toggle');
    if (rmToggle) rmToggle.checked = !!s.reduceMotion;
    const hcToggle = $('#contrast-toggle');
    if (hcToggle) hcToggle.checked = !!s.highContrast;
    // QoL/accessibility — whole-UI zoom (text size).
    if (api.setZoom) api.setZoom(Number(s.uiScale) || 1);
    const scaleSel = $('#ui-scale');
    if (scaleSel) scaleSel.value = String(s.uiScale || 1);
    // P1 — theme. 'gold' adds body.theme-gold which re-points the CSS palette
    // variables to the gold-on-gunmetal scheme. Default 'green' = no class.
    applyTheme(s.theme || 'green');
    const themeSel = $('#theme-select');
    if (themeSel) themeSel.value = s.theme || 'green';
    // Phase 16 — AI engine + Ollama model. Set here (before enhanceSelects) so the
    // custom dropdown renders the right value.
    const engineSel = $('#ai-engine');
    if (engineSel) engineSel.value = s.aiEngine || (s.baseAiEnabled !== false ? 'base' : 'lmstudio');
    syncOllamaRow(engineSel ? engineSel.value : 'base');
    const ollModelInput = $('#ollama-model');
    if (ollModelInput) ollModelInput.value = s.ollamaModel || '';
    // LM Studio handles model selection itself — no dropdown to seed.
    $('#update-repo').value = s.updateRepo || '';
    const chanEl = $('#update-channel');
    if (chanEl) chanEl.value = s.updateChannel || 'stable';
    $('#auto-check').checked = !!s.autoCheck;
    // P2 — stability reporting: label the current version + reflect any
    // prior local vote. The community tally is fetched lazily (button /
    // first Settings open) so there's zero network cost otherwise.
    _stabilityReports = s.stabilityReports || {};
    refreshStabilityUi();
    // Seed the auto-lock select (the idle watch itself lives in main).
    const alSel = $('#autolock-select');
    if (alSel) alSel.value = String(s.autoLockMin || 0);
}

async function setSetting(patch) { try { await api.settings.set(patch); } catch {} }

// ---------------------------------------------------------------------------
// Power
// ---------------------------------------------------------------------------
// a11y — remember who opened the power menu so focus can return there on close,
// and move focus into the menu so keyboard/screen-reader users land on an action
// instead of staying on the now-covered topbar button.
let _powerOpener = null;
function openPower() {
    _powerOpener = document.activeElement;
    $('#power-modal').classList.add('show');
    $('#power-modal .row button')?.focus();
}
function closePower() {
    $('#power-modal').classList.remove('show');
    try { _powerOpener?.focus(); } catch {}
    _powerOpener = null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Phase 4 / #2: render the spec-aware recommendation into the AI setup card.
// Shows the best ENGINE for this machine (built-in / Ollama / LM Studio — not just
// LM Studio) plus a setup path for each, the recommended one expanded. An optional
// plain-language AI "take" is filled in async by checkPc (see #ai-setup-ai-take).
function renderAiRecommendation(r) {
    const out = $('#ai-setup-result');
    if (!out) return;
    r = r || {};
    const gpuTxt = r.vramGb > 0
        ? `${escapeHtml(r.gpuName || 'GPU')} · ${r.vramGb} GB VRAM`
        : (r.gpuName ? `${escapeHtml(r.gpuName)} · no dedicated VRAM` : 'no discrete GPU');
    const rec = r.recommended || {};
    const starter = r.starter || {};
    const engine = r.recommendedEngine || 'ollama';
    const ollamaTag = rec.ollama || '';
    const engineLabel = engine === 'base' ? 'the built-in AI (already on — no setup)'
        : engine === 'ollama' ? 'Ollama (one command, works on any GPU or CPU)'
        : 'LM Studio (point-and-click app)';
    const gpuNote = r.gpuOffload
        ? 'You have a capable GPU, so it runs fast on the GPU.'
        : 'No dedicated GPU — it runs on your CPU + RAM (still works, just slower).';
    const op = (e) => (e === engine ? ' open' : '');   // expand the recommended one

    // Path 1 — built-in (zero setup).
    const builtin = `
        <details${op('base')}><summary><b>Built-in AI</b> — zero setup ${engine === 'base' ? '· recommended' : ''}</summary>
            <div class="muted" style="padding:6px 0 2px;line-height:1.6;">
                Outlaw ships a tiny model that's already running — just open <b>Settings → AI &amp; VRAM</b>,
                set the AI engine to <b>Built-in</b>, and ask away. Great for light help and system control on
                any PC. For bigger, smarter answers, use Ollama or LM Studio below.
            </div>
        </details>`;
    // Path 2 — Ollama (recommended default for most machines).
    const ollama = `
        <details${op('ollama')}><summary><b>Ollama</b> — one command ${engine === 'ollama' ? '· recommended' : ''}</summary>
            <ol style="margin:6px 0 0;padding-left:20px;line-height:1.6;">
                <li>Open <b>Settings → AI &amp; VRAM</b>, set the AI engine to <b>Ollama</b>.</li>
                <li>In the <b>Ollama model</b> box, enter <code>${escapeHtml(ollamaTag || 'qwen2.5:7b')}</code> and click <b>Pull &amp; use</b> — it downloads, then runs it. ${gpuNote}</li>
                <li>Come back here and ask anything. (No GUI, no account — it all stays on this PC.)</li>
            </ol>
        </details>`;
    // Path 3 — LM Studio (GUI alternative).
    const lmstudio = `
        <details${op('lmstudio')}><summary><b>LM Studio</b> — point-and-click app ${engine === 'lmstudio' ? '· recommended' : ''}</summary>
            <ol style="margin:6px 0 0;padding-left:20px;line-height:1.6;">
                <li>Click <b>Get / Open LM Studio</b> above — it opens <b>lmstudio.ai</b>. Download the <b>Linux</b> AppImage (no installer — the AppImage <i>is</i> the app), save it to <b>Downloads</b> or <b>Applications</b>, then click <b>Get / Open LM Studio</b> again so Outlaw makes it runnable and launches it.</li>
                <li>In LM Studio's search, find <b>${escapeHtml(rec.model)}</b> and download it.</li>
                <li>Load it. ${r.gpuOffload ? 'Turn <b>GPU offload ON</b>.' : 'Leave GPU offload off (CPU).'} Set context length to <b>${rec.ctx}</b>, then click <b>Start Server</b> (port 1234).</li>
                <li>Open <b>Settings → AI &amp; VRAM</b>, set the engine to <b>LM Studio</b>, and ask away.</li>
            </ol>
        </details>`;

    out.innerHTML = `
        <div style="border-top:1px solid var(--line,#2a2f29);padding-top:10px;">
            <div class="mono muted" style="font-size:12px;">
                ${escapeHtml(r.cpu)} · ${r.cores} cores · ${r.ramGb} GB RAM · ${gpuTxt}
            </div>
            <p style="margin:8px 0 2px;"><b>Best for your PC:</b> ${engineLabel}</p>
            <p style="margin:0 0 2px;"><b>Recommended model:</b> ${escapeHtml(rec.model)}
                <span class="muted">(${escapeHtml(rec.size)})</span></p>
            ${r.note ? `<p class="muted" style="margin:0 0 2px;">${escapeHtml(r.note)}</p>` : ''}
            <p class="muted" style="margin:0;">Runs on: ${escapeHtml(r.runsOn)} · context length ${rec.ctx}</p>
            <div id="ai-setup-ai-take" class="muted" style="margin:8px 0 0;font-style:italic;"></div>
            <div style="margin-top:10px;display:flex;flex-direction:column;gap:6px;">
                ${builtin}${ollama}${lmstudio}
            </div>
        </div>`;
}

// ---------------------------------------------------------------------------
// F1 — Report-a-problem (error/warning log) controls.
// ---------------------------------------------------------------------------
async function errlogRefresh() {
    const view = $('#errlog-view');
    if (view) view.value = 'Collecting errors + warnings…';
    let txt = '';
    try { txt = await api.errorlog.collect(); } catch {}
    if (view) view.value = txt || '(no errors or warnings logged — nice.)';
}
async function errlogGithub() {
    // Opens the repo's GitHub Issues page in Firefox (window.open is denied by the
    // hardened window-open handler). The user copies the log + makes an issue there.
    const r = await api.errorlog.openIssue().catch(() => null);
    if (r && r.ok) toast('Opening GitHub issues — paste the copied log into a new issue.');
    else toast('Couldn\'t open GitHub. Set your repo in Settings → Updates, then Copy the log and open github.com yourself.');
}
async function errlogClear() {
    try { await api.errorlog.clear(); } catch {}
    const view = $('#errlog-view'); if (view) view.value = '';
    toast('Error log cleared — only new errors from here on.');
}
async function errlogCopy() {
    const view = $('#errlog-view');
    const txt = view ? view.value : '';
    if (!txt || !txt.trim()) { toast('Nothing to copy — click "Collect errors" first.'); return; }
    try { await navigator.clipboard.writeText(txt); toast('Error log copied to clipboard.'); }
    catch { toast('Couldn\'t copy to clipboard.'); }
}

// QoL — storage cleanup (Settings → Free up space). Scan is read-only; clean only
// trims safe caches (package cache to newest-of-each, thumbnails, Trash).
function _storHuman(mb) { return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : (mb || 0) + ' MB'; }
async function storageScan() {
    const st = $('#storage-status'), btn = $('#storage-clean-btn');
    if (st) st.textContent = 'scanning…';
    const r = await api.storage.scan().catch(() => null);
    if (!r || !r.ok) { if (st) st.textContent = (r && r.error) || 'scan failed'; return; }
    if (st) st.textContent = `~${_storHuman(r.totalMb)} reclaimable — package cache ${_storHuman(r.paccMb)}, thumbnails ${_storHuman(r.thumbMb)}, Trash ${_storHuman(r.trashMb)}`;
    if (btn) btn.disabled = (r.totalMb || 0) <= 0;
}
async function storageClean() {
    if (!window.confirm('Free up space now?\n\nClears the old package-download cache (keeping the newest of each), thumbnails and the Trash. Your apps, files and settings are untouched. You may be asked for your password.')) return;
    const st = $('#storage-status'), btn = $('#storage-clean-btn');
    if (btn) btn.disabled = true;
    if (st) st.textContent = 'cleaning… (you may be asked for your password)';
    const r = await api.storage.clean().catch(() => null);
    if (r && r.ok) { if (st) st.textContent = r.partial ? r.note : '✓ Done — re-scanning…'; toast('Freed up space.'); }
    else { if (st) st.textContent = (r && r.error) || 'cleanup failed'; }
    setTimeout(storageScan, 500);   // refresh the numbers
}

// ---------------------------------------------------------------------------
// 🗺 In-OS roadmap (Settings) — interactive + themed. Mirrors the README roadmap.
// ---------------------------------------------------------------------------
const ROADMAP = [
    {
        title: 'Shipped & solid', tag: 'done', open: false,
        blurb: 'Phases 0–5 — a bootable server OS with a control panel, a way in from anywhere, and the tools to run it.',
        items: [
            ['done', '0 · Fork & strip — the desktop OS cut down to a bare-bones server OS'],
            ['done', '1 · Headless daemon — outlaw-serverd; the UI itself is optional (panel / lean mode)'],
            ['done', '2 · Sign-in that means it — password (scrypt) + TOTP 2FA, revocable sessions, per-address lockout, audit log'],
            ['done', '3 · Remote access — Tailscale/WireGuard only; LAN, public and wildcard binds are refused outright'],
            ['done', '4 · Server toolset — services, journal viewer, firewall, SSH keys and storage, from either frontend'],
            ['done', '5 · Game servers — one-click Docker, Portainer and Cockpit, plus a guided Pterodactyl install'],
        ],
    },
    {
        title: 'Polish & first install', tag: 'now', open: true,
        blurb: 'Phase 6 — the last one before this stops being alpha.',
        items: [
            ['now', 'Accessibility pass — full keyboard reach, focus order, screen-reader labels'],
            ['now', 'Docs — help topics that describe THIS OS rather than the desktop it was forked from'],
            ['now', 'The first real-hardware test. Nothing in phases 4–5 has run on Linux yet'],
            ['plan', 'Fix whatever that test finds'],
        ],
    },
    {
        title: 'Experimental — after the roadmap', tag: 'exp', open: false,
        blurb: 'Direction, not promises. Nothing here is started, and any of it may change shape or be dropped.',
        items: [
            ['exp', '🐕‍🦺 Watchdog — a small local AI that watches logs, auth attempts and processes for threats'],
            ['exp', '🦮 Guard Dog — a second, independent AI that verifies what Watchdog found and proposes responses'],
            ['exp', 'Two models, because each has to survive the other’s review before anything reaches you'],
            ['exp', 'You stay in charge — anything above a low-level threat is a message and a list of options, never a silent action'],
            ['exp', 'Both boxed in Docker, and sized to whatever GPU (or CPU) this machine actually has'],
        ],
    },
];
const _RM_ICON = { done: '✓', now: '▸', plan: '○', exp: '⚗' };
const _RM_BADGE = { done: 'shipped', now: 'in progress', plan: 'planned', exp: 'post-1.0' };

function renderRoadmap() {
    const root = $('#roadmap-view');
    if (!root) return;
    const ver = $('#roadmap-version');
    if (ver) ver.textContent = '→ v2.1.0';
    const html = [];
    ROADMAP.forEach((g, gi) => {
        const total = g.items.length;
        const done = g.items.filter((it) => it[0] === 'done').length;
        const pct = total ? Math.round((done / total) * 100) : 0;
        html.push(`<div class="rm-group rm-${g.tag}${g.open ? ' open' : ''}" data-rm="${gi}">`);
        html.push(`<button class="rm-head" type="button" data-rm-toggle="${gi}">`
            + `<span class="rm-caret">▸</span>`
            + `<span class="rm-title">${escapeHtml(g.title)}</span>`
            + `<span class="rm-badge rm-badge-${g.tag}">${_RM_BADGE[g.tag] || ''}</span>`
            + `<span class="rm-bar"><span style="width:${pct}%"></span></span>`
            + `</button>`);
        html.push('<div class="rm-body">');
        if (g.blurb) html.push(`<div class="rm-blurb">${escapeHtml(g.blurb)}</div>`);
        for (const [s, t] of g.items) {
            html.push(`<div class="rm-item rm-item-${s}"><span class="rm-ico">${_RM_ICON[s] || '·'}</span><span>${escapeHtml(t)}</span></div>`);
        }
        html.push('</div></div>');
    });
    root.innerHTML = html.join('');
}

// ---------------------------------------------------------------------------
// Event wiring (delegation)
// ---------------------------------------------------------------------------
function wire() {
    // Boot
    $('#boot-skip').addEventListener('click', enterOS);
    $('#boot-noai').addEventListener('click', async () => { await setSetting({ aiEnabled: false }); await refreshAiStatus(); enterOS(); toast('Started without AI.'); });

    // Sidebar nav
    $('#nav').addEventListener('click', (e) => {
        const item = e.target.closest('.nav-item[data-screen]');
        if (item) showScreen(item.dataset.screen);
    });

    // Global click delegation for data-action + data-launch
    document.body.addEventListener('click', async (e) => {
        const launch = e.target.closest('[data-launch]');
        if (launch) { launchApp(launch.dataset.launch); return; }
        const launchDisc = e.target.closest('[data-launch-disc]');
        if (launchDisc) { launchDiscoveredApp(launchDisc.dataset.launchDisc); return; }
        const installBtn = e.target.closest('[data-install-id]');
        if (installBtn) { handleAppsInstall(installBtn.dataset.installId); return; }
        const uninstallBtn = e.target.closest('[data-uninstall-id]');
        if (uninstallBtn) { handleAppsUninstall(uninstallBtn.dataset.uninstallId); return; }
        const searchAllBtn = e.target.closest('[data-search-all]');
        if (searchAllBtn) { searchAllPackages(); return; }
        const installPkgBtn = e.target.closest('[data-install-pkg]');
        if (installPkgBtn) { handleAppsInstallPkg(installPkgBtn.dataset.installPkg); return; }
        const filterChip = e.target.closest('[data-apps-filter]');
        if (filterChip) { setAppsFilter(filterChip.dataset.appsFilter); return; }
        if (e.target.id === 'apps-refresh-db') {
            toast('Refreshing package list… enter your password if prompted.');
            try {
                const r = await api.apps.refreshDb();
                toast(r.ok ? 'Package list refreshed.' : 'Refresh failed.');
                if (r.ok) refreshAppsInstalledOnly();
            } catch (err) {
                toast('Refresh failed: ' + err.message);
            }
            return;
        }
        const fileRow = e.target.closest('.fs-row');
        if (fileRow) {
            const full = (currentDir.endsWith('/') ? currentDir : currentDir + '/') + fileRow.dataset.name;
            if (fileRow.dataset.type === 'dir') { loadFiles(full); }
            else {
                const r = await api.files.open(full);
                if (!r.ok) toast((r.error || 'Could not open that file') + ' — try “Open in file manager”.');
            }
            return;
        }
        // QoL — quick-folder chips (Downloads / Documents / …) jump straight there.
        const fsChip = e.target.closest('.fs-chip');
        if (fsChip) {
            const home = await api.files.home();
            const base = String(home || '').replace(/\/+$/, '');
            loadFiles(base + '/' + fsChip.dataset.folder);
            return;
        }
        // Server screens: per-row buttons are delegated, so a refreshed table
        // never leaves stale listeners behind.
        const svcBtn = e.target.closest('[data-svc-action]');
        if (svcBtn) { serviceAction(svcBtn.dataset.svc, svcBtn.dataset.svcAction); return; }
        const fwDel = e.target.closest('[data-fw-del]');
        if (fwDel) { firewallDelete(fwDel.dataset.fwDel); return; }
        const appBtn = e.target.closest('[data-app-action]');
        if (appBtn) { serverAppAction(appBtn.dataset.app, appBtn.dataset.appAction); return; }
        const sshDel = e.target.closest('[data-ssh-del]');
        if (sshDel) { sshRemoveKey(sshDel.dataset.sshDel); return; }

        const act = e.target.closest('[data-action]');
        if (!act) return;
        switch (act.dataset.action) {
            case 'files-up': if (parentDir) loadFiles(parentDir); break;
            case 'files-home': loadFiles(await api.files.home()); break;
            case 'files-open-fm': {
                const r = await api.files.openManager(currentDir || null);
                toast(r && r.ok ? 'Opening file manager…' : ((r && r.error) || 'No file manager available.'));
                break;
            }
            case 'tasks-refresh': refreshTasks(); break;
            case 'svc-refresh': refreshServices(); break;
            case 'log-refresh': refreshLogs(); break;
            case 'fw-refresh': refreshFirewall(); break;
            case 'remote-refresh': refreshRemote(); break;
            case 'disk-refresh': refreshDisks(); break;
            case 'server-apps-refresh': refreshServerApps(); break;
            case 'ptero-refresh': refreshPterodactyl(); break;
            case 'ai-send': sendAI(); break;
            case 'updates-check': {
                $('#update-status').textContent = 'checking…';
                const r = await api.updates.check();
                $('#update-status').textContent = r.note
                    ? r.note
                    : (r.updates > 0 ? `${r.updates} update(s) available — click Apply updates` : '✓ everything is up to date');
                break;
            }
            case 'updates-apply': {
                if (!window.confirm('Update everything now?\n\nThis downloads and installs the latest version of every app and system package. It can take several minutes and needs an internet connection. Keep the computer plugged in.')) break;
                $('#update-status').textContent = 'updating… (this can take a few minutes)';
                const r = await api.updates.apply();
                if (r.ok) {
                    $('#update-status').textContent = '✓ everything is up to date';
                    toast('All apps and packages are up to date.');
                } else {
                    $('#update-status').textContent = 'update failed' + (r.hint || '');
                    toast('Update failed: ' + ((r.error || '').split('\n').filter(Boolean).pop() || 'unknown error').slice(0, 140));
                }
                break;
            }
            case 'check-shell': checkShellUpdate(); break;
            case 'install-shell': installShellUpdate(); break;
            case 'repair-shell': repairShell(); break;
            case 'rollback-shell': rollbackShell(); break;
            case 'installer': { const r = await api.installer.launch(); toast(r.ok ? 'Opening installer…' : r.error); break; }
            case 'power-menu': openPower(); break;
            case 'power-cancel': closePower(); break;
            case 'lock': lockNow(); break;
            case 'reboot': closePower(); api.power.reboot(); break;
            case 'shutdown': closePower(); api.power.shutdown(); break;
            case 'stability-works':  setStabilityVote('works'); break;
            case 'stability-broken': setStabilityVote('broken'); break;
            case 'stability-refresh': refreshStabilityTally(); break;
            case 'stability-share':  shareStabilityFeedback(); break;
            case 'storage-scan':  storageScan(); break;
            case 'storage-clean': storageClean(); break;
            case 'confirm-cancel': closeConfirm(false); break;
        }
    });

    // Terminal
    const ti = $('#term-in');
    ti.addEventListener('input', () => inspectCommand(ti.value));
    ti.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { const c = ti.value.trim(); if (c) { ti.value = ''; $('#term-hint').textContent = ''; _termHistPush(c); runTerminal(c); } }
        else if (e.key === 'ArrowUp') { e.preventDefault(); _termHistNav(-1, ti); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); _termHistNav(1, ti); }
    });

    // AI input
    $('#ai-in').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendAI(); });

    // Phase 15b — persistent-chat controls (switch / new / delete).
    const chatSel = $('#ai-chat-select');
    if (chatSel) chatSel.addEventListener('change', (e) => switchAiChat(e.target.value));
    const chatNew = $('#ai-chat-new');
    if (chatNew) chatNew.addEventListener('click', newAiChat);
    const chatDel = $('#ai-chat-delete');
    if (chatDel) chatDel.addEventListener('click', deleteAiChat);
    const refSel = $('#ai-ref-select');
    if (refSel) refSel.addEventListener('change', (e) => { const v = e.target.value; if (v) referenceChat(v); });

    // Phase 16 — AI engine selector + Ollama model pull.
    const engineSel = $('#ai-engine');
    if (engineSel) engineSel.addEventListener('change', async (e) => {
        const eng = e.target.value;
        await setSetting({ aiEngine: eng, baseAiEnabled: eng === 'base' });
        syncOllamaRow(eng);
        refreshAiStatus();
    });
    const ollPull = $('#ollama-pull');
    if (ollPull) ollPull.addEventListener('click', handleOllamaPull);

    // Apps panel search — type-as-you-go, no debounce needed (catalog is tiny).
    const appsSearchEl = $('#apps-search');
    if (appsSearchEl) {
        appsSearchEl.addEventListener('input', (e) => setAppsSearch(e.target.value));
    }
    // QoL — Files in-folder filter.
    const fsFilterEl = $('#fs-filter');
    if (fsFilterEl) fsFilterEl.addEventListener('input', (e) => { _fsFilter = e.target.value || ''; applyFsFilter(); });

    // Phase 2 — re-scan apps "On this PC" when the shell regains focus (e.g. after
    // downloading an AppImage in the browser and tabbing back), so it appears
    // without a manual refresh. Only does work while the Apps screen is open.
    window.addEventListener('focus', () => {
        if (!document.querySelector('#screen-apps.active')) return;
        api.apps.discover()
            .then((d) => { _appsState.discovered = d || []; if (_appsState.filter === 'discovered') _renderAppsList(); })
            .catch(() => {});
    });

    // Confirm modal
    $('#confirm-input').addEventListener('input', (e) => { $('#confirm-go').disabled = e.target.value.trim() !== 'CONFIRM'; });
    $('#confirm-go').addEventListener('click', () => closeConfirm(true));

    // Settings toggles
    $('#crt-toggle').addEventListener('change', (e) => { document.body.classList.toggle('crt', e.target.checked); setSetting({ crtFx: e.target.checked }); });
    $('#glow-toggle').addEventListener('change', (e) => { document.body.classList.toggle('glow', e.target.checked); setSetting({ glow: e.target.checked }); });
    { const rm = $('#reduce-motion-toggle'); if (rm) rm.addEventListener('change', (e) => { document.body.classList.toggle('reduce-motion', e.target.checked); setSetting({ reduceMotion: e.target.checked }); syncBrokenFx(); }); }
    { const hc = $('#contrast-toggle'); if (hc) hc.addEventListener('change', (e) => { document.body.classList.toggle('high-contrast', e.target.checked); setSetting({ highContrast: e.target.checked }); }); }
    { const us = $('#ui-scale'); if (us) us.addEventListener('change', (e) => { const f = parseFloat(e.target.value) || 1; if (api.setZoom) api.setZoom(f); setSetting({ uiScale: f }); }); }
    // QoL — reset appearance (theme/effects/motion/text size) to defaults.
    { const ar = $('#appearance-reset'); if (ar) ar.addEventListener('click', async () => {
        try {
            await setSetting({ theme: 'green', crtFx: false, glow: false, reduceMotion: false, highContrast: false, uiScale: 1 });
            await loadSettings();   // re-applies theme, effects, motion, contrast + zoom
            toast('Appearance reset to defaults.');
        } catch { toast('Couldn\'t reset appearance.'); }
    }); }
    // F1 — error-log controls.
    { const b = $('#errlog-refresh'); if (b) b.addEventListener('click', errlogRefresh); }
    { const b = $('#errlog-github'); if (b) b.addEventListener('click', errlogGithub); }
    { const b = $('#errlog-copy'); if (b) b.addEventListener('click', errlogCopy); }
    { const b = $('#errlog-clear'); if (b) b.addEventListener('click', errlogClear); }
    // 🗺 Roadmap — render + collapsible groups.
    renderRoadmap();
    { const rv = $('#roadmap-view'); if (rv) rv.addEventListener('click', (e) => {
        const h = e.target.closest('[data-rm-toggle]');
        if (h) { const grp = h.closest('.rm-group'); if (grp) grp.classList.toggle('open'); }
    }); }
    const _themeSel = $('#theme-select');
    if (_themeSel) _themeSel.addEventListener('change', (e) => {
        const v = e.target.value;
        const t = (v === 'gold' || v === 'broken') ? v : 'green';   // broken was falling through to green
        applyTheme(t);
        setSetting({ theme: t });
        toast(t === 'gold' ? 'Gold Gunmetal engaged.'
            : t === 'broken' ? 'Broken mode — barely holding on…'
                : 'Green Phosphor restored.');
    });
    $('#ai-toggle').addEventListener('change', async (e) => {
        if (e.target.checked) {
            const r = await api.ai.enable();
            // Engine-aware "not reachable yet" message — an Ollama user must not be
            // told to start LM Studio (mirrors coreai.js _unreachableMsg).
            const notReady = r.backend === 'ollama'
                ? 'AI enabled — make sure Ollama is running and the model is pulled (Settings → AI).'
                : 'AI enabled — start LM Studio and click "Start Server".';
            toast(r.backend === 'base'
                ? (r.available ? 'AI enabled — using the built-in model.' : 'AI enabled — preparing the built-in model…')
                : (r.available ? 'AI enabled.' : notReady));
        } else {
            await api.ai.disable();
            toast('AI disabled.');
        }
        refreshAiStatus();
    });
    // Phase 13.2 — built-in AI vs LM Studio backend toggle.
    const baseAiToggle = $('#base-ai-toggle');
    if (baseAiToggle) baseAiToggle.addEventListener('change', async (e) => {
        const on = !!e.target.checked;
        await setSetting({ baseAiEnabled: on });
        toast(on ? 'Using the built-in AI.' : 'Built-in AI off — will use Ollama or LM Studio instead (whichever you\'ve set up).');
        if (on) { try { api.ai.ensureBaseModel(); } catch {} }   // pull the bundled model if missing
        refreshAiStatus();
    });
    // Convenience: launch LM Studio from the AI settings card.
    const openLmBtn = $('#ai-open-lmstudio');
    if (openLmBtn) {
        openLmBtn.addEventListener('click', async () => {
            try {
                const r = await api.apps.launch('lmstudio');
                if (!r.ok) toast(r.error || 'Could not open LM Studio.');
            } catch {
                toast('Could not open LM Studio.');
            }
        });
    }

    const checkPcBtn = $('#ai-check-pc');
    if (checkPcBtn) {
        checkPcBtn.addEventListener('click', async () => {
            const out = $('#ai-setup-result');
            if (out) out.innerHTML = '<span class="muted">Reading your hardware…</span>';
            // There is only one purpose here now — the dev-session ("coding
            // model") path went with the rest of the desktop OS. 'desktop' is
            // the backend's name for the general-instruct catalogue.
            const opts = { purpose: 'desktop', tier: ($('#ai-tier') || {}).value || 'powerful' };
            try {
                renderAiRecommendation(await api.ai.recommend(opts));
                // #2 — fill in the plain-language AI take async (best-effort; the
                // reliable recommendation is already on screen if the AI is down).
                const take = $('#ai-setup-ai-take');
                if (take) {
                    take.textContent = '';
                    try {
                        const ex = await api.ai.recommendExplain(opts);
                        if (ex && ex.ok && ex.text) take.textContent = '“' + ex.text + '” — Cr1tt3r';
                    } catch {}
                }
            } catch (err) {
                if (out) out.innerHTML = '<span class="muted">Could not read specs: ' + escapeHtml(err.message) + '</span>';
            }
        });
    }
    const getLmBtn = $('#ai-get-lmstudio');
    if (getLmBtn) {
        getLmBtn.addEventListener('click', async () => {
            try {
                const r = await api.apps.launch('lmstudio');
                toast(r.ok ? 'Opening LM Studio (or its download page).' : (r.error || 'Could not open LM Studio.'));
            } catch { toast('Could not open LM Studio.'); }
        });
    }

    // Phase 4: hardware-aware setup chat. Plain-prose Q&A that already knows the
    // machine's specs; once a model is loaded in LM Studio it walks the user
    // through the rest. Short in-renderer history gives multi-turn context.
    const setupLog = $('#ai-setup-chat-log');
    const setupIn = $('#ai-setup-chat-in');
    const setupSend = $('#ai-setup-chat-send');
    const setupChatHistory = [];
    const appendSetupMsg = (role, text, muted) => {
        if (!setupLog) return null;
        const div = document.createElement('div');
        div.style.margin = '4px 0';
        if (muted) div.className = 'muted';
        div.innerHTML = '<b>' + (role === 'user' ? 'You' : 'AI') + ':</b> '
            + escapeHtml(text).replace(/\n/g, '<br>');
        setupLog.appendChild(div);
        setupLog.scrollTop = setupLog.scrollHeight;
        return div;
    };
    const sendSetupChat = async () => {
        if (!setupIn) return;
        const q = setupIn.value.trim();
        if (!q) return;
        setupIn.value = '';
        appendSetupMsg('user', q);
        const priorHistory = setupChatHistory.slice();   // turns BEFORE this one
        setupChatHistory.push({ role: 'user', content: q });
        const thinking = appendSetupMsg('ai', '…', true);
        try {
            const r = await api.ai.setupChat({ prompt: q, history: priorHistory });
            if (thinking && thinking.parentNode) thinking.parentNode.removeChild(thinking);
            if (r && r.ok) {
                appendSetupMsg('ai', r.text);
                setupChatHistory.push({ role: 'assistant', content: r.text });
            } else {
                appendSetupMsg('ai', (r && r.error) || 'No reply.', true);
            }
        } catch (err) {
            if (thinking && thinking.parentNode) thinking.parentNode.removeChild(thinking);
            appendSetupMsg('ai', 'Error: ' + err.message, true);
        }
    };
    if (setupSend) setupSend.addEventListener('click', sendSetupChat);
    if (setupIn) setupIn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); sendSetupChat(); }
    });

    // Phase 5: Task Manager — column sort + End task / End process tree.
    const _sortByKey = (key) => {
        if (_procSort.key === key) _procSort.asc = !_procSort.asc;
        else _procSort = { key, asc: key === 'comm' };   // names A→Z, numbers high→low
        _renderProcs();
    };
    $$('#screen-tasks .proc th[data-sort]').forEach((th) => {
        th.addEventListener('click', () => _sortByKey(th.dataset.sort));
        // a11y — Enter/Space sorts, so the headers are operable without a mouse.
        th.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _sortByKey(th.dataset.sort); }
        });
    });
    const endTaskBtn = $('#task-end');
    if (endTaskBtn) endTaskBtn.addEventListener('click', async () => {
        if (!_selectedPid) return;
        try {
            const r = await api.system.kill(_selectedPid);
            toast(r.ok ? 'Ended task.' : ('Could not end — ' + ((r.errors || []).join(', ') || 'failed')));
        } catch (e) { toast('End task failed: ' + e.message); }
        refreshTasks();
    });
    const endTreeBtn = $('#task-end-tree');
    if (endTreeBtn) endTreeBtn.addEventListener('click', async () => {
        if (!_selectedPid) return;
        try {
            const r = await api.system.killTree(_selectedPid);
            toast(r.ok ? `Ended process tree (${r.killed} process${r.killed === 1 ? '' : 'es'}).`
                       : `Ended ${r.killed}; some need admin: ${(r.errors || []).join(', ')}`);
        } catch (e) { toast('End tree failed: ' + e.message); }
        refreshTasks();
    });
    // One delegated click handler for all process rows (scales to the full list).
    const procBodyEl = $('#proc-body');
    if (procBodyEl) procBodyEl.addEventListener('click', (e) => {
        const tr = e.target.closest('tr[data-pid]');
        if (tr) _selectProc(tr.dataset.pid);
    });
    // a11y — keyboard users select a row (the prerequisite for End task) with Enter/Space.
    if (procBodyEl) procBodyEl.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const tr = e.target.closest('tr[data-pid]');
        if (tr) { e.preventDefault(); _selectProc(tr.dataset.pid); }
    });
    const procFilterEl = $('#proc-filter');
    if (procFilterEl) procFilterEl.addEventListener('input', () => {
        _procFilter = procFilterEl.value.trim().toLowerCase();
        _renderProcs();
    });

    // Phase 6: Help — live search.
    const helpSearchEl = $('#help-search');
    if (helpSearchEl) helpSearchEl.addEventListener('input', () => renderHelp(helpSearchEl.value));

    // Phase 6: Quickstart tour controls.
    const qsNext = $('#qs-next');
    if (qsNext) qsNext.addEventListener('click', () => {
        if (_qsIndex >= QUICKSTART_STEPS.length - 1) { endQuickstart(); return; }
        _qsIndex++; renderQuickstartStep();
    });
    const qsBack = $('#qs-back');
    if (qsBack) qsBack.addEventListener('click', () => { if (_qsIndex > 0) { _qsIndex--; renderQuickstartStep(); } });
    const qsSkip = $('#qs-skip');
    if (qsSkip) qsSkip.addEventListener('click', endQuickstart);
    const qsReplay = $('#help-replay-tour');
    if (qsReplay) qsReplay.addEventListener('click', showQuickstart);

    // Phase 9: session graphics/driver profile buttons.

    // Phase 12: loading screen close button (enabled once a job finishes).
    const lsClose = $('#ls-close');
    if (lsClose) lsClose.addEventListener('click', () => loadingScreen.hide());

    // Live-ISO welcome card buttons. The card itself is shown/hidden by
    // refreshLiveWelcome() on boot; these handlers cover the three actions
    // the user can take from it.
    const liveInstall = $('#live-install-btn');
    if (liveInstall) {
        liveInstall.addEventListener('click', async () => {
            try {
                const r = await api.installer.launch();
                if (!r || !r.ok) toast(r && r.error ? r.error : 'Could not launch installer.');
            } catch (e) {
                toast('Installer launch failed: ' + e.message);
            }
        });
    }
    const liveTry = $('#live-dismiss-btn');
    if (liveTry) {
        liveTry.addEventListener('click', () => {
            const card = $('#live-welcome');
            if (card) card.hidden = true;
            toast('Card hidden for this session — try anything you like, reboot to reset.');
        });
    }
    const liveNever = $('#live-never-btn');
    if (liveNever) {
        liveNever.addEventListener('click', async () => {
            const card = $('#live-welcome');
            if (card) card.hidden = true;
            try { await setSetting({ liveWelcomeDismissed: true }); } catch {}
            toast('Welcome card disabled permanently for this user.');
        });
    }

    // Updater settings — persist on change.
    let repoSaveTimer = null;
    $('#update-repo').addEventListener('input', (e) => {
        clearTimeout(repoSaveTimer);
        repoSaveTimer = setTimeout(() => setSetting({ updateRepo: e.target.value.trim() }), 400);
    });
    $('#auto-check').addEventListener('change', (e) => {
        setSetting({ autoCheck: e.target.checked });
        toast('Auto-check ' + (e.target.checked ? 'enabled' : 'disabled') + '.');
    });
    // C8 — storage-as-memory (swapfile) toggle.
    const swapTog = $('#swap-toggle');
    if (swapTog) swapTog.addEventListener('change', onSwapToggle);
    // QoL — airplane mode toggle (+ reflect actual radio state at startup).
    const airTog = $('#airplane-toggle');
    if (airTog) airTog.addEventListener('change', onAirplaneToggle);
    refreshAirplane();
    // Time zone + NTP. Keeping a server's clock right is not cosmetic: logs,
    // certificates, scheduled jobs and TOTP sign-in codes all depend on it.
    const tzSel = $('#tz-select');
    if (tzSel) tzSel.addEventListener('change', async () => {
        _regionMsg('Setting time zone…');
        const r = await api.time.setZone(tzSel.value);
        _regionMsg(r && r.ok ? 'Time zone updated.' : ('Couldn\'t set time zone' + (r && r.error ? ': ' + r.error : '.')));
        if (!r || !r.ok) refreshRegionUi();
    });
    const ntpTog = $('#ntp-toggle');
    if (ntpTog) ntpTog.addEventListener('change', async () => {
        const r = await api.time.setNtp(ntpTog.checked);
        if (!r || !r.ok) { ntpTog.checked = !ntpTog.checked; _regionMsg('Couldn\'t change auto-time' + (r && r.error ? ': ' + r.error : '.')); }
        else _regionMsg('Auto-time ' + (ntpTog.checked ? 'on.' : 'off.'));
    });
    // Auto-lock still applies — an unattended console next to a rack is a real
    // way in. Sleep and screen blanking do not: a server that suspends itself
    // is a server that stopped serving.
    const alSel = $('#autolock-select');
    if (alSel) alSel.addEventListener('change', () => setSetting({ autoLockMin: parseInt(alSel.value, 10) || 0 }));
    // Main's system-wide idle watch says it's time to lock.
    api.on('idle-lock', onIdleLock);
    // QoL — Settings search/filter.
    const setSearch = $('#settings-search');
    if (setSearch) setSearch.addEventListener('input', (e) => filterSettings(e.target.value));

    // ----- Server screens ---------------------------------------------------
    // Filtering is local to the cached list — no round trip per keystroke.
    { const f = $('#svc-filter'); if (f) f.addEventListener('input', renderServices); }
    { const u = $('#log-unit'); if (u) u.addEventListener('keydown', (e) => { if (e.key === 'Enter') refreshLogs(); }); }
    { const n = $('#log-lines'); if (n) n.addEventListener('change', refreshLogs); }
    { const b = $('#ssh-key-add'); if (b) b.addEventListener('click', sshAddKey); }
    { const i = $('#ssh-key-in'); if (i) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') sshAddKey(); }); }
    { const b = $('#fw-allow'); if (b) b.addEventListener('click', () => firewallAdd('allow')); }
    { const b = $('#fw-deny'); if (b) b.addEventListener('click', () => firewallAdd('deny')); }
    { const p = $('#fw-port'); if (p) p.addEventListener('keydown', (e) => { if (e.key === 'Enter') firewallAdd('allow'); }); }
    { const t = $('#fw-toggle'); if (t) t.addEventListener('change', async () => {
        const on = t.checked;
        // Turning the firewall ON while connected over SSH, with no rule for
        // port 22, drops the connection. Warn before doing it, not after.
        if (on) {
            const st = await op('firewall:status');
            const hasSsh = (st.rules || []).some((x) => /(^|\D)22(\D|$)|ssh/i.test(x.target || ''));
            if (!hasSsh) {
                const go = await askConfirm({
                    title: 'Turn the firewall on with no SSH rule?',
                    reason: 'Nothing here allows port 22. If you are connected over SSH, enabling the firewall now will cut that connection and you will need physical access to the machine. Add a rule for 22/tcp first if you need SSH.',
                    cmd: 'ufw enable',
                });
                if (!go) { t.checked = false; return; }
            }
        }
        t.disabled = true;
        const r = await op('firewall:set', { enabled: on });
        t.disabled = false;
        if (r.ok === false) { t.checked = !on; _fwMsg(r.error || 'Could not change the firewall.'); }
        else { _fwMsg(on ? 'Firewall on.' : 'Firewall off.'); toast(on ? 'Firewall enabled.' : 'Firewall disabled.'); }
        refreshFirewall();
    }); }
    // QOL batch — calendar popover (topbar clock).
    { const ck = $('#stat-clock'); if (ck) ck.addEventListener('click', toggleCalPopover); }
    { const b = $('#cal-prev'); if (b) b.addEventListener('click', () => { _calMonth--; if (_calMonth < 0) { _calMonth = 11; _calYear--; } renderCal(); }); }
    { const b = $('#cal-next'); if (b) b.addEventListener('click', () => { _calMonth++; if (_calMonth > 11) { _calMonth = 0; _calYear++; } renderCal(); }); }
    { const b = $('#cal-today'); if (b) b.addEventListener('click', () => { const now = new Date(); _calYear = now.getFullYear(); _calMonth = now.getMonth(); renderCal(); }); }
    document.addEventListener('click', (e) => {
        const pop = $('#cal-popover');
        if (!pop || pop.hidden) return;
        if (e.target.closest('#cal-popover') || e.target.closest('#stat-clock')) return;
        closeCalPopover();
    });
    // QOL batch — command palette.
    { const pi = $('#pal-input'); if (pi) {
        pi.addEventListener('input', () => _palFilter());
        pi.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); _palMove(1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); _palMove(-1); }
            else if (e.key === 'Enter') { e.preventDefault(); _palRun(_palSel); }
        });
    } }
    { const pl = $('#pal-list'); if (pl) pl.addEventListener('click', (e) => {
        const item = e.target.closest('[data-pal-idx]');
        if (item) _palRun(parseInt(item.dataset.palIdx, 10));
    }); }
    { const pal = $('#palette'); if (pal) pal.addEventListener('click', (e) => { if (e.target === pal) closePalette(); }); }
    // QoL — Esc and click-outside close the power menu (expected desktop behavior).
    document.addEventListener('keydown', (e) => {
        // Esc — close (in order): the palette, any topbar popover, a FINISHED
        // loading screen (never mid-operation; the X stays disabled until
        // done), then the power menu.
        if (e.key === 'Escape') {
            // One Esc dismisses ONE surface. This listener runs FIRST (earlier
            // registration), so after consuming the key it must stop the later
            // document-level listener — that one would see the surface already
            // closed and close the power menu / cancel a confirm dialog too.
            const pal = $('#palette'); if (pal && !pal.hidden) { closePalette(); e.stopImmediatePropagation(); return; }
            const cp = $('#cal-popover'); if (cp && !cp.hidden) { closeCalPopover(); e.stopImmediatePropagation(); return; }
            const ls = $('#loadscreen'), lsClose = $('#ls-close');
            if (ls && ls.classList.contains('show') && lsClose && !lsClose.disabled) { loadingScreen.hide(); e.stopImmediatePropagation(); return; }
            // Esc leaves the quickstart tour (same as Skip — it can be replayed
            // from Help any time).
            const qt = $('#quickstart');
            if (qt && qt.style.display === 'flex') { endQuickstart(); e.stopImmediatePropagation(); return; }
            const pm = $('#power-modal');
            if (pm && pm.classList.contains('show')) closePower();
            return;
        }
        // Don't fire navigation shortcuts while the sign-in/lock overlay is up.
        const signin = $('#signin');
        if (signin && signin.style.display === 'flex') return;
        // Ctrl/Cmd+K — quick-ask the AI from anywhere.
        if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
            e.preventDefault();
            try { showScreen('ai'); const i = $('#ai-in'); if (i) i.focus(); } catch {}
            return;
        }
        // Ctrl/Cmd+Space — the command palette (search everything).
        if ((e.ctrlKey || e.metaKey) && (e.code === 'Space' || e.key === ' ')) {
            e.preventDefault();
            const pal = $('#palette');
            if (pal && !pal.hidden) closePalette(); else openPalette();
            return;
        }
        // Ctrl/Cmd+, — open Settings (the conventional shortcut).
        if ((e.ctrlKey || e.metaKey) && e.key === ',') {
            e.preventDefault();
            try { showScreen('settings'); } catch {}
            return;
        }
        // Alt+1..9 — jump to the Nth sidebar screen (not while typing in a field).
        if (e.altKey && !e.ctrlKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
            const ae = document.activeElement;
            if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
            const navs = $$('.nav-item[data-screen]');
            const idx = parseInt(e.key, 10) - 1;
            if (navs[idx]) { e.preventDefault(); navs[idx].click(); }
        }
    });
    const powerModal = $('#power-modal');
    if (powerModal) powerModal.addEventListener('click', (e) => { if (e.target === powerModal) closePower(); });
    const channelEl = $('#update-channel');
    if (channelEl) {
        channelEl.addEventListener('change', (e) => {
            const ch = e.target.value === 'beta' ? 'beta' : 'stable';
            setSetting({ updateChannel: ch });
            toast(ch === 'beta'
                ? 'Beta channel — you’ll get the newest (untested) builds.'
                : 'Stable channel — only tested releases.');
        });
    }

    // Toast events from the main process (used by background update checks).
    api.on('toast', (msg) => toast(String(msg)));

    // Keyboard: physical calculator + escape closes modals
    document.addEventListener('keydown', (e) => {
        // Emergency stop: Ctrl+Alt+K → kill every tracked subprocess in main.
        // Works even when modal dialogs / hung handlers are blocking the rest
        // of the UI — last-resort escape hatch.
        if (e.key && e.key.toLowerCase() === 'k' && e.ctrlKey && e.altKey) {
            e.preventDefault();
            (async () => {
                try {
                    const r = await api.emergency.stop();
                    toast(`🛑 Emergency stop — killed ${r.killed} process(es).`);
                } catch (err) {
                    toast('Emergency stop failed: ' + err.message);
                }
            })();
            return;
        }
        // One Esc dismisses ONE surface. This listener registered first, so it
        // must defer while a palette/popover/loading screen is open — the later
        // Esc-chain listener owns closing those; without this guard the same
        // keypress would ALSO close the power menu and cancel a pending confirm
        // dialog behind them.
        const _escSurfaceOpen = ['#palette', '#cal-popover']
            .some((s) => { const el = $(s); return el && !el.hidden; })
            || (($('#loadscreen') || {}).classList || { contains: () => false }).contains('show');
        if (e.key === 'Escape' && !_escSurfaceOpen) { closePower(); if (confirmResolver) closeConfirm(false); }
    });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
// QoL — warn once at startup if the disk is nearly full (installs/updates would
// fail confusingly otherwise). Also logged so a "Report a problem" captures it.
async function checkDiskSpace() {
    try {
        const d = await api.system.disk();
        if (!d || !d.available || !d.totalMb) return;
        const freeMb = Math.max(0, d.totalMb - d.usedMb);
        if (d.pct >= 92 || freeMb < 2048) {
            const gb = (freeMb / 1024).toFixed(1);
            const msg = `⚠ Low disk space — ${gb} GB free (${d.pct}% used). Try Settings → Free up space before installing apps or updates.`;
            setTimeout(() => toast(msg), 2600);
            try { api.errorlog.add({ level: 'warning', source: 'shell-ui', message: msg }); } catch {}
        }
    } catch {}
}

// QoL — after an update applies, tell the user once which version they're on.
async function checkVersionBump() {
    try {
        const ver = await api.appVersion();
        if (!ver) return;
        const s = await api.settings.get();
        const last = s && s.lastSeenVersion;
        if (last && last !== ver) setTimeout(() => toast('✓ Updated to v' + ver), 1800);
        if (last !== ver) await setSetting({ lastSeenVersion: ver });
    } catch {}
}

window.addEventListener('DOMContentLoaded', async () => {
    wire();
    await loadSettings();
    enhanceSelects();   // replace native <select> popups (broken with no WM)
    initAiChats().catch(() => {});   // Phase 15b — load persistent Cr1tt3r chats
    await renderTiles();
    renderRecentApps();   // QOL — "Recent" row on the Dashboard (hidden when empty)
    await loadSysInfo();
    // Probe whether a previous shell version exists on disk so the Rollback
    // button reflects reality on Settings open instead of waiting for a click.
    refreshRollbackAvailability().catch(() => {});
    // Live-ISO welcome card. Only shows when /run/archiso exists AND the user
    // hasn't ticked "Don't show again". Installed users never see this.
    refreshLiveWelcome().catch(() => {});
    // First-login connectivity check: if there's no internet, the topbar shows
    // an "OFFLINE — set up Wi-Fi" pill that jumps straight to the Wi-Fi panel.
    // (Being offline silently was the root cause of several failed installs.)
    wireNetworkUI();
    refreshNetStatus().catch(() => {});
    checkVersionBump().catch(() => {});   // QoL — "Updated to vX" note after an update
    checkDiskSpace().catch(() => {});     // QoL — warn if the disk is nearly full
    wireAuth();
    // Sign-in gate (Phase 3c): the lock screen first (if enabled), then boot.
    startupGate();
});

async function refreshLiveWelcome() {
    const card = $('#live-welcome');
    if (!api.system || !api.system.liveIso) return;
    try {
        const r = await api.system.liveIso();
        _isLive = !!(r && r.live);
        if (card) card.hidden = !(r && r.live && !r.dismissed);
        applyLiveLocks();
    } catch {
        if (card) card.hidden = true;
    }
}

// Live-mode ("broken mode", basic form): the live ISO is an ephemeral, limited
// preview — a teaser of the real thing. Lock the features that can't or
// shouldn't run until the OS is actually installed, and flag the limited state.
// The full glitch/fake-error aesthetic + a selectable "Broken" theme come later
// (roadmap). Installed systems never hit any of this.
let _isLive = false;
function applyLiveLocks() {
    if (!_isLive) return;
    document.body.classList.add('live-mode');
    const badge = $('#live-badge'); if (badge) badge.hidden = false;
}
