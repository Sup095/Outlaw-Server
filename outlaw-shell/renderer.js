// ============================================================================
// Outlaw OS - renderer
// No inline handlers (CSP-safe). Everything talks to the main process through
// the audited `window.outlaw` bridge defined in preload.js.
// ============================================================================
'use strict';

const api = window.outlaw;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// F1 — capture renderer errors/rejections into the combined error log, so a
// desktop crash leaves a trace even when nobody's reading the console.
window.addEventListener('error', (e) => {
    try { window.outlaw.errorlog.add({ level: 'error', source: 'shell-ui', message: (e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || '') }); } catch {}
});
window.addEventListener('unhandledrejection', (e) => {
    try { window.outlaw.errorlog.add({ level: 'error', source: 'shell-ui', message: 'unhandledrejection: ' + String((e.reason && e.reason.message) || e.reason) }); } catch {}
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

// --- Region & Input (keyboard layout, time zone, NTP) + Bluetooth -----------
function _regionMsg(t) { const el = document.querySelector('#region-msg'); if (el) el.textContent = t || ''; }
let _regionPopulated = false;
async function refreshRegionUi() {
    const kbSel = document.querySelector('#kb-layout');
    const tzSel = document.querySelector('#tz-select');
    const ntp = document.querySelector('#ntp-toggle');
    try {
        if (!_regionPopulated) {
            const [layouts, zones] = await Promise.all([api.kb.list(), api.time.zones()]);
            if (kbSel && Array.isArray(layouts)) kbSel.innerHTML = layouts.map((l) => `<option value="${l.code}">${l.label}</option>`).join('');
            if (tzSel && Array.isArray(zones)) tzSel.innerHTML = zones.map((z) => `<option value="${z}">${z}</option>`).join('');
            _regionPopulated = true;
        }
        const [kbSt, tSt] = await Promise.all([api.kb.status(), api.time.status()]);
        if (kbSel && kbSt) kbSel.value = kbSt.saved || kbSt.current || 'us';
        if (tzSel && tSt && tSt.timezone) tzSel.value = tSt.timezone;
        if (ntp && tSt) ntp.checked = !!tSt.ntp;
        const sub = document.querySelector('#tz-sub'); if (sub && tSt && tSt.local) sub.textContent = tSt.local;
    } catch { /* leave defaults */ }
}
async function refreshBtUi() {
    const tog = document.querySelector('#bt-toggle');
    const sub = document.querySelector('#bt-status-sub');
    const mng = document.querySelector('#bt-manage-btn');
    try {
        const r = await api.bt.status();
        if (!r || !r.present) {
            if (sub) sub.textContent = 'No Bluetooth adapter found.';
            if (tog) tog.disabled = true;
            if (mng) mng.disabled = true;
            return;
        }
        if (tog) { tog.disabled = false; tog.checked = !!r.powered; }
        if (mng) mng.disabled = false;
        if (sub) sub.textContent = r.powered ? 'On — pair a device below.' : 'Off.';
    } catch { if (sub) sub.textContent = 'Bluetooth unavailable.'; }
}

// --- Tier-2 desktop QOL: night light + Do Not Disturb -----------------------
function _desktopMsg(t) { const el = document.querySelector('#desktop-msg'); if (el) el.textContent = t || ''; }
async function refreshDesktopUi() {
    const nlTog = document.querySelector('#nightlight-toggle');
    const nlTemp = document.querySelector('#nightlight-temp');
    const nlRow = document.querySelector('#nightlight-warmth-row');
    const dndTog = document.querySelector('#dnd-toggle');
    try {
        const nl = await api.nightlight.status();
        if (nlTog) nlTog.checked = !!(nl && nl.on);
        if (nlTemp && nl && nl.temp) nlTemp.value = String(nl.temp);
        if (nlRow) nlRow.style.display = (nl && nl.on) ? '' : 'none';
        const sub = document.querySelector('#nightlight-sub');
        if (sub && nl && !nl.supported) sub.textContent = 'Runs on Outlaw OS.';
    } catch {}
    try {
        const d = await api.notif.dndStatus();
        if (dndTog) dndTog.checked = !!(d && d.paused);
    } catch {}
}

// --- Display settings (xrandr modes + brightness) ----------------------------
// The renderer half of the safe-apply design: main owns the real 15s revert
// timer; this code just renders the pickers and the visible countdown.
function _dispMsg(t) { const el = document.querySelector('#display-msg'); if (el) el.textContent = t || ''; }
async function refreshDisplayUi() {
    const box = document.querySelector('#display-outputs');
    if (!box) return;
    try {
        const d = await api.display.info();
        if (!d || !d.supported) box.innerHTML = '<div class="muted">Display settings run on Outlaw OS.</div>';
        else if (!d.outputs.length) box.innerHTML = '<div class="muted">No displays detected.</div>';
        else {
            box.innerHTML = '';
            for (const o of d.outputs) {
                const row = document.createElement('div');
                row.className = 'setting';
                const opts = [];
                for (const m of o.modes) for (const r of m.rates) {
                    const sel = o.current && o.current.mode === m.mode && o.current.rate === r;
                    opts.push(`<option value="${_escapeHtml(m.mode)}|${_escapeHtml(r)}"${sel ? ' selected' : ''}>${_escapeHtml(m.mode)} @ ${_escapeHtml(r)} Hz</option>`);
                }
                row.innerHTML =
                    `<div class="label">${_escapeHtml(o.name)}${o.primary ? ' <span class="dim">(primary)</span>' : ''}`
                    + `<small>${o.current ? 'Now: ' + _escapeHtml(o.current.mode) + ' @ ' + _escapeHtml(o.current.rate) + ' Hz' : 'Current mode unknown'}</small></div>`
                    + `<div class="row" style="gap:6px;">`
                    + `<select data-disp-out="${_escapeHtml(o.name)}" aria-label="Resolution for ${_escapeHtml(o.name)}" style="width:auto;min-width:190px;">${opts.join('')}</select>`
                    + `<button data-disp-apply="${_escapeHtml(o.name)}" title="Apply this mode (auto-reverts in 15s unless you keep it)">Apply</button></div>`;
                box.appendChild(row);
            }
            enhanceSelects(box);   // fresh selects each render — wrappers die with them
        }
    } catch { box.innerHTML = '<div class="muted">Couldn\'t read display info.</div>'; }
    try {
        const b = await api.display.brightnessInfo();
        const row = document.querySelector('#brightness-row');
        const sl = document.querySelector('#brightness-slider');
        const sub = document.querySelector('#brightness-sub');
        if (row) row.hidden = !(b && b.present);
        if (b && b.present && sl) sl.value = b.pct;
        if (b && b.present && b.writable === false && sub) {
            sub.textContent = 'Backlight found, but no permission to change it — fresh-install a current ISO to pick up the udev rule.';
        }
    } catch {}
}
// Keep/revert countdown dialog (the visible half of main's auto-revert).
let _dispCountTimer = null;
let _dispPending = null;
function _closeDispConfirm() {
    const m = document.querySelector('#disp-confirm');
    if (m) m.classList.remove('show');
    if (_dispCountTimer) { clearInterval(_dispCountTimer); _dispCountTimer = null; }
    _dispPending = null;
}
function openDispConfirm(payload) {
    const m = document.querySelector('#disp-confirm');
    if (!m) return;
    _dispPending = payload || null;
    let left = 15;
    const c = document.querySelector('#disp-count');
    if (c) c.textContent = left;
    m.classList.add('show');
    const keep = document.querySelector('#disp-keep');
    if (keep) keep.focus();
    _dispCountTimer = setInterval(() => {
        left--;
        if (c && left >= 0) c.textContent = left;
        if (left <= 0) {
            // Main's timer has already reverted (or is about to) — just reflect it.
            _closeDispConfirm();
            _dispMsg('No confirmation — reverted to the previous mode.');
            refreshDisplayUi();
        }
    }, 1000);
}

// Recent-notifications list (read-only view over the daemon's history).
async function renderNotifHistory() {
    const box = document.querySelector('#notif-history');
    if (!box) return;
    if (box.style.display !== 'none') { box.style.display = 'none'; return; }  // toggle closed
    box.style.display = '';
    box.textContent = 'Loading…';
    try {
        const h = await api.notif.history();
        if (!h || !h.supported) { box.textContent = 'Notification history is available on Outlaw OS (needs the dunst daemon).'; return; }
        if (!h.items.length) { box.textContent = 'No recent notifications.'; return; }
        box.innerHTML = h.items.map((n) =>
            `<div style="padding:4px 0;border-bottom:1px solid var(--line);">`
            + `<b>${_escapeHtml(n.summary || '(no title)')}</b>`
            + (n.app ? ` <span class="dim">· ${_escapeHtml(n.app)}</span>` : '')
            + (n.body ? `<br><span class="dim">${_escapeHtml(n.body)}</span>` : '')
            + `</div>`).join('');
    } catch { box.textContent = 'Couldn\'t read the notification history.'; }
}

// --- QOL batch: quick-settings popover (topbar ☰) ---------------------------
// The everyday toggles in one place. Every control reuses an EXISTING IPC
// surface — this popover adds no new privileges, just faster reach.
function _qkSet(sel, on) {
    const b = document.querySelector(sel);
    if (b) { b.classList.toggle('on', !!on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
}
function _qkOn(sel) { const b = document.querySelector(sel); return !!(b && b.classList.contains('on')); }
async function refreshQuickUi() {
    await Promise.all([
        api.nightlight.status().then((nl) => _qkSet('#qk-nightlight', !!(nl && nl.on))).catch(() => {}),
        api.notif.dndStatus().then((d) => _qkSet('#qk-dnd', !!(d && d.paused))).catch(() => {}),
        api.net.airplaneStatus().then((a) => _qkSet('#qk-airplane', !!(a && a.airplane))).catch(() => {}),
        api.settings.get().then((s) => _qkSet('#qk-perf', !!(s && s.performanceMode))).catch(() => {}),
        api.audio.get().then((a) => {
            const row = document.querySelector('#qk-vol-row');
            if (row) row.hidden = !(a && a.available);
            if (a && a.available) {
                const sl = document.querySelector('#qk-vol'); if (sl) sl.value = a.volume;
                const pct = document.querySelector('#qk-vol-pct'); if (pct) pct.textContent = a.volume + '%';
            }
        }).catch(() => { const row = document.querySelector('#qk-vol-row'); if (row) row.hidden = true; }),
        api.display.brightnessInfo().then((b) => {
            const row = document.querySelector('#qk-bright-row');
            if (row) row.hidden = !(b && b.present && b.writable !== false);
            if (b && b.present) {
                const sl = document.querySelector('#qk-bright'); if (sl) sl.value = b.pct;
                const pct = document.querySelector('#qk-bright-pct'); if (pct) pct.textContent = b.pct + '%';
            }
        }).catch(() => { const row = document.querySelector('#qk-bright-row'); if (row) row.hidden = true; }),
    ]);
}
function closeQuickPopover() { const p = document.querySelector('#quick-popover'); if (p) p.hidden = true; }
function toggleQuickPopover() {
    const pop = document.querySelector('#quick-popover'); if (!pop) return;
    if (pop.hidden) { closeCalPopover(); refreshQuickUi(); pop.hidden = false; } else pop.hidden = true;
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
        closeQuickPopover();
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
        ['📷 Take a screenshot', 'screenshot capture print screen picture', () => takeScreenshot('full')],
        ['📷 Screenshot a region', 'screenshot region area select crop', () => takeScreenshot('region')],
        ['🎥 Start / stop screen recording', 'record screen video capture movie clip', () => toggleRecording()],
        ['🔒 Lock the screen', 'lock secure away pin', () => lockNow()],
        ['💤 Sleep', 'sleep suspend standby power', () => { api.power.suspend().then((r) => { if (r && r.ok === false) toast('Sleep failed: ' + (r.error || 'try again')); }).catch(() => {}); }],
        ['🌙 Toggle night light', 'night light blue warm color', async () => { try { const s = await api.nightlight.status(); const r = await api.nightlight.set({ on: !(s && s.on) }); toast(r && r.ok ? ('Night light ' + (r.on ? 'on.' : 'off.')) : ((r && r.error) || 'Couldn\'t change night light.')); } catch {} }],
        ['🔕 Toggle Do Not Disturb', 'dnd do not disturb notifications quiet mute', async () => { try { const d = await api.notif.dndStatus(); const r = await api.notif.dndSet(!(d && d.paused)); toast(r && r.ok ? ('Do Not Disturb ' + (r.paused ? 'on.' : 'off.')) : ((r && r.error) || 'Couldn\'t change Do Not Disturb.')); } catch {} }],
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
    closeQuickPopover(); closeCalPopover();
    pal.hidden = false;
    const inp = document.querySelector('#pal-input');
    if (inp) { inp.value = ''; inp.focus(); }
    _palFilter();
}
function closePalette() { const pal = document.querySelector('#palette'); if (pal) pal.hidden = true; }

// --- QOL batch: recent apps on the Dashboard ---------------------------------
const _RECENT_ICONS = { browser: '🌐', steam: '🎮', godot: '🤖', files: '📁', terminal: '>_', lutris: '🍷', blender: '🧊', gimp: '🎨', code: '💻' };
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
    try { closePalette(); closeQuickPopover(); closeCalPopover(); } catch {}
    try { const vp = $('#volume-popover'); if (vp) vp.hidden = true; } catch {}
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
    push('INITIALIZING OUTLAW OS…');

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
    if (name === 'dashboard') renderRecentApps();
    if (name === 'gaming') refreshGaming();
    if (name === 'apps') { loadAppsCatalog(); const as = $('#apps-search'); if (as) as.focus(); }
    if (name === 'help') { renderHelp(($('#help-search') || {}).value || ''); const hs = $('#help-search'); if (hs) hs.focus(); }
    if (name === 'settings') { const ss = $('#settings-search'); if (ss) ss.value = ''; filterSettings(''); refreshNetStatus(); refreshDriversUi(); refreshSwapStatus(); refreshAirplane(); refreshRegionUi(); refreshBtUi(); refreshDesktopUi(); refreshDisplayUi(); if (window._refreshSecurityUi) window._refreshSecurityUi(); }
    if (name === 'ai') $('#ai-in').focus();
    if (name === 'terminal') $('#term-in').focus();
    // System Core lifecycle — init when navigating to it, teardown otherwise.
    // The module is self-contained so this is the only hook the rest of the
    // shell needs to know about. SC2+ slices plug into the same init/teardown.
    if (window.outlawCore) {
        if (name === 'syscore') window.outlawCore.init();
        else window.outlawCore.teardown();
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
    launchers: [['browser', '🌐'], ['steam', '🎮'], ['godot', '🤖'], ['files', '📁'], ['terminal', '>_']],
    'gaming-apps': [['steam', '🎮'], ['lutris', '🍷']],
    'gamedev-apps': [['godot', '🤖'], ['blender', '🧊'], ['gimp', '🎨'], ['code', '💻']],
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
    'Game Dev':     '🛠',
    'Gaming':       '🎮',
    'Browsers':     '🌐',
    'Productivity': '📑',
    'Security':     '🛡',
};

// Built once, then mutated in-place when install state changes. `filter` is
// either a category name from the catalog ("Game Dev", "Security", …),
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
        $('#sysinfo').textContent = 'Preview mode — full telemetry available on Outlaw OS.';
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
        'Reinstall the Outlaw OS system code from the latest release?\n\n' +
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
    toast('Outlaw OS reinstalled. Restart the desktop to finish.');
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
    const res = await api.files.list(dir);
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
const QUICKSTART_STEPS = [
    { ico: '✦', title: 'Welcome to Outlaw OS', body: '<p>A lightweight Linux built for AI-driven game development. This quick tour shows where everything is — you can <b>Skip</b> at any time.</p>' },
    { ico: '▣', title: 'Finding your way', body: '<p>The <b>sidebar</b> on the left switches screens — Dashboard, Files, Task Manager, Apps, AI Assistant and more. The top bar shows live CPU/RAM and the clock.</p>' },
    { ico: '✦', title: 'Private, local AI', body: '<p>Open <b>AI Assistant → Check my PC</b> and Outlaw recommends a model your hardware can run plus the best engine for it — the <b>built-in</b> model (already on), <b>Ollama</b> or <b>LM Studio</b>. It all runs on your machine — no account.</p>' },
    { ico: '📦', title: 'Apps & games', body: '<p>The <b>Apps</b> page installs Steam, Firefox, Godot and more in one click. The <b>On this PC</b> view finds everything you’ve already installed, including AppImages.</p>' },
    { ico: '🛠', title: 'Build games', body: '<p>The <b>Dev session</b> (Outlaw CodeMaker) is an AI agent for making Godot games. Switch to it from <b>Settings → Session</b> or the boot greeter.</p>' },
    { ico: '❔', title: 'Stuck? Open Help', body: '<p>The <b>Help</b> screen explains every part of the OS and how to fix common problems, with a search box. You can replay this tour from there too. Enjoy Outlaw OS!</p>' },
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
// Round-2 QOL — battery indicator (laptops; hidden on desktops / no battery).
let _batTick = 0;
// QOL — low-battery warnings. One toast per threshold crossing (20% heads-up,
// 10% urgent), latched so the ~16s battery poll doesn't nag every tick;
// plugging in (or charging back above the threshold) re-arms them.
let _batWarned20 = false;
let _batWarned10 = false;
async function updateBattery() {
    const el = $('#stat-battery'); if (!el) return;
    try {
        const b = await api.system.battery();
        if (!b || !b.present) { el.hidden = true; return; }
        el.hidden = false;
        el.textContent = (b.charging ? '⚡ ' : '🔋 ') + b.percent + '%';
        el.title = 'Battery ' + b.percent + '% · ' + b.status;
        el.classList.toggle('warn-text', !b.charging && b.percent <= 15);
        if (b.charging || b.percent > 22) _batWarned20 = false;
        if (b.charging || b.percent > 12) _batWarned10 = false;
        if (!b.charging && b.percent <= 10 && !_batWarned10) {
            _batWarned10 = true; _batWarned20 = true;   // the 10% toast covers both
            toast('🪫 Battery critically low (' + b.percent + '%) — plug in now or the machine may shut off.');
        } else if (!b.charging && b.percent <= 20 && !_batWarned20) {
            _batWarned20 = true;
            toast('🔋 Battery low (' + b.percent + '%) — consider plugging in.');
        }
    } catch { el.hidden = true; }
}

// Round-2 QOL — volume control popover.
function _setVolIcon(vol, muted) {
    const btn = $('#stat-volume'); if (!btn) return;
    btn.textContent = (muted || vol === 0) ? '🔇' : vol < 50 ? '🔉' : '🔊';
}
async function refreshVolumeUi() {
    const btn = $('#stat-volume'); if (!btn) return;
    try {
        const a = await api.audio.get();
        if (!a || !a.available) { btn.hidden = true; return; }
        btn.hidden = false;
        _setVolIcon(a.volume, a.muted);
        const sl = $('#vol-slider'); if (sl) sl.value = a.volume;
        const pct = $('#vol-pct'); if (pct) pct.textContent = a.volume + '%';
        const mb = $('#vol-mute'); if (mb) mb.textContent = a.muted ? '🔇' : '🔊';
    } catch { btn.hidden = true; }
    // QOL — output device picker (headset / HDMI / speakers). Shown only when
    // there's actually a choice (>1 sink); simple buttons, no dropdown quirks.
    try {
        const s = await api.audio.sinks();
        const box = $('#vol-sinks');
        if (box) {
            if (s && s.ok && Array.isArray(s.sinks) && s.sinks.length > 1) {
                box.hidden = false;
                box.innerHTML = '<div class="dim" style="font-size:11px;margin:8px 0 4px;">Output device</div>'
                    + s.sinks.map((k) =>
                        `<button class="vol-sink-btn${k.current ? ' on' : ''}" data-sink="${_escapeHtml(k.name)}"`
                        + ` title="${_escapeHtml(k.label)}" aria-pressed="${k.current}">`
                        + `${k.current ? '● ' : '○ '}${_escapeHtml(k.label)}</button>`).join('');
            } else { box.hidden = true; box.innerHTML = ''; }
        }
    } catch { const box = $('#vol-sinks'); if (box) { box.hidden = true; } }
}
function toggleVolumePopover() {
    const pop = $('#volume-popover'); if (!pop) return;
    if (pop.hidden) { refreshVolumeUi(); pop.hidden = false; } else pop.hidden = true;
}

// Round-2 QOL — screenshots. PrtSc = full (1s delay so menus close, no pre-toast
// that'd be captured); Shift+PrtSc = drag-select a region. Saved to ~/Pictures.
async function takeScreenshot(mode) {
    if (mode === 'region') toast('Drag to select a region…');
    try {
        const r = await api.screenshot(mode);
        if (r && r.ok) toast('📷 Saved to Pictures: ' + (r.path || '').replace(/^.*\//, ''));
        else toast((r && r.error) || 'Screenshot failed.');
    } catch (e) { toast('Screenshot failed: ' + e.message); }
}
window.takeScreenshot = takeScreenshot;   // so System Core (or the AI) can trigger it

// QOL — screen recording (ffmpeg, video-only, saves to ~/Videos). One at a
// time; a red ⏺ REC pill in the topbar shows it's live and stops it on click.
function _setRecPill(on) {
    const p = document.querySelector('#rec-pill');
    if (p) p.hidden = !on;
}
async function toggleRecording() {
    try {
        const st = await api.record.status();
        if (!st || !st.supported) { toast('Screen recording runs on Outlaw OS.'); return; }
        if (st.recording) {
            const r = await api.record.stop();
            _setRecPill(false);
            toast(r && r.ok
                ? '🎥 Saved to Videos: ' + (r.path || '').replace(/^.*\//, '') + (r.sizeMb ? ` (${r.sizeMb} MB)` : '')
                : ((r && r.error) || 'Couldn\'t stop the recording.'));
        } else {
            if (!st.haveFfmpeg) { toast('Screen recording needs ffmpeg — install it from Apps (search "ffmpeg").'); return; }
            const r = await api.record.start();
            if (r && r.ok) { _setRecPill(true); toast('⏺ Recording the screen — click the red REC pill to stop.'); }
            else toast((r && r.error) || 'Couldn\'t start recording.');
        }
    } catch (e) { toast('Recording error: ' + ((e && e.message) || e)); }
}

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
            if (_batTick++ % 8 === 0) updateBattery();   // ~every 16s; first tick fires it
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
    if (res.suspend) { try { api.power.suspend(); } catch {} }
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
// Calculator (safe expression evaluator — no eval)
// ---------------------------------------------------------------------------
let calcExpr = '';
function calcRender() { $('#calc-display').value = calcExpr || '0'; }
function calcKey(k) {
    if (k === 'C') { calcExpr = ''; calcRender(); return; }
    if (k === '=') {
        try { calcExpr = String(safeEval(calcExpr)); }
        catch { calcExpr = ''; $('#calc-display').value = 'ERROR'; return; }
        calcRender(); return;
    }
    if ('+-*/.'.includes(k)) {
        if (!calcExpr && k !== '-') return;            // don't start with an operator (except minus)
        if (/[+\-*/.]$/.test(calcExpr)) calcExpr = calcExpr.slice(0, -1); // replace trailing operator
    }
    calcExpr += k;
    calcRender();
}
function safeEval(expr) {
    const tokens = (expr.match(/(\d+\.?\d*|\.\d+|[+\-*/()])/g) || []);
    if (tokens.join('') !== expr.replace(/\s+/g, '')) throw new Error('bad');
    // Shunting-yard to RPN
    const out = [], ops = [];
    const prec = { '+': 1, '-': 1, '*': 2, '/': 2, 'u-': 3 };
    let prev = null;
    for (const t of tokens) {
        if (/^[\d.]/.test(t)) { out.push(parseFloat(t)); }
        else if (t === '(') { ops.push(t); }
        else if (t === ')') { while (ops.length && ops[ops.length - 1] !== '(') out.push(ops.pop()); if (!ops.length) throw new Error('paren'); ops.pop(); }
        else {
            let op = t;
            if (t === '-' && (prev === null || prev === '(' || '+-*/'.includes(prev))) op = 'u-';
            while (ops.length && ops[ops.length - 1] !== '(' && prec[ops[ops.length - 1]] >= prec[op]) out.push(ops.pop());
            ops.push(op);
        }
        prev = t;
    }
    while (ops.length) { const o = ops.pop(); if (o === '(') throw new Error('paren'); out.push(o); }
    const st = [];
    for (const tk of out) {
        if (typeof tk === 'number') st.push(tk);
        else if (tk === 'u-') st.push(-st.pop());
        else { const b = st.pop(), a = st.pop(); if (a === undefined || b === undefined) throw new Error('expr');
            st.push(tk === '+' ? a + b : tk === '-' ? a - b : tk === '*' ? a * b : a / b); }
    }
    if (st.length !== 1 || !isFinite(st[0])) throw new Error('expr');
    return Math.round(st[0] * 1e10) / 1e10;
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

// --- Phase 9: session graphics/driver profiles ------------------------------
async function refreshDriversUi() {
    const gpuEl = $('#drv-gpu'), stEl = $('#drv-state');
    try {
        const d = await api.drivers.detect();
        if (gpuEl) gpuEl.textContent = (d && d.ok && d.vendor) ? d.vendor : 'unknown';
        if (stEl) stEl.textContent = (d && d.gaming_installed) ? 'gaming stack installed' : 'lean';
    } catch { if (gpuEl) gpuEl.textContent = '—'; }
    try {
        const p = await api.drivers.preview();
        const pv = $('#drv-preview');
        if (pv && p && p.ok && p.packages && p.packages.length) pv.textContent = p.packages.join(' ');
    } catch {}
}
async function _runDriverAction(kind) {
    // Gate behind the same re-auth as other important installs (no-op if no PIN).
    if (typeof requireImportantAuth === 'function' && !(await requireImportantAuth())) return;
    if (kind === 'apply') {
        // Long job → the streamed loading screen shows live phases + log.
        const btn = $('#drv-apply'); if (btn) btn.disabled = true;
        loadingScreen.open('Installing gaming graphics stack');
        try {
            const r = await api.drivers.apply();         // streams to the loading screen
            loadingScreen.done(!!(r && r.ok));           // belt-and-suspenders if the event was missed
            toast(r && r.ok ? 'Gaming graphics stack installed.' : 'Install failed — see the log.');
        } catch (e) { loadingScreen.done(false); toast('Error: ' + e.message); }
        if (btn) btn.disabled = false;
        refreshDriversUi();
        return;
    }
    // revert — quick, inline output
    const out = $('#drv-out'), btn = $('#drv-revert');
    if (out) out.textContent = 'Switching to the lean profile…';
    if (btn) btn.disabled = true;
    try {
        const r = await api.drivers.revert();
        if (out) out.textContent = r.ok ? ('Done — switched to lean.\n' + (r.output || '')) : ('Failed: ' + (r.error || 'unknown'));
        toast(r.ok ? 'Switched to lean profile.' : 'Revert failed.');
    } catch (e) { if (out) out.textContent = 'Error: ' + e.message; }
    if (btn) btn.disabled = false;
    refreshDriversUi();
}

// Custom dropdowns. Native <select> popups are a separate OS-level window that
// needs a window manager to stay open; in Outlaw's no-WM session they open and
// vanish instantly. We hide each <select> and drive it from an inline,
// DOM-only dropdown (no OS popup) — and dispatch a real 'change' event so all
// the existing select handlers keep working unchanged.
function enhanceSelects(root) {
    (root || document).querySelectorAll('select:not([data-enhanced])').forEach((sel) => {
        sel.dataset.enhanced = '1';
        sel.style.display = 'none';
        const wrap = document.createElement('div');
        wrap.className = 'cselect';
        wrap.style.minWidth = sel.style.minWidth || '160px';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cselect-btn';
        const list = document.createElement('div');
        list.className = 'cselect-list';
        list.hidden = true;

        const sync = () => {
            const o = sel.options[sel.selectedIndex];
            btn.textContent = o ? o.textContent : '';
            list.querySelectorAll('.cselect-opt').forEach((it) =>
                it.classList.toggle('active', it.dataset.value === sel.value));
        };
        [...sel.options].forEach((o) => {
            const item = document.createElement('div');
            item.className = 'cselect-opt';
            item.textContent = o.textContent;
            item.dataset.value = o.value;
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                sel.value = o.value;
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                sync();
                list.hidden = true; wrap.classList.remove('open');
            });
            list.appendChild(item);
        });
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const willOpen = list.hidden;
            document.querySelectorAll('.cselect.open').forEach((w) => {
                if (w !== wrap) { w.classList.remove('open'); w.querySelector('.cselect-list').hidden = true; }
            });
            list.hidden = !willOpen;
            wrap.classList.toggle('open', willOpen);
            if (willOpen) sync();
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
    $('#perf-toggle').checked = !!s.performanceMode;
    $('#update-repo').value = s.updateRepo || '';
    const chanEl = $('#update-channel');
    if (chanEl) chanEl.value = s.updateChannel || 'stable';
    $('#auto-check').checked = !!s.autoCheck;
    // P2 — stability reporting: label the current version + reflect any
    // prior local vote. The community tally is fetched lazily (button /
    // first Settings open) so there's zero network cost otherwise.
    _stabilityReports = s.stabilityReports || {};
    refreshStabilityUi();
    // SC5 — System Core voice toggle. Probe TTS engine availability in
    // parallel with reading the setting so the sub-text reflects reality
    // (e.g., "On · piper" vs "On · not installed").
    const voiceEl = $('#voice-toggle');
    if (voiceEl) {
        voiceEl.checked = !!s.coreVoiceEnabled;
        refreshVoiceSubText(!!s.coreVoiceEnabled);
    }
    // SC7 — VRAM saver mode dropdown.
    const vramEl = $('#vram-mode');
    if (vramEl) {
        vramEl.value = s.vramSaverMode || 'auto';
        refreshVramSubText();
    }
    // Tier-2 — seed the power-management selects + night-light warmth (the
    // idle watch itself lives in main and starts with the app).
    const alSel = $('#autolock-select');
    if (alSel) alSel.value = String(s.autoLockMin || 0);
    const asSel = $('#autosleep-select');
    if (asSel) asSel.value = String(s.autoSleepMin || 0);
    const sbSel = $('#screenblank-select');
    if (sbSel) sbSel.value = String(s.screenBlankMin == null ? -1 : s.screenBlankMin);
    const nlTempSel = $('#nightlight-temp');
    if (nlTempSel && s.nightLightTemp) nlTempSel.value = String(s.nightLightTemp);
}

async function refreshVramSubText() {
    const sub = $('#vram-mode-sub');
    if (!sub || !api.vram) return;
    try {
        const st = await api.vram.status();
        const lines = [];
        lines.push('Currently: ' + (st.label || st.tier));
        if (st.available && st.totalMb > 0) {
            lines.push(st.freeMb + ' / ' + st.totalMb + ' MB free');
        }
        sub.textContent = lines.join(' · ');
    } catch {
        sub.textContent = 'probe failed';
    }
}

async function refreshVoiceSubText(enabledHint) {
    const sub = $('#voice-sub');
    if (!sub || !api.tts) return;
    try {
        const st = await api.tts.status();
        const enabled = enabledHint != null ? !!enabledHint : !!st.enabled;
        if (!st.available) {
            sub.textContent = enabled
                ? 'On · ' + (st.note || 'no engine installed')
                : 'Off · ' + (st.note || 'no engine installed');
        } else if (enabled) {
            sub.textContent = 'On · speaking via ' + st.engine;
        } else {
            sub.textContent = 'Off · text-only bubble';
        }
    } catch {
        sub.textContent = 'Off · text-only bubble';
    }
}

async function setSetting(patch) { try { await api.settings.set(patch); } catch {} }

async function refreshGaming() {
    try {
        const g = await api.gaming.status();
        $('#gaming-status').textContent =
            `GPU ${g.gpu || 'unknown'}  •  GameMode ${g.gamemode ? 'available' : 'not installed'}  •  MangoHud ${g.mangohud ? 'available' : 'not installed'}`;
    } catch { $('#gaming-status').textContent = 'GPU info available on Outlaw OS.'; }
}

// ---------------------------------------------------------------------------
// Power / hotswap
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
async function hotswap() {
    closePower();
    const r = await api.power.hotswap();
    toast(r.ok ? 'Opening hotswap…' : (r.error || 'Hotswap unavailable.'));
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
        blurb: 'Six completed roadmaps — the OS core, the AI stack, and the desktop feature set.',
        items: [
            ['done', 'Product merge · Reliability · System Core · release & boot hardening · updates/channels'],
            ['done', 'Completeness & Polish — all 7 v2.1 phases: themes, apps-found, task manager, help + quickstart, reviewer, boot splash + pre-flight, driver profiles'],
            ['done', 'Dev session rebuild (Outlaw CodeMaker) + AI Assistant overhaul — Cr1tt3r + V4rm1nt, persistent chats, smart installer'],
            ['done', 'Three AI engines — built-in (default) / Ollama / LM Studio — incl. AMD + Intel GPU support'],
            ['done', 'Hardening & capability — safeguarded AI system control, updater overhaul, storage-as-RAM, background-AI notifications, AI personalities, offline mode, one combined error log'],
            ['done', 'Full-fledged desktop — sleep, notifications + history + Do Not Disturb, USB auto-mount, Bluetooth, time zone & keyboard layout, night light, auto-lock, screen-blank + sleep-when-idle'],
            ['done', 'Everyday polish — quick settings (☰), command palette (Ctrl+Space), calendar, recent apps, full keyboard access, high contrast, the Broken theme’s live faults'],
        ],
    },
    {
        title: 'Release readiness — the road to v2.1.0', tag: 'now', open: true,
        blurb: 'Test on real hardware, fix, repeat — until the bugs are gone, then v2.1.0.',
        items: [
            ['now', 'Real-hardware test passes over the new desktop features'],
            ['now', 'Boot crash-loops — diagnosing via the error log (Report a problem)'],
            ['now', 'Hotswap second-reboot'],
            ['plan', 'Display settings + screen brightness (need careful hardware testing — a wrong mode can blank a screen)'],
            ['plan', 'Scope calls — printing, multi-user accounts'],
        ],
    },
    {
        title: 'Post-1.0', tag: 'exp', open: false,
        blurb: 'The long-term direction once v2.1.0 is stable.',
        items: [
            ['exp', 'Publish your games — Steam / itch.io pipelines from CodeMaker'],
            ['exp', 'AI builds more of the game — templates, playtest-fix loop, asset generation'],
            ['exp', 'Runs anywhere — model auto-management, Lite edition, backups, translations'],
            ['exp', 'Smarter AI — Godot-docs retrieval, multi-agent, learns your style'],
            ['exp', 'Reliability — boot CI, recovery shell, crash reporting'],
            ['exp', 'Slow-but-light AI · self-update service (feasibility)'],
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
        const calcBtn = e.target.closest('#calc-pad [data-k]');
        if (calcBtn) { calcKey(calcBtn.dataset.k); return; }

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
            case 'hotswap': hotswap(); break;
            case 'power-menu': openPower(); break;
            case 'power-cancel': closePower(); break;
            case 'lock': lockNow(); break;
            case 'reboot': closePower(); api.power.reboot(); break;
            case 'shutdown': closePower(); api.power.shutdown(); break;
            case 'sleep': closePower(); api.power.suspend().then((r) => { if (r && r.ok === false) toast('Sleep failed: ' + (r.error || 'try again')); }).catch(() => {}); break;
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
    $('#perf-toggle').addEventListener('change', async (e) => { await api.gaming.setPerformance(e.target.checked); toast('Performance mode ' + (e.target.checked ? 'ON' : 'OFF')); });
    // SC7 — Aggressive VRAM saver dropdown. setMode immediately invalidates
    // the probe cache + fires the tier-changed event, so the System Core
    // badge updates in the same beat the user picks a new mode.
    const vramModeEl = $('#vram-mode');
    if (vramModeEl) {
        vramModeEl.addEventListener('change', async (e) => {
            const mode = e.target.value;
            try {
                const r = await api.vram.setMode(mode);
                if (!r.ok) {
                    toast('VRAM mode change failed: ' + (r.error || 'unknown'));
                    return;
                }
                await refreshVramSubText();
                if (window.outlawCore && window.outlawCore.refreshVramTier) {
                    window.outlawCore.refreshVramTier();
                }
                toast('VRAM saver: ' + (r.status && r.status.label || mode));
            } catch (err) {
                toast('VRAM mode error: ' + err.message);
            }
        });
    }

    // SC5 — System Core voice toggle. Persist the setting, then re-probe TTS
    // status so the sub-text and the System Core footer both catch up without
    // requiring a screen revisit.
    const voiceToggleEl = $('#voice-toggle');
    if (voiceToggleEl) {
        voiceToggleEl.addEventListener('change', async (e) => {
            const on = !!e.target.checked;
            await setSetting({ coreVoiceEnabled: on });
            refreshVoiceSubText(on);
            // Force re-probe the engine in case the user just installed one
            // (caches were valid for up to 30s otherwise).
            try { await api.tts.status({ force: true }); } catch {}
            if (window.outlawCore && window.outlawCore.refreshVoiceStatus) {
                window.outlawCore.refreshVoiceStatus();
            }
            // Friendly nudge if they toggled on but no engine is installed.
            try {
                const st = await api.tts.status();
                if (on && !st.available) {
                    toast('Voice toggle on, but no TTS engine installed (piper / espeak-ng).');
                } else if (on) {
                    toast('Core voice on — speaking via ' + st.engine + '.');
                } else {
                    toast('Core voice off.');
                }
            } catch {}
        });
    }

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

    // Phase 14d: AI setup guide — purpose-aware (dev vs desktop) recommendation.
    const aiPurpose = $('#ai-purpose');
    const aiTierWrap = $('#ai-tier-wrap');
    const aiSpillWrap = $('#ai-spill-wrap');
    const syncAiPurposeUi = () => {
        const dev = aiPurpose && aiPurpose.value === 'dev';
        if (aiTierWrap) aiTierWrap.style.display = dev ? 'none' : '';
        if (aiSpillWrap) aiSpillWrap.style.display = dev ? 'inline-flex' : 'none';
    };
    if (aiPurpose) { aiPurpose.addEventListener('change', syncAiPurposeUi); syncAiPurposeUi(); }

    const checkPcBtn = $('#ai-check-pc');
    if (checkPcBtn) {
        checkPcBtn.addEventListener('click', async () => {
            const out = $('#ai-setup-result');
            if (out) out.innerHTML = '<span class="muted">Reading your hardware…</span>';
            const opts = {
                purpose: aiPurpose ? aiPurpose.value : 'desktop',
                tier: ($('#ai-tier') || {}).value || 'powerful',
                spill: !!($('#ai-spill') && $('#ai-spill').checked),
            };
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
    const drvApplyBtn = $('#drv-apply');
    if (drvApplyBtn) drvApplyBtn.addEventListener('click', () => _runDriverAction('apply'));
    const drvRevertBtn = $('#drv-revert');
    if (drvRevertBtn) drvRevertBtn.addEventListener('click', () => _runDriverAction('revert'));

    // Phase 12: loading screen close button (enabled once a job finishes).
    const lsClose = $('#ls-close');
    if (lsClose) lsClose.addEventListener('click', () => loadingScreen.hide());

    // Session preference reset — flips ~/.outlaw-session-pref back to "ask"
    // so the greeter shows again on next boot.
    const sessResetBtn = $('#session-reset-pref');
    if (sessResetBtn) {
        sessResetBtn.addEventListener('click', async () => {
            try {
                const r = await api.session.resetGreeterPref();
                toast(r.ok ? 'Greeter will show on next boot.' : ('Reset failed: ' + (r.error || 'unknown')));
            } catch (err) {
                toast('Reset failed: ' + err.message);
            }
        });
    }

    // Session switcher: jump straight from the desktop into a Dev session.
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

    const sessSwitchBtn = $('#session-switch-dev');
    if (sessSwitchBtn) {
        sessSwitchBtn.addEventListener('click', async () => {
            // Live demo: the Dev session needs the fully-installed system. Don't
            // offer to download a dev env into the ephemeral live overlay — just
            // tell the user to install first.
            if (_isLive) {
                window.alert(
                    "The Dev session isn't available in the live demo.\n\n" +
                    "Outlaw CodeMaker needs the full system. Install Outlaw OS to your " +
                    "disk first (click “Install Outlaw OS” on the desktop), then come " +
                    "back and switch to the Dev session.\n\n" +
                    "The live environment is a limited preview — install to unlock everything.",
                );
                return;
            }
            sessSwitchBtn.disabled = true;
            // First check the Dev session can actually run here. On a freshly
            // installed system where the dev env didn't build, CodeMaker's Python
            // deps may be missing — switching would just bounce back to the
            // desktop. Offer to download + build them instead of failing.
            let ready = true;
            try { const s = await api.session.devStatus(); ready = !!(s && s.ready); } catch { ready = true; }
            if (!ready) {
                const setup = window.confirm(
                    "The Dev session isn't set up on this machine yet.\n\n" +
                    "Outlaw CodeMaker needs Python and its dependencies (PyQt6, etc.). " +
                    "Download and build them now? This opens a terminal and needs an " +
                    "internet connection — a few minutes. When it finishes, click " +
                    "'Switch to Dev session' again.",
                );
                if (setup) {
                    try { await api.session.setupDev(); toast('Setting up the Dev session in a terminal — switch again once it finishes.'); }
                    catch (err) { toast('Could not start setup: ' + err.message); }
                }
                sessSwitchBtn.disabled = false;
                return;
            }
            const ok = window.confirm(
                'Switch to the Dev session now?\n\n' +
                'This closes the desktop and opens Outlaw CodeMaker. ' +
                'The screen will go black for a few seconds while X restarts.',
            );
            if (!ok) { sessSwitchBtn.disabled = false; return; }
            toast('Switching to Dev session…');
            try {
                const r = await api.session.switchToDev();
                if (!r.ok) {
                    toast('Could not switch: ' + (r.error || 'unknown error'));
                    sessSwitchBtn.disabled = false;
                }
                // On success the main process closes the window — nothing more to do.
            } catch (err) {
                toast('Switch failed: ' + err.message);
                sessSwitchBtn.disabled = false;
            }
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
    // Tier-1 — Region & Input (keyboard layout, time zone, NTP).
    const kbSel = $('#kb-layout');
    if (kbSel) kbSel.addEventListener('change', async () => {
        const r = await api.kb.set(kbSel.value);
        _regionMsg(r && r.ok ? 'Keyboard layout applied.' : ('Couldn\'t set layout' + (r && r.error ? ': ' + r.error : '.')));
    });
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
    // Tier-1 — Bluetooth (power toggle + open the pairing manager).
    const btTog = $('#bt-toggle');
    if (btTog) btTog.addEventListener('change', async () => {
        btTog.disabled = true;
        try { await api.bt.power(btTog.checked); } catch {}
        btTog.disabled = false; refreshBtUi();
    });
    const btMng = $('#bt-manage-btn');
    if (btMng) btMng.addEventListener('click', async () => {
        const r = await api.bt.manage();
        if (!r || !r.ok) toast(r && r.error ? r.error : 'Couldn\'t open the Bluetooth manager.');
        else toast('Opening the Bluetooth manager…');
    });
    // Tier-2 — Night light (warm the screen) + warmth level.
    const nlTog = $('#nightlight-toggle');
    const nlTemp = $('#nightlight-temp');
    const nlRow = $('#nightlight-warmth-row');
    const applyNl = async (on) => {
        const temp = nlTemp ? parseInt(nlTemp.value, 10) || 4000 : 4000;
        const r = await api.nightlight.set({ on, temp });
        if (nlRow) nlRow.style.display = on ? '' : 'none';
        if (!r || !r.ok) {
            if (nlTog) nlTog.checked = false;
            if (nlRow) nlRow.style.display = 'none';
            _desktopMsg(r && r.error ? r.error : 'Couldn\'t change night light.');
        } else {
            _desktopMsg(on ? 'Night light on.' : 'Night light off.');
        }
    };
    if (nlTog) nlTog.addEventListener('change', () => applyNl(nlTog.checked));
    if (nlTemp) nlTemp.addEventListener('change', () => { if (nlTog && nlTog.checked) applyNl(true); });
    // Tier-2 — Do Not Disturb + re-show the last notification.
    const dndTog = $('#dnd-toggle');
    if (dndTog) dndTog.addEventListener('change', async () => {
        const r = await api.notif.dndSet(dndTog.checked);
        if (!r || !r.ok) { dndTog.checked = !dndTog.checked; _desktopMsg(r && r.error ? r.error : 'Couldn\'t change Do Not Disturb.'); }
        else _desktopMsg(dndTog.checked ? 'Do Not Disturb on.' : 'Do Not Disturb off.');
    });
    const dndLast = $('#dnd-show-last');
    if (dndLast) dndLast.addEventListener('click', async () => { try { await api.notif.showLast(); } catch {} });
    const nhBtn = $('#notif-history-btn');
    if (nhBtn) nhBtn.addEventListener('click', renderNotifHistory);
    // Display settings — apply (delegated), keep/revert, reset, brightness.
    { const dbox = $('#display-outputs'); if (dbox) dbox.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-disp-apply]'); if (!btn) return;
        const name = btn.dataset.dispApply;
        const sel = dbox.querySelector(`select[data-disp-out="${CSS.escape(name)}"]`);
        if (!sel || !sel.value) return;
        const [mode, rate] = sel.value.split('|');
        btn.disabled = true;
        try {
            const r = await api.display.setMode({ output: name, mode, rate });
            if (!r || !r.ok) _dispMsg((r && r.error) || 'Couldn\'t apply that mode.');
            else openDispConfirm({ output: name, mode, rate });
        } catch (err) { _dispMsg('Error: ' + ((err && err.message) || err)); }
        btn.disabled = false;
    }); }
    { const k = $('#disp-keep'); if (k) k.addEventListener('click', async () => {
        try { await api.display.confirmMode(_dispPending || {}); } catch {}
        _closeDispConfirm(); _dispMsg('Display settings kept — they\'ll be restored on every boot.');
        refreshDisplayUi();
    }); }
    { const rv = $('#disp-revert'); if (rv) rv.addEventListener('click', async () => {
        try { await api.display.revertMode(); } catch {}
        _closeDispConfirm(); _dispMsg('Reverted to the previous mode.');
        refreshDisplayUi();
    }); }
    { const dr = $('#display-reset'); if (dr) dr.addEventListener('click', async () => {
        dr.disabled = true;
        try {
            const r = await api.display.resetAuto();
            _dispMsg(r && r.ok ? 'Every display is back on its native mode.' : ((r && r.error) || 'Reset failed.'));
        } catch {}
        dr.disabled = false;
        refreshDisplayUi();
    }); }
    { const bs = $('#brightness-slider'); if (bs) bs.addEventListener('input', async (e) => {
        try {
            const r = await api.display.setBrightness(parseInt(e.target.value, 10));
            if (r && !r.ok && r.error) _dispMsg(r.error);
        } catch {}
    }); }
    { const sl = $('#qk-bright'); if (sl) sl.addEventListener('input', async (e) => {
        const v = parseInt(e.target.value, 10) || 5;
        const pct = $('#qk-bright-pct'); if (pct) pct.textContent = v + '%';
        try { await api.display.setBrightness(v); } catch {}
    }); }
    // Tier-2 — power management. Persisting the setting is enough: main's
    // settings:set hook re-syncs the idle watch / X blanking immediately.
    const alSel = $('#autolock-select');
    if (alSel) alSel.addEventListener('change', () => setSetting({ autoLockMin: parseInt(alSel.value, 10) || 0 }));
    const asSel = $('#autosleep-select');
    if (asSel) asSel.addEventListener('change', () => setSetting({ autoSleepMin: parseInt(asSel.value, 10) || 0 }));
    const sbSel = $('#screenblank-select');
    if (sbSel) sbSel.addEventListener('change', () => {
        const v = parseInt(sbSel.value, 10);
        setSetting({ screenBlankMin: Number.isFinite(v) ? v : -1 });
    });
    // Main's system-wide idle watch says it's time to lock.
    api.on('idle-lock', onIdleLock);
    // QoL — Settings search/filter.
    const setSearch = $('#settings-search');
    if (setSearch) setSearch.addEventListener('input', (e) => filterSettings(e.target.value));
    // Round-2 QOL — volume popover.
    { const sv = $('#stat-volume'); if (sv) sv.addEventListener('click', toggleVolumePopover); }
    { const sl = $('#vol-slider'); if (sl) sl.addEventListener('input', async (e) => {
        const v = parseInt(e.target.value, 10) || 0;
        const pct = $('#vol-pct'); if (pct) pct.textContent = v + '%';
        _setVolIcon(v, false);
        try { await api.audio.set(v); } catch {}
    }); }
    { const mb = $('#vol-mute'); if (mb) mb.addEventListener('click', async () => { try { await api.audio.toggleMute(); } catch {} refreshVolumeUi(); }); }
    // QOL — output-device buttons in the volume popover (delegated once).
    { const vs = $('#vol-sinks'); if (vs) vs.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-sink]'); if (!b) return;
        b.disabled = true;
        try {
            const r = await api.audio.setSink(b.dataset.sink);
            if (!r || !r.ok) toast((r && r.error) || 'Couldn\'t switch the output device.');
        } catch {}
        refreshVolumeUi();
    }); }
    // QOL — screen recording: quick-settings button + the topbar REC pill.
    { const b = $('#qk-record'); if (b) b.addEventListener('click', () => { closeQuickPopover(); toggleRecording(); }); }
    { const p = $('#rec-pill'); if (p) p.addEventListener('click', toggleRecording); }
    document.addEventListener('click', (e) => {
        const pop = $('#volume-popover');
        if (!pop || pop.hidden) return;
        if (e.target.closest('#volume-popover') || e.target.closest('#stat-volume')) return;
        pop.hidden = true;
    });
    // QOL batch — quick-settings popover (topbar ☰).
    { const qt = $('#quick-toggle'); if (qt) qt.addEventListener('click', toggleQuickPopover); }
    const _qkToggle = (sel, doSet) => {
        const b = $(sel);
        if (!b) return;
        b.addEventListener('click', async () => {
            const next = !_qkOn(sel);
            b.disabled = true;
            try { await doSet(next); } catch {}
            b.disabled = false;
        });
    };
    _qkToggle('#qk-nightlight', async (on) => {
        const r = await api.nightlight.set({ on });
        if (r && r.ok) { _qkSet('#qk-nightlight', on); refreshDesktopUi(); }
        else toast((r && r.error) || 'Couldn\'t change night light.');
    });
    _qkToggle('#qk-dnd', async (on) => {
        const r = await api.notif.dndSet(on);
        if (r && r.ok) { _qkSet('#qk-dnd', on); refreshDesktopUi(); }
        else toast((r && r.error) || 'Couldn\'t change Do Not Disturb.');
    });
    _qkToggle('#qk-airplane', async (on) => {
        const r = await api.net.setAirplane(on);
        if (r && r.ok) _qkSet('#qk-airplane', on);
        else toast('Couldn\'t change airplane mode' + (r && r.error ? ': ' + r.error.slice(0, 80) : '.'));
        refreshAirplane();   // keep the Settings toggle + offline pill in sync either way
    });
    _qkToggle('#qk-perf', async (on) => {
        await api.gaming.setPerformance(on);
        _qkSet('#qk-perf', on);
        const pt = $('#perf-toggle'); if (pt) pt.checked = on;
        toast('Performance mode ' + (on ? 'ON' : 'OFF'));
    });
    { const sl = $('#qk-vol'); if (sl) sl.addEventListener('input', async (e) => {
        const v = parseInt(e.target.value, 10) || 0;
        const pct = $('#qk-vol-pct'); if (pct) pct.textContent = v + '%';
        _setVolIcon(v, false);
        try { await api.audio.set(v); } catch {}
    }); }
    { const b = $('#qk-screenshot'); if (b) b.addEventListener('click', () => { closeQuickPopover(); takeScreenshot('full'); }); }
    { const b = $('#qk-lock'); if (b) b.addEventListener('click', () => { closeQuickPopover(); lockNow(); }); }
    { const b = $('#qk-sleep'); if (b) b.addEventListener('click', () => {
        closeQuickPopover();
        api.power.suspend().then((r) => { if (r && r.ok === false) toast('Sleep failed: ' + (r.error || 'try again')); }).catch(() => {});
    }); }
    { const b = $('#qk-settings'); if (b) b.addEventListener('click', () => { closeQuickPopover(); showScreen('settings'); }); }
    document.addEventListener('click', (e) => {
        const pop = $('#quick-popover');
        if (!pop || pop.hidden) return;
        if (e.target.closest('#quick-popover') || e.target.closest('#quick-toggle')) return;
        closeQuickPopover();
    });
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
            // Display keep/revert dialog first: Esc = revert (the safe choice).
            const dc = $('#disp-confirm');
            if (dc && dc.classList.contains('show')) {
                const rv = $('#disp-revert'); if (rv) rv.click();
                e.stopImmediatePropagation(); return;
            }
            const pal = $('#palette'); if (pal && !pal.hidden) { closePalette(); e.stopImmediatePropagation(); return; }
            const qp = $('#quick-popover'); if (qp && !qp.hidden) { closeQuickPopover(); e.stopImmediatePropagation(); return; }
            const cp = $('#cal-popover'); if (cp && !cp.hidden) { closeCalPopover(); e.stopImmediatePropagation(); return; }
            const vp = $('#volume-popover'); if (vp && !vp.hidden) { vp.hidden = true; e.stopImmediatePropagation(); return; }
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
        // Round-2 QOL — PrtSc = full screenshot, Shift+PrtSc = drag-select a region.
        if (e.key === 'PrintScreen') { e.preventDefault(); takeScreenshot(e.shiftKey ? 'region' : 'full'); return; }
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
        // keypress would ALSO close the power menu, cancel a pending confirm
        // dialog, and wipe the calculator behind them.
        const _escSurfaceOpen = ['#palette', '#quick-popover', '#cal-popover', '#volume-popover']
            .some((s) => { const el = $(s); return el && !el.hidden; })
            || (($('#loadscreen') || {}).classList || { contains: () => false }).contains('show')
            || (($('#disp-confirm') || {}).classList || { contains: () => false }).contains('show');
        if (e.key === 'Escape' && !_escSurfaceOpen) { closePower(); if (confirmResolver) closeConfirm(false); }
        if ($('#screen-calc').classList.contains('active') && $('#app').classList.contains('ready')) {
            // Don't drive the calculator while the user is typing in a text
            // field (e.g. the command palette opened over the Calculator screen)
            // or dismissing an overlay with Esc.
            const ae = document.activeElement;
            if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
            if (_escSurfaceOpen && e.key === 'Escape') return;
            if (/[0-9.+\-*/]/.test(e.key)) calcKey(e.key);
            else if (e.key === 'Enter' || e.key === '=') calcKey('=');
            else if (e.key === 'Escape' || e.key.toLowerCase() === 'c') calcKey('C');
        }
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
    refreshVolumeUi().catch(() => {});    // QoL — show the volume control if audio is present
    wireAuth();
    calcRender();
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
    const reason = 'Locked in the live demo — install Outlaw OS to unlock this.';
    // Controls that don't make sense on a throwaway live system.
    ['#perf-toggle', '#qk-perf'].forEach((sel) => {
        const el = $(sel); if (el) { el.disabled = true; el.title = reason; }
    });
    const dev = $('#session-switch-dev');
    if (dev) dev.title = 'Install Outlaw OS first to use the Dev session.';
}
