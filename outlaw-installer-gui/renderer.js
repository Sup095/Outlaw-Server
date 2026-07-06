// ============================================================================
// Outlaw OS installer GUI — renderer (wizard logic).
// Plain DOM, no frameworks. All privileged work happens in main via the
// `installer` bridge; this file only collects choices and renders progress.
// ============================================================================
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
    probe: null,        // result of installer.probe()
    mode: '',           // 'alongside' | 'wipe'
    disk: null,         // chosen disk object
    source: '',         // 'free' | 'shrink'
    shrinkPart: null,   // chosen shrink candidate
    gib: 32,
    username: '',
    password: '',
};

function show(stepId) {
    $$('.step').forEach((s) => s.classList.toggle('active', s.id === stepId));
    window.scrollTo(0, 0);
}

function fmtGib(mib) { return Math.floor(mib / 1024); }
function esc(s) {
    return String(s || '').replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// 0 · Welcome — env + connectivity check (non-blocking, retryable)
// ---------------------------------------------------------------------------
async function checkOnline() {
    try {
        const r = await window.installer.online();
        const online = !!(r && r.online);
        $('#net-warn').hidden = online;
        $('#net-ok').hidden = !online;
        if (online) $('#wifi-area').hidden = true;
        return online;
    } catch {
        $('#net-warn').hidden = false;
        $('#net-ok').hidden = true;
        return false;
    }
}

$('#net-retry').addEventListener('click', checkOnline);
$('#btn-exit').addEventListener('click', () => window.installer.quit());

// --- Wi-Fi from inside the wizard (being offline silently was the root cause
// --- of a string of failed installs — fix it where the user discovers it).
$('#wifi-show').addEventListener('click', scanWifi);

async function scanWifi() {
    const area = $('#wifi-area');
    area.hidden = false;
    area.innerHTML = '<div class="dim">Scanning for networks (a few seconds)…</div>';
    let r;
    try { r = await window.installer.wifiList(); }
    catch (e) { r = { ok: false, error: e.message }; }
    if (!r.ok || !r.networks || !r.networks.length) {
        area.innerHTML = `<div class="dim">${esc(r.error || 'No Wi-Fi networks found. A network cable works automatically when plugged in.')}</div>`;
        return;
    }
    area.innerHTML = '';
    for (const n of r.networks) {
        const bars = n.signal >= 70 ? '▂▄▆█' : n.signal >= 45 ? '▂▄▆' : n.signal >= 20 ? '▂▄' : '▂';
        const row = document.createElement('div');
        row.className = 'wifi-row';
        row.innerHTML =
            `<span class="wifi-name">${n.inUse ? '✔ ' : ''}${esc(n.ssid)}</span>` +
            `<span class="wifi-meta">${n.security ? '🔒' : 'open'} ${bars}</span>` +
            `<button class="wifi-join" ${n.inUse ? 'disabled' : ''}>${n.inUse ? 'Connected' : 'Connect'}</button>`;
        row.querySelector('.wifi-join').addEventListener('click', () => {
            area.querySelectorAll('.wifi-pwform').forEach((f) => f.remove());
            if (!n.security) { joinWifi(n.ssid, '', row); return; }
            const form = document.createElement('div');
            form.className = 'wifi-pwform';
            form.innerHTML =
                `<input type="password" placeholder="Password for ${esc(n.ssid)}" autocomplete="off">` +
                `<button class="primary">Join</button>`;
            row.after(form);
            const input = form.querySelector('input');
            const go = () => { if (input.value) joinWifi(n.ssid, input.value, row, form); };
            form.querySelector('button').addEventListener('click', go);
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
            input.focus();
        });
        area.appendChild(row);
    }
}

async function joinWifi(ssid, password, row, form) {
    const btn = row.querySelector('.wifi-join');
    btn.disabled = true; btn.textContent = 'Connecting…';
    let r;
    try { r = await window.installer.wifiConnect(ssid, password); }
    catch (e) { r = { ok: false, error: e.message }; }
    if (r.ok) {
        if (form) form.remove();
        btn.textContent = 'Connected';
        await checkOnline();   // flips the warning to the green "looks good" box
    } else {
        btn.disabled = false; btn.textContent = 'Connect';
        if (form) {
            const input = form.querySelector('input');
            input.value = ''; input.placeholder = (r.error || 'Failed — try again').slice(0, 80);
            input.focus();
        }
    }
}

$('#btn-start').addEventListener('click', async () => {
    const env = await window.installer.env();
    if (!env.linux || !env.root) {
        $('#done-title').textContent = '⚠ Wrong environment';
        $('#done-msg').textContent = 'The installer must run from the Outlaw OS live USB.';
        $('#btn-reboot').hidden = true; $('#btn-again').hidden = true;
        show('step-done');
        return;
    }
    show('step-mode');
});

// ---------------------------------------------------------------------------
// 1 · Mode
// ---------------------------------------------------------------------------
$$('#step-mode .card').forEach((c) => c.addEventListener('click', async () => {
    state.mode = c.dataset.mode;
    $('#disk-title').textContent = state.mode === 'wipe'
        ? 'Which disk should be ERASED?' : 'Where should Outlaw live?';
    $('#disk-sub').textContent = state.mode === 'wipe'
        ? 'Everything on the chosen disk will be deleted. The live USB is hidden for safety.'
        : 'Pick the disk that has your other OS (or free space). Nothing is changed yet.';
    $('#disk-list').innerHTML = '<div class="dim">Scanning disks…</div>';
    show('step-disk');
    await loadDisks();
}));

$$('[data-back]').forEach((b) => b.addEventListener('click', () => show(b.dataset.back)));

// ---------------------------------------------------------------------------
// 2 · Disk
// ---------------------------------------------------------------------------
async function loadDisks() {
    const p = await window.installer.probe();
    if (p.error) {
        $('#disk-list').innerHTML = `<div class="warnbox">⚠ ${esc(p.error)}</div>`;
        return;
    }
    state.probe = p;
    const list = $('#disk-list');
    list.innerHTML = '';
    const usable = (p.disks || []).filter((d) => d.path !== p.liveUsb && d.sizeMib >= 9 * 1024);
    if (!usable.length) {
        list.innerHTML = '<div class="warnbox">⚠ No usable disks found (the live USB doesn\'t count). ' +
            'Check that the computer\'s drive is connected and detected by the BIOS.</div>';
        return;
    }
    for (const d of usable) {
        const partsTxt = (d.parts || []).slice(0, 5)
            .map((q) => `${esc(q.label || q.fstype || 'partition')} ${fmtGib(q.sizeMib)}G`)
            .join(' · ') || 'empty disk';
        const winBadge = (d.parts || []).some((q) => q.fstype === 'ntfs')
            ? '<span class="tag">has Windows files</span>' : '';
        const freeTxt = d.freeMib >= 8 * 1024
            ? `<span class="ok">${fmtGib(d.freeMib)} GiB free space</span>` : '';
        const btn = document.createElement('button');
        btn.className = 'card';
        btn.innerHTML =
            `<div class="card-title">💽 ${esc(d.path)} — ${fmtGib(d.sizeMib)} GiB ${winBadge}</div>` +
            `<div class="card-desc">${esc(d.model || 'disk')}<br>${partsTxt}<br>${freeTxt}</div>`;
        btn.addEventListener('click', () => pickDisk(d));
        list.appendChild(btn);
    }
}

function pickDisk(d) {
    state.disk = d;
    if (state.mode === 'wipe') { show('step-account'); return; }

    // Alongside: EFI machines need an ESP on this disk (we never create a 2nd
    // one next to Windows). Erase mode creates its own, so only check here.
    if (state.probe.efi && !d.esp) {
        alert('This computer boots in EFI mode, but that disk has no EFI System Partition.\n\n' +
              'Pick the disk your current OS boots from, or use "Erase this computer" instead.');
        return;
    }
    const freeGib = fmtGib(d.freeMib);
    if (freeGib >= 16) {
        state.source = 'free';
        $('#space-free').hidden = false; $('#space-shrink').hidden = true;
        $('#free-gib').textContent = String(freeGib);
        setSizeBounds(16, freeGib, Math.min(Math.max(32, 16), freeGib));
        show('step-space');
        return;
    }
    const cands = (d.shrink || []).filter((s) => s.maxTakeGib >= 16);
    if (!cands.length) {
        alert('That disk has no free space, and no partition can spare 16+ GiB.\n\n' +
              (freeGib >= 8 ? 'Tip: there are ' + freeGib + ' GiB free — Outlaw needs at least 16 GiB to be comfortable.\n\n' : '') +
              'If this is a Windows disk: boot Windows, disable Fast Startup, run "chkdsk /f", ' +
              'shut down fully (don\'t restart), then run this installer again.');
        return;
    }
    state.source = 'shrink';
    $('#space-free').hidden = true; $('#space-shrink').hidden = false;
    const sl = $('#shrink-list');
    sl.innerHTML = '';
    cands.forEach((c, i) => {
        const btn = document.createElement('button');
        btn.className = 'card';
        btn.innerHTML =
            `<div class="card-title">📦 ${esc(c.part)} <span class="tag">${esc(c.fstype)}</span></div>` +
            `<div class="card-desc">${fmtGib(c.sizeMib)} GiB now — can spare up to <b>${c.maxTakeGib} GiB</b></div>`;
        btn.addEventListener('click', () => {
            state.shrinkPart = c;
            $$('#shrink-list .card').forEach((x) => x.classList.remove('sel'));
            btn.classList.add('sel');
            setSizeBounds(16, c.maxTakeGib, Math.min(32, c.maxTakeGib));
        });
        sl.appendChild(btn);
        if (i === 0) btn.click(); // sensible default
    });
    show('step-space');
}

// ---------------------------------------------------------------------------
// 3 · Space
// ---------------------------------------------------------------------------
function setSizeBounds(min, max, val) {
    for (const el of [$('#size-slider'), $('#size-gib')]) {
        el.min = String(min); el.max = String(max); el.value = String(val);
    }
    state.gib = val;
}
$('#size-slider').addEventListener('input', (e) => { $('#size-gib').value = e.target.value; state.gib = +e.target.value; });
$('#size-gib').addEventListener('input', (e) => { $('#size-slider').value = e.target.value; state.gib = +e.target.value; });

$('#btn-space-next').addEventListener('click', () => {
    const min = +$('#size-gib').min, max = +$('#size-gib').max;
    let v = Math.floor(+$('#size-gib').value || 0);
    if (v < min) v = min;
    if (v > max) v = max;
    setSizeBounds(min, max, v);
    show('step-account');
});

// ---------------------------------------------------------------------------
// 4 · Account
// ---------------------------------------------------------------------------
$('#btn-account-back').addEventListener('click', () =>
    show(state.mode === 'wipe' ? 'step-disk' : 'step-space'));

function validateAccount() {
    const u = $('#acc-user').value.trim();
    const p1 = $('#acc-pw1').value, p2 = $('#acc-pw2').value;
    const userOk = /^[a-z_][a-z0-9_-]*$/.test(u);
    $('#user-msg').className = userOk || !u ? 'dim' : 'bad';
    const pwOk = p1.length > 0 && p1 === p2;
    $('#pw-msg').className = (p2 && !pwOk) ? 'bad' : 'dim';
    $('#pw-msg').textContent = (p2 && p1 !== p2) ? 'Passwords don\'t match yet.'
        : 'Used to log in and for admin (sudo) actions.';
    return userOk && pwOk ? { u, p1 } : null;
}
['acc-user', 'acc-pw1', 'acc-pw2'].forEach((id) =>
    $('#' + id).addEventListener('input', validateAccount));

$('#btn-account-next').addEventListener('click', () => {
    const v = validateAccount();
    if (!v) { alert('Fix the username/password fields first (red hints show what\'s wrong).'); return; }
    state.username = v.u; state.password = v.p1;
    buildPlan();
    show('step-confirm');
});

// ---------------------------------------------------------------------------
// 5 · Confirm
// ---------------------------------------------------------------------------
function buildPlan() {
    const li = [];
    const word = state.mode === 'wipe' ? 'ERASE' : 'INSTALL';
    if (state.mode === 'wipe') {
        li.push(`🧨 <b>Erase everything</b> on <b>${esc(state.disk.path)}</b> (${fmtGib(state.disk.sizeMib)} GiB).`);
        li.push('💽 Outlaw OS becomes the only operating system on that disk.');
        $('#confirm-warn').innerHTML = '⚠ <b>This deletes all files on that disk permanently.</b> Make sure nothing you need is on it.';
    } else if (state.source === 'free') {
        li.push(`🛡 Keep all existing partitions on <b>${esc(state.disk.path)}</b> untouched.`);
        li.push(`📦 Create a new <b>${state.gib} GiB</b> partition in the free space for Outlaw OS.`);
        $('#confirm-warn').innerHTML = '✅ Your other OS and files are not modified.';
    } else {
        li.push(`🛡 Keep your files on <b>${esc(state.shrinkPart.part)}</b> — the partition is shrunk by <b>${state.gib} GiB</b> (files intact, partition smaller).`);
        li.push(`📦 Install Outlaw OS into the freed ${state.gib} GiB on <b>${esc(state.disk.path)}</b>.`);
        $('#confirm-warn').innerHTML = '⚠ Shrinking is checked read-only first and refuses unsafe disks. ' +
            'If it\'s a Windows partition, Windows will run a quick disk check on its next boot (normal). ' +
            'A power cut during resize can corrupt the partition — keep the machine plugged in.';
    }
    li.push(`👤 Account: <b>${esc(state.username)}</b> (your password also unlocks admin actions).`);
    li.push('🧭 A boot menu will list Outlaw OS and any other OS each time you start the computer.');
    $('#plan').innerHTML = li.map((x) => `<li>${x}</li>`).join('');
    $('#confirm-word').textContent = word;
    $('#confirm-input').value = '';
    $('#btn-go').disabled = true;
}
$('#confirm-input').addEventListener('input', (e) => {
    $('#btn-go').disabled = e.target.value.trim() !== $('#confirm-word').textContent;
});

$('#btn-go').addEventListener('click', async () => {
    $('#btn-go').disabled = true;
    // Hide stages that don't apply to this run.
    $('[data-stage="shrink"]').style.display = (state.source === 'shrink' && state.mode !== 'wipe') ? '' : 'none';
    $('#log').textContent = '';
    $$('#stages li').forEach((li) => li.classList.remove('on', 'done'));
    show('step-progress');
    const opts = state.mode === 'wipe'
        ? { mode: 'wipe', disk: state.disk.path, username: state.username, password: state.password }
        : state.source === 'free'
            ? { mode: 'free', disk: state.disk.path, gib: state.gib, username: state.username, password: state.password }
            : { mode: 'shrink', part: state.shrinkPart.part, gib: state.gib, username: state.username, password: state.password };
    const r = await window.installer.start(opts);
    if (!r.ok) {
        $('#done-title').textContent = '❌ Could not start';
        $('#done-msg').textContent = r.error || 'Unknown error.';
        $('#btn-reboot').hidden = true; $('#btn-again').hidden = false;
        show('step-done');
    }
});

// ---------------------------------------------------------------------------
// 6 · Progress events
// ---------------------------------------------------------------------------
const LOG_MAX = 400; // lines kept on screen
let logLines = [];

window.installer.onLine((s) => {
    logLines.push(s);
    if (logLines.length > LOG_MAX) logLines = logLines.slice(-LOG_MAX);
    const log = $('#log');
    log.textContent = logLines.join('\n');
    log.scrollTop = log.scrollHeight;
});

window.installer.onStage(({ id }) => {
    let passed = true;
    $$('#stages li').forEach((li) => {
        if (li.dataset.stage === id) { li.classList.add('on'); li.classList.remove('done'); passed = false; }
        else if (passed) { li.classList.add('done'); li.classList.remove('on'); }
        else { li.classList.remove('on', 'done'); }
    });
});

window.installer.onDone(() => {
    $$('#stages li').forEach((li) => { li.classList.add('done'); li.classList.remove('on'); });
    $('#done-title').textContent = '✅ Outlaw OS is installed';
    $('#done-msg').innerHTML = 'Remove the USB stick, then reboot. Pick <b>Outlaw OS</b> in the boot menu — ' +
        'your other operating systems are still listed there too. On first boot, a quick setup ' +
        'wizard offers Steam, Firefox and Godot.';
    $('#btn-reboot').hidden = false; $('#btn-again').hidden = true;
    show('step-done');
});

window.installer.onError(({ message }) => {
    $('#done-title').textContent = '❌ The install hit a problem';
    $('#done-msg').textContent = (message || 'Unknown error.') +
        ' — Nothing else was changed. Fix the issue above and try again; the wizard is safe to re-run.';
    $('#btn-reboot').hidden = true; $('#btn-again').hidden = false;
    show('step-done');
});

$('#btn-reboot').addEventListener('click', () => window.installer.reboot());
$('#btn-again').addEventListener('click', () => { logLines = []; show('step-welcome'); checkOnline(); });
$('#btn-done-exit').addEventListener('click', () => window.installer.quit());

// boot
checkOnline();
