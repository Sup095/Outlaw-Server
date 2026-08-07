#!/usr/bin/env bash
# ============================================================================
# Outlaw OS - Boot Manager / Live ISO build script
# ----------------------------------------------------------------------------
# Strategy: take the known-good upstream `releng` archiso profile as a base
# (so bootloader scaffolding is always correct for the installed archiso), then
# overlay this repo's customizations on top. This avoids hand-maintaining
# fragile BIOS/UEFI boot configs.
#
# Run on Arch Linux with: sudo ./build.sh
# ============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
OUT_DIR="$REPO_ROOT/out"
WORK_DIR="$OUT_DIR/work"
PROFILE_DIR="$OUT_DIR/build-profile"
RELENG="/usr/share/archiso/configs/releng"
# Default version baked in for local builds. CI overrides this from the git
# tag via OUTLAW_ISO_VERSION (see .github/workflows/build-iso.yml) so the
# artifact filename always matches the tag the user pushed.
ISO_VERSION="${OUTLAW_ISO_VERSION:-0.8.0}"
ISO_FINAL="$OUT_DIR/outlaw-server-v${ISO_VERSION}.iso"

echo "========================================"
echo "   Building Outlaw Server Live ISO v${ISO_VERSION}"
echo "========================================"

# --- Preconditions ---------------------------------------------------------
if [[ $EUID -ne 0 ]]; then
    echo "ERROR: must run as root (mkarchiso needs it). Try: sudo ./build.sh"
    exit 1
fi
if ! command -v mkarchiso >/dev/null 2>&1; then
    echo "ERROR: archiso is not installed. Run: pacman -S archiso"
    exit 1
fi
if [[ ! -d "$RELENG" ]]; then
    echo "ERROR: $RELENG not found (is the 'archiso' package installed?)."
    exit 1
fi

# --- Clean -----------------------------------------------------------------
echo "[1/7] Cleaning previous build…"
rm -rf "$WORK_DIR" "$PROFILE_DIR" "$ISO_FINAL" "$ISO_FINAL.sha256" 2>/dev/null || true
mkdir -p "$OUT_DIR"

# --- Assemble profile from releng base + our overlays ----------------------
echo "[2/7] Assembling profile from releng base…"
cp -r "$RELENG" "$PROFILE_DIR"

# Overlay our package set and pacman.conf
cp "$HERE/packages.x86_64" "$PROFILE_DIR/packages.x86_64"
cp "$HERE/pacman.conf"     "$PROFILE_DIR/pacman.conf"

# Merge our airootfs overlay (scripts, skel, root profile, hostname)
cp -rT "$HERE/airootfs" "$PROFILE_DIR/airootfs"

# --- Live root login shell -------------------------------------------------
# CRITICAL: the upstream releng profile ships /etc/passwd with the live root
# shell set to /usr/bin/zsh, and bundles zsh in ITS package list. We REPLACE
# that package list with our own slim one, which does NOT include zsh — so on
# our ISO root's login shell points at a binary that isn't installed. The
# autologin getty then can't start a shell, the login profile never runs, and
# `startx` never fires: the live session dies before X, leaving a blank tty1.
# (This silently broke the live ISO on every build.) Force root's shell to
# /bin/bash, which is always present (base) and whose ~/.bash_profile we ship
# to launch the graphical session.
LIVE_PASSWD="$PROFILE_DIR/airootfs/etc/passwd"
if [[ -f "$LIVE_PASSWD" ]] && grep -qE '^root:.*:(/usr)?/bin/zsh$' "$LIVE_PASSWD"; then
    sed -i -E 's#^(root(:[^:]*){5}):[^:]*$#\1:/bin/bash#' "$LIVE_PASSWD"
    echo "[2a/7] Live root shell set to /bin/bash (releng default was zsh, which we don't ship)."
else
    echo "[2a/7] Live root shell check: no zsh override found (root already uses a shell we ship)."
fi

# NOTE: we deliberately do NOT add `nomodeset` to the boot entries anymore.
# Earlier builds did, as a workaround for a "black screen" we later traced to
# the wrong cause (the live root shell pointed at an uninstalled zsh, so X
# never started — fixed above). With that real bug gone, `nomodeset` was doing
# harm: it disables kernel mode-setting, so there's no DRM framebuffer for the
# modesetting Xorg driver, and in BIOS mode no efifb either — Xorg then failed
# with "no screens found". The standard KMS path (vmwgfx for VMSVGA, vboxvideo
# for VBoxVGA, or a real GPU) gives Xorg's modesetting driver a screen, with
# xf86-video-vesa / -fbdev still installed as automatic fallbacks. Much more
# robust across BIOS, UEFI, VMs and real hardware.

