#!/usr/bin/env bash
# Identity guard for the MonoCode Hub fork.
#
# The Hub and upstream MonoCode are two apps that look alike. The Hub must keep its own bundle
# identifier (com.ash.monocode-hub) because Tauri keys the data directory off it:
#   app_data_dir() = ~/Library/Application Support/<identifier>
# A Hub build that carries upstream's identifier (com.monocode.desktop) reads and writes upstream's
# database, so the Hub's own conversations look like they vanished. That happened on 2026-10-16.
#
# Since Phase 1b a copy's kind comes from its identifier (src-tauri/src/instance.rs):
#   com.ash.monocode-hub              the daily app; runs only from ~/Applications/MonoCode Hub.app
#   com.ash.monocode-hub.dev.<slot>   a dev copy, with its own data folder
# Every build carries a stamp (MONOCODE-STAMP:{sha,branch,dirty,builtAt}) read here without launching it.
#
# This script never writes to a database and never launches an app. It checks:
#   1. the installed app and every Hub build under ~/Projects/monocode-hub and ~/Worktrees carry a known
#      identity (upstream's identifier fails; an unstamped daily build outside ~/Applications is flagged);
#   2. upstream MonoCode's database has not grown (a growing one means a misidentified build ran);
#   3. the Hub database has not shrunk.
# It also lists each data folder and the copy that last owned it (running.json).
#
# Run it from the repo root:   bash scripts/identity-guard.sh
# Wired into: `npm run hub:check` (before a Hub build) and the repo's AGENTS.md checklist.
# Tests (scripts/identity-guard.test.cjs) run it with HOME and HUB_GUARD_BASELINE pointing at fixtures.

set -uo pipefail
shopt -s nullglob

HUB_IDENTIFIER="com.ash.monocode-hub"
DEV_PREFIX="com.ash.monocode-hub.dev."
SANDBOX_IDENTIFIER="com.ash.monocode-hub.sandbox"
UPSTREAM_IDENTIFIER="com.monocode.desktop"
SUPPORT="$HOME/Library/Application Support"
UPSTREAM_DB="$SUPPORT/$UPSTREAM_IDENTIFIER/monocode.db"
HUB_DB="$SUPPORT/$HUB_IDENTIFIER/monocode.db"
DAILY_APP="$HOME/Applications/MonoCode Hub.app"
BASELINE="${HUB_GUARD_BASELINE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.identity-baseline.json}"
STATUS=0

# Read one integer from a SQLite database without taking a write lock. A live app holding the
# database is normal here, so a failure to read is a warning, never a hard fail.
q() { sqlite3 "file:$1?mode=ro" "$2" 2>/dev/null || echo ""; }

