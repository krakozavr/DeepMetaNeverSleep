// =============================================================================
// FEATURE: Bring the batch you opened back into view + keep it highlighted (v1.7)
//
// HOW THE APP WORKS (from network logs):
//   • The batch list is server-paginated (GET /api/dm-batches?...&page=1..N,
//     25/page) and re-fetched on return (~2s to rebuild).
//   • The active-row highlight (class bg-sky-100 / dark:bg-sky-900) is driven by
//     GET /api/preference. It lands ~1-2s after return AND can latch onto the
//     stale previous folder and stay wrong (confirmed in a clean browser at
//     speed) — so we can't just wait it out.
//   • Each row's thumbnail is served from
//         thumbs-deepmeta.creativ.zone/<batchId-without-dashes>/...
//     so a row maps to a batchId deterministically via its <img>.
//
// WHAT WE DO on return to /batches:
//   1. Find the opened batch's row by its thumbnail and scroll it into view —
//      but only scroll when it's actually off-screen, so we don't disrupt the
//      app's lazy thumbnail loading (repeated programmatic scrolls were making
//      surrounding elements fail to load).
//   2. Assert the active highlight on that row ourselves for a short window
//      (~2.5s), covering the app's laggy/stuck /api/preference render. After
//      that the list is static, so our class simply stays.
//   3. Fallbacks: if the batch has no UUID thumbnail (S3-hosted), wait for the
//      app's highlight to stabilize instead; if nothing renders, page down to
//      trigger pagination.
//
// We never touch the History API or focus. MUST run in the page MAIN world.
// =============================================================================

