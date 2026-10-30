#!/usr/bin/env bash
# Remove SkiffCode.
#   ~/.local/share/skiffcode/src/uninstall.sh   (if you installed with curl)
#   ./uninstall.sh          remove the app; keep your SkiffCode settings and repo list
#   ./uninstall.sh --purge  also delete ~/.local/share/skiffcode (settings, repo list, session list)
# Running Claude sessions and shells started by SkiffCode are stopped.
# Your repos, worktrees and Claude conversations (~/.claude) are never touched.
set -euo pipefail
SKIFFCODE_HOME="${SKIFFCODE_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/skiffcode}"
BIN_DIR="${SKIFFCODE_BIN_DIR:-$HOME/.local/bin}"

[[ -x "$BIN_DIR/skiffcode" ]] && "$BIN_DIR/skiffcode" stop >/dev/null 2>&1 || true
# Stop the terminal hosts (Claude sessions and shells) SkiffCode started.
pkill -f "$SKIFFCODE_HOME/app/server/ptyhost.py" 2>/dev/null || true
pkill -f "/harbor/app/server/ptyhost.py" 2>/dev/null || true   # started under SkiffCode's old name
rm -f "$BIN_DIR/skiffcode"
rm -rf "$SKIFFCODE_HOME/app" "$SKIFFCODE_HOME/pty" "$SKIFFCODE_HOME/src"
OLD="${XDG_DATA_HOME:-$HOME/.local/share}/harbor"
[[ -L "$OLD" ]] && rm -f "$OLD"   # link left by the move from Harbor
if grep -qi microsoft /proc/version 2>/dev/null && command -v powershell.exe >/dev/null; then
  powershell.exe -NoProfile -Command "Remove-Item -ErrorAction SilentlyContinue (Join-Path \$env:APPDATA 'Microsoft\Windows\Start Menu\Programs\SkiffCode.lnk'); Remove-Item -Recurse -ErrorAction SilentlyContinue (Join-Path \$env:LOCALAPPDATA 'SkiffCode')" >/dev/null 2>&1 || true
fi
if [[ "${1:-}" == "--purge" ]]; then
  rm -rf "$SKIFFCODE_HOME"
  echo "SkiffCode removed, including $SKIFFCODE_HOME"
else
  echo "SkiffCode removed. Your settings and repo list are still in $SKIFFCODE_HOME (use --purge to delete them)."
fi
