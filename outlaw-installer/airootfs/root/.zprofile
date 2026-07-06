# Live env root often uses zsh — start the shell from .zprofile too.
# Uses outlaw-start-session (crash-loop guard) instead of a blind exec startx,
# and a robust first-VT check (falls back to tty when XDG_VTNR is unset).
_outlaw_vt="${XDG_VTNR:-}"
if [ -z "$_outlaw_vt" ]; then
    _outlaw_vt="$(tty 2>/dev/null | sed -n 's@^/dev/tty@@p')"
fi
if [ -z "${DISPLAY:-}" ] && [ "$_outlaw_vt" = "1" ]; then
    if command -v outlaw-start-session >/dev/null 2>&1; then
        outlaw-start-session
    else
        exec startx
    fi
fi
unset _outlaw_vt
