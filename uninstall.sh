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
# Stop the terminal hosts (Claude sessions and shells) SkiffCode started: "python3 …/ptyhost.py <home>/pty/<id>.sock …".
pty_re="$(printf '%s' "$SKIFFCODE_HOME/pty/" | sed 's/[][\.*^$+?(){}|]/\\&/g')"
hosts() { pgrep -f "^[^ ]+ [^ ]*/ptyhost\.py ${pty_re}[^ /]+\.sock " 2>/dev/null || true; }
pids="$(hosts)"
if [[ -n "$pids" ]]; then
  kill $pids 2>/dev/null || true
  # They save their scrollback into pty/ as they exit: wait before removing it.
  for _ in $(seq 1 50); do [[ -n "$(hosts)" ]] || break; sleep 0.1; done
fi
rm -f "$BIN_DIR/skiffcode"
rm -rf "$SKIFFCODE_HOME/app" "$SKIFFCODE_HOME/pty" "$SKIFFCODE_HOME/src"
if grep -qi microsoft /proc/version 2>/dev/null && command -v powershell.exe >/dev/null; then
  # --foreground: WSL suspends Windows programs started outside the terminal's foreground (plain `timeout`).
  timeout --foreground 30 powershell.exe -NoProfile -NonInteractive -Command "Remove-Item -ErrorAction SilentlyContinue (Join-Path \$env:APPDATA 'Microsoft\Windows\Start Menu\Programs\SkiffCode.lnk'); Remove-Item -Recurse -ErrorAction SilentlyContinue (Join-Path \$env:LOCALAPPDATA 'SkiffCode')" </dev/null >/dev/null 2>&1 || true
fi
if [[ "${1:-}" == "--purge" ]]; then
  rm -rf "$SKIFFCODE_HOME"
  echo "SkiffCode removed, including $SKIFFCODE_HOME"
else
  echo "SkiffCode removed. Your settings and repo list are still in $SKIFFCODE_HOME (use --purge to delete them)."
fi