plist_id() { /usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$1/Contents/Info.plist" 2>/dev/null || echo "MISSING"; }

# The build stamp as "branch @ sha7[-dirty], built <time>", or nothing for a build without one. The binary may hold
# the bare prefix elsewhere, and a branch may contain "}", so every candidate is parsed until one is a real stamp
# (the same reader as scripts/hub-bundle.mjs).
stamp_of() {
  local bin="$1/Contents/MacOS/monocode"
  [ -f "$bin" ] || return 0
  python3 - "$bin" <<'PY' 2>/dev/null || true
import json, sys
data = open(sys.argv[1], "rb").read()
marker = b"MONOCODE-STAMP:{"
at = data.find(marker)
while at != -1:
    start = at + len(marker) - 1
    end = data.find(b"}", start)
    while end != -1 and end - start < 4096:
        try:
            s = json.loads(data[start:end + 1].decode("utf-8"))
            if isinstance(s, dict) and isinstance(s.get("sha"), str) and isinstance(s.get("branch"), str):
                print("%s @ %s%s, built %s" % (s["branch"], s["sha"][:7], "-dirty" if s.get("dirty") else "", s.get("builtAt", "?")))
                sys.exit(0)
        except Exception:
            pass
        end = data.find(b"}", end + 1)
    at = data.find(marker, at + len(marker))
PY
}

valid_slot() { [[ "$1" =~ ^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$ ]]; }

echo "MonoCode Hub identity guard"
echo "  daily identifier:    $HUB_IDENTIFIER (runs only from ~/Applications/MonoCode Hub.app)"
echo "  dev copies:          ${DEV_PREFIX}<slot>"
echo "  upstream identifier: $UPSTREAM_IDENTIFIER (must NOT be used by any hub build)"
echo

# 1a. The installed daily app.
if [ -d "$DAILY_APP" ]; then
  id=$(plist_id "$DAILY_APP")
  stamp=$(stamp_of "$DAILY_APP")
  if [ "$id" = "$HUB_IDENTIFIER" ]; then
    echo "  ok    installed: $(basename "$DAILY_APP"): $id, ${stamp:-no build stamp (built before Phase 1b)}"
  else
    echo "  FAIL  $DAILY_APP"
    echo "        CFBundleIdentifier = $id (expected $HUB_IDENTIFIER)"
    STATUS=1
  fi
fi

# 1b. Every Hub build where builds land: release bundles and dev wrappers.
for app in \
  "$HOME/Projects/monocode-hub/target"/{release,debug}/bundle/macos/*.app \
  "$HOME/Projects/monocode-hub/target/debug"/*.app \
  "$HOME/Worktrees"/*/target/{release,debug}/bundle/macos/*.app \
  "$HOME/Worktrees"/*/target/debug/*.app; do
  [ -d "$app" ] || continue
  id=$(plist_id "$app")
  name=$(basename "$app")
  stamp=$(stamp_of "$app")
  case "$id" in
    "$HUB_IDENTIFIER")
      if [ -n "$stamp" ]; then
        echo "  ok    daily build: $app ($stamp); it runs only once shipped to ~/Applications"
      else
        echo "  WARN  $app carries the daily identity and predates the instance lock (no build stamp)."
        echo "        Opened from there it would run on Ash's live data. Archive it."
      fi
      ;;
    "$DEV_PREFIX"*)
      slot="${id#"$DEV_PREFIX"}"
      if valid_slot "$slot"; then
        echo "  ok    dev slot $slot: $app (${stamp:-no build stamp})"
      else
        echo "  WARN  $app carries $id, which is not a valid dev slot; it refuses to start."
      fi
      ;;
    "$SANDBOX_IDENTIFIER")
      echo "  note  retired test copy: $app ($id). Its data folder is separate; archive it."
      ;;
    "$UPSTREAM_IDENTIFIER")
      echo "  FAIL  $app carries upstream's identifier ($UPSTREAM_IDENTIFIER)."
      echo "        If it came from this repo it shares upstream MonoCode's database."
      STATUS=1
      ;;
    *)
      case "$name" in
        MonoCode*) echo "  WARN  $app carries an unknown identity ($id)." ;;
      esac
      ;;
  esac
done

# Who last owned each data folder. The lock itself (instance-owner.sqlite) is never touched here.
for dir in "$SUPPORT/$HUB_IDENTIFIER" "$SUPPORT/$DEV_PREFIX"*; do
  [ -d "$dir" ] || continue
  owner="no running.json"
  if [ -f "$dir/running.json" ]; then
    owner=$(python3 - "$dir/running.json" <<'PY' 2>/dev/null || echo "unreadable running.json"
import json, os, sys
r = json.load(open(sys.argv[1]))
pid = r.get("pid")
alive = False
try:
    os.kill(int(pid), 0)
    alive = True
except Exception:
    pass
print("%s pid %s (%s), %s @ %s%s, from %s" % (
    r.get("kind", "?"), pid, "running" if alive else "not running",
    r.get("branch", "?"), str(r.get("sha", "?"))[:7], "-dirty" if r.get("dirty") else "",
    r.get("bundlePath", "?")))
PY
)
  fi
  echo "  data  $(basename "$dir"): last owner $owner"
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
