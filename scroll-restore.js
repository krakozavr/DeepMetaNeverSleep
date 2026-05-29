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
  const UPLOADS_PATH = '/contribute/esp/uploads';
  const SETTINGS_SOURCE = 'DMNS_EXTENSION_SETTINGS';
  const SETTINGS_REQUEST_SOURCE = 'DMNS_SETTINGS_REQUEST';

  const DEFAULT_SETTINGS = {
    restoreSearchResults: true,
    restoreBatchPosition: true
  };

  const MAX_MS = 8000;             // overall budget to find the row
  const HOLD_MS = 2500;            // keep our highlight asserted this long
  const SETTLE_FRAMES = 5;         // fallback path: frames the row must stay visible
  const HIGHLIGHT_STABLE_MS = 500; // fallback: highlight must hold this long
  const POLL_MS = 150;
  const GRACE_MS = 2500;           // wait for auto-refetch before nudging
  const NUDGE_INTERVAL_MS = 250;
  const HL_CLASSES = ['bg-sky-100', 'dark:bg-sky-900']; // app's active-row marker
  const RESTORED_CLEAR_CLASS = 'dmns-restored-search-clear';

  let generation = 0;
  let lastPath = location.pathname;
  let lastOpenedBatchId = null;
  let settings = { ...DEFAULT_SETTINGS };
  let currentSearch = '';
  let returnSearch = '';
  let returnSearchPhase = 'idle'; // idle -> armed while in uploads -> returning on batches API series
  let returnSearchLastPage = 0;
  let restoredSearchOnPage = false;
  let restoredSearchDisplayValue = '';
  let pendingOpenSearch = null;
  let searchInputListener = null;
  let userSearchIntentPending = false;
  let pendingClickedRowLabel = null;
  let lastOpenedRowLabel = null;
  let pendingClickedRowImageKeys = [];
  let lastOpenedRowImageKeys = [];

  function applySettings(nextSettings) {
    settings = { ...settings, ...nextSettings };
    if (!settings.restoreSearchResults) {
      clearReturnSearch('settings off');
    }
    if (!settings.restoreBatchPosition) {
      generation++;
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

  function isBatchListApiUrl(url) {
    return url &&
      url.origin === location.origin &&
      url.pathname === '/api/dm-batches';
  }

  function setCurrentSearch(value, reason) {
    const nextValue = String(value || '').trim();
    if (currentSearch === nextValue) return;

    currentSearch = nextValue;
    console.log(`${LOG} Current batch search (${reason}): "${currentSearch}"`);
  }

  function clearRestoredSearchPage(reason) {
    if (!restoredSearchOnPage) return;

    restoredSearchOnPage = false;
    restoredSearchDisplayValue = '';
    removeRestoredSearchClearButtons();
    console.log(`${LOG} Cleared restored search page: ${reason}`);
  }

  function clearReturnSearch(reason) {
    if (returnSearch || returnSearchPhase !== 'idle') {
      const prefix = reason === 'search input changed' ||
        reason === 'search input intent' ||
        reason.startsWith('explicit search changed')
        ? 'Disarmed search restore'
        : 'Cleared return search';
      console.log(`${LOG} ${prefix}: ${reason}`);
    }
    returnSearch = '';
    returnSearchPhase = 'idle';
    returnSearchLastPage = 0;
  }

  function searchInputValue() {
    const input = findSearchInput();
    return input ? input.value.trim() : null;
  }

  function armSearchRestore() {
    const visibleSearch = searchInputValue();
    const snapshot = pendingOpenSearch !== null
      ? pendingOpenSearch
      : (visibleSearch || currentSearch);
    pendingOpenSearch = null;

    setCurrentSearch(snapshot, 'open snapshot');

    if (!settings.restoreSearchResults || !snapshot) {
      clearReturnSearch('no active search');
      return;
    }

    returnSearch = snapshot;
    returnSearchPhase = 'armed';
    returnSearchLastPage = 0;
    console.log(`${LOG} Remembered batch search: "${returnSearch}"`);
  }

  function setSearchInputDisplay(value, notify = false) {
    const input = findSearchInput();
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

  function searchInputWrapper(input) {
    return input?.parentElement || null;
  }

  function removeRestoredSearchClearButtons() {
    document.querySelectorAll(`.${RESTORED_CLEAR_CLASS}`).forEach((button) => button.remove());
  }

  function hasNativeSearchClearButton(wrapper) {
    if (!wrapper) return false;

    return Array.from(wrapper.querySelectorAll('button[type="button"]'))
      .some((button) => !button.classList.contains(RESTORED_CLEAR_CLASS) && isVisibleInput(button));
  }

  function resetRestoredSearchFromButton(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!restoredSearchOnPage) return;

    setCurrentSearch('', 'clear button');
    console.log(`${LOG} User cleared batch search`);
    clearReturnSearch('search input intent');
    clearRestoredSearchPage('restored clear button');
    console.log(`${LOG} Reloading batches after restored search clear`);
    location.reload();
  }

  function createRestoredSearchClearButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `${RESTORED_CLEAR_CLASS} absolute inset-0 start-auto`;
    button.setAttribute('aria-label', 'Clear search');
    button.style.position = 'absolute';
    button.style.inset = '0 0 0 auto';
    button.style.width = '24px';
    button.style.padding = '0';
    button.style.border = '0';
    button.style.background = 'transparent';
    button.style.display = 'flex';
    button.style.alignItems = 'center';
    button.style.justifyContent = 'center';
    button.style.cursor = 'pointer';
    button.style.zIndex = '2';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('size-5', 'text-slate-400', 'hover:text-red-500', 'dark:text-slate-400');
    svg.style.width = '20px';
    svg.style.height = '20px';
    svg.style.color = 'rgb(148, 163, 184)';

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('d', 'm9.75 9.75 4.5 4.5m0-4.5-4.5 4.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z');
    svg.appendChild(path);
    button.appendChild(svg);

    button.addEventListener('pointerdown', resetRestoredSearchFromButton);
    button.addEventListener('mousedown', resetRestoredSearchFromButton);
    button.addEventListener('click', resetRestoredSearchFromButton);
    return button;
  }

  function syncRestoredSearchClearButton(input) {
    if (!restoredSearchOnPage || !restoredSearchDisplayValue || location.pathname !== BATCHES_PATH) {
      removeRestoredSearchClearButtons();
      return;
    }

    const searchInput = input || findSearchInput();
    const wrapper = searchInputWrapper(searchInput);
    if (!searchInput || !wrapper) {
      removeRestoredSearchClearButtons();
      return;
    }

    if (hasNativeSearchClearButton(wrapper)) {
      removeRestoredSearchClearButtons();
      return;
    }

    const existing = wrapper.querySelector(`.${RESTORED_CLEAR_CLASS}`);
    if (!existing) {
      wrapper.appendChild(createRestoredSearchClearButton());
      console.log(`${LOG} Added restored search clear button`);
    }
  }

  function syncRestoredSearchDisplay() {
    if (!restoredSearchOnPage || !restoredSearchDisplayValue || location.pathname !== BATCHES_PATH) {
      removeRestoredSearchClearButtons();
      return;
    }

    const input = findSearchInput();
    if (!input || document.activeElement === input) return;

    if (setSearchInputDisplay(restoredSearchDisplayValue)) {
      console.log(`${LOG} Synced restored search display: "${restoredSearchDisplayValue}"`);
    }
    syncRestoredSearchClearButton(input);
  }

  function markRestoredSearchOnPage(value) {
    const nextValue = String(value || '').trim();
    if (!nextValue) return;

    restoredSearchOnPage = true;
    restoredSearchDisplayValue = nextValue;
    syncRestoredSearchDisplay();
  }

  function beginReturnSearchRestore(reason) {
    if (returnSearchPhase !== 'armed' || !returnSearch) return;

    returnSearchPhase = 'returning';
    returnSearchLastPage = 0;
    console.log(`${LOG} Armed search restore on return (${reason}): "${returnSearch}"`);
    markRestoredSearchOnPage(returnSearch);
  }

  function returnSearchPage(url) {
    const page = Number(url.searchParams.get('page') || '1');
    return Number.isFinite(page) && page > 0 ? page : 1;
  }

  function shouldRestoreReturnSearch(url) {
    if (returnSearchPhase === 'armed' && location.pathname === BATCHES_PATH) {
      beginReturnSearchRestore('api');
    }
    if (returnSearchPhase !== 'returning' || !returnSearch) return false;

    returnSearchLastPage = returnSearchPage(url);
    return true;
  }

  function maybeRestoreBatchSearchUrl(urlValue) {
    const url = parseUrl(urlValue);
    if (!isBatchListApiUrl(url)) return null;
    const explicitSearch = url.searchParams.get('search') || '';

    if (!settings.restoreSearchResults) {
      return null;
    }

    if (explicitSearch === '' && shouldRestoreReturnSearch(url)) {
      url.searchParams.set('search', returnSearch);
      setCurrentSearch(returnSearch, 'restore request');
      markRestoredSearchOnPage(returnSearch);
      console.log(`${LOG} Restoring batch search: "${returnSearch}" page=${returnSearchLastPage}`);
      return url.toString();
    }

    if (returnSearchPhase !== 'idle' && explicitSearch === returnSearch) {
      setCurrentSearch(returnSearch, 'api request');
      return null;
    }

    if (returnSearchPhase !== 'idle' && explicitSearch && explicitSearch !== returnSearch) {
      setCurrentSearch(explicitSearch, 'api request');
      clearRestoredSearchPage('explicit search changed');
      clearReturnSearch(`explicit search changed to "${explicitSearch}"`);
      userSearchIntentPending = false;
      return null;
    }

    if (returnSearchPhase === 'idle' && explicitSearch) {
      clearRestoredSearchPage('explicit search');
      setCurrentSearch(explicitSearch, 'api request');
      userSearchIntentPending = false;
    } else if (returnSearchPhase === 'idle' && explicitSearch === '' && userSearchIntentPending) {
      clearRestoredSearchPage('explicit empty search');
      setCurrentSearch('', 'api request');
      userSearchIntentPending = false;
    }

    return null;
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
    const rect = input.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findSearchInput() {
    const inputs = Array.from(document.querySelectorAll('input'))
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

  function detachSearchInputListener() {
    if (!searchInputListener) return;

    for (const { target, type, listener, capture } of searchInputListener.handlers) {
      target.removeEventListener(type, listener, capture);
    }
    searchInputListener = null;
  }

  function attachSearchInputListener() {
    if (!settings.restoreSearchResults || location.pathname !== BATCHES_PATH) {
      detachSearchInputListener();
      return;
    }

    const input = findSearchInput();
    if (!input) {
      detachSearchInputListener();
      return;
    }
    if (searchInputListener?.input === input) return;

    detachSearchInputListener();

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
      if (location.pathname !== BATCHES_PATH || !event.isTrusted) return;
      if (!isSearchControlIntent(event)) return;

      userSearchIntentPending = true;
      pendingOpenSearch = null;
      clearReturnSearch('search input intent');
      if (isLikelyClearClick(event)) {
        setCurrentSearch('', 'clear intent');
        console.log(`${LOG} User cleared batch search`);
        if (restoredSearchOnPage) {
          clearRestoredSearchPage('user clear click');
          console.log(`${LOG} Reloading batches after restored search clear`);
          location.reload();
        }
      }
    };

    const valueHandler = (event) => {
      if (location.pathname !== BATCHES_PATH || !event.isTrusted) return;

      const value = searchInputValue() || '';
      const hadUserSearchIntent = userSearchIntentPending;
      userSearchIntentPending = false;
      pendingOpenSearch = null;
      setCurrentSearch(value, 'input');
      clearReturnSearch('search input changed');
      if (value) {
        clearRestoredSearchPage('user input changed');
      } else if (hadUserSearchIntent && restoredSearchOnPage) {
        clearRestoredSearchPage('user empty input');
        console.log(`${LOG} Reloading batches after restored search clear`);
        location.reload();
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

    searchInputListener = { input, handlers };

    const value = searchInputValue();
    if (value) {
      setCurrentSearch(value, 'input attach');
    }
  }

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

  function imageKey(src) {
    try {
      const url = new URL(src, location.origin);
      return url.pathname.split('/').pop() || url.pathname;
    } catch {
      return src || '';
    }
  }

  function rowImageKeys(row) {
    if (!row) return [];
    return Array.from(row.querySelectorAll('img[src]'))
      .map((img) => imageKey(img.currentSrc || img.src))
      .filter(Boolean);
  }

  // Primary: the row whose thumbnail belongs to the opened batch.
  function findRowByBatchId(batchId) {
    if (!batchId) return null;
    const scope = document.querySelector('main') || document;
    const link = Array.from(scope.querySelectorAll('a[href*="batchId="]'))
      .find((candidate) => parseUrl(candidate.href)?.searchParams.get('batchId') === batchId);
    if (link) return rowOf(link);

    const key = batchId.replace(/-/g, '');
    const img = scope.querySelector(`img[src*="${key}"]`);
    if (img) return rowOf(img);

    if (lastOpenedRowImageKeys.length > 0) {
      const rows = Array.from(scope.querySelectorAll('tbody tr, [role="row"], li'));
      const row = rows.find((candidate) => {
        const keys = rowImageKeys(candidate);
        return keys.some((candidateKey) => lastOpenedRowImageKeys.includes(candidateKey));
      });
      if (row) return row;
    }

    if (lastOpenedRowLabel) {
      const rows = Array.from(scope.querySelectorAll('tbody tr, [role="row"], li'));
      const row = rows.find((candidate) => rowLabel(candidate) === lastOpenedRowLabel);
      if (row) return row;
    }

    return null;
  }

  function rememberClickedBatch(event) {
    if (location.pathname !== BATCHES_PATH) return;

    if (event.target?.closest?.('input, textarea, button, [role="button"]')) return;

    const row = event.target ? rowOf(event.target) : null;
    if (row) {
      pendingClickedRowLabel = rowLabel(row);
      pendingClickedRowImageKeys = rowImageKeys(row);
    }

    const link = event.target?.closest?.('a[href*="batchId="]');
    if (!link) return;

    const url = parseUrl(link.href);
    const id = url?.searchParams.get('batchId');
    if (id) {
      lastOpenedBatchId = id;
      const value = searchInputValue();
      pendingOpenSearch = value !== null ? value : currentSearch;
    }
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
    let scrolled = false; // scroll at most once — chasing disrupts lazy indicators

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
      if (myGen !== generation) {
        cleanup();
        return;
      }
      if (userInterrupted) {
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

        // Scroll AT MOST ONCE, when first found. Chasing the row as the list
        // grows fires repeated programmatic scrolls that disrupt the app's
        // lazy, IntersectionObserver-driven per-row indicators (status donuts).
        // After the single scroll the browser's scroll anchoring keeps the row
        // roughly in place on its own.
        if (!scrolled && container) {
          if (!isFullyVisible(row, container)) {
            // Smooth (not instant) so the scroll passes through intermediate
            // positions and fires continuous scroll/intersection events — like a
            // manual scroll — letting the app's lazy per-row indicators render.
            // An instant jump gives the loader a single tick and leaves rows
            // around the target blank.
            row.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
          }
          scrolled = true;
        }

        if (foundVia === 'thumbnail') {
          // Assert the active highlight ourselves through the laggy preference
          // render, then let go (the list is static afterwards). No scrolling.
          paintHighlight(row);
          if (now - foundAt >= HOLD_MS) {
            cleanup();
            console.log(`${LOG} Revealed + held highlight (${t}ms)`);
            return;
          }
        } else if (++settle >= SETTLE_FRAMES) {
          // S3 fallback: highlight is already the app's (stable) one — don't paint.
          cleanup();
          console.log(`${LOG} Revealed (${t}ms, via ${foundVia})`);
          return;
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
      lastOpenedRowLabel = pendingClickedRowLabel;
      lastOpenedRowImageKeys = pendingClickedRowImageKeys;
      if (next === UPLOADS_PATH) {
        armSearchRestore();
      } else {
        clearReturnSearch('left batches');
        clearRestoredSearchPage('left batches');
      }
      try {
        const id = new URL(location.href).searchParams.get('batchId');
        if (id) lastOpenedBatchId = id;
      } catch { /* ignore */ }
    } else if (next === BATCHES_PATH && prev !== BATCHES_PATH) {
      if (prev === UPLOADS_PATH) {
        beginReturnSearchRestore('path');
      } else {
        clearReturnSearch('entered batches');
        clearRestoredSearchPage('entered batches');
      }
      if (settings.restoreBatchPosition) {
        revealOpenedBatch();
      }
    } else if (prev === UPLOADS_PATH && next !== BATCHES_PATH) {
      clearReturnSearch('left uploads');
      clearRestoredSearchPage('left uploads');
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
    attachSearchInputListener();
    syncRestoredSearchDisplay();
  }
  installBatchSearchInterceptor();
  attachSearchInputListener();
  document.addEventListener('click', rememberClickedBatch, true);
  setInterval(checkPath, POLL_MS);
  window.addEventListener('popstate', checkPath);

  console.log(`${LOG} Active-row reveal active (MAIN world, v1.8.19 — scroll once + smooth, assert highlight ~2.5s)`);
})();
