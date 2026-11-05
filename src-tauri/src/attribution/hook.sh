#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Hivra WP-86. prepare-commit-msg. The app writes this file when a crew starts,
# with the repository's own hook path baked in on the real_hook line below.
# At hook time the script runs no git: it runs that hook, then stamps
# Hivra-Chat and Hivra-Task. The app resolves the path once per run, so a hook
# added or moved during a run is picked up on the next run.
# Design: HumanLayer packages/git-attribution (Apache-2.0).

real_hook=''
# The test for whether the repository's own hook can run. On Unix the
# executable bit decides. Windows has no executable bit, so there an existing
# file counts, as it does for git itself. The app writes this line for its
# platform when it installs the hook.
hook_test='-x'

if [ -n "$real_hook" ] && [ "$hook_test" "$real_hook" ]; then
  "$real_hook" "$@"
  status=$?
  if [ "$status" -ne 0 ]; then
    exit "$status"
  fi
fi

msg=${1-}
if [ -z "$msg" ] || [ ! -f "$msg" ]; then
  exit 0
fi

# A trailer id is one token. A newline, a carriage return, or any other
# character outside the set is rejected. The environment is untrusted.
clean_id() {
  case "$1" in
    ""|*[!A-Za-z0-9._:/-]*)
      printf '%s' ""
      return
      ;;
  esac
  if [ "${#1}" -gt 200 ]; then
    printf '%s' ""
    return
  fi
  printf '%s' "$1"
}

chat=$(clean_id "${HIVRA_CHAT-}")
task=$(clean_id "${HIVRA_TASK-}")

tmp="$msg.hivra.$$"
# One pass over the message: see whether a trailer is already there, and write
# the message back with the two Hivra lines at the end. A blank line splits a
# trailer block, so the Hivra lines stay together and join a block that is
# already at the end. Exit 3 means there was nothing to add.
awk \
  -v chat="$chat" \
  -v task="$task" \
  '
    { lines[++n] = $0
      if ($0 ~ /^Hivra-Chat:[ \t]/) has_chat = 1
      if ($0 ~ /^Hivra-Task:[ \t]/) has_task = 1
    }
    END {
      add_chat = (chat != "" && !has_chat)
      add_task = (task != "" && !has_task)
      if (!add_chat && !add_task) exit 3
      while (n > 0 && lines[n] == "") n--
      add_blank = (n > 0 && lines[n] !~ /^[A-Za-z0-9-]+:[ \t]/)
      for (i = 1; i <= n; i++) print lines[i]
      if (add_blank) print ""
      if (add_chat) print "Hivra-Chat: " chat
      if (add_task) print "Hivra-Task: " task
    }
  ' "$msg" > "$tmp"
status=$?
if [ "$status" -eq 3 ]; then
  rm -f "$tmp"
  exit 0
fi
if [ "$status" -ne 0 ]; then
  rm -f "$tmp"
  exit 1
fi
if ! mv "$tmp" "$msg"; then
  rm -f "$tmp"
  exit 1
fi
exit 0
