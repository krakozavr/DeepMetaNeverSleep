// =============================================================================
// FEATURE: Reveal the active batch row once its highlight stabilizes (v1.5.x)
//
// WHAT WE LEARNED:
// The app marks the active row with class `bg-sky-100` (dark: `bg-sky-900`).
// Clicking a folder writes a server "preference" (setPreference) and the list
// re-renders that highlight ASYNCHRONOUSLY; Next.js App Router also caches the
// /batches segment. So right after returning the highlight can still point at
// the PREVIOUS folder and only later (maybe) update to the one you opened.
//
// Earlier builds scrolled to the highlighted row immediately (~100ms) and thus
// exposed that stale intermediate state ("no logic" highlight, missing
// indicators). With the extension disabled you never notice it because the
// scroll resets to the top and you scroll down manually only seconds later,
// after the highlight has settled.
//
// THIS BUILD is non-adversarial and patient: it watches the highlighted row and
// only scrolls it into view once it has held steady for a short while. It also
// logs how the highlight changes over time + the batchId we returned from, so we
// can confirm whether the highlight converges to the correct folder or stays
// stale. Nothing touches the History API, focus, or the highlight itself.
//
// MUST run in the page MAIN world (manifest.json "world": "MAIN").
// =============================================================================

(function () {
  'use strict';

  const LOG = '[DeepMeta Never Sleep][ScrollRestore]';
  const BATCHES_PATH = '/contribute/esp/batches';

  const MAX_MS = 4000;       // overall watch budget after returning
  const STABLE_MS = 500;     // highlight must hold this long before we reveal
  const POLL_MS = 150;       // path-change polling interval

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

  // The active row is the one the app paints with a sky background.
  function findActiveRow() {
    const scope = document.querySelector('main') || document;
    let el = scope.querySelector('tbody tr[class*="bg-sky-"]');
    if (el) return el;

    // Fallback: odd-one-out by class among sibling rows.
    const rows = Array.from(scope.querySelectorAll('tbody tr'));
    if (rows.length > 2) {
      const counts = new Map();
      rows.forEach((r) => counts.set(r.className, (counts.get(r.className) || 0) + 1));
      const unique = rows.filter((r) => counts.get(r.className) === 1);
      if (unique.length === 1) return unique[0];
    }
    return null;
  }

  function rowLabel(row) {
    if (!row) return '(none)';
    return (row.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50) || '(empty)';
  }

  function isInView(row, container) {
    const c = container.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const rowCenter = r.top + r.height / 2;
    const viewCenter = c.top + c.height / 2;
    return r.top >= c.top && r.bottom <= c.bottom && Math.abs(rowCenter - viewCenter) < c.height * 0.45;
  }

  function watchAndReveal() {
    const myGen = ++generation;
    const start = performance.now();

    let lastLabel = null;
    let stableSince = 0;
    let revealedLabel = null;

    let userInterrupted = false;
    const onUserAct = () => { userInterrupted = true; };
    const opts = { passive: true, capture: true };
    const events = ['wheel', 'touchstart', 'keydown', 'mousedown'];
    events.forEach((e) => window.addEventListener(e, onUserAct, opts));
    const cleanup = () => events.forEach((e) => window.removeEventListener(e, onUserAct, opts));

    console.log(`${LOG} Return to batches — returned from batchId=${lastOpenedBatchId || '(unknown)'} — watching highlight`);

    function tick(now) {
      if (myGen !== generation || userInterrupted) {
        cleanup();
        return;
      }

      const row = findActiveRow();
      const label = rowLabel(row);
      const t = Math.round(now - start);

      if (label !== lastLabel) {
        console.log(`${LOG} highlight @${t}ms: "${label}"`);
        lastLabel = label;
        stableSince = now;
      }

      const stableFor = now - stableSince;
      const container = getScrollContainer();

      // Reveal once the highlight has held steady, and re-reveal if it later
      // changes to a different (hopefully correct) folder.
      if (row && container && stableFor >= STABLE_MS && label !== revealedLabel) {
        if (!isInView(row, container)) {
          row.scrollIntoView({ block: 'center', inline: 'nearest' });
        }
        revealedLabel = label;
        console.log(`${LOG} revealed "${label}" (stable ${Math.round(stableFor)}ms, @${t}ms)`);
      }

      if (now - start < MAX_MS) {
        requestAnimationFrame(tick);
      } else {
        cleanup();
        console.log(`${LOG} watch ended @${t}ms — final highlight "${lastLabel}", revealed "${revealedLabel || '(none)'}"`);
      }
    }

    requestAnimationFrame(tick);
  }

  function onPathChange(prev, next) {
    if (prev === BATCHES_PATH && next !== BATCHES_PATH) {
      generation++; // cancel any in-flight watch
      // Remember which batch we're opening (passively, from the URL).
      try {
        lastOpenedBatchId = new URL(location.href).searchParams.get('batchId') || lastOpenedBatchId;
      } catch { /* ignore */ }
    } else if (next === BATCHES_PATH && prev !== BATCHES_PATH) {
      watchAndReveal();
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

  console.log(`${LOG} Active-row reveal active (MAIN world, v1.5 — waits for highlight to stabilize)`);
})();
