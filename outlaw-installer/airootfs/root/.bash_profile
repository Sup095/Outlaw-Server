# Outlaw OS live environment: start the graphical shell on the first console.
# Uses outlaw-start-session so a failed X start drops to this root shell with a
# readable error instead of an invisible getty→startx crash loop.
#
# First-VT detection falls back to the tty name when XDG_VTNR is unset (some
# minimal autologin setups don't populate it).
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
