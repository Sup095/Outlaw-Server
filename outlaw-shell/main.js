// ============================================================================
// Outlaw Server - Electron main process (secure)
// ----------------------------------------------------------------------------
// Hardened for a security/gaming desktop:
//   * contextIsolation ON, nodeIntegration OFF, sandboxed renderer
//   * the renderer never gets a raw shell; every privileged action is a named,
//     validated IPC handler
//   * a destructive-command guard makes it hard to accidentally wipe the disk
//   * external navigation is intercepted and handed to the system browser
// Degrades gracefully on non-Linux hosts so the UI can be previewed anywhere.
// ============================================================================

const { app, BrowserWindow, ipcMain, shell, screen, powerMonitor, net } = require('electron');
const { spawn, execFile } = require('child_process');

// Phase 10: give the shell a stable WM_CLASS so the window manager (openbox)
// can pin it to the "below" layer — the desktop stays behind launched apps.
// Must be set before the app is ready. Harmless off-Linux.
try { app.commandLine.appendSwitch('class', 'outlaw-shell'); } catch { /* older electron */ }
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const aiAgent = require('./ai-agent');
const updater = require('./updater');
const APP_VERSION = require('./package.json').version;
const { DiagnosticRunner, listReports: listDiagReports, readReport: readDiagReport } = require('./diagnostics');
const errorlog = require('./errorlog');   // F1 — combined error/warning log
// Server fork: the sci-fi System Core (coreai), cold-mode voice (tts) and the
// VRAM tier monitor (vram-tier) were removed — a server has no GPU-VRAM budget
// dance and no talking centerpiece. Their IPC handlers + boot wiring are gone.

// Capture the shell's own crashes/rejections into the combined log so a desktop
// crash-loop is diagnosable. Never let the handler itself throw.
process.on('uncaughtException', (e) => { try { errorlog.append('error', 'shell-main', (e && e.stack) || e); } catch {} });
process.on('unhandledRejection', (e) => { try { errorlog.append('error', 'shell-main', (e && e.stack) || e); } catch {} });

const IS_LINUX = process.platform === 'linux';
// Phase 13.2 — local AI backends (both OpenAI-compatible). The BUILT-IN base AI
// is a bundled Ollama model that runs on almost anything; the fallback is the
// user's own LM Studio. The Dev session never touches either — it has its own
// backend — so this stays desktop-only per the Dev⟂Desktop rule.
const LM_STUDIO_V1 = 'http://127.0.0.1:1234/v1';
const OLLAMA_V1 = 'http://127.0.0.1:11434/v1';
const BASE_AI_MODEL = 'qwen2.5:1.5b';   // small enough for anything, capable enough to be useful
let mainWindow = null;
let autoCheckTimer = null;

// Set of long-running subprocesses we've spawned (apps:install, updates:apply,
// terminal:run, etc.). Emergency stop (Ctrl+Alt+K) walks this and kills them
// all — last-resort escape hatch when one of them is hung.
const trackedProcs = new Set();

// SC3 System Core diagnostics. Instantiated lazily (after runShell is in scope
// at module load time) and reused across runs. Progress events flow to the
// renderer via the 'diagnostics-progress' channel; if no mainWindow exists
// yet, events are dropped — the renderer can call diagnostics:status to
// resync the next time it opens the System Core screen.
let _diagRunner = null;
function getDiagRunner() {
    if (_diagRunner) return _diagRunner;
    _diagRunner = new DiagnosticRunner({ runShell });
    _diagRunner.on('progress', (payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('diagnostics-progress', payload);
        }
        // F1 — fold the System Core diagnostics' findings into the combined
        // error log, so "Report a problem" / Collect errors includes whatever a
        // health scan turned up (failed checks + warnings), not just runtime
        // crashes. Only fail/warn are logged — pass/skip aren't problems. The
        // log's content-hash dedup means the same finding isn't stored twice
        // across repeated scans. Best-effort: never let logging break a run.
        if (payload && payload.phase === 'done' && payload.report) {
            try {
                const prof = payload.report.profile || 'scan';
                for (const r of (payload.report.results || [])) {
                    if (r.status === 'fail' || r.status === 'warn') {
                        const lvl = r.status === 'fail' ? 'error' : 'warn';
                        const msg = `[diagnostic:${prof}] ${r.label}: ${r.detail || ''}`.trim();
                        errorlog.append(lvl, 'diagnostics', msg);
                    }
                }
            } catch { /* logging must never break diagnostics */ }
        }
    });
    return _diagRunner;
}

// SC7 VRAM tier monitor. One instance for the whole shell process. Background
// polling kicks off when the first renderer subscribes (we treat window
// creation as the implicit subscription) so a shell launched purely to handle
// IPC from a script doesn't fork nvidia-smi every 10s for nobody.

// ---------------------------------------------------------------------------
// Settings (persisted JSON in userData)
// ---------------------------------------------------------------------------
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_SETTINGS = {
    // Phase 13.2 — AI is ON by default now that there's a bundled built-in model
    // (no setup needed). The System Core + AI Assistant use it automatically; the
    // tiny model loads on demand and unloads when idle, and the Dev session never
    // touches it. "Start without AI" at boot, or this toggle, turns it off.
    aiEnabled: true,
    // 'local-model' is LM Studio's sentinel — it routes to whatever model the
    // user has loaded in LM Studio's UI. Matches Outlaw CodeMaker's default.
    aiModel: 'local-model',
    // Phase 13.2 — the BUILT-IN base AI. true (default) = the System Core + AI
    // Assistant use the bundled Ollama model (no setup, runs on anything). false
    // = fall back to LM Studio if it's installed + running. "Start without AI"
    // at boot flips the master aiEnabled off so nothing loads at all.
    baseAiEnabled: true,
    // Phase 16 — which engine runs the AI. 'base' = the tiny bundled Ollama model
    // (default, runs on anything); 'lmstudio' = a model you load in LM Studio;
    // 'ollama' = a LARGER model you pull through Ollama (a full LM Studio
    // replacement for CPUs that can't run LM Studio, e.g. AVX1-only). Empty = derive
    // from baseAiEnabled for backward compatibility. `ollamaModel` is the chosen tag.
    aiEngine: '',
    ollamaModel: '',
    aiPersonaName: '',       // C6 — self-chosen AI name on a user-loaded (non-base) model; base stays Cr1tt3r
    aiPersonaDesc: '',       // C6 — its self-chosen personality blurb
    lastSeenVersion: '',     // QoL — for the "Updated to vX.Y.Z" first-launch-after-update note
    crtFx: false,            // CRT scanline/flicker effect OFF by default (crisp + readable)
    glow: false,             // text glow OFF by default (no discoloration)
    reduceMotion: false,     // QoL — off decorative animations/transitions (a11y + low-end perf)
    highContrast: false,     // a11y — brighter text, no faded elements, stronger borders/focus
    uiScale: 1,              // QoL/accessibility — whole-UI zoom (text size). 0.9–1.3.
    // P1 — visual theme. 'green' = classic green-phosphor terminal (default,
    // unchanged for existing users). 'gold' = retro gold-on-gunmetal "sci-fi
    // fortress" look that matches Outlaw CodeMaker. Pure CSS-variable swap, so
    // it costs nothing at runtime and can be flipped anytime in Settings.
    theme: 'green',
    performanceMode: false,  // gaming CPU governor / gamemode hint
    // "owner/repo" the self-updater checks for releases (overridable in Settings).
    // This MUST be the server repo: pointing it at the desktop OS would pull
    // game-OS releases down onto a server.
    updateRepo: 'Sup095/Outlaw-Server',
    updateChannel: 'stable', // 'stable' = latest non-prerelease; 'beta' = newest release of any kind
    autoCheck: true,         // background check for shell updates
    lastUpdateCheck: 0,
    lastNotifiedVersion: '', // don't re-toast the same available version
    kbLayout: '',            // keyboard layout code (setxkbmap), '' = system default (us). Applied on boot.
    // Tier-2 desktop QOL (V2.0.171)
    nightLight: false,       // warm color-temperature filter (gammastep). Re-applied on boot when on.
    nightLightTemp: 4000,    // Kelvin when night light is ON (lower = warmer). Clamped 2000–6500.
    dnd: false,              // Do Not Disturb — pause desktop notifications (dunst). Re-applied on boot.
    autoLockMin: 0,          // auto-lock the desktop after N minutes idle. 0 = never.
    autoSleepMin: 0,         // suspend the machine after N minutes idle. 0 = never.
    screenBlankMin: -1,      // blank the screen (X screensaver/DPMS) after N min. -1 = system default, 0 = never.
    recentApps: [],          // MRU list of launched app ids for the Dashboard "Recent" row (max 8).
    // Display settings. Only modes the user explicitly KEPT through the 15s
    // auto-revert confirm are stored here ({outputName: {mode, rate}}) and
    // re-applied at boot — and even then only after re-validating against the
    // modes xrandr lists RIGHT NOW, so a changed monitor can't get a bad mode.
    displayModes: {},
    brightnessPct: -1,       // backlight %, floored at 5 so it can't go black. -1 = untouched.
    // Phase 6 — first-boot Quickstart tour. Shown once on the first desktop
    // entry; set true on Skip/Finish ("don't show again"). Replayable from Help.
    quickstartSeen: false,
    // SC5 — System Core voice. OFF by default. When ON, cold-mode dialogue
    // lines are routed through piper / espeak-ng for spoken playback. CPU-only,
    // no VRAM use; the shell still speaks via text bubble even when this is OFF.
    coreVoiceEnabled: false,
    // SC7 — Aggressive VRAM saver mode. `auto` (default) reads NVML each tick
    // and flips into emergency mode under thresholds. `off` keeps the tier at
    // `free` even when VRAM is low. `lean` / `minimal` force-pin the tier
    // regardless of probe. See vram-tier.js for thresholds + effects.
    vramSaverMode: 'auto',
    // Live-ISO welcome card. The Dashboard shows it on every boot of the
    // live system until the user clicks "Don't show again" — at which point
    // this flips true and persists. Installed systems never have /run/archiso
    // so the card is never shown there regardless.
    liveWelcomeDismissed: false,
    // Phase 3c — show the sign-in lock screen on shell startup (installed
    // systems). Off on the live demo automatically.
    lockEnabled: true,
};

function loadSettings() {
    try {
        const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
        return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

// Phase 14h — mirror the chosen theme to a plain $HOME dotfile so the boot-time
// greeter (a SEPARATE Electron app that can't reach this app's userData) can
// match its palette to the desktop's. Best-effort and non-fatal: if it never
// lands, the greeter just falls back to the green default. Mirrors the existing
// ~/.outlaw-session* convention the greeter already reads.
function mirrorThemeToHome(theme) {
    try {
        const t = (typeof theme === 'string' && theme) ? theme : 'green';
        fs.writeFileSync(path.join(app.getPath('home'), '.outlaw-theme'), t + '\n', { mode: 0o600 });
    } catch { /* non-fatal — greeter falls back to green */ }
}

// Atomic write — write to a temp file in the SAME directory, then rename over the
// target. rename(2) is atomic on a POSIX filesystem, so a crash or power-loss
// mid-write can never leave a half-written (corrupt) file. Without this, a direct
// writeFileSync that's interrupted leaves truncated JSON that fails to parse on the
// next load and SILENTLY resets the user's settings/chats/PIN to defaults. On any
// failure we clean up the temp file and rethrow so the existing (good) file is kept
// rather than replaced with a partial one.
function atomicWriteFileSync(file, data, opts) {
    const tmp = `${file}.tmp-${process.pid}`;
    try {
        fs.writeFileSync(tmp, data, opts);
        fs.renameSync(tmp, file);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
        throw e;
    }
}

function saveSettings(s) {
    try {
        fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
        atomicWriteFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
    } catch (e) {
        console.error('Could not persist settings:', e.message);
    }
    mirrorThemeToHome(s && s.theme);
    return s;
}

// ---------------------------------------------------------------------------
// Phase 15b — persistent AI chats (Cr1tt3r). Named, multi-turn conversations
// stored in userData so they SURVIVE app updates (the app code in /usr/share is
// replaced on update; userData is not). The renderer owns the conversation
// logic; these helpers just load/save the whole (small) store as one JSON blob.
// ---------------------------------------------------------------------------
const AI_CHATS_PATH = path.join(app.getPath('userData'), 'ai-chats.json');

function loadAiChats() {
    try {
        const store = JSON.parse(fs.readFileSync(AI_CHATS_PATH, 'utf8'));
        if (store && Array.isArray(store.conversations)) return store;
    } catch { /* absent or corrupt — start fresh */ }
    return { activeId: null, conversations: [] };
}

function saveAiChats(store) {
    try {
        fs.mkdirSync(path.dirname(AI_CHATS_PATH), { recursive: true });
        const safe = (store && Array.isArray(store.conversations)) ? store : { activeId: null, conversations: [] };
        atomicWriteFileSync(AI_CHATS_PATH, JSON.stringify(safe, null, 2));
        return true;
    } catch (e) {
        console.error('Could not persist AI chats:', e.message);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Auth — 4-digit PIN (Outlaw-level convenience credential) + account password.
// The PIN is stored ONLY as a salted scrypt hash in a 0600 file (never plain
// text). The account password is verified against PAM via `sudo -S -v` (so the
// real OS password always works as a fallback). The PIN gates the sign-in
// screen and "important" installs; ordinary installs are passwordless via the
// 49-outlaw polkit rule.
// ---------------------------------------------------------------------------
const AUTH_FILE = path.join(app.getPath('userData'), 'auth.json');
const IS_LIVE = (() => { try { return process.platform === 'linux' && fs.existsSync('/run/archiso'); } catch { return false; } })();
let _authFails = 0;       // failed unlock attempts this session (rate-limit)
let _authLockUntil = 0;   // epoch ms; unlocking blocked until then

function readAuth() {
    try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch { return null; }
}
function hasPin() { const a = readAuth(); return !!(a && a.pinHash && a.pinSalt); }
function setPin(pin) {
    if (!/^\d{4}$/.test(String(pin))) return false;
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
    try {
        fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
        // atomic + 0o600 on the temp file so the PIN hash is never briefly written
        // world-readable, and a crash can't leave a corrupt auth file.
        atomicWriteFileSync(AUTH_FILE, JSON.stringify({ pinSalt: salt, pinHash: hash }), { mode: 0o600 });
        try { fs.chmodSync(AUTH_FILE, 0o600); } catch {}
        return true;
    } catch { return false; }
}
function clearPin() { try { fs.unlinkSync(AUTH_FILE); } catch {} return true; }
function verifyPin(pin) {
    const a = readAuth();
    if (!a || !a.pinHash || !a.pinSalt || !/^\d{4}$/.test(String(pin))) return false;
    try {
        const h = crypto.scryptSync(String(pin), a.pinSalt, 32).toString('hex');
        return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(a.pinHash, 'hex'));
    } catch { return false; }
}
function verifyPassword(pw) {
    return new Promise((resolve) => {
        if (process.platform !== 'linux') return resolve(false);
        let p;
        try { p = spawn('sudo', ['-S', '-p', '', '-v'], { stdio: ['pipe', 'ignore', 'ignore'] }); }
        catch { return resolve(false); }
        p.on('error', () => resolve(false));
        p.on('close', (code) => { try { spawn('sudo', ['-k'], { stdio: 'ignore' }).unref(); } catch {} resolve(code === 0); });
        try { p.stdin.write(String(pw || '') + '\n'); p.stdin.end(); } catch { resolve(false); }
    });
}
// Unlock with either a PIN or the account password. Rate-limited.
async function authUnlock({ pin, password }) {
    const now = Date.now();
    if (now < _authLockUntil) {
        return { ok: false, error: 'Too many attempts — wait a few seconds.', waitMs: _authLockUntil - now };
    }
    let ok = false;
    if (pin != null && pin !== '') ok = verifyPin(pin);
    else if (password != null && password !== '') ok = await verifyPassword(password);
    if (ok) { _authFails = 0; return { ok: true }; }
    _authFails += 1;
    if (_authFails >= 5) { _authLockUntil = Date.now() + 8000; _authFails = 0; }
    return { ok: false, error: 'Incorrect — try again.' };
}

// ---------------------------------------------------------------------------
// Resilient package install/update. Prefer the installed /usr/local/bin helpers
// (passwordless via the 49-outlaw polkit rule). If a helper is MISSING — e.g.
// the shell was updated on a system installed before the helpers existed — fall
// back to the same logic written to a temp script and run via `pkexec bash`
// (works, but prompts since it isn't the allowlisted program). This turns the
// fatal "no such file or directory" into a working install.
// ---------------------------------------------------------------------------
const PKG_INSTALL_SH = [
    '#!/bin/bash',
    'set -uo pipefail',
    "if ! grep -qE '^\\[multilib\\]' /etc/pacman.conf; then sed -i '/^#\\[multilib\\]/{s/^#//; n; s/^#//}' /etc/pacman.conf; fi",
    'if [ ! -s /etc/pacman.d/gnupg/pubring.gpg ]; then pacman-key --init >/dev/null 2>&1 || true; pacman-key --populate archlinux >/dev/null 2>&1 || true; fi',
    'pacman -Syy --noconfirm || { echo "could not synchronize databases"; exit 4; }',
    'pacman -S --needed --noconfirm "$@"',
    '',
].join('\n');
const PKG_UPDATE_SH = '#!/bin/bash\nset -uo pipefail\npacman -Syu --noconfirm\n';

function tempScript(name, content) {
    const p = path.join(os.tmpdir(), name);
    try { fs.writeFileSync(p, content, { mode: 0o755 }); return p; } catch { return null; }
}
function privInstall(pkgList, timeout) {
    const helper = '/usr/local/bin/outlaw-pkg-install';
    if (IS_LINUX && fs.existsSync(helper)) return runShell(`pkexec ${helper} ${pkgList}`, { timeout });
    const tmp = tempScript('outlaw-pkg-install.sh', PKG_INSTALL_SH);
    if (!tmp) return Promise.resolve({ code: 1, stdout: '', stderr: 'Could not prepare the installer.' });
    return runShell(`pkexec bash ${tmp} ${pkgList}`, { timeout });
}
function privUpdate(timeout) {
    const helper = '/usr/local/bin/outlaw-update-pkgs';
    if (IS_LINUX && fs.existsSync(helper)) return runShell(`pkexec ${helper}`, { timeout });
    const tmp = tempScript('outlaw-update-pkgs.sh', PKG_UPDATE_SH);
    if (!tmp) return Promise.resolve({ code: 1, stdout: '', stderr: 'Could not prepare the updater.' });
    return runShell(`pkexec bash ${tmp}`, { timeout });
}

let settings = loadSettings();

// ---------------------------------------------------------------------------
// Allowlisted application launchers
// The renderer can only ask for an *id*; it can never name an arbitrary binary.
// ---------------------------------------------------------------------------
const APP_REGISTRY = {
    browser:   { label: 'Web Browser',  bin: 'opera',          args: [], fallbacks: ['opera-gx', 'firefox', 'chromium'] },
    steam:     { label: 'Steam',        bin: 'steam',          args: [] },
    lutris:    { label: 'Lutris',       bin: 'lutris',         args: [] },
    heroic:    { label: 'Heroic',       bin: 'heroic',         args: [] },
    godot:     { label: 'Godot',        bin: 'godot',          args: [] },
    blender:   { label: 'Blender',      bin: 'blender',        args: [] },
    gimp:      { label: 'GIMP',         bin: 'gimp',           args: [] },
    code:      { label: 'VS Code',      bin: 'code',           args: [], fallbacks: ['code-oss', 'codium'] },
    files:     { label: 'Files',        bin: 'thunar',         args: [], fallbacks: ['pcmanfm', 'nautilus'] },
    lmstudio:  { label: 'LM Studio',    bin: 'outlaw-lm-studio', args: [], fallbacks: ['lm-studio', 'lmstudio'] },
    wireshark: { label: 'Wireshark',    bin: 'wireshark',      args: [] },
    burp:      { label: 'Burp Suite',   bin: 'burpsuite',      args: [] },
    obs:       { label: 'OBS Studio',   bin: 'obs',            args: [] },
    terminal:  { label: 'Terminal',     bin: 'xfce4-terminal', args: [], fallbacks: ['xterm', 'alacritty'] },
};

// ---------------------------------------------------------------------------
// Apps catalog — the curated allowlist of optional, on-demand installs.
// The Apps screen in the renderer shows these; clicking Install runs
//   pkexec pacman -S --needed --noconfirm <pkg>
// All packages here are in official Arch repos (core/extra/community/multilib)
// so no AUR helper is required. The renderer can ONLY ask to install by `id`;
// it can never name an arbitrary package — the catalog IS the allowlist.
// ---------------------------------------------------------------------------
const APP_CATALOG = [
    // ----- Essentials (the first-boot bundles, also installable here any time
    // if you skipped them on first login). `extra` packages install alongside
    // the primary `pkg`; install-state is tracked on `pkg`. -----
    { id: 'steam',       pkg: 'steam',             category: 'Essentials',   label: 'Steam + gaming stack', description: 'Steam client plus GameMode, Gamescope, MangoHud and the Vulkan / 32-bit gaming libraries.', bin: 'steam',
      extra: ['gamemode', 'lib32-gamemode', 'gamescope', 'mangohud', 'lib32-mangohud', 'vulkan-icd-loader', 'lib32-vulkan-icd-loader', 'vulkan-tools', 'lib32-mesa'] },
    { id: 'firefox',     pkg: 'firefox',           category: 'Essentials',   label: 'Firefox',         description: 'The Firefox web browser.',                                        bin: 'firefox' },
    { id: 'godot',       pkg: 'godot',             category: 'Essentials',   label: 'Godot Engine',    description: 'The Godot game engine (GDScript) — what Outlaw CodeMaker builds games in.', bin: 'godot' },

    // ----- Game Dev -----
    { id: 'blender',     pkg: 'blender',           category: 'Game Dev',     label: 'Blender',         description: '3D modeling, rigging, animation, and sculpting.',                 bin: 'blender' },
    { id: 'gimp',        pkg: 'gimp',              category: 'Game Dev',     label: 'GIMP',            description: 'Raster image editor for sprites and textures.',                   bin: 'gimp' },
    { id: 'code',        pkg: 'code',              category: 'Game Dev',     label: 'VS Code',         description: 'Code editor with extensions. Pairs well with GDScript.',          bin: 'code' },
    { id: 'krita',       pkg: 'krita',             category: 'Game Dev',     label: 'Krita',           description: 'Digital painting for concept art and 2D animation.',              bin: 'krita' },
    { id: 'inkscape',    pkg: 'inkscape',          category: 'Game Dev',     label: 'Inkscape',        description: 'Vector editor for UI and SVG assets.',                            bin: 'inkscape' },
    { id: 'audacity',    pkg: 'audacity',          category: 'Game Dev',     label: 'Audacity',        description: 'Audio editor for SFX and music.',                                 bin: 'audacity' },
    { id: 'tiled',       pkg: 'tiled',             category: 'Game Dev',     label: 'Tiled',           description: 'Tilemap editor — great for 2D level design.',                     bin: 'tiled' },

    // ----- Gaming -----
    { id: 'lutris',      pkg: 'lutris',            category: 'Gaming',       label: 'Lutris',          description: 'Non-Steam game launcher (GOG, Epic, emulators).',                 bin: 'lutris' },
    { id: 'wine',        pkg: 'wine',              category: 'Gaming',       label: 'Wine',            description: 'Run Windows games and apps on Linux.' },
    { id: 'winetricks',  pkg: 'winetricks',        category: 'Gaming',       label: 'Winetricks',      description: 'Workarounds + components for Wine.' },
    { id: 'discord',     pkg: 'discord',           category: 'Gaming',       label: 'Discord',         description: 'Voice and text chat.',                                            bin: 'discord' },

    // ----- Browsers -----
    { id: 'chromium',    pkg: 'chromium',          category: 'Browsers',     label: 'Chromium',        description: 'Alternative to Firefox.',                                         bin: 'chromium' },

    // ----- Productivity / utilities -----
    { id: 'vim',         pkg: 'vim',               category: 'Productivity', label: 'Vim',             description: 'Modal terminal text editor.' },
    { id: 'vlc',         pkg: 'vlc',               category: 'Productivity', label: 'VLC',             description: 'Media player.',                                                   bin: 'vlc' },
    { id: 'libreoffice', pkg: 'libreoffice-fresh', category: 'Productivity', label: 'LibreOffice',     description: 'Documents, spreadsheets, presentations.',                         bin: 'libreoffice' },
    { id: 'obs',         pkg: 'obs-studio',        category: 'Productivity', label: 'OBS Studio',      description: 'Screen recording / streaming.',                                   bin: 'obs' },

    // ----- Security (authorized testing only) -----
    { id: 'nmap',        pkg: 'nmap',              category: 'Security',     label: 'Nmap',            description: 'Network scanning.' },
    { id: 'wireshark',   pkg: 'wireshark-qt',      category: 'Security',     label: 'Wireshark',       description: 'Packet capture and analysis.',                                    bin: 'wireshark' },
    { id: 'tcpdump',     pkg: 'tcpdump',           category: 'Security',     label: 'tcpdump',         description: 'CLI packet capture.' },
    { id: 'john',        pkg: 'john',              category: 'Security',     label: 'John the Ripper', description: 'Password cracker (CPU).' },
    { id: 'hashcat',     pkg: 'hashcat',           category: 'Security',     label: 'Hashcat',         description: 'Password cracker (GPU).' },
    { id: 'sqlmap',      pkg: 'sqlmap',            category: 'Security',     label: 'sqlmap',          description: 'SQL injection testing.' },
    { id: 'aircrack',    pkg: 'aircrack-ng',       category: 'Security',     label: 'Aircrack-ng',     description: 'Wireless network security testing.' },
    { id: 'hydra',       pkg: 'hydra',             category: 'Security',     label: 'Hydra',           description: 'Network login brute-force.' },
    { id: 'netcat',      pkg: 'gnu-netcat',        category: 'Security',     label: 'netcat',          description: 'Network swiss-army knife.' },
];

function which(bin) {
    return new Promise((resolve) => {
        if (!IS_LINUX) return resolve(null);
        execFile('command', ['-v', bin], { shell: '/bin/bash' }, (err, out) => {
            resolve(err ? null : (out || '').trim());
        });
    });
}

async function resolveBinary(entry) {
    const candidates = [entry.bin, ...(entry.fallbacks || [])];
    for (const c of candidates) {
        if (await which(c)) return c;
    }
    return null;
}

// Pin a frameless window to the full primary display and keep it there when the
// display resizes. Works without a window manager (where `fullscreen: true` is
// a no-op). Forcing fullscreen OFF first guarantees setBounds isn't ignored.
function fitToScreen(winRef) {
    const apply = () => {
        try {
            // workArea (not .size) so the window leaves room for the tint2
            // taskbar. Without a WM/taskbar, workArea === the full display, so
            // this still fills the screen. Re-fits when the taskbar appears
            // (its strut changes the work area → display-metrics-changed).
            const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
            if (winRef.isFullScreen()) winRef.setFullScreen(false);
            // Idempotent: only move the window if it isn't already correct.
            // Calling setBounds needlessly (e.g. on a spurious display-metrics
            // event) can dismiss a just-opened native popup.
            const b = winRef.getBounds();
            if (b.x !== x || b.y !== y || b.width !== width || b.height !== height) {
                winRef.setBounds({ x, y, width, height });
            }
        } catch { /* window may be gone */ }
    };
    winRef.once('ready-to-show', () => {
        apply();
        // The taskbar (tint2) may reserve its strut a moment after the shell
        // maps, shrinking the work area; re-fit once it settles. Belt-and-braces
        // alongside the display-metrics-changed listener.
        setTimeout(apply, 1500);
    });
    const onChange = () => apply();
    screen.on('display-metrics-changed', onChange);
    winRef.on('closed', () => { try { screen.removeListener('display-metrics-changed', onChange); } catch {} });
}

function launchDetached(bin, args = [], opts = {}) {
    const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
    child.on('error', (e) => console.error(`launch ${bin} failed:`, e.message));
    child.unref();
    // No-WM focus fix: the Outlaw session runs without a window manager, so a
    // newly-launched window appears on top but never receives X keyboard focus
    // — you can see it but can't type into it. outlaw-focus sets input focus
    // directly (xdotool) once the window maps. `opts.focus` is a window
    // name/class substring; it defaults to the binary's basename (matches most
    // apps' WM_CLASS). Pass `focus: false` for launchers that focus themselves
    // (e.g. outlaw-term). Best-effort, Linux-only, never throws.
    if (IS_LINUX && opts.focus !== false) {
        const pat = (typeof opts.focus === 'string' && opts.focus) || String(bin).split('/').pop();
        try { spawn('outlaw-focus', [pat], { detached: true, stdio: 'ignore' }).unref(); } catch {}
    }
    return child;
}

// --- App auto-discovery (Phase 2) ------------------------------------------
// Surface apps the user installed themselves — freedesktop `.desktop` entries
// and AppImages dropped into common folders — so they appear in the Apps page
// next to the curated catalog and launch in one click. Pure filesystem reads,
// Linux-only, and tolerant of missing dirs / unreadable files (never throws).
function _parseDesktopEntry(txt) {
    const e = {};
    let inMain = false;
    for (const raw of String(txt).split('\n')) {
        const line = raw.trim();
        if (line.startsWith('[')) { inMain = (line === '[Desktop Entry]'); continue; }
        if (!inMain || !line || line.startsWith('#')) continue;
        const i = line.indexOf('=');
        if (i < 0) continue;
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k === 'Name' && !e.name) e.name = v;            // locale-less Name= wins
        else if (k === 'Exec' && !e.exec) e.exec = v;
        else if (k === 'NoDisplay') e.noDisplay = /true/i.test(v);
        else if (k === 'Hidden') e.hidden = /true/i.test(v);
        else if (k === 'Type') e.type = v;
        else if (k === 'Terminal') e.terminal = /true/i.test(v);
    }
    return e;
}
function _cleanExec(exec) {
    // Strip desktop-entry field codes (%f %F %u %U %i %c %k %d %n %v %m …).
    return String(exec).replace(/%[a-zA-Z]/g, '').replace(/\s+/g, ' ').trim();
}
function _splitExec(s) {
    const out = []; let cur = ''; let q = null;
    for (const ch of s) {
        if (q) { if (ch === q) q = null; else cur += ch; }
        else if (ch === '"' || ch === "'") q = ch;
        else if (ch === ' ') { if (cur) { out.push(cur); cur = ''; } }
        else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
}
function discoverApps() {
    if (!IS_LINUX) return [];
    const home = os.homedir();
    const desktopDirs = [
        '/usr/share/applications',
        '/usr/local/share/applications',
        path.join(home, '.local/share/applications'),
        '/var/lib/flatpak/exports/share/applications',
        path.join(home, '.local/share/flatpak/exports/share/applications'),
        '/var/lib/snapd/desktop/applications',
    ];
    const appImageDirs = [
        path.join(home, 'Downloads'),
        path.join(home, 'Applications'),
        path.join(home, 'Desktop'),
        path.join(home, 'AppImages'),
        home,
    ];
    const out = [];
    const seen = new Set();
    for (const dir of desktopDirs) {
        let files;
        try { files = fs.readdirSync(dir); } catch { continue; }
        for (const f of files) {
            if (!f.endsWith('.desktop')) continue;
            const full = path.join(dir, f);
            let txt;
            try { txt = fs.readFileSync(full, 'utf8'); } catch { continue; }
            const e = _parseDesktopEntry(txt);
            if (!e.name || !e.exec) continue;
            if (e.noDisplay || e.hidden) continue;
            if (e.type && e.type !== 'Application') continue;
            const key = e.name.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ id: 'd:' + full, name: e.name, exec: e.exec, kind: 'desktop', path: full, terminal: !!e.terminal });
        }
    }
    for (const dir of appImageDirs) {
        let files;
        try { files = fs.readdirSync(dir); } catch { continue; }
        for (const f of files) {
            if (!/\.appimage$/i.test(f)) continue;
            const full = path.join(dir, f);
            const key = 'ai:' + full.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ id: 'a:' + full, name: f.replace(/\.appimage$/i, ''), exec: full, kind: 'appimage', path: full });
        }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
}

