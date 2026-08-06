#!/bin/sh
# ============================================================================
# Outlaw Server — local console session launcher (installed system).
# ----------------------------------------------------------------------------
# This only runs when someone is physically at the machine with a monitor
# attached. Headless servers never get here — they're managed from a browser or
# over SSH, and X is never started.
#
# Boot flow:
#   FIRST boot (no ~/.outlaw-firstboot-done marker yet): run setup, then show
#     the panel. The wizard writes the marker when you finish or skip.
#   LATER boots: straight to the panel. There is no session chooser — a server
#     must not stop at a menu and wait for a human on every boot.
#
#   Sessions:
#     panel  → electron-wrapped /usr/share/outlaw-os (the control panel)
#     tty    → exit X, dropping back to the login console (headless boxes)
#
# All stderr goes to ~/.outlaw-x.log so silent Electron failures are
# diagnosable. Fail-safe: anything missing/unreadable falls back to the panel.
# ============================================================================

XLOG="$HOME/.outlaw-x.log"
exec 2>>"$XLOG"
printf '\n=== outlaw .xinitrc start: %s ===\n' "$(date -Iseconds)" >&2

# Detect whether we're in a VM. Used for two things below: forcing software
# GL, and SKIPPING the compositor (picom).
OUTLAW_IN_VM=0
if command -v systemd-detect-virt >/dev/null 2>&1; then
    if [ "$(systemd-detect-virt 2>/dev/null)" != "none" ]; then
        OUTLAW_IN_VM=1
        export LIBGL_ALWAYS_SOFTWARE=1
        export GALLIUM_DRIVER=llvmpipe
        echo "[xinitrc] VM detected — forcing software GL, skipping picom." >&2
    fi
fi

# picom is purely cosmetic (shadows / vsync) and its glx backend needs real
# OpenGL. In a VM the software framebuffer has no usable GLX, and a
# half-working glx compositor REDIRECTS every window and then paints it BLACK
# — the Electron window appears but stays dark. So only run picom on real
# hardware, where KMS gives working GL. The desktop renders fine without it.
if [ "$OUTLAW_IN_VM" = "0" ]; then
    picom --config "$HOME/.config/picom/picom.conf" >/dev/null 2>&1 &
fi

# Polkit authentication agent. The Apps panel + updater use `pkexec pacman …`
# to install packages; pkexec needs a running authentication agent to prompt
# for the password. Outlaw runs without a WM, so nothing starts one by default
# — without this, installs FAIL on the installed system ("no authentication
# agent"). Start the first agent that's present; harmless (no-op) if none is.
for _agent in \
    /usr/lib/polkit-gnome/polkit-gnome-authentication-agent-1 \
    /usr/lib/polkit-kde-authentication-agent-1 \
    /usr/lib/xfce-polkit/xfce-polkit \
    /usr/bin/lxqt-policykit-agent; do
    if [ -x "$_agent" ]; then "$_agent" >/dev/null 2>&1 & break; fi
done

# Window manager + taskbar. Gives launched app windows real title bars
# (minimize / maximize / close) and a taskbar to reach minimized windows; the
# Outlaw shell stays the frameless full-screen backdrop. GUARDED: if openbox
# isn't installed or fails to start, the session continues exactly as before (a
# no-window-manager kiosk) — so this can NEVER block boot. OUTLAW_NO_WM=1
# forces the old no-WM behaviour.
if [ "${OUTLAW_NO_WM:-0}" != "1" ] && command -v openbox >/dev/null 2>&1; then
    echo "[xinitrc] starting window manager (openbox) + taskbar (tint2)." >&2
    openbox >/dev/null 2>&1 &
    sleep 0.4
    command -v tint2 >/dev/null 2>&1 && tint2 >/dev/null 2>&1 &
else
    echo "[xinitrc] no window manager (openbox missing or OUTLAW_NO_WM=1) — kiosk mode." >&2
fi

# Ensure the standard XDG home folders exist (~/Downloads, ~/Documents, …) so the
# Files app and cleanup tools have real directories. Idempotent + instant; guarded.
command -v xdg-user-dirs-update >/dev/null 2>&1 && xdg-user-dirs-update >/dev/null 2>&1 || true

# Notification daemon — displays desktop notifications (notify-send + the shell's
# AI `notify` action). Guarded + backgrounded so its absence/failure never blocks
# the session; runs regardless of the window manager.
command -v dunst >/dev/null 2>&1 && dunst >/dev/null 2>&1 &

# Electron flag set (adds --disable-gpu inside a VM).
ELECTRON_FLAGS="$(outlaw-electron-flags 2>/dev/null | tr '\n' ' ')"
[ -z "$ELECTRON_FLAGS" ] && ELECTRON_FLAGS="--no-sandbox"

# ---- Decide the session --------------------------------------------------
# There is no session chooser on a server. A machine whose job is to stay up
# does not stop at a menu on every boot and wait for someone to be standing in
# front of it — it goes straight to the control panel.
#
# The one escape hatch: put "tty" in ~/.outlaw-session and X exits to a plain
# console instead. That is the right choice for a headless box, and it is
# exactly what `outlaw mode lean` is for.
if [ ! -f "$HOME/.outlaw-firstboot-done" ]; then
    echo "[xinitrc] first boot — running setup." >&2
    if command -v outlaw-firstboot >/dev/null 2>&1; then
        outlaw-firstboot || echo "[xinitrc] first-boot setup exited non-zero (continuing)." >&2
    fi
    SESSION="panel"
else
    SESSION="$(head -n1 "$HOME/.outlaw-session" 2>/dev/null | tr -d '[:space:]')"
    [ -z "$SESSION" ] && SESSION="panel"
fi

# ---- Launch the session under the crash-guard watchdog -------------------
run_session() {
    case "$1" in
        tty)
            return 0
            ;;
        # Anything else means "show me the panel". Defaulting this way (rather
        # than falling through to a bare console) means a stale or hand-edited
        # session file can never leave someone staring at a black screen.
        panel|desktop|*)
            # shellcheck disable=SC2086  # intentional word-splitting of flags
            outlaw-session-watchdog desktop electron $ELECTRON_FLAGS /usr/share/outlaw-os
            ;;
    esac
}

run_session "$SESSION"
RC=$?
if [ "$RC" = 87 ]; then
    # Watchdog forced a fallback. Re-read the session file and try once more.
    SESSION="$(head -n1 "$HOME/.outlaw-session" 2>/dev/null | tr -d '[:space:]')"
    [ -z "$SESSION" ] && SESSION="desktop"
    run_session "$SESSION"
fi