# Sync the Electron shell into the image (single source of truth: outlaw-shell)
echo "[3/7] Syncing Outlaw shell…"
install -d "$PROFILE_DIR/airootfs/usr/share/outlaw-os"
cp -rT "$REPO_ROOT/outlaw-shell" "$PROFILE_DIR/airootfs/usr/share/outlaw-os"
rm -rf "$PROFILE_DIR/airootfs/usr/share/outlaw-os/node_modules" 2>/dev/null || true

# Sync the first-boot wizard (separate small Electron app shown on first
# login after install — checkbox UI for Steam / Firefox / Godot bundles).
# Skipped silently on the live ISO via /root/.xinitrc.
if [[ -d "$REPO_ROOT/outlaw-firstboot" ]]; then
    echo "[3b/7] Syncing first-boot wizard…"
    install -d "$PROFILE_DIR/airootfs/usr/share/outlaw-firstboot"
    cp -rT "$REPO_ROOT/outlaw-firstboot" "$PROFILE_DIR/airootfs/usr/share/outlaw-firstboot"
    rm -rf "$PROFILE_DIR/airootfs/usr/share/outlaw-firstboot/node_modules" 2>/dev/null || true
fi

# Graphical installer wizard (point-and-click front-end over outlaw-install's
# machine modes — the default path from the desktop's Install button).
if [[ -d "$REPO_ROOT/outlaw-installer-gui" ]]; then
    echo "[3c/7] Syncing graphical installer…"
    install -d "$PROFILE_DIR/airootfs/usr/share/outlaw-installer-gui"
    cp -rT "$REPO_ROOT/outlaw-installer-gui" "$PROFILE_DIR/airootfs/usr/share/outlaw-installer-gui"
    rm -rf "$PROFILE_DIR/airootfs/usr/share/outlaw-installer-gui/node_modules" 2>/dev/null || true
fi

# The control daemon (Phase 1). Zero npm dependencies, so this is a plain copy —
# nothing to install or build. It serves the panel UI and runs every privileged
# operation; in `lean` mode it listens for nothing at all.
echo "[4/7] Syncing the control daemon…"
if [[ -d "$REPO_ROOT/outlaw-serverd" ]]; then
    install -d "$PROFILE_DIR/airootfs/usr/share/outlaw-serverd"
    cp -rT "$REPO_ROOT/outlaw-serverd" "$PROFILE_DIR/airootfs/usr/share/outlaw-serverd"
    rm -rf "$PROFILE_DIR/airootfs/usr/share/outlaw-serverd/node_modules" 2>/dev/null || true
    # The panel UI the daemon serves in a browser = the same shell sources.
    install -d "$PROFILE_DIR/airootfs/usr/share/outlaw-server/ui"
    cp -rT "$REPO_ROOT/outlaw-shell" "$PROFILE_DIR/airootfs/usr/share/outlaw-server/ui"
    rm -rf "$PROFILE_DIR/airootfs/usr/share/outlaw-server/ui/node_modules" 2>/dev/null || true
    # web-bridge.js lives in outlaw-shell/ (it IS a UI file), so the copy above
    # already placed it here — and in the Electron tree too, where it detects
    # preload's IPC bridge and stays out of the way.
else
    echo "  ⚠ outlaw-serverd/ not found — building without the control daemon."
fi

# Enable services + live autologin-to-shell (creating symlinks on Linux side)
echo "[5/7] Enabling services and autologin…"
ROOTFS="$PROFILE_DIR/airootfs"
install -d "$ROOTFS/etc/systemd/system/multi-user.target.wants"
ln -sf /usr/lib/systemd/system/NetworkManager.service \
       "$ROOTFS/etc/systemd/system/multi-user.target.wants/NetworkManager.service"
ln -sf /usr/lib/systemd/system/apparmor.service \
       "$ROOTFS/etc/systemd/system/multi-user.target.wants/apparmor.service"
