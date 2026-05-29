// =============================================================================
// FEATURE: Restore batch list scroll position (v1.3.x)
//
// PROBLEM: On /contribute/esp/batches, clicking a batch row navigates away and
// pressing "<" returns with the scroll reset to the top.
//
// DESIGN NOTE — why this no longer overrides history.pushState:
// Earlier builds wrapped history.pushState to detect navigation. The app keeps
// its own "active row" highlight, and that wrapping made the highlight lag one
// navigation behind (it works perfectly with the extension disabled). To avoid
// interfering with the page's router/highlight at all, this build is fully
// PASSIVE: it never touches the History API and never moves DOM focus. It only
//   1. remembers the container's scrollTop while on /batches (scroll listener),
//   2. notices path changes by polling location.pathname (+ popstate), and
//   3. re-applies the saved scrollTop on return until it sticks.
//
// The scroll container is located by walking up from the list table to its
// nearest scrollable ancestor (robust against class-name churn).
//
// MUST run in the page MAIN world (manifest.json "world": "MAIN") so it shares
// the same DOM/scroll state the app renders into.
// =============================================================================

(function () {
  'use strict';

  const LOG = '[DeepMeta Never Sleep][ScrollRestore]';
  const SCROLL_KEY = 'deepmeta_batches_scrollTop';
  const CONTAINER_SEL = 'div.relative.flex.flex-1.flex-col.overflow-y-auto';
  const BATCHES_PATH = '/contribute/esp/batches';

  const MAX_RESTORE_MS = 4000; // keep watching this long for late remounts
  const SETTLE_FRAMES = 6;     // frames the value must hold on its own (~100ms)
  const TOLERANCE_PX = 2;
  const POLL_MS = 120;         // path-change polling interval

  // Bumping this cancels any in-flight restore loop.
  let restoreGeneration = 0;
  let lastPath = location.pathname;
  let lastBatchesScrollTop = 0;

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

  function describeScroller(el) {
    if (!el) return 'null';
    const cls = (typeof el.className === 'string' && el.className.trim())
      ? '.' + el.className.trim().split(/\s+/).slice(0, 4).join('.')
      : '';
    return `${el.tagName.toLowerCase()}${cls} [top=${Math.round(el.scrollTop)} scrollH=${el.scrollHeight} clientH=${el.clientHeight}]`;
  }

  function cancelRestore() {
    restoreGeneration++;
  }

  // (1) Remember the latest scroll position while we're on the batches page.
  // 'scroll' doesn't bubble, so listen in the capture phase to catch the inner
  // scrollable container.
  window.addEventListener('scroll', () => {
    if (location.pathname !== BATCHES_PATH) return;
    const c = getContainer();
    if (c && c.scrollTop > 0) {
      lastBatchesScrollTop = Math.round(c.scrollTop);
    }
  }, { passive: true, capture: true });

  // (3) Re-apply the saved scrollTop until it sticks, and keep watching past the
  // first settle so a late re-render/remount can't silently reset it to 0.
  function restoreScroll() {
    const saved = sessionStorage.getItem(SCROLL_KEY);
    if (saved === null) return;

    const scrollTo = parseInt(saved, 10);
    sessionStorage.removeItem(SCROLL_KEY);
    if (!Number.isFinite(scrollTo) || scrollTo <= 0) return;

    const myGen = ++restoreGeneration;
    const start = performance.now();
    let settled = 0;
    let announced = false;
    let everApplied = false;
    let reCorrectionsAfterSettle = 0;

    console.log(`${LOG} Restoring scrollTop=${scrollTo}px`);

    // Stop fighting the user if they interact.
    let userInterrupted = false;
    const onUserAct = () => { userInterrupted = true; };
    const opts = { passive: true, capture: true };
    const events = ['wheel', 'touchstart', 'keydown', 'mousedown'];
    events.forEach((e) => window.addEventListener(e, onUserAct, opts));
    const cleanup = () => events.forEach((e) => window.removeEventListener(e, onUserAct, opts));

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
              console.log(`${LOG} Settled at ${scrollTo}px (${Math.round(now - start)}ms) on ${describeScroller(container)} — keep watching for late remount`);
            }
          } else {
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
        console.log(`${LOG} Done. applied=${everApplied} reCorrectionsAfterSettle=${reCorrectionsAfterSettle} final=${describeScroller(getContainer())} target=${scrollTo}px`);
      }
    }

    requestAnimationFrame(tick);
  }

  function onPathChange(prev, next) {
    console.log(`${LOG} path change: "${prev}" -> "${next}"`);

    // Leaving the batches page → persist the last scroll position, cancel any
    // running restore.
    if (prev === BATCHES_PATH && next !== BATCHES_PATH) {
      cancelRestore();
      if (lastBatchesScrollTop > 0) {
        sessionStorage.setItem(SCROLL_KEY, String(lastBatchesScrollTop));
        console.log(`${LOG} Saved ${lastBatchesScrollTop}px on leave`);
      }
    }

    // Arriving at the batches page → restore.
    if (next === BATCHES_PATH && prev !== BATCHES_PATH) {
      restoreScroll();
    }
  }

  // (2) Detect navigation without touching the History API.
  function checkPath() {
    const p = location.pathname;
    if (p !== lastPath) {
      const prev = lastPath;
      lastPath = p;
      onPathChange(prev, p);
    }
  }
  setInterval(checkPath, POLL_MS);
  window.addEventListener('popstate', checkPath);

  console.log(`${LOG} Scroll restore active (MAIN world, passive — no History API override)`);
})();
