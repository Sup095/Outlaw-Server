# ⛨ Outlaw Server

**A stripped-down, security-first Linux server OS you manage from a web browser.**
Built on the same hardened foundation as [Outlaw OS](https://github.com/Sup095/Outlaw-Game-OS),
with everything a desktop needs and a server doesn't ripped out — and everything a
server admin needs added in.

> **Status: pre-alpha (Phase 0).** Forked from Outlaw OS v2.0.180. Nothing here is
> ready to run yet — the roadmap below is being built top to bottom.

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
| 🚧 | **1 · Headless daemon** | `outlaw-serverd`: the control panel served over HTTP/WebSocket; Electron removed; **the UI itself becomes optional** (see below). |
| 🔭 | **2 · Sign-in that means it** | Password + TOTP 2FA, session tokens, TLS, rate-limiting, audit log of every remote action. |
| 🔭 | **3 · Remote access** | Tailscale/WireGuard integration — manage every box from anywhere, with nothing on the public internet. |
| 🔭 | **4 · Server toolset** | Services manager, firewall, journal/log viewer, SSH keys, storage, live resource dashboard. |
| 🔭 | **5 · Game servers** | One-click Pterodactyl (+ Docker), optional Portainer & Cockpit — all removable. |
| 🔭 | **6 · Polish & first install** | Accessibility pass, docs, and the first real-hardware test. |

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
