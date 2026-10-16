#!/usr/bin/env bash
# Identity guard for the MonoCode Hub fork.
#
# The Hub and upstream MonoCode are two apps that look alike. The Hub must keep its own bundle
# identifier (com.ash.monocode-hub) because Tauri keys the data directory off it:
#   app_data_dir() = ~/Library/Application Support/<identifier>
# A Hub build that carries upstream's identifier (com.monocode.desktop) reads and writes upstream's
# database, so the Hub's own conversations look like they vanished. That happened on 2026-10-16.
#
# This script checks three things and never writes to a database:
#   1. every installed/built Hub bundle carries the Hub identifier;
#   2. upstream MonoCode's database has not grown (a growing one means a misidentified build ran);
#   3. the Hub database has not shrunk.
#
# Run it from the repo root:   bash scripts/identity-guard.sh
# Wired into: `npm run hub:check` (before a Hub build) and the repo's CLAUDE.md checklist.

set -uo pipefail

HUB_IDENTIFIER="com.ash.monocode-hub"
UPSTREAM_IDENTIFIER="com.monocode.desktop"
SUPPORT="$HOME/Library/Application Support"
UPSTREAM_DB="$SUPPORT/$UPSTREAM_IDENTIFIER/monocode.db"
HUB_DB="$SUPPORT/$HUB_IDENTIFIER/monocode.db"
BASELINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.identity-baseline.json"
STATUS=0

# Read one integer from a SQLite database without taking a write lock. A live app holding the
# database is normal here, so a failure to read is a warning, never a hard fail.
q() { sqlite3 "file:$1?mode=ro" "$2" 2>/dev/null || echo ""; }

echo "MonoCode Hub identity guard"
echo "  hub identifier:      $HUB_IDENTIFIER"
echo "  upstream identifier: $UPSTREAM_IDENTIFIER (must NOT be used by any hub build)"
echo

# 1. Every Hub bundle on disk must carry the Hub identifier.
BUNDLES=(
  "$HOME/Applications/MonoCode Hub.app"
  "$HOME/Projects/monocode-hub/target/release/bundle/macos/MonoCode Hub.app"
)
for app in "${BUNDLES[@]}"; do
  [ -d "$app" ] || continue
  id=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$app/Contents/Info.plist" 2>/dev/null || echo "MISSING")
  if [ "$id" = "$HUB_IDENTIFIER" ]; then
    echo "  ok    $(basename "$app"): $id"
  else
    echo "  FAIL  $app"
    echo "        CFBundleIdentifier = $id (expected $HUB_IDENTIFIER)"
    STATUS=1
  fi
done

# A hub build that emitted upstream's identity is the exact failure. Look where builds land.
for tgt in \
  "$HOME/Projects/monocode-hub/target/release/bundle/macos/MonoCode.app" \
  "$HOME/Worktrees"/*/target/release/bundle/macos/MonoCode.app ; do
  [ -d "$tgt" ] || continue
  echo "  WARN  a build at $tgt carries the upstream name 'MonoCode.app'."
  echo "        If it came from this repo it has upstream's identifier and shares upstream's data."
  STATUS=1
done

# 2 & 3. Database growth/shrink compared with the last run.
upstream_n=$(q "$UPSTREAM_DB" "SELECT count(*) FROM sessions;")
hub_n=$(q "$HUB_DB" "SELECT count(*) FROM sessions;")

prev_upstream=""; prev_hub=""
if [ -f "$BASELINE" ]; then
  prev_upstream=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('upstreamSessions',''))" "$BASELINE" 2>/dev/null || echo "")
  prev_hub=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('hubSessions',''))" "$BASELINE" 2>/dev/null || echo "")
fi

if [ -n "$upstream_n" ]; then
  echo "  upstream database sessions: $upstream_n${prev_upstream:+ (last run: $prev_upstream)}"
  if [ -n "$prev_upstream" ] && [ "$upstream_n" -gt "$prev_upstream" ]; then
    echo "  FAIL  upstream's database grew ($prev_upstream -> $upstream_n)."
    echo "        Something with the upstream identity wrote conversations. Check /Applications/MonoCode.app"
    echo "        and any build carrying com.monocode.desktop. Those chats belong in the hub database."
    STATUS=1
  fi
else
  echo "  note  could not read upstream's database (missing or locked)"
fi

if [ -n "$hub_n" ]; then
  echo "  hub database sessions:      $hub_n${prev_hub:+ (last run: $prev_hub)}"
  if [ -n "$prev_hub" ] && [ "$hub_n" -lt "$prev_hub" ]; then
    echo "  FAIL  the hub database shrank ($prev_hub -> $hub_n) — suspect a misidentified build."
    STATUS=1
  fi
else
  echo "  note  could not read the hub database (missing or locked by the running app)"
fi

# Record the counts for the next run (only when we actually read them).
if [ -n "$upstream_n" ] && [ -n "$hub_n" ]; then
  printf '{"upstreamSessions":%s,"hubSessions":%s}\n' "$upstream_n" "$hub_n" > "$BASELINE"
fi

echo
if [ "$STATUS" -eq 0 ]; then
  echo "GUARD OK"
else
  echo "GUARD FAILED — see above"
fi
exit "$STATUS"
