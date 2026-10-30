#!/bin/sh
# SkiffCode status hook for Claude Code (passed with `claude --settings`).
# Records the session state in $SKIFFCODE_STATUS_DIR/$SKIFFCODE_SESSION_ID.json.
# Usage: hook.sh <working|question|permission|idle|ended|edited|agent> [prompt|start]
# Sessions started by Harbor (SkiffCode's old name) still carry the old variable names.
: "${SKIFFCODE_SESSION_ID:=$HARBOR_SESSION_ID}" "${SKIFFCODE_STATUS_DIR:=$HARBOR_STATUS_DIR}"
if [ -z "$SKIFFCODE_SESSION_ID" ] || [ -z "$SKIFFCODE_STATUS_DIR" ] || [ ! -d "$SKIFFCODE_STATUS_DIR" ]; then
  cat >/dev/null 2>&1; exit 0
fi
d="$SKIFFCODE_STATUS_DIR"; id="$SKIFFCODE_SESSION_ID"
if [ "$1" = agent ]; then
  # Subagent events: keep the hook input (one line each) for SkiffCode's subagent list.
  # One write per event (parallel subagents start at the same moment).
  line=$(tr -d '\r\n' | { head -c 65536; cat >/dev/null; })
  printf '%s\t%s\n' "$(date +%s)" "$line" >>"$d/$id.agents" 2>/dev/null
  exit 0
fi
cat >/dev/null 2>&1
# A name you gave the session in SkiffCode, not yet passed to Claude: hand it over as the
# session title (UserPromptSubmit and SessionStart hooks may set it). $2 = prompt | start.
t="$d/$id.title"
if [ -f "$t" ] && { [ "$2" = prompt ] || [ "$2" = start ]; }; then
  ev=UserPromptSubmit; [ "$2" = start ] && ev=SessionStart
  title=$(cat "$t" 2>/dev/null) && rm -f "$t" && [ -n "$title" ] &&
    printf '{"hookSpecificOutput":{"hookEventName":"%s","sessionTitle":%s}}\n' "$ev" "$title"
fi
case "$1" in
  edited) : >"$d/$id.edited"; exit 0 ;;   # Claude changed files: refresh git + file views
  working|question|permission|idle|ended) ;;
  *) exit 0 ;;
esac
# Remember that the conversation has a prompt, so SkiffCode resumes it instead of starting fresh.
[ "$1" = working ] && [ ! -f "$d/$id.prompted" ] && : >"$d/$id.prompted"
f="$d/$id.json"
if [ -f "$f" ] && grep -q "\"state\":\"$1\"" "$f" 2>/dev/null; then exit 0; fi
tmp="$f.$$.tmp"
printf '{"state":"%s"}\n' "$1" >"$tmp" 2>/dev/null && mv -f "$tmp" "$f" 2>/dev/null
exit 0
