#!/bin/bash
# ============================================================================
# Runs INSIDE the archlinux container during the GitHub "build" job (via
# `docker run`). Installs the build deps (retrying through transient mirror
# flakes) and runs the ISO build. Kept as a committed file (not an inline
# heredoc) so it's readable + `bash -n`-checkable and free of YAML quoting.
#
# Env (passed via `docker run -e`): INSTALLER_DIR, OUTLAW_ISO_VERSION,
# OUTLAW_CODEMAKER_SRC. The repo is bind-mounted at /work.
# ============================================================================
set -eo pipefail

# Retry pacman through transient Arch mirror hiccups (a single .sig/.pkg failing
# from one mirror) — refresh the DB between attempts so a flaky mirror self-heals.
retry() {
  n=0
  until "$@"; do
    n=$((n + 1))
    if [ "$n" -ge 5 ]; then echo "::error::pacman failed after $n attempts"; return 1; fi
    echo "::warning::pacman attempt $n failed; refreshing databases, retrying in 15s…"
    sleep 15
    pacman -Syy --noconfirm || true
  done
}

pacman-key --init >/dev/null 2>&1
pacman-key --populate archlinux >/dev/null 2>&1
retry pacman -Syu --noconfirm --disable-download-timeout
retry pacman -S --noconfirm --needed --disable-download-timeout \
  archiso git base-devel \
  nodejs python python-pip rsync \
  mkinitcpio mkinitcpio-archiso squashfs-tools \
  dosfstools mtools libisoburn

cd "/work/${INSTALLER_DIR}"
# pipefail (set above) makes a build.sh failure propagate through the tee.
./build.sh 2>&1 | tee /work/build.log
