// =============================================================================
// FEATURE: restore Batches panel search + opened batch position in Studio.
//
// The old /contribute/esp/batches and /contribute/esp/uploads route-based UI is
// intentionally no longer supported here. This script only handles the current
// Studio UI at /contribute/studio.
//
// Studio behavior:
// - Pinned mode keeps Batches visible, so the app preserves scroll position on
//   its own and we do not intervene.
// - Unpinned mode swaps the Batches and Uploads panels inside the same route.
//   When a user opens a batch from Batches, Studio hides the Batches panel and
//   later recreates it on return. We remember the opened batch id and active
//   search, restore the search request if Studio drops it, then reveal and
//   highlight the opened batch row once the panel is visible again.
//
// MUST run in the page MAIN world so fetch/XHR interception sees app requests.
// =============================================================================

(function () {
  'use strict';

  const LOG = '[DeepMeta Never Sleep][ScrollRestore]';
  const STUDIO_PATH = '/contribute/studio';
  const SETTINGS_SOURCE = 'DMNS_EXTENSION_SETTINGS';
  const SETTINGS_REQUEST_SOURCE = 'DMNS_SETTINGS_REQUEST';

  const DEFAULT_SETTINGS = {
    restoreSearchResults: true,
    restoreBatchPosition: true
  };

  const MAX_MS = 8000;
  const HOLD_MS = 2500;
  const POLL_MS = 150;
  const GRACE_MS = 2500;
  const NUDGE_INTERVAL_MS = 250;
  const HL_CLASSES = ['bg-sky-100', 'dark:bg-sky-900'];

  let settings = { ...DEFAULT_SETTINGS };
  let wasInStudio = isStudioPath();

  let studioGeneration = 0;
  let studioPanelPhase = 'idle'; // idle -> armed -> away -> idle
  let studioOpenSeq = 0;
  let studioRevealSeq = 0;
  let studioLastOpenedBatchId = null;
  let studioLastOpenedRowLabel = null;

  let studioCurrentSearch = '';
  let studioReturnSearch = '';
  let studioReturnSearchPhase = 'idle'; // idle -> armed -> away -> returning
  let studioReturnSearchLastPage = 0;
  let studioRestoredSearchOnPage = false;
  let studioRestoredSearchDisplayValue = '';
  let studioSearchInputListener = null;
  let studioReloadingAfterSearchClear = false;

  function applySettings(nextSettings) {
    settings = { ...settings, ...nextSettings };

    if (!settings.restoreSearchResults) {
      clearStudioReturnSearch('settings off');
      clearStudioRestoredSearchPage('settings off');
    }

    if (!settings.restoreBatchPosition) {
      studioGeneration++;
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== SETTINGS_SOURCE) return;
    applySettings(event.data.settings || {});
  });

  window.postMessage({ source: SETTINGS_REQUEST_SOURCE }, location.origin);

  function parseUrl(url) {
    try {
      return new URL(String(url), location.origin);
    } catch {
      return null;
    }
  }

  // DeepMeta renamed /api/dm-* endpoints to /api/v1/dm/* (seen on briefs,
  // Nov 2026). Accept both spellings of the batch list endpoint.
  const BATCH_LIST_PATH_RE = /^\/api\/(?:dm-batches|v\d+\/dm\/batches)\/?$/;

  function isBatchListApiUrl(url) {
    return url &&
      url.origin === location.origin &&
      BATCH_LIST_PATH_RE.test(url.pathname);
  }

  function returnSearchPage(url) {
    const page = Number(url.searchParams.get('page') || '1');
    return Number.isFinite(page) && page > 0 ? page : 1;
  }

  function isStudioPath() {
    return location.pathname === STUDIO_PATH;
  }

  function setInputDisplay(input, value, notify = false) {
    if (!input) return false;

    const changed = input.value !== value;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (changed) {
      if (setter) {
        setter.call(input, value);
      } else {
        input.value = value;
      }
    }

    if (notify) {
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    return changed;
  }

  function setStudioCurrentSearch(value, reason) {
    const nextValue = String(value || '').trim();
    if (studioCurrentSearch === nextValue) return;

    studioCurrentSearch = nextValue;
    console.log(`${LOG} Studio batch search (${reason}): "${studioCurrentSearch}"`);
  }

  function clearStudioRestoredSearchPage(reason) {
    if (!studioRestoredSearchOnPage) return;

    studioRestoredSearchOnPage = false;
    studioRestoredSearchDisplayValue = '';
    console.log(`${LOG} Cleared studio restored search page: ${reason}`);
  }

  function reloadStudioAfterRestoredSearchClear(reason) {
    if (studioReloadingAfterSearchClear) return;

    studioReloadingAfterSearchClear = true;
    clearStudioRestoredSearchPage(reason);
    console.log(`${LOG} Reloading studio after restored search clear`);
    location.reload();
  }

  function clearStudioReturnSearch(reason) {
    if (studioReturnSearch || studioReturnSearchPhase !== 'idle') {
      const prefix = reason === 'search input changed' ||
        reason === 'search input intent' ||
        reason.startsWith('explicit search changed')
        ? 'Disarmed studio search restore'
        : 'Cleared studio return search';
      console.log(`${LOG} ${prefix}: ${reason}`);
    }

    studioReturnSearch = '';
    studioReturnSearchPhase = 'idle';
    studioReturnSearchLastPage = 0;
  }

  function studioSearchInputValue() {
    const input = findStudioBatchesSearchInput();
    return input ? input.value.trim() : null;
  }

  function armStudioSearchRestore() {
    const visibleSearch = studioSearchInputValue();
    const snapshot = visibleSearch !== null ? visibleSearch : studioCurrentSearch;

    setStudioCurrentSearch(snapshot, 'open snapshot');

    if (!settings.restoreSearchResults || !snapshot) {
      clearStudioReturnSearch('no active search');
      return;
    }

    studioReturnSearch = snapshot;
    studioReturnSearchPhase = 'armed';
    studioReturnSearchLastPage = 0;
    console.log(`${LOG} Remembered studio batch search: "${studioReturnSearch}"`);
  }

  function markStudioRestoredSearchOnPage(value) {
    const nextValue = String(value || '').trim();
    if (!nextValue) return;

    studioRestoredSearchOnPage = true;
    studioRestoredSearchDisplayValue = nextValue;
    syncStudioRestoredSearchDisplay();
  }

  function beginStudioReturnSearchRestore(reason) {
    if (studioReturnSearchPhase !== 'away' || !studioReturnSearch) return;

    studioReturnSearchPhase = 'returning';
    studioReturnSearchLastPage = 0;
    console.log(`${LOG} Armed studio search restore on return (${reason}): "${studioReturnSearch}"`);
    markStudioRestoredSearchOnPage(studioReturnSearch);
  }

  function shouldRestoreStudioReturnSearch(url) {
    if (studioReturnSearchPhase === 'away' && isStudioPath()) {
      beginStudioReturnSearchRestore('api');
    }
    if (studioReturnSearchPhase !== 'returning' || !studioReturnSearch) return false;

    studioReturnSearchLastPage = returnSearchPage(url);
    return true;
  }

  function maybeRestoreStudioBatchSearchUrl(url) {
    if (!settings.restoreSearchResults || !isStudioPath()) {
      return null;
    }

    const explicitSearch = url.searchParams.get('search') || '';

    if (explicitSearch === '' && shouldRestoreStudioReturnSearch(url)) {
      url.searchParams.set('search', studioReturnSearch);
      setStudioCurrentSearch(studioReturnSearch, 'restore request');
      markStudioRestoredSearchOnPage(studioReturnSearch);
      console.log(`${LOG} Restoring studio batch search: "${studioReturnSearch}" page=${studioReturnSearchLastPage}`);
      return url.toString();
    }

    if (studioReturnSearchPhase !== 'idle' && explicitSearch === studioReturnSearch) {
      studioReturnSearchLastPage = returnSearchPage(url);
      setStudioCurrentSearch(studioReturnSearch, 'api request');
      return null;
    }

    if (studioReturnSearchPhase !== 'idle' && explicitSearch && explicitSearch !== studioReturnSearch) {
      setStudioCurrentSearch(explicitSearch, 'api request');
      clearStudioRestoredSearchPage('explicit search changed');
      clearStudioReturnSearch(`explicit search changed to "${explicitSearch}"`);
      return null;
    }

    if (studioReturnSearchPhase === 'idle' && explicitSearch) {
      clearStudioRestoredSearchPage('explicit search');
      setStudioCurrentSearch(explicitSearch, 'api request');
    } else if (studioReturnSearchPhase === 'idle' && explicitSearch === '') {
      setStudioCurrentSearch('', 'api request');
    }

    return null;
  }

  function maybeRestoreBatchSearchUrl(urlValue) {
    const url = parseUrl(urlValue);
    if (!isBatchListApiUrl(url)) return null;
    return maybeRestoreStudioBatchSearchUrl(url);
  }

  function installBatchSearchInterceptor() {
    const originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
      window.fetch = function dmnsFetch(input, init) {
        const restoredUrl = maybeRestoreBatchSearchUrl(input?.url || input);
        if (restoredUrl) {
          if (typeof Request !== 'undefined' && input instanceof Request) {
            return originalFetch.call(this, new Request(restoredUrl, input), init);
          }
          return originalFetch.call(this, restoredUrl, init);
        }
        return originalFetch.call(this, input, init);
      };
    }

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function dmnsOpen(method, url, ...args) {
      const restoredUrl = maybeRestoreBatchSearchUrl(url);
      return originalOpen.call(this, method, restoredUrl || url, ...args);
    };
  }

  function isVisibleInput(input) {
    if (!input) return false;
    const rect = input.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isVisibleElement(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;

    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function elementText(el) {
    return (el?.innerText || el?.textContent || '').trim().replace(/\s+/g, ' ');
  }

  function hasClassToken(el, token) {
    return Boolean(el?.classList && Array.from(el.classList).includes(token));
  }

  function rowOf(el) {
    return el.closest('tr') ||
      el.closest('[role="row"]') ||
      el.closest('li') ||
      el.closest('article') ||
      el;
  }

  function studioRowFromBatchMarker(marker) {
    if (!marker) return null;

    if (marker.matches?.('tr[data-batch-id], [role="row"][data-batch-id], li[data-batch-id], article[data-batch-id]')) {
      return marker;
    }

    let el = marker;
    while (el && el !== document.body && el !== document.documentElement) {
      if (hasClassToken(el, 'group/row')) {
        return el;
      }
      el = el.parentElement;
    }

    return rowOf(marker);
  }

  function studioRowFromElement(el) {
    if (!el?.closest) return null;

    const directRow = el.closest('tr[data-batch-id], [role="row"][data-batch-id], li[data-batch-id], article[data-batch-id]');
    if (directRow) return directRow;

    const marker = el.closest('[data-batch-id]');
    if (marker) return studioRowFromBatchMarker(marker);

    let row = el;
    while (row && row !== document.body && row !== document.documentElement) {
      if (hasClassToken(row, 'group/row') && row.querySelector('[data-batch-id]')) {
        return row;
      }
      row = row.parentElement;
    }

    return null;
  }

  function studioBatchId(row) {
    if (!row) return null;
    return row.getAttribute?.('data-batch-id') ||
      row.querySelector?.('[data-batch-id]')?.getAttribute('data-batch-id') ||
      null;
  }

  function studioScrollTarget(row) {
    if (!row) return null;
    if (row.getAttribute?.('data-batch-id')) return row;
    return row.querySelector?.('[data-batch-id]') || row;
  }

  function visibleStudioBatchRows() {
    if (!isStudioPath()) return [];

    const rows = new Set();
    document.querySelectorAll('[data-batch-id]').forEach((marker) => {
      const row = studioRowFromBatchMarker(marker);
      const target = studioScrollTarget(row);
      if (row && target && isVisibleElement(target)) {
        rows.add(row);
      }
    });

    return Array.from(rows);
  }

  function findStudioBatchesPanel() {
    if (!isStudioPath()) return null;

    const headings = Array.from(document.querySelectorAll('h2, [role="heading"]'))
      .filter((heading) => isVisibleElement(heading) && elementText(heading) === 'Batches');

    for (const heading of headings) {
      let el = heading.closest('section') || heading.parentElement;
      while (el && el !== document.body && el !== document.documentElement) {
        if (el.querySelector('input[type="search"], input[type="text"]')) {
          return el;
        }
        el = el.parentElement;
      }
    }

    const row = visibleStudioBatchRows()[0];
    return row?.closest('section') || row?.closest('div') || null;
  }

  function findStudioBatchesSearchInput() {
    const panel = findStudioBatchesPanel();
    if (!panel) return null;

    const inputs = Array.from(panel.querySelectorAll('input'))
      .filter((input) => {
        const type = (input.getAttribute('type') || 'text').toLowerCase();
        return (type === 'text' || type === 'search') && isVisibleInput(input);
      });

    return inputs.find((input) => {
      const haystack = [
        input.getAttribute('type'),
        input.getAttribute('placeholder'),
        input.getAttribute('aria-label'),
        input.getAttribute('name'),
        input.getAttribute('id')
      ].join(' ').toLowerCase();
      return haystack.includes('search');
    }) || (inputs.length === 1 ? inputs[0] : null);
  }

  function isStudioBatchesPanelVisible() {
    return Boolean(findStudioBatchesPanel());
  }

  function findStudioBatchesScrollContainer() {
    const row = visibleStudioBatchRows()[0];
    const target = studioScrollTarget(row);
    let el = target?.closest('table')?.parentElement || target?.parentElement || row?.parentElement || null;

    while (el && el !== document.body && el !== document.documentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 4) {
        return el;
      }
      el = el.parentElement;
    }

    const panel = findStudioBatchesPanel();
    if (!panel) return null;

    return Array.from(panel.querySelectorAll('div'))
      .find((candidate) => {
        const oy = getComputedStyle(candidate).overflowY;
        return isVisibleElement(candidate) &&
          (oy === 'auto' || oy === 'scroll') &&
          candidate.scrollHeight > candidate.clientHeight + 4;
      }) || null;
  }

  function findStudioBatchRowById(batchId) {
    if (!batchId) return null;

    const marker = document.querySelector(`[data-batch-id="${batchId}"]`);
    if (marker && isVisibleElement(marker)) {
      return studioRowFromBatchMarker(marker);
    }

    return visibleStudioBatchRows()
      .find((row) => studioBatchId(row) === batchId) || null;
  }

  function detachStudioSearchInputListener() {
    if (!studioSearchInputListener) return;

    for (const { target, type, listener, capture } of studioSearchInputListener.handlers) {
      target.removeEventListener(type, listener, capture);
    }
    studioSearchInputListener = null;
  }

  function attachStudioSearchInputListener() {
    if (!settings.restoreSearchResults || !isStudioPath() || !isStudioBatchesPanelVisible()) {
      detachStudioSearchInputListener();
      return;
    }

    const input = findStudioBatchesSearchInput();
    if (!input) {
      detachStudioSearchInputListener();
      return;
    }
    if (studioSearchInputListener?.input === input) return;

    detachStudioSearchInputListener();

    const searchControlRoot = () => input.closest('form, label, [role="search"]') ||
      input.parentElement?.parentElement ||
      input.parentElement;

    const isLikelyClearClick = (event) => {
      if (!['pointerdown', 'mousedown', 'click'].includes(event.type)) return false;
      if (typeof event.clientX !== 'number') return false;

      if (event.target === input) {
        const rect = input.getBoundingClientRect();
        return event.clientX >= rect.right - 48;
      }

      const root = searchControlRoot();
      if (!root || !(event.target instanceof Node) || !root.contains(event.target)) return false;

      const rect = root.getBoundingClientRect();
      return event.clientX >= rect.right - 64;
    };

    const isSearchControlIntent = (event) => {
      if (isLikelyClearClick(event)) return true;
      if (event.target === input) return event.type === 'keydown' || event.type === 'beforeinput';
      if ((event.type === 'keydown' || event.type === 'beforeinput') && document.activeElement === input) {
        return true;
      }

      const root = searchControlRoot();
      return Boolean(root && event.target instanceof Node && root.contains(event.target));
    };

    const intentHandler = (event) => {
      if (!isStudioPath() || !event.isTrusted) return;
      if (!isSearchControlIntent(event)) return;

      clearStudioReturnSearch('search input intent');
      if (isLikelyClearClick(event)) {
        const wasRestoredSearch = studioRestoredSearchOnPage;
        setStudioCurrentSearch('', 'clear intent');
        console.log(`${LOG} User cleared studio batch search`);
        if (wasRestoredSearch) {
          reloadStudioAfterRestoredSearchClear('user clear click');
        }
      }
    };

    const valueHandler = (event) => {
      if (!isStudioPath() || !event.isTrusted) return;

      const value = studioSearchInputValue() || '';
      const wasRestoredSearch = studioRestoredSearchOnPage;
      setStudioCurrentSearch(value, 'input');
      clearStudioReturnSearch('search input changed');
      if (value) {
        clearStudioRestoredSearchPage('user input changed');
      } else if (wasRestoredSearch) {
        reloadStudioAfterRestoredSearchClear('user empty input');
      } else {
        clearStudioRestoredSearchPage('user empty input');
      }
    };

    const handlers = [
      { target: document, type: 'pointerdown', listener: intentHandler, capture: true },
      { target: document, type: 'mousedown', listener: intentHandler, capture: true },
      { target: document, type: 'keydown', listener: intentHandler, capture: true },
      { target: document, type: 'beforeinput', listener: intentHandler, capture: true },
      { target: input, type: 'input', listener: valueHandler, capture: true },
      { target: input, type: 'change', listener: valueHandler, capture: true },
      { target: input, type: 'search', listener: valueHandler, capture: true }
    ];

    for (const { target, type, listener, capture } of handlers) {
      target.addEventListener(type, listener, capture);
    }

    studioSearchInputListener = { input, handlers };

    const value = studioSearchInputValue();
    if (value) {
      setStudioCurrentSearch(value, 'input attach');
    }
  }

  function syncStudioRestoredSearchDisplay() {
    if (!studioRestoredSearchOnPage ||
        !studioRestoredSearchDisplayValue ||
        !isStudioPath() ||
        !isStudioBatchesPanelVisible()) {
      return;
    }

    const input = findStudioBatchesSearchInput();
    if (!input || document.activeElement === input) return;

    if (setInputDisplay(input, studioRestoredSearchDisplayValue, true)) {
      console.log(`${LOG} Synced studio restored search display: "${studioRestoredSearchDisplayValue}"`);
    }
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

  function studioHighlightTargets(row) {
    if (!row) return [];

    if (hasClassToken(row, 'group/row')) {
      const cells = Array.from(row.children || [])
        .filter(isVisibleElement);
      if (cells.length > 0) {
        return cells;
      }
    }

    return [row];
  }

  function paintStudioHighlight(row) {
    const targetSet = new Set(studioHighlightTargets(row));
    for (const candidate of visibleStudioBatchRows()) {
      for (const target of studioHighlightTargets(candidate)) {
        if (!targetSet.has(target)) {
          HL_CLASSES.forEach((c) => target.classList.remove(c));
        }
      }
    }
    targetSet.forEach((target) => HL_CLASSES.forEach((c) => target.classList.add(c)));
  }

  function rememberStudioClickedBatch(event) {
    if (!isStudioPath()) return;
    if (event.target?.closest?.('input, textarea, button, a, [role="button"]')) return;

    const row = studioRowFromElement(event.target);
    const target = studioScrollTarget(row);
    if (!row || !target || !isVisibleElement(target)) return;

    const id = studioBatchId(row);
    if (!id) return;

    studioLastOpenedBatchId = id;
    studioLastOpenedRowLabel = rowLabel(row);
    studioPanelPhase = 'armed';
    studioOpenSeq++;
    armStudioSearchRestore();
    console.log(`${LOG} Studio batch opened from list: batchId=${id}`);
  }

  function revealStudioOpenedBatch() {
    const batchId = studioLastOpenedBatchId;
    const expectedLabel = studioLastOpenedRowLabel;
    const myGen = ++studioGeneration;
    const start = performance.now();
    let foundAt = 0;
    let scrolled = false;
    let lastNudgeAt = 0;
    let lastNudgeHeight = 0;
    let bottomStreak = 0;

    let userInterrupted = false;
    const onUserAct = () => { userInterrupted = true; };
    const opts = { passive: true, capture: true };
    const events = ['wheel', 'touchstart', 'keydown', 'mousedown'];
    events.forEach((e) => window.addEventListener(e, onUserAct, opts));
    const cleanup = () => events.forEach((e) => window.removeEventListener(e, onUserAct, opts));

    console.log(`${LOG} Studio return to Batches - will reveal opened batchId=${batchId || '(unknown)'}`);

    function tick(now) {
      if (myGen !== studioGeneration) {
        cleanup();
        return;
      }
      if (userInterrupted) {
        cleanup();
        return;
      }

      const t = Math.round(now - start);

      if (studioReturnSearch &&
          studioReturnSearchPhase === 'returning' &&
          studioReturnSearchLastPage === 0) {
        if (now - start < MAX_MS) {
          requestAnimationFrame(tick);
        } else {
          cleanup();
          console.warn(`${LOG} Studio gave up waiting for restored search request before reveal`);
        }
        return;
      }

      let row = findStudioBatchRowById(batchId);
      if (!row && expectedLabel) {
        row = visibleStudioBatchRows()
          .find((candidate) => rowLabel(candidate) === expectedLabel) || null;
      }

      const scrollTarget = studioScrollTarget(row);
      if (row && scrollTarget && scrollTarget.getClientRects().length > 0) {
        const container = findStudioBatchesScrollContainer();
        if (!foundAt) {
          foundAt = now;
          console.log(`${LOG} Found studio target row @${t}ms`);
        }

        if (!scrolled && container) {
          if (!isFullyVisible(scrollTarget, container)) {
            scrollTarget.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
          }
          scrolled = true;
        }

        paintStudioHighlight(row);
        if (now - foundAt >= HOLD_MS) {
          cleanup();
          console.log(`${LOG} Revealed studio batch + held highlight (${t}ms)`);
          return;
        }
      } else if (now - start >= GRACE_MS && now - lastNudgeAt >= NUDGE_INTERVAL_MS) {
        const container = findStudioBatchesScrollContainer();
        if (container) {
          if (lastNudgeAt === 0) {
            console.log(`${LOG} Studio row not visible after ${t}ms - nudging to load pages`);
          }
          const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 2;
          if (atBottom && container.scrollHeight <= lastNudgeHeight + 2) {
            if (++bottomStreak >= 3) {
              cleanup();
              console.warn(`${LOG} Studio gave up: reached end of list, row not found (batchId=${batchId || 'unknown'})`);
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
        console.warn(`${LOG} Studio gave up after ${t}ms (batchId=${batchId || 'unknown'})`);
      }
    }

    requestAnimationFrame(tick);
  }

  function resetStudioStateAfterLeaving() {
    detachStudioSearchInputListener();
    studioGeneration++;
    studioPanelPhase = 'idle';
    studioReloadingAfterSearchClear = false;
    clearStudioReturnSearch('left studio');
    clearStudioRestoredSearchPage('left studio');
  }

  function checkStudioPanel() {
    if (!isStudioPath()) {
      if (wasInStudio ||
          studioPanelPhase !== 'idle' ||
          studioReturnSearchPhase !== 'idle' ||
          studioRestoredSearchOnPage ||
          studioSearchInputListener) {
        resetStudioStateAfterLeaving();
      }
      wasInStudio = false;
      return;
    }

    wasInStudio = true;
    const batchesVisible = isStudioBatchesPanelVisible();

    if (studioPanelPhase === 'armed' && !batchesVisible) {
      studioPanelPhase = 'away';
      if (studioReturnSearchPhase === 'armed') {
        studioReturnSearchPhase = 'away';
      }
      console.log(`${LOG} Studio Batches panel hidden after opened batch`);
    }

    if (batchesVisible && studioPanelPhase === 'away') {
      if (studioReturnSearchPhase === 'away') {
        beginStudioReturnSearchRestore('panel');
      }
      syncStudioRestoredSearchDisplay();

      if (settings.restoreBatchPosition && studioLastOpenedBatchId && studioRevealSeq < studioOpenSeq) {
        studioRevealSeq = studioOpenSeq;
        revealStudioOpenedBatch();
      }

      studioPanelPhase = 'idle';
    }

    attachStudioSearchInputListener();
    syncStudioRestoredSearchDisplay();
  }

  installBatchSearchInterceptor();
  document.addEventListener('click', rememberStudioClickedBatch, true);
  setInterval(checkStudioPanel, POLL_MS);
  window.addEventListener('popstate', checkStudioPanel);
  checkStudioPanel();

  console.log(`${LOG} Active-row reveal active (MAIN world, build 1.15.3)`);
})();
