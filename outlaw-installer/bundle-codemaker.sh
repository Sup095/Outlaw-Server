#!/usr/bin/env bash
# ============================================================================
# bundle-codemaker.sh — copy Outlaw CodeMaker into the airootfs overlay.
# ----------------------------------------------------------------------------
# Called by build.sh between profile assembly and mkarchiso. Produces
#   <airootfs>/opt/outlaw-codemaker/
# with the source tree but WITHOUT venv, caches, build artifacts, or the
# user's local data (SQLite DBs, workspace/, backups/, etc.). The Linux venv
# is created during outlaw-install on the installed system (we can't ship a
# venv because they're path- and Python-version-specific).
#
# Usage:
#   bundle-codemaker.sh <source-dir> <airootfs-dir>
#
# Exits 0 even if <source-dir> is missing — the ISO can build without
# CodeMaker (the greeter's Dev path falls back to the desktop shell).
# ============================================================================

set -uo pipefail

SRC="${1:-}"
DEST_ROOT="${2:-}"

if [[ -z "$SRC" || -z "$DEST_ROOT" ]]; then
    echo "usage: $0 <codemaker-source-dir> <airootfs-dir>" >&2
    exit 2
fi

DEST="$DEST_ROOT/opt/outlaw-codemaker"

if [[ ! -d "$SRC" ]]; then
    echo "[bundle-codemaker] source not found: $SRC"
    echo "[bundle-codemaker] skipping — the Dev session will be unavailable in this build."
    exit 0
fi
if [[ ! -f "$SRC/main.py" ]]; then
    echo "[bundle-codemaker] $SRC/main.py missing — this doesn't look like CodeMaker. Skipping."
    exit 0
fi

echo "[bundle-codemaker] $SRC  →  $DEST"
mkdir -p "$DEST"

# Pick rsync if available (better excludes); fall back to cp + post-cleanup.
EXCLUDES=(
    ".venv"
    "__pycache__"
    ".pytest_cache"
    ".mypy_cache"
    ".ruff_cache"
    ".git"
    ".github"
    ".gitignore"
    "backups"
    "workspace"
    # Windows-only helpers — useless on Linux and noisy in the image.
    "tools/tesseract"
    "Create Desktop Icon.bat"
    "run.bat"
    # Local databases that hold the dev's projects, sessions, vault index, etc.
    # The OS user starts fresh — a brand-new outlaw.db is created on first run.
    "db/*.db"
    "db/*.db-journal"
    "db/*.db-wal"
    "db/*.db-shm"
    # Build artifacts / IDE noise
    "*.egg-info"
    ".vscode"
    ".idea"
)

if command -v rsync >/dev/null 2>&1; then
    RSYNC_ARGS=(-a --delete-excluded)
    for pat in "${EXCLUDES[@]}"; do
        RSYNC_ARGS+=(--exclude "$pat")
    done
    rsync "${RSYNC_ARGS[@]}" "$SRC/" "$DEST/"
else
    # No rsync — do a plain copy then prune the excludes by name.
    cp -rT "$SRC" "$DEST"
    for pat in "${EXCLUDES[@]}"; do
        # find handles the simple glob patterns we use above.
        find "$DEST" -depth -name "${pat##*/}" -exec rm -rf {} + 2>/dev/null || true
    done
fi

# Sanity check — main.py must end up in the bundle, else the launcher won't
# find it and outlaw-codemaker will fall back to desktop on every Dev choice.
if [[ ! -f "$DEST/main.py" ]]; then
    echo "[bundle-codemaker] ERROR: main.py missing in $DEST after copy." >&2
    exit 1
fi

# Quick summary for the build log.
BYTES=$(du -sb "$DEST" 2>/dev/null | awk '{print $1}')
FILES=$(find "$DEST" -type f | wc -l)
echo "[bundle-codemaker] bundled $FILES files (~$((BYTES / 1024 / 1024)) MB)."
