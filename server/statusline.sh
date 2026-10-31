#!/bin/sh
# SkiffCode status line for Claude Code (passed with `claude --settings`).
# Saves Claude's status JSON (it includes 5-hour / weekly usage) for SkiffCode,
# then shows your own status line if you have one configured.
input=$(cat)
if [ -n "$SKIFFCODE_SESSION_ID" ] && [ -d "$SKIFFCODE_STATUS_DIR" ]; then
  f="$SKIFFCODE_STATUS_DIR/$SKIFFCODE_SESSION_ID.statusline"
  printf '%s' "$input" >"$f.$$" 2>/dev/null && mv -f "$f.$$" "$f" 2>/dev/null
fi
if [ -n "$SKIFFCODE_USER_STATUSLINE" ]; then
  printf '%s' "$input" | sh -c "$SKIFFCODE_USER_STATUSLINE"
fi
exit 0
