// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Source: https://github.com/coollabsio/orbit
// Original paths: apps/web/src/features/home/pages/HomePage.tsx
//   and apps/web/src/index.css (view-bar-enter)
// The upstream files have no file-level copyright line. See src/features/tasks/vendor/LICENSE.
//
// HomePage.tsx imports Orbit data hooks and shows counters, status icons and view-all
// links that WP-73 forbids, so the column measurements and the view-bar-enter timing
// are copied here and the screen is restyled. The entrance is not in HomePage.tsx
// any more; it is the view-bar-enter keyframes (180ms, the same ease, a 4px rise).

/** The home column width, from HomePage's max-w-[960px]. */
export const HOME_MAX_WIDTH = 960;

/** Most rows a home list shows. Orbit's CARD_LIMIT. */
export const HOME_CARD_LIMIT = 7;

/** view-bar-enter: 180ms on the strong ease-out. */
export const HOME_ENTER_MS = 180;

/** view-bar-enter's ease. */
export const HOME_ENTER_EASE = "cubic-bezier(0.23, 1, 0.32, 1)";

/** view-bar-enter rises 4px. */
export const HOME_ENTER_RISE_PX = 4;

/**
 * Orbit's feature notes ask for a restrained staggered entrance. HomePage.tsx no longer
 * has one, so each section waits this long after the one above it.
 */
export const HOME_STAGGER_MS = 40;
