# ⛨ Outlaw Server

**A stripped-down, security-first Linux server OS you manage from a web browser.**
Built on the same hardened foundation as [Outlaw OS](https://github.com/Sup095/Outlaw-Game-OS),
with everything a desktop needs and a server doesn't ripped out — and everything a
server admin needs added in.

> **Status: alpha (Phase 6 of 6).** Forked from Outlaw OS v2.0.180. The control
> daemon, sign-in, remote access, the server toolset and one-click game servers
> are all in. What's left is polish and the thing that matters most:
> **none of it has run on real hardware yet.**

---

## What it is

- **One box, one job** — a minimal Arch-based OS whose entire purpose is to run your
  servers (game servers first) and make managing them painless.
- **The UI is a web app** — the same simple, keyboard-friendly control panel whether
  you're sitting at the machine or on your laptop across the internet. Click through
  to update the system, watch resources, manage services, view logs, or run commands.
- **Remote by default, private by default** — remote access rides a free
  [Tailscale](https://tailscale.com) (or self-hosted WireGuard) private network, so
  your control panel is never exposed to the open internet. Signing in requires a
  password **and** a 2FA code from a free authenticator app
  ([Aegis](https://getaegis.app) recommended; Google Authenticator or
  [Ente Auth](https://ente.io/auth) work too).
- **Game servers in one click** — a guided installer for
  [Pterodactyl](https://pterodactyl.io) (the game-server management panel), plus
  optional [Portainer](https://www.portainer.io) (Docker management) and
  [Cockpit](https://cockpit-project.org) (classic Linux admin). Every one of them is
  removable/disable-able to keep resources free.
- **A tiny AI helper, off by default** — answers setup questions and explains errors
  using a small local model that loads only while it's answering and unloads itself
  afterward. Zero idle cost; no cloud, no accounts.
- **Free, forever** — every component in this OS (and every service it sets up) has a
  genuinely free tier or is fully open source. Running Outlaw Server never requires
  spending money.

## What got stripped from the desktop OS

Steam/gaming, game-dev tools, the AI game-maker (CodeMaker), the sci-fi System Core,
sound/volume, Bluetooth, night light, battery, screenshots/screen recording,
display/brightness controls, sleep/suspend — none of it belongs on a server.
The lightweight themes stay (they're free), and the boring-but-critical parts stay:
the hardened update system, the combined error log, health diagnostics, and the
guarded terminal.

## Roadmap

| | Phase | What you get |
|:--:|:--|:--|
| ✅ | **0 · Fork & strip** | The desktop OS cut down to a bootable, bare-bones server OS. |
| ✅ | **1 · Headless daemon** | `outlaw-serverd`: the control panel served over HTTP; **the UI itself is now optional** (see below). |
| ✅ | **2 · Sign-in that means it** | Password (scrypt) + TOTP 2FA, revocable server-side sessions, per-IP lockout, audit log. |
| ✅ | **3 · Remote access** | Tailscale/WireGuard — manage every box from anywhere, with nothing on the public internet. |
| ✅ | **4 · Server toolset** | Services, journal viewer, firewall, SSH keys and storage — all reachable from either frontend. |
| ✅ | **5 · Game servers** | One-click Docker, Portainer and Cockpit, plus a guided Pterodactyl install. All removable. |
| 🚧 | **6 · Polish & first install** | Accessibility pass, docs, and the first real-hardware test. |

### Signing in

The first time you open the panel (or run `sudo outlaw passwd`) you create the
administrator. That prints a **two-factor secret** to add to a free authenticator
app — [Aegis](https://getaegis.app) (open source) is the recommendation; Google
Authenticator and [Ente Auth](https://ente.io/auth) work too.

**2FA is not enforced until you confirm it works** (`sudo outlaw 2fa <user> <code>`),
so a mistyped secret can't lock you out of your own server. After that, sign-in needs
the password *and* a live code. Five bad attempts locks that address out for 15
minutes, and every sign-in and privileged action is written to an audit log
(`outlaw audit`).

### Reaching it from anywhere

The panel speaks plain HTTP, so it is only ever allowed to listen in two places:
**loopback**, or **an address that belongs to a WireGuard/Tailscale interface** —
where everything is already encrypted end to end before it touches a wire. A LAN
address, a public address or a wildcard bind is **refused, and the daemon exits**.
That is stronger than a firewall rule: the socket is never created on those
interfaces at all, so there is no rule to get wrong or forget after a reboot.

The **Remote Access** screen drives all of it: join the tailnet, move the panel
onto it, turn on HTTPS, or leave again. Anything that would cut off the person
clicking it says so and asks first. The same steps from a terminal — which is what
you want in lean mode, or over SSH:

```
sudo outlaw remote up        # join your Tailscale network — prints a sign-in link
sudo outlaw remote bind tunnel
```

That's it. The panel is now reachable from any device on your tailnet and from
nowhere else. `outlaw remote` shows exactly where things stand and where the panel
can be reached.

Want a padlock and a real hostname instead of an IP? `sudo outlaw remote serve on`
puts Tailscale's own HTTPS proxy in front (a free Let's Encrypt certificate for the
machine's `*.ts.net` name) while the daemon stays on loopback.

Prefer to involve no third party at all? `wireguard-tools` is installed and a
self-hosted WireGuard address is accepted by exactly the same rule.

**Remote access is off until you ask for it.** `tailscaled` is not enabled at
install time, and `outlaw remote off` puts the machine back to nothing running and
nothing listening. It is worth being straight about this one: a tunnel daemon is a
real process with real (small) memory use and periodic keepalive traffic — that is
the honest price of being reachable, and it is why it is opt-in rather than on.

### The keyboard you type the password with

**Settings → Keyboard layout** sets the layout for the **text console** — where
you type the root password when there's no graphical panel, including in lean
mode — as well as for the panel itself. It uses `localectl`, so it persists
across reboots and covers both surfaces; the X-session-only approach a desktop
uses would reset at every login and do nothing for the console at all.

Symbols move between layouts (`@` and `"` swap between UK and US), and you
normally discover this while typing a password you can't see — so there's a test
box next to the picker. Nothing you type in it is saved or sent anywhere.
From a terminal: `outlaw keyboard list`, `sudo outlaw keyboard set gb`.

### Server software

Nothing is installed until you ask. A fresh machine ships with none of it, so an
idle server runs nothing it wasn't told to.

- **Docker** — containers. Pterodactyl and Portainer both sit on top of it.
- **Portainer** — point-and-click Docker management. Published to **loopback only**:
  it can control every container on the box, so it does not go on a network
  interface — reach it over your tunnel, like the panel.
- **Cockpit** — the classic Linux admin console. Installed **socket-activated**, so
  it uses nothing at all until a browser actually connects.

Each can be **stopped without uninstalling** (frees the memory, keeps the setup) or
removed outright. **Removing never deletes your data** — container volumes and
`/var/lib/docker` are left exactly as they are, so anything you were running can be
brought straight back.

### Game servers (Pterodactyl)

[Pterodactyl](https://pterodactyl.io) is the game-server manager: a web panel where
you create Minecraft, Rust, Valheim and dozens of other servers, edit configs, watch
consoles and give friends access — without touching a terminal.

```
sudo outlaw-pterodactyl panel --fqdn your-box.ts.net --email you@example.com
sudo outlaw-pterodactyl wings
```

**This one is not a single button, and the reason is worth being straight about.**
It installs a database, a PHP runtime, a web server, a queue worker and a scheduled
job, and it asks you questions partway through. That is a ten-minute operation you
should be able to watch — so it's a script you run and read, not a spinner over a
process you can't see. It **stops at the first thing that fails**, showing the exact
command and error, and it is **re-runnable**: every step checks whether its work is
already done, so a run that dies halfway can be fixed and started again.

Two things it deliberately does **not** do: it never opens a firewall port (that
stays your decision, on the Firewall screen), and it doesn't obtain a TLS
certificate — inside a tailnet the tunnel already encrypts everything, and on a
public domain that's a decision of its own.

### Your server, your overhead

From Phase 1 on, **the control panel is optional**. Every install picks a mode, and can
switch later:

- **Panel mode** — the full browser UI: click through updates, services, logs, game
  servers. Easiest to run and configure. Costs a little RAM for the daemon.
- **Lean mode** — no UI at all. SSH + the `outlaw` command-line tool. Nothing is
  listening for a browser, nothing renders, nothing polls.

Either way the OS itself stays out of your way: **no background work when nothing is
being asked of it.** No idle timers, no telemetry, no polling loops — the resources
belong to what you're actually serving.

---

## 🧪 Experimental — after the roadmap

Ideas we intend to build once the core OS is solid. **Nothing here is started**, and
anything in this section may change shape or be dropped. Listed so the direction is
public, not as a promise.

### X1 · Watchdog & Guard Dog — two AIs that watch each other

A pair of small local AIs that watch the server for security threats. They are
deliberately **two** models, not one, because the whole design rests on them
**checking each other's work**:

- **🐕‍🦺 Watchdog — the one that notices.** Watches logs, auth attempts, processes,
  network activity and file changes, and identifies anything that looks like a threat.
  On a big enough model it also *suggests* what to do about it.
- **🦮 Guard Dog — the one that acts.** Independently verifies that what Watchdog
  flagged is a *real* threat (not a hallucination), builds **its own** list of possible
  responses, compares that against Watchdog's suggestions, and puts the best options
  forward.

**The admin stays in charge.** Anything above a low-level threat is never acted on
silently — you get a message describing what was found and a short list of concrete
options to choose from. That is the point: two independent models must agree, and then
a *human* decides. A single confused model can't take your server down.

You can opt specific, easily-scoped responses into running **automatically** (say,
blocking an IP after a brute-force burst) — with heavy warnings at the point you enable
them, because automatic action is inherently risky.

**Why two models, specifically:**
- **Fewer hallucinations** — one model's claim has to survive the other's review before
  it reaches you.
- **Harder to turn against you** — each model inspects what the *other* is trying to
  output, so a prompt-injection or poisoned log line that hijacks one has to get past
  the other to reach the server. (This mutual check needs models with enough capacity
  to reason about it — see below.)
- **Blast radius** — both run **inside Docker containers**, so even a fully compromised
  AI is boxed away from the host.

**Sized to your hardware.** There'll be preset model choices tuned for whatever GPU (or
CPU) the box has. Bigger models unlock more: richer response options, finer-grained
controls, and the cross-checking behaviour above. On the smallest models some of that
isn't realistic — so the presets say plainly what each tier can and can't do, rather
than pretending capability it doesn't have.

## License

Source-available under the [Outlaw Server License v1.0](LICENSE) — use it, study it,
host anything you like on it (including paid services), send improvements back; don't
redistribute or sell the OS itself. Third-party components keep their own licenses.
