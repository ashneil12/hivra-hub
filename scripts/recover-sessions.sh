#!/usr/bin/env bash
# Bring conversations back from upstream MonoCode's database into the Hub's database.
#
# Why this is needed: before the identity fix, a Hub build could carry upstream's bundle identifier
# (com.monocode.desktop). Such a build read and wrote upstream's own database
# (~/Library/Application Support/com.monocode.desktop/), so conversations Ash had in "MonoCode"
# live there instead of in the Hub's database. The conversations were never deleted — they are in
# the wrong store. This copies them across.
#
# It is also a general-purpose tool: pass one or more session ids, or no argument to move every
# session that is missing from the hub. Pass --dry-run to see what would move.
#
# Usage:
#   bash scripts/recover-sessions.sh --dry-run
#   bash scripts/recover-sessions.sh                      # every session the hub is missing
#   bash scripts/recover-sessions.sh 627d4d7e-1aba-4bc1-bf75-e481ea27d5ec
#
# Safety:
#   - copies whole `sessions` rows only (the schemas are identical; both at migration 19);
#   - INSERT OR IGNORE, so an existing session is never overwritten;
#   - backs up both databases first;
#   - never copies the upstream database over the hub's;
#   - checkpoint dirs are copied additively (per-turn change review), never replaced.

set -euo pipefail

UPSTREAM_IDENTIFIER="com.monocode.desktop"
HUB_IDENTIFIER="com.ash.monocode-hub"
SUPPORT="$HOME/Library/Application Support"
UPSTREAM_DB="$SUPPORT/$UPSTREAM_IDENTIFIER/monocode.db"
HUB_DB="$SUPPORT/$HUB_IDENTIFIER/monocode.db"

DRY_RUN=0
SIDS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) SIDS+=("$arg") ;;
  esac
done

[ -f "$UPSTREAM_DB" ] || { echo "No upstream database at $UPSTREAM_DB — nothing to recover."; exit 0; }
[ -f "$HUB_DB" ]      || { echo "No hub database at $HUB_DB — is the Hub installed?"; exit 1; }

# Build the WHERE clause: named ids, or every row the hub does not already have.
if [ "${#SIDS[@]}" -gt 0 ]; then
  quoted=$(printf "'%s'," "${SIDS[@]}"); quoted="${quoted%,}"
  WHERE="id IN ($quoted)"
else
  WHERE="id NOT IN (SELECT id FROM main.sessions)"
fi

echo "Recovering conversations into the Hub database"
echo "  from: $UPSTREAM_DB"
echo "  into: $HUB_DB"
echo

echo "Sessions to move:"
sqlite3 -header -column "file:$UPSTREAM_DB?mode=ro" \
  "SELECT substr(id,1,8) AS id, datetime(updated_at/1000,'unixepoch','localtime') AS updated,
          length(blocks_json) AS bytes, substr(title,1,52) AS title
     FROM sessions WHERE $WHERE ORDER BY updated_at DESC;" || {
  echo "Could not read the upstream database (it may be locked or missing rows)."; exit 1; }
echo

if [ "$DRY_RUN" -eq 1 ]; then
  echo "Dry run — nothing was written. Re-run without --dry-run to move them."
  exit 0
fi

TS=$(date +%Y%m%dT%H%M%S)
BACKUP="$HOME/Archive/monocode/backups-$TS"
mkdir -p "$BACKUP"
echo "Backing up both databases to $BACKUP"
for f in "$HUB_DB" "$HUB_DB-wal" "$HUB_DB-shm"; do [ -f "$f" ] && cp -a "$f" "$BACKUP/" ; done
for f in "$UPSTREAM_DB" "$UPSTREAM_DB-wal" "$UPSTREAM_DB-shm"; do [ -f "$f" ] && cp -a "$f" "$BACKUP/upstream-$(basename "$f")" ; done
echo

echo "Copying rows (the Hub may be running; this waits briefly for its lock)"
sqlite3 "file:$HUB_DB" <<SQL
.timeout 20000
ATTACH 'file:$UPSTREAM_DB?mode=ro' AS src;
INSERT OR IGNORE INTO main.sessions SELECT * FROM src.sessions WHERE $WHERE;
DETACH src;
SQL
echo

# Per-turn change review (undo/redo) for the sessions just moved. Keyed by the same session id.
moved=$(sqlite3 "file:$HUB_DB?mode=ro" "SELECT id FROM sessions;" | grep -Fxf <(sqlite3 "file:$UPSTREAM_DB?mode=ro" "SELECT id FROM sessions WHERE $WHERE;") || true)
for sid in $moved; do
  src="$SUPPORT/$UPSTREAM_IDENTIFIER/checkpoints/$sid"
  dst="$SUPPORT/$HUB_IDENTIFIER/checkpoints/$sid"
  if [ -d "$src" ] && [ ! -d "$dst" ]; then
    cp -R "$src" "$dst" && echo "  restored change review for ${sid:0:8}"
  fi
done
echo

echo "Verify:"
sqlite3 "file:$HUB_DB?mode=ro" "PRAGMA integrity_check;"
sqlite3 -header -column "file:$HUB_DB?mode=ro" \
  "SELECT substr(id,1,8) AS id, datetime(updated_at/1000,'unixepoch','localtime') AS updated,
          length(blocks_json) AS bytes, substr(title,1,52) AS title
     FROM sessions ORDER BY updated_at DESC;"
echo
echo "Done. The conversations appear under their project (they are grouped by working folder)."
