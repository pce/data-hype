#!/bin/sh
# docs.sh
#
# Generate TypeDoc documentation to a temporary directory and copy it to a
# configurable output directory. This variant prefers `pnpm exec typedoc`
# (project-local) then `npx --no-install typedoc`, then a global `typedoc`
# binary, and finally falls back to `npx typedoc` (network install) as a last
# resort. It writes to ./docs-output by default or to $DOCS_OUTPUT / first arg.
#
# Usage:
#   DOCS_OUTPUT=./out ./docs.sh
#   ./docs.sh ./out
#   ./docs.sh           # writes to ./docs-output
#
# The script is written to be CI-friendly:
#  - Generates into a temp dir first to avoid partial output.
#  - Copies atomically into the output location (rsync when available).
#  - Exposes exit codes and clear diagnostics.
set -eu

# -- configuration -----------------------------------------------------------
OUT=${DOCS_OUTPUT:-${1:-./docs-output}}

# Resolve absolute-ish output path for nicer logs
case "$OUT" in
  /*) OUT_ABS="$OUT" ;;
  *) OUT_ABS="$(pwd)/$OUT" ;;
esac

# Create secure temp dir
TMPDIR="$(mktemp -d 2>/dev/null || mktemp -d -t docs_tmp)"
cleanup() {
  if [ -d "$TMPDIR" ]; then
    rm -rf "$TMPDIR"
  fi
}
trap cleanup EXIT

echo "TypeDoc generator: generating docs to temporary directory:"
echo "  $TMPDIR"
echo "Final output directory:"
echo "  $OUT_ABS"
echo ""

# -- doc generation ----------------------------------------------------------
# Try in order:
# 1) pnpm exec typedoc
# 2) npx --no-install typedoc
# 3) global typedoc
# 4) npx typedoc (network)
generate_with_pnpm_exec() {
  if command -v pnpm >/dev/null 2>&1; then
    echo "Trying: pnpm exec typedoc (project-local)"
    # Use pnpm exec to prefer a project-installed typedoc
    if pnpm exec --silent typedoc --out "$TMPDIR"; then
      return 0
    fi
    echo "pnpm exec typedoc failed or not available in project-local deps."
  else
    echo "pnpm not found on PATH; skipping pnpm exec typedoc."
  fi
  return 1
}

generate_with_npx_no_install() {
  if command -v npx >/dev/null 2>&1; then
    echo "Trying: npx --no-install typedoc (use local node_modules/.bin if present)"
    # --no-install prevents network install; will fail if not present locally
    if npx --no-install typedoc --out "$TMPDIR"; then
      return 0
    fi
    echo "npx --no-install typedoc not available locally."
  else
    echo "npx not found on PATH; skipping npx --no-install typedoc."
  fi
  return 1
}

generate_with_global_typedoc() {
  if command -v typedoc >/dev/null 2>&1; then
    echo "Trying: global typedoc"
    if typedoc --out "$TMPDIR"; then
      return 0
    fi
    echo "Global typedoc invocation failed."
  else
    echo "Global typedoc not found; skipping."
  fi
  return 1
}

generate_with_npx_network() {
  if command -v npx >/dev/null 2>&1; then
    echo "Trying: npx typedoc (network install fallback)"
    echo "Note: this may download packages from the network (CI may restrict this)."
    if npx typedoc --out "$TMPDIR"; then
      return 0
    fi
    echo "npx typedoc (network) failed."
  else
    echo "npx not found on PATH; cannot perform network fallback."
  fi
  return 1
}

echo "Generating TypeDoc (attempting preferred executables in order)..."
if generate_with_pnpm_exec; then
  echo "Docs generated with pnpm exec typedoc"
elif generate_with_npx_no_install; then
  echo "Docs generated with npx --no-install typedoc"
elif generate_with_global_typedoc; then
  echo "Docs generated with global typedoc"
elif generate_with_npx_network; then
  echo "Docs generated with npx typedoc (network)"
else
  echo "Error: TypeDoc not found or all invocation methods failed."
  echo "Install TypeDoc (pnpm/yarn/npm) or ensure 'npx'/'typedoc' are available."
  exit 1
fi

echo ""
echo "Documentation generated into: $TMPDIR"
echo ""

# -- publish to output ------------------------------------------------------
# Ensure OUT is a directory (not a file)
if [ -f "$OUT" ]; then
  echo "Error: output path exists and is a regular file: $OUT" >&2
  exit 1
fi

# Create output dir if missing
mkdir -p "$OUT"

# Use rsync if available for atomic-ish sync
if command -v rsync >/dev/null 2>&1; then
  echo "Syncing to output directory with rsync..."
  rsync -a --delete --omit-dir-times --no-perms "$TMPDIR"/ "$OUT"/
  RSYNC_EXIT=$?
  if [ "$RSYNC_EXIT" -ne 0 ]; then
    echo "rsync reported failure (exit $RSYNC_EXIT). Aborting." >&2
    exit "$RSYNC_EXIT"
  fi
else
  echo "rsync not found; falling back to safe copy."
  # Remove existing contents (preserve the directory itself)
  if [ -d "$OUT" ]; then
    # Remove hidden and non-hidden files safely
    set +e
    # POSIX-safe removals: handle if pattern matches nothing
    find "$OUT" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    set -e
  fi

  echo "Copying files..."
  if cp -a "$TMPDIR"/. "$OUT"/ 2>/dev/null; then
    :
  else
    if cp -r "$TMPDIR"/. "$OUT"/; then
      :
    else
      echo "Error: copying docs into output directory failed." >&2
      exit 1
    fi
  fi
fi

echo ""
echo "Documentation published to: $OUT_ABS"
echo ""
echo "Top-level files in output directory:"
if command -v ls >/dev/null 2>&1; then
  ls -la "$OUT" | head -n 20 || true
fi

echo ""
echo "Documentation generation complete."
exit 0

