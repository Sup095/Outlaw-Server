// ============================================================================
// Outlaw Server — Help database (Phase 6)
// ----------------------------------------------------------------------------
// A structured, shipped-in-the-image docs database. Each entry explains one
// part of the OS or one troubleshooting topic. The Help screen (renderer.js)
// renders these grouped by `cat` and searches title + keywords + body.
//
// Bodies are trusted, author-written HTML (simple tags only). Keep them short
// and practical. To add a topic: append an object; `cat` should match one of
// OUTLAW_HELP_CATS (new categories appear at the end).
//
// RULE: every topic here must describe something this OS actually does. A help
// database that documents features which were stripped out is worse than no
// help at all — it sends people looking for buttons that don't exist.
// ============================================================================
window.OUTLAW_HELP_CATS = [
    'Getting started', 'The panel', 'Remote access', 'Server software',
    'System tools', 'Settings & updates', 'Troubleshooting',
];

window.OUTLAW_HELP = [
    // ---- Getting started ---------------------------------------------------
    {
        id: 'what-is', cat: 'Getting started', title: 'What is Outlaw Server?',
        keywords: 'overview about intro what outlaw server linux arch headless',
        body: '<p><b>Outlaw Server</b> is a stripped-down, security-minded Linux server OS you '
            + 'manage from a web browser. One box, one job: run your servers — game servers '
            + 'first — and make managing them painless.</p>'
            + '<p>Everything a desktop needs and a server doesn’t has been removed. What’s left '
            + 'is the control panel you’re looking at, the <b>outlaw</b> command-line tool, and '
            + 'the boring-but-critical parts: updates, the error log, health checks and a '
            + 'guarded terminal.</p>',
    },
    {
        id: 'first-steps', cat: 'Getting started', title: 'First things to do',
        keywords: 'setup begin start new fresh checklist order password 2fa network',
        body: '<ol><li><b>Set the admin password</b> — run <code>sudo outlaw passwd</code>. It '
            + 'prints a two-factor secret; add it to your authenticator app now.</li>'
            + '<li><b>Confirm 2FA works</b> — <code>sudo outlaw 2fa &lt;user&gt; &lt;code&gt;</code>. '
            + 'Until you do this, two-factor is <i>not</i> enforced, so a mistyped secret can’t '
            + 'lock you out.</li>'
            + '<li><b>Check the network</b> — <b>Settings → Network &amp; Wi-Fi</b>.</li>'
            + '<li><b>Add your SSH key</b> — <b>Settings → SSH keys</b>, so you can get in '
            + 'without a password.</li>'
            + '<li><b>Set up remote access</b> — <code>sudo outlaw remote up</code>, then '
            + '<code>sudo outlaw remote bind tunnel</code>.</li>'
            + '<li><b>Install what you actually need</b> — <b>Apps</b> page. A fresh machine '
            + 'ships with none of it.</li></ol>',
    },
    {
        id: 'sign-in', cat: 'Getting started', title: 'Signing in (password + 2FA)',
        keywords: 'login sign in password 2fa totp authenticator aegis code admin passwd secret',
        body: '<p>The panel needs a <b>password</b> and a <b>six-digit code</b> from an '
            + 'authenticator app. Create the administrator with <code>sudo outlaw passwd</code> — '
            + 'it prints the two-factor secret once.</p>'
            + '<p>Add that secret to a free authenticator: <b>Aegis</b> (open source, recommended), '
            + '<b>Ente Auth</b> or Google Authenticator. Then prove it works with '
            + '<code>sudo outlaw 2fa &lt;user&gt; &lt;code&gt;</code>.</p>'
            + '<p><b>Two-factor is not enforced until that confirmation succeeds.</b> That is '
            + 'deliberate — a secret you copied down wrong can’t lock you out of your own '
            + 'server.</p>'
            + '<p>Five bad attempts locks that address out for 15 minutes. Every sign-in and '
            + 'privileged action is recorded — see <code>outlaw audit</code>.</p>',
    },
    {
        id: 'panel-vs-lean', cat: 'Getting started', title: 'Panel mode vs Lean mode',
        keywords: 'mode panel lean headless ui optional overhead ram resources listener',
        body: '<p>Every install picks a mode, and can switch at any time with '
            + '<code>sudo outlaw mode panel</code> / <code>sudo outlaw mode lean</code>.</p>'
            + '<ul><li><b>Panel</b> — the full browser UI on <code>http://127.0.0.1:7717</code>. '
            + 'Easiest to run and configure. Costs a little RAM for the daemon.</li>'
            + '<li><b>Lean</b> — no UI and <b>nothing listening at all</b>. SSH plus the '
            + '<code>outlaw</code> command. Nothing renders, nothing polls.</li></ul>'
            + '<p>Either way the OS does <b>no background work when nothing is being asked of '
            + 'it</b> — no idle timers, no telemetry, no polling loops.</p>',
    },
    {
        id: 'two-frontends', cat: 'Getting started', title: 'At the machine, or from a browser',
        keywords: 'console local browser remote same ui screen monitor keyboard frontend',
        body: '<p>There are two ways to see this panel, and they show <b>the same screens</b> '
            + 'backed by the same operations:</p>'
            + '<ul><li><b>At the machine</b> — plug in a monitor and it’s already on screen.</li>'
            + '<li><b>From a browser</b> — over your private tunnel, from a laptop or phone '
            + 'anywhere (see <i>Remote access</i>).</li></ul>'
            + '<p>Nothing is “local only”. Anything you can do sitting at the box you can do from '
            + 'the couch, and the other way round.</p>',
    },

    // ---- The panel ---------------------------------------------------------
    {
        id: 'nav', cat: 'The panel', title: 'Finding your way around',
        keywords: 'navigation sidebar screens menu layout dashboard where',
        body: '<p>The left <b>sidebar</b> switches screens:</p>'
            + '<ul><li><b>Dashboard</b> — machine summary and storage at a glance.</li>'
            + '<li><b>Files</b> — browse the filesystem.</li>'
            + '<li><b>Services</b> — start, stop and enable systemd units.</li>'
            + '<li><b>System Log</b> — the journal, filtered and searchable.</li>'
            + '<li><b>Firewall</b> — open and close ports.</li>'
            + '<li><b>Remote Access</b> — where the panel is reachable from.</li>'
            + '<li><b>Task Manager</b> — live CPU/RAM and what’s using them.</li>'
            + '<li><b>Terminal</b> — a guarded shell.</li>'
            + '<li><b>Apps</b> — Docker, Portainer, Cockpit and Pterodactyl.</li>'
            + '<li><b>AI Helper</b> — optional, off unless you set it up.</li>'
            + '<li><b>Settings</b> and <b>Help</b>.</li></ul>'
            + '<p>The top bar shows live CPU/RAM and the clock.</p>',
    },
    {
        id: 'shortcuts', cat: 'The panel', title: 'Keyboard shortcuts',
        keywords: 'keyboard shortcuts hotkeys keys ctrl alt palette search emergency stop',
        body: '<ul><li><b>Ctrl + Space</b> — command palette: search every screen, setting and '
            + 'action.</li>'
            + '<li><b>Alt + 1…9</b> — jump straight to the Nth sidebar screen.</li>'
            + '<li><b>Ctrl + ,</b> — Settings.</li>'
            + '<li><b>Ctrl + K</b> — ask the AI helper from anywhere.</li>'
            + '<li><b>Esc</b> — close whatever is on top (palette, dialog, menu), one at a '
            + 'time.</li>'
            + '<li><b>Ctrl + Alt + K</b> — <b>emergency stop</b>: kills every subprocess the '
            + 'panel started. A last resort if something hangs the interface.</li></ul>'
            + '<p>Every control is reachable with <b>Tab</b> and <b>Enter</b> alone — nothing '
            + 'needs a mouse.</p>',
    },
    {
        id: 'themes', cat: 'The panel', title: 'Themes & the retro look',
        keywords: 'theme appearance green phosphor gold gunmetal broken glitch crt scanline color',
        body: '<p><b>Settings → Appearance</b> switches between <b>Green Phosphor</b> (classic '
            + 'terminal green), <b>Gold Gunmetal</b> (the sci-fi-fortress look) and <b>Broken</b> — '
            + 'a machine barely holding together: washed-out phosphor, flicker, glitch bursts and '
            + 'fake <b>SYSTEM FAULT</b> pop-ups.</p>'
            + '<p><b>Broken is pure theatre.</b> Nothing is actually wrong, and it never touches '
            + 'the real error log. If you’re demoing a server to someone, you probably want it '
            + 'off.</p>'
            + '<p>There’s also an optional <b>CRT</b> effect and a phosphor <b>glow</b>. The whole '
            + 'UI recolors instantly — no restart.</p>',
    },
    {
        id: 'accessibility', cat: 'The panel', title: 'Accessibility options',
        keywords: 'accessibility a11y contrast motion text size scale readable screen reader legible eyes',
        body: '<p><b>Settings → Appearance</b>:</p>'
            + '<ul><li><b>Reduce motion</b> — stops every decorative animation, transition and '
            + 'glitch effect. Also lighter on weak hardware.</li>'
            + '<li><b>High contrast</b> — brighter text, no faded elements, stronger borders and '
            + 'much stronger focus outlines.</li>'
            + '<li><b>Text size</b> — Compact / Normal / Large / Extra large, scaling the whole '
            + 'interface.</li>'
            + '<li><b>Reset appearance</b> — puts all of it back to defaults if you’ve made it '
            + 'unreadable.</li></ul>'
            + '<p>Turning off <b>CRT scanlines</b> and <b>phosphor glow</b> gives the crispest, '
            + 'most legible text.</p>',
    },

    // ---- Remote access -----------------------------------------------------
    {
        id: 'remote-why', cat: 'Remote access', title: 'Why the panel refuses most addresses',
        keywords: 'bind refuse listen loopback tunnel lan public wildcard http plain exits security',
        body: '<p>The panel speaks <b>plain HTTP</b>. So it is only ever allowed to listen in two '
            + 'places: <b>loopback</b> (this machine alone), or <b>an address that belongs to a '
            + 'WireGuard/Tailscale interface</b> — where everything is already encrypted end to '
            + 'end before it touches a wire.</p>'
            + '<p>A LAN address, a public address or a wildcard bind is <b>refused, and the daemon '
            + 'exits</b>. That is deliberately stronger than a firewall rule: the socket is never '
            + 'created on those interfaces at all, so there is no rule to get wrong, and nothing '
            + 'to forget after a reboot.</p>'
            + '<p>If you see <code>REFUSING to listen</code> in the log, that is this rule doing '
            + 'its job — see <i>“REFUSING to listen” at startup</i>.</p>',
    },
    {
        id: 'tailscale', cat: 'Remote access', title: 'Reaching it from anywhere (Tailscale)',
        keywords: 'tailscale remote anywhere tunnel vpn tailnet join login url free account magicdns',
        body: '<p><b>Tailscale</b> builds a private encrypted network between your own devices. '
            + 'It’s free for personal use, and it means your control panel is never exposed to '
            + 'the open internet — there is no public address to find and nothing to '
            + 'port-forward.</p>'
            + '<p>The <b>Remote Access</b> screen has two buttons for it: <b>Join the tailnet</b>, '
            + 'then <b>Move the panel onto the tunnel</b>. Joining shows a <b>sign-in link</b> — '
            + 'open it in any browser, log in to Tailscale, and press Refresh.</p>'
            + '<p>The same thing from a terminal, which is what you want in lean mode:</p>'
            + '<pre>sudo outlaw remote up\nsudo outlaw remote bind tunnel</pre>'
            + '<p>Install Tailscale on your laptop or phone, sign in to the same account, and the '
            + 'panel is reachable from there and nowhere else. The <b>Remote Access</b> screen '
            + 'shows exactly where things stand.</p>',
    },
    {
        id: 'remote-bind', cat: 'Remote access', title: 'Pointing the panel at the tunnel',
        keywords: 'bind loopback tunnel address change where listening port 7717 restart',
        body: '<p><code>sudo outlaw remote bind &lt;where&gt;</code> takes:</p>'
            + '<ul><li><b>loopback</b> — this machine only (the default).</li>'
            + '<li><b>tunnel</b> — the tunnel address it finds, whichever interface that is.</li>'
            + '<li>an explicit <b>address</b> — accepted only if it really belongs to a '
            + 'WireGuard/Tailscale interface.</li></ul>'
            + '<p>The panel listens on port <b>7717</b>. After binding, reach it at '
            + '<code>http://&lt;tunnel-address&gt;:7717</code> — the Remote Access screen prints '
            + 'the exact URL.</p>',
    },
    {
        id: 'remote-serve', cat: 'Remote access', title: 'HTTPS and a real hostname',
        keywords: 'https tls certificate padlock serve hostname ts.net letsencrypt magicdns name',
        body: '<p>Want a padlock and a memorable name instead of an IP? Turn on '
            + '<b>Remote Access → Tailscale HTTPS proxy</b>, or from a terminal:</p>'
            + '<pre>sudo outlaw remote serve on</pre>'
            + '<p>If it refuses, it is almost always because HTTPS certificates aren’t enabled '
            + 'for your tailnet yet — turn them on in the Tailscale admin console under '
            + '<b>DNS → HTTPS Certificates</b>. The panel shows Tailscale’s own error either way.</p>'
            + '<p>This puts Tailscale’s own HTTPS proxy in front of the panel — a free '
            + 'Let’s Encrypt certificate for the machine’s <code>*.ts.net</code> name — while the '
            + 'daemon itself stays on loopback.</p>'
            + '<p>It changes nothing about who can reach it: still your tailnet, still nobody '
            + 'else. <code>sudo outlaw remote serve off</code> undoes it.</p>',
    },
    {
        id: 'wireguard', cat: 'Remote access', title: 'Self-hosted WireGuard instead',
        keywords: 'wireguard self hosted no third party private own vpn wg tunnel',
        body: '<p>Prefer to involve no third party at all? <b>wireguard-tools</b> is installed, and '
            + 'a self-hosted WireGuard address is accepted by <b>exactly the same rule</b> as a '
            + 'Tailscale one.</p>'
            + '<p>Set up your WireGuard interface however you normally would, then '
            + '<code>sudo outlaw remote bind tunnel</code> (or bind the address explicitly). The '
            + 'panel checks that the address really belongs to a tunnel interface before it '
            + 'listens.</p>'
            + '<p>You’re on your own for the WireGuard config itself — that’s a deliberate '
            + 'trade: total independence, more setup.</p>',
    },
    {
        id: 'remote-off', cat: 'Remote access', title: 'Turning remote access off',
        keywords: 'off down disable stop tailscaled leave tailnet idle cost overhead opt in',
        body: '<p>Remote access is <b>off until you ask for it</b>. <code>tailscaled</code> is not '
            + 'enabled at install time.</p>'
            + '<p>On <b>Remote Access → Turn it off</b>, or from a terminal:</p>'
            + '<ul><li><b>Leave the tailnet</b> (<code>sudo outlaw remote down</code>) — off the '
            + 'tailnet, but <code>tailscaled</code> keeps running.</li>'
            + '<li><b>Leave and stop tailscaled</b> (<code>sudo outlaw remote off</code>) — back to '
            + 'nothing running and nothing listening.</li></ul>'
            + '<p>Both cut off <i>your own</i> connection if you are reading this over the tunnel, '
            + 'so the panel asks you to confirm first.</p>'
            + '<p>Worth being straight about: a tunnel daemon is a real process with real (small) '
            + 'memory use and periodic keepalive traffic. That’s the honest price of being '
            + 'reachable, and it’s why it’s opt-in rather than on.</p>'
            + '<p>If you turned off remote access while bound to a tunnel address, remember to '
            + '<code>sudo outlaw remote bind loopback</code> too, or the panel will refuse to '
            + 'start next boot.</p>',
    },

    // ---- Server software ---------------------------------------------------
    {
        id: 'server-apps', cat: 'Server software', title: 'Docker, Portainer and Cockpit',
        keywords: 'docker portainer cockpit install remove stop containers admin console apps',
        body: '<p><b>Apps → Server software.</b> Nothing is installed until you ask — a fresh '
            + 'machine ships with none of it, so an idle server runs nothing it wasn’t told to.</p>'
            + '<ul><li><b>Docker</b> — containers. Pterodactyl and Portainer both sit on top of '
            + 'it.</li>'
            + '<li><b>Portainer</b> — point-and-click Docker management. Published to '
            + '<b>loopback only</b>: it can control every container on the box, so it does not go '
            + 'on a network interface. Reach it over your tunnel, like the panel.</li>'
            + '<li><b>Cockpit</b> — the classic Linux admin console. Installed '
            + '<b>socket-activated</b>, so it uses nothing at all until a browser connects.</li></ul>'
            + '<p>Each can be <b>stopped without uninstalling</b> (frees the memory, keeps the '
            + 'setup) or removed outright.</p>',
    },
    {
        id: 'apps-data-safe', cat: 'Server software', title: 'Removing software never deletes your data',
        keywords: 'remove uninstall data volumes keep safe delete docker var lib restore',
        body: '<p>Removing Docker, Portainer or Cockpit from the Apps screen removes the '
            + '<b>packages</b>. It leaves container volumes and <code>/var/lib/docker</code> '
            + 'exactly as they are.</p>'
            + '<p>So anything you were running can be brought straight back by reinstalling — your '
            + 'Minecraft world does not evaporate because you uninstalled Portainer.</p>'
            + '<p>If you genuinely want the data gone too, that’s a deliberate act you do yourself '
            + 'in the terminal. The panel will not do it for you by accident.</p>',
    },
    {
        id: 'pterodactyl', cat: 'Server software', title: 'Game servers (Pterodactyl)',
        keywords: 'pterodactyl game server minecraft rust valheim panel wings install fqdn install script',
        body: '<p><b>Pterodactyl</b> is the game-server manager: a web panel where you create '
            + 'Minecraft, Rust, Valheim and dozens of other servers, edit configs, watch consoles '
            + 'and give friends access — without touching a terminal.</p>'
            + '<pre>sudo outlaw-pterodactyl panel --fqdn your-box.ts.net --email you@example.com\nsudo outlaw-pterodactyl wings</pre>'
            + '<p><b>This one is not a single button, and the reason is worth being straight '
            + 'about.</b> It installs a database, a PHP runtime, a web server, a queue worker and a '
            + 'scheduled job, and it asks you questions partway through. That’s a ten-minute '
            + 'operation you should be able to watch — so it’s a script you run and read, not a '
            + 'spinner over a process you can’t see.</p>'
            + '<p><code>sudo outlaw-pterodactyl status</code> shows what’s done so far.</p>',
    },
    {
        id: 'ptero-rerun', cat: 'Server software', title: 'If the Pterodactyl install stops partway',
        keywords: 'pterodactyl failed error rerun resume restart halfway step broken retry',
        body: '<p>It <b>stops at the first thing that fails</b> and shows you the exact command and '
            + 'error rather than carrying on over a broken step.</p>'
            + '<p>It is also <b>re-runnable</b>: every step checks whether its work is already '
            + 'done, so a run that died halfway can be fixed and started again with the same '
            + 'command. You will not get a duplicate database or a second copy of the panel.</p>'
            + '<p>Read the error, fix that one thing (usually a missing package, no disk space, or '
            + 'a name that doesn’t resolve), and run it again.</p>',
    },
    {
        id: 'ptero-limits', cat: 'Server software', title: 'What the Pterodactyl installer won’t do',
        keywords: 'pterodactyl firewall port tls certificate ssl https not automatic decision',
        body: '<p>Two things it deliberately does <b>not</b> do:</p>'
            + '<ul><li><b>It never opens a firewall port.</b> That stays your decision, on the '
            + '<b>Firewall</b> screen. An installer that quietly exposes ports is an installer you '
            + 'can’t trust.</li>'
            + '<li><b>It doesn’t obtain a TLS certificate.</b> Inside a tailnet the tunnel already '
            + 'encrypts everything; on a public domain that’s a decision with real consequences '
            + 'and should be made on purpose.</li></ul>'
            + '<p>Once the panel is up, open the ports your game servers actually need — and only '
            + 'those.</p>',
    },

    // ---- System tools ------------------------------------------------------
    {
        id: 'services', cat: 'System tools', title: 'Services',
        keywords: 'services systemd start stop restart enable disable unit daemon boot running',
        body: '<p>The <b>Services</b> screen lists systemd units with their state, and lets you '
            + '<b>start</b>, <b>stop</b>, <b>restart</b>, <b>enable</b> (start at boot) and '
            + '<b>disable</b> them.</p>'
            + '<p><b>Enabled</b> and <b>running</b> are different things, and the screen shows both: '
            + 'a unit can be running now but not come back after a reboot, which is a classic way '
            + 'to lose a game server at 3am.</p>'
            + '<p>Same jobs from the command line: <code>outlaw services</code>, '
            + '<code>outlaw start|stop|restart|enable|disable &lt;unit&gt;</code>.</p>',
    },
    {
        id: 'logs', cat: 'System tools', title: 'System Log',
        keywords: 'log journal journalctl errors warnings unit filter search recent lines',
        body: '<p>The <b>System Log</b> screen shows recent journal lines — the system’s own record '
            + 'of what happened. Filter by <b>unit</b> to see one service’s story, or search the '
            + 'text.</p>'
            + '<p>This is the first place to look when something didn’t start: the reason is '
            + 'almost always written here in plain language.</p>'
            + '<p>From the command line: <code>outlaw logs [unit] [n]</code> (200 lines by '
            + 'default).</p>',
    },
    {
        id: 'firewall', cat: 'System tools', title: 'Firewall',
        keywords: 'firewall ufw port open close allow deny rules block game server 25565',
        body: '<p>The <b>Firewall</b> screen turns the firewall on or off, lists the rules, and '
            + 'opens or closes single ports.</p>'
            + '<p>Open a port by number and protocol — e.g. <b>25565 / tcp</b> for Minecraft. '
            + 'Delete a rule by its number.</p>'
            + '<p><b>Only your game servers need open ports.</b> The control panel does not: it '
            + 'rides the tunnel, so it is reachable without any rule at all. If you find yourself '
            + 'about to open 7717 to the internet, stop — that’s the one thing this OS is built to '
            + 'prevent.</p>'
            + '<p>Ranges and lists aren’t accepted here on purpose (a typo’d range silently opens '
            + 'the wrong thing). Use the terminal for those.</p>',
    },
    {
        id: 'ssh-keys', cat: 'System tools', title: 'SSH keys',
        keywords: 'ssh key authorized_keys public private ed25519 rsa login password paste pub',
        body: '<p><b>Settings → SSH keys.</b> A key listed here <b>is a login</b> — anyone holding '
            + 'the matching private key gets in, with no password.</p>'
            + '<p>Paste the contents of your <code>.pub</code> file (usually '
            + '<code>~/.ssh/id_ed25519.pub</code>). <b>Never paste a private key</b> — that’s the '
            + 'half that stays on your own machine, and pasting it here would be handing it '
            + 'away.</p>'
            + '<p>Keys with SSH <i>options</i> attached (<code>command=</code>, '
            + '<code>environment=</code>, <code>permitopen=</code>) are refused. Those run code on '
            + 'every login, and pasting one you didn’t write is a well-known way to be handed a '
            + 'backdoor. Add those by hand if you truly mean to.</p>',
    },
    {
        id: 'keyboard', cat: 'System tools', title: 'Keyboard layout',
        keywords: 'keyboard layout keymap console vconsole localectl symbols password at sign uk us qwerty azerty',
        body: '<p><b>Settings → Keyboard layout</b> sets which physical keyboard is plugged into '
            + '<b>this machine</b>. It covers the <b>text console</b> — where you type the root '
            + 'password when there is no graphical panel, including in lean mode — as well as the '
            + 'panel itself.</p>'
            + '<p>It does <b>not</b> change the keyboard on a laptop you connect from. That stays '
            + 'whatever your own computer uses.</p>'
            + '<p>Getting it wrong is quietly painful, because the symbols move. A UK keyboard set '
            + 'to US swaps <code>@</code> and <code>"</code> — which you discover while typing a '
            + 'password you can’t see. <b>Use the test box before you rely on it.</b></p>'
            + '<p>The setting is saved immediately, but the graphical panel only picks it up after '
            + 'a log out or reboot; the panel tells you which happened.</p>'
            + '<p>From a terminal: <code>outlaw keyboard</code>, <code>outlaw keyboard list</code>, '
            + '<code>sudo outlaw keyboard set gb</code>.</p>',
    },
    {
        id: 'tasks', cat: 'System tools', title: 'Task Manager',
        keywords: 'task manager processes cpu ram memory usage kill top load monitor',
        body: '<p>Live <b>CPU</b>, <b>memory</b> and <b>GPU</b> usage, with the processes using '
            + 'them. Sort to find whatever is eating the box, and end a process that’s stuck.</p>'
            + '<p>It only polls <b>while you’re looking at it</b> — leave the screen and the '
            + 'polling stops. That’s the rule everywhere in this OS: no background work when '
            + 'nothing is being asked of it.</p>'
            + '<p>From the command line: <code>outlaw stats</code>.</p>',
    },
    {
        id: 'terminal', cat: 'System tools', title: 'The Secure Terminal',
        keywords: 'terminal shell command line guarded dangerous confirm sudo bash prompt',
        body: '<p>A real shell, with a guard: commands that could destroy the machine ask for '
            + 'confirmation first, spelling out what’s about to happen.</p>'
            + '<p>It’s not a sandbox and doesn’t pretend to be — it’s a seatbelt against the '
            + 'classic 2am <code>rm -rf</code> with a space in the wrong place.</p>'
            + '<p>Everything the panel’s buttons do, you can also do here. Nothing is hidden from '
            + 'you.</p>',
    },
    {
        id: 'files', cat: 'System tools', title: 'Files',
        keywords: 'files browse filesystem folder directory manager navigate open',
        body: '<p>Browse the filesystem, open folders and see what’s where — useful for finding a '
            + 'config file or checking that a world save is where you think it is.</p>'
            + '<p>For heavy work (moving lots of data, editing configs) the <b>Terminal</b> is '
            + 'faster and honest about what it’s doing.</p>',
    },
    {
        id: 'storage', cat: 'System tools', title: 'Storage & disks',
        keywords: 'storage disk space full free usage filesystem mount df capacity',
        body: '<p>The <b>Dashboard</b> has a <b>Storage</b> card showing each filesystem and how '
            + 'full it is. The panel also warns you at startup if the disk is nearly full.</p>'
            + '<p>Take that warning seriously on a server: a full disk is how installs, updates '
            + 'and databases fail in confusing ways, and game servers write more than people '
            + 'expect (world saves, backups, container images, logs).</p>'
            + '<p><b>Settings → Free up space</b> clears package caches and old logs. From the '
            + 'command line: <code>outlaw disk</code>.</p>',
    },
    {
        id: 'outlaw-cli', cat: 'System tools', title: 'The `outlaw` command',
        keywords: 'cli command line outlaw terminal ssh headless lean tool help usage',
        body: '<p>Everything the panel does is also a command, which is what makes <b>Lean mode</b> '
            + 'and plain SSH viable. <code>outlaw help</code> lists them all.</p>'
            + '<ul><li><code>outlaw status</code> / <code>stats</code> / <code>disk</code> — what '
            + 'this machine is and what it’s doing.</li>'
            + '<li><code>outlaw services</code>, <code>start|stop|restart|enable|disable '
            + '&lt;unit&gt;</code>.</li>'
            + '<li><code>outlaw logs [unit] [n]</code>.</li>'
            + '<li><code>outlaw mode panel|lean</code>.</li>'
            + '<li><code>outlaw passwd</code>, <code>outlaw 2fa</code>, <code>outlaw audit</code>.</li>'
            + '<li><code>outlaw remote …</code> — see <i>Remote access</i>.</li></ul>'
            + '<p>Anything that changes the system needs <code>sudo</code>.</p>',
    },
    {
        id: 'audit', cat: 'System tools', title: 'The audit log',
        keywords: 'audit log sign in attempts security who record history privileged action',
        body: '<p><code>outlaw audit [n]</code> shows recent sign-ins and privileged actions: who, '
            + 'what, when, and from which address — including the <b>failed</b> attempts.</p>'
            + '<p>On a machine reachable from anywhere, this is the record that tells you whether '
            + 'anyone has been trying the door. Check it after anything surprising.</p>',
    },

    // ---- Settings & updates ------------------------------------------------
    {
        id: 'updates', cat: 'Settings & updates', title: 'Updating Outlaw Server',
        keywords: 'update upgrade version release channel stable beta packages pacman shell',
        body: '<p>Two separate things, both in <b>Settings</b>:</p>'
            + '<ul><li><b>Outlaw Shell Updates</b> — new versions of this control panel and the OS '
            + 'tooling, from GitHub releases. Pick <b>stable</b> or <b>beta</b>.</li>'
            + '<li><b>System Package Updates</b> — everything else on the machine, through the '
            + 'system package manager.</li></ul>'
            + '<p>While this OS is pre-1.0 there is no real difference between the channels: every '
            + 'build is a prerelease, so stable falls back to the newest one. That changes at '
            + '1.0.</p>'
            + '<p>Update at a time you can watch it. Servers are exactly the machines where an '
            + 'unattended update at the wrong moment hurts.</p>',
    },
    {
        id: 'security-settings', cat: 'Settings & updates', title: 'PIN, lock & auto-lock',
        keywords: 'pin lock unlock idle auto lock security screen console physical access',
        body: '<p><b>Settings → Security &amp; sign-in</b> covers the panel <b>on this machine</b> — '
            + 'the console someone could walk up to.</p>'
            + '<ul><li><b>Ask to sign in on startup</b> — lock the panel until a PIN or password is '
            + 'entered.</li>'
            + '<li><b>Auto-lock when idle</b> — lock automatically after 5–30 minutes of nothing '
            + 'happening. Needs a PIN.</li>'
            + '<li><b>Unlock PIN</b> — a 4-digit PIN for quick unlocking at the keyboard.</li></ul>'
            + '<p>This is separate from the browser sign-in (password + 2FA), which is what guards '
            + 'remote access. A PIN is for the person standing in the room; it is not a substitute '
            + 'for the password.</p>',
    },
    {
        id: 'ai', cat: 'Settings & updates', title: 'The AI helper (off by default)',
        keywords: 'ai assistant model local ollama offline help explain errors optional off private',
        body: '<p>An optional, small, <b>local</b> AI that answers setup questions and explains '
            + 'errors. No cloud, no account, nothing leaves the machine.</p>'
            + '<p>It is <b>off by default and stays off until you turn it on</b>, because a server’s '
            + 'memory belongs to what it’s serving. When enabled it loads only while it’s '
            + 'answering and unloads itself afterward — <b>zero idle cost</b>.</p>'
            + '<p><b>AI Helper → Check my PC</b> reads your RAM, GPU and CPU and recommends a model '
            + 'this box can actually run. On a small server, the honest answer is sometimes '
            + '“don’t” — and it will say so.</p>',
    },
    {
        id: 'report-problem', cat: 'Settings & updates', title: 'Report a problem',
        keywords: 'report bug error log crash github issue send collect copy clear problem',
        body: '<p><b>Settings → Report a problem.</b> Click <b>Collect errors</b> and it gathers '
            + 'errors and warnings from the panel, Xorg and the system journal — deduplicated, so '
            + 'one repeating fault doesn’t bury everything else.</p>'
            + '<p><b>Copy</b> it, click <b>Open GitHub issues</b>, and paste it into a new issue. '
            + 'Then <b>Clear</b> it, so already-reported errors don’t pile up with new ones.</p>'
            + '<p>Read what you’re about to post. It’s a log from your machine — hostnames and '
            + 'paths are in there.</p>',
    },
    {
        id: 'reviewer', cat: 'Settings & updates', title: 'Help test this version',
        keywords: 'test reviewer alpha feedback checklist try report help version quality',
        body: '<p>This OS is <b>alpha</b>, and honest testing is the most useful thing you can '
            + 'contribute. <b>Settings → Help Test This Version</b> walks through what’s new and '
            + 'what’s most likely to be broken.</p>'
            + '<p>The things worth testing hardest are the ones that can lock you out: '
            + '<b>remote access</b>, the <b>firewall</b>, and <b>sign-in</b>. Test those while you '
            + 'still have a keyboard attached to the machine.</p>',
    },
    {
        id: 'recovery', cat: 'Settings & updates', title: 'Boot & recovery',
        keywords: 'boot recovery hotswap installer reinstall dual another os wipe partition',
        body: '<p><b>Settings → Boot &amp; Recovery</b>:</p>'
            + '<ul><li><b>Hotswap to another OS</b> — sets the next boot to another installed OS '
            + '(or opens the boot menu).</li>'
            + '<li><b>Open Installer</b> — sets up or removes Outlaw Server.</li></ul>'
            + '<p>Your other OS and data stay untouched unless you explicitly choose to wipe.</p>',
    },

    // ---- Troubleshooting ---------------------------------------------------
    {
        id: 'trouble-refuse-bind', cat: 'Troubleshooting', title: '“REFUSING to listen” at startup',
        keywords: 'refusing listen exit daemon wont start bind error address tunnel down loopback',
        body: '<p>The panel refused to open a socket on the address it was told to use, and '
            + 'exited. That is the bind rule working, not a bug — see <i>Why the panel refuses '
            + 'most addresses</i>.</p>'
            + '<p>Almost always one of two things:</p>'
            + '<ul><li><b>The tunnel is down.</b> The address was a valid tunnel address last '
            + 'boot, but Tailscale/WireGuard isn’t up yet, so it no longer belongs to any '
            + 'interface. Bring it up: <code>sudo outlaw remote up</code>.</li>'
            + '<li><b>It was pointed at a LAN or public address.</b> Refused permanently — your '
            + 'password would cross the wire in the clear.</li></ul>'
            + '<p>To get back in right now: <code>sudo outlaw remote bind loopback</code>, then '
            + 'reach it at the machine itself.</p>',
    },
    {
        id: 'trouble-no-panel', cat: 'Troubleshooting', title: 'Can’t reach the panel remotely',
        keywords: 'cant reach connect remote browser timeout refused tailscale not working url',
        body: '<p>Work down this list — it’s in the order things actually go wrong:</p>'
            + '<ol><li><b>Is the machine on the tailnet?</b> <code>outlaw remote</code> at the box '
            + '(or over SSH) says so plainly.</li>'
            + '<li><b>Is the panel bound to the tunnel?</b> If it still says loopback, run '
            + '<code>sudo outlaw remote bind tunnel</code>.</li>'
            + '<li><b>Is your laptop on the same tailnet?</b> Same account, Tailscale running, '
            + 'connected.</li>'
            + '<li><b>Right URL?</b> Port <b>7717</b>, and <code>http://</code> unless you turned on '
            + '<code>remote serve</code>.</li>'
            + '<li><b>Is the mode right?</b> <code>outlaw mode</code> — in <b>lean</b> mode nothing '
            + 'is listening, by design.</li></ol>'
            + '<p>Do <b>not</b> "fix" this by opening port 7717 in the firewall. That defeats the '
            + 'entire design and puts a plain-HTTP login on the internet.</p>',
    },
    {
        id: 'trouble-locked-out', cat: 'Troubleshooting', title: 'Locked out of the panel',
        keywords: 'locked out lockout 15 minutes password forgot 2fa code wrong reset attempts',
        body: '<p><b>Five bad attempts locks that address out for 15 minutes.</b> Waiting is the '
            + 'intended fix — that delay is what makes guessing a password impractical.</p>'
            + '<p>If you’ve lost the password or the 2FA secret, you need access to the machine '
            + 'itself (physically or over SSH):</p>'
            + '<pre>sudo outlaw passwd\nsudo outlaw 2fa &lt;user&gt; &lt;code&gt;</pre>'
            + '<p>That sets a new password and prints a fresh 2FA secret to enrol.</p>'
            + '<p>If your codes are rejected but the password is right, check the machine’s '
            + '<b>clock</b> — <b>Settings → Time &amp; Clock</b>. Time-based codes fail when the '
            + 'clock has drifted.</p>'
            + '<p>This is exactly why <b>SSH keys</b> are worth adding on day one: they’re a way '
            + 'back in that doesn’t depend on the panel.</p>',
    },
    {
        id: 'trouble-service', cat: 'Troubleshooting', title: 'A service won’t start',
        keywords: 'service failed start wont run unit systemd error crash boot enable journal',
        body: '<p>Open <b>System Log</b> and filter to that unit. The reason is nearly always '
            + 'written there in plain language — a missing file, a port already in use, a '
            + 'permission problem, or no disk space.</p>'
            + '<p>Two things people miss:</p>'
            + '<ul><li>A service that runs now but isn’t <b>enabled</b> will not come back after a '
            + 'reboot.</li>'
            + '<li>A full disk breaks services in ways that look like anything but a full disk. '
            + 'Check the Dashboard’s Storage card first.</li></ul>',
    },
    {
        id: 'trouble-game-server', cat: 'Troubleshooting', title: 'Friends can’t connect to my game server',
        keywords: 'game server connect friends port firewall minecraft cant join timeout public',
        body: '<p>Game servers <b>do</b> need open ports — unlike the control panel. Check, in '
            + 'order:</p>'
            + '<ol><li><b>Is the server running?</b> Services screen, or the Pterodactyl panel.</li>'
            + '<li><b>Is the port open here?</b> <b>Firewall</b> screen — e.g. 25565/tcp for '
            + 'Minecraft.</li>'
            + '<li><b>Is it forwarded to this machine?</b> On your router, if you’re behind '
            + 'one.</li>'
            + '<li><b>Are they using the right address?</b> Your public address, not the tunnel '
            + 'address — tailnet addresses only work for devices on your tailnet.</li></ol>'
            + '<p>Open only the ports the game needs. Every extra open port is a door you now own '
            + 'the consequences of.</p>',
    },
    {
        id: 'trouble-boot', cat: 'Troubleshooting', title: 'It won’t boot / black screen',
        keywords: 'boot black screen wont start blank stuck graphics safe kms usb bios uefi',
        body: '<p>At the boot menu, pick the <b>safe graphics</b> entry — most black screens are a '
            + 'graphics driver that doesn’t like this hardware.</p>'
            + '<p>If it boots but the panel never appears, you still have a working machine: switch '
            + 'to a text console with <b>Ctrl + Alt + F2</b>, log in, and use the '
            + '<code>outlaw</code> command. A server that boots to a shell is fine — the panel is '
            + 'optional.</p>'
            + '<p>Then check <code>outlaw logs</code> for what failed, and see '
            + '<i>“REFUSING to listen” at startup</i> if the panel exited on purpose.</p>',
    },
    {
        id: 'trouble-net', cat: 'Troubleshooting', title: 'No internet',
        keywords: 'network internet wifi ethernet connection dns offline cant download nmcli',
        body: '<p><b>Settings → Network &amp; Wi-Fi</b> to connect. On a server, prefer a '
            + '<b>wired</b> connection where you can: it survives reboots without a password and '
            + 'doesn’t drop when the access point reboots.</p>'
            + '<p>If the network is up but downloads fail, it’s usually DNS or the clock. Check '
            + '<b>Settings → Time &amp; Clock</b> — a badly wrong clock breaks HTTPS to everything, '
            + 'which looks exactly like "the internet is broken".</p>',
    },
    {
        id: 'trouble-install', cat: 'Troubleshooting', title: 'Install problems',
        keywords: 'install installer partition disk usb wipe keep other os space failed setup',
        body: '<p>The installer can set up Outlaw Server alongside another OS or take the whole '
            + 'disk. Keeping another OS needs enough <b>free space</b> for it to work with.</p>'
            + '<p>If an install fails partway, don’t reboot into a half-written disk and guess — '
            + 'collect the log (<b>Report a problem</b>) and post it. Installer bugs are the ones '
            + 'most worth reporting, because they’re the hardest to recover from.</p>'
            + '<p>Back up anything you care about before repartitioning. This is alpha software '
            + 'touching partition tables.</p>',
    },
];
