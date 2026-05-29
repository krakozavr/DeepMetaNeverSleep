// =============================================================================
// FEATURE: Restore batch list scroll position (v1.2.x)
//
// PROBLEM: On /contribute/esp/batches, clicking a batch row navigates away and
// pressing "<" returns with the scroll reset to the top.
//
// ROOT CAUSE: Next.js App Router navigates via history.pushState and re-mounts /
// re-renders the list asynchronously (again once data finishes loading), each
// time resetting the scrollable container's scrollTop to 0.
//
// FIX: Save scrollTop when leaving /batches; on return keep re-applying the
// saved value across animation frames until it sticks AND keep watching past the
// first settle so a late re-render/remount can't silently reset us back to 0.
//
// This build also (a) locates the scroll container by walking up from the list
// table to its nearest scrollable ancestor — robust against class-name churn and
// "wrong element" mistakes — and (b) logs URL transitions + container details to
// make any remaining misbehavior diagnosable from the console.
//
// MUST run in the page MAIN world (manifest.json "world": "MAIN") so the
// history.pushState override sits in the same JS context Next.js navigates from.
// =============================================================================

(function () {
  'use strict';

  const LOG = '[DeepMeta Never Sleep][ScrollRestore]';
  const STORAGE_KEY = 'deepmeta_batches_scrollTop';
  const CONTAINER_SEL = 'div.relative.flex.flex-1.flex-col.overflow-y-auto';
  const BATCHES_PATH = '/contribute/esp/batches';

  const MAX_RESTORE_MS = 4000; // keep watching this long for late remounts
  const SETTLE_FRAMES = 6;     // frames the value must hold on its own (~100ms)
  const TOLERANCE_PX = 2;

  // Bumping this cancels any in-flight restore loop.
  let restoreGeneration = 0;

  // Find the actual scrollable element by walking up from the list table to its
  // nearest scrollable ancestor. Falls back to the historical class selector.
  function findScrollableAncestorOfTable() {
    const table = document.querySelector('main table') || document.querySelector('table');
    if (!table) return null;
    let el = table.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 4) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  function getContainer() {
    return findScrollableAncestorOfTable() || document.querySelector(CONTAINER_SEL);
  }

  function describe(el) {
    if (!el) return 'null';
    const cls = (typeof el.className === 'string' && el.className.trim())
      ? '.' + el.className.trim().split(/\s+/).slice(0, 4).join('.')
      : '';
    return `${el.tagName.toLowerCase()}${cls} [top=${Math.round(el.scrollTop)} scrollH=${el.scrollHeight} clientH=${el.clientHeight}]`;
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

  function restoreScrollWhenReady() {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved === null) return;

    const scrollTo = parseInt(saved, 10);
    sessionStorage.removeItem(STORAGE_KEY);
    if (!Number.isFinite(scrollTo) || scrollTo <= 0) return;

    const myGen = ++restoreGeneration;
    const start = performance.now();
    let settled = 0;
    let announced = false;
    let everApplied = false;
    let reCorrectionsAfterSettle = 0;

    console.log(`${LOG} Restoring scrollTop to ${scrollTo}px`);

    // Stop fighting the user if they scroll themselves.
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
            if (++settled >= SETTLE_FRAMES && !announced) {
              announced = true;
              console.log(`${LOG} Settled at ${scrollTo}px (${Math.round(now - start)}ms) on ${describe(container)} — keep watching for late remount`);
            }
          } else {
            // Something moved/reset it. If this happens AFTER we already settled,
            // it's the late Next.js re-render/remount — the real culprit.
            if (announced) reCorrectionsAfterSettle++;
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
        console.log(`${LOG} Done. applied=${everApplied} reCorrectionsAfterSettle=${reCorrectionsAfterSettle} final=${describe(getContainer())} target=${scrollTo}px`);
      }
    }

    requestAnimationFrame(tick);
  }

  const origPushState = history.pushState.bind(history);
  history.pushState = function (state, title, url) {
    const newUrl = String(url);
    const from = location.pathname + location.search;
    let to = newUrl;
    try {
      const u = new URL(newUrl, location.origin);
      to = u.pathname + u.search;
    } catch { /* keep raw */ }
    console.log(`${LOG} pushState: "${from}" -> "${to}"`);

    // Leaving the batches page → save current scroll, cancel any running restore.
    if (location.pathname === BATCHES_PATH && !isBatchesPath(newUrl)) {
      cancelRestore();
      const container = getContainer();
      const selectorMatches = document.querySelectorAll(CONTAINER_SEL).length;
      if (container && container.scrollTop > 0) {
        sessionStorage.setItem(STORAGE_KEY, Math.round(container.scrollTop));
        console.log(`${LOG} Saved ${Math.round(container.scrollTop)}px from ${describe(container)} (selectorMatches=${selectorMatches})`);
      } else {
        console.log(`${LOG} Nothing to save (container=${describe(container)}, selectorMatches=${selectorMatches})`);
      }
    }

    origPushState(state, title, url);

    if (isBatchesPath(newUrl)) {
      restoreScrollWhenReady();
    }
  };

  // Belt-and-suspenders for a real browser back/forward gesture.
  window.addEventListener('popstate', () => {
    if (location.pathname === BATCHES_PATH) {
      restoreScrollWhenReady();
    }
  });

  console.log(`${LOG} Scroll restore listener active (MAIN world)`);
})();