(function () {
  'use strict';

  const LOG = '[DeepMeta Never Sleep][ScrollRestore]';
  const BATCHES_PATH = '/contribute/esp/batches';

  const MAX_MS = 8000;             // overall budget to find the row
  const HOLD_MS = 2500;            // keep our highlight asserted this long
  const SETTLE_FRAMES = 5;         // fallback path: frames the row must stay visible
  const HIGHLIGHT_STABLE_MS = 500; // fallback: highlight must hold this long
  const POLL_MS = 150;
  const GRACE_MS = 2500;           // wait for auto-refetch before nudging
  const NUDGE_INTERVAL_MS = 250;
  const HL_CLASSES = ['bg-sky-100', 'dark:bg-sky-900']; // app's active-row marker

  let generation = 0;
  let lastPath = location.pathname;
  let lastOpenedBatchId = null;

  function getScrollContainer() {
    const table = document.querySelector('main table') || document.querySelector('table');
    let el = table ? table.parentElement : null;
    while (el && el !== document.body && el !== document.documentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 4) {
        return el;
      }
      el = el.parentElement;
    }
    return document.querySelector('div.relative.flex.flex-1.flex-col.overflow-y-auto');
  }

  function rowOf(el) {
    return el.closest('tr') || el.closest('[role="row"]') || el.closest('li') || el;
  }

  // Primary: the row whose thumbnail belongs to the opened batch.
  function findRowByBatchId(batchId) {
    if (!batchId) return null;
    const key = batchId.replace(/-/g, '');
    const scope = document.querySelector('main') || document;
    const img = scope.querySelector(`img[src*="${key}"]`);
    return img ? rowOf(img) : null;
  }

  // Fallback: the row the app marked active (sky background).
  function findHighlightRow() {
    const scope = document.querySelector('main') || document;
    return scope.querySelector('tbody tr[class*="bg-sky-"]');
  }

  function rowLabel(row) {
    if (!row) return null;
    return (row.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50) || '(row)';
  }

  function isFullyVisible(row, container) {
    const c = container.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    return r.top >= c.top - 2 && r.bottom <= c.bottom + 2;
  }

  // Mirror the app's active-row marker onto our row and clear it from any stale
  // row, so the opened folder looks active immediately. React may overwrite this
  // when /api/preference resolves; we re-apply each frame during the hold window.
  function paintHighlight(target) {
    const scope = document.querySelector('main') || document;
    scope.querySelectorAll('tbody tr.bg-sky-100').forEach((tr) => {
      if (tr !== target) HL_CLASSES.forEach((c) => tr.classList.remove(c));
    });
    HL_CLASSES.forEach((c) => target.classList.add(c));
  }

  function revealOpenedBatch() {
    const batchId = lastOpenedBatchId;
    const myGen = ++generation;
    const start = performance.now();
    let foundVia = null;
    let foundAt = 0;
    let settle = 0;

    // Highlight-stability tracking (S3 fallback path).
    let hlLabel = null;
    let hlStableSince = 0;

    // Nudge state (only when nothing is on screen yet).
    let lastNudgeAt = 0;
    let lastNudgeHeight = 0;
    let bottomStreak = 0;

    let userInterrupted = false;
    const onUserAct = () => { userInterrupted = true; };
    const opts = { passive: true, capture: true };
    const events = ['wheel', 'touchstart', 'keydown', 'mousedown'];
    events.forEach((e) => window.addEventListener(e, onUserAct, opts));
    const cleanup = () => events.forEach((e) => window.removeEventListener(e, onUserAct, opts));

    console.log(`${LOG} Return to batches — will reveal opened batchId=${batchId || '(unknown)'}`);

    function tick(now) {
      if (myGen !== generation || userInterrupted) {
        cleanup();
        return;
      }
      const t = Math.round(now - start);

      // 1) Primary: deterministic thumbnail match.
      let row = findRowByBatchId(batchId);
      let via = 'thumbnail';

      // 2) Fallback: a *stable* highlight (never an instantaneous, possibly
      //    stale one).
      const hl = row ? null : findHighlightRow();
      if (!row) {
        const label = rowLabel(hl);
        if (label !== hlLabel) { hlLabel = label; hlStableSince = now; }
        if (hl && now - hlStableSince >= HIGHLIGHT_STABLE_MS) {
          row = hl;
          via = 'highlight(stable)';
        }
      }

      if (row && row.getClientRects().length > 0) {
        const container = getScrollContainer();
        if (!foundVia) {
          foundVia = via;
          foundAt = now;
          console.log(`${LOG} Found target row via ${via} @${t}ms`);
        }

        // Scroll ONLY when the row is off-screen — minimize programmatic scrolls
        // so the app's lazy thumbnail loading isn't disrupted.
        if (container && !isFullyVisible(row, container)) {
          row.scrollIntoView({ block: 'center', inline: 'nearest' });
        }

        if (foundVia === 'thumbnail') {
          // Assert the active highlight ourselves through the laggy preference
          // render, then let go (the list is static afterwards).
          paintHighlight(row);
          if (now - foundAt >= HOLD_MS) {
            cleanup();
            console.log(`${LOG} Revealed + held highlight (${t}ms)`);
            return;
          }
        } else if (container && isFullyVisible(row, container)) {
          // S3 fallback: highlight is already the app's (stable) one — don't paint.
          if (++settle >= SETTLE_FRAMES) {
            cleanup();
            console.log(`${LOG} Revealed (${t}ms, via ${foundVia})`);
            return;
          }
        }
      } else if (!row && !hl && now - start >= GRACE_MS && now - lastNudgeAt >= NUDGE_INTERVAL_MS) {
        // Nothing on screen yet — page down to trigger lazy pagination.
        const container = getScrollContainer();
        if (container) {
          if (lastNudgeAt === 0) {
            console.log(`${LOG} Nothing yet after ${t}ms — nudging to load pages`);
          }
          const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 2;
          if (atBottom && container.scrollHeight <= lastNudgeHeight + 2) {
            if (++bottomStreak >= 3) {
              cleanup();
              console.warn(`${LOG} Gave up: reached end of list, row not found (batchId=${batchId || 'unknown'})`);
              return;
            }
          } else {
            bottomStreak = 0;
          }
          lastNudgeHeight = container.scrollHeight;
          container.scrollTop = Math.min(
            container.scrollTop + container.clientHeight * 0.85,
            container.scrollHeight
          );
          lastNudgeAt = now;
        }
      }

      if (now - start < MAX_MS) {
        requestAnimationFrame(tick);
      } else {
        cleanup();
        console.warn(`${LOG} Gave up after ${t}ms (batchId=${batchId || 'unknown'}, foundVia=${foundVia || 'none'})`);
      }
    }

    requestAnimationFrame(tick);
  }

  function onPathChange(prev, next) {
    if (prev === BATCHES_PATH && next !== BATCHES_PATH) {
      generation++; // cancel any in-flight reveal / highlight hold
      try {
        const id = new URL(location.href).searchParams.get('batchId');
        if (id) lastOpenedBatchId = id;
      } catch { /* ignore */ }
    } else if (next === BATCHES_PATH && prev !== BATCHES_PATH) {
      revealOpenedBatch();
    }
  }

  // Detect navigation passively — never touch the History API.
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

  console.log(`${LOG} Active-row reveal active (MAIN world, v1.7 — reveal by thumbnail + assert highlight ~2.5s)`);
})();
