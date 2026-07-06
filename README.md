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
| 🚧 | **0 · Fork & strip** | The desktop OS cut down to a bootable, bare-bones server shell. |
| 🔭 | **1 · Headless daemon** | `outlaw-serverd`: the control panel served over HTTPS/WebSocket; Electron removed; local display = optional kiosk browser. |
| 🔭 | **2 · Sign-in that means it** | Password + TOTP 2FA, session tokens, TLS, rate-limiting, audit log of every remote action. |
| 🔭 | **3 · Remote access** | Tailscale/WireGuard integration — manage every box from anywhere, with nothing on the public internet. |
| 🔭 | **4 · Server toolset** | Services manager, firewall, journal/log viewer, SSH keys, storage, live resource dashboard. |
| 🔭 | **5 · Game servers** | One-click Pterodactyl (+ Docker), optional Portainer & Cockpit — all removable. |
| 🔭 | **6 · Polish & first install** | Accessibility pass, docs, and the first real-hardware test. |

## License

Source-available under the [Outlaw Server License v1.0](LICENSE) — use it, study it,
host anything you like on it (including paid services), send improvements back; don't
redistribute or sell the OS itself. Third-party components keep their own licenses.
