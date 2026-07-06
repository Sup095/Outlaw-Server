# Start the Outlaw OS graphical shell automatically on the first console.
# Booting to this console without launching X still works (Ctrl-Alt-F2 for a
# plain TTY), which keeps the system usable on very low-RAM machines.
#
# First-VT detection: prefer XDG_VTNR (set by pam_systemd), but fall back to
# the tty name — some minimal autologin setups don't populate XDG_VTNR, and
# without this fallback the user would land on a bare shell instead of the
# desktop.
#
# We call outlaw-start-session (NOT a blind `exec startx`) so that if the
# graphical session crash-loops, the wrapper drops us back to THIS interactive
# shell with a readable error instead of an invisible getty→startx→crash loop.
_outlaw_vt="${XDG_VTNR:-}"
if [ -z "$_outlaw_vt" ]; then
    _outlaw_vt="$(tty 2>/dev/null | sed -n 's@^/dev/tty@@p')"
fi
if [ -z "${DISPLAY:-}" ] && [ "$_outlaw_vt" = "1" ]; then
    if command -v outlaw-start-session >/dev/null 2>&1; then
        outlaw-start-session
    else
        exec startx   # fallback for older images without the wrapper
    fi
fi
unset _outlaw_vt
