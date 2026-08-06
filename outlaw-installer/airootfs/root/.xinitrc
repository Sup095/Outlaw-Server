#!/bin/sh
# ============================================================================
# Outlaw Server — live session launcher (USB-boot ISO).
# ----------------------------------------------------------------------------
# The live image autologins as root and goes STRAIGHT TO THE PANEL, because
# that is where the "Install Outlaw Server" welcome card lives and it is the
# most reliable path on a fresh VM.
#
# No first-boot wizard here: the live environment is ephemeral (tmpfs), so
# installing optional bundles into RAM would be wasteful. The wizard runs on
# the INSTALLED system's first boot instead.
#
# All stderr goes to /root/.outlaw-x.log so silent Electron failures (the
# black-screen-on-VBox symptom) are diagnosable from a TTY.
# ============================================================================

XLOG="/root/.outlaw-x.log"
exec 2>>"$XLOG"
printf '\n=== outlaw live .xinitrc start: %s ===\n' "$(date -Iseconds)" >&2

# Detect VM: force software GL, and skip the compositor (picom) below.
OUTLAW_IN_VM=0
if command -v systemd-detect-virt >/dev/null 2>&1; then
    if [ "$(systemd-detect-virt 2>/dev/null)" != "none" ]; then
        OUTLAW_IN_VM=1
        export LIBGL_ALWAYS_SOFTWARE=1
        export GALLIUM_DRIVER=llvmpipe
        echo "[xinitrc] VM detected — forcing software GL, skipping picom." >&2
    fi
fi

# picom's glx backend needs real OpenGL. In a VM (software framebuffer) a
# half-working glx compositor redirects windows and paints them BLACK — the
# Electron window appears but stays dark. Only composite on real hardware.
if [ "$OUTLAW_IN_VM" = "0" ]; then
    picom --config /root/.config/picom/picom.conf >/dev/null 2>&1 &
fi

# Polkit authentication agent (see skel/.xinitrc for the rationale). The live
# ISO runs as root, so pkexec doesn't actually need an agent here, and the live
# package set doesn't ship one — this loop is a harmless no-op on the ISO, but
# keeps the live and installed session launchers consistent.
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

ELECTRON_FLAGS="$(outlaw-electron-flags 2>/dev/null | tr '\n' ' ')"
[ -z "$ELECTRON_FLAGS" ] && ELECTRON_FLAGS="--no-sandbox"

# Default to Desktop. Honor a saved choice if the user switched sessions from
# the shell (the switcher writes /root/.outlaw-session, then relaunches X).
SESSION="$(head -n1 /root/.outlaw-session 2>/dev/null | tr -d '[:space:]')"
[ -z "$SESSION" ] && SESSION="desktop"

run_session() {
    case "$1" in
        tty)
            return 0
            ;;
        # Anything else shows the panel — a stale session file must never leave
        # the live ISO sitting at a black screen.
        panel|desktop|*)
            # shellcheck disable=SC2086  # intentional word-splitting of flags
            outlaw-session-watchdog desktop electron $ELECTRON_FLAGS /usr/share/outlaw-os
            ;;
    esac
}

run_session "$SESSION"
RC=$?
if [ "$RC" = 87 ]; then
    SESSION="$(head -n1 /root/.outlaw-session 2>/dev/null | tr -d '[:space:]')"
    [ -z "$SESSION" ] && SESSION="desktop"
    run_session "$SESSION"
fi