// ---------------------------------------------------------------------------
// Destructive command guard — the "don't accidentally nuke the PC" layer
// ---------------------------------------------------------------------------
const DANGER_PATTERNS = [
    { re: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i, reason: 'Recursive/forced delete (rm -rf).' },
    { re: /\bdd\b[^|;]*\bof=\/dev\//i, reason: 'Raw write to a block device (dd of=/dev/...).' },
    { re: /\bmkfs(\.\w+)?\b/i, reason: 'Filesystem format (mkfs).' },
    { re: /\bwipefs\b/i, reason: 'Filesystem signature wipe (wipefs).' },
    { re: /\b(shred|blkdiscard)\b[^|;]*\/dev\//i, reason: 'Destroying data on a device.' },
    { re: /\b(fdisk|sfdisk|sgdisk|cfdisk|parted)\b/i, reason: 'Partition table editing.' },
    { re: />\s*\/dev\/(sd|nvme|vd|mmcblk)/i, reason: 'Redirecting output onto a disk device.' },
    { re: /\b(parted|sgdisk)\b[^|;]*--?(mklabel|zap-all|delete)/i, reason: 'Erasing partition layout.' },
    { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'Fork bomb.' },
    { re: /\bchmod\s+-R\s+0*\s+\//i, reason: 'Recursive chmod from filesystem root.' },
    { re: /\bchown\s+-R\b[^|;]*\s\/(?:\s|$)/i, reason: 'Recursive chown of the filesystem root.' },
    { re: /\bmv\b[^|;]*\s\/dev\/null\b/i, reason: 'Moving data into /dev/null (destroys it).' },
    { re: /\b(pacman|yay)\b[^|;]*-R[a-z]*s[a-z]*\b/i, reason: 'Mass package removal with dependencies.' },
    { re: /\bgit\b[^|;]*\b(reset\s+--hard|clean\s+-[a-z]*f)/i, reason: 'Destructive git operation (discards work).' },
];

function classifyCommand(command) {
    const cmd = String(command || '');
    for (const p of DANGER_PATTERNS) {
        if (p.re.test(cmd)) return { danger: true, reason: p.reason };
    }
    return { danger: false, reason: '' };
}

function runShell(command, { timeout = 30000 } = {}) {
    return new Promise((resolve) => {
        if (!IS_LINUX) {
            return resolve({ code: 127, stdout: '', stderr: 'Shell commands only run on Outlaw Server (Linux).' });
        }
        const child = spawn('bash', ['-c', command], {
            cwd: os.homedir(),
            env: process.env,
        });
        trackedProcs.add(child);
        let stdout = '', stderr = '';
        const killer = setTimeout(() => child.kill('SIGKILL'), timeout);
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        const cleanup = () => { clearTimeout(killer); trackedProcs.delete(child); };
        child.on('close', (code) => { cleanup(); resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }); });
        child.on('error', (err) => { cleanup(); resolve({ code: 1, stdout: '', stderr: err.message }); });
    });
}

// Kill every tracked subprocess. SIGTERM first; if anything is still alive
// after 1s, SIGKILL. Returns the number we acted on.
function killAllTrackedProcs() {
    const procs = Array.from(trackedProcs);
    for (const p of procs) {
        try { p.kill('SIGTERM'); } catch { /* already dead */ }
    }
    setTimeout(() => {
        for (const p of procs) {
            try {
                if (!p.killed) p.kill('SIGKILL');
            } catch { /* already dead */ }
        }
    }, 1000);
    return procs.length;
}

// ---------------------------------------------------------------------------
// System information helpers (read /proc; fall back gracefully off-Linux)
// ---------------------------------------------------------------------------
let lastCpu = null;
function readCpuSample() {
    try {
        const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
        const p = line.trim().split(/\s+/).slice(1).map(Number);
        const idle = p[3] + (p[4] || 0);
        const total = p.reduce((a, b) => a + b, 0);
        return { idle, total };
    } catch {
        return null;
    }
}

function cpuPercent() {
    const sample = readCpuSample();
    if (!sample) {
        // cross-platform fallback via loadavg
        const load = os.loadavg()[0];
        const cores = os.cpus().length || 1;
        return Math.min(100, (load / cores) * 100);
    }
    if (!lastCpu) { lastCpu = sample; return 0; }
    const dIdle = sample.idle - lastCpu.idle;
    const dTotal = sample.total - lastCpu.total;
    lastCpu = sample;
    if (dTotal <= 0) return 0;
    return Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
}

function memInfo() {
    try {
        const txt = fs.readFileSync('/proc/meminfo', 'utf8');
        const get = (k) => Number((txt.match(new RegExp(`${k}:\\s+(\\d+)`)) || [])[1] || 0);
        const total = get('MemTotal'), avail = get('MemAvailable');
        return { totalKb: total, usedKb: total - avail };
    } catch {
        return { totalKb: Math.round(os.totalmem() / 1024), usedKb: Math.round((os.totalmem() - os.freemem()) / 1024) };
    }
}

function fmtGb(kb) { return (kb / 1024 / 1024).toFixed(1) + 'G'; }

// ---- Phase 4: local-AI model recommendation -------------------------------
// Given total system RAM and discrete-GPU VRAM (GB), pick a model the machine
// can realistically run in LM Studio, plus suggested settings. We always also
// return a "starter" model that runs on practically any PC — once it's loaded
// it can guide the user through the rest of the setup itself.
// opts (Phase 14d): { purpose:'desktop'|'dev', tier:'powerful'|'minimal' (desktop),
// spill:bool (dev — spill the model into system RAM beyond VRAM) }. Defaults
// (no opts) = desktop/powerful, identical to the original behaviour so existing
// callers (gatherSpecs, machineSummary) are unaffected.
function recommendModel(ramGb, vramGb, opts = {}) {
    const purpose = opts.purpose === 'dev' ? 'dev' : 'desktop';
    const tier = opts.tier === 'minimal' ? 'minimal' : 'powerful';
    const spill = !!opts.spill;
    const gpu = vramGb >= 4;                       // a usable discrete GPU?
    const starter = { model: 'Qwen2.5 0.5B Instruct (Q4_K_M)', size: '~0.4 GB',
                      note: 'Runs on almost anything, even old laptops.' };
    // General instruct catalogue (desktop), smallest → largest. `ollama` is the
    // pull tag for the Ollama engine; the same weights are searchable by name in
    // LM Studio. Both engines (and CPU-only) work on any GPU vendor.
    const M = {
        s05: { model: 'Qwen2.5 0.5B Instruct (Q4_K_M)', size: '~0.4 GB', ctx: 2048, tier: 'tiny',   ollama: 'qwen2.5:0.5b' },
        s3:  { model: 'Llama 3.2 3B Instruct (Q4_K_M)',  size: '~2.2 GB', ctx: 4096, tier: 'small',  ollama: 'llama3.2:3b' },
        s7:  { model: 'Qwen2.5 7B Instruct (Q4_K_M)',    size: '~4.7 GB', ctx: 8192, tier: 'medium', ollama: 'qwen2.5:7b' },
        s14: { model: 'Qwen2.5 14B Instruct (Q4_K_M)',   size: '~9 GB',   ctx: 8192, tier: 'large',  ollama: 'qwen2.5:14b' },
        s32: { model: 'Qwen2.5 32B Instruct (Q4_K_M)',   size: '~19 GB',  ctx: 8192, tier: 'xl',     ollama: 'qwen2.5:32b' },
    };
    // Coding catalogue (Dev session) — Qwen2.5-Coder, bigger context for code.
    const C = {
        c15: { model: 'Qwen2.5-Coder 1.5B (Q4_K_M)', size: '~1.0 GB', ctx: 8192,  tier: 'tiny',   ollama: 'qwen2.5-coder:1.5b' },
        c7:  { model: 'Qwen2.5-Coder 7B (Q4_K_M)',   size: '~4.7 GB', ctx: 16384, tier: 'medium', ollama: 'qwen2.5-coder:7b' },
        c14: { model: 'Qwen2.5-Coder 14B (Q4_K_M)',  size: '~9 GB',   ctx: 16384, tier: 'large',  ollama: 'qwen2.5-coder:14b' },
        c32: { model: 'Qwen2.5-Coder 32B (Q4_K_M)',  size: '~19 GB',  ctx: 16384, tier: 'xl',     ollama: 'qwen2.5-coder:32b' },
    };
    let rec, budget, runsOn, note;

    if (purpose === 'dev') {
        // Best CODING model the machine can run. Optional spill borrows spare RAM
        // beyond VRAM for a bigger (slower) model.
        if (gpu) {
            budget = spill ? vramGb + Math.max(0, ramGb - 4) * 0.5 : vramGb;
            runsOn = spill
                ? `GPU + RAM spill (${vramGb} GB VRAM + system RAM — larger model, a little slower)`
                : `GPU only (${vramGb} GB VRAM — fastest)`;
        } else {
            budget = Math.max(1, ramGb - 4);
            runsOn = 'CPU + RAM (no discrete GPU — slower; a smaller coder model stays usable)';
        }
        rec = budget < 6 ? C.c15 : budget < 11 ? C.c7 : budget < 20 ? C.c14 : C.c32;
        note = 'Coding model for the Dev session (Outlaw CodeMaker).';
    } else if (tier === 'minimal') {
        // Desktop, minimal-but-useful — small + capable, for system control and
        // the built-in AI's job done better. Deliberately light on resources.
        budget = gpu ? vramGb : Math.max(1, ramGb - 4);
        rec = budget >= 6 ? M.s7 : M.s3;
        runsOn = gpu ? `GPU offload (${vramGb} GB VRAM — light)` : 'CPU + RAM (light footprint)';
        note = "Lean desktop assistant — system control + the built-in AI's job, but better.";
    } else {
        // Desktop, most-powerful — the biggest general model the PC can run.
        if (gpu) { budget = vramGb; rec = vramGb < 6 ? M.s3 : vramGb < 11 ? M.s7 : vramGb < 20 ? M.s14 : M.s32; }
        else { budget = Math.max(1, ramGb - 4); rec = ramGb < 6 ? M.s05 : ramGb < 12 ? M.s3 : ramGb < 24 ? M.s7 : M.s14; }
        runsOn = gpu ? `GPU offload (${vramGb} GB VRAM — fast)`
                     : 'CPU + RAM (works everywhere, but slower — drop to a smaller model if it lags)';
        note = 'The most capable general model your PC can run.';
    }

    // Engine recommendation — vendor-agnostic (uses vramGb, which already reads
    // NVIDIA via nvidia-smi AND AMD/Intel via the DRM sysfs node). Ollama is the
    // one-command default that works on any GPU or CPU-only; the built-in model
    // suits very weak PCs with zero setup; LM Studio is the GUI alternative. This
    // is a sensible default — the on-device AI refines it in plain language.
    const weak = !gpu && ramGb < 8;
    const recommendedEngine = (weak || rec.tier === 'tiny') ? 'base' : 'ollama';

    return {
        gpu, purpose, budgetGb: Math.round(budget * 10) / 10,
        tier: purpose === 'desktop' ? tier : null,
        spill: purpose === 'dev' ? spill : null,
        runsOn, note, gpuOffload: gpu,
        starter, recommended: rec, recommendedEngine,
        sameAsStarter: rec.model === starter.model,
    };
}

// Read this PC's specs (RAM / discrete-GPU VRAM / CPU) once and cache them —
// hardware doesn't change during a session, and the nvidia-smi probe is the
// only slow bit. Shared by the AI setup card, the spec-aware prompts, and the
// setup chat so they all agree.
let _specsCache = null;
async function gatherSpecs() {
    if (_specsCache) return _specsCache;
    // The probe must NEVER hard-fail — the AI Setup card (and "Check my PC")
    // depend on it, and an early throw shows up to the user as the whole thing
    // "failing immediately". Any unexpected error falls back to Node's own readings.
    try {
        const mem = memInfo();
        const ramGb = Math.round((mem.totalKb / 1024 / 1024) * 10) / 10;
        let vramGb = 0, gpuName = '';
        if (IS_LINUX) {
            const nv = await runShell(
                'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null | head -n 1',
                { timeout: 3000 }).catch(() => ({ code: 1, stdout: '' }));
            if (nv.code === 0 && nv.stdout) {
                const p = nv.stdout.split(',').map((s) => s.trim());
                gpuName = p[0] || 'NVIDIA GPU';
                vramGb = Math.round((Number(p[1]) || 0) / 1024 * 10) / 10;
            } else {
                const lspci = await runShell(
                    "lspci 2>/dev/null | grep -Ei 'vga|3d|display' | sed 's/^.*: //' | head -n 1",
                    { timeout: 2000 }).catch(() => ({ stdout: '' }));
                gpuName = (lspci.stdout || '').trim();
                // C4 — AMD / Intel (and other non-NVIDIA) discrete VRAM via the DRM
                // sysfs nodes (bytes): amdgpu = device/mem_info_vram_total, Intel
                // i915 discrete = lmem_total_bytes. Integrated GPUs report 0 / no
                // node — they share system RAM — so vramGb stays 0, which correctly
                // routes to the RAM-based recommendations + the RAM-only AI path.
                const vram = await runShell(
                    '{ cat /sys/class/drm/card*/device/mem_info_vram_total 2>/dev/null; ' +
                    'cat /sys/class/drm/card*/lmem_total_bytes 2>/dev/null; } | sort -rn | head -n 1',
                    { timeout: 2000 }).catch(() => ({ stdout: '' }));
                const bytes = Number((vram.stdout || '').trim());
                if (bytes > 0) vramGb = Math.round(bytes / (1024 ** 3) * 10) / 10;
            }
        }
        const cores = os.cpus().length;
        const cpu = (os.cpus()[0] || {}).model || 'CPU';
        _specsCache = { ramGb, vramGb, gpuName, cores, cpu, ...recommendModel(ramGb, vramGb) };
        return _specsCache;
    } catch (e) {
        const ramGb = Math.round((os.totalmem() / (1024 ** 3)) * 10) / 10;
        _specsCache = {
            ramGb, vramGb: 0, gpuName: '',
            cores: os.cpus().length || 1,
            cpu: (os.cpus()[0] || {}).model || 'CPU',
            probeNote: 'limited probe (' + ((e && e.message) || 'unknown') + ')',
            ...recommendModel(ramGb, 0),
        };
        return _specsCache;
    }
}

// Compact one-liner used to make the local AI hardware-aware in its prompt.
function machineSummary(s) {
    const gpu = s.vramGb > 0
        ? `${s.gpuName || 'GPU'} with ${s.vramGb}GB VRAM`
        : (s.gpuName ? `${s.gpuName} (no dedicated VRAM)` : 'no discrete GPU');
    return `${s.cpu}, ${s.cores} cores, ${s.ramGb}GB RAM, ${gpu}. `
        + `Best local model for it: ${s.recommended.model} (${s.recommended.size}), `
        + `context ${s.recommended.ctx}, GPU offload ${s.gpuOffload ? 'on' : 'off'}. `
        + `Starter model that runs on anything: ${s.starter.model}.`;
}

// QoL — a one-line snapshot of the user's current settings so Cr1tt3r is aware of
// the system state (can answer "what theme am I on?" and avoid redundant changes).
function settingsSummary() {
    const onoff = (v) => (v ? 'on' : 'off');
    return 'Current settings — '
        + `AI engine: ${aiEngine()}; `
        + (aiEngine() === 'ollama' ? `Ollama model: ${settings.ollamaModel || '(none)'}; ` : '')
        + `theme: ${settings.theme || 'system'}; `
        + `CRT: ${onoff(settings.crtFx)}; glow: ${onoff(settings.glow)}; `
        + `reduce motion: ${onoff(settings.reduceMotion)}; text size: ${settings.uiScale || 1}; `
        + `VRAM saver: ${settings.vramSaverMode || 'auto'}; performance mode: ${onoff(settings.performanceMode)}; `
        + `update checks: ${onoff(settings.autoCheck)}; voice: ${onoff(settings.coreVoiceEnabled)}.`;
}

// Phase 13.2 / 16 — which local AI backend the desktop uses right now. Three
// engines: 'base' (tiny bundled Ollama model, default — runs on anything),
// 'lmstudio' (a model loaded in LM Studio), or 'ollama' (a LARGER model pulled
// through Ollama — a full LM Studio replacement for AVX1-only CPUs). aiEngine is
// authoritative; when empty we derive it from the legacy baseAiEnabled toggle.
function aiEngine() {
    if (settings.aiEngine === 'base' || settings.aiEngine === 'lmstudio' || settings.aiEngine === 'ollama') {
        return settings.aiEngine;
    }
    return settings.baseAiEnabled !== false ? 'base' : 'lmstudio';
}
function aiBackend() {
    const engine = aiEngine();
    if (engine === 'ollama') {
        return { baseUrl: OLLAMA_V1, model: settings.ollamaModel || BASE_AI_MODEL, kind: 'ollama' };
    }
    if (engine === 'base') {
        return { baseUrl: OLLAMA_V1, model: BASE_AI_MODEL, kind: 'base' };
    }
    return { baseUrl: LM_STUDIO_V1, model: settings.aiModel || 'local-model', kind: 'lmstudio' };
}

// Phase 16 — a "the AI isn't reachable yet" message tailored to the active engine.
function aiUnavailableMsg(be) {
    if (be.kind === 'base') {
        return 'The built-in AI isn\'t ready yet — it may still be downloading its model. Try again shortly (or check that Ollama is running).';
    }
    if (be.kind === 'ollama') {
        return `Ollama isn't reachable, or "${be.model}" isn't pulled yet. Make sure Ollama is running and pull the model from AI setup.`;
    }
    return 'LM Studio isn\'t reachable. Open LM Studio, load a model, then click "Start Server" (port 1234).';
}

// Phase 16 — CPU AVX support, read once. LM Studio needs AVX2; CPUs with only
// AVX1 (or neither) can't run it, so we steer those users to the Ollama engine.
let _avxCaps = null;
function cpuAvxCaps() {
    if (_avxCaps) return _avxCaps;
    let avx = true, avx2 = true;   // assume capable off-Linux / when unreadable
    try {
        const info = fs.readFileSync('/proc/cpuinfo', 'utf8');
        const flagsLine = info.split('\n').find((l) => l.startsWith('flags'));
        const flags = flagsLine ? (flagsLine.split(':')[1] || '') : '';
        if (flags) { avx = /\bavx\b/.test(flags); avx2 = /\bavx2\b/.test(flags); }
    } catch { /* keep the capable default */ }
    _avxCaps = { avx, avx2 };
    return _avxCaps;
}

// Pull the bundled base model if it isn't present yet (first desktop run). Runs
// only when the built-in AI is on; streams to the loading screen. Ollama must be
// installed + its service running (the installer enables it).
async function ensureBaseModel() {
    if (!IS_LINUX) return { ok: false, reason: 'not-linux' };
    if (settings.baseAiEnabled === false) return { ok: false, reason: 'base-ai-off' };
    const have = await runShell(`ollama list 2>/dev/null | grep -F "${BASE_AI_MODEL}"`, { timeout: 8000 });
    if (have.code === 0 && have.stdout.trim()) return { ok: true, present: true };
    // Not present — pull it (streamed to the loading screen).
    const labels = ['Preparing', 'Downloading model', 'Verifying', 'Finishing'];
    const matchers = [null, /pulling|downloading|manifest/i, /verifying|writing/i, /success/i];
    const r = await runStreamingJob('ollama', ['pull', BASE_AI_MODEL], labels, matchers);
    return { ok: r.ok, pulled: r.ok };
}

async function systemInfo() {
    const mem = memInfo();
    let kernel = os.release();
    let cpuModel = (os.cpus()[0] || {}).model || 'Unknown CPU';
    if (IS_LINUX) {
        const k = await runShell('uname -r'); if (k.code === 0) kernel = k.stdout;
        const c = await runShell("LC_ALL=C lscpu | sed -n 's/^Model name:[[:space:]]*//p'");
        if (c.code === 0 && c.stdout) cpuModel = c.stdout.split('\n')[0];
    }
    return {
        hostname: os.hostname(),
        kernel,
        cpu: cpuModel,
        cores: os.cpus().length,
        ramTotal: fmtGb(mem.totalKb),
        ramUsed: fmtGb(mem.usedKb),
        uptime: Math.round(os.uptime()),
        platform: process.platform,
        appVersion: APP_VERSION,
    };
}

function sendToast(msg) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('toast', msg);
    }
}

