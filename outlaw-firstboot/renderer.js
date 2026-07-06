// ============================================================================
// Outlaw OS first-boot wizard — renderer.
// ----------------------------------------------------------------------------
// Renders the bundle checkboxes, runs the install pipeline serially, streams
// pacman output into the live log pane, then quits via window.firstboot.finish.
//
// All cross-process work goes through window.firstboot (defined in preload.js).
// The renderer has no Node access; this file is plain DOM JS.
// ============================================================================

(async function () {
    // ----- Stage refs ------------------------------------------------------
    const stagePicker   = document.getElementById('picker');
    const stageProgress = document.getElementById('progress');
    const stageSkipped  = document.getElementById('skipped');

    const bundleList   = document.getElementById('bundle-list');
    const bundleStatus = document.getElementById('bundle-status');
    const logPane      = document.getElementById('log');

    const installBtn       = document.getElementById('install-btn');
    const skipBtn          = document.getElementById('skip-btn');
    const finishBtn        = document.getElementById('finish-btn');
    const skippedFinishBtn = document.getElementById('skipped-finish-btn');

    // ----- Tiny stage switcher --------------------------------------------
    function show(stage) {
        for (const s of [stagePicker, stageProgress, stageSkipped]) {
            s.classList.toggle('stage-active', s === stage);
        }
    }

    // ----- Network setup (the bundles download from the internet) ----------
    const netWarn = document.getElementById('net-warn');
    const wifiArea = document.getElementById('wifi-area');
    const escHtml = (s) => String(s || '').replace(/[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    async function checkNet() {
        try { const r = await window.firstboot.netOnline(); netWarn.hidden = !!(r && r.online); }
        catch { netWarn.hidden = false; }
    }
    async function scanWifi() {
        wifiArea.hidden = false;
        wifiArea.innerHTML = '<div class="dim">Scanning for networks…</div>';
        let r; try { r = await window.firstboot.wifiList(); } catch (e) { r = { ok: false, error: e.message }; }
        if (!r.ok || !r.networks || !r.networks.length) {
            wifiArea.innerHTML = `<div class="dim">${escHtml(r.error || 'No Wi-Fi networks found. A network cable works automatically.')}</div>`;
            return;
        }
        wifiArea.innerHTML = '';
        for (const n of r.networks) {
            const bars = n.signal >= 70 ? '▂▄▆█' : n.signal >= 45 ? '▂▄▆' : n.signal >= 20 ? '▂▄' : '▂';
            const row = document.createElement('div');
            row.className = 'wifi-row';
            row.innerHTML =
                `<span class="wifi-name">${n.inUse ? '✔ ' : ''}${escHtml(n.ssid)}</span>` +
                `<span class="wifi-meta">${n.security ? '🔒' : 'open'} ${bars}</span>` +
                `<button class="wifi-join btn-secondary" ${n.inUse ? 'disabled' : ''}>${n.inUse ? 'Connected' : 'Connect'}</button>`;
            row.querySelector('.wifi-join').addEventListener('click', () => {
                wifiArea.querySelectorAll('.wifi-pwform').forEach((f) => f.remove());
                if (!n.security) { joinWifi(n.ssid, '', row); return; }
                const form = document.createElement('div');
                form.className = 'wifi-pwform';
                form.innerHTML = `<input type="password" placeholder="Password for ${escHtml(n.ssid)}"><button class="btn-primary">Join</button>`;
                row.after(form);
                const input = form.querySelector('input');
                const go = () => { if (input.value) joinWifi(n.ssid, input.value, row, form); };
                form.querySelector('button').addEventListener('click', go);
                input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
                input.focus();
            });
            wifiArea.appendChild(row);
        }
    }
    async function joinWifi(ssid, password, row, form) {
        const btn = row.querySelector('.wifi-join');
        btn.disabled = true; btn.textContent = 'Connecting…';
        let r; try { r = await window.firstboot.wifiConnect(ssid, password); } catch (e) { r = { ok: false, error: e.message }; }
        if (r.ok) { if (form) form.remove(); btn.textContent = 'Connected'; await checkNet(); }
        else { btn.disabled = false; btn.textContent = 'Connect'; if (form) { const i = form.querySelector('input'); i.value = ''; i.placeholder = (r.error || 'Failed').slice(0, 80); i.focus(); } }
    }
    document.getElementById('wifi-show').addEventListener('click', scanWifi);
    document.getElementById('net-retry').addEventListener('click', checkNet);
    checkNet();

    // ----- Load bundle list -----------------------------------------------
    let bundles = [];
    try {
        bundles = await window.firstboot.listBundles();
    } catch (err) {
        // Defensive: shouldn't happen, but if it does don't hang. Skip-all.
        appendLog(`Failed to load bundle list: ${err && err.message}`);
        show(stageSkipped);
        return;
    }

    // ----- Render picker rows ---------------------------------------------
    for (const bundle of bundles) {
        const li = document.createElement('li');
        li.className = 'bundle';
        li.dataset.bundleId = bundle.id;
        li.innerHTML = `
            <input type="checkbox" id="bundle-${bundle.id}"
                   ${bundle.defaultChecked ? 'checked' : ''}>
            <div class="bundle-body">
                <div class="bundle-title">
                    <label for="bundle-${bundle.id}"></label>
                    <span class="bundle-size"></span>
                </div>
                <div class="bundle-desc"></div>
            </div>
        `;
        // Plain-text into innerText slots to avoid any HTML injection from
        // bundle metadata (it's hard-coded today, but cheap insurance).
        li.querySelector('label').textContent = bundle.label;
        li.querySelector('.bundle-size').textContent = bundle.sizeNote || '';
        li.querySelector('.bundle-desc').textContent = bundle.description;

        // Click anywhere on the row toggles the checkbox (better UX than
        // requiring a precise checkbox click).
        li.addEventListener('click', (evt) => {
            if (evt.target.tagName !== 'INPUT' && evt.target.tagName !== 'LABEL') {
                const cb = li.querySelector('input[type="checkbox"]');
                cb.checked = !cb.checked;
            }
        });

        bundleList.appendChild(li);
    }

    // ----- Action wiring ---------------------------------------------------
    skipBtn.addEventListener('click', () => {
        show(stageSkipped);
    });

    skippedFinishBtn.addEventListener('click', () => {
        window.firstboot.finish();
    });

    finishBtn.addEventListener('click', () => {
        window.firstboot.finish();
    });

    installBtn.addEventListener('click', async () => {
        const selected = bundles.filter((b) => {
            const el = document.getElementById('bundle-' + b.id);
            return el && el.checked;
        });
        if (selected.length === 0) {
            // Nothing to do — treat as Skip All.
            show(stageSkipped);
            return;
        }

        // Build status rows for the progress stage.
        bundleStatus.innerHTML = '';
        for (const bundle of selected) {
            const li = document.createElement('li');
            li.className = 'bundle';
            li.dataset.bundleId = bundle.id;
            li.innerHTML = `
                <div class="bundle-body">
                    <div class="bundle-title">
                        <span class="bundle-status-icon">○</span>
                        <span class="bundle-status-label"></span>
                    </div>
                </div>
            `;
            li.querySelector('.bundle-status-label').textContent = bundle.label;
            bundleStatus.appendChild(li);
        }

        // Hook progress stream BEFORE the first install starts.
        window.firstboot.onProgress(({ bundleId, line }) => {
            appendLog(line);
        });

        show(stageProgress);
        finishBtn.disabled = true;

        // Serial install — pacman holds an exclusive lock on its DB, so
        // parallel installs would just queue and confuse the log output.
        let allOk = true;
        for (const bundle of selected) {
            setBundleStatus(bundle.id, 'running', '⟳');
            appendLog(`\n[${bundle.label}] starting…`);
            let result;
            try {
                result = await window.firstboot.installBundle(bundle.id);
            } catch (err) {
                result = { ok: false, errorMessage: err && err.message };
            }
            if (result && result.ok) {
                setBundleStatus(bundle.id, 'ok', '✓');
            } else {
                setBundleStatus(bundle.id, 'err', '✗');
                appendLog(`[${bundle.label}] failed: ${result && result.errorMessage}`);
                allOk = false;
            }
        }

        // Re-enable Finish; user clicks to exit.
        finishBtn.disabled = false;
        if (allOk) {
            appendLog('\nAll selected bundles installed successfully.');
        } else {
            appendLog('\nSome bundles failed. You can retry from the Apps panel in the shell.');
        }
    });

    // ----- Helpers ---------------------------------------------------------
    function appendLog(line) {
        logPane.textContent += (line.endsWith('\n') ? line : line + '\n');
        logPane.scrollTop = logPane.scrollHeight;
    }

    function setBundleStatus(bundleId, kind, icon) {
        const li = bundleStatus.querySelector(`[data-bundle-id="${bundleId}"]`);
        if (!li) return;
        li.classList.remove('status-running', 'status-ok', 'status-err');
        li.classList.add('status-' + kind);
        const iconEl = li.querySelector('.bundle-status-icon');
        if (iconEl) iconEl.textContent = icon;
    }
})();
