// =============================================================================
// FEATURE: Restore batch list scroll position (v1.2.x)
//
// PROBLEM: On the batches list page (/contribute/esp/batches), clicking a batch
// row navigates to /contribute/esp/uploads?batchId=UUID. Pressing the "<" back
// button returns to /contribute/esp/batches but resets the scroll to the top,
// forcing the user to manually scroll down to find their batch again.
//
// ROOT CAUSE: The site is a Next.js App Router SPA. Both the row click AND the
// back button use history.pushState (not a real browser popstate/back). Next.js
// re-mounts the page component and then RE-RENDERS again once list data finishes
// loading, resetting the scrollable container's scrollTop to 0 each time.
//
// FIX: Intercept history.pushState to save scrollTop when leaving /batches, and
// on return keep re-applying the saved scrollTop across animation frames until
// it sticks (survives the late data-driven re-render) instead of setting it once.
//
// IMPORTANT: This script MUST run in the page's MAIN world (see manifest.json,
// "world": "MAIN"). history.pushState is called by Next.js page code, so our
// override has to live in the same JS context. An ISOLATED-world content script
// overrides only its own copy of history.pushState and never fires.
// =============================================================================

(function () {
  'use strict';

  const LOG = '[DeepMeta Never Sleep][ScrollRestore]';
  const STORAGE_KEY = 'deepmeta_batches_scrollTop';
  const CONTAINER_SEL = 'div.relative.flex.flex-1.flex-col.overflow-y-auto';
  const BATCHES_PATH = '/contribute/esp/batches';

  // Tuning knobs
  const MAX_RESTORE_MS = 5000; // give up after this long
  const SETTLE_FRAMES = 6;     // frames the value must hold on its own (~100ms)
  const TOLERANCE_PX = 2;      // sub-pixel / rounding slack

  // Monotonic token: bumping it cancels any in-flight restore loop.
  let restoreGeneration = 0;

  function getContainer() {
    return document.querySelector(CONTAINER_SEL);
  }

  function isBatchesPath(url) {
    try {
      return new URL(url, location.origin).pathname === BATCHES_PATH;
    } catch {
      return false;
    }
  }

  function cancelRestore() {
    restoreGeneration++;
  }

  // Keep re-applying the saved scrollTop until it "settles": the list must be
  // tall enough to actually hold the target, and the value must survive on its
  // own for SETTLE_FRAMES consecutive frames (i.e. Next.js stopped resetting it).
  // Aborts early if the user starts scrolling themselves.
  function restoreScrollWhenReady() {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved === null) return;

    const scrollTo = parseInt(saved, 10);
    sessionStorage.removeItem(STORAGE_KEY);
    if (!Number.isFinite(scrollTo) || scrollTo <= 0) return;

    const myGen = ++restoreGeneration;
    const start = performance.now();
    let settled = 0;
    let everApplied = false;

    console.log(`${LOG} Navigation to batches detected — restoring scrollTop to ${scrollTo}px`);

    // If the user interacts to scroll, stop fighting them.
    let userInterrupted = false;
    const onUserScroll = () => { userInterrupted = true; };
    const opts = { passive: true, capture: true };
    window.addEventListener('wheel', onUserScroll, opts);
    window.addEventListener('touchstart', onUserScroll, opts);
    window.addEventListener('keydown', onUserScroll, opts);

    function cleanup() {
      window.removeEventListener('wheel', onUserScroll, opts);
      window.removeEventListener('touchstart', onUserScroll, opts);
      window.removeEventListener('keydown', onUserScroll, opts);
    }

    function tick(now) {
      // Superseded by a newer navigation/restore, or user took over.
      if (myGen !== restoreGeneration || userInterrupted) {
        cleanup();
        return;
      }

      const container = getContainer();
      if (container) {
        const maxScroll = container.scrollHeight - container.clientHeight;
        // Only act once the list is tall enough to reach the target, otherwise
        // the browser clamps scrollTop ("remembers but doesn't scroll").
        if (maxScroll >= scrollTo - TOLERANCE_PX) {
          if (Math.abs(container.scrollTop - scrollTo) <= TOLERANCE_PX) {
            // Already at target before we touched it this frame → nothing is
            // fighting us. Count toward "settled".
            if (++settled >= SETTLE_FRAMES) {
              cleanup();
              console.log(`${LOG} Scroll settled at ${scrollTo}px (${Math.round(now - start)}ms)`);
              return;
            }
          } else {
            // A (re-)render moved it — re-apply and restart the settle count.
            container.scrollTop = scrollTo;
            settled = 0;
            everApplied = true;
          }
        }
      }

      if (now - start < MAX_RESTORE_MS) {
        requestAnimationFrame(tick);
      } else {
        cleanup();
        console.warn(`${LOG} Gave up restoring to ${scrollTo}px after ${MAX_RESTORE_MS}ms (applied=${everApplied})`);
      }
    }

    requestAnimationFrame(tick);
  }

  // Intercept pushState — the single hook that covers both directions:
  //   • Row click  : current path = /batches, new URL = /uploads?batchId=...
  //   • Back button: current path = /uploads,  new URL = /batches
  const origPushState = history.pushState.bind(history);
  history.pushState = function (state, title, url) {
    const newUrl = String(url);

    // Leaving the batches page → save current scroll position and cancel any
    // restore loop that might still be running.
    if (location.pathname === BATCHES_PATH && !isBatchesPath(newUrl)) {
      cancelRestore();
      const container = getContainer();
      if (container && container.scrollTop > 0) {
        sessionStorage.setItem(STORAGE_KEY, Math.round(container.scrollTop));
        console.log(`${LOG} Leaving batches — saved scrollTop: ${Math.round(container.scrollTop)}px`);
      }
    }

    origPushState(state, title, url);

    // Arriving at the batches page → restore scroll
    if (isBatchesPath(newUrl)) {
      restoreScrollWhenReady();
    }
  };

  // Belt-and-suspenders: also handle a real browser back/forward gesture,
  // in case the user uses the browser's own Back button instead of the "<" button.
  window.addEventListener('popstate', () => {
    if (location.pathname === BATCHES_PATH) {
      restoreScrollWhenReady();
    }
  });

  console.log(`${LOG} Scroll restore listener active (MAIN world)`);
})();
