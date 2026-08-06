#!/usr/bin/env bash
# ============================================================================
# Outlaw OS - archiso profile definition
# ----------------------------------------------------------------------------
# Modeled on the upstream Arch `releng` profile. build.sh assembles the final
# build profile from the installed archiso `releng` config (for known-good
# bootloader scaffolding) and overlays this repo's files on top, so the boot
# configuration always matches your local archiso version. This file is kept
# for reference and for manual `mkarchiso` runs.
# shellcheck disable=SC2034
# ============================================================================

iso_name="outlaw-server"
iso_label="OUTLAWSRV_$(date +%Y%m)"
iso_publisher="Outlaw Server"
iso_application="Outlaw Server Live / Installer"
iso_version="0.2.0"
install_dir="arch"
buildmodes=('iso')
bootmodes=('bios.syslinux.mbr' 'bios.syslinux.eltorito'
           'uefi-ia32.grub.esp' 'uefi-x64.grub.esp'
           'uefi-ia32.grub.eltorito' 'uefi-x64.grub.eltorito')
arch="x86_64"
pacman_conf="pacman.conf"
airootfs_image_type="squashfs"
airootfs_image_tool_options=('-comp' 'zstd' '-Xcompression-level' '19' '-b' '1M')
bootstrap_tarball_compression=('zstd' '-c' '-T0' '--auto-threads=logical' '-19')
file_permissions=(
  ["/etc/shadow"]="0:0:400"
  ["/root"]="0:0:750"
  ["/root/.bash_profile"]="0:0:644"
  ["/root/.xinitrc"]="0:0:755"
  ["/usr/local/bin/outlaw-install"]="0:0:755"
  ["/usr/local/bin/outlaw-hotswap"]="0:0:755"
  ["/usr/local/bin/outlaw-perf"]="0:0:755"
  ["/usr/local/bin/outlaw-update-apply"]="0:0:755"
  ["/usr/local/bin/outlaw-swap"]="0:0:755"
)
