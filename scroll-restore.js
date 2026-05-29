// =============================================================================
// FEATURE: Bring the active batch row back into view (v1.4.x)
//
// HISTORY / WHY THIS REWRITE:
// The app already keeps its own "active row" highlight, and with the extension
// DISABLED that highlight is always correct (the folder you exited from). The
// only native annoyance is that returning to /contribute/esp/batches leaves the
// scroll at the top, so you must scroll down to find that folder again.
//
// Earlier builds tried to remember and force a pixel scrollTop. That fought the
// app on two fronts — its lazy row/data loading (the list grows as you scroll)
// and its own scroll/highlight management — producing flaky, racy behavior and
// occasionally breaking lazy-loading around the clicked folder.
//
// NEW STRATEGY: don't fight. Do nothing to the History API, focus, or the
// highlight. On return to /batches, simply find the row the APP marked active
// and scroll THAT element into view once. Targeting the element (not a pixel) is
// robust to lazy loading, and reading the highlight (not setting it) can't make
// the highlight lag.
//
// MUST run in the page MAIN world (manifest.json "world": "MAIN") so it shares
// the same DOM the app renders into.
// =============================================================================

(function () {
  'use strict';

  const LOG = '[DeepMeta Never Sleep][ScrollRestore]';
  const BATCHES_PATH = '/contribute/esp/batches';

  const MAX_MS = 3000;       // give the list this long to render the active row
  const SETTLE_FRAMES = 5;   // frames the row must stay centered before we stop
  const POLL_MS = 150;       // path-change polling interval

  let generation = 0;
  let lastPath = location.pathname;

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

  function shortDesc(el) {
    if (!el) return 'null';
    const cls = (typeof el.className === 'string' && el.className.trim())
      ? '.' + el.className.trim().split(/\s+/).slice(0, 5).join('.')
      : '';
    return `${el.tagName.toLowerCase()}${cls}`;
  }

  // Find the row the app marked active, class-name agnostic where possible.
  function findActiveRow() {
    const scope = document.querySelector('main') || document;

    // 1) Semantic markers.
    let el = scope.querySelector(
      '[aria-selected="true"], [aria-current="true"], [aria-current="page"], ' +
      '[data-state="active"], [data-state="selected"], [data-active="true"], [data-selected="true"]'
    );
    if (el) return { el, via: 'aria/data' };

    // 2) Class keyword.
    el = scope.querySelector(
      'tbody tr[class*="active"], tbody tr[class*="selected"], ' +
      'li[class*="active"], li[class*="selected"], [role="row"][class*="active"], [role="row"][class*="selected"]'
    );
    if (el) return { el, via: 'class-keyword' };

    // 3) Odd-one-out: the highlighted row's class differs from all its siblings.
    const rows = Array.from(scope.querySelectorAll('tbody tr'));
    if (rows.length > 2) {
      const counts = new Map();
      rows.forEach((r) => counts.set(r.className, (counts.get(r.className) || 0) + 1));
      const unique = rows.filter((r) => counts.get(r.className) === 1);
      if (unique.length === 1) return { el: unique[0], via: 'unique-class' };
    }

    return null;
  }

  function logDiagnostics() {
    const rows = Array.from(document.querySelectorAll('tbody tr')).slice(0, 4);
    const sample = rows.map((r, i) => `  row[${i}] = ${shortDesc(r)}`).join('\n');
    const anchors = document.querySelectorAll('a[href*="batchId="]').length;
    console.warn(`${LOG} Active row not found. anchorsWithBatchId=${anchors}\n${sample}`);
  }

  function bringActiveRowIntoView() {
    const myGen = ++generation;
    const start = performance.now();
    let settled = 0;
    let announced = false;
    let everFound = false;

    let userInterrupted = false;
    const onUserAct = () => { userInterrupted = true; };
    const opts = { passive: true, capture: true };
    const events = ['wheel', 'touchstart', 'keydown', 'mousedown'];
    events.forEach((e) => window.addEventListener(e, onUserAct, opts));
    const cleanup = () => events.forEach((e) => window.removeEventListener(e, onUserAct, opts));

    console.log(`${LOG} Return to batches — looking for the active row to reveal`);

    function tick(now) {
      if (myGen !== generation || userInterrupted) {
        cleanup();
        return;
      }

      const found = findActiveRow();
      if (found && found.el.getClientRects().length > 0) {
        const row = found.el;
        const container = getScrollContainer();
        if (!everFound) {
          everFound = true;
          console.log(`${LOG} Active row via ${found.via}: ${shortDesc(row)}`);
        }

        if (container) {
          const cRect = container.getBoundingClientRect();
          const rRect = row.getBoundingClientRect();
          const rowCenter = rRect.top + rRect.height / 2;
          const viewCenter = cRect.top + cRect.height / 2;
          const offBy = Math.abs(rowCenter - viewCenter);

          // Consider it good if the row sits comfortably inside the viewport.
          const inView = rRect.top >= cRect.top && rRect.bottom <= cRect.bottom;

          if (inView && offBy < cRect.height * 0.4) {
            if (++settled >= SETTLE_FRAMES) {
              cleanup();
              if (!announced) {
                console.log(`${LOG} Active row in view (${Math.round(now - start)}ms)`);
              }
              return;
            }
          } else {
            // Re-center only when it's actually off — don't fight tiny diffs.
            row.scrollIntoView({ block: 'center', inline: 'nearest' });
            settled = 0;
          }
        }
      }

      if (now - start < MAX_MS) {
        requestAnimationFrame(tick);
      } else {
        cleanup();
        if (!everFound) logDiagnostics();
        else console.log(`${LOG} Done revealing active row (${Math.round(now - start)}ms)`);
      }
    }

    requestAnimationFrame(tick);
  }

  function onPathChange(prev, next) {
    if (next === BATCHES_PATH && prev !== BATCHES_PATH) {
      bringActiveRowIntoView();
    } else if (prev === BATCHES_PATH && next !== BATCHES_PATH) {
      generation++; // cancel any in-flight reveal
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

  console.log(`${LOG} Active-row reveal active (MAIN world, passive — reads highlight, does not set it)`);
})();
