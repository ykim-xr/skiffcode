#!/usr/bin/env bash
# Install (or update) SkiffCode for the current user. No root needed.
#
#   curl -fsSL https://raw.githubusercontent.com/ykim-xr/skiffcode/main/install.sh | bash
#   ./install.sh                      (from a copy of the repo)
#
# Puts the app in ~/.local/share/skiffcode/app, the `skiffcode` command in ~/.local/bin,
# and (on WSL) "SkiffCode" in the Windows Start menu. Update later with: skiffcode update
set -euo pipefail

REPO="${SKIFFCODE_REPO:-https://github.com/ykim-xr/skiffcode.git}"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
SKIFFCODE_HOME="${SKIFFCODE_HOME:-$DATA/skiffcode}"
APP="$SKIFFCODE_HOME/app"
BIN_DIR="${SKIFFCODE_BIN_DIR:-$HOME/.local/bin}"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!!\033[0m %s\n' "$*"; }
die() { printf '\033[31mxx\033[0m %s\n' "$*" >&2; exit 1; }
# Windows PowerShell from WSL: never let it wait on the terminal for input, and never for long.
# --foreground: WSL suspends Windows programs started outside the terminal's foreground (plain `timeout`).
winps() { timeout --foreground 60 powershell.exe -NoProfile -NonInteractive -Command "$1" </dev/null >/dev/null 2>&1; }

# ---- run through `curl … | bash`: fetch the repo, then run its installer
HERE=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; fi
if [[ -z "$HERE" || ! -f "$HERE/server/main.js" ]]; then
  command -v git >/dev/null || die "git is required (sudo apt install git)"
  SRC="$SKIFFCODE_HOME/src"
  (umask 077; mkdir -p "$SKIFFCODE_HOME")
  if [[ -d "$SRC/.git" ]]; then
    say "Updating $SRC"
    git -C "$SRC" fetch -q --depth 1 origin main && git -C "$SRC" reset -q --hard FETCH_HEAD
  else
    say "Downloading SkiffCode from $REPO"
    rm -rf "$SRC"
    git clone -q --depth 1 "$REPO" "$SRC"
  fi
  exec bash "$SRC/install.sh"
fi

# ---- requirements
if ! command -v node >/dev/null; then
  die "Node.js 18 or newer is required. Easiest: install nvm (https://github.com/nvm-sh/nvm), then: nvm install --lts"
fi
major="$(node -p 'process.versions.node.split(".")[0]')"
(( major >= 18 )) || die "Node.js $(node -v) is too old; SkiffCode needs 18+ (nvm install --lts)"
command -v python3 >/dev/null || die "python3 is required (sudo apt install python3)"
command -v git >/dev/null || die "git is required (sudo apt install git)"
command -v claude >/dev/null || warn "'claude' isn't on PATH yet — install Claude Code, or set the command in SkiffCode's Settings."
command -v rg >/dev/null || warn "ripgrep makes search much faster: sudo apt install ripgrep (SkiffCode falls back to git grep)"

# ---- app files
say "Installing SkiffCode $(node -p "require('$HERE/package.json').version") → $APP"
(umask 077; mkdir -p "$SKIFFCODE_HOME")
mkdir -p "$BIN_DIR"
rm -rf "$APP.new"
mkdir -p "$APP.new"
cp -r "$HERE/server" "$HERE/web" "$HERE/scripts" "$HERE/package.json" "$APP.new/"
# The library versions fetch-vendor.sh pins, as it records them in vendor/VERSIONS.
pinned() { printf '%s %s' "$(sed -n 's/^MONACO=//p' "$1")" "$(sed -n 's/^XTERM=//p' "$1")"; }
if [[ -d "$HERE/vendor/monaco" && -d "$HERE/vendor/xterm" && "$(cat "$HERE/vendor/VERSIONS" 2>/dev/null)" == "$(pinned "$HERE/scripts/fetch-vendor.sh")" ]]; then
  cp -r "$HERE/vendor" "$APP.new/vendor"
elif [[ -d "$APP/vendor/monaco" && -f "$APP/vendor/VERSIONS" ]] && diff -q <(grep -E '^[A-Z0-9]+=[0-9]' "$HERE/scripts/fetch-vendor.sh") <(grep -E '^[A-Z0-9]+=[0-9]' "$APP/scripts/fetch-vendor.sh") >/dev/null 2>&1; then
  cp -r "$APP/vendor" "$APP.new/vendor"   # same library versions as before: keep them
else
  say "Downloading the editor and terminal libraries"
  bash "$APP.new/scripts/fetch-vendor.sh"
fi
chmod +x "$APP.new/server/ptyhost.py" "$APP.new/server/hook.sh" "$APP.new/server/main.js"
rm -rf "$APP.old"
[[ -d "$APP" ]] && mv "$APP" "$APP.old"
mv "$APP.new" "$APP"

install -m 0755 "$HERE/bin/skiffcode" "$BIN_DIR/skiffcode"

# A running server keeps the old code until it restarts (sessions keep running either way).
# The previous version stays in $APP.old until the new one has started.
if "$BIN_DIR/skiffcode" status 2>/dev/null </dev/null | grep -q '^running'; then
  if "$BIN_DIR/skiffcode" restart </dev/null >/dev/null; then
    say "Restarted the running SkiffCode server"
  elif [[ -d "$APP.old" ]]; then
    warn "The new version didn't start. Going back to the previous one."
    rm -rf "$APP"
    mv "$APP.old" "$APP"
    "$BIN_DIR/skiffcode" restart </dev/null >/dev/null || true
    die "Update failed. Its log is $SKIFFCODE_HOME/server.log.1"
  else
    die "SkiffCode didn't start. See $SKIFFCODE_HOME/server.log"
  fi
fi
rm -rf "$APP.old"

# ---- Windows Start menu (WSL)
if grep -qi microsoft /proc/version 2>/dev/null && command -v powershell.exe >/dev/null && [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
  say "Adding “SkiffCode” to the Windows Start menu"
  winps "
    \$p = Join-Path \$env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\SkiffCode.lnk';
    \$s = (New-Object -ComObject WScript.Shell).CreateShortcut(\$p);
    \$s.TargetPath = (Join-Path \$env:WINDIR 'System32\\wsl.exe');
    \$s.Arguments = '-d $WSL_DISTRO_NAME -- bash -lic skiffcode';
    \$s.WindowStyle = 7;
    \$d = Join-Path \$env:LOCALAPPDATA 'SkiffCode'; New-Item -ItemType Directory -Force \$d | Out-Null;
    Copy-Item -Force '$(wslpath -w "$APP/web/icons/skiffcode.ico" 2>/dev/null)' (Join-Path \$d 'skiffcode.ico') -ErrorAction SilentlyContinue;
    if (Test-Path (Join-Path \$d 'skiffcode.ico')) { \$s.IconLocation = (Join-Path \$d 'skiffcode.ico') };
    \$s.Description = 'SkiffCode — repos, worktrees and Claude Code sessions';
    \$s.Save()" || warn "couldn't create the Start menu shortcut (you can still run: skiffcode)"
fi

echo
say "Done. Start SkiffCode:   skiffcode              (or “SkiffCode” in the Start menu)"
say "Open at a repo:          skiffcode ~/code/my-repo"
say "Get the latest version:  skiffcode update"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) warn "$BIN_DIR is not on your PATH — add it:  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc && source ~/.bashrc" ;; esac