# Autologin root on tty1. Name this drop-in so it sorts AFTER any releng one
# (`override.conf` comes after `autologin.conf`), so our ExecStart wins.
install -d "$ROOTFS/etc/systemd/system/getty@tty1.service.d"
cat > "$ROOTFS/etc/systemd/system/getty@tty1.service.d/override.conf" <<'EOF'
[Service]
ExecStart=
ExecStart=-/usr/bin/agetty --autologin root --noclear %I 38400 linux
EOF

# Patch profiledef.sh (keep releng bootmodes; override naming + permissions)
echo "[6/7] Patching profile metadata…"
PD="$PROFILE_DIR/profiledef.sh"
sed -i \
    -e 's/^iso_name=.*/iso_name="outlaw-server"/' \
    -e "s/^iso_version=.*/iso_version=\"${ISO_VERSION}\"/" \
    -e 's/^iso_publisher=.*/iso_publisher="Outlaw Server"/' \
    -e 's#^iso_application=.*#iso_application="Outlaw Server Live / Installer"#' \
    "$PD"
# Ensure our helper scripts are executable in the image.
#   outlaw-install-aur     — pkexec helper for on-demand AUR install (steamcmd).
#   outlaw-electron-flags  — emits per-host Electron CLI flags (VM detection
#                            for --disable-gpu so VBox doesn't black-screen).
#   outlaw-firstboot       — launches the first-boot setup wizard.
for f in outlaw outlaw-install outlaw-install-aur outlaw-electron-flags \
         outlaw-firstboot outlaw-start-session outlaw-hotswap outlaw-perf \
         outlaw-tune outlaw-update-apply outlaw-update-rollback \
         outlaw-session-watchdog \
         outlaw-diagnose outlaw-focus outlaw-term \
         outlaw-install-gui outlaw-pkg-install outlaw-update-pkgs \
         outlaw-driver-profile outlaw-swap; do
    if ! grep -q "/usr/local/bin/$f" "$PD"; then
        sed -i "/^file_permissions=(/a\\  [\"/usr/local/bin/$f\"]=\"0:0:755\"" "$PD"
    fi
done

# --- Build -----------------------------------------------------------------
echo "[7/7] Running mkarchiso (this takes a while)…"
mkarchiso -v -w "$WORK_DIR" -o "$OUT_DIR" "$PROFILE_DIR"

# mkarchiso outputs outlaw-server-<version>-x86_64.iso — normalize the name.
BUILT_ISO="$(find "$OUT_DIR" -maxdepth 1 -name 'outlaw-server-*.iso' -type f | head -n1 || true)"
if [[ -z "$BUILT_ISO" ]]; then
    echo "❌ ERROR: ISO not produced. Check the mkarchiso output above."
    exit 1
fi
mv -f "$BUILT_ISO" "$ISO_FINAL"
sha256sum "$ISO_FINAL" | sed "s#$OUT_DIR/##" > "$ISO_FINAL.sha256"

echo "✅ Build complete:"
echo "   ISO: $ISO_FINAL"
echo "   SHA: $ISO_FINAL.sha256"
ls -lh "$ISO_FINAL"*

# --- Size budget --------------------------------------------------------------
# GitHub release assets are capped at 2 GiB (2147483648 bytes). Surface the
# ISO size here so any future bloat shows up at build time, not at upload
# time. Hard-fail at 2 GiB so CI catches it before the gh-release step.
ISO_BYTES=$(stat -c%s "$ISO_FINAL" 2>/dev/null || wc -c < "$ISO_FINAL")
ISO_MIB=$((ISO_BYTES / 1024 / 1024))
LIMIT_BYTES=$((2 * 1024 * 1024 * 1024))   # 2 GiB
WARN_BYTES=$((1800 * 1024 * 1024))        # 1.8 GiB — start trimming territory
echo "   Size: ${ISO_MIB} MiB  (limit: 2048 MiB for GitHub release upload)"
if (( ISO_BYTES >= LIMIT_BYTES )); then
    echo ""
    echo "❌ ERROR: ISO is ${ISO_MIB} MiB — GitHub caps release assets at 2048 MiB."
    echo "   Trim packages.x86_64 (the LIVE-ISO list) — anything not strictly"
    echo "   needed to boot the installer + shell should live only in"
    echo "   outlaw-install's PKGS array, where it's pacstrapped post-install."
    exit 1
elif (( ISO_BYTES >= WARN_BYTES )); then
    echo "   ⚠ heads-up: within 250 MiB of the GitHub asset cap."
fi
