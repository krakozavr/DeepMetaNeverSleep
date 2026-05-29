// =============================================================================
// FEATURE: Restore batch list scroll position + active-row focus (v1.2.x)
//
// PROBLEM: On /contribute/esp/batches, clicking a batch row navigates away.
// Pressing "<" returns with (a) the scroll reset to the top and (b) the row
// "focus"/highlight lagging one navigation behind (the app highlights the
// previously-opened batch, not the one you just came back from).
//
// ROOT CAUSE: Next.js App Router navigates via history.pushState and re-mounts /
// re-renders the list asynchronously, resetting scrollTop to 0, and the app's
// own active-row state is one step stale.
//
// FIX:
//   • Scroll: save scrollTop when leaving /batches; on return re-apply it across
//     animation frames until it sticks, and keep watching past the first settle
//     so a late re-render/remount can't silently reset it to 0.
//   • Focus: remember the batchId we navigated into; on return, find that row and
//     focus it (preventScroll) so the highlight follows the batch you actually
//     opened instead of the stale one.
//
// The scroll container is located by walking up from the list table to its
// nearest scrollable ancestor (robust against class-name churn). URL transitions
// and chosen elements are logged to keep any remaining misbehavior diagnosable.
//
// MUST run in the page MAIN world (manifest.json "world": "MAIN") so the
// history.pushState override sits in the same JS context Next.js navigates from.
// =============================================================================

