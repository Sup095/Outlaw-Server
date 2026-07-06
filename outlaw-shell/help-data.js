// ============================================================================
// Outlaw OS — Help database (Phase 6)
// ----------------------------------------------------------------------------
// A structured, shipped-in-the-image docs database. Each entry explains one
// part of the OS or one troubleshooting topic. The Help screen (renderer.js)
// renders these grouped by `cat` and searches title + keywords + body.
//
// Bodies are trusted, author-written HTML (simple tags only). Keep them short
// and practical. To add a topic: append an object; `cat` should match one of
// OUTLAW_HELP_CATS (new categories appear at the end).
// ============================================================================
window.OUTLAW_HELP_CATS = [
    'Getting started', 'The desktop', 'Apps & games', 'AI',
    'Dev session', 'System tools', 'Settings & updates', 'Troubleshooting',
];

window.OUTLAW_HELP = [
    // ---- Getting started ---------------------------------------------------
    {
        id: 'what-is', cat: 'Getting started', title: 'What is Outlaw OS?',
        keywords: 'overview about intro what outlaw os godot ai',
        body: '<p><b>Outlaw OS</b> is a lightweight, security-minded Linux desktop built for '
            + 'AI-driven game development with <b>Godot</b>. It has two sides: the <b>Desktop</b> '
            + '(this shell — apps, games, AI assistant, system tools) and the <b>Dev session</b> '
            + '(<b>Outlaw CodeMaker</b>, an AI agent that helps you build games). You pick which '
            + 'one to open at the boot greeter.</p>',
    },
    {
        id: 'first-steps', cat: 'Getting started', title: 'First things to do',
        keywords: 'setup begin start new fresh checklist wifi pin theme',
        body: '<ol><li>Connect to the internet — <b>Settings → Network &amp; Wi-Fi</b>.</li>'
            + '<li>Set a <b>PIN</b> if you want sign-in — <b>Settings → Security</b>.</li>'
            + '<li>Pick a look — <b>Settings → Appearance</b> (Green Phosphor or Gold Gunmetal).</li>'
            + '<li>Install your apps — <b>Apps</b> page (Steam, Firefox, Godot…).</li>'
            + '<li>Set up local AI — <b>AI Assistant → Set up your private AI → Check my PC</b>.</li></ol>',
    },
    {
        id: 'sessions', cat: 'Getting started', title: 'Desktop vs Dev session',
        keywords: 'greeter switch session dev desktop codemaker boot choose',
        body: '<p>At boot, the <b>greeter</b> lets you choose <b>Desktop</b> (this shell) or '
            + '<b>Dev</b> (Outlaw CodeMaker). You can switch later from <b>Settings → Session → '
            + 'Switch to Dev session</b>. Tick "always start in this session" to skip the greeter; '
            + 'reset that under <b>Settings → Session → Show greeter on next boot</b>.</p>',
    },

    // ---- The desktop -------------------------------------------------------
    {
        id: 'nav', cat: 'The desktop', title: 'Finding your way around',
        keywords: 'navigation sidebar screens menu layout dashboard',
        body: '<p>The left <b>sidebar</b> switches screens: Dashboard, System Core, Files, '
            + 'Task Manager, Terminal, Gaming, Game Dev, Apps, AI Assistant, Calculator and '
            + 'Settings. The top bar shows live CPU/RAM and the clock.</p>',
    },
    {
        id: 'windows', cat: 'The desktop', title: 'Windows & the taskbar',
        keywords: 'minimize maximize close taskbar tint2 openbox window manage drag',
        body: '<p>App windows have normal title-bar buttons — <b>minimize, maximize, close</b> — '
            + 'and a <b>taskbar</b> along the bottom shows what’s open (left-click to '
            + 'restore/hide, middle-click to close). This is handled by a tiny window manager '
            + '(openbox + tint2) that loads on top of the desktop.</p>',
    },
    {
        id: 'themes', cat: 'The desktop', title: 'Themes & the retro look',
        keywords: 'theme appearance green phosphor gold gunmetal broken glitch crt scanline color fault',
        body: '<p><b>Settings → Appearance</b> switches between <b>Green Phosphor</b> (classic '
            + 'terminal green), <b>Gold Gunmetal</b> (the sci-fi-fortress look that matches '
            + 'CodeMaker) and <b>Broken</b> — a machine barely holding together: washed-out '
            + 'phosphor, flicker, glitch bursts and fake <b>SYSTEM FAULT</b> pop-ups (pure '
            + 'theatre — nothing is actually wrong, and they never touch the real error log). '
            + 'There’s also an optional <b>CRT</b> effect. <b>Reduce motion</b> stills all of it. '
            + 'The whole UI recolors instantly — no restart.</p>',
    },

    // ---- Apps & games ------------------------------------------------------
    {
        id: 'apps', cat: 'Apps & games', title: 'Installing apps',
        keywords: 'apps install software packages essentials catalog pacman',
        body: '<p>The <b>Apps</b> page installs software for you. <b>Essentials</b> (Steam, '
            + 'Firefox, Godot) and security tools may ask for your password. Everything installs '
            + 'through the system package manager, so updates are handled centrally '
            + '(<b>Settings → System Package Updates</b>).</p>',
    },
    {
        id: 'on-this-pc', cat: 'Apps & games', title: 'Apps already on this PC',
        keywords: 'on this pc discover installed appimage desktop launch found',
        body: '<p>The Apps page has an <b>On this PC</b> view that auto-discovers everything '
            + 'you’ve installed — both regular <code>.desktop</code> apps and <b>AppImages</b> '
            + 'you download into Downloads/Applications. One click launches them; no manual '
            + 'refresh needed.</p>',
    },
    {
        id: 'appimages', cat: 'Apps & games', title: 'Running AppImages',
        keywords: 'appimage download run executable fuse lm studio chmod',
        body: '<p>An <b>AppImage</b> is a single-file app. Save it to <b>Downloads</b> or '
            + '<b>Applications</b> and it shows up under <b>Apps → On this PC</b>. Outlaw makes it '
            + 'executable and runs it for you (it includes FUSE support, with an automatic '
            + 'fallback if FUSE is missing). LM Studio is installed exactly this way.</p>',
    },

    // ---- AI ----------------------------------------------------------------
    {
        id: 'ai-setup', cat: 'AI', title: 'Setting up local AI',
        keywords: 'ai lm studio ollama built-in model download setup check pc recommend server engine',
        body: '<p>Open <b>AI Assistant</b> and click <b>Check my PC</b> — Outlaw reads your RAM, GPU and '
            + 'CPU, recommends a model your hardware can run, and tells you the best <b>engine</b> for it. '
            + 'You have three choices (see <i>AI engines</i>): the <b>built-in</b> model is already on — '
            + 'zero setup; <b>Ollama</b> takes one command to pull a bigger model; <b>LM Studio</b> is a '
            + 'point-and-click app. Pick the engine in <b>Settings → AI &amp; VRAM</b>. Stuck? Use the '
            + '<b>Ask the AI to set itself up</b> box — it already knows your exact hardware.</p>',
    },
    {
        id: 'ai-assistant', cat: 'AI', title: 'Using the AI Assistant',
        keywords: 'assistant chat ask commands open app search private local',
        body: '<p>Everything runs <b>locally</b> — no account, nothing leaves your machine. Ask '
            + 'questions, or give commands like <i>open steam</i>, <i>search godot tutorials</i> or '
            + '<i>list files</i>. It already knows your hardware, so it can answer things like '
            + '“can my PC run a bigger model?”</p>',
    },
    {
        id: 'system-core', cat: 'AI', title: 'The System Core',
        keywords: 'system core telemetry diagnostics voice tts live ai sci-fi monitor',
        body: '<p>The <b>System Core</b> is the sci-fi centerpiece: live telemetry (CPU/RAM/GPU), '
            + 'three-tier <b>diagnostics</b>, and an optional <b>Live AI</b> with a dystopian '
            + 'persona that can run checks and open apps. It can speak aloud if you enable '
            + '<b>System Core voice</b> in Settings (needs a TTS engine).</p>',
    },

    // ---- Dev session -------------------------------------------------------
    {
        id: 'dev-session', cat: 'Dev session', title: 'The Dev session (Outlaw CodeMaker)',
        keywords: 'dev codemaker game development agent godot switch session pyqt',
        body: '<p><b>Outlaw CodeMaker</b> is the AI game-dev agent — a separate session focused '
            + 'on building Godot games (project picker, new-game wizard, AI that plans and edits). '
            + 'Open it from the <b>greeter</b> or <b>Settings → Session → Switch to Dev session</b>. '
            + 'The first switch may download its tools; let it finish.</p>',
    },

    // ---- System tools ------------------------------------------------------
    {
        id: 'task-manager', cat: 'System tools', title: 'Task Manager',
        keywords: 'task manager end task process tree kill cpu ram gpu vram filter',
        body: '<p><b>Task Manager</b> lists everything running. Type in <b>Filter by name</b> to '
            + 'find an app, click its row, then <b>End task</b> (close nicely) or <b>End process '
            + 'tree</b> (force-close it and what it started). The cards up top show live '
            + '<b>CPU, memory and GPU/VRAM</b>. Some processes belong to the administrator and '
            + 'show <i>needs admin</i> when ended — that’s normal.</p>',
    },
    {
        id: 'terminal', cat: 'System tools', title: 'The Secure Terminal',
        keywords: 'terminal command shell sudo pacman destructive confirm rm',
        body: '<p>A normal shell running in your home folder as you. <b>Destructive commands</b> '
            + '(<code>rm -rf</code>, <code>dd</code>, <code>mkfs</code>…) are intercepted and '
            + 'need you to type <b>CONFIRM</b> first, so you can’t wipe the machine by '
            + 'accident. Use <code>sudo</code> for admin tasks.</p>',
    },
    {
        id: 'files', cat: 'System tools', title: 'Files',
        keywords: 'files browse folders open file manager thunar documents downloads',
        body: '<p>Browse your folders (Downloads, Documents, Pictures, Projects…). If a file '
            + 'won’t open from here, use <b>Open in file manager</b> to launch the full file '
            + 'manager (Thunar), which has the right “open with” handlers.</p>',
    },

    // ---- Settings & updates ------------------------------------------------
    {
        id: 'updates', cat: 'Settings & updates', title: 'Updating Outlaw OS',
        keywords: 'update updater shell channel stable beta repair package upgrade version',
        body: '<p><b>Settings → Outlaw Shell Updates</b> updates Outlaw itself (shell + all its '
            + 'components) with one click, and keeps the previous version for rollback. '
            + '<b>System Package Updates</b> updates every installed app + the system. '
            + 'Note: before v1.0 there’s <b>no difference</b> between the Stable and Beta '
            + 'channels — both get the newest build. <b>Reinstall / repair all components</b> fixes '
            + 'a half-applied update without touching your files.</p>',
    },
    {
        id: 'security', cat: 'Settings & updates', title: 'PIN, lock & sign-in',
        keywords: 'pin sign in lock password security authorize unlock picker greeter session screen power menu',
        body: '<p><b>Settings → Security</b> lets you set a <b>4-digit PIN</b> and require sign-in '
            + 'on startup. With a PIN set, the <b>session picker</b> also asks for it before you can '
            + 'choose Desktop or Dev, and you can <b>lock the screen any time</b> from the power menu '
            + '(⏻ → 🔒 Lock). The PIN (or your password) is also asked before important installs like '
            + 'Essentials and security tools. Forgot the PIN? Use <b>Use password instead</b> (your '
            + 'account password) at any sign-in or the picker.</p>',
    },

    {
        id: 'reviewer', cat: 'Settings & updates', title: 'Help test this version (reporting)',
        keywords: 'report works broken test feedback stable channel review version github issue tally',
        body: '<p><b>Settings → Help Test This Version</b> lets you tell the maintainer whether a '
            + 'build works. Click <b>✓ Works for me</b> or <b>✗ Having problems</b> and Outlaw opens a '
            + '<b>pre-filled GitHub issue</b> — just review and Submit. It includes the version and a '
            + 'short system summary (no account info; an anonymous machine hash lets duplicate reports '
            + 'be merged). The <b>Community tally</b> shows 👍/👎 reactions on the release. Enough '
            + 'positive reports is how a build eventually gets promoted to the <b>stable</b> channel.</p>',
    },

    // ---- Troubleshooting ---------------------------------------------------
    {
        id: 'trouble-boot', cat: 'Troubleshooting', title: 'It won’t boot / black screen',
        keywords: 'boot black screen wont start graphics kms virtualbox vm bare metal',
        body: '<p>Outlaw is built and tested for <b>bare-metal</b> machines — that’s the '
            + 'supported path. Virtual machines (especially VirtualBox on a Windows host with '
            + 'Hyper-V/WSL2 enabled) are flaky and <b>not officially supported</b>. On real '
            + 'hardware, a black screen after the menu usually means a graphics-mode hiccup — try '
            + 'rebooting once. If it persists, note your GPU and report it.</p>',
    },
    {
        id: 'trouble-gfx', cat: 'Troubleshooting', title: 'Desktop crashes or black screen (safe graphics)',
        keywords: 'crash black screen safe mode graphics gpu intel software gl mesa picom watchdog',
        body: '<p>If the desktop crashes on startup, Outlaw automatically retries in <b>safe '
            + 'graphics</b> — software rendering with GPU acceleration turned off — which runs on '
            + 'practically any hardware (handy for flaky Intel/Mesa GPUs that report '
            + '“failed to load module intel”). It then <b>stays</b> in safe graphics so it can’t '
            + 'crash-loop; everything still works, it’s just not GPU-accelerated. To retry your '
            + 'GPU later, open a <b>Terminal</b> and run <code>rm ~/.outlaw-safe-gfx</code>, then '
            + 'reboot.</p>',
    },
    {
        id: 'trouble-wifi', cat: 'Troubleshooting', title: 'No internet / Wi-Fi',
        keywords: 'wifi internet network offline connect nmcli download fails forget saved password changed',
        body: '<p>Go to <b>Settings → Network &amp; Wi-Fi</b>, scan, pick your network and enter '
            + 'the password. A wired cable works automatically. Most “install failed” or '
            + '“can’t download” errors are simply no connection — check here first. If a network\'s '
            + 'password <b>changed</b> and it keeps failing, hit <b>Forget</b> on its row in the scan '
            + 'list (deletes the stale saved profile), then connect fresh with the new password.</p>',
    },
    {
        id: 'display-settings', cat: 'Settings & updates', title: 'Display resolution & brightness',
        keywords: 'display resolution refresh rate hz monitor screen mode xrandr brightness backlight dim revert',
        body: '<p><b>Settings → Display</b> lists every connected screen with its available '
            + 'resolutions and refresh rates (only modes the display itself reports — nothing '
            + 'experimental). Hit <b>Apply</b> and you get <b>15 seconds</b> to click <i>Keep '
            + 'settings</i>; if you don\'t — say the picture went black — the OS <b>reverts on its '
            + 'own</b>, so you can\'t get stuck. Kept modes are restored on every boot (and '
            + 're-checked against the connected display first). <b>Reset to automatic</b> puts '
            + 'everything back on native modes. On laptops the same card has a <b>Brightness</b> '
            + 'slider (also in ☰ quick settings) — it dims but never goes fully dark.</p>',
    },
    {
        id: 'screen-recording', cat: 'The desktop', title: 'Screen recording',
        keywords: 'screen record recording video capture clip movie ffmpeg rec videos',
        body: '<p>Record the screen from the topbar <b>☰ quick settings → 🎥</b> (or the command '
            + 'palette). A red <b>⏺ REC</b> pill appears in the top bar while recording — click it to '
            + 'stop. Clips save to <b>~/Videos</b> as MP4 (video-only). Needs the <b>ffmpeg</b> package '
            + '— if it\'s missing, install it from <b>Apps</b> (search “ffmpeg”). The OS won\'t '
            + 'auto-sleep while a recording is running.</p>',
    },
    {
        id: 'sound-output', cat: 'The desktop', title: 'Volume & sound output device',
        keywords: 'volume sound audio output device speakers headphones headset hdmi sink mute',
        body: '<p>Click the <b>🔊 speaker</b> in the top bar for the volume slider and mute. When more '
            + 'than one output exists (speakers, a headset, HDMI audio), an <b>Output device</b> list '
            + 'appears underneath — click one to switch the default output instantly.</p>',
    },
    {
        id: 'trouble-ai', cat: 'Troubleshooting', title: 'LM Studio won’t connect',
        keywords: 'lm studio not reachable ai disabled start server port 1234 model',
        body: '<p>If the AI says LM Studio isn’t reachable: open LM Studio, <b>load a '
            + 'model</b>, then click <b>Start Server</b> (it must be on <b>port 1234</b>). Then '
            + 'turn on <b>Enable on-device AI</b> in Settings. If the button won’t open LM '
            + 'Studio, make sure the <code>.AppImage</code> is in your Downloads/Applications '
            + 'folder and press <b>Get / Open LM Studio</b> again.</p>',
    },
    {
        id: 'trouble-install', cat: 'Troubleshooting', title: 'Install problems',
        keywords: 'install installer partition disk erase free space windows shrink wifi',
        body: '<p>Connect to the internet <b>before</b> installing (the installer needs to '
            + 'download packages). Choose <b>erase a disk</b> or <b>use free space</b>. '
            + 'Automatic Windows-partition shrinking had a bug that a recent update fixed; if it '
            + 'still fails for you, make free space first (e.g. shrink the partition from Windows), '
            + 'then pick <b>use free space</b>.</p>',
    },

    // ---- New in the 2.0.x hardening + QOL stream ----------------------------
    {
        id: 'airplane-offline', cat: 'Settings & updates', title: 'Airplane mode & offline mode',
        keywords: 'airplane offline wifi radio network disconnect plane flight internet bluetooth',
        body: '<p><b>Airplane mode</b> (<b>Settings → Network &amp; Wi-Fi</b>) turns your Wi-Fi '
            + '(and Bluetooth) off in one tap — handy on a plane or to save power. <b>Offline mode</b> '
            + 'is automatic: whenever there is no internet, a badge appears and Outlaw stops attempting '
            + 'web actions (update checks, model downloads, web search) so nothing hangs. Either way, '
            + 'everything local — your AI, files, apps and projects — keeps working normally.</p>',
    },
    {
        id: 'storage-as-ram', cat: 'Settings & updates', title: 'Use storage as extra memory',
        keywords: 'ram memory swap swapfile storage low-end oom out of memory slow pagefile',
        body: '<p>On a machine short on RAM, turn on <b>Use storage as extra memory</b> '
            + '(<b>Settings → AI &amp; VRAM</b>). It adds a 4&nbsp;GB swapfile so the system can keep '
            + 'an AI model and the desktop running instead of running out of memory. It is slower than '
            + 'real RAM and uses 4&nbsp;GB of disk, and you can turn it off any time.</p>',
    },
    {
        id: 'ai-personalities', cat: 'AI', title: 'AI names & personalities',
        keywords: 'personality name cr1tt3r varmint outlaw core persona model character rename system core',
        body: '<p>Outlaw has three separate AI personas, each in its own place: <b>Cr1tt3r</b> is your '
            + 'desktop AI Assistant; <b>V4rm1nt</b> is the coder in the Dev session (Outlaw CodeMaker); and '
            + 'the <b>OUTLAW CORE</b> is the voice of the System Core command center. They are distinct on '
            + 'purpose and don\'t change. If you switch the desktop assistant to a different model you loaded '
            + 'yourself, you can invite <i>that</i> model to <b>pick its own name and personality</b> — just '
            + 'ask. The bundled built-in model always stays Cr1tt3r.</p>',
    },
    {
        id: 'system-core-hub', cat: 'System tools', title: 'System Core (command center)',
        keywords: 'system core hub command center telemetry diagnostics control ai health rings',
        body: '<p>The <b>System Core</b> is your command center: live CPU / RAM / VRAM rings, '
            + 'diagnostics, and one-tap actions — <b>Ask Cr1tt3r</b>, <b>Report a Problem</b>, '
            + '<b>Screenshot</b>, update, and performance mode. To change settings for your hardware, '
            + 'just ask Cr1tt3r (e.g. "use less VRAM"). The Report button even shows '
            + 'how many issues are in the error log.</p>',
    },
    {
        id: 'report-problem', cat: 'Troubleshooting', title: 'Report a problem (send the error log)',
        keywords: 'error log report problem crash bug github send diagnostics issue picker clear copy',
        body: '<p>If something failed, crashed, or bounced you to the session picker, open '
            + '<b>Settings → Report a problem</b> (or <b>System Core → Report a Problem</b>). '
            + 'Click <b>Collect errors</b> to gather a deduplicated log from the desktop, the Dev '
            + 'session, Xorg, the system journal, and any failed checks or warnings from the '
            + '<b>System Core diagnostics</b>, then <b>Copy</b> it, click <b>Open GitHub issues</b>, '
            + 'and paste it into a new issue. When you\'re done reporting, click <b>Clear</b> so '
            + 'already-sent errors don\'t pile up with new ones. This is the best way to get boot '
            + 'crash-loops fixed.</p>',
    },
    {
        id: 'shortcuts', cat: 'The desktop', title: 'Keyboard shortcuts',
        keywords: 'keyboard shortcut hotkey keys ctrl alt esc space palette quick ask navigate switch screen settings terminal history',
        body: '<p><b>Ctrl + Space</b> — the command palette: search apps, settings, help and actions from anywhere. '
            + '<b>Ctrl + K</b> — jump to the AI assistant and start typing (a quick ask). '
            + '<b>Ctrl + ,</b> — open Settings. '
            + '<b>Alt + 1…9</b> — jump to the matching sidebar screen (1 = Dashboard, 2 = System Core, and so on). '
            + '<b>Esc</b> — close the palette, any popover, the power menu, or a finished loading screen. '
            + '<b>PrtSc</b> — save a screenshot to Pictures (<b>Shift+PrtSc</b> to drag-select a region). '
            + 'In the assistant, press <b>Enter</b> to send. In the Terminal, <b>↑ / ↓</b> recall previous commands.</p>',
    },
    {
        id: 'accessibility', cat: 'Settings & updates', title: 'Accessibility options',
        keywords: 'accessibility a11y high contrast text size zoom reduce motion keyboard navigation screen reader legibility focus',
        body: '<p><b>Settings → Appearance</b> has the comfort and legibility options: <b>Text size</b> scales '
            + 'the whole interface, <b>High contrast</b> brightens text and strengthens borders and focus '
            + 'outlines, and <b>Reduce motion</b> turns off decorative animation. The desktop is fully '
            + 'keyboard-navigable — <b>Tab</b> moves between controls, toggles flip with <b>Space</b>, and '
            + '<b>Esc</b> backs out of any popover or dialog. See the <i>Keyboard shortcuts</i> topic for the '
            + 'global keys (Ctrl+Space command palette, Alt+1…9 screens, and more).</p>',
    },
    {
        id: 'command-palette', cat: 'The desktop', title: 'Command palette (search everything)',
        keywords: 'command palette search everything launcher spotlight find quick open ctrl space',
        body: '<p>Press <b>Ctrl + Space</b> anywhere to open the <b>command palette</b> — one search box over '
            + 'every screen, settings section, help topic, app and common action (screenshot, lock, sleep, '
            + 'night light…). Type a few letters, pick with <b>↑ ↓</b>, run with <b>Enter</b>. It\'s the fastest '
            + 'way to get anywhere in Outlaw OS.</p>',
    },
    {
        id: 'quick-settings', cat: 'The desktop', title: 'Quick settings (topbar ☰)',
        keywords: 'quick settings control center panel toggles topbar volume night light dnd airplane performance popover',
        body: '<p>Click the <b>☰</b> button in the top bar for <b>quick settings</b>: night light, Do Not '
            + 'Disturb, airplane mode and performance mode as one-tap tiles, plus volume, screenshot, lock and '
            + 'sleep — without opening the full Settings screen. Click the <b>clock</b> for a calendar.</p>',
    },
    {
        id: 'power-management', cat: 'Settings & updates', title: 'Screen blanking & automatic sleep',
        keywords: 'power management screen blank turn off display sleep idle automatic suspend timeout energy',
        body: '<p><b>Settings → Power</b> controls what happens when you step away: <b>Turn off the screen '
            + 'when idle</b> blanks the display (any key wakes it), and <b>Sleep when idle</b> suspends the whole '
            + 'computer. Keyboard and mouse activity in <i>any</i> app counts. <b>Heads up:</b> controller-only '
            + 'play can look idle to the system — if you game with a gamepad, use a long sleep timeout or leave it '
            + 'on Never. Sleep also waits for any running install or download to finish. Pair these with '
            + '<b>Auto-lock when idle</b> (Settings → Security) to lock the desktop too.</p>',
    },
    {
        id: 'gaming', cat: 'Apps & games', title: 'Gaming (Steam, Lutris, GameMode)',
        keywords: 'gaming games steam lutris gamemode mangohud play proton fps',
        body: '<p>The <b>Gaming</b> page launches <b>Steam</b> and <b>Lutris</b> (click to install if '
            + 'missing) and shows your GPU plus whether <b>GameMode</b> and <b>MangoHud</b> are available. '
            + 'For the best performance, install the <b>gaming graphics profile</b> in Settings → Session and '
            + 'turn on <b>Performance Mode</b> while you play.</p>',
    },
    {
        id: 'gamedev-tools', cat: 'Apps & games', title: 'Game-dev tools (Godot, Blender, GIMP)',
        keywords: 'game dev godot blender gimp vscode code editor art assets tools',
        body: '<p>The <b>Game Dev</b> page launches the tools you build games with — <b>Godot</b>, '
            + '<b>Blender</b>, <b>GIMP</b> and a code editor (click to install if missing). To have the AI '
            + 'write your game <i>for</i> you, switch to the <b>Dev session</b> (Outlaw CodeMaker) from the '
            + 'boot greeter instead.</p>',
    },
    {
        id: 'hotswap', cat: 'System tools', title: 'Hotswap (boot another OS)',
        keywords: 'hotswap boot reboot other os windows dual boot grub switch power menu',
        body: '<p><b>Hotswap</b> (the power menu ⏻, or the topbar button) reboots you straight into another '
            + 'operating system on your machine — handy for dual-boot setups. Pick the OS and the machine '
            + 'restarts into it. <i>Known issue being worked on:</i> on some setups it currently needs a '
            + 'second manual reboot to take.</p>',
    },
    {
        id: 'performance-mode', cat: 'Settings & updates', title: 'Performance Mode',
        keywords: 'performance mode gaming cpu governor speed power fps boost',
        body: '<p><b>Performance Mode</b> (in the System Core command center) switches your CPU to a '
            + 'performance governor for more speed while gaming or building — at the cost of a little more '
            + 'power. Toggle it off to return to balanced/power-saving. Safe and fully reversible.</p>',
    },
    {
        id: 'drivers', cat: 'Settings & updates', title: 'Graphics / driver profiles',
        keywords: 'driver graphics gpu vulkan mesa gaming profile lean session nvidia amd intel',
        body: '<p><b>Settings → Session</b> has a one-click <b>gaming graphics profile</b> that installs the '
            + 'userspace Vulkan/Mesa + 32-bit stack (plus GameMode/MangoHud) for your GPU, and a <b>lean</b> '
            + 'profile that reverts it. It\'s applied after boot via the package manager — userspace only, '
            + 'never the kernel driver or bootloader — so it\'s fully revertible.</p>',
    },
    {
        id: 'ai-tune', cat: 'AI', title: 'Let the AI change settings for you',
        keywords: 'tune settings auto recommend best optimize vram performance ai cr1tt3r change adjust',
        body: '<p>Just <b>ask Cr1tt3r</b> in plain language and it changes the setting for you — '
            + '"use less VRAM", "switch the AI to LM Studio", "turn on performance mode", "make the text bigger", '
            + '"use the green theme". It can set the VRAM/RAM saver, visual effects, performance mode, update '
            + 'checks, text size and the AI engine. Every change is safe and reversible.</p>',
    },
    {
        id: 'ai-engines', cat: 'AI', title: 'AI engines — built-in, Ollama or LM Studio',
        keywords: 'ai engine base built-in ollama lm studio lmstudio model switch backend local',
        body: '<p>Outlaw can run its local AI three ways — pick one in <b>Settings → AI &amp; VRAM</b>: '
            + '<b>Built-in</b> (a tiny model that ships with Outlaw — already on, zero setup); '
            + '<b>Ollama</b> (one command to pull bigger models; works on any GPU or CPU); and '
            + '<b>LM Studio</b> (a point-and-click app you download). Use <b>Check my PC</b> in the AI '
            + 'Assistant and Outlaw recommends the best engine and model for your hardware, then walks '
            + 'you through it. Everything runs on this machine — no account, nothing leaves your PC.</p>',
    },
    {
        id: 'vram-saver', cat: 'AI', title: 'VRAM saver modes',
        keywords: 'vram saver mode auto off lean minimal video memory gpu tier ai context',
        body: '<p>The <b>VRAM saver</b> (<b>Settings → AI &amp; VRAM</b>) controls how hard Outlaw trims '
            + 'AI video-memory use so the desktop stays responsive: <b>Auto</b> (recommended) kicks in only '
            + 'when free VRAM runs low; <b>Off</b> never trims (use it if you have VRAM to spare); '
            + '<b>Lean</b> always uses smaller AI contexts (predictable, lighter); <b>Minimal</b> is a '
            + 'bare-bones emergency mode that also pauses System Core voice + Live mode to free the most '
            + 'memory. The System Core badge shows the current tier.</p>',
    },
    {
        id: 'volume', cat: 'The desktop', title: 'Volume & sound',
        keywords: 'volume sound audio mute speaker loud quiet topbar slider pipewire',
        body: '<p>Click the <b>speaker icon</b> (🔊) on the top bar to open the volume slider and a '
            + '<b>mute</b> button. Drag the slider to set the level, or click the speaker to mute/unmute. '
            + 'The icon hides on machines with no audio hardware.</p>',
    },
    {
        id: 'battery', cat: 'The desktop', title: 'Battery indicator & low-battery warnings',
        keywords: 'battery laptop charge charging percent power topbar low warning critical',
        body: '<p>On laptops, the top bar shows your <b>battery percentage</b> with 🔋 (on battery) or '
            + '⚡ (charging). It turns red below 15% when unplugged, and the OS warns you once at '
            + '<b>20%</b> and again (urgently) at <b>10%</b> so you\'re never surprised by a dead '
            + 'battery. Plugging in resets the warnings. Desktop computers with no battery don\'t '
            + 'show any of this.</p>',
    },
    {
        id: 'sleep', cat: 'The desktop', title: 'Sleep / suspend',
        keywords: 'sleep suspend power menu standby resume wake shutdown reboot',
        body: '<p>Open the <b>power menu</b> (⏻ on the top bar) and choose <b>🌙 Sleep</b> to suspend the '
            + 'computer to RAM — it powers down almost everything but keeps your session in memory. Press a '
            + 'key or the power button to wake it back exactly where you left off. You can also just ask the '
            + 'AI: "put the computer to sleep".</p>',
    },
    {
        id: 'bluetooth', cat: 'The desktop', title: 'Bluetooth devices',
        keywords: 'bluetooth pair connect headphones controller mouse keyboard wireless blueman device',
        body: '<p>In <b>Settings → Network &amp; Wi-Fi</b>, the <b>🔵 Bluetooth</b> row turns the adapter on/off '
            + 'and <b>Pair a device…</b> opens the Bluetooth manager to pair headphones, controllers, a mouse '
            + 'and so on. Airplane mode turns Bluetooth off along with Wi-Fi. If it says "no adapter found", '
            + 'this machine has no Bluetooth hardware.</p>',
    },
    {
        id: 'region-input', cat: 'The desktop', title: 'Keyboard layout, time zone & clock',
        keywords: 'keyboard layout language region time zone timezone clock ntp date input setxkbmap',
        body: '<p><b>Settings → Region &amp; Input</b> lets you pick your <b>keyboard layout</b> (applied right '
            + 'away and on every boot), your <b>time zone</b>, and whether the clock <b>sets itself '
            + 'automatically</b> over the internet. Changing the time zone or auto-time asks for your password.</p>',
    },
    {
        id: 'night-light', cat: 'The desktop', title: 'Night light (warm the screen)',
        keywords: 'night light blue light warm color temperature eye strain evening gammastep redshift dark',
        body: '<p><b>Settings → Desktop &amp; Notifications → 🌙 Night light</b> warms the screen\'s colors to '
            + 'cut blue light in the evening, which is easier on the eyes. Pick how warm it goes under '
            + '<b>Warmth</b>. It re-applies itself on every boot while it\'s on, and turning it off restores '
            + 'normal colors instantly.</p>',
    },
    {
        id: 'do-not-disturb', cat: 'The desktop', title: 'Do Not Disturb (pause notifications)',
        keywords: 'do not disturb dnd notifications pause silence quiet mute popup dunst focus',
        body: '<p><b>Settings → Desktop &amp; Notifications → 🔕 Do Not Disturb</b> silences pop-up '
            + 'notifications so nothing interrupts you. <b>Show last</b> re-displays the most recent one, and '
            + '<b>Show recent</b> lists the latest notifications so a missed pop-up isn\'t lost. Your '
            + 'choice sticks across reboots. DND is also a one-tap tile in the topbar <b>☰</b> quick settings.</p>',
    },
    {
        id: 'auto-lock', cat: 'Settings & updates', title: 'Auto-lock when idle',
        keywords: 'auto lock idle timeout screen lock security pin away inactivity',
        body: '<p><b>Settings → Security &amp; sign-in → Auto-lock when idle</b> locks the desktop for you '
            + 'after a stretch of no keyboard or mouse activity, so it\'s protected if you step away. It needs '
            + 'a <b>PIN</b> set first, and you unlock the same way as at sign-in.</p>',
    },
    {
        id: 'free-up-space', cat: 'System tools', title: 'Free up disk space',
        keywords: 'storage disk space full clean cleanup cache pacman thumbnails trash reclaim low',
        body: '<p>Low on disk space? <b>Settings → Free up space</b> reclaims room safely. Click '
            + '<b>Scan</b> to see how much you can get back, then <b>Clean up</b> — it clears the old '
            + '<b>package-download cache</b> (keeping the newest of each package), <b>thumbnails</b> and '
            + 'the <b>Trash</b>. It never touches your installed apps, files or settings. You may be asked '
            + 'for your password for the package-cache part.</p>',
    },
    {
        id: 'calculator', cat: 'System tools', title: 'Calculator',
        keywords: 'calculator calc math arithmetic add subtract multiply divide numbers',
        body: '<p>The <b>Calculator</b> (sidebar) is a simple desktop calculator: click the number '
            + 'buttons and operators (÷ × − +) and <b>=</b> to calculate, or just type on your keyboard. '
            + 'Press <b>C</b> or <b>Esc</b> to clear. Basic arithmetic — no memory or scientific functions.</p>',
    },
];
