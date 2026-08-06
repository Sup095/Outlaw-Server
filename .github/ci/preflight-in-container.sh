#!/bin/bash
# ============================================================================
# Runs INSIDE the archlinux container during the GitHub "preflight" job (via
# `docker run`). Validates that EVERY package the OS asks pacman to install
# (the live-ISO packages.x86_64 + the installer's ESSENTIAL_PKGS) resolves in
# the official Arch repos — BEFORE the ~20-minute ISO build. A committed file so
# the awk/regex aren't mangled by YAML/heredoc quoting.
#
# Env (via `docker run -e`): INSTALLER_DIR. Repo bind-mounted at /work.
# ============================================================================
set -uo pipefail

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
# lib32-* packages need the multilib repo enabled to resolve.
if ! grep -q '^\[multilib\]' /etc/pacman.conf; then
  printf '\n[multilib]\nInclude = /etc/pacman.d/mirrorlist\n' >> /etc/pacman.conf
fi
# -Sy, NOT -Syu. All we need is the sync databases to query against; upgrading
# every package in a throwaway container is several minutes of pure waste (it is
# what pushed this job past its timeout). The usual "never -Sy on Arch" warning
# is about partial upgrades on a real system — nothing is installed here.
retry pacman -Sy --noconfirm --disable-download-timeout

PKGFILE="/work/${INSTALLER_DIR}/packages.x86_64"
INSTALLER="/work/${INSTALLER_DIR}/airootfs/usr/local/bin/outlaw-install"

echo "::group::Collecting package names"
# Live-ISO set: one package per line; drop comments/blanks, take the first field.
mapfile -t LIVE < <(grep -vE '^[[:space:]]*#|^[[:space:]]*$' "$PKGFILE" \
                    | awk '{print $1}' | grep -v '^$' || true)
# Installed-system ESSENTIAL_PKGS bash array: lines between 'ESSENTIAL_PKGS=(' and
# the closing ')', strip inline comments, split to words, keep package-looking tokens.
mapfile -t ESS < <(awk '/ESSENTIAL_PKGS=\(/{f=1;next} f&&/^\)/{f=0} f{sub(/#.*/,"");print}' "$INSTALLER" \
                    | tr ' \t' '\n\n' | grep -E '^[a-z0-9]' || true)
ALL="$(printf '%s\n' "${LIVE[@]}" "${ESS[@]}" | sort -u | grep -v '^$' || true)"
COUNT="$(printf '%s\n' "$ALL" | grep -c . || true)"
echo "Live-ISO packages   : ${#LIVE[@]}"
echo "Installer essential : ${#ESS[@]}"
echo "Unique to validate  : $COUNT"
printf '%s\n' "$ALL" | tr '\n' ' '; echo
echo "::endgroup::"

echo "::group::Resolving against the repos"
# Fast path: ask about every package in ONE pacman call. Spawning ~55 separate
# `pacman -Si` processes (each re-reading the sync databases) is what made this
# step slow enough to hit the job timeout.
MISSING=""
# shellcheck disable=SC2086  # deliberate word-splitting: $ALL is a package list
if pacman -Si -- $ALL >/dev/null 2>/tmp/pacman-si.err; then
  echo "  all $COUNT packages resolved in a single query"
else
  # Something didn't resolve. pacman names the offenders on stderr; re-check
  # only those individually so the reported list is exact rather than inferred
  # from a message format that could change between releases.
  SUSPECT="$(sed -n "s/^error: package '\(.*\)' was not found$/\1/p" /tmp/pacman-si.err | sort -u)"
  if [[ -z "$SUSPECT" ]]; then
    # Unrecognised failure — fall back to the slow-but-certain path.
    echo "::warning::batch query failed without naming a package; checking one by one."
    SUSPECT="$ALL"
  fi
  while IFS= read -r pkg; do
    [[ -z "$pkg" ]] && continue
    if pacman -Si -- "$pkg" >/dev/null 2>&1; then
      echo "  ok   $pkg"
    else
      echo "  MISS $pkg"
      MISSING="$MISSING $pkg"
    fi
  done <<< "$SUSPECT"
fi
echo "::endgroup::"

if [[ -n "${MISSING// /}" ]]; then
  echo "::error::Package preflight FAILED — these don't resolve in the official Arch repos (typo / renamed / AUR-only / dropped):$MISSING"
  echo ""
  echo "Fix the name(s) in $PKGFILE and/or ESSENTIAL_PKGS in outlaw-install,"
  echo "or move any AUR-only package to an on-demand install."
  exit 1
fi
echo "✅ All $COUNT packages resolve in the official repos. Safe to build."