// ---------------------------------------------------------------------------
// AI orchestration: parse intent -> map to a safe action or a confirm request
// ---------------------------------------------------------------------------
// Phase 13: resolve an app name the AI was asked to install to a KNOWN source
// only — the curated Apps catalog first, then exact official-repo package names.
// Returns null for anything not in a known source (no arbitrary web downloads).
async function resolveInstallable(name) {
    const q = String(name || '').toLowerCase().trim().replace(/^install\s+/, '');
    if (!q) return null;
    const hit = APP_CATALOG.find((a) =>
        a.id === q || a.pkg === q || (a.label || '').toLowerCase() === q
        || a.id.includes(q) || (a.label || '').toLowerCase().includes(q));
    if (hit) return { pkg: hit.pkg, extra: hit.extra || [], label: hit.label, source: 'the Apps catalog' };
    // Official repos — EXACT package name first (validated, no shell metacharacters).
    if (IS_LINUX && /^[a-z0-9][a-z0-9._+-]*$/.test(q)) {
        const r = await runShell(`pacman -Si ${q}`, { timeout: 8000 });
        if (r.code === 0) return { pkg: q, extra: [], label: q, source: 'the official repositories' };
    }
    // Phase 15c — fuzzy fallback: search the repos for the best match so a DESCRIBED
    // need ("something to edit audio") or a slightly-off name still resolves to a
    // real, installable package. The user still confirms before anything installs.
    if (IS_LINUX && /^[a-z0-9][a-z0-9 ._+-]{0,39}$/i.test(q)) {
        const terms = q.split(/\s+/).filter(Boolean).map((w) => `'${w}'`).join(' ');
        const r = await runShell(`pacman -Ss ${terms}`, { timeout: 12000 });
        const line = (r.stdout || '').split('\n').find((l) => /^\w[\w-]*\/\S+\s+/.test(l));
        const m = line && line.match(/^\w[\w-]*\/(\S+)\s+/);
        if (m) return { pkg: m[1], extra: [], label: m[1], source: 'the official repositories', fuzzy: true };
    }
    return null;
}

// QoL — settings the AI is allowed to change on the user's behalf. Safe, reversible
// ones only (no auth / updater / sensitive keys). Booleans accept on/off synonyms;
// the rest are value allowlists. The renderer applies the patch via settings:set so
// all the usual side-effects (vram apply, theme mirror, auto-check restart) still run.
const AI_SETTABLE = {
    theme: { values: ['green', 'gold', 'broken'] },
    crtFx: { bool: true },
    glow: { bool: true },
    reduceMotion: { bool: true },
    performanceMode: { bool: true },
    vramSaverMode: { values: ['auto', 'off', 'lean', 'minimal'] },
    aiEngine: { values: ['base', 'lmstudio', 'ollama'] },
    autoCheck: { bool: true },
    coreVoiceEnabled: { bool: true },
    uiScale: { values: ['0.9', '1', '1.15', '1.3'] },
};

// Case-insensitive lookup into AI_SETTABLE (the tiny model often emits lowercase
// keys like "aiengine"/"performancemode", which a case-sensitive lookup rejected).
const _AI_SETTABLE_LC = Object.fromEntries(Object.keys(AI_SETTABLE).map((k) => [k.toLowerCase(), k]));

// Reverse map: an enum VALUE -> the single key it belongs to, but ONLY for values
// that are unambiguous (belong to exactly one settable key). This lets the AI (or
// the user) name the WRONG key and still land on the right setting — the classic
// case being "performanceMode=minimal" (performanceMode is on/off; "minimal" is a
// vramSaverMode value) or a bare "mode=lmstudio" -> aiEngine=lmstudio.
const _AI_VALUE_TO_KEY = (() => {
    const byVal = {};
    for (const [k, spec] of Object.entries(AI_SETTABLE)) {
        if (!spec.values) continue;
        for (const v of spec.values) (byVal[v] = byVal[v] || new Set()).add(k);
    }
    const out = {};
    for (const [v, keys] of Object.entries(byVal)) if (keys.size === 1) out[v] = [...keys][0];
    return out; // e.g. green->theme, lmstudio->aiEngine, lean/minimal/auto->vramSaverMode
})();

// Human-readable, per-key list of what the AI can change (kept in sync with
// AI_SETTABLE above) — used in the "couldn't apply that" message so the user/AI
// learns the exact accepted values instead of a vague rejection.
const AI_SETTABLE_HELP = 'theme=green|gold|broken, uiScale=0.9|1|1.15|1.3, '
    + 'crtFx/glow/reduceMotion/performanceMode/autoCheck/coreVoiceEnabled=on|off, '
    + 'vramSaverMode=auto|off|lean|minimal, aiEngine=base|lmstudio|ollama';

function parseSettingChange(arg) {
    // Accepts one OR MORE "key=value" pairs (the model sometimes batches them,
    // e.g. "aiEngine=lmstudio, vramSaverMode=minimal"). Keys are matched
    // case-insensitively; values allow a dot (uiScale=1.15) and a dash.
    const patch = {};
    const re = /([a-zA-Z]+)\s*[:=]\s*([a-zA-Z0-9.\-]+)/g;
    let m;
    while ((m = re.exec(String(arg || ''))) !== null) {
        const key = _AI_SETTABLE_LC[m[1].toLowerCase()];
        const val = m[2].toLowerCase();
        let applied = false;
        if (key) {
            const spec = AI_SETTABLE[key];
            if (spec.bool) {
                if (['on', 'true', 'yes', '1', 'enable', 'enabled'].includes(val)) { patch[key] = true; applied = true; }
                else if (['off', 'false', 'no', '0', 'disable', 'disabled'].includes(val)) { patch[key] = false; applied = true; }
            } else if (spec.values && spec.values.includes(val)) {
                patch[key] = val; applied = true;
            }
        }
        // The key was missing or its value didn't validate, but the VALUE alone
        // unambiguously names one setting — apply it there. Forgives the tiny
        // model's frequent "right value, wrong key" mistakes.
        if (!applied && _AI_VALUE_TO_KEY[val]) patch[_AI_VALUE_TO_KEY[val]] = val;
    }
    return Object.keys(patch).length ? patch : null;
}

// QoL — screens the AI may navigate to for the user (matches the sidebar).
const AI_SCREENS = ['dashboard', 'syscore', 'files', 'tasks', 'terminal',
    'gaming', 'gamedev', 'apps', 'ai', 'calc', 'settings', 'help'];

async function executeIntent(intent) {
    switch (intent.tool) {
        case 'system_info': {
            const i = await systemInfo();
            return { text: `${i.hostname} • ${i.cpu} (${i.cores} cores) • RAM ${i.ramUsed}/${i.ramTotal} • kernel ${i.kernel}`, did: 'system_info' };
        }
        case 'open_app': {
            const id = (intent.arg || '').toLowerCase().trim();
            const entry = APP_REGISTRY[id];
            if (!entry) return { text: `I don't have an app called "${intent.arg}". Try the launcher buttons.`, did: 'none' };
            const bin = await resolveBinary(entry);
            if (!bin) return { text: `${entry.label} isn't installed.`, did: 'none' };
            launchDetached(bin, entry.args);
            return { text: `Opening ${entry.label}.`, did: 'open_app' };
        }
        case 'search_web': {
            const q = encodeURIComponent(intent.arg || '');
            const url = `https://duckduckgo.com/?q=${q}`;
            const entry = APP_REGISTRY.browser;
            const bin = await resolveBinary(entry);
            if (bin) launchDetached(bin, [url]); else shell.openExternal(url);
            return { text: `Searching the web for "${intent.arg}".`, did: 'search_web' };
        }
        case 'list_files': {
            const dir = intent.arg && intent.arg.trim() ? intent.arg.trim() : os.homedir();
            const listing = await listFiles(dir);
            if (listing.error) return { text: listing.error, did: 'none' };
            const names = listing.entries.slice(0, 40).map((e) => (e.type === 'dir' ? e.name + '/' : e.name)).join('  ');
            return { text: `${listing.path}:\n${names || '(empty)'}`, did: 'list_files' };
        }
        case 'open_file': {
            const r = await openPath(intent.arg || '');
            return { text: r.ok ? `Opened ${intent.arg}.` : r.error, did: r.ok ? 'open_file' : 'none' };
        }
        case 'read_file': {
            // C1 — read-only file inspection. Cr1tt3r may READ files it has access
            // to (incl. config/system files) to answer or diagnose, but NEVER
            // alters them. Size-capped so a huge file can't blow up the prompt.
            const p = String(intent.arg || '').trim();
            if (!p) return { text: 'Which file? Give me a path.', did: 'none' };
            try {
                const st = fs.statSync(p);
                if (st.isDirectory()) return { text: `${p} is a folder — use list_files for that.`, did: 'none' };
                if (st.size > 256 * 1024) return { text: `${p} is ${Math.round(st.size / 1024)} KB — too big to read inline (cap ~256 KB).`, did: 'none' };
                const content = fs.readFileSync(p, 'utf8');
                return { text: `${p}:\n\n${content.slice(0, 8000)}${content.length > 8000 ? '\n…(truncated)' : ''}`, did: 'read_file' };
            } catch (e) {
                return { text: `Couldn't read ${p}: ${e.message}`, did: 'none' };
            }
        }
        case 'open_screen': {
            // QoL — let the assistant take the user to a section of the shell.
            const name = String(intent.arg || '').toLowerCase().trim();
            if (!AI_SCREENS.includes(name)) {
                return { text: 'I can open: ' + AI_SCREENS.join(', ') + '. There\'s no "' + (intent.arg || '') + '" screen.', did: 'none' };
            }
            return { did: 'open_screen', openScreen: name, text: intent.text || ('Opening ' + name + '.') };
        }
        case 'set_setting': {
            // QoL — let the assistant adjust a safe, reversible setting for the user.
            const patch = parseSettingChange(intent.arg || '');
            if (!patch) {
                return { text: 'I can change these (with their allowed values): ' + AI_SETTABLE_HELP
                    + '. I couldn\'t apply "' + (intent.arg || '') + '".', did: 'none' };
            }
            const key = Object.keys(patch)[0];
            // The renderer applies this through settings:set (full side-effects).
            return { did: 'set_setting', settingsPatch: patch, text: intent.text || ('Set ' + key + ' to ' + patch[key] + '.') };
        }
        case 'set_persona': {
            // C6 — the AI (on a user-loaded model) names itself. arg = "Name | description".
            const raw = String(intent.arg || '').trim();
            const parts = raw.split('|');
            const name = (parts[0] || '').trim().slice(0, 40);
            const desc = (parts[1] || '').trim().slice(0, 240);
            if (!name) return { text: intent.text || 'I need a name to go by.', did: 'none' };
            return {
                did: 'set_persona',
                settingsPatch: { aiPersonaName: name, aiPersonaDesc: desc },
                text: intent.text || ('Alright — call me ' + name + ' from now on.'),
            };
        }
        case 'system_action': {
            // C1 extension — let the AI drive the new one-tap features. These return
            // directives the renderer carries out (it owns the lock overlay + the
            // wired toggles, which update the UI + show confirms where appropriate).
            const a = String(intent.arg || '').trim().toLowerCase();
            switch (a) {
                case 'lock': return { did: 'system_action', lockScreen: true, text: intent.text || 'Locking the screen.' };
                case 'sleep': return { did: 'system_action', suspend: true, text: intent.text || 'Going to sleep — press a key or the power button to wake.' };
                case 'airplane_on': return { did: 'system_action', airplane: true, text: intent.text || 'Airplane mode on — radios off.' };
                case 'airplane_off': return { did: 'system_action', airplane: false, text: intent.text || 'Airplane mode off.' };
                case 'storage_ram_on': return { did: 'system_action', swap: true, text: intent.text || 'Setting up storage as extra memory…' };
                case 'storage_ram_off': return { did: 'system_action', swap: false, text: intent.text || 'Turning off storage-as-memory.' };
                case 'night_light_on': case 'night_light_off': {
                    const on = a === 'night_light_on';
                    if (IS_LINUX && on) {
                        const have = await runShell('command -v gammastep >/dev/null 2>&1 && echo yes', { timeout: 3000 });
                        if (!/yes/.test(have.stdout || '')) return { did: 'system_action', text: 'Night light needs the gammastep package, which isn\'t installed yet.' };
                    }
                    applyNightLight(on, settings.nightLightTemp);
                    settings = saveSettings({ ...settings, nightLight: on });
                    return { did: 'system_action', text: intent.text || ('Night light ' + (on ? 'on — warmer colors.' : 'off.')) };
                }
                case 'dnd_on': case 'dnd_off': {
                    const on = a === 'dnd_on';
                    applyDnd(on);
                    settings = saveSettings({ ...settings, dnd: on });
                    return { did: 'system_action', text: intent.text || (on ? 'Do Not Disturb on — notifications paused.' : 'Do Not Disturb off.') };
                }
                case 'report_problem':
                    return { did: 'system_action', openReport: true, text: intent.text || 'Opening the problem reporter — collect the log and send it.' };
                case 'check_updates': {
                    // Read-only: check GitHub for a newer Outlaw Server shell release + report.
                    try {
                        const info = await updater.checkShellUpdate({
                            repo: settings.updateRepo,
                            currentVersion: APP_VERSION,
                            channel: settings.updateChannel || 'stable',
                        });
                        if (!info) return { did: 'system_action', text: 'Couldn\'t check for updates right now.' };
                        return { did: 'system_action', text: info.available
                            ? `Update available: v${info.remoteVersion} (you have v${info.currentVersion}). Open Settings → Outlaw Shell Updates to install it.`
                            : `You're up to date (v${info.currentVersion}).` };
                    } catch (e) {
                        return { did: 'system_action', text: 'Update check failed — ' + ((e && e.message) || e) + ' (are you online?)' };
                    }
                }
                default: return { did: 'none', text: 'I can lock the screen, sleep, toggle airplane mode, night light, Do Not Disturb, or storage-as-memory, or check for updates — which one?' };
            }
        }
        case 'install_app': {
            // Phase 13: only ever install from a KNOWN source, and only after the
            // user confirms. Hand a proposal back to the UI (same rail as run_command).
            const resolved = await resolveInstallable(intent.arg || '');
            if (!resolved) {
                return { text: `I can only install from known sources (the Apps catalog or the official repositories), and I couldn't find "${intent.arg}" there. You can browse the Apps page instead.`, did: 'none' };
            }
            const proposal = resolved.fuzzy
                ? `Closest match I found is "${resolved.label}" in ${resolved.source}. Confirm to install it (or browse the Apps page for more).`
                : (intent.text || `I can install ${resolved.label} from ${resolved.source}. Confirm to proceed.`);
            return {
                needsConfirm: true,
                action: { tool: 'install_app', pkg: resolved.pkg, extra: resolved.extra || [], label: resolved.label, source: resolved.source },
                text: proposal,
            };
        }
        case 'run_command':
            // Never auto-run. Hand back to UI for explicit confirmation.
            return {
                needsConfirm: true,
                action: { tool: 'run_command', arg: intent.arg || '' },
                classify: classifyCommand(intent.arg || ''),
                text: intent.text || 'I can run this command if you confirm.',
            };
        case 'answer':
        default:
            return { text: intent.text || '...', did: 'answer' };
    }
}

// ---------------------------------------------------------------------------
// File helpers (read-only listing + safe open)
// ---------------------------------------------------------------------------
async function listFiles(dir) {
    try {
        const real = path.resolve(dir);
        const entries = fs.readdirSync(real, { withFileTypes: true })
            .filter((d) => !d.name.startsWith('.'))
            .map((d) => {
                let size = 0;
                try { size = d.isFile() ? fs.statSync(path.join(real, d.name)).size : 0; } catch {}
                return { name: d.name, type: d.isDirectory() ? 'dir' : 'file', size };
            })
            .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
        return { path: real, parent: path.dirname(real), entries };
    } catch (e) {
        return { path: dir, entries: [], error: `Cannot open ${dir}: ${e.code || e.message}` };
    }
}

