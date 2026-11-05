// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Source: https://github.com/coollabsio/orbit
// Original path: apps/web/src/features/views/useCollapsedGroups.ts
// The upstream file has no file-level copyright line. See ../LICENSE.

import { useState } from 'react'

export function readIds(storageKey: string): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(storageKey) ?? '[]')
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

/** The next collapsed set. Pulled out so the rule can be tested without a React renderer. */
export function toggledIds(collapsed: readonly string[], id: string): string[] {
  return collapsed.includes(id) ? collapsed.filter((item) => item !== id) : [...collapsed, id]
}

export function writeIds(storageKey: string, ids: readonly string[]): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(ids))
  } catch {
    // storage full or blocked: the group still toggles for this visit
  }
}

/**
 * Collapsed group ids for one page, remembered in localStorage (deliberately not part of the view state).
 * The caller keys the component by page, so a new `storageKey` always arrives with a fresh mount.
 */
export function useCollapsedGroups(storageKey: string): [string[], (id: string) => void] {
  const [collapsed, setCollapsed] = useState<string[]>(() => readIds(storageKey))
  const toggle = (id: string) => {
    const next = toggledIds(collapsed, id)
    setCollapsed(next)
    writeIds(storageKey, next)
  }
  return [collapsed, toggle]
}
