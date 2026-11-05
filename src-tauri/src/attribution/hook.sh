#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Hivra WP-86. One script for every git hook. Git is pointed at this folder,
# which would otherwise hide the repository's own hooks, so each name runs
# that hook with the same arguments and stdin and passes on its exit code.
# prepare-commit-msg runs the repository's hook first, then stamps
# Hivra-Chat and Hivra-Task. The script reads core.hooksPath once, after
# hiding the crew's GIT_CONFIG_* entries, and never writes git config.
# Design: HumanLayer packages/git-attribution (Apache-2.0).

# set -u comes after the forward. macOS /bin/sh is bash 3.2, and an empty
# "$@" under set -u aborts the shell before a hook with no arguments runs.

name=$(printf '%s' "$0" | tr '\\' '/')
name=${name##*/}

# Prints core.hooksPath after hiding the crew's GIT_CONFIG_* entries.
# A function, not an inline substitution: a case arm's ")" would close "$( )".
# The caller runs it in a subshell, so the unset does not leak.
hidden_hooks_path() {
  n=0
  raw=${GIT_CONFIG_COUNT-}
  case "$raw" in
    [0-9]|[0-9][0-9]|[0-9][0-9][0-9]) n=$raw ;;
  esac
  if [ "$n" -gt 256 ]; then
    n=256
  fi
  i=0
  while [ "$i" -lt "$n" ]; do
    unset "GIT_CONFIG_KEY_$i"
    unset "GIT_CONFIG_VALUE_$i"
    i=$((i + 1))
  done
  unset GIT_CONFIG_COUNT
  git config --get core.hooksPath 2>/dev/null || true
}

# The crew's GIT_CONFIG_* points core.hooksPath at this folder. Drop those
# variables for this query only, so a husky-style path in local, global or
# system config is what git reports. Anything else falls back to the common
# git dir, which is where a worktree keeps its hooks.
real_hooks() {
  found=$(hidden_hooks_path)
  found=$(printf '%s\n' "$found" | sed -n '1s/\r$//;s/^[[:space:]]*//;s/[[:space:]]*$//p')
  case "$found" in
    "~")
      found=${HOME-}
      ;;
    "~/"*)
      found="${HOME-}/${found#~/}"
      ;;
  esac
  if [ -n "$found" ]; then
    printf '%s' "$found"
    return 0
  fi
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || git rev-parse --git-common-dir 2>/dev/null || true)
  common=$(printf '%s\n' "$common" | sed -n '1s/\r$//;s/^[[:space:]]*//;s/[[:space:]]*$//p')
  if [ -n "$common" ]; then
    printf '%s/hooks' "$common"
  fi
}

# A resolved path that is this file would run us again.
is_this_script() {
  cand=$(printf '%s' "$1" | tr '\\' '/')
  ours=$(printf '%s' "$0" | tr '\\' '/')
  if [ "$cand" = "$ours" ]; then
    return 0
  fi
  if [ "${cand##*/}" = "${ours##*/}" ] && [ "${cand%/*}" = "${ours%/*}" ]; then
    return 0
  fi
  return 1
}

dir=$(real_hooks || true)
if [ -n "${dir-}" ]; then
  hook="$dir/$name"
  if ! is_this_script "$hook" && [ -f "$hook" ] && [ -x "$hook" ]; then
    if [ "$name" = "prepare-commit-msg" ]; then
      "$hook" "$@"
      status=$?
      if [ "$status" -ne 0 ]; then
        exit "$status"
      fi
    else
      exec "$hook" "$@"
      exit $?
    fi
  fi
fi

if [ "$name" != "prepare-commit-msg" ]; then
  exit 0
fi

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
exit 0