async function openPath(target) {
    try {
        const real = path.resolve(target);
        if (!fs.existsSync(real)) return { ok: false, error: `Not found: ${target}` };
        const err = await shell.openPath(real); // never goes through a shell -> no injection
        return err ? { ok: false, error: err } : { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// ---- Phase 5: process control (End task / End process tree) ----------------
function toPid(x) { const n = parseInt(x, 10); return Number.isInteger(n) && n > 1 ? n : 0; }

// All descendants of `root` (inclusive), leaves-first, so children die before
// their parents. Single `ps` call; pure parse — no shell expansion of the pid.
async function descendantPids(root) {
    if (!IS_LINUX) return [root];
    const r = await runShell('ps -eo pid=,ppid=');
    const kids = new Map();
    for (const line of (r.stdout || '').split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (!m) continue;
        const pid = parseInt(m[1], 10), ppid = parseInt(m[2], 10);
        if (!kids.has(ppid)) kids.set(ppid, []);
        kids.get(ppid).push(pid);
    }
    const order = [];
    const seen = new Set();
    (function walk(p) {
        if (seen.has(p)) return;          // guard against any ppid cycle
        seen.add(p);
        for (const c of (kids.get(p) || [])) walk(c);
        order.push(p);                    // post-order = leaves first
    })(root);
    return order;
}

function killPids(pids, signal) {
    let killed = 0; const errors = [];
    for (const pid of pids) {
        if (!pid || pid <= 1) continue;   // never SIGKILL init
        try { process.kill(pid, signal); killed++; }
        catch (e) {
            if (e.code === 'ESRCH') continue;                 // already gone
            errors.push(e.code === 'EPERM' ? `${pid}: needs admin` : `${pid}: ${e.code || e.message}`);
        }
    }
    return { ok: errors.length === 0, killed, errors };
}

// ---- Phase 12: streamed long-job runner (drives the loading screen) --------
// Spawns a command and streams its output to the renderer's loading screen via
// 'job-progress' events: { phases:[labels] } once at the start, { phase:i } as
// recognised markers go by, { log:line } per output line, { done, ok } at exit.
// Resolves { ok, code } so the caller still gets a final verdict.
function runStreamingJob(cmd, args, phaseLabels, phaseMatchers) {
    return new Promise((resolve) => {
        const send = (p) => {
            try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('job-progress', p); }
            catch { /* window gone */ }
        };
        send({ phases: phaseLabels, phase: 0 });
        let phase = 0, child;
        try { child = spawn(cmd, args); }
        catch (e) { send({ log: 'error: ' + e.message, done: true, ok: false }); return resolve({ ok: false, error: e.message }); }
        // Register with trackedProcs so the emergency stop (Ctrl+Alt+K ->
        // killAllTrackedProcs) can actually kill these long, hang-prone jobs
        // (AI-confirmed installs, drivers:apply, ollama pulls). Without this they
        // were invisible to the escape hatch — the exact case it exists for.
        trackedProcs.add(child);
        const onData = (buf) => {
            for (const raw of String(buf).split('\n')) {
                const line = raw.replace(/\s+$/, '');
                if (!line) continue;
                for (let i = phase + 1; i < phaseMatchers.length; i++) {
                    if (phaseMatchers[i] && phaseMatchers[i].test(line)) { phase = i; send({ phase }); break; }
                }
                send({ log: line.slice(0, 200) });
            }
        };
        child.stdout && child.stdout.on('data', onData);
        child.stderr && child.stderr.on('data', onData);
        child.on('error', (e) => { trackedProcs.delete(child); send({ log: 'error: ' + e.message, done: true, ok: false }); resolve({ ok: false, error: e.message }); });
        child.on('close', (code) => { trackedProcs.delete(child); send({ phase: phaseLabels.length - 1, done: true, ok: code === 0 }); resolve({ ok: code === 0, code }); });
    });
}

// ---------------------------------------------------------------------------
// Keyboard layouts — a curated allowlist (code -> label). The renderer can only
// pick a code from THIS list; it can never pass an arbitrary string to setxkbmap,
// so there's no injection surface. Codes are standard XKB layout names.
// ---------------------------------------------------------------------------
const KB_LAYOUTS = [
    { code: 'us', label: 'English (US)' },
    { code: 'gb', label: 'English (UK)' },
    { code: 'de', label: 'German' },
    { code: 'fr', label: 'French' },
    { code: 'es', label: 'Spanish' },
    { code: 'it', label: 'Italian' },
    { code: 'pt', label: 'Portuguese' },
    { code: 'br', label: 'Portuguese (Brazil)' },
    { code: 'latam', label: 'Spanish (Latin America)' },
    { code: 'dk', label: 'Danish' },
    { code: 'no', label: 'Norwegian' },
    { code: 'se', label: 'Swedish' },
    { code: 'fi', label: 'Finnish' },
    { code: 'pl', label: 'Polish' },
    { code: 'cz', label: 'Czech' },
    { code: 'hu', label: 'Hungarian' },
    { code: 'ru', label: 'Russian' },
    { code: 'ua', label: 'Ukrainian' },
    { code: 'tr', label: 'Turkish' },
    { code: 'gr', label: 'Greek' },
    { code: 'nl', label: 'Dutch' },
    { code: 'be', label: 'Belgian' },
    { code: 'ch', label: 'Swiss' },
    { code: 'ca', label: 'Canadian' },
];
function _isKbLayout(code) { return KB_LAYOUTS.some((l) => l.code === code); }
// Apply a keyboard layout for the whole X session (setxkbmap is session-global).
// Silently no-ops off-Linux / if the code isn't in the allowlist.
function applyKbLayout(code) {
    if (!IS_LINUX || !code || !_isKbLayout(code)) return;
    try { execFile('setxkbmap', [code], () => {}); } catch { /* setxkbmap absent */ }
}

// ----- Tier-2 desktop QOL: night light + Do Not Disturb -----------------
// Night light warms the screen via gammastep's one-shot manual mode: `-O TEMP`
// sets the X gamma ramp and exits (no lingering daemon), `-x` resets to neutral.
// This is an unprivileged, per-session gamma-ramp op — the worst case is a wrong
// tint that `-x` (or the next login) clears, so it can NEVER strand the boot.
function applyNightLight(on, temp) {
    if (!IS_LINUX) return;
    const t = Math.max(2000, Math.min(6500, Number(temp) || 4000));
    try {
        if (on) execFile('gammastep', ['-P', '-O', String(t)], () => {});
        else execFile('gammastep', ['-x'], () => {});
    } catch { /* gammastep absent — night light is a no-op until installed */ }
}

// Do Not Disturb toggles dunst's paused state. dunstctl ships with dunst (the
// notification daemon we bundle). Best-effort — if dunst isn't up yet the call
// no-ops and the saved state re-applies next time it's toggled.
function applyDnd(on) {
    if (!IS_LINUX) return;
    try { execFile('dunstctl', ['set-paused', on ? 'true' : 'false'], () => {}); } catch { /* dunst absent */ }
}

// ----- Power management: screen blank + system-wide idle watch ------------
// Screen blanking uses the X screensaver + DPMS timers (xset). -1 = leave the
// X defaults alone (~10 min blank), 0 = never blank, N = blank after N minutes.
// Session-scoped and unprivileged: a wrong value blanks a screen that any key
// press wakes, so this can never strand the machine.
function applyScreenBlank(min) {
    if (!IS_LINUX) return;
    const m = Number(min);
    if (!Number.isFinite(m) || m < 0) return;          // -1 / unset — don't touch X
    try {
        if (m === 0) {
            execFile('xset', ['s', 'off'], () => {});
            execFile('xset', ['-dpms'], () => {});
        } else {
            const sec = String(Math.round(m * 60));
            execFile('xset', ['s', sec, sec], () => {});
            execFile('xset', ['dpms', sec, sec, sec], () => {});
        }
    } catch { /* xset absent (non-X session) — no-op */ }
}

// Reverting to "System default" (-1) mid-session: applyScreenBlank(-1) is a
// no-op by design (boot must not clobber any session defaults), so an explicit
// restore puts back the X stock behavior (~10-min blank, DPMS on) right away
// instead of waiting for the next login.
function restoreScreenBlankDefaults() {
    if (!IS_LINUX) return;
    try {
        execFile('xset', ['s', 'default'], () => {});
        execFile('xset', ['+dpms'], () => {});
        execFile('xset', ['dpms', '600', '600', '600'], () => {});
    } catch { /* xset absent — no-op */ }
}

// ----- Display settings (xrandr) + brightness (backlight sysfs) -----------
// THE safety design for the one feature that can black-screen a machine:
//   * only modes the display ITSELF advertises (parsed from xrandr) can be
//     applied — arbitrary modelines never exist here;
//   * every apply arms a MAIN-PROCESS 15s revert timer. If the user doesn't
//     confirm (because the screen went black / unusable), main restores the
//     previous mode on its own — a wedged or invisible renderer can't stop it;
//   * boot re-apply only uses modes the user explicitly KEPT, re-validated
//     against what xrandr lists at that moment (monitor swapped = skip).
function _parseXrandr(out) {
    const outputs = [];
    let cur = null;
    for (const line of String(out || '').split('\n')) {
        const head = line.match(/^(\S+) (connected|disconnected)\b(.*)$/);
        if (head) {
            if (head[2] === 'connected') {
                cur = { name: head[1], primary: /\bprimary\b/.test(head[3]), current: null, modes: [] };
                outputs.push(cur);
            } else cur = null;
            continue;
        }
        if (!cur) continue;
        const m = line.match(/^\s+(\d+x\d+i?)\s+(.+)$/);
        if (!m) continue;
        const rates = [];
        for (const tok of m[2].trim().split(/\s+/)) {
            const r = tok.match(/^(\d+(?:\.\d+)?)([*+]*)$/);
            if (!r) continue;
            rates.push(r[1]);
            if (r[2].includes('*')) cur.current = { mode: m[1], rate: r[1] };
        }
        if (rates.length) cur.modes.push({ mode: m[1], rates });
    }
    return outputs;
}
async function _displayInfo() {
    const r = await runShell('xrandr --query 2>/dev/null', { timeout: 5000 });
    return _parseXrandr(r.stdout);
}
function _xrandrApply(output, mode, rate) {
    return new Promise((resolve) => {
        const args = ['--output', output, '--mode', mode];
        if (rate) args.push('--rate', rate);
        execFile('xrandr', args, { timeout: 10000 },
            (err, so, se) => resolve({ ok: !err, error: (se || so || (err && err.message) || '').trim().slice(0, 200) }));
    });
}
let _dispRevert = null;   // { timer, output, prevMode, prevRate } while a confirm window is open
function _dispDoRevert() {
    const s = _dispRevert;
    if (!s) return;
    _dispRevert = null;
    clearTimeout(s.timer);
    if (s.prevMode) _xrandrApply(s.output, s.prevMode, s.prevRate);
    else execFile('xrandr', ['--output', s.output, '--auto'], { timeout: 10000 }, () => {});
}
function _backlightDir() {
    try {
        const base = '/sys/class/backlight';
        const first = fs.readdirSync(base).filter(Boolean)[0];
        return first ? `${base}/${first}` : null;
    } catch { return null; }
}
function applyBrightnessPct(pct) {
    if (!IS_LINUX) return { ok: false, error: 'Brightness runs on Outlaw Server.' };
    const dir = _backlightDir();
    if (!dir) return { ok: false, error: 'No controllable backlight on this machine.' };
    // Floor 5% — the slider can dim, never black the screen entirely.
    const p = Math.max(5, Math.min(100, Math.round(Number(pct) || 0)));
    try {
        const max = parseInt(fs.readFileSync(`${dir}/max_brightness`, 'utf8').trim(), 10);
        if (!isFinite(max) || max <= 0) return { ok: false, error: 'Backlight reports no range.' };
        fs.writeFileSync(`${dir}/brightness`, String(Math.max(1, Math.round(max * p / 100))));
        return { ok: true, pct: p };
    } catch (e) {
        const perm = e && (e.code === 'EACCES' || e.code === 'EPERM');
        return { ok: false, error: perm
            ? 'No permission to change the backlight — the udev rule is missing (fresh-install a current ISO).'
            : 'Couldn\'t set brightness: ' + ((e && e.message) || e) };
    }
}

// System-wide idle watch for auto-lock and auto-sleep. Uses Electron's
// powerMonitor.getSystemIdleTime() — X-server-wide idle, so activity in ANY
// window (a fullscreen game, a terminal) counts, not just activity inside the
// shell window. Design constraints:
//   * zero-idle-cost: the interval only exists while a timeout is enabled;
//     both disabled (the default) = no timer at all.
//   * fire-once + re-arm-on-activity: each action fires at most once per idle
//     stretch and re-arms only after idle drops back under 30s. Even a stuck
//     or bogus idle counter can therefore never lock/suspend-loop the machine.
//   * lock is delegated to the renderer (it owns the PIN/sign-in overlay and
//     re-checks hasPin/live/already-locked before acting).
let idleWatchTimer = null;
let _idleLockFired = false;
let _idleSleepFired = false;
function syncIdleWatch() {
    const lockMin = Math.max(0, Number(settings.autoLockMin) || 0);
    const sleepMin = Math.max(0, Number(settings.autoSleepMin) || 0);
    if (idleWatchTimer) { clearInterval(idleWatchTimer); idleWatchTimer = null; }
    _idleLockFired = false; _idleSleepFired = false;
    if (!lockMin && !sleepMin) return;
    idleWatchTimer = setInterval(() => {
        let idle = 0;
        try { idle = powerMonitor.getSystemIdleTime(); } catch { return; }
        if (idle < 30) { _idleLockFired = false; _idleSleepFired = false; return; }
        if (lockMin && !_idleLockFired && idle >= lockMin * 60) {
            _idleLockFired = true;
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('idle-lock');
        }
        if (sleepMin && !_idleSleepFired && idle >= sleepMin * 60) {
            // Never suspend under a live tracked job — an install / update /
            // model download would lose its network connections overnight.
            // Not marked fired, so it re-checks each tick until the job ends.
            if (trackedProcs.size > 0) return;
            _idleSleepFired = true;
            // Standard OS behavior: wake up to a lock screen. Fire the lock
            // now (if the user has auto-lock on) so the desktop is covered
            // before + after the suspend, regardless of which timeout is longer.
            if (lockMin && !_idleLockFired && mainWindow && !mainWindow.isDestroyed()) {
                _idleLockFired = true;
                mainWindow.webContents.send('idle-lock');
            }
            if (IS_LINUX) {
                runShell('systemctl suspend', { timeout: 10000 }).then((r) => {
                    if (r.code !== 0) errorlog.append('warn', 'power', 'auto-sleep suspend failed: ' + (r.stderr || r.stdout || 'unknown').slice(-160));
                }).catch(() => {});
            }
        }
    }, 30000);
}

// ---------------------------------------------------------------------------
// The server operations registry — ONE implementation, TWO transports
// ---------------------------------------------------------------------------
// Server features (services, journal, storage, remote access, firewall…) live
// in outlaw-serverd/ops.js. The browser panel reaches them over POST /rpc; this
// makes the SAME registry reachable from the Electron panel over IPC.
//
// Writing each server feature twice — once as an ipcMain handler and once as a
// daemon op — is how the two frontends drift apart, and drift here means the
// local console and the remote browser disagree about what the machine is
// doing. One registry, two ways in.
const serverOps = (() => {
    const candidates = [
        // Installed layout: shell at /usr/share/outlaw-os, daemon alongside it.
        '/usr/share/outlaw-serverd/ops.js',
        // Repo layout, for running the shell straight out of a checkout.
        path.join(__dirname, '..', 'outlaw-serverd', 'ops.js'),
    ];
    for (const p of candidates) {
        try { if (fs.existsSync(p)) return require(p); } catch { /* try the next */ }
    }
    return null;
})();

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
function registerIpc() {
    // Generic passthrough to the operations registry. This grants no privilege
    // the renderer doesn't already have by name (power:reboot, proc:kill and
    // services:action are all exposed individually above/below), and dispatch()
    // refuses any name that isn't an own property of the registry, so it can't
    // be walked into a prototype.
    ipcMain.handle('ops:dispatch', async (_e, op, args) => {
        if (!serverOps) {
            return { ok: false, error: 'The server operations module is not installed on this machine.' };
        }
        try {
            return await serverOps.dispatch(String(op || ''), args || {}, {
                version: APP_VERSION, mode: 'panel', bind: 'electron-ipc',
            });
        } catch (e) {
            return { ok: false, error: (e && e.message) || String(e) };
        }
    });

    ipcMain.handle('system:info', () => systemInfo());

    // ----- Keyboard layout -------------------------------------------------
    ipcMain.handle('kb:list', () => KB_LAYOUTS);
    ipcMain.handle('kb:status', async () => {
        const saved = settings.kbLayout || '';
        if (!IS_LINUX) return { current: saved || 'us', saved };
        const r = await runShell('setxkbmap -query 2>/dev/null | awk \'/^layout:/{print $2}\'', { timeout: 3000 });
        const current = (r.stdout || '').split(',')[0].trim() || 'us';
        return { current, saved };
    });
    ipcMain.handle('kb:set', async (_e, code) => {
        if (!_isKbLayout(code)) return { ok: false, error: 'Unknown keyboard layout.' };
        if (IS_LINUX) {
            const r = await runShell(`setxkbmap ${code}`, { timeout: 4000 });
            if (r.code !== 0) return { ok: false, error: (r.stderr || 'setxkbmap failed').slice(-200) };
        }
        settings = saveSettings({ ...settings, kbLayout: code });
        return { ok: true, code };
    });

    // ----- Date / time / timezone -----------------------------------------
    // Reads are unprivileged; setting the zone / NTP goes through pkexec
    // (polkit prompts once). The timezone is validated against the real zone
    // list before it's handed to timedatectl, so no arbitrary argument.
    ipcMain.handle('time:status', async () => {
        if (!IS_LINUX) return { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', ntp: true, local: new Date().toString() };
        const tz = (await runShell('timedatectl show -p Timezone --value 2>/dev/null', { timeout: 3000 })).stdout.trim() || 'UTC';
        const ntp = (await runShell('timedatectl show -p NTP --value 2>/dev/null', { timeout: 3000 })).stdout.trim() === 'yes';
        const local = (await runShell('date 2>/dev/null', { timeout: 3000 })).stdout.trim();
        return { timezone: tz, ntp, local };
    });
    ipcMain.handle('time:zones', async () => {
        if (!IS_LINUX) return ['UTC', 'America/Chicago', 'America/New_York', 'Europe/London'];
        const r = await runShell('timedatectl list-timezones 2>/dev/null', { timeout: 5000 });
        return (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
    });
    ipcMain.handle('time:set-zone', async (_e, tz) => {
        if (!IS_LINUX) return { ok: true };
        // Validate against the real zone list — never pass an arbitrary string to pkexec.
        const zones = (await runShell('timedatectl list-timezones 2>/dev/null', { timeout: 5000 })).stdout.split('\n').map((s) => s.trim());
        if (!zones.includes(tz)) return { ok: false, error: 'Unknown timezone.' };
        const r = await runShell(`pkexec timedatectl set-timezone ${JSON.stringify(tz)}`, { timeout: 15000 });
        if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout || 'Could not set the timezone.').slice(-200) };
        return { ok: true, timezone: tz };
    });
    ipcMain.handle('time:set-ntp', async (_e, on) => {
        if (!IS_LINUX) return { ok: true };
        const r = await runShell(`pkexec timedatectl set-ntp ${on ? 'true' : 'false'}`, { timeout: 15000 });
        if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout || 'Could not change auto-time.').slice(-200) };
        return { ok: true, ntp: !!on };
    });

    // ----- Bluetooth -------------------------------------------------------
    // Pairing/managing devices is handled by blueman (the standard GTK Bluetooth
    // manager) which we bundle — reimplementing the full BT stack in the shell
    // would be fragile. Here we report status, power the adapter on/off, and open
    // the manager. Power uses rfkill (no root needed for the user's own session).
    ipcMain.handle('bt:status', async () => {
        if (!IS_LINUX) return { present: false, powered: false };
        const r = await runShell('rfkill list bluetooth 2>/dev/null', { timeout: 3000 });
        const out = r.stdout || '';
        const present = /bluetooth/i.test(out);
        const powered = present && !/Soft blocked:\s*yes/i.test(out);
        return { present, powered };
    });
    ipcMain.handle('bt:power', async (_e, on) => {
        if (!IS_LINUX) return { ok: true, powered: !!on };
        await runShell(`rfkill ${on ? 'unblock' : 'block'} bluetooth 2>/dev/null`, { timeout: 5000 });
        if (on) await runShell('bluetoothctl power on 2>/dev/null || true', { timeout: 4000 });
        return { ok: true, powered: !!on };
    });
    ipcMain.handle('bt:manage', async () => {
        if (!IS_LINUX) return { ok: false, error: 'Bluetooth manager runs on Outlaw Server.' };
        // Confirm the manager is actually installed before claiming success, then
        // make sure the adapter is unblocked and open the pairing GUI (blueman).
        const have = await runShell('command -v blueman-manager >/dev/null 2>&1 && echo yes', { timeout: 3000 });
        if (!/yes/.test(have.stdout || '')) return { ok: false, error: 'The Bluetooth manager (blueman) isn\'t installed yet.' };
        await runShell('rfkill unblock bluetooth 2>/dev/null || true', { timeout: 4000 });
        try { const c = spawn('blueman-manager', [], { detached: true, stdio: 'ignore' }); c.on('error', () => {}); c.unref(); }
        catch { return { ok: false, error: 'Could not open the Bluetooth manager.' }; }
        return { ok: true };
    });

    // ----- Display settings + brightness -----------------------------------
    ipcMain.handle('display:info', async () => {
        if (!IS_LINUX) return { supported: false, outputs: [] };
        const outputs = await _displayInfo();
        return { supported: true, outputs, pending: !!_dispRevert };
    });
    ipcMain.handle('display:set-mode', async (_e, payload) => {
        if (!IS_LINUX) return { ok: false, error: 'Display settings run on Outlaw Server.' };
        if (_dispRevert) return { ok: false, error: 'Confirm or revert the pending change first.' };
        const output = String((payload && payload.output) || '');
        const mode = String((payload && payload.mode) || '');
        const rate = String((payload && payload.rate) || '');
        // Validate EVERYTHING against what xrandr itself lists right now.
        const outputs = await _displayInfo();
        const o = outputs.find((x) => x.name === output);
        if (!o) return { ok: false, error: 'Unknown display output.' };
        const mm = o.modes.find((x) => x.mode === mode);
        if (!mm) return { ok: false, error: 'That display doesn\'t list that mode.' };
        if (rate && !mm.rates.includes(rate)) return { ok: false, error: 'That mode doesn\'t list that refresh rate.' };
        const prev = o.current || null;
        const r = await _xrandrApply(output, mode, rate);
        if (!r.ok) return { ok: false, error: r.error || 'xrandr rejected the mode.' };
        // Arm the MAIN-SIDE auto-revert — fires even if the renderer never
        // comes back. 15s + a little slack over the renderer's countdown.
        _dispRevert = {
            output,
            prevMode: prev && prev.mode,
            prevRate: prev && prev.rate,
            timer: setTimeout(_dispDoRevert, 15500),
        };
        return { ok: true, revertSeconds: 15 };
    });
    ipcMain.handle('display:confirm-mode', async (_e, payload) => {
        const s = _dispRevert;
        if (!s) return { ok: false, error: 'Nothing to confirm.' };
        clearTimeout(s.timer);
        _dispRevert = null;
        // Persist ONLY user-kept modes; boot re-applies them after re-validation.
        const output = String((payload && payload.output) || s.output);
        const mode = String((payload && payload.mode) || '');
        const rate = String((payload && payload.rate) || '');
        if (mode) {
            const dm = { ...(settings.displayModes || {}) };
            dm[output] = { mode, rate };
            settings = saveSettings({ ...settings, displayModes: dm });
        }
        return { ok: true };
    });
    ipcMain.handle('display:revert-mode', async () => {
        if (!_dispRevert) return { ok: false, error: 'Nothing to revert.' };
        _dispDoRevert();
        return { ok: true };
    });
    ipcMain.handle('display:reset-auto', async () => {
        if (!IS_LINUX) return { ok: false, error: 'Display settings run on Outlaw Server.' };
        if (_dispRevert) _dispDoRevert();
        // Back to every output's preferred mode — the always-safe baseline —
        // and stop re-applying saved modes at boot.
        const r = await runShell('xrandr --auto 2>&1', { timeout: 10000 });
        settings = saveSettings({ ...settings, displayModes: {} });
        return { ok: r.code === 0, error: r.code === 0 ? '' : (r.stdout || '').slice(0, 200) };
    });
    ipcMain.handle('display:brightness-info', () => {
        if (!IS_LINUX) return { present: false };
        const dir = _backlightDir();
        if (!dir) return { present: false };
        try {
            const max = parseInt(fs.readFileSync(`${dir}/max_brightness`, 'utf8').trim(), 10);
            const cur = parseInt(fs.readFileSync(`${dir}/brightness`, 'utf8').trim(), 10);
            if (!isFinite(max) || max <= 0) return { present: false };
            let writable = true;
            try { fs.accessSync(`${dir}/brightness`, fs.constants.W_OK); } catch { writable = false; }
            return { present: true, pct: Math.max(1, Math.round(cur / max * 100)), writable };
        } catch { return { present: false }; }
    });
    ipcMain.handle('display:set-brightness', async (_e, pct) => {
        const r = applyBrightnessPct(pct);
        if (r.ok) settings = saveSettings({ ...settings, brightnessPct: r.pct });
        return r;
    });

    // ----- Night light (warm color-temperature filter) --------------------
    ipcMain.handle('nightlight:status', () => ({
        on: !!settings.nightLight,
        temp: Math.max(2000, Math.min(6500, Number(settings.nightLightTemp) || 4000)),
        supported: IS_LINUX,
    }));
    ipcMain.handle('nightlight:set', async (_e, payload) => {
        const on = !!(payload && payload.on);
        const temp = Math.max(2000, Math.min(6500,
            Number(payload && payload.temp) || Number(settings.nightLightTemp) || 4000));
        if (IS_LINUX && on) {
            const have = await runShell('command -v gammastep >/dev/null 2>&1 && echo yes', { timeout: 3000 });
            if (!/yes/.test(have.stdout || '')) return { ok: false, error: 'Night light needs the gammastep package, which isn\'t installed yet.' };
        }
        applyNightLight(on, temp);
        settings = saveSettings({ ...settings, nightLight: on, nightLightTemp: temp });
        return { ok: true, on, temp };
    });

    // ----- Notifications: Do Not Disturb ----------------------------------
    ipcMain.handle('notif:dnd-status', async () => {
        if (!IS_LINUX) return { paused: !!settings.dnd, supported: false };
        const r = await runShell('dunstctl is-paused 2>/dev/null', { timeout: 3000 });
        const out = (r.stdout || '').trim();
        return { paused: /true/i.test(out), supported: /^(true|false)$/i.test(out) };
    });
    ipcMain.handle('notif:dnd-set', async (_e, on) => {
        if (IS_LINUX) {
            const have = await runShell('command -v dunstctl >/dev/null 2>&1 && echo yes', { timeout: 3000 });
            if (!/yes/.test(have.stdout || '')) return { ok: false, error: 'The notification daemon (dunst) isn\'t running.' };
            await runShell(`dunstctl set-paused ${on ? 'true' : 'false'} 2>/dev/null`, { timeout: 3000 });
        }
        settings = saveSettings({ ...settings, dnd: !!on });
        return { ok: true, paused: !!on };
    });
    ipcMain.handle('notif:show-last', async () => {
        if (!IS_LINUX) return { ok: false };
        // Re-display the most recently dismissed notification (unpause first so it
        // actually appears even while DND is on).
        await runShell('dunstctl set-paused false 2>/dev/null && dunstctl history-pop 2>/dev/null', { timeout: 3000 });
        // Restore the user's DND choice after popping.
        if (settings.dnd) await runShell('dunstctl set-paused true 2>/dev/null', { timeout: 2000 });
        return { ok: true };
    });
    ipcMain.handle('notif:history', async () => {
        if (!IS_LINUX) return { supported: false, items: [] };
        // dunstctl history returns {"data": [[ {appname:{data}, summary:{data}, ...} ]]}.
        // Read-only; body text is renderer-escaped before display.
        const r = await runShell('dunstctl history 2>/dev/null', { timeout: 3000 });
        try {
            const j = JSON.parse(r.stdout || '');
            const arr = (j && Array.isArray(j.data) && Array.isArray(j.data[0])) ? j.data[0] : [];
            // Cap every field (a hostile local notify-send can carry multi-MB
            // strings) and skip malformed entries instead of failing the lot.
            const items = arr.slice(0, 20)
                .filter((n) => n && typeof n === 'object')
                .map((n) => ({
                    app: String((n.appname && n.appname.data) || '').slice(0, 80),
                    summary: String((n.summary && n.summary.data) || '').slice(0, 200),
                    body: String((n.body && n.body.data) || '').slice(0, 300),
                })).filter((n) => n.summary || n.body);
            return { supported: true, items };
        } catch { return { supported: false, items: [] }; }
    });

    // Phase 8: real boot messages for the cinematic boot screen. journalctl
    // -o cat = message text only (no timestamps); falls back to dmesg. Read-only
    // and unprivileged — returns [] if neither is readable, and the boot screen
    // just shows its synthetic lines instead.
    ipcMain.handle('system:boot-log', async () => {
        if (!IS_LINUX) return [];
        let r = await runShell('journalctl -b --no-pager -o cat -n 14 2>/dev/null');
        let out = (r.stdout || '').trim();
        if (!out) { r = await runShell('dmesg 2>/dev/null | tail -n 14'); out = (r.stdout || '').trim(); }
        return out ? out.split('\n').map((l) => l.replace(/\s+$/, '').slice(0, 92)).filter(Boolean) : [];
    });

    ipcMain.handle('system:stats', () => {
        const mem = memInfo();
        return { cpu: cpuPercent(), ramPct: mem.totalKb ? (mem.usedKb / mem.totalKb) * 100 : 0,
                 ramUsed: fmtGb(mem.usedKb), ramTotal: fmtGb(mem.totalKb), time: new Date().toLocaleTimeString() };
    });

    ipcMain.handle('system:processes', async () => {
        if (!IS_LINUX) return [{ pid: process.pid, comm: 'electron', cpu: '0.0', mem: '0.0', memMb: 0 }];
        // rss (KB) gives a Windows-style MB column. Return ALL processes (sorted
        // by CPU) so the user can filter/scroll to find any app to end — capped
        // at 250 so the render stays cheap on busy systems.
        const r = await runShell('ps -eo pid,comm,pcpu,pmem,rss --sort=-pcpu');
        return r.stdout.split('\n').slice(1).map((l) => {
            const m = l.trim().match(/^(\d+)\s+(.+?)\s+([\d.]+)\s+([\d.]+)\s+(\d+)$/);
            return m ? { pid: m[1], comm: m[2], cpu: m[3], mem: m[4], memMb: Math.round(Number(m[5]) / 1024) } : null;
        }).filter(Boolean).slice(0, 250);
    });

    // Phase 5: End task / End process tree. We kill via Node's process.kill so
    // there's no shell + no injection surface. Only the user's own processes can
    // be ended without privilege (root-owned ones return EPERM, surfaced clearly
    // — same as Windows' "Access denied"). PID 1 is never touched.
    ipcMain.handle('proc:kill', async (_e, pid) => killPids([toPid(pid)], 'SIGTERM'));
    ipcMain.handle('proc:kill-tree', async (_e, pid) => {
        const root = toPid(pid);
        if (!root) return { ok: false, killed: 0, errors: ['invalid pid'] };
        // Forceful, leaves-first — mirrors Windows "End process tree".
        return killPids(await descendantPids(root), 'SIGKILL');
    });

    ipcMain.handle('system:gpu', async () => {
        if (!IS_LINUX) return 'GPU detection runs on Outlaw Server.';
        const r = await runShell("lspci 2>/dev/null | grep -Ei 'vga|3d|display' | sed 's/^.*: //' | head -n 2");
        return r.stdout || 'No discrete GPU detected.';
    });

    // ----- System Core detailed handlers (SC2) ------------------------------
    // All of these degrade gracefully off-Linux so the System Core screen
    // still renders during off-OS development (just with "—" values).

    ipcMain.handle('system:gpu-detailed', async () => {
        if (!IS_LINUX) {
            return { available: false, name: '', vramUsedMb: 0, vramTotalMb: 0,
                     vramPct: 0, source: 'preview', note: 'GPU probe runs on Outlaw Server.' };
        }
        // Prefer nvidia-smi for VRAM numbers; this is the only practical way
        // to read actual used VRAM from a shell call. CSV no-units keeps the
        // parser tiny. ~50ms call when present, ~3ms exit when absent.
        const nv = await runShell(
            'nvidia-smi --query-gpu=name,memory.used,memory.total ' +
            '--format=csv,noheader,nounits 2>/dev/null | head -n 1',
            { timeout: 3000 },
        );
        if (nv.code === 0 && nv.stdout) {
            const parts = nv.stdout.split(',').map((s) => s.trim());
            const name = parts[0] || 'NVIDIA GPU';
            const used = Number(parts[1]) || 0;
            const total = Number(parts[2]) || 0;
            const pct = total > 0 ? Math.round((used / total) * 100) : 0;
            return { available: true, name, vramUsedMb: used, vramTotalMb: total,
                     vramPct: pct, source: 'nvml' };
        }
        // Non-NVIDIA — read the GPU model from lspci AND, for AMD/Intel cards with
        // dedicated VRAM, live used/total from the DRM sysfs nodes (bytes). amdgpu
        // and i915 expose mem_info_vram_used / mem_info_vram_total; integrated GPUs
        // share system RAM and have no node, so VRAM correctly stays 0. We pick the
        // card with the largest total (the discrete one on hybrid laptops).
        const lspci = await runShell(
            "lspci 2>/dev/null | grep -Ei 'vga|3d|display' | sed 's/^.*: //' | head -n 1",
            { timeout: 2000 },
        );
        const name = (lspci.stdout || '').trim() || 'GPU n/a';
        // amdgpu exposes total+used under device/; Intel i915 discrete exposes
        // total+AVAILABLE on the card node (used = total - avail).
        const drm = await runShell(
            'for c in /sys/class/drm/card*; do ' +
            't=$(cat "$c/device/mem_info_vram_total" 2>/dev/null); ' +
            'u=$(cat "$c/device/mem_info_vram_used" 2>/dev/null); ' +
            'if [ -z "$t" ]; then t=$(cat "$c/lmem_total_bytes" 2>/dev/null); ' +
            'a=$(cat "$c/lmem_avail_bytes" 2>/dev/null); ' +
            '[ -n "$t" ] && [ -n "$a" ] && u=$((t-a)); fi; ' +
            '[ -n "$t" ] && echo "$t ${u:-0}"; done | sort -rn | head -n 1',
            { timeout: 2000 },
        );
        const dm = (drm.stdout || '').trim().split(/\s+/);
        const totalBytes = Number(dm[0]) || 0;
        const usedBytes = Number(dm[1]) || 0;
        if (totalBytes > 0) {
            const totalMb = Math.round(totalBytes / (1024 * 1024));
            const usedMb = Math.round(usedBytes / (1024 * 1024));
            const pct = totalMb > 0 ? Math.round((usedMb / totalMb) * 100) : 0;
            return { available: true, name, vramUsedMb: usedMb, vramTotalMb: totalMb,
                     vramPct: pct, source: 'drm' };
        }
        return { available: true, name, vramUsedMb: 0, vramTotalMb: 0,
                 vramPct: 0, source: 'lspci' };
    });

    ipcMain.handle('system:disk', async () => {
        if (!IS_LINUX) {
            return { mount: '/', usedMb: 0, totalMb: 0, pct: 0, available: false };
        }
        // df -P -B M / gives a stable, parser-friendly output. Just root for SC2;
        // per-mount is fine future work for the Inventory expansion.
        const r = await runShell('df -P -B M / | tail -n 1', { timeout: 3000 });
        const m = (r.stdout || '').match(/^\S+\s+(\d+)M\s+(\d+)M\s+(\d+)M\s+(\d+)%\s+(\S+)/);
        if (!m) return { mount: '/', usedMb: 0, totalMb: 0, pct: 0, available: false };
        return {
            mount: m[5],
            totalMb: Number(m[1]),
            usedMb: Number(m[2]),
            pct: Number(m[4]),
            available: true,
        };
    });

    // Round-2 QOL — battery status for the topbar (laptops). Read-only from sysfs;
    // returns { present:false } on desktops / non-Linux so the indicator hides.
    ipcMain.handle('system:battery', async () => {
        if (!IS_LINUX) return { present: false };
        try {
            const base = '/sys/class/power_supply';
            let dirs = [];
            try { dirs = fs.readdirSync(base); } catch { return { present: false }; }
            const bat = dirs.find((d) => /^BAT/i.test(d));
            if (!bat) return { present: false };
            const read = (f) => { try { return fs.readFileSync(path.join(base, bat, f), 'utf8').trim(); } catch { return ''; } };
            const cap = parseInt(read('capacity'), 10);
            if (!Number.isFinite(cap)) return { present: false };
            const status = read('status') || 'Unknown';   // Charging|Discharging|Full|Not charging|Unknown
            return {
                present: true,
                percent: Math.max(0, Math.min(100, cap)),
                status,
                charging: status === 'Charging' || status === 'Full',
            };
        } catch { return { present: false }; }
    });

    // Round-2 QOL — volume control. Detect the audio backend once (PipeWire →
    // PulseAudio → ALSA) and drive it. Every set takes a CLAMPED integer %, so
    // there is no shell-injection surface.
    let _audioBackend = null;
    async function detectAudioBackend() {
        if (_audioBackend) return _audioBackend;
        for (const cmd of ['wpctl', 'pactl', 'amixer']) {
            const r = await runShell(`command -v ${cmd} >/dev/null 2>&1 && echo yes`);
            if (/yes/.test(r.stdout || '')) { _audioBackend = cmd; return _audioBackend; }
        }
        _audioBackend = 'none';
        return _audioBackend;
    }
    ipcMain.handle('audio:get', async () => {
        if (!IS_LINUX) return { available: false };
        try {
            const be = await detectAudioBackend();
            if (be === 'wpctl') {
                const r = await runShell('wpctl get-volume @DEFAULT_AUDIO_SINK@ 2>/dev/null', { timeout: 4000 });
                const m = (r.stdout || '').match(/Volume:\s*([\d.]+)/);
                return { available: !!m, volume: m ? Math.round(parseFloat(m[1]) * 100) : 0, muted: /MUTED/i.test(r.stdout || '') };
            }
            if (be === 'pactl') {
                const v = await runShell('pactl get-sink-volume @DEFAULT_SINK@ 2>/dev/null', { timeout: 4000 });
                const m = (v.stdout || '').match(/(\d+)%/);
                const mut = await runShell('pactl get-sink-mute @DEFAULT_SINK@ 2>/dev/null', { timeout: 4000 });
                return { available: !!m, volume: m ? Number(m[1]) : 0, muted: /yes/i.test(mut.stdout || '') };
            }
            if (be === 'amixer') {
                const r = await runShell('amixer get Master 2>/dev/null', { timeout: 4000 });
                const m = (r.stdout || '').match(/\[(\d+)%\]/);
                return { available: !!m, volume: m ? Number(m[1]) : 0, muted: /\[off\]/i.test(r.stdout || '') };
            }
        } catch {}
        return { available: false };
    });
    ipcMain.handle('audio:set', async (_e, pct) => {
        if (!IS_LINUX) return { ok: false };
        const v = Math.max(0, Math.min(100, parseInt(pct, 10) || 0));
        const be = await detectAudioBackend();
        let cmd = null;
        if (be === 'wpctl') cmd = `wpctl set-volume @DEFAULT_AUDIO_SINK@ ${v}%`;
        else if (be === 'pactl') cmd = `pactl set-sink-volume @DEFAULT_SINK@ ${v}%`;
        else if (be === 'amixer') cmd = `amixer set Master ${v}% unmute 2>/dev/null`;
        if (!cmd) return { ok: false };
        const r = await runShell(cmd, { timeout: 4000 });
        return { ok: r.code === 0 || r.code === undefined };
    });
    ipcMain.handle('audio:toggle-mute', async () => {
        if (!IS_LINUX) return { ok: false };
        const be = await detectAudioBackend();
        let cmd = null;
        if (be === 'wpctl') cmd = 'wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle';
        else if (be === 'pactl') cmd = 'pactl set-sink-mute @DEFAULT_SINK@ toggle';
        else if (be === 'amixer') cmd = 'amixer set Master toggle 2>/dev/null';
        if (!cmd) return { ok: false };
        const r = await runShell(cmd, { timeout: 4000 });
        return { ok: r.code === 0 || r.code === undefined };
    });

    // QOL — sound OUTPUT device picker. pactl ships with libpulse (a
    // pipewire-pulse dependency), and its JSON output keeps parsing robust.
    // Gracefully returns an empty list when pactl is absent (ALSA-only setups),
    // which hides the picker in the UI.
    ipcMain.handle('audio:sinks', async () => {
        if (!IS_LINUX) return { ok: false, sinks: [] };
        const r = await runShell('pactl -f json list sinks 2>/dev/null', { timeout: 4000 });
        const def = await runShell('pactl get-default-sink 2>/dev/null', { timeout: 3000 });
        try {
            const arr = JSON.parse(r.stdout || '[]');
            if (!Array.isArray(arr)) return { ok: false, sinks: [] };
            const cur = (def.stdout || '').trim();
            const sinks = arr.map((s) => ({
                name: String((s && s.name) || ''),
                label: String((s && (s.description || s.name)) || '').slice(0, 80),
                current: !!(s && s.name === cur),
            })).filter((s) => s.name);
            return { ok: true, sinks };
        } catch { return { ok: false, sinks: [] }; }
    });
    ipcMain.handle('audio:set-sink', async (_e, name) => {
        if (!IS_LINUX) return { ok: false };
        const n = String(name || '');
        if (!n || n.length > 200) return { ok: false, error: 'Bad device name.' };
        // Validate against the real sink list, then set via execFile argv (no shell).
        const r = await runShell('pactl -f json list sinks 2>/dev/null', { timeout: 4000 });
        let names = [];
        try { names = JSON.parse(r.stdout || '[]').map((s) => String((s && s.name) || '')); } catch {}
        if (!names.includes(n)) return { ok: false, error: 'Unknown output device.' };
        const set = await new Promise((resolve) => {
            execFile('pactl', ['set-default-sink', n], { timeout: 5000 },
                (err, so, se) => resolve({ err, out: (se || so || '').trim() }));
        });
        if (set.err) return { ok: false, error: set.out.slice(0, 200) || 'Could not switch the output device.' };
        return { ok: true };
    });

    // Round-2 QOL — screenshots via scrot (already bundled for CodeMaker OCR).
    // mode 'region' = interactive drag-select; otherwise full screen with a 1s
    // delay so any open menu/popover can close. Saves to ~/Pictures.
    ipcMain.handle('screenshot:capture', async (_e, mode) => {
        if (!IS_LINUX) return { ok: false, error: 'Screenshots run on Outlaw Server.' };
        const has = await runShell('command -v scrot >/dev/null 2>&1 && echo yes');
        if (!/yes/.test(has.stdout || '')) return { ok: false, error: 'Screenshot tool (scrot) not available.' };
        const dir = path.join(os.homedir(), 'Pictures');
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
        const region = mode === 'region';
        const opts = region ? '-s' : '-d 1';
        const cmd = `cd ${JSON.stringify(dir)} && scrot ${opts} 'Screenshot-%Y-%m-%d_%H-%M-%S.png' -e 'echo $f'`;
        const r = await runShell(cmd, { timeout: region ? 60000 : 10000 });
        const fname = ((r.stdout || '').trim().split('\n').filter(Boolean).pop() || '').replace(/^.*\//, '');
        if ((r.code === 0 || r.code === undefined) && fname) return { ok: true, path: path.join(dir, fname) };
        return { ok: false, error: region ? 'Screenshot cancelled.' : (r.stderr || 'Capture failed.').slice(-160) };
    });

    // QOL — screen RECORDING (ffmpeg x11grab → ~/Videos, video-only, H.264).
    // One recording at a time. The child is added to trackedProcs, which gives
    // it emergency-stop (Ctrl+Alt+K) coverage for free AND makes the auto-sleep
    // idle watch treat an active recording as "busy" (it skips suspending while
    // any tracked job runs). ffmpeg is NOT bundled — the start handler reports
    // a friendly "install it from Apps" error when absent.
    let recProc = null;
    let recPath = '';
    ipcMain.handle('record:status', async () => {
        if (!IS_LINUX) return { supported: false, recording: false, haveFfmpeg: false };
        const have = await runShell('command -v ffmpeg >/dev/null 2>&1 && echo yes', { timeout: 3000 });
        return { supported: true, haveFfmpeg: /yes/.test(have.stdout || ''), recording: !!recProc, path: recPath };
    });
    ipcMain.handle('record:start', async () => {
        if (!IS_LINUX) return { ok: false, error: 'Screen recording runs on Outlaw Server.' };
        if (recProc) return { ok: false, error: 'Already recording — stop the current recording first.' };
        const have = await runShell('command -v ffmpeg >/dev/null 2>&1 && echo yes', { timeout: 3000 });
        if (!/yes/.test(have.stdout || '')) {
            return { ok: false, error: 'Screen recording needs the ffmpeg package — install it from Apps (search "ffmpeg").' };
        }
        // x11grab defaults to 640x480 without an explicit size — read the real one.
        const dim = await runShell("xdpyinfo 2>/dev/null | awk '/dimensions:/{print $2; exit}'", { timeout: 3000 });
        const size = /^\d+x\d+$/.test((dim.stdout || '').trim()) ? (dim.stdout || '').trim() : '1920x1080';
        const dir = path.join(os.homedir(), 'Videos');
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
        const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
        const file = path.join(dir, `outlaw-rec-${stamp}.mp4`);
        let child;
        try {
            child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error',
                '-f', 'x11grab', '-framerate', '30', '-video_size', size,
                '-i', process.env.DISPLAY || ':0',
                '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
                file]);
        } catch (e) { return { ok: false, error: 'Could not start ffmpeg: ' + e.message }; }
        recProc = child;
        recPath = file;
        trackedProcs.add(child);
        const drop = () => { trackedProcs.delete(child); if (recProc === child) recProc = null; };
        child.on('error', drop);
        child.on('close', drop);
        return { ok: true, path: file };
    });
    ipcMain.handle('record:stop', async () => {
        const p = recProc;
        if (!p) return { ok: false, error: 'Not recording.' };
        // SIGINT lets ffmpeg write the MP4 trailer so the file is playable;
        // the close handler (above) clears recProc. 6s grace, then report.
        const done = new Promise((resolve) => { p.once('close', resolve); setTimeout(resolve, 6000); });
        try { p.kill('SIGINT'); } catch {}
        await done;
        let sizeMb = 0;
        try { sizeMb = Math.round(fs.statSync(recPath).size / (1024 * 1024) * 10) / 10; } catch {}
        return { ok: true, path: recPath, sizeMb };
    });

    ipcMain.handle('system:net', () => {
        // Return raw counters; the renderer diffs successive calls to derive
        // throughput. Keeping main stateless means no background timers that
        // would persist when the System Core screen isn't open.
        if (!IS_LINUX) return { rxBytes: 0, txBytes: 0, t: Date.now(), available: false };
        try {
            const text = fs.readFileSync('/proc/net/dev', 'utf8');
            let rx = 0, tx = 0;
            for (const line of text.split('\n')) {
                const colon = line.indexOf(':');
                if (colon < 0) continue;
                const iface = line.slice(0, colon).trim();
                if (iface === 'lo' || !iface) continue;  // skip loopback
                const cols = line.slice(colon + 1).trim().split(/\s+/).map(Number);
                if (cols.length < 9) continue;
                rx += cols[0] || 0;   // RX bytes
                tx += cols[8] || 0;   // TX bytes
            }
            return { rxBytes: rx, txBytes: tx, t: Date.now(), available: true };
        } catch (e) {
            return { rxBytes: 0, txBytes: 0, t: Date.now(), available: false,
                     error: e.message };
        }
    });

    ipcMain.handle('system:inventory', async () => {
        // Static inventory loaded once per System Core visit. All fields are
        // optional — missing tools/files just produce empty strings instead
        // of failing the whole call.
        const result = {
            hostname: os.hostname(),
            platform: process.platform,
            kernel: os.release(),
            outlawVersion: APP_VERSION,
            packages: 0,
            sessionPref: '',
            snapshotMb: 0,
            apparmor: '',
            ufw: '',
            bootSince: '',
            available: IS_LINUX,
        };
        if (!IS_LINUX) return result;

        // Run the cheap probes in parallel — total wall time ~150–300ms.
        const [pacman, sessPref, snapDu, appArmor, ufwStatus, bootSince] = await Promise.all([
            runShell('pacman -Q 2>/dev/null | wc -l', { timeout: 4000 }),
            runShell('cat "$HOME/.outlaw-session-pref" 2>/dev/null', { timeout: 1000 }),
            // Best-effort snapshot disk usage — only for the installed CodeMaker
            // path. If CodeMaker isn't installed, just return 0.
            // awk program is SINGLE-quoted so bash (via runShell's `bash -c`)
            // doesn't expand `$1` to an empty positional param before awk sees it
            // — a double-quoted awk body made this always fail and report 0 MB.
            runShell(
                'find /opt/outlaw-codemaker -path "*/.outlaw/snapshots" -prune -print 2>/dev/null ' +
                "| xargs -I{} du -sm {} 2>/dev/null | awk '{s+=$1} END {print s+0}'",
                { timeout: 4000 },
            ),
            runShell('systemctl is-active apparmor 2>/dev/null', { timeout: 2000 }),
            runShell('ufw status 2>/dev/null | head -n 1 | sed "s/Status: //"', { timeout: 2000 }),
            runShell('uptime -s 2>/dev/null', { timeout: 1500 }),
        ]);

        result.packages = parseInt(pacman.stdout, 10) || 0;
        result.sessionPref = (sessPref.stdout || '').trim() || 'ask';
        result.snapshotMb = parseInt(snapDu.stdout, 10) || 0;
        result.apparmor = (appArmor.stdout || '').trim() || 'inactive';
        result.ufw = (ufwStatus.stdout || '').trim() || 'inactive';
        result.bootSince = (bootSince.stdout || '').trim();
        return result;
    });

    // ----- SC3 System Core diagnostics ------------------------------------
    // Runs are owned by the singleton _diagRunner. Only one at a time.
    // Streaming progress goes out on 'diagnostics-progress' (whitelisted in
    // preload's EVENT_CHANNELS). Reports persist to ~/.outlaw-diagnostics/.

    ipcMain.handle('diagnostics:run', async (_e, profile) => {
        const runner = getDiagRunner();
        try {
            // Don't await — return immediately so the renderer can show its
            // progress UI. The 'done' progress event signals completion.
            runner.run(profile).catch((err) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('diagnostics-progress', {
                        phase: 'error', error: err.message,
                    });
                }
            });
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    ipcMain.handle('diagnostics:cancel', () => {
        const runner = getDiagRunner();
        runner.abort();
        return { ok: true };
    });

    ipcMain.handle('diagnostics:status', () => {
        const runner = getDiagRunner();
        return runner.state();
    });

    ipcMain.handle('diagnostics:list-reports', async () => {
        return await listDiagReports();
    });

    ipcMain.handle('diagnostics:read-report', async (_e, filename) => {
        try {
            return { ok: true, report: await readDiagReport(filename) };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    // ----- SC4 Scheduled diagnostic checks --------------------------------
    // The actual timers are systemd user units shipped in airootfs (or copied
    // to ~/.config/systemd/user/ for off-skel users). These handlers just
    // wrap systemctl --user so the renderer never shells out itself.

    const SCHEDULED_PROFILES = {
        // profile id -> { timer unit name, what it runs }
        daily:   { timer: 'outlaw-diagnose-daily.timer',   profile: 'quick'    },
        weekly:  { timer: 'outlaw-diagnose-weekly.timer',  profile: 'standard' },
        monthly: { timer: 'outlaw-diagnose-monthly.timer', profile: 'thorough' },
    };

    async function _schedStatusOne(id) {
        const entry = SCHEDULED_PROFILES[id];
        if (!entry) return null;
        const result = { id, timer: entry.timer, profile: entry.profile,
                         enabled: false, active: false, nextRun: '', lastRun: '',
                         lastResult: '', available: IS_LINUX };
        if (!IS_LINUX) return result;
        const [en, act, show] = await Promise.all([
            runShell(`systemctl --user is-enabled ${entry.timer} 2>/dev/null`, { timeout: 3000 }),
            runShell(`systemctl --user is-active  ${entry.timer} 2>/dev/null`, { timeout: 3000 }),
            // --property gives a parser-friendly key=value dump.
            runShell(
                `systemctl --user show ${entry.timer} --property=NextElapseUSecRealtime,LastTriggerUSec,Result 2>/dev/null`,
                { timeout: 3000 },
            ),
        ]);
        result.enabled = (en.stdout || '').trim() === 'enabled';
        result.active  = (act.stdout || '').trim() === 'active';
        for (const line of (show.stdout || '').split('\n')) {
            const m = line.match(/^([A-Za-z]+)=(.*)$/);
            if (!m) continue;
            const [k, v] = [m[1], m[2].trim()];
            if (k === 'NextElapseUSecRealtime') result.nextRun = v;
            if (k === 'LastTriggerUSec')        result.lastRun = v;
            if (k === 'Result')                 result.lastResult = v;
        }
        return result;
    }

    ipcMain.handle('scheduled:status', async () => {
        const out = {};
        for (const id of Object.keys(SCHEDULED_PROFILES)) {
            out[id] = await _schedStatusOne(id);
        }
        return out;
    });

    ipcMain.handle('scheduled:enable', async (_e, id) => {
        if (!IS_LINUX) return { ok: false, error: 'Scheduled checks run on Outlaw Server.' };
        const entry = SCHEDULED_PROFILES[id];
        if (!entry) return { ok: false, error: 'Unknown schedule id.' };
        // --now also kicks off the timer immediately so it starts counting
        // toward the next OnCalendar trigger.
        const r = await runShell(
            `systemctl --user enable --now ${entry.timer}`,
            { timeout: 8000 },
        );
        if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout || '').slice(-300) };
        return { ok: true };
    });

    ipcMain.handle('scheduled:disable', async (_e, id) => {
        if (!IS_LINUX) return { ok: false, error: 'Scheduled checks run on Outlaw Server.' };
        const entry = SCHEDULED_PROFILES[id];
        if (!entry) return { ok: false, error: 'Unknown schedule id.' };
        const r = await runShell(
            `systemctl --user disable --now ${entry.timer}`,
            { timeout: 8000 },
        );
        if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout || '').slice(-300) };
        return { ok: true };
    });

    ipcMain.handle('scheduled:run-now', async (_e, id) => {
        if (!IS_LINUX) return { ok: false, error: 'Scheduled checks run on Outlaw Server.' };
        const entry = SCHEDULED_PROFILES[id];
        if (!entry) return { ok: false, error: 'Unknown schedule id.' };
        // start the instance directly so it runs whether the timer is enabled
        // or not. The user expects "run now" to mean "run now".
        const r = await runShell(
            `systemctl --user start outlaw-diagnose@${entry.profile}.service`,
            { timeout: 5000 },
        );
        if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout || '').slice(-300) };
        return { ok: true, started: entry.profile };
    });

    // ----- Live-ISO detection ---------------------------------------------
    // /run/archiso exists only when booted from the live ISO. On installed
    // systems this returns false even if the user kept the ISO around.
    ipcMain.handle('system:live-iso', () => {
        if (!IS_LINUX) return { live: false, dismissed: !!settings.liveWelcomeDismissed };
        let live = false;
        try { live = fs.existsSync('/run/archiso'); } catch { /* default false */ }
        return { live, dismissed: !!settings.liveWelcomeDismissed };
    });

    // ----- Network / Wi-Fi (nmcli over NetworkManager) ----------------------
    // The live ISO ships networkmanager + linux-firmware, and installs need the
    // network — but there was NO in-OS way to connect to Wi-Fi (the root cause
    // behind several "couldn't reach the package servers" install failures).
    // nmcli terse output separates fields with ':' and escapes literal colons
    // as '\:' — splitTerse handles that.
    const splitTerse = (line) =>
        line.replace(/\\:/g, '\u0000').split(':').map((s) => s.replace(/\u0000/g, ':'));

    ipcMain.handle('net:status', async () => {
        if (!IS_LINUX) return { connectivity: 'unknown', wifi: false, active: '' };
        const [conn, devs] = await Promise.all([
            runShell('nmcli networking connectivity check 2>/dev/null', { timeout: 10000 }),
            runShell('nmcli -t -f DEVICE,TYPE,STATE,CONNECTION dev 2>/dev/null', { timeout: 8000 }),
        ]);
        const lines = (devs.stdout || '').split('\n').filter(Boolean).map(splitTerse);
        const wifi = lines.some((t) => t[1] === 'wifi');
        const act = lines.find((t) => t[2] === 'connected' && t[1] !== 'loopback');
        return {
            connectivity: (conn.stdout || '').trim() || 'unknown', // full|limited|portal|none|unknown
            wifi,
            active: act ? `${act[3] || act[0]} (${act[1]})` : '',
        };
    });

    // Airplane mode — actively turn the radios OFF (vs offline mode, which just
    // reacts to no connection). nmcli radio = wifi + wwan, no root needed via NM's
    // polkit; Bluetooth is best-effort via rfkill (needs root, ignored if it can't).
    ipcMain.handle('net:airplane-status', async () => {
        if (!IS_LINUX) return { airplane: false };
        const r = await runShell('nmcli radio wifi 2>/dev/null', { timeout: 5000 });
        return { airplane: /disabled/i.test(r.stdout || '') };
    });
    ipcMain.handle('net:airplane-set', async (_e, on) => {
        if (!IS_LINUX) return { ok: false, error: 'Airplane mode runs on Outlaw Server.' };
        const enable = !!on;
        const r = await runShell(`nmcli radio all ${enable ? 'off' : 'on'} 2>/dev/null`, { timeout: 8000 });
        await runShell(`rfkill ${enable ? 'block' : 'unblock'} bluetooth 2>/dev/null`, { timeout: 5000 });
        if (r.code !== 0 && r.code !== undefined) {
            try { errorlog.append('error', 'network', 'Airplane mode toggle failed: ' + (r.stderr || r.stdout || `exit ${r.code}`).slice(-300)); } catch {}
            return { ok: false, error: (r.stderr || r.stdout || 'failed').slice(-300) };
        }
        return { ok: true };
    });

    ipcMain.handle('net:wifi-list', async () => {
        if (!IS_LINUX) return { ok: false, networks: [], error: 'Wi-Fi scan runs on Outlaw Server.' };
        await runShell('nmcli radio wifi on 2>/dev/null', { timeout: 5000 });
        // --rescan yes forces a fresh scan; can take a few seconds.
        const r = await runShell("nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY dev wifi list --rescan yes 2>/dev/null", { timeout: 30000 });
        const seen = new Set();
        const networks = [];
        for (const line of (r.stdout || '').split('\n')) {
            if (!line.trim()) continue;
            const t = splitTerse(line);
            const ssid = t[1];
            if (!ssid || seen.has(ssid)) continue; // skip hidden + duplicate APs
            seen.add(ssid);
            networks.push({
                inUse: t[0] === '*',
                ssid,
                signal: parseInt(t[2], 10) || 0,
                security: (t[3] || '').trim(), // '' = open network
            });
        }
        networks.sort((a, b) => (b.inUse - a.inUse) || (b.signal - a.signal));
        // Mark networks that have a saved profile so the UI can offer "Forget".
        try {
            const conns = await runShell('nmcli -t -f NAME connection show 2>/dev/null', { timeout: 5000 });
            const savedSet = new Set((conns.stdout || '').split('\n').map((l) => splitTerse(l)[0]).filter(Boolean));
            networks.forEach((n) => { n.saved = savedSet.has(n.ssid); });
        } catch { /* no flag — UI just doesn't show Forget */ }
        return { ok: true, networks };
    });

    // QOL — forget a saved Wi-Fi network (deletes its NetworkManager profile,
    // e.g. after a password change left a stale one). Validated: the name must
    // match an EXISTING saved profile, and both calls use execFile argv — an
    // SSID with spaces/quotes can't inject anything.
    ipcMain.handle('net:wifi-forget', async (_e, ssid) => {
        if (!IS_LINUX) return { ok: false, error: 'Wi-Fi runs on Outlaw Server.' };
        const name = String(ssid || '');
        if (!name || name.length > 64) return { ok: false, error: 'Bad network name.' };
        const list = await new Promise((resolve) => {
            execFile('nmcli', ['-t', '-f', 'NAME', 'connection', 'show'], { timeout: 8000 },
                (err, stdout) => resolve(err ? '' : (stdout || '')));
        });
        const saved = list.split('\n').map((l) => splitTerse(l)[0]).filter(Boolean);
        if (!saved.includes(name)) return { ok: false, error: 'No saved profile for that network.' };
        const r = await new Promise((resolve) => {
            execFile('nmcli', ['connection', 'delete', 'id', name], { timeout: 10000 },
                (err, stdout, stderr) => resolve({ err, out: (stderr || stdout || '').trim() }));
        });
        if (r.err) return { ok: false, error: r.out.slice(0, 200) || 'Could not forget the network.' };
        return { ok: true };
    });

    ipcMain.handle('net:wifi-connect', async (_e, payload) => {
        if (!IS_LINUX) return { ok: false, error: 'Wi-Fi runs on Outlaw Server.' };
        const ssid = String((payload && payload.ssid) || '');
        const password = String((payload && payload.password) || '');
        if (!ssid || ssid.length > 64) return { ok: false, error: 'Bad network name.' };
        // execFile with an argv array — no shell, so SSIDs/passwords with
        // spaces or quotes can't break out or inject anything.
        const args = ['dev', 'wifi', 'connect', ssid];
        if (password) args.push('password', password);
        const r = await new Promise((resolve) => {
            execFile('nmcli', args, { timeout: 45000 },
                (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: stderr || '' }));
        });
        if (r.err) {
            let msg = (r.stderr || r.stdout || r.err.message).trim().slice(0, 300);
            if (/secrets were required|802-11-wireless-security|invalid/i.test(msg)) {
                msg = 'Wrong password (or the network rejected the connection). Try again.';
            }
            return { ok: false, error: msg };
        }
        return { ok: true, log: (r.stdout || '').trim().slice(0, 300) };
    });

    // ----- Auth: PIN + sign-in (Phase 3c) -----------------------------------
    ipcMain.handle('auth:status', () => ({
        linux: IS_LINUX,
        live: IS_LIVE,
        hasPin: hasPin(),
        // Sign-in lock: on for installed systems, off on the live demo (root,
        // no password). Toggle in Settings.
        lockEnabled: IS_LINUX && !IS_LIVE && settings.lockEnabled !== false,
        user: (() => { try { return os.userInfo().username; } catch { return 'operator'; } })(),
    }));
    // One-shot token the greeter writes right after it took the PIN, so the
    // session's OWN sign-in doesn't ask again. Consume (delete) it; honor only
    // if it's recent (< 2 min). Any error → not unlocked (fall back to asking).
    ipcMain.handle('auth:recently-unlocked', () => {
        try {
            const tok = path.join(os.homedir(), '.outlaw-unlocked');
            const raw = fs.readFileSync(tok, 'utf8').trim();
            try { fs.unlinkSync(tok); } catch {}
            const ts = parseInt(raw, 10) || 0;
            return { ok: ts > 0 && (Date.now() - ts) < 120000 };
        } catch { return { ok: false }; }
    });
    ipcMain.handle('auth:set-pin', (_e, payload) => {
        const { pin, current } = payload || {};
        if (hasPin()) {
            const okCur = (current && /^\d{4}$/.test(current)) ? verifyPin(current) : false;
            if (!okCur) return { ok: false, error: 'Your current PIN is incorrect.' };
        }
        return setPin(pin) ? { ok: true } : { ok: false, error: 'The PIN must be exactly 4 digits.' };
    });
    ipcMain.handle('auth:clear-pin', async (_e, payload) => {
        const u = await authUnlock(payload || {});
        if (!u.ok) return u;
        clearPin();
        return { ok: true };
    });
    ipcMain.handle('auth:unlock', async (_e, payload) => authUnlock(payload || {}));
    ipcMain.handle('auth:set-lock', (_e, enabled) => {
        settings = saveSettings({ ...settings, lockEnabled: !!enabled });
        return { ok: true };
    });

    ipcMain.handle('files:home', () => os.homedir());
    ipcMain.handle('files:list', (_e, dir) => listFiles(dir || os.homedir()));
    ipcMain.handle('files:open', (_e, target) => openPath(target));
    // Open a real file manager (Thunar) at a path so the user can actually
    // open / copy / rename / right-click files. The built-in list is a quick
    // viewer; opening a file with shell.openPath needs a registered handler,
    // which a fresh system lacks — Thunar gives full interaction either way.
    ipcMain.handle('files:open-manager', async (_e, dir) => {
        if (!IS_LINUX) return { ok: false, error: 'Runs on Outlaw Server.' };
        const target = (dir && typeof dir === 'string') ? dir : os.homedir();
        const bin = await resolveBinary(APP_REGISTRY.files);
        if (bin) {
            launchDetached(bin, [target], { focus: String(bin).split('/').pop() });
            return { ok: true };
        }
        return openPath(target); // last resort: xdg-open the folder
    });

    ipcMain.handle('apps:list', () =>
        Object.entries(APP_REGISTRY).map(([id, v]) => ({ id, label: v.label })));

    ipcMain.handle('apps:launch', async (_e, id) => {
        // Own-property lookup only — a plain index would let ids like
        // '__proto__' pull junk off the prototype chain.
        const key = String(id || '').slice(0, 64);
        // Primary lookup: the curated quick-launch registry (the OS's "always
        // there" apps the AI is allowed to open).
        let entry = Object.prototype.hasOwnProperty.call(APP_REGISTRY, key) ? APP_REGISTRY[key] : undefined;
        // Fallback: the on-demand catalog — apps installed via the Apps panel
        // may not be in APP_REGISTRY but still have a `bin` we can launch.
        if (!entry) {
            const cat = APP_CATALOG.find((a) => a.id === key && a.bin);
            if (cat) entry = { label: cat.label, bin: cat.bin, args: [] };
        }
        if (!entry) return { ok: false, error: 'Unknown app.' };
        const bin = await resolveBinary(entry);
        if (!bin) return { ok: false, error: `${entry.label} is not installed.` };
        launchDetached(bin, entry.args || []);
        // QoL — remember successful launches for the Dashboard's "Recent" row
        // (MRU, deduped, capped at 8).
        try {
            const recent = [key, ...(Array.isArray(settings.recentApps) ? settings.recentApps : []).filter((r) => r !== key)].slice(0, 8);
            settings = saveSettings({ ...settings, recentApps: recent });
        } catch { /* non-fatal — launch already happened */ }
        return { ok: true, label: entry.label };
    });

    // ----- Apps catalog (on-demand installs via pkexec pacman) -----

    ipcMain.handle('apps:catalog', () => {
        // Only return UI-relevant fields. Renderer never sees raw pacman pkg names
        // (they can't be tampered with anyway — the install handler only honors `id`).
        return APP_CATALOG.map((a) => ({
            id: a.id,
            label: a.label,
            category: a.category,
            description: a.description,
            launchable: !!a.bin,
        }));
    });

    ipcMain.handle('apps:installed-list', async () => {
        if (!IS_LINUX) {
            // Off-Linux preview: nothing is "installed".
            return APP_CATALOG.map((a) => ({ id: a.id, installed: false }));
        }
        // pacman -Qq <pkg1> <pkg2> ... in a single call. Missing packages go to
        // stderr; installed ones go to stdout. We just need the set of installed.
        const pkgs = APP_CATALOG.map((a) => a.pkg).join(' ');
        const r = await runShell(`pacman -Qq ${pkgs} 2>/dev/null`, { timeout: 8000 });
        const installed = new Set(r.stdout.split('\n').filter(Boolean));
        return APP_CATALOG.map((a) => ({ id: a.id, installed: installed.has(a.pkg) }));
    });

    // Phase 15c — search ALL official packages (not just the curated catalog), so
    // the user can install anything. Read-only `pacman -Ss`; the query is strictly
    // validated (must start alphanumeric, safe charset) and each term single-quoted
    // so it can never be a shell injection or a stray pacman flag.
    ipcMain.handle('apps:search', async (_e, query) => {
        if (!IS_LINUX) return { ok: false, error: 'Search runs on Outlaw Server.', results: [] };
        const q = String(query || '').trim();
        if (q.length < 2) return { ok: true, results: [] };
        if (!/^[a-z0-9][a-z0-9 ._+-]{0,39}$/i.test(q)) {
            return { ok: false, error: 'Search with letters, numbers, spaces or . _ + - only.', results: [] };
        }
        const terms = q.split(/\s+/).filter(Boolean).map((w) => `'${w}'`).join(' ');
        const r = await runShell(`pacman -Ss ${terms}`, { timeout: 12000 });
        const lines = (r.stdout || '').split('\n');
        const results = [];
        for (let i = 0; i < lines.length && results.length < 30; i++) {
            const m = lines[i].match(/^(\w[\w-]*)\/(\S+)\s+(\S+)(.*)$/);
            if (m) {
                results.push({
                    repo: m[1],
                    name: m[2],
                    version: m[3],
                    installed: /\[installed/.test(m[4] || ''),
                    description: (lines[i + 1] || '').trim(),
                });
            }
        }
        return { ok: true, results };
    });

    // Phase 15c — install any official package by name (the "install anything" path
    // behind the search results above). Name is strictly validated, then verified
    // to be a real repo package before we hand it to the privileged installer.
    ipcMain.handle('apps:install-pkg', async (_e, pkg) => {
        if (!IS_LINUX) return { ok: false, error: 'Install runs on Outlaw Server.' };
        const name = String(pkg || '').trim();
        if (!/^[a-z0-9][a-z0-9@._+-]{0,79}$/i.test(name)) return { ok: false, error: 'Invalid package name.' };
        const info = await runShell(`pacman -Si '${name}'`, { timeout: 8000 });
        if (info.code !== 0) return { ok: false, error: `"${name}" isn't an available package.` };
        const r = await privInstall(name, 1000 * 60 * 20);
        const tail = (r.stdout || r.stderr || `exit ${r.code}`).slice(-3000);
        if (r.code !== 0) return { ok: false, error: tail };
        return { ok: true, text: `${name} installed.` };
    });

    ipcMain.handle('apps:install', async (_e, id) => {
        if (!IS_LINUX) return { ok: false, error: 'Install runs on Outlaw Server.' };
        const app = APP_CATALOG.find((a) => a.id === id);
        if (!app) return { ok: false, error: 'Unknown app id.' };
        // Route through the outlaw-pkg-install helper (via pkexec). It enables
        // [multilib] on demand for Steam / lib32 packages, force-refreshes the
        // databases (fixes "failed to synchronize databases"), inits the keyring
        // if empty, then installs. `extra` packages install with the primary;
        // install-state is still tracked on the primary `pkg`.
        // 20-minute timeout — large multilib packages on slow connections.
        const pkgList = [app.pkg, ...(app.extra || [])].join(' ');
        // Resilient: uses the installed helper (passwordless) if present, else a
        // temp-script fallback — so a missing helper can't break installs.
        const r = await privInstall(pkgList, 1000 * 60 * 20);
        const tail = (r.stdout || r.stderr || `exit ${r.code}`).slice(-3000);
        if (r.code !== 0) {
            // Surface a useful hint for the most common failure modes.
            const hint = /could not synchronize|failed to synchronize|database file for|use ['"]?-Sy/i.test(tail)
                ? '\n\nHint: couldn\'t reach the package servers. Open Settings → Network & Wi-Fi, get online, then try again.'
                : /target not found|could not find/i.test(tail)
                    ? '\n\nHint: a package wasn\'t found. If this is Steam, the multilib repo is needed — the installer enables it automatically, so just try once more.'
                    : /not authorized|authentication agent|polkit|dismissed/i.test(tail)
                        ? '\n\nHint: the password prompt was cancelled or no authorization agent answered.'
                        : '';
            return { ok: false, error: tail + hint };
        }
        return { ok: true, label: app.label, log: tail };
    });

    ipcMain.handle('apps:uninstall', async (_e, id) => {
        if (!IS_LINUX) return { ok: false, error: 'Uninstall runs on Outlaw Server.' };
        const app = APP_CATALOG.find((a) => a.id === id);
        if (!app) return { ok: false, error: 'Unknown app id.' };
        // -Rs removes the package + any deps that become orphaned (safe).
        // Not -Rsc (cascade) — that's too aggressive and could remove something
        // the user still wants.
        const cmd = `pkexec pacman -Rs --noconfirm ${app.pkg}`;
        const r = await runShell(cmd, { timeout: 1000 * 60 * 10 });
        const tail = (r.stdout || r.stderr || `exit ${r.code}`).slice(-2000);
        return { ok: r.code === 0, label: app.label, log: tail, error: r.code === 0 ? '' : tail };
    });

    ipcMain.handle('apps:refresh-db', async () => {
        // Optional: refresh local pacman DB without doing a full upgrade.
        // Mildly risky (partial-upgrade window) but useful before an Apps install.
        if (!IS_LINUX) return { ok: false, error: 'Runs on Outlaw Server.' };
        const r = await runShell('pkexec pacman -Sy --noconfirm', { timeout: 1000 * 60 * 5 });
        return { ok: r.code === 0, log: (r.stdout || r.stderr).slice(-2000) };
    });

    // ----- App auto-discovery (Phase 2): apps the user installed themselves --
    ipcMain.handle('apps:discover', async () => {
        try { return discoverApps(); } catch { return []; }
    });

    ipcMain.handle('apps:launch-discovered', async (_e, id) => {
        if (!IS_LINUX) return { ok: false, error: 'Runs on Outlaw Server.' };
        // Re-scan and match by id so the renderer can only launch something that
        // genuinely exists on disk — never an arbitrary command from the page.
        const item = discoverApps().find((a) => a.id === id);
        if (!item) return { ok: false, error: 'App not found — try refreshing.' };
        try {
            if (item.kind === 'appimage') {
                try { fs.chmodSync(item.path, 0o755); } catch {}
                launchDetached(item.path, [], { focus: path.basename(item.path) });
                return { ok: true, label: item.name };
            }
            const parts = _splitExec(_cleanExec(item.exec));
            if (!parts.length) return { ok: false, error: 'No runnable command in the .desktop entry.' };
            const bin = parts[0];
            const args = parts.slice(1);
            if (item.terminal) {
                // Terminal apps need a terminal + focus (no WM) — reuse outlaw-term.
                launchDetached('outlaw-term', [item.name, bin, ...args], { focus: false });
            } else {
                launchDetached(bin, args, { focus: path.basename(bin) });
            }
            return { ok: true, label: item.name };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    // Inspect a command WITHOUT running it (UI uses this to warn before submit).
    ipcMain.handle('terminal:inspect', (_e, command) => classifyCommand(command));

    ipcMain.handle('terminal:run', async (_e, { command, opts }) => {
        const cls = classifyCommand(command);
        if (cls.danger && !(opts && opts.confirmDangerous)) {
            return { code: -1, stdout: '', stderr: '', blocked: true, reason: cls.reason };
        }
        const r = await runShell(command, { timeout: 120000 });
        return { ...r, blocked: false, danger: cls.danger };
    });

    ipcMain.handle('settings:get', () => settings);
    ipcMain.handle('settings:set', (_e, patch) => {
        // Harden the patch before merging: IPC structured clone can deliver
        // values JSON can't serialize (BigInt, cyclic graphs). Merging one of
        // those would poison the in-memory settings object and silently break
        // ALL settings persistence for the rest of the session, so round-trip
        // the patch through JSON first (with a size cap) and reject it whole
        // on failure — the current settings are returned unchanged.
        try {
            const raw = JSON.stringify(patch || {});
            if (raw.length > 200000) return settings;
            patch = JSON.parse(raw);
        } catch { return settings; }
        const before = {
            autoCheck: settings.autoCheck,
            updateRepo: settings.updateRepo,
            vramSaverMode: settings.vramSaverMode,
            autoLockMin: settings.autoLockMin,
            autoSleepMin: settings.autoSleepMin,
            screenBlankMin: settings.screenBlankMin,
        };
        const merged = { ...settings, ...(patch || {}) };
        // Phase 16 — keep the legacy baseAiEnabled flag in step with the chosen
        // engine so the (many) existing `baseAiEnabled` checks stay correct.
        if (patch && patch.aiEngine) merged.baseAiEnabled = (patch.aiEngine === 'base');
        settings = saveSettings(merged);
        // If updater config changed, restart the background timer accordingly.
        if (before.autoCheck !== settings.autoCheck || before.updateRepo !== settings.updateRepo) {
            startAutoCheck();
        }
        // Power management — re-sync the idle watch / X blanking timers as soon
        // as the user changes them (no restart needed).
        if (before.autoLockMin !== settings.autoLockMin || before.autoSleepMin !== settings.autoSleepMin) {
            syncIdleWatch();
        }
        if (before.screenBlankMin !== settings.screenBlankMin) {
            const m = Number(settings.screenBlankMin);
            if (Number.isFinite(m) && m >= 0) applyScreenBlank(m);
            else restoreScreenBlankDefaults();
        }
        return settings;
    });

    // --- AI ---
    ipcMain.handle('ai:status', async () => {
        const be = aiBackend();
        const s = await aiAgent.status(be);
        return { ...s, enabled: settings.aiEnabled, model: be.model, backend: be.kind,
                 baseAiEnabled: settings.baseAiEnabled !== false,
                 aiEngine: aiEngine(), ollamaModel: settings.ollamaModel || '',
                 lmStudioOk: cpuAvxCaps().avx2 };
    });

    ipcMain.handle('ai:enable', async () => {
        // LM Studio is a user-launched desktop app, not a systemd service we own.
        // Enabling here means "the shell will route prompts to it"; the actual
        // server is started by the user in LM Studio's UI ("Start Server"). We
        // try launching the LM Studio helper as a convenience, but don't gate
        // success on it — the user may already have LM Studio running.
        settings = saveSettings({ ...settings, aiEnabled: true });
        const be = aiBackend();
        if (IS_LINUX) {
            // Fire-and-forget — never block the IPC reply on it.
            if (be.kind === 'base') ensureBaseModel().catch(() => {});       // built-in: pull model if missing
            else runShell('outlaw-lm-studio 2>/dev/null &', { timeout: 2000 }).catch(() => {});  // fallback: launch LM Studio
        }
        const s = await aiAgent.status(be);
        return { ok: true, enabled: true, available: s.available, model: be.model, backend: be.kind };
    });

    // Phase 13.2: pull the built-in base model on demand (first desktop run).
    ipcMain.handle('ai:ensure-base-model', async () => ensureBaseModel());

    ipcMain.handle('ai:disable', async () => {
        // Just flips the routing bit — we don't kill LM Studio, the user owns it.
        settings = saveSettings({ ...settings, aiEnabled: false });
        return { ok: true, enabled: false };
    });

    // Phase 4: read this PC's specs and recommend a local model + settings.
    ipcMain.handle('ai:recommend', async (_e, opts) => {
        // Phase 14d: opts = { purpose:'desktop'|'dev', tier, spill }. Specs are
        // cached; recompute the recommendation fresh for the chosen purpose so the
        // dev-vs-desktop + powerful/minimal + spill choices are honoured.
        const s = await gatherSpecs();
        const rec = recommendModel(s.ramGb, s.vramGb, opts || {});
        return { ok: true, ...s, ...rec };
    });

    // #2 — "use AI, not just a preset". After the deterministic recommendation is
    // shown, the on-device AI adds a short plain-language take on what THIS machine
    // can comfortably run and which engine fits best. Best-effort: if no AI is
    // reachable we return ok:false and the UI simply omits the paragraph (the
    // reliable preset recommendation is always shown either way).
    ipcMain.handle('ai:recommend-explain', async (_e, opts) => {
        try {
            const be = aiBackend();
            const st = await aiAgent.status(be);
            if (!st.available) return { ok: false };
            const s = await gatherSpecs();
            const rec = recommendModel(s.ramGb, s.vramGb, opts || {});
            const m = rec.recommended || {};
            const engineName = rec.recommendedEngine === 'base' ? 'the built-in model (no setup)'
                : rec.recommendedEngine === 'ollama' ? 'Ollama' : 'LM Studio';
            const sys = 'You are Cr1tt3r, this PC\'s on-device AI. In 2-3 short, friendly sentences, '
                + 'tell the user in plain language what their hardware can comfortably run for local AI and '
                + 'why the recommended engine fits. Be concrete but not technical. No lists, no JSON, no markdown.';
            const user = 'This computer: ' + machineSummary(s) + '. '
                + 'Recommended model: ' + (m.model || '?') + ' (' + (m.size || '?') + '). '
                + 'Recommended engine: ' + engineName + '. '
                + 'GPU offload: ' + (rec.gpuOffload ? 'yes' : 'no (CPU + RAM)') + '. '
                + 'Write the short take now.';
            const text = await aiAgent.chat(
                [{ role: 'system', content: sys }, { role: 'user', content: user }],
                { ...be, maxTokens: 180 },
            );
            const clean = String(text || '').trim();
            return clean ? { ok: true, text: clean } : { ok: false };
        } catch {
            return { ok: false };
        }
    });

    // Phase 4: hardware-aware setup guide. A plain-prose chat (NOT the JSON-intent
    // agent) whose system prompt already knows this PC's specs + the recommended
    // model, so even a tiny local model can walk the user through getting AI
    // running. Degrades to a clear "load the starter model first" hint when
    // LM Studio isn't serving yet.
    ipcMain.handle('ai:setup-chat', async (_e, payload) => {
        const userMsg = String((payload && payload.prompt) || '').slice(0, 2000).trim();
        if (!userMsg) return { ok: false, error: 'Ask a question first.' };
        const s = await gatherSpecs();
        const sys = [
            "You are OUTLAW's on-device AI setup guide. You help the operator get a "
                + 'private local AI running in LM Studio on THIS computer — everything '
                + 'stays local, no account or internet needed.',
            'This computer: ' + machineSummary(s),
            'Recommend the model above. If the machine is weak, steer them to the '
                + 'starter model first. Be friendly and practical: short answers, a '
                + 'short numbered list when giving steps. Plain text only — no JSON, no '
                + 'code fences unless quoting an exact setting value.',
        ].join('\n');
        const prior = Array.isArray(payload && payload.history)
            ? payload.history
                .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
                .slice(-6)
            : [];
        const messages = [{ role: 'system', content: sys }, ...prior, { role: 'user', content: userMsg }];
        try {
            const text = await aiAgent.chat(messages, { ...aiBackend(), maxTokens: 420 });
            return { ok: true, text: text || 'No reply.' };
        } catch (e) {
            return { ok: false, error: aiUnavailableMsg(aiBackend()) };
        }
    });

    ipcMain.handle('ai:ask', async (_e, payload) => {
        if (!settings.aiEnabled) return { error: 'AI is disabled. Enable it in Settings.' };
        // payload is a plain string (legacy) or { prompt, history, summary } so a
        // persistent chat can give Cr1tt3r conversation memory (Phase 15b).
        const prompt = typeof payload === 'string' ? payload : ((payload && payload.prompt) || '');
        const history = (payload && Array.isArray(payload.history)) ? payload.history : [];
        const summary = (payload && typeof payload.summary === 'string') ? payload.summary : '';
        // QoL — the renderer tells us if it's offline so the AI won't web-search.
        const online = !(payload && payload.online === false);
        const be = aiBackend();
        const s = await aiAgent.status(be);
        if (!s.available) {
            return { error: aiUnavailableMsg(be) };
        }
        try {
            const appIds = Object.keys(APP_REGISTRY);
            const machine = machineSummary(await gatherSpecs());
            // C6 — on the bundled base model the identity is fixed (Cr1tt3r).
            // On a model the user loaded themselves, hand the AI its self-chosen
            // persona (if any) and let it pick one (set_persona). undefined = base.
            const persona = (aiEngine() !== 'base')
                ? { name: settings.aiPersonaName || '', personality: settings.aiPersonaDesc || '' }
                : undefined;
            const intent = await aiAgent.ask(prompt, { ...be, appIds, machine, history, summary, sysSettings: settingsSummary(), persona, online });
            return await executeIntent(intent);
        } catch (e) {
            return { error: e.message };
        }
    });

    // Phase 15b — persistent AI chats: load/save the whole store (small JSON).
    ipcMain.handle('ai:chats:load', () => loadAiChats());
    ipcMain.handle('ai:chats:save', (_e, store) => ({ ok: saveAiChats(store) }));

    // Phase 15b (slice 2) — fold older turns into a running summary so long chats
    // keep memory without resending everything. Best-effort: on any failure the
    // caller keeps its prior summary. payload = { messages:[{role,content}], priorSummary }.
    ipcMain.handle('ai:summarize', async (_e, payload) => {
        const prior = (payload && typeof payload.priorSummary === 'string') ? payload.priorSummary : '';
        if (!settings.aiEnabled) return { summary: prior };
        const msgs = (payload && Array.isArray(payload.messages)) ? payload.messages : [];
        if (!msgs.length) return { summary: prior };
        const be = aiBackend();
        const s = await aiAgent.status(be);
        if (!s.available) return { summary: prior };
        try {
            const convo = msgs
                .map((m) => (m.role === 'user' ? 'User: ' : 'Cr1tt3r: ') + String(m.content || ''))
                .join('\n');
            const prompt = [
                { role: 'system', content: 'You keep a terse running summary of a chat. Preserve names, decisions, facts, and any unfinished threads. Reply with 4–8 short bullet points only — no preamble.' },
                { role: 'user', content: (prior ? 'Current summary:\n' + prior + '\n\n' : '') + 'New turns to fold in:\n' + convo + '\n\nReturn the updated summary as bullets.' },
            ];
            const summary = await aiAgent.chat(prompt, { ...be, maxTokens: 320 });
            return { summary: String(summary || prior || '').slice(0, 2000) };
        } catch {
            return { summary: prior };
        }
    });

    // Phase 16 — Ollama model management (status / list / pull) so the user can run
    // a LARGER model through Ollama as a full LM Studio replacement.
    ipcMain.handle('ollama:status', async () => {
        if (!IS_LINUX) return { installed: false, running: false };
        const installed = (await runShell('command -v ollama', { timeout: 4000 })).code === 0;
        let running = false;
        if (installed) {
            const r = await runShell('curl -sf -m 3 http://127.0.0.1:11434/api/tags', { timeout: 5000 });
            running = r.code === 0;
        }
        return { installed, running };
    });

    ipcMain.handle('ollama:list', async () => {
        if (!IS_LINUX) return { models: [] };
        const r = await runShell('ollama list 2>/dev/null', { timeout: 8000 });
        // Skip the header row; first column is the model tag.
        const models = (r.stdout || '').split('\n').slice(1)
            .map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
        return { models };
    });

    ipcMain.handle('ollama:pull', async (_e, model) => {
        if (!IS_LINUX) return { ok: false, error: 'Ollama runs on Outlaw Server.' };
        const name = String(model || '').trim();
        // Ollama tags look like "qwen2.5-coder:7b" — strict charset, passed as an
        // argv entry (no shell) so it can't be an injection.
        if (!/^[a-z0-9][a-z0-9._:/-]{0,60}$/i.test(name)) return { ok: false, error: 'Invalid model name.' };
        const labels = ['Preparing', 'Downloading model', 'Verifying', 'Finishing'];
        const matchers = [null, /pulling|downloading|manifest/i, /verifying|writing/i, /success/i];
        const r = await runStreamingJob('ollama', ['pull', name], labels, matchers);
        return { ok: r.ok, error: r.ok ? '' : 'Pull failed. Check the model name and your connection.' };
    });

    // QoL — current shell version, for the "Updated to vX.Y.Z" first-launch note.
    ipcMain.handle('app:version', () => APP_VERSION);

    // F1 — combined error/warning log (desktop + dev + xorg + journal).
    ipcMain.handle('errorlog:read', () => errorlog.read());
    ipcMain.handle('errorlog:collect', () => errorlog.collect());
    ipcMain.handle('errorlog:clear', () => { errorlog.clear(); return { ok: true }; });
    ipcMain.handle('errorlog:add', (_e, payload) => {
        const p = payload || {};
        errorlog.append(p.level || 'error', p.source || 'shell-ui', p.message || '');
        return { ok: true };
    });
    ipcMain.handle('errorlog:issue-url', () => errorlog.issueUrl(settings.updateRepo, APP_VERSION));
    // Open the repo's GitHub ISSUES page in the user's browser. The user just
    // copies the log and makes an issue there. We open the plain issues list (not
    // a prefilled-body URL, which can be too long to open) and launch Firefox
    // DIRECTLY — shell.openExternal relies on xdg-open, which can silently no-op in
    // the minimal kiosk session if no default browser is registered (that's why the
    // button "did nothing"). Falls back to openExternal if the browser won't resolve.
    ipcMain.handle('errorlog:open-issue', async () => {
        try {
            const repo = (settings.updateRepo || 'Sup095/Outlaw-Game-OS').trim();
            if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, error: 'No repository set.' };
            const url = `https://github.com/${repo}/issues`;
            const entry = APP_REGISTRY.browser;
            const bin = entry ? await resolveBinary(entry) : null;
            if (bin) { launchDetached(bin, [url]); return { ok: true }; }
            await shell.openExternal(url);
            return { ok: true };
        } catch (e) { return { ok: false, error: e.message }; }
    });

    ipcMain.handle('ai:confirm-action', async (_e, action) => {
        if (action && action.tool === 'run_command') {
            const r = await runShell(action.arg, { timeout: 120000 });
            return { text: (r.stdout || r.stderr || `(exit ${r.code})`).slice(0, 4000), did: 'run_command' };
        }
        // Phase 13: install a known-source app the user just approved. Streams to
        // the loading screen via runStreamingJob; uses the robust pkg helper.
        if (action && action.tool === 'install_app') {
            if (!IS_LINUX) return { ok: false, text: 'Installs run on Outlaw Server.', did: 'install_app' };
            const pkgs = [action.pkg, ...(Array.isArray(action.extra) ? action.extra : [])]
                .filter((p) => typeof p === 'string' && /^[a-z0-9][a-z0-9._+-]*$/.test(p));
            if (!pkgs.length) return { ok: false, text: 'Nothing valid to install.', did: 'install_app' };
            const labels = ['Preparing', 'Refreshing databases', `Installing ${action.label || action.pkg}`, 'Finishing'];
            const matchers = [null, /Synchronizing|Refreshing|multilib|keyring/i, /Installing|downloading|reinstalling|^:: |\(\d+\/\d+\)/i, /^>> Installing|installation finished|complete/i];
            const r = await runStreamingJob('pkexec', ['/usr/local/bin/outlaw-pkg-install', ...pkgs], labels, matchers);
            return { ok: r.ok, did: 'install_app',
                     text: r.ok ? `Installed ${action.label || action.pkg}.` : 'Install failed — see the log.' };
        }
        return { text: 'Nothing to do.' };
    });

    // --- Gaming ---
    ipcMain.handle('gaming:status', async () => {
        const out = { gamemode: false, mangohud: false, gpu: '' };
        if (IS_LINUX) {
            out.gamemode = !!(await which('gamemoded'));
            out.mangohud = !!(await which('mangohud'));
            const r = await runShell("lspci 2>/dev/null | grep -Ei 'vga|3d' | sed 's/^.*: //' | head -n 1");
            out.gpu = r.stdout;
        }
        return out;
    });

    ipcMain.handle('gaming:performance', async (_e, on) => {
        settings = saveSettings({ ...settings, performanceMode: !!on });
        if (IS_LINUX) {
            // Best-effort governor switch via the polkit-allowed helper.
            await runShell(`pkexec /usr/local/bin/outlaw-perf ${on ? 'performance' : 'schedutil'} 2>/dev/null || true`, { timeout: 8000 });
        }
        return { ok: true, performanceMode: settings.performanceMode };
    });

    // --- Power / hotswap ---
    ipcMain.handle('power:boot-targets', async () => {
        if (!IS_LINUX) return [];
        const r = await runShell('outlaw-hotswap --list 2>/dev/null');
        return r.stdout.split('\n').filter(Boolean);
    });
    ipcMain.handle('power:hotswap', async () => {
        if (!IS_LINUX) return { ok: false, error: 'Hotswap runs on Outlaw Server.' };
        launchDetached('outlaw-term', ['Outlaw Hotswap', 'outlaw-hotswap'], { focus: false });
        return { ok: true };
    });
    ipcMain.handle('power:reboot', async () => {
        if (!IS_LINUX) return { ok: true };
        const r = await runShell('systemctl reboot');
        if (r.code !== 0) {
            const err = (r.stderr || r.stdout || ('exit ' + r.code)).slice(-300);
            try { errorlog.append('error', 'power', 'reboot failed: ' + err); } catch {}
            return { ok: false, error: err };
        }
        return { ok: true };
    });
    ipcMain.handle('power:shutdown', async () => {
        if (!IS_LINUX) return { ok: true };
        const r = await runShell('systemctl poweroff');
        if (r.code !== 0) {
            const err = (r.stderr || r.stdout || ('exit ' + r.code)).slice(-300);
            try { errorlog.append('error', 'power', 'shutdown failed: ' + err); } catch {}
            return { ok: false, error: err };
        }
        return { ok: true };
    });
    // Sleep / suspend-to-RAM. Non-destructive and instantly reversible (any key/
    // power press wakes the machine), so no confirmation. logind normally allows
    // an active local session to suspend without a password.
    ipcMain.handle('power:suspend', async () => {
        if (!IS_LINUX) return { ok: true };
        const r = await runShell('systemctl suspend');
        if (r.code !== 0) {
            const err = (r.stderr || r.stdout || ('exit ' + r.code)).slice(-300);
            try { errorlog.append('error', 'power', 'suspend failed: ' + err); } catch {}
            return { ok: false, error: err };
        }
        return { ok: true };
    });

    // --- Updates / installer ---
    ipcMain.handle('updates:check', async () => {
        if (!IS_LINUX) return { updates: 0, note: 'Updates run on Outlaw Server.' };
        // checkupdates (pacman-contrib) counts updates safely without touching
        // the live DB. It exits 2 when there are none (→ 0 lines, fine). If it's
        // somehow missing, say so instead of silently reporting 0.
        const has = await runShell('command -v checkupdates >/dev/null 2>&1 && echo yes');
        if (!/yes/.test(has.stdout || '')) return { updates: 0, note: 'Update check tool missing — run a full update to refresh.' };
        const r = await runShell('checkupdates 2>/dev/null | grep -c .', { timeout: 1000 * 60 });
        return { updates: parseInt((r.stdout || '0').trim(), 10) || 0 };
    });
    ipcMain.handle('updates:apply', async () => {
        if (!IS_LINUX) return { ok: false, error: 'Updates run on Outlaw Server.' };
        // Full system upgrade via the helper (ABSOLUTE path; passwordless via
        // the 49-outlaw polkit rule). -Syu is the only safe way to update on
        // Arch and covers every app installed from the Apps panel too.
        const r = await privUpdate(1000 * 60 * 30);
        const tail = (r.stdout || r.stderr || `exit ${r.code}`).slice(-4000);
        if (r.code !== 0) {
            const hint = /could not|failed to synchronize|connect|network/i.test(tail)
                ? ' (couldn\'t reach the servers — check Settings → Network & Wi-Fi)' : '';
            // C9 — capture update failures so the user can send them from the log.
            try { errorlog.append('error', 'updater', 'System update (pacman -Syu) failed: ' + tail.slice(-600)); } catch {}
            return { ok: false, error: tail, hint };
        }
        return { ok: true, log: tail };
    });

    // C8 — "use storage as extra memory" (a swapfile). status reads without root;
    // set toggles the helper via pkexec. Lets a low-RAM box avoid OOM under AI load.
    ipcMain.handle('swap:status', async () => {
        if (!IS_LINUX || !fs.existsSync('/usr/local/bin/outlaw-swap'))
            return { ok: false, swapTotalMb: 0, swapfile: false };
        const r = await runShell('/usr/local/bin/outlaw-swap status', { timeout: 8000 });
        const out = r.stdout || '';
        const m = out.match(/swap_total_mb=(\d+)/);
        return { ok: true, swapTotalMb: m ? parseInt(m[1], 10) : 0, swapfile: /swapfile=present/.test(out) };
    });
    ipcMain.handle('swap:set', async (_e, payload) => {
        if (!IS_LINUX) return { ok: false, error: 'Storage-as-memory runs on Outlaw Server.' };
        const on = !!(payload && payload.on);
        const sizeGb = Math.max(1, Math.min(64, parseInt((payload && payload.sizeGb) || 4, 10) || 4));
        const cmd = on
            ? `pkexec /usr/local/bin/outlaw-swap on ${sizeGb}`
            : 'pkexec /usr/local/bin/outlaw-swap off';
        const r = await runShell(cmd, { timeout: 1000 * 60 * 8 });
        const tail = (r.stdout || r.stderr || `exit ${r.code}`).slice(-2000);
        if (r.code !== 0) {
            try { errorlog.append('error', 'swap', 'Storage-as-memory ' + (on ? 'enable' : 'disable') + ' failed: ' + tail.slice(-400)); } catch {}
            return { ok: false, error: tail };
        }
        return { ok: true, log: tail };
    });

    // QoL — Storage cleanup. Read-only SCAN reports reclaimable space; CLEAN removes
    // only well-known SAFE caches: the pacman package cache trimmed to the newest
    // version of each package (paccache -rk1 — the standard safe cleanup), plus the
    // user's thumbnail cache and Trash (both regenerate on demand). It NEVER removes
    // installed packages, orphans or app data. Helpful on near-full disks.
    ipcMain.handle('storage:scan', async () => {
        if (!IS_LINUX) return { ok: false, error: 'Storage cleanup runs on Outlaw Server.' };
        // du -sm prints size in MiB; sum the safe targets. Old pacman cache = total
        // cache minus what paccache would keep (approx via a dry-run line count is
        // unreliable, so we report the whole cache as the upper bound + the rest).
        const sh = "pacc=$(du -sm /var/cache/pacman/pkg 2>/dev/null | cut -f1); "
            + "thumb=$(du -sm \"$HOME/.cache/thumbnails\" 2>/dev/null | cut -f1); "
            + "trash=$(du -sm \"$HOME/.local/share/Trash\" 2>/dev/null | cut -f1); "
            + "echo \"pacc=${pacc:-0} thumb=${thumb:-0} trash=${trash:-0}\"";
        const r = await runShell(sh, { timeout: 15000 });
        const out = r.stdout || '';
        const num = (k) => { const m = out.match(new RegExp(k + '=(\\d+)')); return m ? parseInt(m[1], 10) : 0; };
        const paccMb = num('pacc'), thumbMb = num('thumb'), trashMb = num('trash');
        return { ok: true, paccMb, thumbMb, trashMb, totalMb: paccMb + thumbMb + trashMb };
    });
    ipcMain.handle('storage:clean', async () => {
        if (!IS_LINUX) return { ok: false, error: 'Storage cleanup runs on Outlaw Server.' };
        // User-owned caches first (no password needed): thumbnails + Trash.
        await runShell('rm -rf "$HOME/.cache/thumbnails/"* "$HOME/.local/share/Trash/files/"* "$HOME/.local/share/Trash/info/"* 2>/dev/null; true',
            { timeout: 30000 });
        // System pacman cache (one admin prompt): keep the newest 1 of each package.
        // paccache ships with pacman-contrib, which is part of the base install.
        const r = await runShell('pkexec paccache -rk1', { timeout: 1000 * 60 * 3 });
        if (r.code !== 0) {
            const tail = (r.stderr || r.stdout || `exit ${r.code}`).slice(-600);
            try { errorlog.append('warn', 'storage', 'pacman cache cleanup did not complete: ' + tail.slice(-300)); } catch {}
            // The user-space part still succeeded — report partial success.
            return { ok: true, partial: true, note: 'Cleared thumbnails + Trash. The package-cache step was skipped (' + tail.split('\n').pop() + ').' };
        }
        return { ok: true, log: (r.stdout || '').slice(-600) };
    });

    // Shell self-updater (downloads from your GitHub Releases).
    ipcMain.handle('updates:check-shell', async () => {
        try {
            const info = await updater.checkShellUpdate({
                repo: settings.updateRepo,
                currentVersion: APP_VERSION,
                channel: settings.updateChannel || 'stable',
            });
            settings = saveSettings({ ...settings, lastUpdateCheck: Date.now() });
            return { ok: true, ...info };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    ipcMain.handle('updates:install-shell', async (_e, info) => {
        let tmp;
        try {
            if (!info || !info.assetUrl) return { ok: false, error: 'No update payload supplied.' };
            const dl = await updater.downloadShellUpdate(info);
            tmp = dl.tmp;
            const { tarPath, sha } = dl;
            if (!IS_LINUX) {
                return { ok: false, error: `Downloaded to ${tarPath}. Installation step only runs on Outlaw Server.` };
            }
            // The privileged helper verifies SHA again, extracts atomically, and swaps /usr/share/outlaw-os.
            const cmd = `pkexec /usr/local/bin/outlaw-update-apply ${JSON.stringify(tarPath)} ${JSON.stringify(sha)}`;
            const r = await runShell(cmd, { timeout: 1000 * 60 * 10 });
            if (r.code !== 0) {
                const msg = (r.stderr || r.stdout || `exit ${r.code}`).slice(-2000);
                try { errorlog.append('error', 'updater', 'Shell/component update failed: ' + msg.slice(-600)); } catch {}
                return { ok: false, error: msg };
            }
            return { ok: true, log: (r.stdout || '').slice(-2000), restart: true };
        } catch (e) {
            try { errorlog.append('error', 'updater', 'Shell update failed: ' + ((e && e.message) || e)); } catch {}
            return { ok: false, error: e.message };
        } finally {
            // outlaw-update-apply has fully consumed tarPath (re-verify + extract +
            // swap, synchronously) by the time the await resolves, so the downloader's
            // temp dir — holding the tens-of-MB tarball — is no longer needed. It was
            // only removed on a checksum mismatch before, so every SUCCESSFUL update
            // orphaned it in /tmp. Best-effort cleanup of a dir the code itself made.
            if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* gone already */ } }
        }
    });

    // Rollback: swap /usr/share/outlaw-os with .prev. Used by the Rollback
    // button below the updater. We probe for availability first so the button
    // can be disabled when there's nothing to roll back to.
    ipcMain.handle('updates:rollback-check', async () => {
        if (!IS_LINUX) return { available: false, note: 'Rollback runs on Outlaw Server.' };
        // The .prev directory is owned by root and not world-readable in places;
        // probe it via a tiny shell test instead of fs.access (which would EACCES
        // for non-root readers).
        const r = await runShell('test -d /usr/share/outlaw-os.prev && test -f /usr/share/outlaw-os.prev/main.js && echo yes', { timeout: 4000 });
        return { available: (r.stdout || '').trim() === 'yes' };
    });

    ipcMain.handle('updates:rollback', async () => {
        if (!IS_LINUX) return { ok: false, error: 'Rollback runs on Outlaw Server.' };
        const r = await runShell('pkexec /usr/local/bin/outlaw-update-rollback', { timeout: 1000 * 60 * 2 });
        if (r.code !== 0) {
            const msg = (r.stderr || r.stdout || `exit ${r.code}`).slice(-2000);
            try { errorlog.append('error', 'updater', 'Rollback failed: ' + msg.slice(-600)); } catch {}
            return { ok: false, error: msg };
        }
        return { ok: true, log: (r.stdout || '').slice(-2000), restart: true };
    });
    ipcMain.handle('installer:launch', async () => {
        if (!IS_LINUX) return { ok: false, error: 'Installer runs from the live boot media.' };
        // outlaw-install-gui opens the point-and-click installer wizard (and
        // handles its own focus poke + falls back to the terminal installer if
        // the GUI app is missing). focus:false — the launcher does it itself.
        launchDetached('outlaw-install-gui', [], { focus: false });
        return { ok: true };
    });

    // Advisory community-stability tally for the INSTALLED version. Reads the
    // public 👍/👎 reaction counts on the matching GitHub release. The local
    // "your vote" is persisted client-side in settings (stabilityReports);
    // this handler only fetches the shared signal. Read-only, no auth.
    ipcMain.handle('stability:tally', async () => {
        try {
            const t = await updater.getStabilityTally({
                repo: settings.updateRepo,
                version: APP_VERSION,
            });
            return { ok: true, version: updater.normalize(APP_VERSION), ...t };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    // Phase 7: build a pre-filled GitHub issue so a "works / broken" report
    // actually reaches the maintainer with context. Server-less: we just return
    // the URL; the user reviews + submits on GitHub. The Reporter ID is an
    // anonymous, stable-per-machine hash so duplicate reports can be merged.
    ipcMain.handle('stability:report-url', async (_e, verdict) => {
        const repo = (settings.updateRepo || '').trim();
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
            return { ok: false, error: 'Set the GitHub repository in Settings first.' };
        }
        const v = updater.normalize(APP_VERSION);
        const broken = verdict === 'broken';
        // Anonymous machine fingerprint (a hash, never the raw id) for de-dup.
        let mid = '';
        try { if (IS_LINUX) mid = fs.readFileSync('/etc/machine-id', 'utf8').trim(); } catch {}
        if (!mid) mid = os.hostname() || 'unknown';
        const rid = crypto.createHash('sha256').update('outlaw:' + mid).digest('hex').slice(0, 8);
        let cpu = (os.cpus()[0] || {}).model || 'CPU', cores = os.cpus().length;
        let gpu = 'unknown', ram = 'unknown', kernel = os.release();
        try {
            const s = await gatherSpecs();
            cpu = s.cpu || cpu; cores = s.cores || cores;
            gpu = s.gpuName || 'unknown'; if (s.vramGb) gpu += ` (${s.vramGb} GB VRAM)`;
            ram = (s.ramGb || '?') + ' GB';
        } catch {}
        if (IS_LINUX) { try { const k = await runShell('uname -r'); if (k.code === 0 && k.stdout) kernel = k.stdout; } catch {} }
        let safeGfx = false;
        try { safeGfx = fs.existsSync(path.join(os.homedir(), '.outlaw-safe-gfx')); } catch {}
        const title = `[build report] v${v} — ${broken ? 'broken' : 'works'}`;
        const body = [
            '### Build report',
            '',
            `- **Verdict:** ${broken ? '❌ Broken' : '✅ Works'}`,
            `- **Version:** v${v} (${settings.updateChannel || 'stable'} channel)`,
            `- **Reporter ID:** \`${rid}\` (anonymous, stable per machine — for de-duplication)`,
            '',
            '**System**',
            `- CPU: ${cpu} (${cores} cores)`,
            `- GPU: ${gpu}`,
            `- RAM: ${ram}`,
            `- Kernel: ${kernel}`,
            `- Safe graphics: ${safeGfx ? 'yes' : 'no'}`,
            '',
            broken ? '**What went wrong?** (steps, error text, screenshots if you can)'
                   : '**Anything to add?** (optional)',
            '> ',
            '',
            '<!-- generated by Outlaw Server · Help Test This Version -->',
        ].join('\n');
        const url = `https://github.com/${repo}/issues/new`
            + `?title=${encodeURIComponent(title)}`
            + `&body=${encodeURIComponent(body)}`
            + `&labels=${encodeURIComponent('build-report')}`;
        return { ok: true, url };
    });

    // --- Phase 9: session graphics/driver profiles --------------------------
    // outlaw-driver-profile installs USERSPACE graphics packages only (Vulkan /
    // Mesa / 32-bit libs / GameMode) — never kernel modules, KMS or the
    // bootloader, so it can't affect booting. detect/packages are read-only;
    // apply/revert self-elevate via pkexec (passwordless polkit allowlist).
    const DRIVER_PROFILE = '/usr/local/bin/outlaw-driver-profile';
    ipcMain.handle('drivers:detect', async () => {
        if (!IS_LINUX) return { ok: false, error: 'Graphics profiles run on Outlaw Server.' };
        const r = await runShell(`${DRIVER_PROFILE} detect`, { timeout: 8000 });
        try { return { ok: true, ...JSON.parse(r.stdout || '{}') }; }
        catch { return { ok: false, error: 'Could not detect the graphics hardware.' }; }
    });
    ipcMain.handle('drivers:preview', async () => {
        if (!IS_LINUX) return { ok: false, error: 'Graphics profiles run on Outlaw Server.' };
        const r = await runShell(`${DRIVER_PROFILE} packages`, { timeout: 8000 });
        return { ok: true, packages: (r.stdout || '').trim().split(/\s+/).filter(Boolean) };
    });
    ipcMain.handle('drivers:apply', async () => {
        if (!IS_LINUX) return { ok: false, error: 'Graphics profiles run on Outlaw Server.' };
        // Phase 12: stream to the loading screen (live phases + log) instead of a
        // single blocking call with output dumped at the end.
        const labels = ['Preparing', 'Refreshing databases', 'Installing graphics packages', 'Finishing'];
        const matchers = [
            null,
            /Synchronizing|Refreshing|multilib|keyring/i,
            /Installing|downloading|reinstalling|^:: |\(\d+\/\d+\)/i,
            /^>> Done|installation finished|complete/i,
        ];
        return runStreamingJob('pkexec', [DRIVER_PROFILE, 'apply', 'gaming'], labels, matchers);
    });
    ipcMain.handle('drivers:revert', async () => {
        if (!IS_LINUX) return { ok: false, error: 'Graphics profiles run on Outlaw Server.' };
        const r = await runShell(`pkexec ${DRIVER_PROFILE} revert`, { timeout: 1000 * 60 * 5 });
        return r.code === 0
            ? { ok: true, output: (r.stdout || '').slice(-800) }
            : { ok: false, error: (r.stderr || r.stdout || 'Revert failed.').slice(-800) };
    });

    // (The old "Tune This PC" feature was removed — the AI assistant now handles
    // per-machine setting changes directly via set_setting. The outlaw-tune helper
    // remains on disk for any manual/advanced use but is no longer wired to the UI.)

    // --- Safe mode marker (set by outlaw-session-watchdog after a crash loop) ----
    ipcMain.handle('safe-mode:check', () => {
        if (!IS_LINUX) return { active: false, reason: '' };
        const markerPath = path.join(os.homedir(), '.outlaw-safe-mode');
        try {
            if (!fs.existsSync(markerPath)) return { active: false, reason: '' };
            const reason = fs.readFileSync(markerPath, 'utf8').trim();
            // Delete after reading — banner is one-shot. If the user enters
            // another crash loop, the watchdog writes a fresh marker.
            try { fs.unlinkSync(markerPath); } catch { /* ignored */ }
            return { active: true, reason };
        } catch {
            return { active: false, reason: '' };
        }
    });

    // --- Emergency stop (Ctrl+Alt+K from the renderer) ---------------------
    // Kills every tracked subprocess we've spawned. Last-resort escape hatch
    // for hung pacman installs, runaway terminal commands, etc.
    ipcMain.handle('emergency:stop', () => {
        const n = killAllTrackedProcs();
        return { ok: true, killed: n };
    });

    // --- Session preference (set by greeter's "Always start in this session"
    // checkbox; reset here so the greeter shows on next boot). ------------
    ipcMain.handle('session:reset-greeter-pref', () => {
        if (!IS_LINUX) return { ok: false, error: 'Greeter pref lives on Outlaw Server.' };
        const prefPath = path.join(os.homedir(), '.outlaw-session-pref');
        try {
            // Writing "ask" is more explicit than deleting — the greeter's
            // readPref() handles both, but a present file makes the user's
            // intent obvious if they ever cat it.
            fs.writeFileSync(prefPath, 'ask\n', { mode: 0o600 });
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    // --- Session switching (Dev vs Desktop, via the boot greeter) ----------
    // The shell can mark the next X session as "dev" by writing two files in
    // the user's home: ~/.outlaw-session (the choice) and
    // ~/.outlaw-session.honor-once (a one-shot signal to the greeter to skip
    // its prompt). Then we quit so the X session ends — agetty autologin +
    // .bash_profile + .xinitrc bring the user back into outlaw-codemaker.
    ipcMain.handle('session:switch-dev', async () => {
        if (!IS_LINUX) {
            return { ok: false, error: 'Session switching runs on Outlaw Server.' };
        }
        try {
            const home = os.homedir();
            fs.writeFileSync(path.join(home, '.outlaw-session'), 'dev\n', { mode: 0o600 });
            fs.writeFileSync(path.join(home, '.outlaw-session.honor-once'), '', { mode: 0o600 });
        } catch (err) {
            return { ok: false, error: err.message };
        }
        // Give the renderer a beat to render the "switching…" toast before we
        // tear down the window.
        setTimeout(() => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
            app.quit();
        }, 350);
        return { ok: true };
    });

    // Is the Dev session actually runnable here? It is iff a Python interpreter
    // (the CodeMaker venv first, else system python3) can import PyQt6 — i.e.
    // CodeMaker will start instead of crashing. Mirrors /usr/local/bin/
    // outlaw-codemaker. On the live ISO this is false until outlaw-setup-dev
    // builds the venv. Lets the UI offer to download the dev env before a switch.
    ipcMain.handle('session:dev-status', async () => {
        if (!IS_LINUX) return { ready: false, reason: 'not-linux' };
        const probe = 'p=/opt/outlaw-codemaker/.venv/bin/python; [ -x "$p" ] || p="$(command -v python3)"; '
            + '{ [ -n "$p" ] && "$p" -c "import PyQt6.QtCore" >/dev/null 2>&1 && echo READY; } || echo NOPE';
        const r = await runShell(probe, { timeout: 8000 });
        return { ready: /READY/.test(r.stdout || '') };
    });

    // Download + build the Dev environment on demand (live ISO / repair). It's
    // long and network-heavy, so run it in a visible terminal (outlaw-term
    // focuses it + holds it open) rather than silently in the background.
    ipcMain.handle('session:setup-dev', async () => {
        if (!IS_LINUX) return { ok: false, error: 'Runs on Outlaw Server.' };
        launchDetached('outlaw-term', ['Set up Dev session', 'outlaw-setup-dev'], { focus: false });
        return { ok: true };
    });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
    // Fill the WHOLE screen. The Outlaw session runs with no window manager, so
    // a plain `fullscreen: true` request is often ignored and the window opens
    // as a small box in the centre (the symptom users hit on real hardware).
    // Sizing the frameless window to the primary display's exact resolution
    // fills the screen WITH or WITHOUT a WM, and fitToScreen() re-applies it on
    // any display-size change (e.g. a VM window being resized). Off-Linux (dev
    // preview on Windows/macOS) we keep a normal resizable window.
    const wa = screen.getPrimaryDisplay().workArea;
    mainWindow = new BrowserWindow({
        // Frameless backdrop sized to the work area (leaves room for the
        // taskbar). skipTaskbar so the desktop shell doesn't list itself in the
        // taskbar it sits behind. With a WM, app windows float above this;
        // without one, it's the same full-screen kiosk as before.
        ...(IS_LINUX
            ? { x: wa.x, y: wa.y, width: wa.width, height: wa.height, frame: false, skipTaskbar: true }
            : { width: 1280, height: 820 }),
        backgroundColor: '#050505',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false,
        },
    });
    mainWindow.setMenu(null);
    if (IS_LINUX) fitToScreen(mainWindow);
    mainWindow.loadFile('index.html');

    // Open all external links in the system browser, never inside the shell.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (e, url) => {
        if (url !== mainWindow.webContents.getURL()) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
    });
}

// ---------------------------------------------------------------------------
// Background update check (Windows-style: quietly poll, notify on new release)
// ---------------------------------------------------------------------------
async function backgroundUpdateCheck() {
    if (!settings.autoCheck || !settings.updateRepo) return;
    // C11 offline mode — don't attempt background network while offline /
    // airplane mode. Chromium's connectivity signal is free to read; manual
    // "Check now" still tries regardless (the user asked, so show the error).
    try { if (!net.online) return; } catch { /* older Electron — just try */ }
    try {
        const info = await updater.checkShellUpdate({ repo: settings.updateRepo, currentVersion: APP_VERSION, channel: settings.updateChannel || 'stable' });
        settings = saveSettings({ ...settings, lastUpdateCheck: Date.now() });
        if (info.available && info.remoteVersion !== settings.lastNotifiedVersion) {
            settings = saveSettings({ ...settings, lastNotifiedVersion: info.remoteVersion });
            sendToast(`Update available: v${info.remoteVersion} — open Settings to install.`);
        }
    } catch (e) {
        // Silent in the background; manual checks surface the error.
        console.warn('Background update check failed:', e.message);
    }
}

function startAutoCheck() {
    if (autoCheckTimer) clearInterval(autoCheckTimer);
    if (!settings.autoCheck) return;
    setTimeout(backgroundUpdateCheck, 30 * 1000);        // first check ~30s after boot
    autoCheckTimer = setInterval(backgroundUpdateCheck, 6 * 60 * 60 * 1000); // every 6h
}

app.whenReady().then(() => {
    registerIpc();
    // Phase 14h — make sure the greeter can already see the current theme on the
    // very next boot, even for users who set it before this feature existed (they
    // wouldn't have re-saved settings). Cheap one-shot write.
    mirrorThemeToHome(settings && settings.theme);
    // Re-apply the user's saved keyboard layout for the session (setxkbmap is
    // session-global and resets to the default each login).
    applyKbLayout(settings && settings.kbLayout);
    // Re-apply saved night light (X gamma resets each login) and Do Not Disturb.
    // DND is delayed a few seconds because dunst is still coming up from .xinitrc
    // when the shell launches; night light needs no daemon so it applies at once.
    if (settings && settings.nightLight) applyNightLight(true, settings.nightLightTemp);
    if (settings && settings.dnd) setTimeout(() => applyDnd(true), 4000);
    // Power management — restore the saved screen-blank timers and start the
    // idle watch (a no-op interval-wise when both timeouts are 0/off).
    applyScreenBlank(settings && settings.screenBlankMin);
    syncIdleWatch();
    // Display — re-apply modes the user explicitly KEPT, but only after
    // re-validating each against what xrandr lists right now (monitor swapped
    // or mode gone → skip silently, native mode stays). Never-break-boot:
    // an invalid/failed apply changes nothing. Brightness likewise (floored).
    if (IS_LINUX && settings && settings.displayModes && Object.keys(settings.displayModes).length) {
        (async () => {
            try {
                const outputs = await _displayInfo();
                for (const [name, m] of Object.entries(settings.displayModes)) {
                    if (!m || !m.mode) continue;
                    const o = outputs.find((x) => x.name === name);
                    const mm = o && o.modes.find((x) => x.mode === m.mode);
                    if (!mm) continue;
                    const rate = (m.rate && mm.rates.includes(m.rate)) ? m.rate : '';
                    await _xrandrApply(name, m.mode, rate);
                }
            } catch { /* display restore is best-effort */ }
        })();
    }
    if (IS_LINUX && settings && Number(settings.brightnessPct) >= 5) {
        try { applyBrightnessPct(settings.brightnessPct); } catch { /* best-effort */ }
    }
    createWindow();
    startAutoCheck();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
