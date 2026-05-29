// =============================================================================
// FEATURE: Bring the batch you opened back into view (v1.6.x)
//
// HOW THE APP WORKS (from network logs):
//   • The batch list is server-paginated: GET /api/dm-batches?...&page=1..N
//     (25 rows/page). On return to /batches the app re-fetches every page it had
//     loaded — the full list takes ~2s to rebuild.
//   • The active-row highlight (class bg-sky-100) is driven by GET /api/preference
//     and lands ~1-2s after return, so watching it right away is racy.
//   • Each row's thumbnail is served from
//         thumbs-deepmeta.creativ.zone/<batchId-without-dashes>/...
//     so a row can be matched to a batchId deterministically via its <img>.
//
// STRATEGY: we know the batchId we navigated into (from the URL). On return:
//   1. Primary — find that batch's row by its thumbnail and scrollIntoView it.
//      Deterministic and independent of the highlight race.
//   2. Fallback (batch has no UUID thumbnail, e.g. S3-hosted) — wait until the
//      app's highlight has *stabilized*, then reveal that row. We never jump to
//      an instantaneous highlight, which could still be the stale previous one.
//   3. If neither a row nor any highlight is present after a grace period, page
//      down to trigger lazy pagination, then retry.
//
// We touch nothing else: no History API, no focus, no setting the highlight —
// the app paints the active row on its own.
//
// MUST run in the page MAIN world (manifest.json "world": "MAIN").
// =============================================================================

(function () {
  'use strict';

  const LOG = '[DeepMeta Never Sleep][ScrollRestore]';
  const BATCHES_PATH = '/contribute/esp/batches';

  const MAX_MS = 8000;
  const SETTLE_FRAMES = 5;        // frames the row must stay centered before we stop
  const HIGHLIGHT_STABLE_MS = 500; // fallback: highlight must hold this long
  const POLL_MS = 150;
  const GRACE_MS = 2500;          // wait for auto-refetch before nudging
  const NUDGE_INTERVAL_MS = 250;

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

  function isCentered(row, container) {
    const c = container.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const rowCenter = r.top + r.height / 2;
    const viewCenter = c.top + c.height / 2;
    return r.top >= c.top && r.bottom <= c.bottom && Math.abs(rowCenter - viewCenter) < c.height * 0.45;
  }

  function revealOpenedBatch() {
    const batchId = lastOpenedBatchId;
    const myGen = ++generation;
    const start = performance.now();
    let settle = 0;
    let foundVia = null;

    // Highlight-stability tracking (fallback path).
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
          console.log(`${LOG} Found target row via ${via} @${t}ms`);
        }
        if (container) {
          if (isCentered(row, container)) {
            if (++settle >= SETTLE_FRAMES) {
              cleanup();
              console.log(`${LOG} Revealed target row (${t}ms, via ${foundVia})`);
              return;
            }
          } else {
            row.scrollIntoView({ block: 'center', inline: 'nearest' });
            settle = 0;
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
      generation++; // cancel any in-flight reveal
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

  console.log(`${LOG} Active-row reveal active (MAIN world, v1.6.2 — thumbnail first, stable-highlight fallback)`);
})();