(function () {
  'use strict';

  const LOG = '[DeepMeta Never Sleep][ScrollRestore]';
  const SCROLL_KEY = 'deepmeta_batches_scrollTop';
  const BATCH_KEY = 'deepmeta_batches_lastBatchId';
  const CONTAINER_SEL = 'div.relative.flex.flex-1.flex-col.overflow-y-auto';
  const BATCHES_PATH = '/contribute/esp/batches';

  const MAX_RESTORE_MS = 4000; // keep watching this long for late remounts
  const SETTLE_FRAMES = 6;     // frames a value must hold on its own (~100ms)
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
    return `${el.tagName.toLowerCase()}${cls}`;
  }

  function describeScroller(el) {
    if (!el) return 'null';
    return `${describe(el)} [top=${Math.round(el.scrollTop)} scrollH=${el.scrollHeight} clientH=${el.clientHeight}]`;
  }

  function isBatchesPath(url) {
    try {
      return new URL(url, location.origin).pathname === BATCHES_PATH;
    } catch {
      return false;
    }
  }

  function extractBatchId(url) {
    try {
      return new URL(url, location.origin).searchParams.get('batchId');
    } catch {
      return null;
    }
  }

  // Locate the list row corresponding to a batchId. Rows navigate to
  // /uploads?batchId=<id>, so the row is (or contains) an anchor to that URL.
  // We return the focusable element that best represents the row.
  function findBatchRow(id) {
    if (!id) return null;
    let el = document.querySelector(`a[href*="batchId=${id}"]`);
    if (el) return el;
    el = document.querySelector(`[href*="${id}"], [data-batch-id="${id}"], [data-id="${id}"]`);
    return el || null;
  }

  function cancelRestore() {
    restoreGeneration++;
  }

  function restoreOnReturn() {
    const savedScroll = sessionStorage.getItem(SCROLL_KEY);
    const batchId = sessionStorage.getItem(BATCH_KEY);
    sessionStorage.removeItem(SCROLL_KEY);
    sessionStorage.removeItem(BATCH_KEY);

    const scrollTo = parseInt(savedScroll, 10);
    const wantScroll = Number.isFinite(scrollTo) && scrollTo > 0;
    const wantFocus = !!batchId;
    if (!wantScroll && !wantFocus) return;

    const myGen = ++restoreGeneration;
    const start = performance.now();

    console.log(`${LOG} Restoring${wantScroll ? ` scrollTop=${scrollTo}px` : ''}${wantFocus ? ` focus batchId=${batchId}` : ''}`);

    // Stop fighting the user if they interact.
    let userInterrupted = false;
    const onUserAct = () => { userInterrupted = true; };
    const opts = { passive: true, capture: true };
    const events = ['wheel', 'touchstart', 'keydown', 'mousedown'];
    events.forEach((e) => window.addEventListener(e, onUserAct, opts));
    function cleanup() {
      events.forEach((e) => window.removeEventListener(e, onUserAct, opts));
    }

    // --- scroll state ---
    let scrollSettled = 0;
    let scrollAnnounced = false;
    let scrollApplied = false;
    let reCorrectionsAfterSettle = 0;
    let scrollDone = !wantScroll;

    // --- focus state ---
    let focusSettled = 0;
    let focusDone = !wantFocus;
    let focusEverFound = false;

    function tick(now) {
      if (myGen !== restoreGeneration || userInterrupted) {
        cleanup();
        return;
      }

      // ---- scroll ----
      if (!scrollDone) {
        const container = getContainer();
        if (container) {
          const maxScroll = container.scrollHeight - container.clientHeight;
          if (maxScroll >= scrollTo - TOLERANCE_PX) {
            if (Math.abs(container.scrollTop - scrollTo) <= TOLERANCE_PX) {
              if (++scrollSettled >= SETTLE_FRAMES && !scrollAnnounced) {
                scrollAnnounced = true;
                console.log(`${LOG} Scroll settled at ${scrollTo}px (${Math.round(now - start)}ms) on ${describeScroller(container)} — keep watching for late remount`);
              }
            } else {
              if (scrollAnnounced) reCorrectionsAfterSettle++;
              container.scrollTop = scrollTo;
              scrollSettled = 0;
              scrollApplied = true;
            }
          }
        }
      }

      // ---- focus ----
      if (!focusDone) {
        const row = findBatchRow(batchId);
        if (row) {
          if (!focusEverFound) {
            focusEverFound = true;
            console.log(`${LOG} Found batch row to focus: ${describe(row)} (href=${row.getAttribute && row.getAttribute('href')})`);
          }
          if (document.activeElement === row) {
            if (++focusSettled >= SETTLE_FRAMES) {
              focusDone = true;
              console.log(`${LOG} Focus settled on batch row ${batchId} (${Math.round(now - start)}ms)`);
            }
          } else {
            try { row.focus({ preventScroll: true }); } catch { /* ignore */ }
            focusSettled = 0;
          }
        }
      }

      if (now - start < MAX_RESTORE_MS && (!scrollDone || !focusDone)) {
        requestAnimationFrame(tick);
      } else {
        cleanup();
        const c = getContainer();
        console.log(`${LOG} Done. scroll{applied=${scrollApplied} reCorrectionsAfterSettle=${reCorrectionsAfterSettle} final=${describeScroller(c)} target=${wantScroll ? scrollTo + 'px' : 'n/a'}} focus{wanted=${wantFocus} found=${focusEverFound} active=${document.activeElement ? describe(document.activeElement) : 'null'}}`);
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

    // Leaving the batches page → save scroll + the batchId we're opening,
    // and cancel any running restore.
    if (location.pathname === BATCHES_PATH && !isBatchesPath(newUrl)) {
      cancelRestore();
      const container = getContainer();
      const selectorMatches = document.querySelectorAll(CONTAINER_SEL).length;
      if (container && container.scrollTop > 0) {
        sessionStorage.setItem(SCROLL_KEY, Math.round(container.scrollTop));
        console.log(`${LOG} Saved ${Math.round(container.scrollTop)}px from ${describeScroller(container)} (selectorMatches=${selectorMatches})`);
      } else {
        console.log(`${LOG} Nothing to save (container=${describeScroller(container)}, selectorMatches=${selectorMatches})`);
      }
      const batchId = extractBatchId(newUrl);
      if (batchId) {
        sessionStorage.setItem(BATCH_KEY, batchId);
        console.log(`${LOG} Remembered opened batchId=${batchId}`);
      }
    }

    origPushState(state, title, url);

    if (isBatchesPath(newUrl)) {
      restoreOnReturn();
    }
  };

  // Belt-and-suspenders for a real browser back/forward gesture.
  window.addEventListener('popstate', () => {
    if (location.pathname === BATCHES_PATH) {
      restoreOnReturn();
    }
  });

  console.log(`${LOG} Scroll restore listener active (MAIN world)`);
})();
