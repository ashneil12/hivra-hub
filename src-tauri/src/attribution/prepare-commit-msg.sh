#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Hivra WP-86 prepare-commit-msg.
# Stamps Hivra-Chat and Hivra-Task from the crew's environment, then runs the
# repository's own hook. It does not read or write git config.
# Design: HumanLayer packages/git-attribution (Apache-2.0).
# The upstream tree was not in the local sources checkout, so this is a rewrite.

set -u

msg=${1-}
if [ -z "$msg" ] || [ ! -f "$msg" ]; then
  exit 0
fi

# A trailer id is one token. A newline, a carriage return, or any other
# character outside the set is rejected. The environment is untrusted.
clean_id() {
  raw=$1
  stripped=$(printf '%s' "$raw" | tr -d '\r\n')
  if [ "$stripped" != "$raw" ]; then
    printf '%s' ""
    return
  fi
  case "$stripped" in
    *[!A-Za-z0-9._:/-]*|"")
      printf '%s' ""
      return
      ;;
  esac
  if [ "${#stripped}" -gt 200 ]; then
    printf '%s' ""
    return
  fi
  printf '%s' "$stripped"
}

chat=$(clean_id "${HIVRA_CHAT-}")
task=$(clean_id "${HIVRA_TASK-}")

need_chat=0
need_task=0
if [ -n "$chat" ] && ! grep -q '^Hivra-Chat:[ \t]' "$msg"; then
  need_chat=1
fi
if [ -n "$task" ] && ! grep -q '^Hivra-Task:[ \t]' "$msg"; then
  need_task=1
fi

if [ "$need_chat" -eq 1 ] || [ "$need_task" -eq 1 ]; then
  tmp="$msg.hivra.$$"
  # A blank line splits a trailer block. The two Hivra lines stay together,
  # and they join a trailer block that is already at the end.
  if ! awk \
    -v add_chat="$need_chat" \
    -v add_task="$need_task" \
    -v chat="$chat" \
    -v task="$task" \
    '
      { lines[++n] = $0 }
      END {
        while (n > 0 && lines[n] == "") n--
        add_blank = (n > 0 && lines[n] !~ /^[A-Za-z0-9-]+:[ \t]/)
        for (i = 1; i <= n; i++) print lines[i]
        if (add_blank) print ""
        if (add_chat == 1) print "Hivra-Chat: " chat
        if (add_task == 1) print "Hivra-Task: " task
      }
    ' "$msg" > "$tmp"
  then
    rm -f "$tmp"
    exit 1
  fi
  if ! mv "$tmp" "$msg"; then
    rm -f "$tmp"
    exit 1
  fi
fi

# A worktree keeps its hooks in the common git dir, not in the worktree git dir.
# Git does not always export GIT_DIR into a hooksPath hook, so ask the
# repository when neither variable points at an executable hook.
repo_hook=""
for dir in "${GIT_COMMON_DIR-}" "${GIT_DIR-}"; do
  if [ -z "$dir" ]; then
    continue
  fi
  candidate="$dir/hooks/prepare-commit-msg"
  # Git runs a hook only when it is a file and executable. Samples are not hooks.
  if [ -f "$candidate" ] && [ -x "$candidate" ]; then
    repo_hook=$candidate
    break
  fi
done
if [ -z "$repo_hook" ]; then
  dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || git rev-parse --git-common-dir 2>/dev/null || true)
  if [ -n "$dir" ]; then
    candidate="$dir/hooks/prepare-commit-msg"
    if [ -f "$candidate" ] && [ -x "$candidate" ]; then
      repo_hook=$candidate
    fi
  fi
fi
if [ -n "$repo_hook" ]; then
  "$repo_hook" "$@"
  exit $?
fi
exit 0
