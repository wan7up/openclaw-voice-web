#!/usr/bin/env bash
set -euo pipefail

REPO="${OPENCLAW_VOICE_WEB_REPO:-wan7up/openclaw-voice-web}"
REF="${OPENCLAW_VOICE_WEB_REF:-main}"
TARBALL_URL="${OPENCLAW_VOICE_WEB_TARBALL_URL:-https://github.com/${REPO}/archive/refs/heads/${REF}.tar.gz}"

log() {
  printf '\033[1;34m[openclaw-voice-web]\033[0m %s\n' "$*"
}

fail() {
  printf '\033[1;31m[openclaw-voice-web]\033[0m %s\n' "$*" >&2
  exit 1
}

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo -E bash "$0" "$@"
  fi
  fail "Please run as root, or install sudo first."
fi

if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y ca-certificates curl tar
  else
    fail "curl and tar are required."
  fi
fi

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

archive="$tmp_dir/openclaw-voice-web.tar.gz"
log "Downloading ${TARBALL_URL}"
curl -fsSL "$TARBALL_URL" -o "$archive"

log "Extracting installer"
tar -xzf "$archive" -C "$tmp_dir"
project_dir="$(find "$tmp_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
if [ -z "$project_dir" ] || [ ! -f "$project_dir/scripts/install.sh" ]; then
  fail "Downloaded archive does not contain scripts/install.sh"
fi

log "Running installer"
bash "$project_dir/scripts/install.sh" "$@"
